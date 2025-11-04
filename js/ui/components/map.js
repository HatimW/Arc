import { listItemsByKind, getItem, upsertItem, getMapConfig, saveMapConfig } from '../../storage/storage.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { uid, deepClone } from '../../utils.js';
import { showPopup } from './popup.js';
import { openEditor } from './editor.js';
import { createFloatingWindow } from './window-manager.js';
import { noteTabRender } from './sections.js';

function createMutationScheduler(label = 'map') {
  const logError = err => {
    console.error(`[${label}] Failed to apply DOM mutation`, err);
  };
  if (typeof requestAnimationFrame !== 'function') {
    return task => {
      if (typeof task !== 'function') return;
      try {
        task();
      } catch (err) {
        logError(err);
      }
    };
  }
  let queue = [];
  let raf = 0;
  const flush = () => {
    raf = 0;
    const tasks = queue;
    queue = [];
    for (const task of tasks) {
      try {
        task();
      } catch (err) {
        logError(err);
      }
    }
  };
  return task => {
    if (typeof task !== 'function') return;
    queue.push(task);
    if (!raf) {
      raf = requestAnimationFrame(flush);
    }
  };
}

function debounceFrame(fn, wait = 120) {
  let timer = 0;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = 0;
      const execute = () => {
        try {
          fn(...lastArgs);
        } catch (err) {
          console.error('[map] Failed to execute debounced handler', err);
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(execute);
      } else {
        execute();
      }
    }, wait);
  };
}

const scheduleDomMutation = createMutationScheduler('map');

function runMutation(task, options = {}) {
  if (typeof task !== 'function') return;
  const immediate = options.immediate === true;
  if (immediate) {
    try {
      task();
    } catch (err) {
      console.error('[map] Failed to apply DOM mutation', err);
    }
    return;
  }
  scheduleDomMutation(task);
}

const TOOL = {
  NAVIGATE: 'navigate',
  HIDE: 'hide',
  BREAK: 'break-link',
  ADD_LINK: 'add-link',
  AREA: 'area'
};

function createCursor(svg, hotX = 8, hotY = 8) {
  const encoded = encodeURIComponent(svg.trim())
    .replace(/%0A/g, '')
    .replace(/%20/g, ' ');
  return `url("data:image/svg+xml,${encoded}") ${hotX} ${hotY}, pointer`;
}

const CURSOR_STYLE = {
  hide: createCursor(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
    + '<path d="M6 19.5l9-9a3 3 0 0 1 4.24 0l6.5 6.5a3 3 0 0 1 0 4.24l-9 9H9a3 3 0 0 1-3-3z" fill="#f97316" />'
    + '<path d="M8.2 21.2l8.6 8.6" stroke="#fed7aa" stroke-width="3" stroke-linecap="round" />'
    + '<path d="M11.3 24.5l4 4" stroke="#fff7ed" stroke-width="2" stroke-linecap="round" />'
    + '</svg>',
    7,
    26
  ),
  break: createCursor(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
    + '<circle cx="11" cy="11" r="4" fill="none" stroke="#f97316" stroke-width="2.2" />'
    + '<circle cx="11" cy="21" r="4" fill="none" stroke="#f97316" stroke-width="2.2" />'
    + '<path d="M14.5 13L24 3.5" stroke="#fbbf24" stroke-width="2.6" stroke-linecap="round" />'
    + '<path d="M14.5 19L24 28.5" stroke="#fbbf24" stroke-width="2.6" stroke-linecap="round" />'
    + '<path d="M6 6l7 7" stroke="#f97316" stroke-width="2.2" stroke-linecap="round" />'
    + '<path d="M6 26l7-7" stroke="#f97316" stroke-width="2.2" stroke-linecap="round" />'
    + '</svg>',
    18,
    18
  ),
  link: createCursor(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
    + '<path d="M12 11h5a4.5 4.5 0 0 1 0 9h-3" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />'
    + '<path d="M14 15h-4a4.5 4.5 0 0 0 0 9h5" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />'
    + '<path d="M13 19h6" stroke="#bae6fd" stroke-width="2" stroke-linecap="round" />'
    + '</svg>',
    9,
    23
  )
};

const PAN_ACCELERATION = 1.8;
const ZOOM_INTENSITY = 0.0041;
const NODE_DRAG_DISTANCE_THRESHOLD = 0;

const ICONS = {
  sliders:
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M6 7h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />'
    + '<path d="M6 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />'
    + '<path d="M6 17h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />'
    + '<circle cx="16" cy="7" r="2.5" stroke="currentColor" stroke-width="1.6" />'
    + '<circle cx="11" cy="12" r="2.5" stroke="currentColor" stroke-width="1.6" />'
    + '<circle cx="19" cy="17" r="2.5" stroke="currentColor" stroke-width="1.6" />'
    + '</svg>',
  close:
    '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />'
    + '</svg>',
  plus:
    '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />'
    + '</svg>',
  search:
    '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<circle cx="9" cy="9" r="5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />'
    + '<path d="M12.8 12.8L16.5 16.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />'
    + '</svg>',
  arrowRight:
    '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M4 10h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />'
    + '<path d="M10 6l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />'
    + '</svg>',
  gear:
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" stroke="currentColor" stroke-width="1.6" />'
    + '<path d="M4.5 12.5l1.8.52c.26.08.46.28.54.54l.52 1.8a.9.9 0 0 0 1.47.41l1.43-1.08a.9.9 0 0 1 .99-.07l1.63.82a.9.9 0 0 0 1.22-.41l.73-1.66a.9.9 0 0 1 .73-.52l1.88-.2a.9.9 0 0 0 .78-1.07l-.39-1.85a.9.9 0 0 1 .25-.83l1.29-1.29a.9.9 0 0 0-.01-1.27l-1.29-1.29a.9.9 0 0 0-.83-.25l-1.85.39a.9.9 0 0 1-1.07-.78l-.2-1.88A.9.9 0 0 0 13.3 2h-2.6a.9.9 0 0 0-.9.78l-.2 1.88a.9.9 0 0 1-1.07.78l-1.85-.39a.9.9 0 0 0-.83.25L4.56 6.59a.9.9 0 0 0-.01 1.27l1.29 1.29c.22.22.31.54.25.83l-.39 1.85a.9.9 0 0 0 .7 1.07z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />'
    + '</svg>',
  trash:

    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M6 7h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />'
    + '<path d="M9 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />'
    + '<path d="M18 7v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />'
    + '<path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />'
    + '</svg>'
};

const DEFAULT_LINK_COLOR = '#888888';
const DEFAULT_LINE_STYLE = 'solid';
const DEFAULT_LINE_DECORATION = 'none';
const DEFAULT_DECORATION_DIRECTION = 'end';
const DEFAULT_LINE_GLOW = false;
const DEFAULT_LINE_THICKNESS = 'regular';
const DEFAULT_CURVE_ANCHOR = 0.5;
const CURVE_HANDLE_COUNT = 1;
const CURVE_HANDLE_MAX_OFFSET = 3.5;
const MIN_NODE_RADIUS = 20;
const MAX_NODE_RADIUS = 60;
const MAX_GRAVITY_BOOST = 999;
const NODE_COLLISION_MARGIN = 36;
const DEFAULT_REORGANIZE_SPACING = 220;
const HANDLE_STICKY_RELEASE_DELAY = 260;
const VIEW_MEMORY_MAX_AGE = 10 * 60 * 1000;

const LINE_STYLE_OPTIONS = [
  { value: 'solid', label: 'Smooth' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' }
];

const LINE_DECORATION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'arrow', label: 'Arrowhead' },
  { value: 'inhibit', label: 'Inhibitor ⊣' },
  { value: 'block', label: 'Blocked ✕' }
];

const LINE_DECORATION_DIRECTION_OPTIONS = [
  { value: 'end', label: 'A → B' },
  { value: 'start', label: 'B → A' },
  { value: 'both', label: 'Both directions' }
];

const LINE_STYLE_CLASSNAMES = ['map-edge--solid', 'map-edge--dashed', 'map-edge--dotted'];
const LINE_DECORATION_CLASSNAMES = [
  'map-edge--decoration-arrow',
  'map-edge--decoration-inhibit',
  'map-edge--decoration-block'
];

const LINE_STYLE_VALUE_SET = new Set(LINE_STYLE_OPTIONS.map(option => option.value));
const LINE_DECORATION_VALUE_SET = new Set(LINE_DECORATION_OPTIONS.map(option => option.value));
const LINE_DIRECTION_VALUE_SET = new Set(LINE_DECORATION_DIRECTION_OPTIONS.map(option => option.value));

const LINE_THICKNESS_VALUES = {
  thin: 1.8,
  regular: 3,
  bold: 4.6
};

const LINE_THICKNESS_OPTIONS = [
  { value: 'thin', label: 'Thin' },
  { value: 'regular', label: 'Regular' },
  { value: 'bold', label: 'Bold' }
];

const LINE_HOVER_WIDTH_MULTIPLIER = 1.2;

const LINE_TYPE_PRESETS = [
  { value: 'line', label: 'Line', style: 'solid', decoration: 'none', direction: DEFAULT_DECORATION_DIRECTION },
  { value: 'arrow', label: 'Arrow', style: 'solid', decoration: 'arrow', direction: 'end', directional: true },
  { value: 'inhibit', label: 'Inhibitor ⊣', style: 'solid', decoration: 'inhibit', direction: 'end', directional: true },
  { value: 'blocked', label: 'Blocked ✕', style: 'solid', decoration: 'block', direction: DEFAULT_DECORATION_DIRECTION },
  { value: 'dashed', label: 'Dashed', style: 'dashed', decoration: 'none', direction: DEFAULT_DECORATION_DIRECTION },
  { value: 'dotted', label: 'Dotted', style: 'dotted', decoration: 'none', direction: DEFAULT_DECORATION_DIRECTION }
];

const LINE_TYPE_PRESET_LOOKUP = new Map(LINE_TYPE_PRESETS.map(option => [option.value, option]));

const LINE_GAP_SAMPLE_STEP = 0.08;
const LINE_GAP_MIN_DISTANCE = 12;
const LINE_GAP_STROKE_MULTIPLIER = 2.4;

const EDGE_DRAG_HOLD_DELAY = 160;
const EDGE_DRAG_MOVE_THRESHOLD = 3.5;
const EDGE_CLICK_DISTANCE = 12;
const EDGE_ANIMATION_DURATION = 120;

const LEGACY_STYLE_MAPPINGS = {
  'arrow': { style: 'solid', decoration: 'arrow', decorationDirection: 'end' },
  'arrow-end': { style: 'solid', decoration: 'arrow', decorationDirection: 'end' },
  'arrow-start': { style: 'solid', decoration: 'arrow', decorationDirection: 'start' },
  'arrow-both': { style: 'solid', decoration: 'arrow', decorationDirection: 'both' },
  'blocked': { style: 'solid', decoration: 'block', decorationDirection: 'end' },
  'inhibit': { style: 'solid', decoration: 'inhibit', decorationDirection: 'end' },
  'glow': { style: 'solid', glow: true }
};

const KIND_FALLBACK_COLORS = {
  disease: 'var(--purple)',
  drug: 'var(--blue)',
  concept: 'var(--green)'
};

const mapState = {
  tool: TOOL.NAVIGATE,
  selectionIds: [],
  previewSelection: null,
  selectionPreviewSignature: '',
  pendingLink: null,
  hiddenMenuTab: 'nodes',
  panelVisible: true,
  menuPinned: false,
  menuOpen: false,
  listenersAttached: false,
  draggingView: false,
  viewWasDragged: false,
  nodeDrag: null,
  areaDrag: null,
  menuDrag: null,
  edgeDrag: null,
  selectionRect: null,
  nodeWasDragged: false,
  lastPointerDownInfo: null,
  viewBox: null,
  svg: null,
  g: null,
  positions: {},
  itemMap: {},
  elements: new Map(),
  root: null,
  container: null,
  updateViewBox: () => {},
  selectionBox: null,
  sizeLimit: 2000,
  minView: 100,
  lastPointer: { x: 0, y: 0, mapX: 0, mapY: 0 },
  autoPan: null,
  autoPanFrame: null,
  autoPanPointer: null,
  toolboxPos: { x: 16, y: 16 },
  toolboxDrag: null,
  toolboxEl: null,
  toolboxContainer: null,
  toolboxBadges: null,
  baseCursor: 'grab',
  prefersReducedMotion: null,
  motionMedia: null,
  pendingEdgeAnimations: new Map(),
  cursorOverride: null,
  defaultViewSize: null,
  lastScaleSize: null,
  viewBoxFrame: null,
  pendingViewBoxOptions: null,
  svgRect: null,
  svgRectTime: 0,
  justCompletedSelection: false,
  edgeTooltip: null,
  hoveredEdge: null,
  hoveredEdgePointer: { x: 0, y: 0 },
  currentScales: { nodeScale: 1, labelScale: 1, lineScale: 1 },
  suppressNextClick: false,
  edgeDragJustCompleted: false,
  edgePress: null,
  viewPointerId: null,
  viewDragStart: null,
  mapConfig: null,
  mapConfigLoaded: false,
  blocks: [],
  visibleItems: [],
  searchValue: '',
  searchFeedback: null,
  searchInput: null,
  searchFieldEl: null,
  searchFeedbackEl: null,
  searchSuggestions: [],
  searchSuggestionsEl: null,
  searchActiveIndex: -1,
  searchSuggestionTimer: null,
  paletteSearch: '',
  nodeRadii: null,
  gravityModel: null,
  edgeLayer: null,
  nodeLayer: null,
  lineMarkers: new Map(),
  markerDefs: null,
  lineMarkerCache: new Map(),
  edgeRefs: new Map(),
  allEdges: new Set(),
  pendingNodeUpdates: new Map(),
  pendingEdgeUpdates: new Set(),
  nodeUpdateFrame: null,
  edgeUpdateFrame: null,
  activeLineMenu: null,
  pendingFocusId: null,
  restoredViewFromMemory: false,
  viewMemoryTimer: null,
  viewMemoryDirty: false
};

function normalizeMapTab(tab = {}) {
  const filter = tab.filter && typeof tab.filter === 'object' ? tab.filter : {};
  const layout = {};
  if (tab.layout && typeof tab.layout === 'object') {
    Object.entries(tab.layout).forEach(([id, pos]) => {
      if (!id || !pos || typeof pos !== 'object') return;
      const x = Number(pos.x);
      const y = Number(pos.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      layout[id] = { x, y };
    });
  }
  const viewState = normalizeViewState(tab.viewState || tab.view || tab.viewBox);
  const normalized = {
    id: tab.id || uid(),
    name: tab.name || 'Untitled map',
    includeLinked: tab.includeLinked !== false,
    manualMode: Boolean(tab.manualMode),
    manualIds: Array.isArray(tab.manualIds) ? Array.from(new Set(tab.manualIds.filter(Boolean))) : [],
    layout,
    layoutSeeded: tab.layoutSeeded === true,
    filter: {
      blockId: filter.blockId || '',
      weeks: getFilterWeeks(filter),
      lectureKeys: getFilterLectureKeys(filter)
    },
    viewState: viewState
  };
  return normalized;
}

function normalizeViewState(view = {}) {
  if (!view || typeof view !== 'object') {
    return null;
  }
  const x = Number(view.x);
  const y = Number(view.y);
  const width = Number(view.w ?? view.width);
  const height = Number(view.h ?? view.height ?? width);
  const timestamp = Number(view.timestamp ?? view.time ?? view.updatedAt);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    x,
    y,
    w: width,
    h: height,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0
  };
}

function getRestorableViewState(tab) {
  if (!tab) return null;
  const normalized = normalizeViewState(tab.viewState);
  if (!normalized) {
    return null;
  }
  const lastUpdated = Number(normalized.timestamp) || 0;
  if (lastUpdated > 0) {
    const age = Date.now() - lastUpdated;
    if (Number.isFinite(age) && age > VIEW_MEMORY_MAX_AGE) {
      return null;
    }
  }
  return normalized;
}

function findNewestVisibleNode(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }
  let newest = null;
  let newestValue = -Infinity;
  items.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const created = Number(item.createdAt ?? item.updatedAt);
    if (Number.isFinite(created) && created > newestValue) {
      newest = item;
      newestValue = created;
    }
  });
  return newest;
}

function rememberViewBox() {
  if (!mapState.viewBox) return;
  const tab = getActiveTab();
  if (!tab) return;
  const snapshot = {
    x: mapState.viewBox.x,
    y: mapState.viewBox.y,
    w: mapState.viewBox.w,
    h: mapState.viewBox.h,
    timestamp: Date.now()
  };
  tab.viewState = snapshot;
  mapState.viewMemoryDirty = true;
  scheduleViewStatePersist();
}

function scheduleViewStatePersist() {
  if (mapState.viewMemoryTimer) return;
  mapState.viewMemoryTimer = setTimeout(() => {
    mapState.viewMemoryTimer = null;
    if (!mapState.viewMemoryDirty) return;
    mapState.viewMemoryDirty = false;
    persistMapConfig().catch(() => {});
  }, 300);
}

async function flushViewStatePersist() {
  if (mapState.viewMemoryTimer) {
    clearTimeout(mapState.viewMemoryTimer);
    mapState.viewMemoryTimer = null;
  }
  if (!mapState.viewMemoryDirty) {
    return;
  }
  mapState.viewMemoryDirty = false;
  await persistMapConfig();
}

function parseWeekValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeWeekArray(values = []) {
  const seen = new Set();
  const result = [];
  values.forEach(value => {
    const week = parseWeekValue(value);
    if (!Number.isFinite(week) || seen.has(week)) return;
    seen.add(week);
    result.push(week);
  });
  result.sort((a, b) => a - b);
  return result;
}

function normalizeLectureKeyArray(values = []) {
  const seen = new Set();
  const result = [];
  values.forEach(value => {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(key);
  });
  return result;
}

function getFilterWeeks(filter = {}) {
  if (!filter || typeof filter !== 'object') {
    return [];
  }
  const weeks = normalizeWeekArray(filter.weeks);
  if (weeks.length) {
    return weeks;
  }
  const legacy = parseWeekValue(filter.week);
  return Number.isFinite(legacy) ? [legacy] : [];
}

function getFilterLectureKeys(filter = {}) {
  if (!filter || typeof filter !== 'object') {
    return [];
  }
  const keys = normalizeLectureKeyArray(filter.lectureKeys);
  if (keys.length) {
    return keys;
  }
  const legacy = typeof filter.lectureKey === 'string' ? filter.lectureKey.trim() : '';
  return legacy ? [legacy] : [];
}

function setFilterWeeks(targetFilter, weeks = []) {
  if (!targetFilter || typeof targetFilter !== 'object') return;
  targetFilter.weeks = normalizeWeekArray(weeks);
  if ('week' in targetFilter) {
    targetFilter.week = '';
  }
}

function setFilterLectureKeys(targetFilter, keys = []) {
  if (!targetFilter || typeof targetFilter !== 'object') return;
  targetFilter.lectureKeys = normalizeLectureKeyArray(keys);
  if ('lectureKey' in targetFilter) {
    targetFilter.lectureKey = '';
  }
}

function deriveItemGroupKeys(item) {
  const groups = [];
  const lectures = Array.isArray(item?.lectures) ? item.lectures : [];
  if (lectures.length) {
    lectures.forEach(lecture => {
      const blockKey = lecture.blockId ? `block:${lecture.blockId}` : 'block:__';
      const lectureId = lecture.id != null ? `lec:${lecture.id}` : '';
      const lectureName = lecture.name ? `name:${lecture.name}` : '';
      const week = Number.isFinite(lecture.week) ? `week:${lecture.week}` : '';
      const key = [blockKey, week, lectureId || lectureName].filter(Boolean).join('|');
      groups.push(key || blockKey);
    });
  } else if (Array.isArray(item?.blocks) && item.blocks.length) {
    item.blocks.forEach(blockId => {
      groups.push(`block-only:${blockId}`);
    });
  }
  if (!groups.length) {
    groups.push(`kind:${item?.kind || 'concept'}`);
  }
  return groups;
}

function parseGroupKey(key = '') {
  const info = { block: '__', week: '__', lecture: key || '__' };
  if (!key) {
    return info;
  }
  const parts = String(key).split('|');
  parts.forEach(part => {
    if (part.startsWith('block:')) {
      const value = part.slice(6);
      info.block = value || '__';
    } else if (part.startsWith('block-only:')) {
      const value = part.slice(11);
      info.block = value || '__';
    } else if (part.startsWith('week:')) {
      const value = part.slice(5);
      info.week = value || '__';
    } else if (part.startsWith('lec:')) {
      const value = part.slice(4);
      info.lecture = value || info.lecture;
    } else if (part.startsWith('name:') && (info.lecture === key || info.lecture === '__')) {
      const value = part.slice(5);
      info.lecture = value || info.lecture;
    }
  });
  if (!info.lecture || info.lecture === '__') {
    info.lecture = key || '__';
  }
  return info;
}

function getPrimaryGroupKey(item, keys = deriveItemGroupKeys(item)) {
  if (Array.isArray(keys) && keys.length) {
    return keys[0];
  }
  return `kind:${item?.kind || 'concept'}`;
}

function normalizeMapConfig(config = null) {
  const base = config && typeof config === 'object' ? { ...config } : {};
  const tabs = Array.isArray(base.tabs)
    ? base.tabs.map(normalizeMapTab)
    : [normalizeMapTab({ id: 'default', name: 'All concepts', includeLinked: true, layoutSeeded: true })];
  const ids = new Set();
  const deduped = [];
  tabs.forEach(tab => {
    if (ids.has(tab.id)) {
      const clone = { ...tab, id: uid() };
      ids.add(clone.id);
      deduped.push(clone);
    } else {
      ids.add(tab.id);
      deduped.push(tab);
    }
  });
  const active = deduped.find(tab => tab.id === base.activeTabId) || deduped[0];
  return {
    activeTabId: active.id,
    tabs: deduped
  };
}

function ensureTabLayout(tab) {
  if (!tab) return {};
  if (!tab.layout || typeof tab.layout !== 'object') {
    tab.layout = {};
  }
  return tab.layout;
}

function normalizeGravityBoost(value) {
  if (value === null || value === undefined) return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const clamped = Math.min(MAX_GRAVITY_BOOST, num);
  return Math.round(clamped * 100) / 100;
}

function getItemGravityBoost(item) {
  if (!item || typeof item !== 'object') return 0;
  return normalizeGravityBoost(item.mapGravityBoost);
}

function buildGravityModel(items = []) {
  const list = Array.isArray(items) ? items : [];
  const idSet = new Set();
  list.forEach(item => {
    if (item?.id) {
      idSet.add(item.id);
    }
  });
  const adjacency = new Map();
  const weights = new Map();
  const neighborWeights = new Map();
  const baseCounts = new Map();
  let maxWeight = 0;
  list.forEach(item => {
    if (!item || !item.id) return;
    const seen = new Set();
    const neighbors = [];
    (item.links || []).forEach(link => {
      const targetId = link?.id;
      if (!targetId) return;
      if (link.hidden) return;
      if (!idSet.has(targetId)) return;
      if (seen.has(targetId)) return;
      seen.add(targetId);
      neighbors.push(targetId);
    });
    adjacency.set(item.id, neighbors);
    const degree = neighbors.length;
    const boost = getItemGravityBoost(item);
    const weight = degree + boost;
    weights.set(item.id, weight);
    baseCounts.set(item.id, { degree, boost });
    if (weight > maxWeight) {
      maxWeight = weight;
    }
  });
  list.forEach(item => {
    if (!item?.id) return;
    const neighbors = adjacency.get(item.id) || [];
    const sorted = neighbors
      .map(id => weights.get(id) || 0)
      .sort((a, b) => b - a);
    neighborWeights.set(item.id, sorted);
  });
  const influence = new Map();
  list.forEach(item => {
    if (!item?.id) return;
    const neighbors = adjacency.get(item.id) || [];
    const baseWeight = weights.get(item.id) || 0;
    if (!neighbors.length) {
      influence.set(item.id, baseWeight);
      return;
    }
    let directSum = 0;
    neighbors.forEach(id => {
      directSum += weights.get(id) || 0;
    });
    const directAvg = directSum / neighbors.length;
    let secondSum = 0;
    neighbors.forEach(id => {
      const secondNeighbors = adjacency.get(id) || [];
      if (!secondNeighbors.length) return;
      let secondWeight = 0;
      secondNeighbors.forEach(innerId => {
        secondWeight += weights.get(innerId) || 0;
      });
      secondSum += secondWeight / secondNeighbors.length;
    });
    const secondAvg = neighbors.length ? secondSum / neighbors.length : 0;
    const score = baseWeight + directAvg * 0.6 + secondAvg * 0.3;
    influence.set(item.id, score);
  });
  return { weights, adjacency, neighborWeights, influence, maxWeight, baseCounts };
}

function computeNodeRadiusFromWeight(weight, maxWeight) {
  const clampedMax = Math.max(Number(maxWeight) || 0, 1);
  const normalized = clamp((Number(weight) || 0) / clampedMax, 0, 1);
  return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * normalized;
}

function computeRadiiFromModel(model, items = mapState.visibleItems || []) {
  const radii = new Map();
  if (!model) return radii;
  const { weights, maxWeight } = model;
  (Array.isArray(items) ? items : []).forEach(item => {
    if (!item?.id) return;
    const radius = computeNodeRadiusFromWeight(weights.get(item.id) || 0, maxWeight);
    radii.set(item.id, radius);
  });
  return radii;
}

function refreshGravityModel() {
  const items = Array.isArray(mapState.visibleItems) ? mapState.visibleItems : [];
  const model = buildGravityModel(items);
  mapState.gravityModel = model;
  const nodeRadii = computeRadiiFromModel(model, items);
  mapState.nodeRadii = nodeRadii;
  const touched = [];
  nodeRadii.forEach((radius, id) => {
    const entry = mapState.elements?.get(id);
    if (!entry?.circle) return;
    entry.circle.dataset.radius = radius;
    updateNodeGeometry(id, entry);
    touched.push(id);
  });
  touched.forEach(id => updateEdgesFor(id));
  return model;
}

function computeLayoutCenter() {
  const positions = mapState.positions || {};
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  Object.values(positions).forEach(pos => {
    if (!pos) return;
    const { x, y } = pos;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    const limit = Math.max(mapState.sizeLimit || 0, 2000);
    const fallback = limit / 2;
    return { x: fallback, y: fallback };
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2
  };
}


function computeSmartLayout(model, options = {}) {
  const items = Array.isArray(mapState.visibleItems)
    ? mapState.visibleItems.filter(it => it && it.id)
    : [];
  if (!items.length) return {};

  const workingModel = model || mapState.gravityModel || buildGravityModel(items);
  const { weights, adjacency, influence } = workingModel;
  const radii = computeRadiiFromModel(workingModel, items);

  let totalRadius = 0;
  let radiusCount = 0;
  let maxRadius = MIN_NODE_RADIUS;
  const weightValues = [];
  items.forEach(item => {
    const radius = radii.get(item.id) || MIN_NODE_RADIUS;
    totalRadius += radius;
    radiusCount += 1;
    if (radius > maxRadius) {
      maxRadius = radius;
    }
    weightValues.push(weights.get(item.id) || 0);
  });
  const avgRadius = radiusCount ? totalRadius / radiusCount : MIN_NODE_RADIUS;
  const typicalRadius = Math.max(avgRadius, maxRadius * 0.75, MIN_NODE_RADIUS);

  const sizeLimit = Math.max(mapState.sizeLimit || 0, 2600);
  const requestedCenter = options.center || computeLayoutCenter();
  const fallbackCenter = sizeLimit > 0 ? sizeLimit / 2 : typicalRadius * 20;
  const center = {
    x: Number.isFinite(requestedCenter?.x) ? clamp(requestedCenter.x, typicalRadius, sizeLimit - typicalRadius) : fallbackCenter,
    y: Number.isFinite(requestedCenter?.y) ? clamp(requestedCenter.y, typicalRadius, sizeLimit - typicalRadius) : fallbackCenter
  };

  const baseSpacing = Math.max(
    options.baseSpacing ?? DEFAULT_REORGANIZE_SPACING,
    typicalRadius * 3.4,
    maxRadius * 2.6
  );
  const margin = NODE_COLLISION_MARGIN + Math.max(24, typicalRadius * 0.5);

  const groupNodes = new Map();
  const primaryGroupById = new Map();
  items.forEach(item => {
    if (!item?.id) return;
    const keys = deriveItemGroupKeys(item);
    const primary = getPrimaryGroupKey(item, keys);
    primaryGroupById.set(item.id, primary);
    const list = groupNodes.get(primary) || [];
    list.push(item.id);
    groupNodes.set(primary, list);
  });
  if (!groupNodes.size) {
    return {};
  }

  const groupMetrics = new Map();
  groupNodes.forEach((ids, key) => {
    let sumRadius = 0;
    let maxGroupRadius = 0;
    let totalWeight = 0;
    let totalInfluence = 0;
    ids.forEach(id => {
      const radius = radii.get(id) || typicalRadius;
      sumRadius += radius;
      if (radius > maxGroupRadius) {
        maxGroupRadius = radius;
      }
      totalWeight += weights.get(id) || 0;
      totalInfluence += influence.get(id) || 0;
    });
    groupMetrics.set(key, {
      count: ids.length,
      sumRadius,
      maxRadius: maxGroupRadius || typicalRadius,
      totalWeight,
      totalInfluence
    });
  });

  const blockAggregates = new Map();
  const weekAggregates = new Map();
  groupMetrics.forEach((metric, key) => {
    const parsed = parseGroupKey(key);
    const blockKey = parsed.block || '__';
    const weekId = parsed.week || '__';
    const blockEntry = blockAggregates.get(blockKey) || { weight: 0, count: 0 };
    blockEntry.weight += metric.totalInfluence + metric.totalWeight;
    blockEntry.count += metric.count;
    blockAggregates.set(blockKey, blockEntry);
    const weekKey = `${blockKey}::${weekId}`;
    const weekEntry = weekAggregates.get(weekKey) || { weight: 0, count: 0 };
    weekEntry.weight += metric.totalInfluence + metric.totalWeight;
    weekEntry.count += metric.count;
    weekAggregates.set(weekKey, weekEntry);
  });

  const groupSpacingCache = new Map();
  const groupSpacingBase = Math.max(baseSpacing * 0.95, typicalRadius * 3.6, maxRadius * 2.5 + 56);
  const lectureSpacingBase = Math.max(groupSpacingBase * 1.22, typicalRadius * 4.6);
  const weekSpacingBase = Math.max(lectureSpacingBase * 1.18, typicalRadius * 5.3);
  const blockSpacingBase = Math.max(weekSpacingBase * 1.22, typicalRadius * 6.0);

  function getGroupSpacing(key) {
    if (groupSpacingCache.has(key)) return groupSpacingCache.get(key);
    const metric = groupMetrics.get(key) || {
      count: 0,
      sumRadius: 0,
      maxRadius: typicalRadius,
      totalWeight: 0,
      totalInfluence: 0
    };
    const avgRadius = metric.count ? metric.sumRadius / metric.count : typicalRadius;
    const influenceBoost = Math.sqrt(Math.max(metric.totalInfluence, metric.totalWeight, 0)) * typicalRadius * 0.35;
    const spacing = Math.max(
      groupSpacingBase,
      avgRadius * 3 + 60,
      metric.maxRadius * 3.4 + 80,
      baseSpacing + influenceBoost
    );
    groupSpacingCache.set(key, spacing);
    return spacing;
  }

  const clampClusterPoint = pos => ({
    x: clamp(pos.x, margin, sizeLimit - margin),
    y: clamp(pos.y, margin, sizeLimit - margin)
  });

  const clampPosition = (pos, radius) => {
    const r = Math.max(radius || MIN_NODE_RADIUS, MIN_NODE_RADIUS);
    const minCoord = r + margin;
    const maxCoord = Math.max(minCoord, sizeLimit - r - margin);
    return {
      x: clamp(pos.x, minCoord, maxCoord),
      y: clamp(pos.y, minCoord, maxCoord)
    };
  };

  const placements = new Map();
  const orbitUsage = new Map();
  const groupOrbit = new Map();

  const resolveCollisions = (id, initial, radiusOverride = null) => {
    const radius = radiusOverride ?? radii.get(id) ?? typicalRadius;
    let position = { x: initial.x, y: initial.y };
    for (let iter = 0; iter < 8; iter += 1) {
      let adjusted = false;
      placements.forEach((otherPos, otherId) => {
        if (otherId === id) return;
        const otherRadius = radii.get(otherId) || typicalRadius;
        const minDistance = radius + otherRadius + margin;
        const dx = position.x - otherPos.x;
        const dy = position.y - otherPos.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        if (dist < minDistance) {
          const push = (minDistance - dist) * 0.5;
          position.x += (dx / dist) * push;
          position.y += (dy / dist) * push;
          adjusted = true;
        }
      });
      position = clampPosition(position, radius);
      if (!adjusted) break;
    }
    return position;
  };

  const ensureOrbitState = (id, options = {}) => {
    if (orbitUsage.has(id)) {
      const existing = orbitUsage.get(id);
      if (Number.isFinite(options.baseDistance)) {
        existing.baseDistance = options.baseDistance;
      }
      if (Number.isFinite(options.layerSpacing)) {
        existing.layerSpacing = options.layerSpacing;
      }
      if (Number.isFinite(options.slotWeight)) {
        existing.slots = Math.max(6, Math.round(options.slotWeight * 1.5) + 6);
      }
      return existing;
    }
    const slotWeight = Number.isFinite(options.slotWeight) ? options.slotWeight : weights.get(id) || 0;
    const baseSlots = Math.max(6, Math.round(slotWeight * 1.5) + 6);
    const state = {
      layer: 0,
      index: 0,
      slots: baseSlots,
      baseDistance: Number.isFinite(options.baseDistance) ? options.baseDistance : baseSpacing * 0.55,
      layerSpacing: Number.isFinite(options.layerSpacing) ? options.layerSpacing : baseSpacing * 0.42
    };
    orbitUsage.set(id, state);
    return state;
  };

  const nextOrbitPosition = (anchorId, radius, opts = {}) => {
    const anchorPos = placements.get(anchorId) || center;
    const anchorRadius = radii.get(anchorId) || typicalRadius;
    const baseDistance = Number.isFinite(opts.baseDistance)
      ? opts.baseDistance
      : Math.max((opts.groupSpacing || baseSpacing) * 0.42, baseSpacing * 0.5);
    const layerSpacing = Number.isFinite(opts.layerSpacing)
      ? opts.layerSpacing
      : Math.max((opts.groupSpacing || baseSpacing) * 0.34, baseSpacing * 0.38);
    const state = ensureOrbitState(anchorId, {
      baseDistance,
      layerSpacing,
      slotWeight: opts.slotWeight
    });
    const slots = Math.max(6, state.slots + state.layer * 3);
    const angleOffset = state.layer % 2 ? 0.5 : 0;
    const angle = ((state.index + angleOffset) / slots) * Math.PI * 2;
    const distance = anchorRadius + radius + state.baseDistance + state.layer * state.layerSpacing;
    state.index += 1;
    if (state.index >= slots) {
      state.index = 0;
      state.layer += 1;
    }
    return {
      x: anchorPos.x + Math.cos(angle) * distance,
      y: anchorPos.y + Math.sin(angle) * distance
    };
  };

  const ensureGroupOrbit = key => {
    if (groupOrbit.has(key)) return groupOrbit.get(key);
    const metric = groupMetrics.get(key);
    const spacing = Math.max(getGroupSpacing(key) * 0.5, baseSpacing * 0.55);
    const slots = Math.max(8, Math.round((metric?.totalWeight || 0) * 1.2) + 8);
    const state = { layer: 0, index: 0, baseSpacing: spacing, slots };
    groupOrbit.set(key, state);
    return state;
  };

  const nextGroupPosition = (key, radius) => {
    const origin = clusterOrigins.get(key) || { x: center.x, y: center.y, spacing: getGroupSpacing(key) };
    const state = ensureGroupOrbit(key);
    const slots = Math.max(state.slots + state.layer * 4, 8);
    const angleOffset = state.layer % 2 ? 0.5 : 0;
    const angle = ((state.index + angleOffset) / slots) * Math.PI * 2;
    const distance = origin.spacing * 0.52 + state.baseSpacing * state.layer + radius + typicalRadius * 0.65;
    state.index += 1;
    if (state.index >= slots) {
      state.index = 0;
      state.layer += 1;
    }
    return {
      x: origin.x + Math.cos(angle) * distance,
      y: origin.y + Math.sin(angle) * distance
    };
  };

  const blockCenters = new Map();
  const blockPositionList = [];
  const weekCenters = new Map();
  const weekPositionsByBlock = new Map();
  const lectureCenters = new Map();
  const lecturesByWeek = new Map();

  function ensureBlockCenter(blockKey) {
    if (blockCenters.has(blockKey)) return blockCenters.get(blockKey);
    const agg = blockAggregates.get(blockKey) || { weight: 0, count: 0 };
    const spacing = Math.max(
      blockSpacingBase,
      baseSpacing + Math.sqrt(Math.max(agg.weight, 0)) * typicalRadius * 0.45 + agg.count * typicalRadius * 0.18
    );
    const candidate = pickClusterPosition(blockPositionList, spacing, center, {
      buffer: spacing * 0.35
    });
    const point = clampClusterPoint(candidate);
    const info = { x: point.x, y: point.y, spacing, buffer: spacing * 0.85 };
    blockCenters.set(blockKey, info);
    blockPositionList.push(info);
    return info;
  }

  function ensureWeekCenter(blockKey, weekId, blockCenter) {
    const weekKey = `${blockKey}::${weekId}`;
    if (weekCenters.has(weekKey)) return weekCenters.get(weekKey);
    const agg = weekAggregates.get(weekKey) || { weight: 0, count: 0 };
    const existing = weekPositionsByBlock.get(blockKey) || [];
    const spacing = Math.max(
      weekSpacingBase,
      blockCenter.spacing * 0.64,
      baseSpacing + Math.sqrt(Math.max(agg.weight, 0)) * typicalRadius * 0.34 + agg.count * typicalRadius * 0.16
    );
    const candidate = pickClusterPosition(existing, spacing, blockCenter, {
      buffer: spacing * 0.3,
      maxRadius: blockCenter.spacing * 0.85
    });
    const point = clampClusterPoint(candidate);
    const info = { x: point.x, y: point.y, spacing, buffer: spacing * 0.75 };
    weekCenters.set(weekKey, info);
    existing.push(info);
    weekPositionsByBlock.set(blockKey, existing);
    return info;
  }

  function ensureLectureCenter(blockKey, weekId, lectureId, weekCenter, groupKey) {
    const weekKey = `${blockKey}::${weekId}`;
    const lectureKey = `${weekKey}::${lectureId}`;
    if (lectureCenters.has(lectureKey)) return lectureCenters.get(lectureKey);
    const existing = lecturesByWeek.get(weekKey) || [];
    const spacing = Math.max(lectureSpacingBase, weekCenter.spacing * 0.62, getGroupSpacing(groupKey));
    const candidate = pickClusterPosition(existing, spacing, weekCenter, {
      buffer: spacing * 0.24,
      maxRadius: weekCenter.spacing * 0.7
    });
    const point = clampClusterPoint(candidate);
    const info = { x: point.x, y: point.y, spacing, buffer: spacing * 0.7 };
    lectureCenters.set(lectureKey, info);
    existing.push(info);
    lecturesByWeek.set(weekKey, existing);
    return info;
  }

  const blockOrder = new Map();
  Array.from(blockAggregates.entries())
    .sort((a, b) => {
      const scoreA = a[1].weight + a[1].count * 0.6;
      const scoreB = b[1].weight + b[1].count * 0.6;
      if (Math.abs(scoreA - scoreB) > 0.0001) return scoreB - scoreA;
      return String(a[0]).localeCompare(String(b[0]));
    })
    .forEach((entry, index) => {
      blockOrder.set(entry[0], index);
    });

  const weekOrder = new Map();
  Array.from(weekAggregates.entries())
    .sort((a, b) => {
      const scoreA = a[1].weight + a[1].count * 0.5;
      const scoreB = b[1].weight + b[1].count * 0.5;
      if (Math.abs(scoreA - scoreB) > 0.0001) return scoreB - scoreA;
      return String(a[0]).localeCompare(String(b[0]));
    })
    .forEach((entry, index) => {
      weekOrder.set(entry[0], index);
    });

  const groupOrder = Array.from(groupNodes.keys()).sort((a, b) => {
    const parsedA = parseGroupKey(a);
    const parsedB = parseGroupKey(b);
    const blockIdxA = blockOrder.get(parsedA.block || '__') ?? Number.MAX_SAFE_INTEGER;
    const blockIdxB = blockOrder.get(parsedB.block || '__') ?? Number.MAX_SAFE_INTEGER;
    if (blockIdxA !== blockIdxB) return blockIdxA - blockIdxB;
    const weekKeyA = `${parsedA.block || '__'}::${parsedA.week || '__'}`;
    const weekKeyB = `${parsedB.block || '__'}::${parsedB.week || '__'}`;
    const weekIdxA = weekOrder.get(weekKeyA) ?? Number.MAX_SAFE_INTEGER;
    const weekIdxB = weekOrder.get(weekKeyB) ?? Number.MAX_SAFE_INTEGER;
    if (weekIdxA !== weekIdxB) return weekIdxA - weekIdxB;
    const metricA = groupMetrics.get(a) || { totalInfluence: 0, totalWeight: 0, count: 0 };
    const metricB = groupMetrics.get(b) || { totalInfluence: 0, totalWeight: 0, count: 0 };
    const scoreA = metricA.totalInfluence + metricA.totalWeight;
    const scoreB = metricB.totalInfluence + metricB.totalWeight;
    if (Math.abs(scoreA - scoreB) > 0.0001) return scoreB - scoreA;
    if (metricA.count !== metricB.count) return metricB.count - metricA.count;
    return String(a).localeCompare(String(b));
  });

  const clusterOrigins = new Map();
  groupOrder.forEach(key => {
    const parsed = parseGroupKey(key);
    const blockKey = parsed.block || '__';
    const weekId = parsed.week || '__';
    const lectureId = parsed.lecture || key;
    const blockCenter = ensureBlockCenter(blockKey);
    const weekCenter = ensureWeekCenter(blockKey, weekId, blockCenter);
    const lectureCenter = ensureLectureCenter(blockKey, weekId, lectureId, weekCenter, key);
    clusterOrigins.set(key, {
      x: lectureCenter.x,
      y: lectureCenter.y,
      spacing: Math.max(lectureCenter.spacing, getGroupSpacing(key))
    });
  });

  const heavyThreshold = (() => {
    if (!weightValues.length) return 0;
    const sorted = weightValues.slice().sort((a, b) => a - b);
    const index = Math.max(0, Math.floor(sorted.length * 0.75) - 1);
    return sorted[index];
  })();

  groupOrder.forEach(groupKey => {
    const ids = groupNodes.get(groupKey) || [];
    if (!ids.length) return;
    const nodes = ids
      .slice()
      .sort((a, b) => {
        const diffInfluence = (influence.get(b) || 0) - (influence.get(a) || 0);
        if (Math.abs(diffInfluence) > 0.0001) return diffInfluence;
        const diffWeight = (weights.get(b) || 0) - (weights.get(a) || 0);
        if (Math.abs(diffWeight) > 0.0001) return diffWeight;
        return String(a).localeCompare(String(b));
      });

    const origin = clusterOrigins.get(groupKey) || { x: center.x, y: center.y, spacing: getGroupSpacing(groupKey) };
    const primaryId = nodes[0];
    const primaryRadius = radii.get(primaryId) || typicalRadius;
    const primaryPos = clampPosition({ x: origin.x, y: origin.y }, primaryRadius);
    placements.set(primaryId, primaryPos);
    ensureOrbitState(primaryId, {
      baseDistance: origin.spacing * 0.48,
      layerSpacing: origin.spacing * 0.36,
      slotWeight: weights.get(primaryId) || 0
    });

    for (let index = 1; index < nodes.length; index += 1) {
      const id = nodes[index];
      const radius = radii.get(id) || typicalRadius;
      const neighbors = adjacency.get(id) || [];
      const placedNeighbors = neighbors.filter(n => placements.has(n));
      let guess = null;

      if (placedNeighbors.length >= 2) {
        let sumX = 0;
        let sumY = 0;
        let totalWeight = 0;
        const neighborGroups = new Set();
        placedNeighbors.forEach(neighborId => {
          const pos = placements.get(neighborId);
          if (!pos) return;
          const weight = Math.max(0.2, weights.get(neighborId) || 0);
          sumX += pos.x * weight;
          sumY += pos.y * weight;
          totalWeight += weight;
          neighborGroups.add(primaryGroupById.get(neighborId));
        });
        if (totalWeight > 0) {
          guess = { x: sumX / totalWeight, y: sumY / totalWeight };
          if (neighborGroups.size > 1) {
            guess.x = (guess.x + origin.x) / 2;
            guess.y = (guess.y + origin.y) / 2;
          }
        }
      }

      if (!guess && placedNeighbors.length === 1) {
        const anchorId = placedNeighbors[0];
        const anchorGroup = primaryGroupById.get(anchorId);
        const anchorSpacing = clusterOrigins.get(anchorGroup || '')?.spacing || getGroupSpacing(anchorGroup || groupKey);
        guess = nextOrbitPosition(anchorId, radius, {
          groupSpacing: Math.max(anchorSpacing, origin.spacing),
          slotWeight: weights.get(anchorId) || 0
        });
      }

      if (!guess) {
        guess = nextGroupPosition(groupKey, radius);
      }

      const position = resolveCollisions(id, guess, radius);
      placements.set(id, position);
      if ((adjacency.get(id) || []).length > 1) {
        ensureOrbitState(id, {
          baseDistance: origin.spacing * 0.5,
          layerSpacing: origin.spacing * 0.4,
          slotWeight: weights.get(id) || 0
        });
      }
    }
  });

  const ids = Array.from(placements.keys());
  for (let iter = 0; iter < 5; iter += 1) {
    let changed = false;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const aId = ids[i];
        const bId = ids[j];
        const aPos = placements.get(aId);
        const bPos = placements.get(bId);
        if (!aPos || !bPos) continue;
        const aRadius = radii.get(aId) || typicalRadius;
        const bRadius = radii.get(bId) || typicalRadius;
        let minDistance = aRadius + bRadius + margin;
        const aWeight = weights.get(aId) || 0;
        const bWeight = weights.get(bId) || 0;
        const aGroup = primaryGroupById.get(aId);
        const bGroup = primaryGroupById.get(bId);
        if (aWeight >= heavyThreshold || bWeight >= heavyThreshold) {
          minDistance += baseSpacing * 0.35;
        }
        if (aGroup && bGroup && aGroup !== bGroup) {
          minDistance += baseSpacing * 0.25;
        }
        const dx = bPos.x - aPos.x;
        const dy = bPos.y - aPos.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        if (dist < minDistance) {
          const push = (minDistance - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          aPos.x -= nx * push;
          aPos.y -= ny * push;
          bPos.x += nx * push;
          bPos.y += ny * push;
          placements.set(aId, clampPosition(aPos, aRadius));
          placements.set(bId, clampPosition(bPos, bRadius));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  for (let iter = 0; iter < 2; iter += 1) {
    const updates = [];
    ids.forEach(id => {
      const weight = weights.get(id) || 0;
      if (weight >= heavyThreshold) return;
      const neighbors = adjacency.get(id) || [];
      if (neighbors.length < 2) return;
      const current = placements.get(id);
      if (!current) return;
      let sumX = 0;
      let sumY = 0;
      let totalWeight = 0;
      neighbors.forEach(neighborId => {
        const pos = placements.get(neighborId);
        if (!pos) return;
        const weightValue = Math.max(0.25, weights.get(neighborId) || 0);
        sumX += pos.x * weightValue;
        sumY += pos.y * weightValue;
        totalWeight += weightValue;
      });
      if (!totalWeight) return;
      const target = {
        x: current.x + ((sumX / totalWeight) - current.x) * 0.32,
        y: current.y + ((sumY / totalWeight) - current.y) * 0.32
      };
      updates.push([id, resolveCollisions(id, target)]);
    });
    updates.forEach(([id, pos]) => {
      placements.set(id, pos);
    });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  placements.forEach(pos => {
    if (!pos) return;
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
  });
  if (Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)) {
    const offsetX = center.x - (minX + maxX) / 2;
    const offsetY = center.y - (minY + maxY) / 2;
    placements.forEach((pos, id) => {
      if (!pos) return;
      const adjusted = { x: pos.x + offsetX, y: pos.y + offsetY };
      placements.set(id, clampPosition(adjusted, radii.get(id) || typicalRadius));
    });
  }

  const layout = {};
  placements.forEach((pos, id) => {
    if (!pos) return;
    layout[id] = { x: pos.x, y: pos.y };
  });
  return layout;
}

async function smartReorganizeActiveMap() {
  const items = Array.isArray(mapState.visibleItems) ? mapState.visibleItems : [];
  if (!items.length) return {};
  const model = refreshGravityModel() || mapState.gravityModel || buildGravityModel(items);
  const layout = computeSmartLayout(model);
  const ids = Object.keys(layout);
  if (!ids.length) return {};
  const tab = getActiveTab();
  ids.forEach(id => {
    mapState.positions[id] = layout[id];
    scheduleNodePositionUpdate(id, layout[id], { immediate: true });
  });
  if (tab) {
    const storedLayout = ensureTabLayout(tab);
    ids.forEach(id => {
      storedLayout[id] = { ...layout[id] };
    });
    tab.layoutSeeded = true;
    await persistMapConfig();
  }
  flushQueuedEdgeUpdates({ force: true });
  return layout;
}

async function ensureMapConfig() {
  if (mapState.mapConfigLoaded && mapState.mapConfig) {
    return mapState.mapConfig;
  }
  const raw = await getMapConfig();
  const normalized = normalizeMapConfig(raw);
  mapState.mapConfig = normalized;
  mapState.mapConfigLoaded = true;
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
    await saveMapConfig(normalized);
  }
  return normalized;
}

async function persistMapConfig() {
  if (!mapState.mapConfig) return;
  const snapshot = deepClone(mapState.mapConfig);
  await saveMapConfig(snapshot);
}

function getActiveTab() {
  const config = mapState.mapConfig;
  if (!config) return null;
  return config.tabs.find(tab => tab.id === config.activeTabId) || config.tabs[0] || null;
}

async function setActiveTab(tabId) {
  const config = mapState.mapConfig;
  if (!config) return;
  const tab = config.tabs.find(t => t.id === tabId);
  if (!tab) return;
  config.activeTabId = tab.id;
  mapState.searchValue = '';
  mapState.searchFeedback = null;
  mapState.paletteSearch = '';
  mapState.selectionIds = [];
  mapState.previewSelection = null;
  mapState.selectionPreviewSignature = '';
  mapState.pendingLink = null;
  await persistMapConfig();
  await renderMap(mapState.root);
}

async function createMapTab() {
  const config = mapState.mapConfig || normalizeMapConfig(null);
  const count = config.tabs.length + 1;
  const tab = normalizeMapTab({
    id: uid(),
    name: `Map ${count}`,
    includeLinked: true,
    manualMode: false,
    manualIds: [],
    layoutSeeded: true,
    filter: { blockId: '', weeks: [], lectureKeys: [] }
  });
  config.tabs.push(tab);
  config.activeTabId = tab.id;
  mapState.mapConfig = config;
  mapState.searchValue = '';
  mapState.searchFeedback = null;
  await persistMapConfig();
  await renderMap(mapState.root);
}

async function deleteActiveTab() {
  const config = mapState.mapConfig;
  if (!config) return;
  if (config.tabs.length <= 1) {
    alert('At least one map tab is required.');
    return;
  }
  const tab = getActiveTab();
  if (!tab) return;
  const confirmed = confirm(`Delete map “${tab.name}”?`);
  if (!confirmed) return;
  config.tabs = config.tabs.filter(t => t.id !== tab.id);
  config.activeTabId = config.tabs[0]?.id || '';
  mapState.searchValue = '';
  mapState.searchFeedback = null;
  await persistMapConfig();
  await renderMap(mapState.root);
}

function updateSearchFeedback(message, type = '') {
  if (message) {
    mapState.searchFeedback = { message, type };
  } else {
    mapState.searchFeedback = null;
  }
  applyStoredSearchFeedback();
}

function applyStoredSearchFeedback() {
  const el = mapState.searchFeedbackEl;
  if (!el) return;
  const info = mapState.searchFeedback;
  if (info && info.message) {
    el.textContent = info.message;
    el.className = 'map-search-feedback' + (info.type ? ` ${info.type}` : '');
  } else {
    el.textContent = '';
    el.className = 'map-search-feedback';
  }
}

function updateSearchSuggestions(query) {
  const container = mapState.searchSuggestionsEl;
  if (!container) return;
  if (mapState.searchSuggestionTimer) {
    clearTimeout(mapState.searchSuggestionTimer);
    mapState.searchSuggestionTimer = null;
  }
  container.innerHTML = '';
  mapState.searchSuggestions = [];
  mapState.searchActiveIndex = -1;
  const field = mapState.searchFieldEl;
  const trimmed = (query || '').trim();
  if (!trimmed) {
    container.classList.remove('visible');
    if (field) field.classList.remove('has-suggestions');
    return;
  }
  const lower = trimmed.toLowerCase();
  const items = (mapState.visibleItems || [])
    .map(item => ({ id: item.id, label: titleOf(item) || '' }))
    .filter(entry => entry.label && entry.label.toLowerCase().includes(lower));
  if (!items.length) {
    container.classList.remove('visible');
    if (field) field.classList.remove('has-suggestions');
    return;
  }
  const seen = new Set();
  const unique = [];
  items.forEach(entry => {
    if (!entry.id || seen.has(entry.id)) return;
    seen.add(entry.id);
    unique.push(entry);
  });
  unique.sort((a, b) => {
    const aIndex = a.label.toLowerCase().indexOf(lower);
    const bIndex = b.label.toLowerCase().indexOf(lower);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.label.localeCompare(b.label);
  });
  const limited = unique.slice(0, 6);
  if (!limited.length) {
    container.classList.remove('visible');
    if (field) field.classList.remove('has-suggestions');
    return;
  }
  mapState.searchSuggestions = limited;
  limited.forEach((entry, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'map-search-suggestion';
    option.textContent = entry.label;
    option.addEventListener('mousedown', evt => {
      evt.preventDefault();
    });
    option.addEventListener('click', () => {
      applySearchSuggestion(index);
    });
    container.appendChild(option);
  });
  container.classList.add('visible');
  if (field) field.classList.add('has-suggestions');
}

function clearSearchSuggestions() {
  const container = mapState.searchSuggestionsEl;
  if (mapState.searchSuggestionTimer) {
    clearTimeout(mapState.searchSuggestionTimer);
    mapState.searchSuggestionTimer = null;
  }
  if (container) {
    container.innerHTML = '';
    container.classList.remove('visible');
  }
  mapState.searchSuggestions = [];
  mapState.searchActiveIndex = -1;
  const field = mapState.searchFieldEl;
  if (field) {
    field.classList.remove('has-suggestions');
  }
}

function highlightSearchSuggestion(index) {
  const container = mapState.searchSuggestionsEl;
  if (!container) return;
  const options = Array.from(container.querySelectorAll('.map-search-suggestion'));
  if (!options.length) return;
  const clamped = ((index % options.length) + options.length) % options.length;
  options.forEach((option, i) => {
    option.classList.toggle('active', i === clamped);
    if (i === clamped) {
      option.scrollIntoView({ block: 'nearest' });
    }
  });
  mapState.searchActiveIndex = clamped;
}

function applySearchSuggestion(index) {
  const suggestion = mapState.searchSuggestions?.[index];
  if (!suggestion) return;
  if (mapState.searchInput) {
    mapState.searchInput.value = suggestion.label;
    mapState.searchValue = suggestion.label;
    mapState.searchInput.focus();
  }
  clearSearchSuggestions();
  handleSearchSubmit(suggestion.label);
}

function setSearchInputState({ notFound = false } = {}) {
  const input = mapState.searchInput;
  if (input) {
    input.classList.toggle('not-found', Boolean(notFound));
  }
  if (mapState.searchFieldEl) {
    mapState.searchFieldEl.classList.toggle('not-found', Boolean(notFound));
  }
}

function createMapTabsPanel(activeTab) {
  const config = mapState.mapConfig || { tabs: [] };
  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'map-tabs';

  const header = document.createElement('div');
  header.className = 'map-tabs-header';

  const heading = document.createElement('div');
  heading.className = 'map-tabs-heading';
  const title = document.createElement('h2');
  title.className = 'map-tabs-title';
  title.textContent = 'Concept maps';
  heading.appendChild(title);
  const subtitle = document.createElement('p');
  subtitle.className = 'map-tabs-subtitle';
  subtitle.textContent = 'Jump between saved layouts or spin up a fresh canvas.';
  heading.appendChild(subtitle);
  header.appendChild(heading);

  const actions = document.createElement('div');
  actions.className = 'map-tab-actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'map-pill-btn map-tab-add';
  addBtn.setAttribute('aria-label', 'Create new map tab');
  addBtn.innerHTML = `${ICONS.plus}<span>New map</span>`;
  addBtn.addEventListener('click', () => {
    createMapTab();
  });
  actions.appendChild(addBtn);

  header.appendChild(actions);
  tabsWrap.appendChild(header);

  const tabList = document.createElement('div');
  tabList.className = 'map-tab-list';
  config.tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-tab' + (activeTab && tab.id === activeTab.id ? ' active' : '');
    btn.textContent = tab.name || 'Untitled map';
    btn.addEventListener('click', () => {
      if (!activeTab || tab.id !== activeTab.id) {
        setActiveTab(tab.id);
      }
    });
    tabList.appendChild(btn);
  });
  tabsWrap.appendChild(tabList);

  return tabsWrap;
}

function createSearchOverlay() {
  const searchWrap = document.createElement('div');
  searchWrap.className = 'map-search-container map-search-overlay';

  const form = document.createElement('form');
  form.className = 'map-search';
  form.addEventListener('submit', evt => {
    evt.preventDefault();
    handleSearchSubmit(input.value);
  });

  const field = document.createElement('div');
  field.className = 'map-search-field';

  const icon = document.createElement('span');
  icon.className = 'map-search-icon';
  icon.innerHTML = ICONS.search;
  field.appendChild(icon);

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'input map-search-input';
  input.placeholder = 'Search concepts…';
  input.value = mapState.searchValue || '';
  input.addEventListener('input', () => {
    mapState.searchValue = input.value;
    setSearchInputState({ notFound: false });
    if (!input.value.trim()) {
      updateSearchFeedback('', '');
    }
    updateSearchSuggestions(input.value);
  });
  input.addEventListener('focus', () => {
    if (mapState.searchSuggestionTimer) {
      clearTimeout(mapState.searchSuggestionTimer);
      mapState.searchSuggestionTimer = null;
    }
    updateSearchSuggestions(input.value);
  });
  input.addEventListener('blur', () => {
    if (mapState.searchSuggestionTimer) {
      clearTimeout(mapState.searchSuggestionTimer);
    }
    mapState.searchSuggestionTimer = setTimeout(() => {
      clearSearchSuggestions();
    }, 120);
  });
  input.addEventListener('keydown', evt => {
    if (!mapState.searchSuggestions || mapState.searchSuggestions.length === 0) return;
    if (evt.key === 'ArrowDown') {
      evt.preventDefault();
      const next = (mapState.searchActiveIndex + 1) % mapState.searchSuggestions.length;
      highlightSearchSuggestion(next);
    } else if (evt.key === 'ArrowUp') {
      evt.preventDefault();
      const total = mapState.searchSuggestions.length;
      const next = (mapState.searchActiveIndex - 1 + total) % total;
      highlightSearchSuggestion(next);
    } else if (evt.key === 'Enter') {
      if (mapState.searchActiveIndex >= 0 && mapState.searchActiveIndex < mapState.searchSuggestions.length) {
        evt.preventDefault();
        applySearchSuggestion(mapState.searchActiveIndex);
      }
    } else if (evt.key === 'Escape') {
      clearSearchSuggestions();
    }
  });
  field.appendChild(input);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'map-search-submit';
  submit.innerHTML = `${ICONS.arrowRight}<span class="sr-only">Search</span>`;
  field.appendChild(submit);

  form.appendChild(field);

  const suggestions = document.createElement('div');
  suggestions.className = 'map-search-suggestions';
  form.appendChild(suggestions);

  searchWrap.appendChild(form);

  const feedback = document.createElement('div');
  feedback.className = 'map-search-feedback';
  searchWrap.appendChild(feedback);

  mapState.searchInput = input;
  mapState.searchFieldEl = field;
  mapState.searchFeedbackEl = feedback;
  mapState.searchSuggestionsEl = suggestions;
  mapState.searchSuggestions = [];
  mapState.searchActiveIndex = -1;
  applyStoredSearchFeedback();
  updateSearchSuggestions(input.value);

  return searchWrap;
}

function createMapControlsPanel(activeTab) {
  const controls = document.createElement('div');
  controls.className = 'map-controls';
  if (!activeTab) {
    return controls;
  }

  const titleRow = document.createElement('div');
  titleRow.className = 'map-controls-row';

  const nameLabel = document.createElement('label');
  nameLabel.className = 'map-control map-control-name';
  nameLabel.textContent = 'Map name';
  const nameInput = document.createElement('input');
  nameInput.className = 'input map-name-input';
  nameInput.value = activeTab.name || '';
  nameInput.addEventListener('change', async () => {
    const next = nameInput.value.trim() || 'Untitled map';
    if (next === activeTab.name) return;
    activeTab.name = next;
    await persistMapConfig();
    await renderMap(mapState.root);
  });
  nameLabel.appendChild(nameInput);
  titleRow.appendChild(nameLabel);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'map-icon-btn danger map-delete-tab';
  deleteBtn.setAttribute('aria-label', 'Delete map');
  deleteBtn.innerHTML = `${ICONS.trash}<span class="sr-only">Delete map</span>`;
  if ((mapState.mapConfig?.tabs || []).length <= 1) {
    deleteBtn.disabled = true;
  }
  deleteBtn.addEventListener('click', () => {
    deleteActiveTab();
  });
  titleRow.appendChild(deleteBtn);

  controls.appendChild(titleRow);

  const toggleRow = document.createElement('div');
  toggleRow.className = 'map-controls-row';

  const manualToggle = document.createElement('label');
  manualToggle.className = 'map-toggle';
  const manualInput = document.createElement('input');
  manualInput.type = 'checkbox';
  manualInput.checked = Boolean(activeTab.manualMode);
  manualInput.addEventListener('change', async () => {
    activeTab.manualMode = manualInput.checked;
    if (manualInput.checked) {
      activeTab.filter.blockId = '';
      setFilterWeeks(activeTab.filter, []);
      setFilterLectureKeys(activeTab.filter, []);
      activeTab.includeLinked = false;
    } else {
      activeTab.includeLinked = true;
    }
    await persistMapConfig();
    await renderMap(mapState.root);
  });
  const manualSpan = document.createElement('span');
  manualSpan.textContent = 'Manual mode';
  manualToggle.appendChild(manualInput);
  manualToggle.appendChild(manualSpan);
  toggleRow.appendChild(manualToggle);

  const linkedToggle = document.createElement('label');
  linkedToggle.className = 'map-toggle';
  const linkedInput = document.createElement('input');
  linkedInput.type = 'checkbox';
  linkedInput.checked = activeTab.manualMode ? false : activeTab.includeLinked !== false;
  linkedInput.addEventListener('change', async () => {
    activeTab.includeLinked = linkedInput.checked;
    await persistMapConfig();
    await renderMap(mapState.root);
  });
  const linkedSpan = document.createElement('span');
  linkedSpan.textContent = 'Include linked concepts';
  linkedToggle.appendChild(linkedInput);
  linkedToggle.appendChild(linkedSpan);
  toggleRow.appendChild(linkedToggle);

  controls.appendChild(toggleRow);

  const filterRow = document.createElement('div');
  filterRow.className = 'map-controls-row';

  const blockWrap = document.createElement('label');
  blockWrap.className = 'map-control map-control-group';
  const blockLabel = document.createElement('span');
  blockLabel.className = 'map-control-label';
  blockLabel.textContent = 'Block';
  blockWrap.appendChild(blockLabel);
  const blockSelect = document.createElement('select');
  blockSelect.className = 'map-select';
  const blocks = mapState.blocks || [];
  const blockDefault = document.createElement('option');
  blockDefault.value = '';
  blockDefault.textContent = 'All blocks';
  blockSelect.appendChild(blockDefault);
  blocks.forEach(block => {
    const opt = document.createElement('option');
    opt.value = block.blockId;
    opt.textContent = block.name || block.blockId;
    blockSelect.appendChild(opt);
  });
  blockSelect.value = activeTab.filter.blockId || '';
  blockSelect.disabled = Boolean(activeTab.manualMode);
  blockSelect.addEventListener('change', async () => {
    activeTab.filter.blockId = blockSelect.value;
    setFilterWeeks(activeTab.filter, []);
    setFilterLectureKeys(activeTab.filter, []);
    await persistMapConfig();
    await renderMap(mapState.root);
  });
  blockWrap.appendChild(blockSelect);
  filterRow.appendChild(blockWrap);

  const makeChip = ({ label, active = false, onToggle, disabled = false, title }) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'map-chip' + (active ? ' active' : '');
    chip.textContent = label;
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (title) {
      chip.title = title;
    }
    if (disabled) {
      chip.disabled = true;
      chip.classList.add('disabled');
    } else if (typeof onToggle === 'function') {
      chip.addEventListener('click', onToggle);
    }
    return chip;
  };

  const selectedWeeks = new Set(getFilterWeeks(activeTab.filter));
  const selectedLectures = new Set(getFilterLectureKeys(activeTab.filter));
  const weekBlock = blocks.find(b => b.blockId === blockSelect.value);
  const filtersDisabled = Boolean(activeTab.manualMode);
  const hasBlock = Boolean(blockSelect.value);

  const weekWrap = document.createElement('div');
  weekWrap.className = 'map-control map-control-group';
  const weekLabel = document.createElement('div');
  weekLabel.className = 'map-control-label';
  weekLabel.textContent = 'Weeks';
  weekWrap.appendChild(weekLabel);
  const weekList = document.createElement('div');
  weekList.className = 'map-chip-list';
  weekWrap.appendChild(weekList);

  const applyWeeks = async nextWeeks => {
    setFilterWeeks(activeTab.filter, nextWeeks);
    setFilterLectureKeys(activeTab.filter, []);
    await persistMapConfig();
    await renderMap(mapState.root);
  };

  if (!hasBlock || filtersDisabled) {
    const message = document.createElement('div');
    message.className = 'map-chip-empty';
    message.textContent = filtersDisabled ? 'Disabled in manual mode.' : 'Choose a block to filter weeks.';
    weekList.appendChild(message);
  } else {
    const weekNumbers = new Set();
    if (weekBlock) {
      if (Number(weekBlock.weeks)) {
        for (let i = 1; i <= Number(weekBlock.weeks); i++) {
          weekNumbers.add(i);
        }
      }
      (weekBlock.lectures || []).forEach(lec => {
        if (Number.isFinite(lec?.week)) {
          weekNumbers.add(lec.week);
        }
      });
    }
    const sortedWeeks = Array.from(weekNumbers).sort((a, b) => a - b);
    weekList.appendChild(
      makeChip({
        label: 'All weeks',
        active: selectedWeeks.size === 0,
        onToggle: () => applyWeeks([])
      })
    );
    if (!sortedWeeks.length) {
      const empty = document.createElement('div');
      empty.className = 'map-chip-empty';
      empty.textContent = 'No weeks found for this block.';
      weekList.appendChild(empty);
    } else {
      sortedWeeks.forEach(num => {
        weekList.appendChild(
          makeChip({
            label: `Week ${num}`,
            active: selectedWeeks.has(num),
            onToggle: () => {
              const next = new Set(selectedWeeks);
              if (next.has(num)) {
                next.delete(num);
              } else {
                next.add(num);
              }
              applyWeeks(Array.from(next).sort((a, b) => a - b));
            }
          })
        );
      });
    }
  }
  filterRow.appendChild(weekWrap);

  const lectureWrap = document.createElement('div');
  lectureWrap.className = 'map-control map-control-group';
  const lectureLabel = document.createElement('div');
  lectureLabel.className = 'map-control-label';
  lectureLabel.textContent = 'Lectures';
  lectureWrap.appendChild(lectureLabel);
  const lectureList = document.createElement('div');
  lectureList.className = 'map-chip-list';
  lectureWrap.appendChild(lectureList);

  const applyLectures = async nextKeys => {
    setFilterLectureKeys(activeTab.filter, nextKeys);
    await persistMapConfig();
    await renderMap(mapState.root);
  };

  if (!hasBlock || filtersDisabled) {
    const message = document.createElement('div');
    message.className = 'map-chip-empty';
    message.textContent = filtersDisabled ? 'Disabled in manual mode.' : 'Choose a block first.';
    lectureList.appendChild(message);
  } else {
    const lectures = Array.isArray(weekBlock?.lectures) ? weekBlock.lectures : [];
    const filteredLectures = lectures
      .filter(lec => !selectedWeeks.size || selectedWeeks.has(Number(lec.week)))
      .sort((a, b) => {
        const weekA = Number(a.week) || 0;
        const weekB = Number(b.week) || 0;
        if (weekA !== weekB) return weekA - weekB;
        const idA = Number(a.id) || 0;
        const idB = Number(b.id) || 0;
        return idA - idB;
      });

    lectureList.appendChild(
      makeChip({
        label: 'All lectures',
        active: selectedLectures.size === 0,
        onToggle: () => applyLectures([])
      })
    );

    if (!filteredLectures.length) {
      const empty = document.createElement('div');
      empty.className = 'map-chip-empty';
      empty.textContent = selectedWeeks.size
        ? 'No lectures match the selected weeks.'
        : 'No lectures found for this block.';
      lectureList.appendChild(empty);
    } else {
      filteredLectures.forEach(lec => {
        const keyParts = [`block:${weekBlock.blockId}`];
        if (lec.id != null && lec.id !== '') {
          keyParts.push(`id:${lec.id}`);
        }
        if (lec.name) {
          keyParts.push(`name:${lec.name}`);
        }
        if (Number.isFinite(Number(lec.week))) {
          keyParts.push(`week:${Number(lec.week)}`);
        }
        const key = keyParts.join('|');
        const legacyKey = `${weekBlock.blockId}|${lec.id}`;
        const isActive = selectedLectures.has(key) || selectedLectures.has(legacyKey);
        const label = lec.name ? lec.name : `Lecture ${lec.id}`;
        const weekLabel = Number.isFinite(lec.week) ? `Week ${lec.week}` : '';
        lectureList.appendChild(
          makeChip({
            label: weekLabel ? `${label} · ${weekLabel}` : label,
            title: weekLabel ? `${label} (${weekLabel})` : label,
            active: isActive,
            onToggle: () => {
              const next = new Set(selectedLectures);
              next.delete(legacyKey);
              if (isActive) {
                next.delete(key);
              } else {
                next.add(key);
              }
              applyLectures(Array.from(next));
            }
          })
        );
      });
    }
  }
  filterRow.appendChild(lectureWrap);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn map-reset-filters';
  resetBtn.textContent = 'Clear filters';
  resetBtn.disabled = Boolean(activeTab.manualMode);
  resetBtn.addEventListener('click', async () => {
    activeTab.filter.blockId = '';
    setFilterWeeks(activeTab.filter, []);
    setFilterLectureKeys(activeTab.filter, []);
    await persistMapConfig();
    await renderMap(mapState.root);
  });
  filterRow.appendChild(resetBtn);

  controls.appendChild(filterRow);

  const layoutRow = document.createElement('div');
  layoutRow.className = 'map-controls-row map-controls-row--actions';
  const reorganizeBtn = document.createElement('button');
  reorganizeBtn.type = 'button';
  reorganizeBtn.className = 'btn secondary map-reorganize-btn';
  reorganizeBtn.textContent = 'Smart reorganize';
  reorganizeBtn.addEventListener('click', async () => {
    if (reorganizeBtn.dataset.state === 'busy') return;
    const originalText = reorganizeBtn.textContent;
    reorganizeBtn.dataset.state = 'busy';
    reorganizeBtn.disabled = true;
    reorganizeBtn.textContent = 'Organizing…';
    try {
      await smartReorganizeActiveMap();
    } catch (err) {
      console.error(err);
    } finally {
      reorganizeBtn.disabled = false;
      reorganizeBtn.textContent = originalText;
      delete reorganizeBtn.dataset.state;
    }
  });
  layoutRow.appendChild(reorganizeBtn);
  controls.appendChild(layoutRow);

  return controls;
}

function createMapPalettePanel(items, activeTab) {
  if (!activeTab || !activeTab.manualMode) {
    return null;
  }
  const palette = document.createElement('div');
  palette.className = 'map-palette';

  const title = document.createElement('h3');
  title.textContent = 'Concept library';
  palette.appendChild(title);

  const description = document.createElement('p');
  description.className = 'map-palette-hint';
  description.textContent = 'Drag terms onto the canvas to add them to this map.';
  palette.appendChild(description);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'input map-palette-search';
  searchInput.placeholder = 'Filter terms';
  searchInput.value = mapState.paletteSearch || '';
  palette.appendChild(searchInput);

  const list = document.createElement('div');
  list.className = 'map-palette-list';
  palette.appendChild(list);

  const manualSet = new Set(Array.isArray(activeTab.manualIds) ? activeTab.manualIds : []);
  const itemMap = mapState.itemMap || {};

  function renderList() {
    list.innerHTML = '';
    const query = searchInput.value.trim().toLowerCase();
    const available = items
      .filter(it => !manualSet.has(it.id))
      .filter(it => !query || titleOf(it).toLowerCase().includes(query))
      .sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
    if (!available.length) {
      const empty = document.createElement('div');
      empty.className = 'map-palette-empty';
      empty.textContent = query ? 'No matching terms.' : 'All terms have been added.';
      list.appendChild(empty);
      return;
    }
    available.forEach(it => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-palette-item';
      btn.textContent = titleOf(it) || it.id;
      btn.addEventListener('mousedown', evt => {
        const sourceItem = itemMap[it.id] || it;
        startMenuDrag(sourceItem, evt, { source: 'palette' });
      });
      list.appendChild(btn);
    });
  }

  searchInput.addEventListener('input', () => {
    mapState.paletteSearch = searchInput.value;
    renderList();
  });

  renderList();

  const activeWrap = document.createElement('div');
  activeWrap.className = 'map-palette-active';
  const activeTitle = document.createElement('h4');
  activeTitle.textContent = `Active concepts (${manualSet.size})`;
  activeWrap.appendChild(activeTitle);

  const activeList = document.createElement('div');
  activeList.className = 'map-palette-active-list';
  if (!manualSet.size) {
    const empty = document.createElement('div');
    empty.className = 'map-palette-empty';
    empty.textContent = 'No concepts yet. Drag from the library to begin.';
    activeList.appendChild(empty);
  } else {
    activeTab.manualIds.forEach(id => {
      const item = itemMap[id];
      if (!item) return;
      const row = document.createElement('div');
      row.className = 'map-palette-active-item';
      const label = document.createElement('span');
      label.textContent = titleOf(item) || id;
      row.appendChild(label);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-btn ghost';
      removeBtn.setAttribute('aria-label', `Remove ${titleOf(item) || 'item'} from this map`);
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', async () => {
        const tab = getActiveTab();
        if (!tab) return;
        tab.manualIds = (tab.manualIds || []).filter(mid => mid !== id);
        await persistMapConfig();
        await renderMap(mapState.root);
      });
      row.appendChild(removeBtn);
      activeList.appendChild(row);
    });
  }
  activeWrap.appendChild(activeList);
  palette.appendChild(activeWrap);

  return palette;
}

function handleSearchSubmit(rawQuery) {
  clearSearchSuggestions();
  const query = (rawQuery || '').trim();
  if (!query) {
    mapState.searchValue = '';
    updateSearchFeedback('', '');
    setSearchInputState({ notFound: false });
    return;
  }
  mapState.searchValue = rawQuery;
  const items = mapState.visibleItems || [];
  const lower = query.toLowerCase();
  let match = items.find(it => (titleOf(it) || '').toLowerCase() === lower);
  if (!match) {
    match = items.find(it => (titleOf(it) || '').toLowerCase().includes(lower));
  }
  if (!match) {
    updateSearchFeedback('No matching concept on this map.', 'error');
    setSearchInputState({ notFound: true });
    return;
  }
  const success = centerOnNode(match.id);
  if (success) {
    updateSearchFeedback(`Centered on ${titleOf(match)}.`, 'success');
    setSearchInputState({ notFound: false });
  } else {
    updateSearchFeedback('Could not focus on that concept.', 'error');
    setSearchInputState({ notFound: true });
  }
}

function centerOnNode(id, options = {}) {
  if (!mapState.viewBox || !mapState.positions) return false;
  const pos = mapState.positions[id];
  if (!pos) return false;
  const width = mapState.viewBox.w;
  const height = mapState.viewBox.h;
  const limit = mapState.sizeLimit || 0;
  const maxX = Math.max(0, limit - width);
  const maxY = Math.max(0, limit - height);
  const nextX = clamp(pos.x - width / 2, 0, maxX);
  const nextY = clamp(pos.y - height / 2, 0, maxY);
  if (Number.isFinite(nextX)) mapState.viewBox.x = nextX;
  if (Number.isFinite(nextY)) mapState.viewBox.y = nextY;
  if (mapState.updateViewBox) {
    mapState.updateViewBox({ immediate: true });
  }
  if (options.select !== false) {
    mapState.selectionIds = [id];
    updateSelectionHighlight();
  }
  return true;
}

function filterHasCriteria(filter = {}) {
  if (!filter || typeof filter !== 'object') {
    return false;
  }
  if (typeof filter.blockId === 'string' && filter.blockId.trim()) {
    return true;
  }
  if (getFilterWeeks(filter).length) {
    return true;
  }
  if (getFilterLectureKeys(filter).length) {
    return true;
  }
  return false;
}

function matchesFilter(item, filter = {}) {
  if (!filter) return true;
  const normalizedBlock = typeof filter.blockId === 'string' ? filter.blockId.trim() : '';
  const weekValues = getFilterWeeks(filter).map(week => Number(week)).filter(Number.isFinite);
  const weekSet = new Set(weekValues);
  const lectureKeys = getFilterLectureKeys(filter);
  const lectureFilters = lectureKeys.map(key => parseLectureFilterKey(key, normalizedBlock));
  const lectures = Array.isArray(item.lectures) ? item.lectures : [];
  const blocks = Array.isArray(item.blocks) ? item.blocks : [];

  if (normalizedBlock) {
    const inBlock = blocks.includes(normalizedBlock) || lectures.some(lec => lec?.blockId === normalizedBlock);
    if (!inBlock) return false;
  }

  if (weekSet.size) {
    const satisfiesWeek = lectures.some(lec => {
      if (!lec) return false;
      if (normalizedBlock && lec.blockId !== normalizedBlock) return false;
      const weekNumber = Number(lec.week);
      return Number.isFinite(weekNumber) && weekSet.has(weekNumber);
    }) || (Array.isArray(item.weeks) && item.weeks.some(week => weekSet.has(Number(week))));
    if (!satisfiesWeek) return false;
  }

  if (lectureFilters.length) {
    const satisfiesLecture = lectureFilters.some(spec => {
      const blockMatch = (spec.block || normalizedBlock || '').trim();
      const idMatch = (spec.id || '').trim().toLowerCase();
      const nameMatch = (spec.name || '').trim().toLowerCase();
      const weekMatch = Number.isFinite(Number(spec.week)) ? Number(spec.week) : null;
      return lectures.some(lec => {
        if (!lec) return false;
        if (blockMatch && lec.blockId !== blockMatch) return false;
        if (weekMatch !== null) {
          const lecWeek = Number(lec.week);
          if (!Number.isFinite(lecWeek) || lecWeek !== weekMatch) {
            return false;
          }
        }
        const values = new Set();
        if (lec.id != null) {
          const idValue = String(lec.id).trim().toLowerCase();
          if (idValue) {
            values.add(idValue);
          }
        }
        if (lec.uid != null) {
          const uidValue = String(lec.uid).trim().toLowerCase();
          if (uidValue) {
            values.add(uidValue);
          }
        }
        if (lec.name) {
          values.add(lec.name.trim().toLowerCase());
        }
        if (idMatch && values.has(idMatch)) return true;
        if (nameMatch && values.has(nameMatch)) return true;
        return !idMatch && !nameMatch;
      });
    });
    if (!satisfiesLecture) return false;
  }

  return true;
}

function applyTabFilters(items, tab) {
  if (!tab) {
    return items.filter(it => !it.mapHidden);
  }
  const manualSet = new Set(Array.isArray(tab.manualIds) ? tab.manualIds : []);
  let base;
  if (tab.manualMode) {
    base = items.filter(it => manualSet.has(it.id));
  } else {
    base = items.filter(it => !it.mapHidden && matchesFilter(it, tab.filter));
  }
  const allowed = new Set(base.map(it => it.id));
  const filterActive = !tab.manualMode && filterHasCriteria(tab.filter);
  if (tab.includeLinked !== false) {
    const queue = [...allowed];
    while (queue.length) {
      const id = queue.pop();
      const item = mapState.itemMap?.[id];
      if (!item) continue;
      (item.links || []).forEach(link => {
        const other = mapState.itemMap?.[link.id];
        if (!other) return;
        if (other.mapHidden && !manualSet.has(other.id)) return;
        if (!allowed.has(other.id) && (!filterActive || matchesFilter(other, tab.filter))) {
          allowed.add(other.id);
          queue.push(other.id);
        }
      });
    }
  }
  return items.filter(it => {
    if (!allowed.has(it.id)) return false;
    if (tab.manualMode) {
      if (manualSet.has(it.id)) return true;
      return !it.mapHidden;
    }
    return !it.mapHidden || manualSet.has(it.id);
  });
}

function openItemPopup(itemId) {
  const item = mapState.itemMap?.[itemId];
  if (!item) return;
  showPopup(item, {
    onEdit: () => openItemEditor(itemId),
    onColorChange: color => updateItemColor(itemId, color),
    onLink: () => openLinkAssistant(itemId),
    onGravityChange: value => updateItemGravityBoost(itemId, value)
  });
}

function openItemEditor(itemId) {
  const item = mapState.itemMap?.[itemId];
  if (!item) return;
  openEditor(item.kind, async () => {
    await renderMap(mapState.root);
  }, item);
}

async function updateItemColor(itemId, color) {
  const item = await getItem(itemId);
  if (!item) return;
  const normalized = typeof color === 'string' && color ? color : '';
  if (normalized) {
    item.color = normalized;
  } else if (item.color) {
    delete item.color;
  }
  await upsertItem(item);
  if (!mapState.itemMap) {
    mapState.itemMap = {};
  }
  const cached = mapState.itemMap[itemId];
  if (cached) {
    if (normalized) {
      cached.color = normalized;
    } else {
      delete cached.color;
    }
  }
  if (Array.isArray(mapState.visibleItems)) {
    const visible = mapState.visibleItems.find(it => it.id === itemId);
    if (visible) {
      if (normalized) {
        visible.color = normalized;
      } else {
        delete visible.color;
      }
    }
  }
  refreshNodeColor(itemId);
}

async function updateItemGravityBoost(itemId, boost) {
  const item = await getItem(itemId);
  if (!item) return 0;
  const normalized = normalizeGravityBoost(boost);
  item.mapGravityBoost = normalized;
  await upsertItem(item);
  integrateItemUpdates(item);
  refreshGravityModel();
  return normalized;
}

function parseLectureFilterKey(rawKey, fallbackBlock = '') {
  const info = {
    block: fallbackBlock || '',
    id: '',
    name: '',
    week: ''
  };
  if (!rawKey) {
    return info;
  }
  const parts = String(rawKey)
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);
  parts.forEach((part, index) => {
    if (part.startsWith('block:')) {
      info.block = part.slice(6) || info.block;
    } else if (part.startsWith('id:')) {
      info.id = part.slice(3) || info.id;
    } else if (part.startsWith('name:')) {
      info.name = part.slice(5) || info.name;
    } else if (part.startsWith('week:')) {
      info.week = part.slice(5) || info.week;
    } else if (index === 0 && !info.block) {
      info.block = part;
    } else if (!info.id) {
      info.id = part;
    }
  });
  return info;
}

function setAreaInteracting(active) {
  if (!mapState.root) return;
  runMutation(() => {
    mapState.root.classList.toggle('map-area-interacting', Boolean(active));
  }, { immediate: !mapState.root.isConnected });
}

export async function renderMap(root) {
  if (mapState.root && mapState.root !== root) {
    runMutation(() => {
      mapState.root?.classList.remove('map-area-interacting');
    }, { immediate: true });
  }
  noteTabRender('map');
  mapState.root = root;
  closeLineMenu();
  await flushViewStatePersist();
  const fragment = document.createDocumentFragment();
  mapState.nodeDrag = null;
  mapState.areaDrag = null;
  mapState.draggingView = false;
  mapState.menuDrag = null;
  mapState.edgeDrag = null;
  if (mapState.pendingEdgeUpdates) {
    mapState.pendingEdgeUpdates.clear();
  }
  if (mapState.pendingEdgeAnimations) {
    mapState.pendingEdgeAnimations.clear();
  }
  mapState.edgeUpdateFrame = null;
  mapState.selectionRect = null;
  mapState.previewSelection = null;
  mapState.selectionPreviewSignature = '';
  mapState.nodeWasDragged = false;
  mapState.justCompletedSelection = false;
  mapState.edgeDragJustCompleted = false;
  mapState.viewPointerId = null;
  mapState.searchInput = null;
  mapState.searchFieldEl = null;
  mapState.searchFeedbackEl = null;
  mapState.searchSuggestions = [];
  mapState.searchSuggestionsEl = null;
  mapState.searchActiveIndex = -1;
  if (mapState.searchSuggestionTimer) {
    clearTimeout(mapState.searchSuggestionTimer);
    mapState.searchSuggestionTimer = null;
  }
  stopToolboxDrag();
  mapState.toolboxEl = null;
  mapState.toolboxContainer = null;
  mapState.toolboxBadges = null;
  mapState.cursorOverride = null;
  mapState.hoveredEdge = null;
  mapState.hoveredEdgePointer = { x: 0, y: 0 };
  if (mapState.lineMarkers) {
    mapState.lineMarkers.clear();
  } else {
    mapState.lineMarkers = new Map();
  }
  if (mapState.edgeRefs) {
    mapState.edgeRefs.clear();
  } else {
    mapState.edgeRefs = new Map();
  }
  if (mapState.allEdges) {
    mapState.allEdges.clear();
  } else {
    mapState.allEdges = new Set();
  }
  stopAutoPan();
  setAreaInteracting(false);
  mapState.edgeLayer = null;
  mapState.nodeLayer = null;
  flushNodePositionUpdates({ cancelFrame: true });
  if (mapState.pendingNodeUpdates) {
    mapState.pendingNodeUpdates.clear();
  }

  ensureListeners();

  await ensureMapConfig();
  const catalog = await loadBlockCatalog();
  mapState.blocks = (catalog.blocks || []).map(block => ({
    ...block,
    lectures: (catalog.lectureLists?.[block.blockId] || []).map(lecture => ({ ...lecture }))
  }));

  const items = [
    ...(await listItemsByKind('disease')),
    ...(await listItemsByKind('drug')),
    ...(await listItemsByKind('concept'))
  ];

  const hiddenNodes = items.filter(it => it.mapHidden);

  const itemMap = Object.fromEntries(items.map(it => [it.id, it]));
  mapState.itemMap = itemMap;

  const activeTab = getActiveTab();
  const visibleItems = applyTabFilters(items, activeTab);
  mapState.visibleItems = visibleItems;

  const itemGroupCache = new Map();
  visibleItems.forEach(it => {
    itemGroupCache.set(it.id, deriveItemGroupKeys(it));
  });

  const base = 1000;
  const size = Math.max(base, visibleItems.length * 150);
  const viewport = base;
  mapState.sizeLimit = size * 2;
  mapState.minView = 100;

  const wrapper = document.createElement('div');
  wrapper.className = 'map-wrapper';
  fragment.appendChild(wrapper);

  const stage = document.createElement('div');
  stage.className = 'map-stage';
  wrapper.appendChild(stage);

  const container = document.createElement('div');
  container.className = 'map-container';
  stage.appendChild(container);
  mapState.container = container;
  container.addEventListener('pointerdown', e => {
    if (mapState.tool === TOOL.AREA) return;
    if (e.button !== 0) return;
    if (e.target !== container) return;
    closeLineMenu();
    if (beginViewDrag(e)) {
      e.preventDefault();
    }
  });

  const overlay = document.createElement('div');
  overlay.className = 'map-overlay';
  stage.appendChild(overlay);

  const menu = document.createElement('div');
  menu.className = 'map-menu';
  overlay.appendChild(menu);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'map-menu-toggle';
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open map controls');
  toggle.innerHTML = `<span class="map-menu-icon" aria-hidden="true">${ICONS.sliders}</span><span class="sr-only">Open map controls</span>`;
  menu.appendChild(toggle);

  const panel = document.createElement('div');
  panel.className = 'map-menu-panel';
  panel.setAttribute('aria-label', 'Map controls');
  menu.appendChild(panel);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'map-menu-close';
  closeBtn.setAttribute('aria-label', 'Hide map controls');
  closeBtn.innerHTML = `<span class="sr-only">Hide map controls</span>${ICONS.close}`;
  const panelHeader = document.createElement('div');
  panelHeader.className = 'map-menu-header';
  const panelTitle = document.createElement('div');
  panelTitle.className = 'map-menu-title';
  panelTitle.textContent = 'Map controls';
  panelHeader.appendChild(panelTitle);
  panelHeader.appendChild(closeBtn);
  panel.appendChild(panelHeader);

  const tabsPanel = createMapTabsPanel(activeTab);
  panel.appendChild(tabsPanel);

  const controlsPanel = createMapControlsPanel(activeTab);
  if (controlsPanel) {
    panel.appendChild(controlsPanel);
  }

  const palettePanel = createMapPalettePanel(items, activeTab);
  if (palettePanel) {
    panel.appendChild(palettePanel);
  }

  const searchOverlay = createSearchOverlay();
  overlay.appendChild(searchOverlay);

  let menuHoverOpen = Boolean(mapState.menuPinned) || Boolean(mapState.menuOpen);
  let menuHoverCloseTimer = null;

  const clearMenuHoverClose = () => {
    if (menuHoverCloseTimer !== null) {
      clearTimeout(menuHoverCloseTimer);
      menuHoverCloseTimer = null;
    }
  };

  const applyMenuState = () => {
    const open = Boolean(mapState.menuPinned) || menuHoverOpen;
    mapState.menuOpen = open;
    runMutation(() => {
      menu.classList.toggle('open', open);
      menu.classList.toggle('pinned', Boolean(mapState.menuPinned));
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-pressed', mapState.menuPinned ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Hide map controls' : 'Open map controls');
    });
  };

  const openMenu = ({ pinned = false } = {}) => {
    if (pinned) {
      mapState.menuPinned = true;
    }
    menuHoverOpen = true;
    mapState.menuOpen = true;
    clearMenuHoverClose();
    applyMenuState();
  };

  const closeMenu = ({ unpin = false } = {}) => {
    if (unpin) {
      mapState.menuPinned = false;
    }
    menuHoverOpen = false;
    if (!mapState.menuPinned) {
      mapState.menuOpen = false;
    }
    clearMenuHoverClose();
    applyMenuState();
  };

  const scheduleMenuClose = () => {
    if (mapState.menuPinned) {
      return;
    }
    clearMenuHoverClose();
    menuHoverCloseTimer = setTimeout(() => {
      menuHoverCloseTimer = null;
      closeMenu();
    }, 140);
  };

  applyMenuState();

  toggle.addEventListener('click', evt => {
    evt.preventDefault();
    if (mapState.menuPinned) {
      closeMenu({ unpin: true });
    } else {
      openMenu({ pinned: true });
    }
  });


  const handleHoverOpen = () => openMenu();

  menu.addEventListener('mouseenter', handleHoverOpen);
  toggle.addEventListener('mouseenter', handleHoverOpen);
  panel.addEventListener('mouseenter', handleHoverOpen);
  toggle.addEventListener('focusin', handleHoverOpen);
  panel.addEventListener('focusin', handleHoverOpen);

  menu.addEventListener('mouseleave', scheduleMenuClose);
  menu.addEventListener('focusout', evt => {
    if (!menu.contains(evt.relatedTarget) && !mapState.menuPinned) {

      closeMenu();
    }
  });


  closeBtn.addEventListener('click', () => {
    closeMenu({ unpin: true });
  });


  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('map-svg');
  const defaultView = {
    x: (size - viewport) / 2,
    y: (size - viewport) / 2,
    w: viewport,
    h: viewport
  };
  const minSize = mapState.minView || defaultView.w;
  const maxSize = mapState.sizeLimit || defaultView.w;
  const storedView = getRestorableViewState(activeTab);
  let viewBox;
  let restoredFromMemory = false;
  let pendingFocusId = null;
  if (mapState.viewBox) {
    const current = mapState.viewBox;
    const cx = Number.isFinite(current.x) && Number.isFinite(current.w) ? current.x + current.w / 2 : defaultView.x + defaultView.w / 2;
    const cy = Number.isFinite(current.y) && Number.isFinite(current.h) ? current.y + current.h / 2 : defaultView.y + defaultView.h / 2;
    const desiredSize = Number.isFinite(current.w) ? current.w : defaultView.w;
    const clamped = clamp(desiredSize, minSize, maxSize);
    viewBox = {
      x: cx - clamped / 2,
      y: cy - clamped / 2,
      w: clamped,
      h: clamped
    };
    restoredFromMemory = true;
  } else if (storedView) {
    const desiredSize = Number.isFinite(storedView.w) ? storedView.w : defaultView.w;
    const clamped = clamp(desiredSize, minSize, maxSize);
    const limit = Math.max(mapState.sizeLimit || 0, clamped);
    const maxX = limit - clamped;
    const maxY = limit - clamped;
    const sx = Number.isFinite(storedView.x) ? storedView.x : defaultView.x;
    const sy = Number.isFinite(storedView.y) ? storedView.y : defaultView.y;
    viewBox = {
      x: clamp(sx, 0, maxX),
      y: clamp(sy, 0, maxY),
      w: clamped,
      h: clamped
    };
    restoredFromMemory = true;
  } else {
    viewBox = { ...defaultView };
    const newest = findNewestVisibleNode(visibleItems);
    if (newest) {
      pendingFocusId = newest.id;
    }
  }

  mapState.pendingFocusId = pendingFocusId;
  mapState.restoredViewFromMemory = restoredFromMemory;

  mapState.svg = svg;
  mapState.viewBox = viewBox;
  if (!Number.isFinite(mapState.defaultViewSize)) {
    mapState.defaultViewSize = viewBox.w;
  }

  const commitViewBox = (options = {}) => {
    svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
    const { forceScale = false } = options;
    if (forceScale) {
      mapState.lastScaleSize = { w: viewBox.w, h: viewBox.h };
      adjustScale();
      rememberViewBox();
      return;
    }
    const prev = mapState.lastScaleSize;
    const sizeChanged =
      !prev || Math.abs(prev.w - viewBox.w) > 0.5 || Math.abs(prev.h - viewBox.h) > 0.5;
    if (sizeChanged) {
      mapState.lastScaleSize = { w: viewBox.w, h: viewBox.h };
      adjustScale();
    }
    rememberViewBox();
  };

  const updateViewBox = (options = {}) => {
    const pending = {
      ...(mapState.pendingViewBoxOptions || {}),
      forceScale: Boolean(options.forceScale) || Boolean(mapState.pendingViewBoxOptions?.forceScale)
    };
    mapState.pendingViewBoxOptions = pending;
    const immediate = Boolean(options.immediate) || typeof window === 'undefined';
    if (immediate) {
      if (mapState.viewBoxFrame && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(mapState.viewBoxFrame);
      }
      mapState.viewBoxFrame = null;
      const commitOptions = mapState.pendingViewBoxOptions;
      mapState.pendingViewBoxOptions = null;
      commitViewBox(commitOptions || {});
      return;
    }
    if (mapState.viewBoxFrame) {
      return;
    }
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      const commitOptions = mapState.pendingViewBoxOptions;
      mapState.pendingViewBoxOptions = null;
      commitViewBox(commitOptions || {});
      return;
    }
    mapState.viewBoxFrame = window.requestAnimationFrame(() => {
      const commitOptions = mapState.pendingViewBoxOptions;
      mapState.pendingViewBoxOptions = null;
      mapState.viewBoxFrame = null;
      commitViewBox(commitOptions || {});
    });
  };

  mapState.updateViewBox = updateViewBox;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgeLayer.classList.add('map-layer', 'map-layer--edges');
  const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  nodeLayer.classList.add('map-layer', 'map-layer--nodes');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  buildLineMarkers(defs);
  g.appendChild(edgeLayer);
  g.appendChild(nodeLayer);
  svg.appendChild(defs);
  svg.appendChild(g);
  mapState.g = g;
  mapState.edgeLayer = edgeLayer;
  mapState.nodeLayer = nodeLayer;

  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'map-edge-tooltip hidden';
  container.appendChild(tooltip);
  mapState.edgeTooltip = tooltip;

  const selectionBox = document.createElement('div');
  selectionBox.className = 'map-selection hidden';
  container.appendChild(selectionBox);
  mapState.selectionBox = selectionBox;

  attachSvgEvents(svg);

  const positions = {};
  mapState.positions = positions;
  mapState.elements = new Map();

  const gravityModel = buildGravityModel(visibleItems);
  mapState.gravityModel = gravityModel;
  const nodeRadii = computeRadiiFromModel(gravityModel, visibleItems);
  mapState.nodeRadii = nodeRadii;

  let totalRadius = 0;
  let radiusCount = 0;
  let maxRadius = MIN_NODE_RADIUS;
  visibleItems.forEach(it => {
    const radius = nodeRadii.get(it.id) || MIN_NODE_RADIUS;
    if (!Number.isFinite(radius)) return;
    totalRadius += radius;
    radiusCount += 1;
    if (radius > maxRadius) {
      maxRadius = radius;
    }
  });
  const avgRadius = radiusCount ? totalRadius / radiusCount : MIN_NODE_RADIUS;
  const typicalRadius = Math.max(avgRadius, maxRadius * 0.75, MIN_NODE_RADIUS);
  const nodeLength = Math.max(70, typicalRadius * 2.0);
  const groupSpacingBase = Math.max(nodeLength * 1.05, maxRadius * 2.2 + 30);
  const lectureSpacingBase = Math.max(nodeLength * 2.5, maxRadius * 3.6);
  const weekSpacingBase = Math.max(lectureSpacingBase * 1.18, nodeLength * 3.8);
  const blockSpacingBase = Math.max(weekSpacingBase * 1.22, nodeLength * 5.0);

  const groupMetrics = new Map();
  const groupSpacingCache = new Map();
  function touchGroupMetric(key, radius, bucket) {
    if (!key) return;
    const metric = groupMetrics.get(key) || {
      existingCount: 0,
      pendingCount: 0,
      sumRadius: 0,
      maxRadius: 0
    };
    if (bucket === 'existing') {
      metric.existingCount += 1;
    } else if (bucket === 'pending') {
      metric.pendingCount += 1;
    }
    metric.sumRadius += radius;
    if (radius > metric.maxRadius) {
      metric.maxRadius = radius;
    }
    groupMetrics.set(key, metric);
  }
  function getGroupSpacing(key) {
    if (groupSpacingCache.has(key)) {
      return groupSpacingCache.get(key);
    }
    const metric = groupMetrics.get(key) || {
      existingCount: 0,
      pendingCount: 0,
      sumRadius: 0,
      maxRadius: 0
    };
    const totalCount = (metric.existingCount || 0) + (metric.pendingCount || 0);
    const maxR = metric.maxRadius || typicalRadius;
    const avgR = totalCount ? metric.sumRadius / totalCount : typicalRadius;
    const spacing = Math.max(groupSpacingBase, avgR * 2.0 + 20, maxR * 2.4 + 32);
    groupSpacingCache.set(key, spacing);
    return spacing;
  }

  const center = size / 2;
  const newItems = [];
  const layout = activeTab ? ensureTabLayout(activeTab) : null;
  const allowLegacyPositions = Boolean(activeTab && activeTab.layoutSeeded !== true);
  let layoutDirty = false;
  let legacyImported = false;

  visibleItems.forEach(it => {
    if (layout && layout[it.id]) {
      positions[it.id] = { ...layout[it.id] };
      return;
    }
    const legacy = it.mapPos;
    if (
      allowLegacyPositions &&
      legacy &&
      typeof legacy === 'object' &&
      Number.isFinite(Number(legacy.x)) &&
      Number.isFinite(Number(legacy.y))
    ) {
      const x = Number(legacy.x);
      const y = Number(legacy.y);
      positions[it.id] = { x, y };
      if (layout) {
        layout[it.id] = { x, y };
        layoutDirty = true;
        legacyImported = true;
      }
      return;
    }
    const groups = itemGroupCache.get(it.id) || deriveItemGroupKeys(it);
    const primaryGroup = getPrimaryGroupKey(it, groups);
    const weight = gravityModel.weights?.get(it.id) || 0;
    newItems.push({ item: it, primaryGroup, degree: weight });
  });

  const existingGroupInfo = new Map();
  Object.entries(positions).forEach(([id, pos]) => {
    if (!pos) return;
    const groups = itemGroupCache.get(id) || [];
    const radius = nodeRadii.get(id) || MIN_NODE_RADIUS;
    groups.forEach(key => {
      const info = existingGroupInfo.get(key) || {
        minX: pos.x,
        maxX: pos.x,
        minY: pos.y,
        maxY: pos.y,
        count: 0,
        maxRadius: radius,
        sumRadius: 0
      };
      info.count += 1;
      info.minX = Math.min(info.minX, pos.x);
      info.maxX = Math.max(info.maxX, pos.x);
      info.minY = Math.min(info.minY, pos.y);
      info.maxY = Math.max(info.maxY, pos.y);
      info.maxRadius = Math.max(info.maxRadius ?? radius, radius);
      info.sumRadius = (info.sumRadius || 0) + radius;
      existingGroupInfo.set(key, info);
      touchGroupMetric(key, radius, 'existing');
    });
  });

  const pendingCounts = new Map();
  newItems.forEach(entry => {
    pendingCounts.set(entry.primaryGroup, (pendingCounts.get(entry.primaryGroup) || 0) + 1);
    const radius = nodeRadii.get(entry.item.id) || MIN_NODE_RADIUS;
    touchGroupMetric(entry.primaryGroup, radius, 'pending');
  });

  const clusterOrigins = new Map();
  const seenGroups = new Set();
  const newGroupOrder = [];
  newItems.forEach(entry => {
    const key = entry.primaryGroup;
    if (existingGroupInfo.has(key)) return;
    if (seenGroups.has(key)) return;
    seenGroups.add(key);
    newGroupOrder.push(key);
  });

  const blockAggregates = new Map();
  const weekAggregates = new Map();
  const lecturesByWeek = new Map();
  const lectureCenters = new Map();
  existingGroupInfo.forEach((info, key) => {
    const parsed = parseGroupKey(key);
    const blockKey = parsed.block || '__';
    const weekId = parsed.week || '__';
    const weekKey = `${blockKey}::${weekId}`;
    const centerX = (info.minX + info.maxX) / 2;
    const centerY = (info.minY + info.maxY) / 2;
    const blockAgg = blockAggregates.get(blockKey) || { x: 0, y: 0, count: 0 };
    blockAgg.x += centerX;
    blockAgg.y += centerY;
    blockAgg.count += 1;
    blockAggregates.set(blockKey, blockAgg);
    const weekAgg = weekAggregates.get(weekKey) || { x: 0, y: 0, count: 0 };
    weekAgg.x += centerX;
    weekAgg.y += centerY;
    weekAgg.count += 1;
    weekAggregates.set(weekKey, weekAgg);
    const lectureList = lecturesByWeek.get(weekKey) || [];
    lectureList.push({ x: centerX, y: centerY, spacing: lectureSpacingBase });
    lecturesByWeek.set(weekKey, lectureList);
    const lectureKey = `${weekKey}::${parsed.lecture || key}`;
    if (!lectureCenters.has(lectureKey)) {
      lectureCenters.set(lectureKey, { x: centerX, y: centerY, spacing: getGroupSpacing(key) });
    }
  });

  const blockCenters = new Map();
  const blockPositionList = [];
  blockAggregates.forEach((agg, blockKey) => {
    if (!agg.count) return;
    const point = {
      x: agg.x / agg.count,
      y: agg.y / agg.count,
      spacing: blockSpacingBase,
      buffer: blockSpacingBase
    };
    blockCenters.set(blockKey, point);
    blockPositionList.push(point);
  });

  const weekCenters = new Map();
  const weekPositionsByBlock = new Map();
  weekAggregates.forEach((agg, weekKey) => {
    if (!agg.count) return;
    const point = {
      x: agg.x / agg.count,
      y: agg.y / agg.count,
      spacing: weekSpacingBase,
      buffer: weekSpacingBase
    };
    weekCenters.set(weekKey, point);
    const [blockKey] = weekKey.split('::');
    const list = weekPositionsByBlock.get(blockKey) || [];
    list.push(point);
    weekPositionsByBlock.set(blockKey, list);
  });

  const BLOCK_SPACING = blockSpacingBase;
  const WEEK_SPACING = weekSpacingBase;
  const LECTURE_SPACING = lectureSpacingBase;

  function ensureBlockCenter(blockKey) {
    if (blockCenters.has(blockKey)) return blockCenters.get(blockKey);
    const base = { x: center, y: center };
    const candidate = pickClusterPosition(blockPositionList, BLOCK_SPACING, base, {
      buffer: BLOCK_SPACING * 0.3
    });
    const enriched = {
      x: candidate.x,
      y: candidate.y,
      spacing: BLOCK_SPACING,
      buffer: BLOCK_SPACING
    };
    blockCenters.set(blockKey, enriched);
    blockPositionList.push(enriched);
    return enriched;
  }

  function ensureWeekCenter(blockKey, weekId, blockCenter) {
    const weekKey = `${blockKey}::${weekId}`;
    if (weekCenters.has(weekKey)) return weekCenters.get(weekKey);
    const existing = weekPositionsByBlock.get(blockKey) || [];
    const candidate = pickClusterPosition(existing, WEEK_SPACING, blockCenter, {
      buffer: WEEK_SPACING * 0.25
    });
    const enriched = {
      x: candidate.x,
      y: candidate.y,
      spacing: WEEK_SPACING,
      buffer: WEEK_SPACING
    };
    weekCenters.set(weekKey, enriched);
    existing.push(enriched);
    weekPositionsByBlock.set(blockKey, existing);
    return enriched;
  }

  function ensureLectureCenter(blockKey, weekId, lectureId, weekCenter) {
    const weekKey = `${blockKey}::${weekId}`;
    const lectureKey = `${weekKey}::${lectureId}`;
    if (lectureCenters.has(lectureKey)) return lectureCenters.get(lectureKey);
    const existing = lecturesByWeek.get(weekKey) || [];
    const spacing = Math.max(LECTURE_SPACING, getGroupSpacing(lectureKey));
    const candidate = pickClusterPosition(existing, spacing, weekCenter, {
      buffer: spacing * 0.25
    });
    const enriched = {
      x: candidate.x,
      y: candidate.y,
      spacing,
      buffer: spacing
    };
    lectureCenters.set(lectureKey, enriched);
    existing.push(enriched);
    lecturesByWeek.set(weekKey, existing);
    return enriched;
  }

  newGroupOrder.forEach(key => {
    const parsed = parseGroupKey(key);
    const blockKey = parsed.block || '__';
    const weekId = parsed.week || '__';
    const lectureId = parsed.lecture || key;
    const blockCenter = ensureBlockCenter(blockKey);
    const weekCenter = ensureWeekCenter(blockKey, weekId, blockCenter);
    const lectureCenter = ensureLectureCenter(blockKey, weekId, lectureId, weekCenter);
    clusterOrigins.set(key, {
      x: lectureCenter.x,
      y: lectureCenter.y,
      spacing: Math.max(getGroupSpacing(key), lectureCenter.spacing || 0)
    });
  });

  const groupPlacement = new Map();

  function ensureGroupPlacement(key) {
    if (groupPlacement.has(key)) {
      return groupPlacement.get(key);
    }
    const existing = existingGroupInfo.get(key);
    const pending = pendingCounts.get(key) || 0;
    const total = (existing?.count || 0) + pending;
    const columns = Math.max(2, Math.ceil(Math.sqrt(Math.max(total, 1))));
    const rows = Math.max(1, Math.ceil(Math.max(total, 1) / columns));
    const originSource = clusterOrigins.get(key);
    const origin = existing
      ? {
          x: (existing.minX + existing.maxX) / 2,
          y: (existing.minY + existing.maxY) / 2
        }
      : originSource
        ? { x: originSource.x, y: originSource.y }
        : { x: center, y: center };
    let spacing = Math.max(getGroupSpacing(key), originSource?.spacing || 0);
    if (existing?.count > 1) {
      const spread = Math.max(existing.maxX - existing.minX, existing.maxY - existing.minY);
      const averageRadius = (existing.sumRadius || 0) / Math.max(existing.count, 1);
      spacing = Math.max(
        spacing,
        spread / Math.max(1, existing.count - 1) + Math.max(averageRadius * 1.8, typicalRadius * 1.6)
      );
    } else if (existing?.count === 1) {
      spacing = Math.max(spacing, (existing.maxRadius || typicalRadius) * 2.6);
    } else {
      spacing = Math.max(spacing, groupSpacingBase);
    }
    const info = { origin, columns, rows, spacing, index: existing?.count || 0 };
    groupPlacement.set(key, info);
    return info;
  }

  function allocateGroupPosition(key, entry) {
    const info = ensureGroupPlacement(key);
    const itemRadius = entry ? (nodeRadii.get(entry.item.id) || typicalRadius) : typicalRadius;
    const maxAttempts = 400;
    for (let offset = 0; offset < maxAttempts; offset += 1) {
      const idx = info.index + offset;
      const col = idx % info.columns;
      const row = Math.floor(idx / info.columns);
      const neededRows = Math.max(info.rows, row + 1);
      const colCenter = (info.columns - 1) / 2;
      const rowCenter = (neededRows - 1) / 2;
      const x = info.origin.x + (col - colCenter) * info.spacing;
      const y = info.origin.y + (row - rowCenter) * info.spacing;
      let collision = false;
      for (const existingId in positions) {
        const other = positions[existingId];
        if (!other) continue;
        const otherRadius = nodeRadii.get(existingId) || typicalRadius;
        const minDistance = itemRadius + otherRadius + Math.max(30, info.spacing * 0.35);
        if (Math.hypot(other.x - x, other.y - y) < minDistance) {
          collision = true;
          break;
        }
      }
      if (!collision) {
        info.index = idx + 1;
        info.rows = Math.max(info.rows, neededRows);
        groupPlacement.set(key, info);
        return { x, y };
      }
    }
    info.index += maxAttempts;
    groupPlacement.set(key, info);
    return {
      x: info.origin.x + (Math.random() - 0.5) * info.spacing,
      y: info.origin.y + (Math.random() - 0.5) * info.spacing
    };
  }

  newItems.sort((a, b) => b.degree - a.degree);
  newItems.forEach(entry => {
    const pos = allocateGroupPosition(entry.primaryGroup, entry);
    positions[entry.item.id] = pos;
    if (layout) {
      layout[entry.item.id] = { ...pos };
      layoutDirty = true;
    }
  });

  if (activeTab && legacyImported && activeTab.layoutSeeded !== true) {
    activeTab.layoutSeeded = true;
    layoutDirty = true;
  }

  if (layoutDirty) {
    await persistMapConfig();
  }

  mapState.selectionIds = mapState.selectionIds.filter(id => positions[id]);

  const hiddenLinks = gatherHiddenLinks(items, itemMap);

  buildToolbox(container, hiddenNodes.length, hiddenLinks.length);
  buildHiddenPanel(container, hiddenNodes, hiddenLinks);

  const drawn = new Set();
  const nodeLayerRef = mapState.nodeLayer || g;
  visibleItems.forEach(it => {
    (it.links || []).forEach(link => {
      const targetId = link?.id;
      if (!targetId) return;
      if (link.hidden) return;
      if (!positions[targetId]) return;
      const key = it.id < targetId ? `${it.id}|${targetId}` : `${targetId}|${it.id}`;
      if (drawn.has(key)) return;
      drawn.add(key);
      const info = { ...link, id: targetId };
      applyLinkVisibility(it.id, targetId, info);
    });
  });

  visibleItems.forEach(it => {
    const pos = positions[it.id];
    if (!pos) return;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', pos.x);
    circle.setAttribute('cy', pos.y);
    const cachedRadius = mapState.nodeRadii?.get(it.id);
    const baseR = typeof cachedRadius === 'number'
      ? cachedRadius
      : computeNodeRadiusFromWeight(
          gravityModel.weights?.get(it.id) || 0,
          gravityModel.maxWeight || 1
        );
    circle.setAttribute('r', baseR);
    circle.dataset.radius = baseR;
    circle.setAttribute('class', 'map-node');
    circle.dataset.id = it.id;
    circle.setAttribute('fill', getNodeFill(it));

    const handleNodePointerDown = e => {
      if (e.button !== 0) return;
      const isNavigateTool = mapState.tool === TOOL.NAVIGATE;
      const isAreaDrag = mapState.tool === TOOL.AREA && mapState.selectionIds.includes(it.id);
      if (!isNavigateTool && !isAreaDrag) return;
      e.stopPropagation();
      e.preventDefault();
      mapState.suppressNextClick = false;
      mapState.lastPointerDownInfo = null;
      getSvgRect({ force: true });
      const pointer = clientToMap(e.clientX, e.clientY);
      const current = mapState.positions[it.id] || pos;
      const { x, y } = pointer;
      if (isNavigateTool) {
        const selectionSet = new Set(
          mapState.selectionIds.filter(id => mapState.positions[id] || positions[id])
        );
        const wasSelected = selectionSet.has(it.id);
        const hadMultipleBefore = selectionSet.size > 1;
        let addedToSelection = false;

        if (e.shiftKey) {
          if (!wasSelected) {
            selectionSet.add(it.id);
            addedToSelection = true;
          }
        } else {
          if (!wasSelected || hadMultipleBefore) {
            selectionSet.clear();
            selectionSet.add(it.id);
            addedToSelection = !wasSelected;
          }
        }

        if (!selectionSet.size) {
          selectionSet.add(it.id);
          addedToSelection = !wasSelected;
        }

        const uniqueSelection = Array.from(selectionSet);
        mapState.selectionIds = uniqueSelection;
        mapState.previewSelection = null;
        mapState.selectionPreviewSignature = '';
        updateSelectionHighlight();
        mapState.lastPointerDownInfo = { id: it.id, shift: e.shiftKey, added: addedToSelection };

        const dragNodes = [];
        uniqueSelection.forEach(id => {
          const source = mapState.positions[id] || positions[id] || (id === it.id ? current : null);
          if (!source) return;
          dragNodes.push({
            id,
            start: { x: source.x, y: source.y },
            offset: {
              dx: pointer.x - source.x,
              dy: pointer.y - source.y
            }
          });
        });

        if (!dragNodes.length) {
          mapState.nodeDrag = null;
          mapState.nodeWasDragged = false;
          refreshCursor({ keepOverride: true });
          return;
        }

        mapState.nodeDrag = {
          pointerId: e.pointerId,
          captureTarget: e.currentTarget || circle,
          client: { x: e.clientX, y: e.clientY },
          startPointer: { x: pointer.x, y: pointer.y },
          lastPointer: { x: pointer.x, y: pointer.y },
          nodes: dragNodes,
          moved: false,
          primaryId: it.id
        };
        if (mapState.nodeDrag.captureTarget?.setPointerCapture) {
          try {
            mapState.nodeDrag.captureTarget.setPointerCapture(e.pointerId);
          } catch {}
        }
        mapState.nodeWasDragged = false;
        setAreaInteracting(true);
      } else {
        const selectionIds = [...mapState.selectionIds];
        mapState.areaDrag = {
          ids: selectionIds,
          start: { x, y },
          origin: selectionIds.map(id => {
            const source = mapState.positions[id] || positions[id] || { x: 0, y: 0 };
            return { id, pos: { ...source } };
          }),
          moved: false,
          pointerId: e.pointerId,
          captureTarget: e.currentTarget || circle,
          client: { x: e.clientX, y: e.clientY }
        };
        if (mapState.areaDrag.captureTarget?.setPointerCapture) {
          try {
            mapState.areaDrag.captureTarget.setPointerCapture(e.pointerId);
          } catch {}
        }
        mapState.nodeWasDragged = false;
        setAreaInteracting(true);
      }
      refreshCursor({ keepOverride: false });
    };

    circle.addEventListener('pointerdown', handleNodePointerDown);

    circle.addEventListener('click', async e => {
      e.stopPropagation();
      if (mapState.tool === TOOL.NAVIGATE && e.shiftKey) {
        mapState.nodeWasDragged = false;
        mapState.suppressNextClick = false;
        const info = mapState.lastPointerDownInfo;
        const skipToggle = info && info.id === it.id && info.shift && info.added;
        if (!skipToggle) {
          const set = new Set(mapState.selectionIds);
          if (set.has(it.id)) {
            set.delete(it.id);
          } else {
            set.add(it.id);
          }
          mapState.selectionIds = Array.from(set);
          mapState.previewSelection = null;
          mapState.selectionPreviewSignature = '';
          updateSelectionHighlight();
        }
        mapState.lastPointerDownInfo = null;
        return;
      }
      if (mapState.suppressNextClick) {
        mapState.suppressNextClick = false;
        mapState.nodeWasDragged = false;
        mapState.lastPointerDownInfo = null;
        return;
      }
      if (mapState.tool === TOOL.NAVIGATE) {
        if (!mapState.nodeWasDragged) {
          openItemPopup(it.id);
        }
        mapState.nodeWasDragged = false;
        mapState.lastPointerDownInfo = null;
      } else if (mapState.tool === TOOL.HIDE) {
        if (confirm(`Remove ${titleOf(it)} from the map?`)) {
          applyLocalNodeHidden(it.id, true);
          refreshToolboxBadges();
          setNodeHidden(it.id, true)
            .then(() => renderMap(root))
            .catch(err => {
              console.error(err);
            });
        }
      } else if (mapState.tool === TOOL.ADD_LINK) {
        await handleAddLinkClick(it.id);
      }
    });

    circle.addEventListener('mouseenter', () => {
      if (mapState.tool === TOOL.HIDE) {
        applyCursorOverride('hide');
      } else if (mapState.tool === TOOL.ADD_LINK) {
        applyCursorOverride('link');
      }
    });

    circle.addEventListener('mouseleave', () => {
      if (mapState.tool === TOOL.HIDE) {
        clearCursorOverride('hide');
      }
      if (mapState.tool === TOOL.ADD_LINK) {
        clearCursorOverride('link');
      }
    });

    nodeLayerRef.appendChild(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', pos.x);
    text.setAttribute('y', pos.y - (baseR + 12));
    text.setAttribute('class', 'map-label');
    text.setAttribute('font-size', '16');
    text.dataset.id = it.id;
    text.textContent = it.name || it.concept || '?';
    text.addEventListener('pointerdown', handleNodePointerDown);
    text.addEventListener('click', async e => {
      e.stopPropagation();
      if (mapState.tool === TOOL.NAVIGATE && e.shiftKey) {
        mapState.nodeWasDragged = false;
        mapState.suppressNextClick = false;
        const info = mapState.lastPointerDownInfo;
        const skipToggle = info && info.id === it.id && info.shift && info.added;
        if (!skipToggle) {
          const set = new Set(mapState.selectionIds);
          if (set.has(it.id)) {
            set.delete(it.id);
          } else {
            set.add(it.id);
          }
          mapState.selectionIds = Array.from(set);
          mapState.previewSelection = null;
          mapState.selectionPreviewSignature = '';
          updateSelectionHighlight();
        }
        mapState.lastPointerDownInfo = null;
        return;
      }
      if (mapState.suppressNextClick) {
        mapState.suppressNextClick = false;
        mapState.nodeWasDragged = false;
        mapState.lastPointerDownInfo = null;
        return;
      }
      if (mapState.tool === TOOL.NAVIGATE && !mapState.nodeWasDragged) {
        openItemPopup(it.id);
        mapState.lastPointerDownInfo = null;
      } else if (mapState.tool === TOOL.HIDE) {
        if (confirm(`Remove ${titleOf(it)} from the map?`)) {
          applyLocalNodeHidden(it.id, true);
          refreshToolboxBadges();
          setNodeHidden(it.id, true)
            .then(() => renderMap(root))
            .catch(err => {
              console.error(err);
            });
        }
      } else if (mapState.tool === TOOL.ADD_LINK) {
        await handleAddLinkClick(it.id);
      }
      mapState.nodeWasDragged = false;
    });
    nodeLayerRef.appendChild(text);

    mapState.elements.set(it.id, { circle, label: text });
  });

  updateSelectionHighlight();
  updatePendingHighlight();

  if (mapState.pendingFocusId && !mapState.restoredViewFromMemory) {
    const success = centerOnNode(mapState.pendingFocusId, { select: false });
    if (success) {
      mapState.restoredViewFromMemory = true;
    }
  }
  mapState.pendingFocusId = null;

  updateViewBox({ forceScale: true, immediate: true });
  refreshCursor();
  root.replaceChildren(fragment);
}

function ensureListeners() {
  if (mapState.listenersAttached || typeof window === 'undefined') return;
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
  mapState.listenersAttached = true;
  if (!window._mapResizeAttached) {
    const handleResize = debounceFrame(() => {
      invalidateSvgRect();
      adjustScale();
    }, 140);
    window.addEventListener('resize', handleResize);
    window._mapResizeAttached = true;
    window._mapResizeHandler = handleResize;
  }
  if (!window._mapToolboxResizeAttached) {
    const handleToolboxResize = debounceFrame(() => {
      ensureToolboxWithinBounds();
    }, 140);
    window.addEventListener('resize', handleToolboxResize);
    window._mapToolboxResizeAttached = true;
    window._mapToolboxResizeHandler = handleToolboxResize;
  }
}

function buildLineMarkers(defs) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const configs = [
    {
      id: 'arrow-end',
      viewBox: '0 0 16 16',
      refX: 14,
      refY: 8,
      markerWidth: 9,
      markerHeight: 9,
      path: 'M2 2 L14 8 L2 14 L6 8 Z',
      units: 'strokeWidth',
      scaleMode: 'stroke'
    },
    {
      id: 'arrow-start',
      viewBox: '0 0 16 16',
      refX: 2,
      refY: 8,
      markerWidth: 9,
      markerHeight: 9,
      path: 'M14 2 L2 8 L14 14 L10 8 Z',
      units: 'strokeWidth',
      scaleMode: 'stroke'
    }
  ];
  mapState.markerDefs = defs;
  mapState.lineMarkers = new Map();
  if (!mapState.lineMarkerCache) {
    mapState.lineMarkerCache = new Map();
  } else {
    mapState.lineMarkerCache.clear();
  }
  configs.forEach(cfg => {
    const marker = document.createElementNS(svgNS, 'marker');
    marker.setAttribute('id', cfg.id);
    marker.setAttribute('viewBox', cfg.viewBox);
    marker.dataset.baseRefX = String(cfg.refX);
    marker.dataset.baseRefY = String(cfg.refY);
    marker.dataset.baseWidth = String(cfg.markerWidth);
    marker.dataset.baseHeight = String(cfg.markerHeight);
    marker.dataset.scaleMode = cfg.scaleMode || 'absolute';
    marker.setAttribute('refX', String(cfg.refX));
    marker.setAttribute('refY', String(cfg.refY));
    marker.setAttribute('markerWidth', String(cfg.markerWidth));
    marker.setAttribute('markerHeight', String(cfg.markerHeight));
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', cfg.units || 'userSpaceOnUse');
    marker.setAttribute('class', 'map-marker');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', cfg.path);
    path.setAttribute('fill', 'context-stroke');
    path.setAttribute('stroke', 'context-stroke');
    path.setAttribute('stroke-linejoin', 'round');
    marker.appendChild(path);
    defs.appendChild(marker);
    mapState.lineMarkers.set(cfg.id, marker);
  });
  updateMarkerSizes();
}

function updateMarkerSizes() {
  const markers = mapState.lineMarkers;
  if (!markers || markers.size === 0) return;
  const { zoomRatio = 1, lineScale = 1 } = getCurrentScales();
  const ratio = Number.isFinite(zoomRatio) && zoomRatio > 0 ? zoomRatio : 1;
  const strokeScale = Number.isFinite(lineScale) && lineScale > 0 ? lineScale : 1;
  markers.forEach(marker => {
    const baseWidth = Number(marker.dataset.baseWidth) || 12;
    const baseHeight = Number(marker.dataset.baseHeight) || 12;
    const baseRefX = Number(marker.dataset.baseRefX) || 0;
    const baseRefY = Number(marker.dataset.baseRefY) || 0;
    const scaleMode = marker.dataset.scaleMode || 'absolute';
    if (scaleMode === 'stroke') {
      marker.setAttribute('markerWidth', String(baseWidth));
      marker.setAttribute('markerHeight', String(baseHeight));
      marker.setAttribute('refX', String(baseRefX));
      marker.setAttribute('refY', String(baseRefY));
    } else {
      const width = baseWidth * ratio * strokeScale;
      const height = baseHeight * ratio * strokeScale;
      marker.setAttribute('markerWidth', String(width));
      marker.setAttribute('markerHeight', String(height));
      marker.setAttribute('refX', String(baseRefX * ratio * strokeScale));
      marker.setAttribute('refY', String(baseRefY * ratio * strokeScale));
    }
  });
}

function beginViewDrag(e) {
  if (!mapState.svg || !mapState.viewBox) return false;
  if (e.button !== 0) return false;
  mapState.justCompletedSelection = false;
  getSvgRect({ force: true });
  const startMap = clientToMap(e.clientX, e.clientY);
  mapState.draggingView = true;
  mapState.viewWasDragged = false;
  mapState.viewPointerId = e.pointerId;
  mapState.lastPointer = {
    x: e.clientX,
    y: e.clientY,
    mapX: startMap.x,
    mapY: startMap.y
  };
  mapState.viewDragStart = {
    clientX: e.clientX,
    clientY: e.clientY,
    viewX: mapState.viewBox.x,
    viewY: mapState.viewBox.y
  };
  if (e.currentTarget?.setPointerCapture) {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  }
  setAreaInteracting(true);
  refreshCursor({ keepOverride: false });
  return true;
}

function attachSvgEvents(svg) {
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target !== svg) return;
    closeLineMenu();
    mapState.justCompletedSelection = false;
    getSvgRect({ force: true });
    mapState.lastPointerDownInfo = null;
    if (mapState.tool !== TOOL.AREA) {
      e.preventDefault();
      beginViewDrag(e);
    } else {
      e.preventDefault();
      startSelectionDrag(e.pointerId, e.clientX, e.clientY);
      if (svg.setPointerCapture) {
        try {
          svg.setPointerCapture(e.pointerId);
        } catch {}
      }
      setAreaInteracting(true);
    }
  });

  svg.addEventListener('click', e => {
    if (mapState.tool !== TOOL.AREA) return;
    if (e.target !== svg) return;
    if (mapState.justCompletedSelection) {
      mapState.justCompletedSelection = false;
      return;
    }
    if (mapState.selectionIds.length || mapState.previewSelection) {
      mapState.selectionIds = [];
      mapState.previewSelection = null;
      mapState.selectionPreviewSignature = '';
      updateSelectionHighlight();
    }
    setAreaInteracting(false);
  });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    if (!mapState.viewBox) return;
    const rect = getSvgRect({ force: true });
    if (!rect || !rect.width || !rect.height) return;
    const pixelMode = e.deltaMode === 0;
    const wantsZoom = e.ctrlKey || e.metaKey || e.altKey || !pixelMode;
    if (!wantsZoom) {
      const scaleX = rect.width ? (mapState.viewBox.w / rect.width) : 0;
      const scaleY = rect.height ? (mapState.viewBox.h / rect.height) : 0;
      mapState.viewBox.x += e.deltaX * scaleX * PAN_ACCELERATION;
      mapState.viewBox.y += e.deltaY * scaleY * PAN_ACCELERATION;
      constrainViewBox();
      mapState.updateViewBox({ immediate: true });
      return;
    }
    const ratioX = (e.clientX - rect.left) / rect.width;
    const ratioY = (e.clientY - rect.top) / rect.height;
    const mx = mapState.viewBox.x + ratioX * mapState.viewBox.w;
    const my = mapState.viewBox.y + ratioY * mapState.viewBox.h;
    let deltaY = e.deltaY;
    if (e.deltaMode === 1) {
      deltaY *= 16;
    } else if (e.deltaMode === 2) {
      deltaY *= rect.height;
    }
    const rawFactor = Math.exp(deltaY * ZOOM_INTENSITY);
    const factor = Number.isFinite(rawFactor) && rawFactor > 0 ? rawFactor : 1;
    const maxSize = mapState.sizeLimit || 2000;
    const minSize = mapState.minView || 100;
    const nextW = clamp(mapState.viewBox.w * factor, minSize, maxSize);
    mapState.viewBox.w = nextW;
    mapState.viewBox.h = nextW;
    mapState.viewBox.x = mx - ratioX * nextW;
    mapState.viewBox.y = my - ratioY * nextW;
    constrainViewBox();
    mapState.updateViewBox();
  }, { passive: false });
}

function getNodeDragTargets() {
  const drag = mapState.nodeDrag;
  if (!drag) return [];
  if (Array.isArray(drag.nodes) && drag.nodes.length) {
    return drag.nodes;
  }
  if (Array.isArray(drag.targets) && drag.targets.length) {
    return drag.targets;
  }
  if (drag.id) {
    return [{ id: drag.id }];
  }
  return [];
}

function refreshEdgesForIds(ids, options = {}) {
  if (!Array.isArray(ids) || !ids.length) {
    return;
  }
  const seen = new Set();
  ids.forEach(id => {
    if (id == null) return;
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    updateEdgesFor(id, options);
  });
}

function applyNodeDragFromPointer(pointer, options = {}) {
  if (!pointer) return false;
  const drag = mapState.nodeDrag;
  if (!drag) return false;
  const lastPointer = drag.lastPointer;
  if (
    lastPointer &&
    Math.abs(lastPointer.x - pointer.x) < 0.0001 &&
    Math.abs(lastPointer.y - pointer.y) < 0.0001
  ) {
    return false;
  }
  const targets = Array.isArray(drag.nodes) ? drag.nodes : [];
  if (!targets.length) return false;
  let applied = false;
  let moved = drag.moved === true;
  const startPointer = drag.startPointer || null;
  targets.forEach(target => {
    if (!target) return;
    const { id, offset = { dx: 0, dy: 0 }, start } = target;
    if (!id) return;
    const nx = pointer.x - offset.dx;
    const ny = pointer.y - offset.dy;
    scheduleNodePositionUpdate(id, { x: nx, y: ny }, { immediate: true, animate: true });
    if (!moved && start) {
      const dx = nx - start.x;
      const dy = ny - start.y;
      if (Math.hypot(dx, dy) > NODE_DRAG_DISTANCE_THRESHOLD) {
        moved = true;
      }
    }
    applied = true;
  });
  drag.lastPointer = { x: pointer.x, y: pointer.y };
  drag.moved = moved;
  if (applied && moved && options.markDragged !== false) {
    mapState.nodeWasDragged = true;
  }
  return applied;
}

function handlePointerMove(e) {
  if (!mapState.svg) return;

  const pendingPress = mapState.edgePress;
  if (pendingPress && pendingPress.pointerId === e.pointerId && !pendingPress.activated) {
    const dx = e.clientX - pendingPress.startClient.x;
    const dy = e.clientY - pendingPress.startClient.y;
    if (Math.hypot(dx, dy) > EDGE_DRAG_MOVE_THRESHOLD) {
      const pointer = clientToMap(e.clientX, e.clientY);
      activateEdgePress(pendingPress, pointer, { fromMove: true });
    }
  }

  if (mapState.toolboxDrag) {
    moveToolboxDrag(e.clientX, e.clientY);
    return;
  }

  if (mapState.menuDrag) {
    updateMenuDragPosition(e.clientX, e.clientY);
    return;
  }

  if (mapState.edgeDrag && mapState.edgeDrag.pointerId === e.pointerId) {
    const drag = mapState.edgeDrag;
    if (!drag.line || typeof drag.handleIndex !== 'number') return;
    const distance = Math.hypot(e.clientX - drag.clientStart.x, e.clientY - drag.clientStart.y);
    if (!drag.hasDragged && distance < 2.4) {
      return;
    }
    if (!drag.hasDragged) {
      drag.hasDragged = true;
    }
    const pointer = clientToMap(e.clientX, e.clientY);
    const base = drag.base;
    if (!pointer || !base) return;
    const dx = base.endX - base.startX;
    const dy = base.endY - base.startY;
    const length = base.trimmedLength || Math.hypot(dx, dy) || 1;
    if (!length) return;
    const nx = -base.uy;
    const ny = base.ux;
    let handles = drag.handles || [];
    const index = clamp(drag.handleIndex, 0, handles.length - 1);
    const handle = handles[index];
    if (!handle) return;
    const projectionAlong = ((pointer.x - base.startX) * dx + (pointer.y - base.startY) * dy) / (length * length);
    const nextPosition = clampHandlePosition(projectionAlong);
    const baseX = base.startX + dx * nextPosition;
    const baseY = base.startY + dy * nextPosition;
    const weight = getHandleWeight(nextPosition);
    const rawOffset = ((pointer.x - baseX) * nx + (pointer.y - baseY) * ny) / length;
    const normalized = clampHandleOffset(rawOffset / (weight || 1));
    handle.position = nextPosition;
    handle.offset = normalized;
    handle.weight = weight;
    drag.offsetChanged =
      drag.offsetChanged
      || Math.abs((handle.startOffset ?? handle.offset) - handle.offset) > 0.0005
      || Math.abs((handle.startPosition ?? handle.position) - handle.position) > 0.0005;
    const sortedHandles = handles.slice().sort((a, b) => a.position - b.position);
    const newIndex = sortedHandles.indexOf(handle);
    handles = sortedHandles;
    drag.handles = handles;
    if (newIndex >= 0) {
      drag.handleIndex = newIndex;
    }
    if (drag.createdHandle) {
      drag.createdIndex = handles.indexOf(drag.createdHandle);
    }
    const patchHandles = handles.map(h => ({ position: h.position, offset: h.offset }));
    applyLineStyle(drag.line, { curveHandles: patchHandles });
    return;
  }

  if (mapState.nodeDrag && mapState.nodeDrag.pointerId === e.pointerId) {
    mapState.nodeDrag.client = { x: e.clientX, y: e.clientY };
    updateAutoPanFromPointer(e.clientX, e.clientY, { allowDuringDrag: true });
    const pointer = clientToMap(e.clientX, e.clientY);
    applyNodeDragFromPointer(pointer);
    return;
  }

  if (mapState.areaDrag && mapState.areaDrag.pointerId === e.pointerId) {
    mapState.areaDrag.client = { x: e.clientX, y: e.clientY };
    updateAutoPanFromPointer(e.clientX, e.clientY, { allowDuringDrag: true });
    const { x, y } = clientToMap(e.clientX, e.clientY);
    const dx = x - mapState.areaDrag.start.x;
    const dy = y - mapState.areaDrag.start.y;
    mapState.areaDrag.moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
    mapState.areaDrag.origin.forEach(({ id, pos }) => {
      const nx = pos.x + dx;
      const ny = pos.y + dy;
      scheduleNodePositionUpdate(id, { x: nx, y: ny }, { immediate: true, animate: true });
    });
    mapState.nodeWasDragged = true;
    return;
  }

  if (mapState.draggingView && mapState.viewPointerId === e.pointerId) {
    const start = mapState.viewDragStart;
    if (!start) return;
    const rect = getSvgRect();
    if (!rect || !rect.width || !rect.height) return;
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    const movedDistance = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY);
    if (!mapState.viewWasDragged && movedDistance > 1.5) {
      mapState.viewWasDragged = true;
    }
    const scaleX = mapState.viewBox.w / rect.width;
    const scaleY = mapState.viewBox.h / rect.height;
    const deltaX = (e.clientX - start.clientX) * PAN_ACCELERATION;
    const deltaY = (e.clientY - start.clientY) * PAN_ACCELERATION;
    mapState.viewBox.x = start.viewX - deltaX * scaleX;
    mapState.viewBox.y = start.viewY - deltaY * scaleY;
    constrainViewBox();
    mapState.lastPointer = { x: e.clientX, y: e.clientY };
    mapState.updateViewBox({ immediate: true });
    if (mapState.selectionRect) {
      refreshSelectionMaps();
    }
    return;
  }

  if (mapState.selectionRect && mapState.selectionRect.pointerId === e.pointerId) {
    updateAutoPanFromPointer(e.clientX, e.clientY);
    updateSelectionDragPosition(e.clientX, e.clientY);
  }
}

async function handlePointerUp(e) {
  if (!mapState.svg) return;

  flushNodePositionUpdates({ cancelFrame: true });

  stopAutoPan();

  if (mapState.toolboxDrag) {
    stopToolboxDrag();
  }

  if (mapState.menuDrag) {
    await finishMenuDrag(e.clientX, e.clientY);
    return;
  }

  const edgePress = mapState.edgePress;
  if (edgePress && edgePress.pointerId === e.pointerId) {
    clearEdgePressTimer(edgePress);
    mapState.edgePress = null;
    if (!edgePress.activated && edgePress.type === 'handle') {
      const dx = e.clientX - edgePress.startClient.x;
      const dy = e.clientY - edgePress.startClient.y;
      if (Math.hypot(dx, dy) <= EDGE_CLICK_DISTANCE) {
        const line = edgePress.line;
        if (line && confirm('Remove this anchor point?')) {
          await removeHandleAt(line, edgePress.handleIndex);
        } else if (line) {
          showLineHandles(line);
          applyLineHover(line);
        }
      }
    }
  }

  let cursorNeedsRefresh = false;

  if (mapState.edgeDrag && mapState.edgeDrag.pointerId === e.pointerId) {
    const drag = mapState.edgeDrag;
    mapState.edgeDrag = null;
    if (drag.captureTarget?.releasePointerCapture) {
      try {
        drag.captureTarget.releasePointerCapture(e.pointerId);
      } catch {}
    }
    const handles = drag.handles || [];
    const createdIndex = Number.isInteger(drag.createdIndex) ? drag.createdIndex : -1;
    const createdHandle = drag.createdHandle || (createdIndex >= 0 ? handles[createdIndex] : null);
    const changed =
      drag.offsetChanged
      || handles.some(handle => {
        const startOffset = handle.startOffset ?? handle.offset;
        const startPosition = handle.startPosition ?? handle.position;
        return Math.abs(handle.offset - startOffset) > 0.0005 || Math.abs(handle.position - startPosition) > 0.0005;
      });
    const shouldAutoRemove = drag.insertedHandle && !drag.hasDragged;
    if (shouldAutoRemove && createdHandle) {
      const trimmed = handles.filter(handle => handle !== createdHandle);
      const patch = buildCurvePatchFromHandles(trimmed);
      await updateLink(drag.aId, drag.bId, patch);
      applyLineStyle(drag.line, patch);
      applyLinkPatchToState(drag.aId, drag.bId, patch);
      mapState.edgeDragJustCompleted = true;
      setTimeout(() => {
        mapState.edgeDragJustCompleted = false;
      }, 0);
    } else if (changed) {
      const payloadHandles = handles.map(handle => ({ position: handle.position, offset: handle.offset }));
      const patch = buildCurvePatchFromHandles(payloadHandles);
      await updateLink(drag.aId, drag.bId, patch);
      applyLineStyle(drag.line, patch);
      applyLinkPatchToState(drag.aId, drag.bId, patch);
      mapState.edgeDragJustCompleted = true;
      setTimeout(() => {
        mapState.edgeDragJustCompleted = false;
      }, 0);
    }
    if (drag.line) {
      drag.line._handleSticky = false;
      const hovered = typeof drag.line.matches === 'function' && drag.line.matches(':hover');
      if (hovered) {
        showLineHandles(drag.line);
      } else {
        hideLineHandles(drag.line, { force: true });
      }
    }
    cursorNeedsRefresh = true;
  }

  if (mapState.nodeDrag && mapState.nodeDrag.pointerId === e.pointerId) {
    const drag = mapState.nodeDrag;
    const dragTargets = getNodeDragTargets();
    if (drag.captureTarget?.releasePointerCapture) {
      try {
        drag.captureTarget.releasePointerCapture(e.pointerId);
      } catch {}
    }
    const wasDragged = mapState.nodeWasDragged || drag.moved;
    if (wasDragged && mapState.lastPointerDownInfo?.id === drag.primaryId) {
      mapState.lastPointerDownInfo = null;
    }
    mapState.nodeDrag = null;
    flushQueuedEdgeUpdates({ force: true });
    cursorNeedsRefresh = true;
    if (wasDragged) {
      const ids = dragTargets.map(target => target.id).filter(Boolean);
      if (!ids.length && drag.id) {
        ids.push(drag.id);
      }
      const uniqueIds = Array.from(new Set(ids));
      if (uniqueIds.length) {
        for (const nodeId of uniqueIds) {
          await persistNodePosition(nodeId, { persist: false });
        }
        await persistMapConfig();
      }
      mapState.suppressNextClick = true;
    } else {
      mapState.suppressNextClick = false;
    }
    mapState.nodeWasDragged = false;
    setAreaInteracting(false);
  }

  if (mapState.areaDrag && mapState.areaDrag.pointerId === e.pointerId) {
    const currentDrag = mapState.areaDrag;
    const moved = currentDrag.moved;
    const ids = currentDrag.ids;
    if (currentDrag.captureTarget?.releasePointerCapture) {
      try {
        currentDrag.captureTarget.releasePointerCapture(e.pointerId);
      } catch {}
    }
    mapState.areaDrag = null;
    flushQueuedEdgeUpdates({ force: true });
    cursorNeedsRefresh = true;
    if (moved) {
      for (const id of ids) {
        await persistNodePosition(id, { persist: false });
      }
      await persistMapConfig();
      mapState.suppressNextClick = true;
    } else {
      mapState.suppressNextClick = false;
    }
    mapState.nodeWasDragged = false;
    stopAutoPan();
    setAreaInteracting(false);
  }

  if (mapState.draggingView && mapState.viewPointerId === e.pointerId) {
    const wasDragged = mapState.viewWasDragged;
    mapState.draggingView = false;
    mapState.viewPointerId = null;
    mapState.viewDragStart = null;
    mapState.viewWasDragged = false;
    if (mapState.svg?.releasePointerCapture) {
      try {
        mapState.svg.releasePointerCapture(e.pointerId);
      } catch {}
    }
    cursorNeedsRefresh = true;
    setAreaInteracting(false);
    if (!wasDragged && (mapState.selectionIds.length || mapState.previewSelection)) {
      mapState.selectionIds = [];
      mapState.previewSelection = null;
      mapState.selectionPreviewSignature = '';
      updateSelectionHighlight();
    }
  }

  if (mapState.selectionRect && mapState.selectionRect.pointerId === e.pointerId) {
    finalizeSelectionDrag();
    stopAutoPan();
    setAreaInteracting(false);
    mapState.justCompletedSelection = true;
    if (mapState.svg?.releasePointerCapture) {
      try {
        mapState.svg.releasePointerCapture(e.pointerId);
      } catch {}
    }
  }

  if (cursorNeedsRefresh) {
    refreshCursor({ keepOverride: true });
  }
}

function buildCurvePatchFromHandles(handles = []) {
  const sanitized = Array.isArray(handles)
    ? handles
        .map(handle => ({
          position: clampHandlePosition(handle.position),
          offset: clampHandleOffset(handle.offset)
        }))
        .filter(handle => Number.isFinite(handle.position) && Number.isFinite(handle.offset))
    : [];
  if (!sanitized.length) {
    return {
      curveHandles: [],
      curve: 0,
      curveAnchor: DEFAULT_CURVE_ANCHOR
    };
  }
  let dominant = { position: DEFAULT_CURVE_ANCHOR, offset: 0 };
  sanitized.forEach(handle => {
    if (Math.abs(handle.offset) > Math.abs(dominant.offset)) {
      dominant = handle;
    }
  });
  return {
    curveHandles: sanitized,
    curve: clampHandleOffset(dominant.offset),
    curveAnchor: clampHandlePosition(dominant.position)
  };
}

function queueEdgeUpdate(id, options = {}) {
  if (!id) return;
  if (!mapState.pendingEdgeUpdates) {
    mapState.pendingEdgeUpdates = new Set();
  }
  mapState.pendingEdgeUpdates.add(String(id));
  const { immediate = false, animate = false } = options;
  if (animate) {
    if (!mapState.pendingEdgeAnimations) {
      mapState.pendingEdgeAnimations = new Map();
    }
    mapState.pendingEdgeAnimations.set(String(id), true);
  }
  const needsImmediateFlush = immediate
    || typeof window === 'undefined'
    || typeof window.requestAnimationFrame !== 'function';
  if (needsImmediateFlush) {
    flushQueuedEdgeUpdates({ force: true });
    return;
  }
  if (mapState.edgeUpdateFrame) {
    return;
  }
  mapState.edgeUpdateFrame = window.requestAnimationFrame(() => {
    mapState.edgeUpdateFrame = null;
    flushQueuedEdgeUpdates();
  });
}

function flushQueuedEdgeUpdates({ force = false } = {}) {
  const pending = mapState.pendingEdgeUpdates;
  if (!pending || !pending.size) return;
  if (mapState.edgeUpdateFrame && typeof window !== 'undefined') {
    if (force && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(mapState.edgeUpdateFrame);
      mapState.edgeUpdateFrame = null;
    } else if (!force) {
      return;
    }
  }
  const ids = Array.from(pending);
  pending.clear();
  mapState.edgeUpdateFrame = null;
  const animateMap = mapState.pendingEdgeAnimations;
  ids.forEach(id => {
    const key = String(id);
    const shouldAnimate = Boolean(animateMap?.get(key));
    if (animateMap) {
      animateMap.delete(key);
    }
    updateEdgesFor(key, { animate: shouldAnimate });
  });
}

function scheduleNodePositionUpdate(id, pos, options = {}) {
  if (!id || !pos) return;
  const { immediate = false, animate = false } = options;
  mapState.positions[id] = pos;
  if (immediate) {
    if (mapState.pendingNodeUpdates && typeof mapState.pendingNodeUpdates.delete === 'function') {
      mapState.pendingNodeUpdates.delete(id);
    }
    const entry = mapState.elements.get(id);
    let hadRegisteredEdges = false;
    if (entry) {
      updateNodeGeometry(id, entry);
      const registered = mapState.edgeRefs?.get(String(id));
      hadRegisteredEdges = Boolean(registered && registered.size);
      updateEdgesFor(id, { animate });
    }
    if (!hadRegisteredEdges) {
      queueEdgeUpdate(id, { immediate: true, animate });
    }
    return;
  }
  if (!mapState.pendingNodeUpdates) {
    mapState.pendingNodeUpdates = new Map();
  }
  const existing = mapState.pendingNodeUpdates.get(id);
  const nextAnimate = animate || Boolean(existing?.animate);
  mapState.pendingNodeUpdates.set(id, { pos, animate: nextAnimate });
  queueEdgeUpdate(id, { animate: nextAnimate });
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    flushNodePositionUpdates();
    return;
  }
  if (mapState.nodeUpdateFrame) {
    return;
  }
  mapState.nodeUpdateFrame = window.requestAnimationFrame(() => {
    mapState.nodeUpdateFrame = null;
    flushNodePositionUpdates();
  });
}

function flushNodePositionUpdates({ cancelFrame = false } = {}) {
  if (cancelFrame && mapState.nodeUpdateFrame && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(mapState.nodeUpdateFrame);
    mapState.nodeUpdateFrame = null;
  }
  const updates = mapState.pendingNodeUpdates;
  if (!updates || !updates.size) return;
  const touched = [];
  updates.forEach((value, id) => {
    const info = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'pos')
      ? value
      : { pos: value };
    const entry = mapState.elements.get(id);
    if (!entry) return;
    updateNodeGeometry(id, entry);
    touched.push({ id, animate: Boolean(info.animate) });
  });
  updates.clear();
  touched.forEach(({ id, animate }) => {
    updateEdgesFor(id, { animate });
  });
}

function getNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function invalidateSvgRect() {
  mapState.svgRect = null;
  mapState.svgRectTime = 0;
}

function getSvgRect(options = {}) {
  const svg = mapState.svg;
  if (!svg) return null;
  const { force = false } = options;
  if (force) {
    mapState.svgRect = svg.getBoundingClientRect();
    mapState.svgRectTime = getNow();
    return mapState.svgRect;
  }
  const now = getNow();
  if (!mapState.svgRect || !mapState.svgRectTime || now - mapState.svgRectTime > 100) {
    mapState.svgRect = svg.getBoundingClientRect();
    mapState.svgRectTime = now;
  }
  return mapState.svgRect;
}

function constrainViewBox() {
  const viewBox = mapState.viewBox;
  if (!viewBox) return;
  const maxSize = mapState.sizeLimit || 0;
  if (maxSize > 0) {
    const maxX = Math.max(0, maxSize - viewBox.w);
    const maxY = Math.max(0, maxSize - viewBox.h);
    viewBox.x = clamp(viewBox.x, 0, maxX);
    viewBox.y = clamp(viewBox.y, 0, maxY);
  }
}

function clientToMap(clientX, clientY) {
  const viewBox = mapState.viewBox;
  if (!mapState.svg || !viewBox) return { x: 0, y: 0 };
  const rect = getSvgRect();
  if (!rect || !rect.width || !rect.height) {
    return { x: viewBox.x, y: viewBox.y };
  }
  const ratioX = (clientX - rect.left) / rect.width;
  const ratioY = (clientY - rect.top) / rect.height;
  return {
    x: viewBox.x + ratioX * viewBox.w,
    y: viewBox.y + ratioY * viewBox.h
  };
}

function getElementPosition(entry, id) {
  if (entry?.circle) {
    const cx = Number(entry.circle.getAttribute('cx'));
    const cy = Number(entry.circle.getAttribute('cy'));
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      return { x: cx, y: cy };
    }
  }
  return mapState.positions?.[id] || null;
}

function getElementRadius(entry, id) {
  if (entry?.circle) {
    const r = Number(entry.circle.getAttribute('r'));
    if (Number.isFinite(r) && r > 0) {
      return r;
    }
  }
  return getNodeRadius(id);
}

function collectNodesInRect(minX, maxX, minY, maxY) {
  const preview = [];
  const seen = new Set();
  mapState.elements.forEach((entry, id) => {
    const pos = getElementPosition(entry, id);
    if (!pos) return;
    const radius = getElementRadius(entry, id);
    if (!Number.isFinite(radius) || radius < 0) return;
    const label = entry?.label || null;
    const labelHeight = label ? (Number(label.getAttribute('font-size')) || 16) * 0.7 : 0;
    const verticalRadius = radius + labelHeight + 10;
    const expandedRadius = radius + 6;
    const insideBox = pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY;
    const intersectsBox = !insideBox
      ? pos.x + expandedRadius >= minX
        && pos.x - expandedRadius <= maxX
        && pos.y + radius >= minY
        && pos.y - verticalRadius <= maxY
      : true;
    if (insideBox || intersectsBox) {
      if (!seen.has(id)) {
        preview.push(id);
        seen.add(id);
      }
    }
  });
  return preview;
}

function startSelectionDrag(pointerId, clientX, clientY) {
  const originClient = { x: clientX, y: clientY };
  const originMap = clientToMap(clientX, clientY);
  mapState.selectionRect = {
    pointerId,
    originClient,
    originMap,
    currentClient: { ...originClient },
    currentMap: { ...originMap },
    changed: false
  };
  if (mapState.selectionBox) {
    mapState.selectionBox.classList.remove('hidden');
  }
  mapState.previewSelection = [];
  mapState.selectionPreviewSignature = '';
  syncSelectionOverlay();
}

function updateSelectionDragPosition(clientX, clientY) {
  const rect = mapState.selectionRect;
  if (!rect) return;
  rect.currentClient = { x: clientX, y: clientY };
  rect.currentMap = clientToMap(clientX, clientY);
  syncSelectionOverlay();
}

function refreshSelectionMaps({ updateOrigin = false } = {}) {
  const rect = mapState.selectionRect;
  if (!rect) return;
  if (updateOrigin && rect.originClient) {
    rect.originMap = clientToMap(rect.originClient.x, rect.originClient.y);
  }
  if (rect.currentClient) {
    rect.currentMap = clientToMap(rect.currentClient.x, rect.currentClient.y);
  }
  syncSelectionOverlay();
}

function syncSelectionOverlay() {
  const rect = mapState.selectionRect;
  if (!rect || !mapState.selectionBox) return;
  const { originClient, currentClient, originMap, currentMap } = rect;
  if (!originClient || !currentClient) return;
  const svgRect = getSvgRect();
  if (!svgRect) return;
  const left = Math.min(originClient.x, currentClient.x) - svgRect.left;
  const top = Math.min(originClient.y, currentClient.y) - svgRect.top;
  const width = Math.abs(originClient.x - currentClient.x);
  const height = Math.abs(originClient.y - currentClient.y);
  mapState.selectionBox.style.left = `${left}px`;
  mapState.selectionBox.style.top = `${top}px`;
  mapState.selectionBox.style.width = `${width}px`;
  mapState.selectionBox.style.height = `${height}px`;
  rect.changed = width > 3 || height > 3;

  if (!originMap || !currentMap) return;
  const minX = Math.min(originMap.x, currentMap.x);
  const maxX = Math.max(originMap.x, currentMap.x);
  const minY = Math.min(originMap.y, currentMap.y);
  const maxY = Math.max(originMap.y, currentMap.y);
  const preview = collectNodesInRect(minX, maxX, minY, maxY);
  const signature = preview.length ? preview.slice().sort().join('|') : '';
  if (signature !== mapState.selectionPreviewSignature) {
    mapState.previewSelection = preview;
    mapState.selectionPreviewSignature = signature;
    updateSelectionHighlight();
  }
}

function finalizeSelectionDrag({ commit = true } = {}) {
  if (mapState.selectionBox) {
    mapState.selectionBox.classList.add('hidden');
    mapState.selectionBox.style.width = '0px';
    mapState.selectionBox.style.height = '0px';
  }
  const shouldCommit = commit !== false && (mapState.selectionRect?.changed || (mapState.previewSelection?.length ?? 0) > 0);
  if (shouldCommit) {
    const ids = mapState.previewSelection ? mapState.previewSelection.slice() : [];
    mapState.selectionIds = ids;
  }
  mapState.selectionRect = null;
  mapState.previewSelection = null;
  mapState.selectionPreviewSignature = '';
  updateSelectionHighlight();
}

function pickClusterPosition(existing = [], spacing = 200, base = { x: 0, y: 0 }, options = {}) {
  const baseX = Number.isFinite(base?.x) ? base.x : 0;
  const baseY = Number.isFinite(base?.y) ? base.y : 0;
  const minDistanceBase = Math.max(spacing * 0.82, spacing - 80);
  const buffer = Number.isFinite(options?.buffer) ? options.buffer : 0;
  const maxRadius = Number.isFinite(options?.maxRadius) ? options.maxRadius : 0;
  const targetDistance = Math.max(minDistanceBase + buffer, spacing * 0.75, maxRadius);
  for (let radius = 0; radius <= 6; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const candidate = {
          x: baseX + dx * spacing,
          y: baseY + dy * spacing
        };
        let collision = false;
        for (const pos of existing) {
          if (!pos) continue;
          const px = Number.isFinite(pos?.x) ? pos.x : 0;
          const py = Number.isFinite(pos?.y) ? pos.y : 0;
          const dist = Math.hypot(px - candidate.x, py - candidate.y);
          const existingSpacing = Number.isFinite(pos?.spacing) ? pos.spacing : spacing;
          const existingBuffer = Number.isFinite(pos?.buffer) ? pos.buffer : 0;
          const required = Math.max(targetDistance, (existingSpacing + spacing) * 0.5, existingBuffer);
          if (dist < required) {
            collision = true;
            break;
          }
        }
        if (!collision) {
          return candidate;
        }
      }
    }
  }
  return {
    x: baseX + (Math.random() - 0.5) * spacing,
    y: baseY + (Math.random() - 0.5) * spacing
  };
}

function updateAutoPanFromPointer(clientX, clientY, options = {}) {
  if (!mapState.svg) return;
  const { allowDuringDrag = false, force = false } = options;
  const dragging = allowDuringDrag && (mapState.nodeDrag || mapState.areaDrag);
  const shouldAutoPan = force || mapState.tool === TOOL.AREA || dragging;
  if (!shouldAutoPan) {
    stopAutoPan();
    return;
  }
  mapState.autoPanPointer = { x: clientX, y: clientY };
  const vector = computeAutoPanVector(clientX, clientY);
  if (vector) {
    startAutoPan(vector);
  } else {
    stopAutoPan();
  }
}

function computeAutoPanVector(clientX, clientY) {
  const rect = getSvgRect();
  if (!rect) return null;
  const threshold = 40;
  const baseSpeed = 25;
  let dx = 0;
  let dy = 0;

  const leftDist = clientX - rect.left;
  const rightDist = rect.right - clientX;
  const topDist = clientY - rect.top;
  const bottomDist = rect.bottom - clientY;

  if (leftDist < threshold) {
    const intensity = Math.min(1, Math.max(0, threshold - leftDist) / threshold);
    dx -= intensity * baseSpeed;
  } else if (rightDist < threshold) {
    const intensity = Math.min(1, Math.max(0, threshold - rightDist) / threshold);
    dx += intensity * baseSpeed;
  }

  if (topDist < threshold) {
    const intensity = Math.min(1, Math.max(0, threshold - topDist) / threshold);
    dy -= intensity * baseSpeed;
  } else if (bottomDist < threshold) {
    const intensity = Math.min(1, Math.max(0, threshold - bottomDist) / threshold);
    dy += intensity * baseSpeed;
  }

  if (dx || dy) {
    return { dx, dy };
  }
  return null;
}

function startAutoPan(vector) {
  if (!vector) return;
  mapState.autoPan = { dx: vector.dx, dy: vector.dy };
  applyAutoPan(mapState.autoPan);
  if (typeof window === 'undefined') return;
  if (mapState.autoPanFrame) return;
  const step = () => {
    if (!mapState.autoPan) {
      mapState.autoPanFrame = null;
      return;
    }
    if (mapState.autoPanPointer) {
      const nextVector = computeAutoPanVector(mapState.autoPanPointer.x, mapState.autoPanPointer.y);
      if (!nextVector) {
        stopAutoPan();
        return;
      }
      mapState.autoPan.dx = nextVector.dx;
      mapState.autoPan.dy = nextVector.dy;
    }
    applyAutoPan(mapState.autoPan);
    mapState.autoPanFrame = window.requestAnimationFrame(step);
  };
  mapState.autoPanFrame = window.requestAnimationFrame(step);
}

function applyAutoPan(vector) {
  if (!mapState.svg || !mapState.viewBox || !mapState.updateViewBox) return;
  const rect = getSvgRect();
  if (!rect || !rect.width || !rect.height) return;
  const scaleX = mapState.viewBox.w / rect.width;
  const scaleY = mapState.viewBox.h / rect.height;
  mapState.viewBox.x += vector.dx * scaleX;
  mapState.viewBox.y += vector.dy * scaleY;
  constrainViewBox();
  mapState.updateViewBox({ immediate: true });
  if (mapState.selectionRect) {
    refreshSelectionMaps({ updateOrigin: true });
  }
  if (mapState.nodeDrag?.client) {
    const pointer = clientToMap(mapState.nodeDrag.client.x, mapState.nodeDrag.client.y);
    applyNodeDragFromPointer(pointer);
  }
  if (mapState.areaDrag?.client) {
    const pointer = clientToMap(mapState.areaDrag.client.x, mapState.areaDrag.client.y);
    const dx = pointer.x - mapState.areaDrag.start.x;
    const dy = pointer.y - mapState.areaDrag.start.y;
    mapState.areaDrag.moved = mapState.areaDrag.moved || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
    mapState.areaDrag.origin.forEach(({ id, pos }) => {
      const nx = pos.x + dx;
      const ny = pos.y + dy;
      scheduleNodePositionUpdate(id, { x: nx, y: ny }, { immediate: true, animate: true });
    });
    mapState.nodeWasDragged = true;
  }
}

function stopAutoPan() {
  mapState.autoPan = null;
  mapState.autoPanPointer = null;
  if (mapState.autoPanFrame && typeof window !== 'undefined') {
    window.cancelAnimationFrame(mapState.autoPanFrame);
  }
  mapState.autoPanFrame = null;
}

function getCurrentScales() {
  return mapState.currentScales || { nodeScale: 1, labelScale: 1, lineScale: 1 };
}

function getLineThicknessValue(key) {
  return LINE_THICKNESS_VALUES[key] || LINE_THICKNESS_VALUES[DEFAULT_LINE_THICKNESS];
}

function normalizeLineStyle(style) {
  if (LINE_STYLE_VALUE_SET.has(style)) {
    return style;
  }
  if (style && LEGACY_STYLE_MAPPINGS[style]?.style && LINE_STYLE_VALUE_SET.has(LEGACY_STYLE_MAPPINGS[style].style)) {
    return LEGACY_STYLE_MAPPINGS[style].style;
  }
  return DEFAULT_LINE_STYLE;
}

function normalizeLineDecoration(decoration, styleHint) {
  if (LINE_DECORATION_VALUE_SET.has(decoration)) {
    return decoration;
  }
  if (styleHint && LEGACY_STYLE_MAPPINGS[styleHint]?.decoration) {
    const mapped = LEGACY_STYLE_MAPPINGS[styleHint].decoration;
    if (LINE_DECORATION_VALUE_SET.has(mapped)) {
      return mapped;
    }
  }
  return DEFAULT_LINE_DECORATION;
}

function normalizeDecorationDirection(direction, decoration, styleHint) {
  if (decoration === 'none') {
    return DEFAULT_DECORATION_DIRECTION;
  }
  if (LINE_DIRECTION_VALUE_SET.has(direction)) {
    return direction;
  }
  if (styleHint && LEGACY_STYLE_MAPPINGS[styleHint]?.decorationDirection) {
    const mapped = LEGACY_STYLE_MAPPINGS[styleHint].decorationDirection;
    if (LINE_DIRECTION_VALUE_SET.has(mapped)) {
      return mapped;
    }
  }
  return DEFAULT_DECORATION_DIRECTION;
}

function normalizeLineGlow(glow, styleHint) {
  if (typeof glow === 'string') {
    if (glow === 'true' || glow === '1') return true;
    if (glow === 'false' || glow === '0') return false;
  }
  if (typeof glow === 'number') {
    return glow !== 0;
  }
  if (typeof glow === 'boolean') {
    return glow;
  }
  if (styleHint && LEGACY_STYLE_MAPPINGS[styleHint]?.glow) {
    return true;
  }
  return DEFAULT_LINE_GLOW;
}

function normalizeLinkAppearance(info = {}) {
  const styleHint = info.style ?? info.linkStyle;
  const style = normalizeLineStyle(styleHint);
  const decoration = normalizeLineDecoration(info.decoration, styleHint);
  const decorationDirection = normalizeDecorationDirection(
    info.decorationDirection,
    decoration,
    styleHint
  );
  const glow = normalizeLineGlow(info.glow, styleHint);
  return { style, decoration, decorationDirection, glow };
}

function getLineTypePreset(value) {
  return LINE_TYPE_PRESET_LOOKUP.get(value) || LINE_TYPE_PRESET_LOOKUP.get('line');
}

function inferLineTypePreset(style, decoration) {
  const normalizedStyle = normalizeLineStyle(style);
  const normalizedDecoration = normalizeLineDecoration(decoration, style);
  for (const option of LINE_TYPE_PRESETS) {
    if (option.style === normalizedStyle && option.decoration === normalizedDecoration) {
      return option.value;
    }
  }
  if (normalizedDecoration === 'block') {
    return 'blocked';
  }
  if (normalizedStyle === 'dashed') {
    return 'dashed';
  }
  if (normalizedStyle === 'dotted') {
    return 'dotted';
  }
  return 'line';
}

function isDirectionalPreset(preset) {
  return Boolean(preset && preset.directional);
}

function flipDecorationDirection(direction) {
  if (direction === 'start') return 'end';
  if (direction === 'end') return 'start';
  return direction || DEFAULT_DECORATION_DIRECTION;
}

function updateNodeGeometry(id, entry = mapState.elements.get(id)) {
  if (!entry) return;
  const { circle, label } = entry;
  const pos = mapState.positions[id];
  if (!circle || !pos) return;
  const baseR = Number(circle.dataset.radius) || 20;
  const scales = getCurrentScales();
  const nodeScale = scales.nodeScale || 1;
  const labelScale = scales.labelScale || 1;
  circle.setAttribute('cx', pos.x);
  circle.setAttribute('cy', pos.y);
  circle.setAttribute('r', baseR * nodeScale);
  if (label) {
    label.setAttribute('x', pos.x);
    const offset = (baseR + 12) * nodeScale;
    label.setAttribute('y', pos.y - offset);
    const fontSize = Math.max(14, 16 * labelScale);
    label.setAttribute('font-size', fontSize);
  }
}

function updateSelectionHighlight() {
  const ids = mapState.previewSelection || mapState.selectionIds;
  const set = new Set(ids);
  runMutation(() => {
    mapState.elements.forEach(({ circle, label }, id) => {
      if (set.has(id)) {
        circle.classList.add('selected');
        label.classList.add('selected');
      } else {
        circle.classList.remove('selected');
        label.classList.remove('selected');
      }
    });
  });
}

const EDGE_NODE_KEY = Symbol('edgeNodes');

function ensureEdgeRegistry() {
  if (!mapState.edgeRefs) {
    mapState.edgeRefs = new Map();
  }
  if (!mapState.allEdges) {
    mapState.allEdges = new Set();
  }
}

function registerEdgeElement(edge, aId, bId) {
  if (!edge) return;
  ensureEdgeRegistry();
  mapState.allEdges.add(edge);
  const keyA = String(aId);
  const keyB = String(bId);
  edge[EDGE_NODE_KEY] = { aId: keyA, bId: keyB };
  [keyA, keyB].forEach(id => {
    if (!id) return;
    let set = mapState.edgeRefs.get(id);
    if (!set) {
      set = new Set();
      mapState.edgeRefs.set(id, set);
    }
    set.add(edge);
  });
}

function unregisterEdgeElement(edge) {
  if (!edge) return;
  const info = edge[EDGE_NODE_KEY];
  if (info) {
    [info.aId, info.bId].forEach(id => {
      const key = String(id);
      const set = mapState.edgeRefs?.get(key);
      if (!set) return;
      set.delete(edge);
      if (!set.size) {
        mapState.edgeRefs.delete(key);
      }
    });
    delete edge[EDGE_NODE_KEY];
  }
  if (mapState.allEdges) {
    mapState.allEdges.delete(edge);
  }
}

function getLinkInfo(aId, bId) {
  if (!mapState.itemMap) return null;
  const key = String(aId);
  const source = mapState.itemMap[key] || mapState.itemMap[aId];
  if (!source || !Array.isArray(source.links)) return null;
  const otherKey = String(bId);
  return source.links.find(link => String(link?.id) === otherKey) || null;
}

function integrateItemUpdates(...items) {
  if (!items || !items.length) return;
  items.forEach(item => {
    if (!item || !item.id) return;
    if (!mapState.itemMap) {
      mapState.itemMap = {};
    }
    mapState.itemMap[item.id] = item;
    if (Array.isArray(mapState.visibleItems)) {
      const idx = mapState.visibleItems.findIndex(it => it && it.id === item.id);
      if (idx >= 0) {
        mapState.visibleItems[idx] = item;
      }
    }
  });
}

function getEdgeElement(aId, bId) {
  ensureEdgeRegistry();
  const keyA = String(aId);
  const keyB = String(bId);
  const set = mapState.edgeRefs?.get(keyA);
  if (set) {
    for (const edge of set) {
      if (!edge?.dataset) continue;
      const da = String(edge.dataset.a);
      const db = String(edge.dataset.b);
      if ((da === keyA && db === keyB) || (da === keyB && db === keyA)) {
        return edge;
      }
    }
  }
  if (mapState.allEdges) {
    for (const edge of mapState.allEdges) {
      if (!edge?.dataset) continue;
      const da = String(edge.dataset.a);
      const db = String(edge.dataset.b);
      if ((da === keyA && db === keyB) || (da === keyB && db === keyA)) {
        return edge;
      }
    }
  }
  return null;
}

function beginEdgeHandleDrag(line, handleIndex, evt, options = {}) {
  if (!line || !line.dataset) return;
  const aId = line.dataset.a;
  const bId = line.dataset.b;
  if (!aId || !bId) return;
  const pointerId = evt.pointerId;
  const geometry = options.geometry || getLineGeometry(aId, bId, { line });
  if (!geometry) return;
  const pointer = options.pointer || clientToMap(evt.clientX, evt.clientY);
  const prepared = prepareHandlesForDrag(geometry, pointer, handleIndex, {
    forceCreate: options.trigger === 'line'
  });
  const handles = prepared.handles.map(handle => {
    const weight = handle.weight ?? getHandleWeight(handle.position);
    return {
      position: handle.position,
      offset: handle.offset,
      weight,
      startOffset: handle.offset,
      startPosition: handle.position
    };
  });
  if (!handles.length) return;
  const index = clamp(prepared.index, 0, handles.length - 1);
  const createdIndex = Number.isInteger(prepared.createdIndex) ? prepared.createdIndex : -1;
  const insertedHandle = Number.isFinite(prepared.originalLength)
    ? handles.length > prepared.originalLength
    : createdIndex >= 0;
  const createdHandle = insertedHandle ? handles[index] : null;
  const captureTarget = evt.currentTarget || line;
  const baseLength = geometry.trimmedLength || Math.hypot(geometry.endX - geometry.startX, geometry.endY - geometry.startY) || 1;
  mapState.edgeDrag = {
    pointerId,
    line,
    aId,
    bId,
    captureTarget,
    handleIndex: index,
    handles,
    base: {
      startX: geometry.startX,
      startY: geometry.startY,
      endX: geometry.endX,
      endY: geometry.endY,
      ux: geometry.ux,
      uy: geometry.uy,
      trimmedLength: baseLength
    },
    offsetChanged: false,
    hasDragged: false,
    geometry,
    fromHandle: Boolean(evt?.target && evt.target !== line),
    clientStart: { x: evt.clientX, y: evt.clientY },
    createdIndex,
    createdHandle,
    insertedHandle,
    trigger: options.trigger || 'handle',
    activatedByHold: options.activatedByHold === true
  };
  setLineHandlesVisible(line, true, { force: true, sticky: true });
  if (mapState.edgeDrag.captureTarget?.setPointerCapture) {
    try {
      mapState.edgeDrag.captureTarget.setPointerCapture(pointerId);
    } catch {}
  }
}

function clearEdgePressTimer(press) {
  if (!press) return;
  if (press.holdTimer) {
    clearTimeout(press.holdTimer);
    press.holdTimer = null;
  }
}

function resetEdgePress() {
  if (mapState.edgePress) {
    clearEdgePressTimer(mapState.edgePress);
  }
  mapState.edgePress = null;
}

function activateEdgePress(press, pointer, options = {}) {
  if (!press || press.activated) return;
  clearEdgePressTimer(press);
  press.activated = true;
  const line = press.line;
  const aId = press.aId;
  const bId = press.bId;
  if (!line || !aId || !bId) {
    resetEdgePress();
    return;
  }
  const geometry = getLineGeometry(aId, bId, { line });
  if (!geometry) {
    resetEdgePress();
    return;
  }
  const evt = press.originalEvent || press.event;
  if (!evt) {
    resetEdgePress();
    return;
  }
  const pointerMeta = pointer || press.pointerStart || clientToMap(evt.clientX, evt.clientY);
  beginEdgeHandleDrag(line, press.type === 'handle' ? press.handleIndex : press.handleIndex ?? 0, evt, {
    geometry,
    pointer: pointerMeta,
    trigger: press.type,
    activatedByHold: options.fromHold === true || options.fromTimer === true
  });
  mapState.edgePress = null;
}

function startLinePress(line, aId, bId, evt) {
  resetEdgePress();
  const pointer = clientToMap(evt.clientX, evt.clientY);
  const press = {
    type: 'line',
    pointerId: evt.pointerId,
    line,
    aId,
    bId,
    event: evt,
    originalEvent: evt,
    pointerStart: pointer,
    startClient: { x: evt.clientX, y: evt.clientY },
    holdTimer: null,
    activated: false,
    handleIndex: 0
  };
  if (typeof window !== 'undefined') {
    press.holdTimer = window.setTimeout(() => {
      activateEdgePress(press, press.pointerStart, { fromTimer: true, fromHold: true });
    }, EDGE_DRAG_HOLD_DELAY);
  }
  mapState.edgePress = press;
}

function startHandlePress(line, handleIndex, evt) {
  resetEdgePress();
  const pointer = clientToMap(evt.clientX, evt.clientY);
  const press = {
    type: 'handle',
    pointerId: evt.pointerId,
    line,
    aId: line?.dataset?.a,
    bId: line?.dataset?.b,
    handleIndex,
    event: evt,
    originalEvent: evt,
    pointerStart: pointer,
    startClient: { x: evt.clientX, y: evt.clientY },
    holdTimer: null,
    activated: false,
    handleElement: evt.currentTarget || null,
    hoveredAtPress: Boolean(
      evt.currentTarget?.classList?.contains('is-hovered')
      || evt.currentTarget?.parentNode?.classList?.contains('is-hovered')
    )
  };
  if (typeof window !== 'undefined') {
    press.holdTimer = window.setTimeout(() => {
      activateEdgePress(press, press.pointerStart, { fromTimer: true, fromHold: true });
    }, EDGE_DRAG_HOLD_DELAY);
  }
  mapState.edgePress = press;
}

async function removeHandleAt(line, handleIndex) {
  if (!line || !line.dataset) return;
  const aId = line.dataset.a;
  const bId = line.dataset.b;
  if (!aId || !bId) return;
  const handles = parseCurveHandles(line.dataset.handles) || [];
  if (handleIndex < 0 || handleIndex >= handles.length) return;
  const nextHandles = handles.filter((_, idx) => idx !== handleIndex);
  const patch = buildCurvePatchFromHandles(nextHandles);
  await updateLink(aId, bId, patch);
  applyLineStyle(line, patch);
  applyLinkPatchToState(aId, bId, patch);
  mapState.edgeDragJustCompleted = true;
  setTimeout(() => {
    mapState.edgeDragJustCompleted = false;
  }, 0);
}

async function straightenLine(line) {
  if (!line || !line.dataset) return;
  const aId = line.dataset.a;
  const bId = line.dataset.b;
  if (!aId || !bId) return;
  const patch = buildCurvePatchFromHandles([]);
  await updateLink(aId, bId, patch);
  applyLineStyle(line, patch);
  applyLinkPatchToState(aId, bId, patch);
  mapState.edgeDragJustCompleted = true;
  setTimeout(() => {
    mapState.edgeDragJustCompleted = false;
  }, 0);
}

function attachEdgeInteraction(path, aId, bId) {
  if (!path || path.dataset.interactive === '1') return;
  path.dataset.interactive = '1';
  path.addEventListener('pointerdown', evt => {
    if (evt.button !== 0) return;
    if (mapState.tool !== TOOL.NAVIGATE) return;
    mapState.suppressNextClick = false;
    evt.stopPropagation();
    if (typeof evt.preventDefault === 'function') {
      evt.preventDefault();
    }
    startLinePress(path, aId, bId, evt);
  });
  path.addEventListener('click', e => {
    e.stopPropagation();
    handleEdgeClick(path, aId, bId, e);
  });
  path.addEventListener('mouseenter', evt => {
    if (mapState.tool === TOOL.HIDE) {
      applyCursorOverride('hide');
    } else if (mapState.tool === TOOL.BREAK) {
      applyCursorOverride('break');
    }
    const geometry = getLineGeometry(aId, bId, { line: path });
    showLineHandles(path, geometry);
    showEdgeTooltip(path, evt);
    applyLineHover(path);
  });
  path.addEventListener('mouseleave', () => {
    if (mapState.tool === TOOL.HIDE) {
      clearCursorOverride('hide');
    }
    if (mapState.tool === TOOL.BREAK) {
      clearCursorOverride('break');
    }
    hideLineHandles(path);
    hideEdgeTooltip(path);
    clearLineHover(path);
  });
  path.addEventListener('mousemove', evt => moveEdgeTooltip(path, evt));
}

function ensureEdgeBetween(aId, bId, linkInfo = {}) {
  if (!mapState.positions?.[aId] || !mapState.positions?.[bId]) {
    return null;
  }
  const info = linkInfo || {};
  if (info.hidden) {
    removeEdgeBetween(aId, bId);
    return null;
  }
  let path = getEdgeElement(aId, bId);
  if (!path) {
    const container = mapState.edgeLayer || mapState.g || mapState.svg;
    if (!container) return null;
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('class', 'map-edge');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.dataset.a = String(aId);
    path.dataset.b = String(bId);
    container.appendChild(path);
    registerEdgeElement(path, String(aId), String(bId));
    attachEdgeInteraction(path, String(aId), String(bId));
  }
  path.dataset.label = info.name || '';
  applyLineStyle(path, info);
  return path;
}

function removeEdgeBetween(aId, bId) {
  const edge = getEdgeElement(aId, bId);
  if (!edge) return;
  hideEdgeTooltip(edge);
  clearLineHover(edge, { force: true });
  removeLineOverlay(edge);
  removeLineHandles(edge);
  removeLineGap(edge);
  removeEdgeAnimation(edge);
  unregisterEdgeElement(edge);
  edge.remove();
}

function applyLinkVisibility(aId, bId, info = {}) {
  if (info.hidden) {
    removeEdgeBetween(aId, bId);
    return null;
  }
  return ensureEdgeBetween(aId, bId, info);
}

function normalizeLinkEntry(targetId, info = {}) {
  const appearance = normalizeLinkAppearance({
    style: info.style ?? info.linkStyle ?? DEFAULT_LINE_STYLE,
    decoration: info.decoration,
    decorationDirection: info.decorationDirection ?? info.direction,
    glow: info.glow
  });
  const entry = {
    id: targetId,
    style: appearance.style,
    decoration: appearance.decoration,
    decorationDirection: appearance.decorationDirection,
    glow: Boolean(appearance.glow),
    thickness: info.thickness || DEFAULT_LINE_THICKNESS,
    color: info.color || DEFAULT_LINK_COLOR,
    name: typeof info.name === 'string' ? info.name : '',
    hidden: Boolean(info.hidden)
  };
  if (Object.prototype.hasOwnProperty.call(info, 'curve')) {
    const curve = Number(info.curve);
    if (Number.isFinite(curve)) entry.curve = curve;
  }
  if (Object.prototype.hasOwnProperty.call(info, 'curveAnchor')) {
    const anchor = normalizeAnchorValue(info.curveAnchor);
    if (Number.isFinite(anchor)) entry.curveAnchor = anchor;
  }
  const handles = parseCurveHandles(
    info.curveHandles
    ?? info.curvePoints
    ?? info.curveOffsets
    ?? info.handles
  );
  if (handles && handles.length) {
    entry.curveHandles = handles.map(handle => ({
      position: clampHandlePosition(handle.position),
      offset: clampHandleOffset(handle.offset)
    }));
  }
  return entry;
}

function updatePendingHighlight() {
  runMutation(() => {
    mapState.elements.forEach(({ circle, label }, id) => {
      if (mapState.pendingLink === id) {
        circle.classList.add('pending');
        label.classList.add('pending');
      } else {
        circle.classList.remove('pending');
        label.classList.remove('pending');
      }
    });
  });
}

function edgeAnimationAllowed() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  if (mapState.prefersReducedMotion == null && typeof window.matchMedia === 'function') {
    try {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      mapState.prefersReducedMotion = query.matches;
      if (!mapState.motionMedia) {
        const listener = event => {
          mapState.prefersReducedMotion = event.matches;
        };
        if (typeof query.addEventListener === 'function') {
          query.addEventListener('change', listener);
        } else if (typeof query.addListener === 'function') {
          query.addListener(listener);
        }
        mapState.motionMedia = { query, listener };
      }
    } catch {
      mapState.prefersReducedMotion = false;
    }
  }
  return !mapState.prefersReducedMotion;
}

function removeEdgeAnimation(line) {
  const animation = line?._pathAnimation;
  if (!animation) return;
  if (animation._timer && typeof window !== 'undefined') {
    window.clearTimeout(animation._timer);
  }
  try {
    animation.remove();
  } catch {}
  if (line) {
    line._pathAnimation = null;
  }
}

function animatePathTransition(line, from, to, options = {}) {
  if (!line || !from || !to || from === to) return;
  if (!edgeAnimationAllowed()) return;
  if (typeof document === 'undefined') return;
  const duration = Math.max(16, Number(options.duration) || EDGE_ANIMATION_DURATION);
  const animateEl = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
  animateEl.setAttribute('attributeName', 'd');
  animateEl.setAttribute('from', from);
  animateEl.setAttribute('to', to);
  animateEl.setAttribute('dur', `${duration}ms`);
  animateEl.setAttribute('fill', 'freeze');
  animateEl.setAttribute('repeatCount', '1');
  animateEl.setAttribute('calcMode', 'linear');
  const cleanup = () => {
    if (typeof window !== 'undefined' && animateEl._timer) {
      window.clearTimeout(animateEl._timer);
    }
    if (animateEl.parentNode === line) {
      animateEl.remove();
    }
    if (line._pathAnimation === animateEl) {
      line._pathAnimation = null;
    }
  };
  animateEl.addEventListener('endEvent', cleanup);
  animateEl.addEventListener('repeatEvent', cleanup);
  removeEdgeAnimation(line);
  line._pathAnimation = animateEl;
  line.appendChild(animateEl);
  if (typeof window !== 'undefined') {
    animateEl._timer = window.setTimeout(cleanup, duration + 40);
  }
  if (typeof animateEl.beginElement === 'function') {
    try {
      animateEl.beginElement();
    } catch {}
  }
}

function refreshEdgeGeometry(line, options = {}) {
  if (!line) return;
  const aId = line.dataset?.a;
  const bId = line.dataset?.b;
  if (!aId || !bId) return;
  const geometry = options.geometry || getLineGeometry(aId, bId, { line });
  if (geometry?.pathData) {
    const previousPath = line.getAttribute('d') || '';
    line.setAttribute('d', geometry.pathData);
    if (options.animate && previousPath && previousPath !== geometry.pathData) {
      animatePathTransition(line, previousPath, geometry.pathData, options);
    } else {
      removeEdgeAnimation(line);
    }
    line._geometry = geometry;
    syncLineHandles(line, geometry);
    updateLineStrokeWidth(line);
  } else {
    removeEdgeAnimation(line);
    removeLineHandles(line);
  }
  syncLineDecoration(line, geometry);
}

function updateEdgesFor(id, options = {}) {
  ensureEdgeRegistry();
  if (!mapState.edgeRefs) return;
  const key = String(id);
  let edges = mapState.edgeRefs.get(key);
  let list = edges && edges.size ? Array.from(edges) : [];
  if (!list.length && mapState.allEdges && mapState.allEdges.size) {
    list = Array.from(mapState.allEdges).filter(edge => {
      const da = edge?.dataset?.a;
      const db = edge?.dataset?.b;
      return da === key || db === key;
    });
  }
  if (!list.length) return;
  const stale = [];
  list.forEach(edge => {
    if (!edge || !edge.isConnected || !edge.ownerSVGElement) {
      stale.push(edge);
      return;
    }
    refreshEdgeGeometry(edge, options);
  });
  if (stale.length) {
    stale.forEach(edge => {
      unregisterEdgeElement(edge);
    });
  }
}

function buildToolbox(container, hiddenNodeCount, hiddenLinkCount) {
  const tools = [
    { id: TOOL.NAVIGATE, icon: '🧭', label: 'Navigate' },
    { id: TOOL.HIDE, icon: '🪄', label: 'Hide' },
    { id: TOOL.BREAK, icon: '✂️', label: 'Break link' },
    { id: TOOL.ADD_LINK, icon: '🔗', label: 'Add link' },
    { id: TOOL.AREA, icon: '📦', label: 'Select area' }
  ];

  const box = document.createElement('div');
  box.className = 'map-toolbox';
  box.style.left = `${mapState.toolboxPos.x}px`;
  box.style.top = `${mapState.toolboxPos.y}px`;
  mapState.toolboxEl = box;
  mapState.toolboxContainer = container;

  box.addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    if (event.target.closest('.map-tool') || event.target.closest('.map-toolbox-drag')) return;
    startToolboxDrag(event);
  });

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'map-toolbox-drag';
  handle.setAttribute('aria-label', 'Drag toolbar');
  handle.innerHTML = '<span>⋮</span>';
  handle.addEventListener('mousedown', startToolboxDrag);
  box.appendChild(handle);

  const list = document.createElement('div');
  list.className = 'map-tool-list';
  tools.forEach(tool => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-tool' + (mapState.tool === tool.id ? ' active' : '');
    btn.textContent = tool.icon;
    btn.title = tool.label;
    btn.addEventListener('click', () => {
      if (mapState.tool !== tool.id) {
        mapState.tool = tool.id;
        if (tool.id !== TOOL.AREA) {
          mapState.selectionIds = [];
          mapState.previewSelection = null;
          mapState.selectionPreviewSignature = '';
        }
        if (tool.id !== TOOL.ADD_LINK) {
          mapState.pendingLink = null;
        }
        if (tool.id === TOOL.HIDE) {
          mapState.hiddenMenuTab = mapState.hiddenMenuTab === 'links' ? 'links' : 'nodes';
          mapState.panelVisible = true;
        }
        mapState.cursorOverride = null;
        renderMap(mapState.root);
      }
    });
    list.appendChild(btn);
  });
  box.appendChild(list);

  const badges = document.createElement('div');
  badges.className = 'map-tool-badges';
  const nodeBadge = document.createElement('span');
  nodeBadge.className = 'map-tool-badge';
  nodeBadge.setAttribute('title', `${hiddenNodeCount} hidden node${hiddenNodeCount === 1 ? '' : 's'}`);
  const nodeIcon = document.createElement('span');
  nodeIcon.textContent = '🙈';
  const nodeCountEl = document.createElement('strong');
  nodeCountEl.textContent = hiddenNodeCount;
  nodeBadge.append(nodeIcon, nodeCountEl);
  badges.appendChild(nodeBadge);

  const linkBadge = document.createElement('span');
  linkBadge.className = 'map-tool-badge';
  linkBadge.setAttribute('title', `${hiddenLinkCount} hidden link${hiddenLinkCount === 1 ? '' : 's'}`);
  const linkIcon = document.createElement('span');
  linkIcon.textContent = '🕸️';
  const linkCountEl = document.createElement('strong');
  linkCountEl.textContent = hiddenLinkCount;
  linkBadge.append(linkIcon, linkCountEl);
  badges.appendChild(linkBadge);

  box.appendChild(badges);

  container.appendChild(box);
  ensureToolboxWithinBounds();
  mapState.toolboxBadges = {
    nodeBadge,
    linkBadge,
    nodeCountEl,
    linkCountEl
  };
}

function computeHiddenNodeCount() {
  if (!mapState.itemMap) return 0;
  return Object.values(mapState.itemMap).reduce((total, item) => total + (item?.mapHidden ? 1 : 0), 0);
}

function computeHiddenLinkCount() {
  if (!mapState.itemMap) return 0;
  const seen = new Set();
  let count = 0;
  Object.values(mapState.itemMap).forEach(item => {
    const id = item?.id;
    if (!id) return;
    (item.links || []).forEach(link => {
      if (!link?.hidden) return;
      const otherId = link.id;
      if (!otherId) return;
      const key = id < otherId ? `${id}|${otherId}` : `${otherId}|${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      count += 1;
    });
  });
  return count;
}

function refreshToolboxBadges() {
  const badges = mapState.toolboxBadges;
  if (!badges) return;
  const hiddenNodeCount = computeHiddenNodeCount();
  const hiddenLinkCount = computeHiddenLinkCount();
  if (badges.nodeCountEl) {
    badges.nodeCountEl.textContent = hiddenNodeCount;
  }
  if (badges.linkCountEl) {
    badges.linkCountEl.textContent = hiddenLinkCount;
  }
  if (badges.nodeBadge) {
    badges.nodeBadge.setAttribute('title', `${hiddenNodeCount} hidden node${hiddenNodeCount === 1 ? '' : 's'}`);
  }
  if (badges.linkBadge) {
    badges.linkBadge.setAttribute('title', `${hiddenLinkCount} hidden link${hiddenLinkCount === 1 ? '' : 's'}`);
  }
}

function buildHiddenPanel(container, hiddenNodes, hiddenLinks) {
  const allowPanel = mapState.tool === TOOL.HIDE;
  const panel = document.createElement('div');
  panel.className = 'map-hidden-panel';
  if (!(allowPanel && mapState.panelVisible)) {
    panel.classList.add('hidden');
  }

  const header = document.createElement('div');
  header.className = 'map-hidden-header';

  const tabs = document.createElement('div');
  tabs.className = 'map-hidden-tabs';

  const nodeTab = document.createElement('button');
  nodeTab.type = 'button';
  nodeTab.textContent = `Nodes (${hiddenNodes.length})`;
  nodeTab.className = mapState.hiddenMenuTab === 'nodes' ? 'active' : '';
  nodeTab.addEventListener('click', () => {
    mapState.hiddenMenuTab = 'nodes';
    renderMap(mapState.root);
  });
  tabs.appendChild(nodeTab);

  const linkTab = document.createElement('button');
  linkTab.type = 'button';
  linkTab.textContent = `Links (${hiddenLinks.length})`;
  linkTab.className = mapState.hiddenMenuTab === 'links' ? 'active' : '';
  linkTab.addEventListener('click', () => {
    mapState.hiddenMenuTab = 'links';
    renderMap(mapState.root);
  });
  tabs.appendChild(linkTab);

  header.appendChild(tabs);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'map-hidden-close';
  closeBtn.textContent = mapState.panelVisible ? 'Hide' : 'Show';
  closeBtn.addEventListener('click', () => {
    mapState.panelVisible = !mapState.panelVisible;
    renderMap(mapState.root);
  });
  header.appendChild(closeBtn);

  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'map-hidden-body';

  if (mapState.hiddenMenuTab === 'nodes') {
    const list = document.createElement('div');
    list.className = 'map-hidden-list';
    if (hiddenNodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'map-hidden-empty';
      empty.textContent = 'No hidden nodes.';
      list.appendChild(empty);
    } else {
      hiddenNodes
        .slice()
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
        .forEach(it => {
          const item = document.createElement('div');
          item.className = 'map-hidden-item';
          item.classList.add('draggable');
          item.textContent = titleOf(it) || it.id;
          item.addEventListener('mousedown', e => {
            if (mapState.tool !== TOOL.HIDE) return;
            startMenuDrag(it, e, { source: 'hidden' });
          });
          list.appendChild(item);
        });
    }
    body.appendChild(list);
  } else {
    const list = document.createElement('div');
    list.className = 'map-hidden-list';
    if (hiddenLinks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'map-hidden-empty';
      empty.textContent = 'No hidden links.';
      list.appendChild(empty);
    } else {
      hiddenLinks.forEach(link => {
        const item = document.createElement('div');
        item.className = 'map-hidden-item';
        const label = document.createElement('span');
        label.textContent = `${titleOf(link.a)} ↔ ${titleOf(link.b)}`;
        item.appendChild(label);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Unhide';
        btn.addEventListener('click', () => {
          applyLocalLinkHidden(link.a.id, link.b.id, false);
          const forward = getLinkInfo(link.a.id, link.b.id);
          if (forward) {
            forward.hidden = false;
            applyLinkVisibility(link.a.id, link.b.id, forward);
          }
          item.remove();
          refreshToolboxBadges();
          setLinkHidden(link.a.id, link.b.id, false)
            .then(result => {
              if (result) {
                integrateItemUpdates(result.source, result.target);
              } else {
                return renderMap(mapState.root);
              }
              return null;
            })
            .catch(err => {
              console.error(err);
            });
        });
        item.appendChild(btn);
        list.appendChild(item);
      });
    }
    body.appendChild(list);
  }

  panel.appendChild(body);

  container.appendChild(panel);

  if (allowPanel && !mapState.panelVisible) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'map-hidden-toggle';
    toggle.textContent = 'Show menu';
    toggle.addEventListener('click', () => {
      mapState.panelVisible = true;
      renderMap(mapState.root);
    });
    container.appendChild(toggle);
  }
}

function startMenuDrag(item, event, options = {}) {
  event.preventDefault();
  const ghost = document.createElement('div');
  ghost.className = 'map-drag-ghost';
  ghost.textContent = titleOf(item) || item.id;
  document.body.appendChild(ghost);
  mapState.menuDrag = {
    id: item.id,
    ghost,
    source: options.source || 'hidden',
    tabId: options.tabId || (getActiveTab()?.id || null)
  };
  updateMenuDragPosition(event.clientX, event.clientY);
}

async function finishMenuDrag(clientX, clientY) {
  const drag = mapState.menuDrag;
  mapState.menuDrag = null;
  if (drag?.ghost) drag.ghost.remove();
  if (!drag || !mapState.svg) return;
  const rect = getSvgRect({ force: true });
  if (!rect) return;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return;
  }
  const { x, y } = clientToMap(clientX, clientY);
  const item = await getItem(drag.id);
  if (!item) return;
  if (drag.source === 'palette') {
    const tab = getActiveTab();
    if (!tab || !tab.manualMode) return;
    if (drag.tabId && tab.id !== drag.tabId) return;
    if (!Array.isArray(tab.manualIds)) {
      tab.manualIds = [];
    }
    let shouldPersist = false;
    if (!tab.manualIds.includes(item.id)) {
      tab.manualIds.push(item.id);
      shouldPersist = true;
    }
    item.mapHidden = false;
    await upsertItem(item);
    const layout = ensureTabLayout(tab);
    const prev = layout[item.id];
    layout[item.id] = { x, y };
    if (!prev || prev.x !== x || prev.y !== y) {
      shouldPersist = true;
    }
    if (shouldPersist) {
      await persistMapConfig();
    }
    await renderMap(mapState.root);
    return;
  }
  item.mapHidden = false;
  await upsertItem(item);
  const tab = getActiveTab();
  if (tab) {
    const layout = ensureTabLayout(tab);
    const prev = layout[item.id];
    layout[item.id] = { x, y };
    if (!prev || prev.x !== x || prev.y !== y) {
      await persistMapConfig();
    }
  }
  await renderMap(mapState.root);
}

function updateMenuDragPosition(clientX, clientY) {
  if (!mapState.menuDrag?.ghost) return;
  mapState.menuDrag.ghost.style.left = `${clientX + 12}px`;
  mapState.menuDrag.ghost.style.top = `${clientY + 12}px`;
}

function startToolboxDrag(event) {
  if (event.button !== 0) return;
  if (!mapState.toolboxEl || !mapState.toolboxContainer) return;
  if (event.target.closest('.map-toolbox-toggle')) return;
  event.preventDefault();
  const boxRect = mapState.toolboxEl.getBoundingClientRect();
  const containerRect = mapState.toolboxContainer.getBoundingClientRect();
  mapState.toolboxDrag = {
    offsetX: event.clientX - boxRect.left,
    offsetY: event.clientY - boxRect.top,
    boxWidth: boxRect.width,
    boxHeight: boxRect.height,
    containerRect
  };
  if (typeof document !== 'undefined') {
    document.body.classList.add('map-toolbox-dragging');
  }
}

function moveToolboxDrag(clientX, clientY) {
  const drag = mapState.toolboxDrag;
  if (!drag || !mapState.toolboxEl) return;
  const { containerRect, offsetX, offsetY, boxWidth, boxHeight } = drag;
  const width = containerRect.width;
  const height = containerRect.height;
  if (!width || !height) return;
  let x = clientX - containerRect.left - offsetX;
  let y = clientY - containerRect.top - offsetY;
  const maxX = Math.max(0, width - boxWidth);
  const maxY = Math.max(0, height - boxHeight);
  x = clamp(x, 0, maxX);
  y = clamp(y, 0, maxY);
  mapState.toolboxPos = { x, y };
  mapState.toolboxEl.style.left = `${x}px`;
  mapState.toolboxEl.style.top = `${y}px`;
}

function stopToolboxDrag() {
  if (typeof document !== 'undefined') {
    document.body.classList.remove('map-toolbox-dragging');
  }
  if (!mapState.toolboxDrag) {
    ensureToolboxWithinBounds();
    return;
  }
  mapState.toolboxDrag = null;
  ensureToolboxWithinBounds();
}

function ensureToolboxWithinBounds() {
  const box = mapState.toolboxEl;
  const container = mapState.toolboxContainer;
  if (!box || !container || !box.isConnected || !container.isConnected) return;
  const containerRect = container.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const width = containerRect.width;
  const height = containerRect.height;
  if (!width || !height) return;
  const maxX = Math.max(0, width - boxRect.width);
  const maxY = Math.max(0, height - boxRect.height);
  const x = clamp(mapState.toolboxPos.x, 0, maxX);
  const y = clamp(mapState.toolboxPos.y, 0, maxY);
  mapState.toolboxPos = { x, y };
  runMutation(() => {
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  });
}

function determineBaseCursor() {
  if (mapState.draggingView || mapState.nodeDrag || mapState.areaDrag) return 'grabbing';
  switch (mapState.tool) {
    case TOOL.AREA:
      return 'crosshair';
    case TOOL.NAVIGATE:
      return 'grab';
    case TOOL.HIDE:
    case TOOL.BREAK:
    case TOOL.ADD_LINK:
      return 'grab';
    default:
      return 'pointer';
  }
}

function refreshCursor(options = {}) {
  if (!mapState.svg) return;
  const { keepOverride = false } = options;
  const base = determineBaseCursor();
  mapState.baseCursor = base;
  let nextCursor = base;
  if (mapState.cursorOverride) {
    const overrideStyle = CURSOR_STYLE[mapState.cursorOverride];
    if (keepOverride && overrideStyle) {
      nextCursor = overrideStyle;
    } else {
      mapState.cursorOverride = null;
    }
  }
  runMutation(() => {
    mapState.svg.style.cursor = nextCursor;
  });
}

function applyCursorOverride(kind) {
  if (!mapState.svg) return;
  if (mapState.nodeDrag || mapState.areaDrag || mapState.draggingView) return;
  const style = CURSOR_STYLE[kind];
  if (!style) return;
  mapState.cursorOverride = kind;
  mapState.svg.style.cursor = style;
}

function clearCursorOverride(kind) {
  if (mapState.cursorOverride !== kind) return;
  mapState.cursorOverride = null;
  refreshCursor();
}

async function persistNodePosition(id, options = {}) {
  const tab = getActiveTab();
  if (!tab) return;
  const pos = mapState.positions[id];
  if (!pos) return;
  const layout = ensureTabLayout(tab);
  layout[id] = { x: pos.x, y: pos.y };
  if (options.persist !== false) {
    await persistMapConfig();
  }
}

function gatherHiddenLinks(items, itemMap) {
  const hidden = [];
  const seen = new Set();
  items.forEach(it => {
    (it.links || []).forEach(link => {
      if (!link.hidden) return;
      const other = itemMap[link.id];
      if (!other) return;
      const key = it.id < link.id ? `${it.id}|${link.id}` : `${link.id}|${it.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      hidden.push({ a: it, b: other });
    });
  });
  return hidden;
}

async function handleAddLinkClick(nodeId) {
  if (!mapState.pendingLink) {
    mapState.pendingLink = nodeId;
    updatePendingHighlight();
    return;
  }
  if (mapState.pendingLink === nodeId) {
    mapState.pendingLink = null;
    updatePendingHighlight();
    return;
  }
  const from = mapState.itemMap[mapState.pendingLink];
  const to = mapState.itemMap[nodeId];
  if (!from || !to) {
    mapState.pendingLink = null;
    updatePendingHighlight();
    return;
  }
  const existing = (from.links || []).find(l => l.id === nodeId);
  if (existing) {
    if (existing.hidden) {
      if (confirm('A hidden link already exists. Unhide it?')) {
        applyLocalLinkHidden(from.id, to.id, false);
        const forward = getLinkInfo(from.id, to.id);
        if (forward) {
          forward.hidden = false;
          applyLinkVisibility(from.id, to.id, forward);
        }
        refreshToolboxBadges();
        setLinkHidden(from.id, to.id, false)
          .then(result => {
            if (result) {
              integrateItemUpdates(result.source, result.target);
            } else {
              return renderMap(mapState.root);
            }
            return null;
          })
          .catch(err => {
            console.error(err);
          });
      }
    } else {
      alert('These concepts are already linked.');
    }
    mapState.pendingLink = null;
    updatePendingHighlight();
    return;
  }
  if (!confirm(`Create a link between ${titleOf(from)} and ${titleOf(to)}?`)) {
    mapState.pendingLink = null;
    updatePendingHighlight();
    return;
  }
  const label = prompt('Optional label for this link:', '') || '';
  const linkOptions = {
    name: label,
    color: DEFAULT_LINK_COLOR,
    style: DEFAULT_LINE_STYLE,
    decoration: DEFAULT_LINE_DECORATION,
    decorationDirection: DEFAULT_DECORATION_DIRECTION,
    glow: DEFAULT_LINE_GLOW,
    thickness: DEFAULT_LINE_THICKNESS,
    hidden: false
  };
  const optimistic = applyLocalLinkAddition(from.id, to.id, linkOptions);
  const forwardInfo = optimistic?.forward
    ? { ...optimistic.forward, hidden: false }
    : { ...normalizeLinkEntry(to.id, linkOptions), hidden: false };
  applyLinkVisibility(from.id, to.id, forwardInfo);
  mapState.pendingLink = null;
  updatePendingHighlight();
  try {
    const result = await createLink(from.id, to.id, linkOptions);
    if (result) {
      integrateItemUpdates(result.source, result.target);
    } else {
      await renderMap(mapState.root);
    }
  } catch (err) {
    console.error(err);
    await renderMap(mapState.root);
  }
}

function openLinkAssistant(nodeId) {
  const source = mapState.itemMap?.[nodeId];
  if (!source) return;
  mapState.pendingLink = nodeId;
  updatePendingHighlight();
  const win = createFloatingWindow({
    title: `Link ${titleOf(source) || 'concept'}`,
    width: 420,
    onClose: () => {
      if (mapState.pendingLink === nodeId) {
        mapState.pendingLink = null;
        updatePendingHighlight();
      }
    }
  });

  const container = document.createElement('div');
  container.className = 'map-linker';

  const hint = document.createElement('p');
  hint.className = 'map-linker-hint';
  hint.textContent = 'Search for another concept to connect to this one.';
  container.appendChild(hint);

  const labelField = document.createElement('label');
  labelField.className = 'map-linker-field';
  labelField.textContent = 'Link label (optional)';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'input map-linker-label-input';
  labelInput.placeholder = 'Add a short description for this relationship';
  labelField.appendChild(labelInput);
  container.appendChild(labelField);

  const searchField = document.createElement('label');
  searchField.className = 'map-linker-field';
  searchField.textContent = 'Link to';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'input map-linker-search';
  searchInput.placeholder = 'Search concepts…';
  searchField.appendChild(searchInput);
  container.appendChild(searchField);

  const list = document.createElement('div');
  list.className = 'map-linker-results';
  container.appendChild(list);

  const allItems = Object.values(mapState.itemMap || {});
  const existingLinks = new Map();
  (source.links || []).forEach(link => {
    if (link?.id) {
      existingLinks.set(link.id, link);
    }
  });

  const renderResults = () => {
    const query = searchInput.value.trim().toLowerCase();
    list.innerHTML = '';
    const matches = allItems
      .filter(item => item && item.id !== source.id)
      .filter(item => {
        if (!query) return true;
        const label = (titleOf(item) || '').toLowerCase();
        return label.includes(query);
      })
      .sort((a, b) => (titleOf(a) || '').localeCompare(titleOf(b) || ''))
      .slice(0, 15);

    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'map-linker-empty';
      empty.textContent = query ? 'No matching concepts.' : 'No available concepts to link.';
      list.appendChild(empty);
      return;
    }

    matches.forEach(target => {
      const row = document.createElement('div');
      row.className = 'map-linker-result';

      const info = document.createElement('div');
      info.className = 'map-linker-result-info';
      const name = document.createElement('div');
      name.className = 'map-linker-result-title';
      name.textContent = titleOf(target) || target.id;
      info.appendChild(name);
      if (target.kind) {
        const meta = document.createElement('div');
        meta.className = 'map-linker-result-meta';
        meta.textContent = target.kind;
        info.appendChild(meta);
      }
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'map-linker-result-actions';
      const linkInfo = existingLinks.get(target.id);
      if (linkInfo) {
        const status = document.createElement('span');
        status.className = 'map-linker-result-status';
        status.textContent = linkInfo.hidden ? 'Hidden link' : 'Already linked';
        actions.appendChild(status);
        if (linkInfo.hidden) {
          const unhideBtn = document.createElement('button');
          unhideBtn.type = 'button';
          unhideBtn.className = 'btn secondary';
          unhideBtn.textContent = 'Unhide link';
          unhideBtn.addEventListener('click', () => {
            applyLocalLinkHidden(source.id, target.id, false);
            const forward = getLinkInfo(source.id, target.id);
            if (forward) {
              forward.hidden = false;
              existingLinks.set(target.id, forward);
              applyLinkVisibility(source.id, target.id, forward);
            }
            updatePendingHighlight();
            refreshToolboxBadges();
            renderResults();
            setLinkHidden(source.id, target.id, false)
              .then(result => {
                if (result) {
                  integrateItemUpdates(result.source, result.target);
                } else {
                  return renderMap(mapState.root);
                }
                return null;
              })
              .catch(err => {
                console.error(err);
              });
          });
          actions.appendChild(unhideBtn);
        }
      } else {
        const linkBtn = document.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'btn primary';
        linkBtn.textContent = 'Link concepts';
        linkBtn.addEventListener('click', async () => {
          try {
            const label = labelInput.value.trim();
        const result = await createLink(source.id, target.id, {
          name: label,
          color: DEFAULT_LINK_COLOR,
          style: DEFAULT_LINE_STYLE,
          decoration: DEFAULT_LINE_DECORATION,
          decorationDirection: DEFAULT_DECORATION_DIRECTION,
          glow: DEFAULT_LINE_GLOW,
          thickness: DEFAULT_LINE_THICKNESS,
          hidden: false
        });
            if (result) {
              integrateItemUpdates(result.source, result.target);
              existingLinks.set(target.id, result.forward);
              applyLinkVisibility(source.id, target.id, result.forward);
              updatePendingHighlight();
              labelInput.value = '';
              requestAnimationFrame(() => {
                searchInput.focus();
                searchInput.select();
              });
              refreshToolboxBadges();
              renderResults();
            }
          } catch (err) {
            console.error(err);
          }
        });
        actions.appendChild(linkBtn);
      }

      row.appendChild(actions);
      list.appendChild(row);
    });
  };

  searchInput.addEventListener('input', renderResults);

  renderResults();
  win.setContent(container);
  requestAnimationFrame(() => {
    searchInput.focus();
    searchInput.select();
  });
}

function handleEdgeClick(path, aId, bId, evt) {
  hideEdgeTooltip(path);
  if (mapState.edgeDragJustCompleted) {
    mapState.edgeDragJustCompleted = false;
    return;
  }
  if (mapState.tool === TOOL.NAVIGATE) {
    openLineMenu(evt, path, aId, bId);
  } else if (mapState.tool === TOOL.BREAK) {
    if (confirm('Are you sure you want to delete this link?')) {
      applyLocalLinkRemoval(aId, bId);
      removeEdgeBetween(aId, bId);
      updatePendingHighlight();
      refreshToolboxBadges();
      removeLink(aId, bId)
        .then(result => {
          if (result) {
            integrateItemUpdates(result.source, result.target);
          } else {
            return renderMap(mapState.root);
          }
          return null;
        })
        .catch(err => {
          console.error(err);
        });
    }
  } else if (mapState.tool === TOOL.HIDE) {
    if (confirm('Hide this link on the map?')) {
      applyLocalLinkHidden(aId, bId, true);
      applyLinkVisibility(aId, bId, { hidden: true });
      updatePendingHighlight();
      refreshToolboxBadges();
      setLinkHidden(aId, bId, true)
        .then(result => {
          if (result) {
            integrateItemUpdates(result.source, result.target);
          } else {
            return renderMap(mapState.root);
          }
          return null;
        })
        .catch(err => {
          console.error(err);
        });
    }
  }
}

function showEdgeTooltip(line, evt) {
  const tooltip = mapState.edgeTooltip;
  const container = mapState.container;
  if (!tooltip || !container) return;
  const text = line?.dataset?.label || '';
  if (!text) {
    hideEdgeTooltip(line);
    return;
  }
  tooltip.textContent = text;
  tooltip.classList.remove('hidden');
  mapState.hoveredEdge = line;
  if (evt && Number.isFinite(evt.clientX) && Number.isFinite(evt.clientY)) {
    mapState.hoveredEdgePointer = { x: evt.clientX, y: evt.clientY };
  }
  positionEdgeTooltip(evt);
}

function moveEdgeTooltip(line, evt) {
  if (mapState.hoveredEdge !== line) return;
  if (!mapState.edgeTooltip || mapState.edgeTooltip.classList.contains('hidden')) return;
  if (evt && Number.isFinite(evt.clientX) && Number.isFinite(evt.clientY)) {
    mapState.hoveredEdgePointer = { x: evt.clientX, y: evt.clientY };
  }
  positionEdgeTooltip(evt);
}

function hideEdgeTooltip(line) {
  if (line && mapState.hoveredEdge && mapState.hoveredEdge !== line) return;
  const tooltip = mapState.edgeTooltip;
  if (!tooltip) return;
  tooltip.classList.add('hidden');
  tooltip.textContent = '';
  mapState.hoveredEdge = null;
}

function positionEdgeTooltip(evt) {
  const tooltip = mapState.edgeTooltip;
  const container = mapState.container;
  if (!tooltip || !container) return;
  const rect = container.getBoundingClientRect();
  const pointer = evt && Number.isFinite(evt.clientX) && Number.isFinite(evt.clientY)
    ? { x: evt.clientX, y: evt.clientY }
    : mapState.hoveredEdgePointer;
  const rawX = pointer.x - rect.left + 14;
  const rawY = pointer.y - rect.top + 14;
  const maxX = rect.width - tooltip.offsetWidth - 12;
  const maxY = rect.height - tooltip.offsetHeight - 12;
  const clampedX = clamp(rawX, 12, Math.max(12, maxX));
  const clampedY = clamp(rawY, 12, Math.max(12, maxY));
  tooltip.style.left = `${clampedX}px`;
  tooltip.style.top = `${clampedY}px`;
}

function adjustScale() {
  const svg = mapState.svg;
  if (!svg) return;
  const vb = svg.getAttribute('viewBox');
  if (!vb) return;
  const parts = vb.split(/\s+/).map(Number);
  const [, , w, h] = parts;
  if (!Number.isFinite(w) || w <= 0) return;
  const height = Number.isFinite(h) && h > 0 ? h : w;
  const defaultSize = Number.isFinite(mapState.defaultViewSize) ? mapState.defaultViewSize : w;
  const zoomRatio = w / defaultSize;
  const normalized = clamp(zoomRatio, 0.35, 4.5);
  const nodeScale = clamp(Math.pow(normalized, 0.28), 0.78, 1.6);
  const labelScale = clamp(Math.pow(normalized, 0.34), 0.92, 2.85);
  const lineScale = clamp(Math.pow(normalized, -0.4), 0.55, 2.1);

  mapState.lastScaleSize = { w, h: height };
  mapState.currentScales = { nodeScale, labelScale, lineScale, zoomRatio };
  updateMarkerSizes();

  mapState.elements.forEach((entry, id) => {
    updateNodeGeometry(id, entry);
  });

  const allEdges = mapState.allEdges;
  if (allEdges && allEdges.size) {
    const stale = [];
    allEdges.forEach(line => {
      if (!line || !line.isConnected || !line.ownerSVGElement) {
        stale.push(line);
        return;
      }
      if (line.dataset.a && line.dataset.b) {
        const geometry = getLineGeometry(line.dataset.a, line.dataset.b, { line });
        if (geometry?.pathData) {
          refreshEdgeGeometry(line, { geometry, animate: false });
        } else {
          removeEdgeAnimation(line);
          removeLineHandles(line);
          syncLineDecoration(line, geometry);
          updateLineStrokeWidth(line);
        }
      } else {
        updateLineStrokeWidth(line);
        syncLineDecoration(line);
      }
    });
    if (stale.length) {
      stale.forEach(unregisterEdgeElement);
    }
  } else {
    const edgeContainer = mapState.edgeLayer || svg;
    edgeContainer.querySelectorAll('.map-edge').forEach(line => {
      if (line.dataset.a && line.dataset.b) {
        const geometry = getLineGeometry(line.dataset.a, line.dataset.b, { line });
        if (geometry?.pathData) {
          refreshEdgeGeometry(line, { geometry, animate: false });
        } else {
          removeEdgeAnimation(line);
          removeLineHandles(line);
          syncLineDecoration(line, geometry);
          updateLineStrokeWidth(line);
        }
      } else {
        updateLineStrokeWidth(line);
        syncLineDecoration(line);
      }
    });
  }
}

function getNodeBaseRadius(id) {
  if (mapState.nodeRadii && mapState.nodeRadii.has(id)) {
    return mapState.nodeRadii.get(id);
  }
  const entry = mapState.elements?.get(id);
  if (entry?.circle) {
    return Number(entry.circle.dataset.radius) || 20;
  }
  return 20;
}

function getNodeRadius(id) {
  const base = getNodeBaseRadius(id);
  const scales = getCurrentScales();
  return base * (scales.nodeScale || 1);
}

function getNodeFill(item) {
  if (!item || typeof item !== 'object') {
    return 'var(--gray)';
  }
  if (item.color && typeof item.color === 'string') {
    return item.color;
  }
  return KIND_FALLBACK_COLORS[item.kind] || 'var(--gray)';
}

function refreshNodeColor(id) {
  const entry = mapState.elements?.get(id);
  const item = mapState.itemMap?.[id];
  if (entry?.circle && item) {
    entry.circle.setAttribute('fill', getNodeFill(item));
  }
}

function computeTrimmedSegment(aId, bId, options = {}) {
  const positions = mapState.positions || {};
  const a = positions[aId];
  const b = positions[bId];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const ux = dx / len;
  const uy = dy / len;
  const extraA = Number(options.trimA) || 0;
  const extraB = Number(options.trimB) || 0;
  const trimA = Math.min(getNodeRadius(aId) + 6 + extraA, len / 2);
  const trimB = Math.min(getNodeRadius(bId) + 6 + extraB, len / 2);
  const startX = a.x + ux * trimA;
  const startY = a.y + uy * trimA;
  const endX = b.x - ux * trimB;
  const endY = b.y - uy * trimB;
  const trimmedLength = Math.hypot(endX - startX, endY - startY);
  return {
    startX,
    startY,
    endX,
    endY,
    ux,
    uy,
    trimmedLength: trimmedLength || 0
  };
}

function getDefaultHandlePositions(count = CURVE_HANDLE_COUNT) {
  const total = Math.max(0, Math.round(Number(count) || 0));
  if (total <= 0) {
    return [];
  }
  return Array.from({ length: total }, (_, idx) => {
    const raw = (idx + 1) / (total + 1);
    return clampHandlePosition(raw);
  });
}

function clampHandleOffset(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return clamp(num, -CURVE_HANDLE_MAX_OFFSET, CURVE_HANDLE_MAX_OFFSET);
}

function clampHandlePosition(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_CURVE_ANCHOR;
  return clamp(num, 0.08, 0.92);
}

function normalizeCurveHandle(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    if (entry.length < 2) return null;
    return {
      position: clampHandlePosition(entry[0]),
      offset: clampHandleOffset(entry[1])
    };
  }
  if (typeof entry === 'object') {
    if (Object.prototype.hasOwnProperty.call(entry, 'position') || Object.prototype.hasOwnProperty.call(entry, 'offset')) {
      return {
        position: clampHandlePosition(entry.position),
        offset: clampHandleOffset(entry.offset)
      };
    }
  }
  const num = Number(entry);
  if (Number.isFinite(num)) {
    return {
      position: DEFAULT_CURVE_ANCHOR,
      offset: clampHandleOffset(num)
    };
  }
  return null;
}

function parseCurveHandles(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const normalized = value
      .map(normalizeCurveHandle)
      .filter(Boolean);
    return normalized.length ? normalized : null;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const normalized = parsed
          .map(normalizeCurveHandle)
          .filter(Boolean);
        if (normalized.length) return normalized;
      }
    } catch {}
    const pieces = value.split(/[|,\s]+/).map(Number).filter(n => Number.isFinite(n));
    if (pieces.length) {
      const positions = getDefaultHandlePositions(pieces.length);
      return pieces.map((offset, idx) => ({
        position: positions[idx] ?? DEFAULT_CURVE_ANCHOR,
        offset: clampHandleOffset(offset)
      }));
    }
    return null;
  }
  if (typeof value === 'object') {
    return parseCurveHandles(Object.values(value));
  }
  return null;
}

function mergeCurveHandles(baseHandles, overrides) {
  const base = Array.isArray(baseHandles) ? baseHandles.map(handle => ({ position: handle.position, offset: handle.offset })) : [];
  if (!Array.isArray(overrides) || !overrides.length) {
    return base;
  }
  overrides.forEach(override => {
    const handle = normalizeCurveHandle(override);
    if (!handle) return;
    if (!base.length) {
      base.push({
        position: clampHandlePosition(handle.position),
        offset: clampHandleOffset(handle.offset)
      });
      return;
    }
    let bestIndex = 0;
    let bestDist = Infinity;
    base.forEach((candidate, idx) => {
      const candidatePos = candidate?.position ?? DEFAULT_CURVE_ANCHOR;
      const dist = Math.abs(candidatePos - handle.position);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = idx;
      }
    });
    const nextPosition = Object.prototype.hasOwnProperty.call(handle, 'position')
      ? clampHandlePosition(handle.position)
      : clampHandlePosition(base[bestIndex].position);
    const replacement = {
      position: nextPosition,
      offset: clampHandleOffset(handle.offset)
    };
    if (bestDist > 0.12) {
      base.splice(bestIndex + (replacement.position > base[bestIndex].position ? 1 : 0), 0, replacement);
    } else {
      base[bestIndex] = replacement;
    }
  });
  base.sort((a, b) => a.position - b.position);
  return base;
}

function encodeCurveHandles(handles) {
  if (!Array.isArray(handles) || !handles.length) return '';
  const simplified = handles.map(handle => ({
    position: clampHandlePosition(handle.position),
    offset: clampHandleOffset(handle.offset)
  }));
  return JSON.stringify(simplified);
}

function getHandleWeight() {
  return 1;
}

function resolveLineHandles(line, info = {}, overrides = {}, context = {}, options = {}) {
  const datasetHandles = line?.dataset?.handles ? parseCurveHandles(line.dataset.handles) : null;
  const hasExplicitHandles =
    Object.prototype.hasOwnProperty.call(info, 'curveHandles')
    || Object.prototype.hasOwnProperty.call(info, 'curvePoints')
    || Object.prototype.hasOwnProperty.call(info, 'curveOffsets')
    || Object.prototype.hasOwnProperty.call(info, 'handles');
  const infoHandleSource = hasExplicitHandles
    ? info.curveHandles ?? info.curvePoints ?? info.curveOffsets ?? info.handles
    : undefined;
  const infoHandles = parseCurveHandles(infoHandleSource);
  const clearExisting = options?.clearExisting === true
    || (hasExplicitHandles
      && (!infoHandles || !infoHandles.length)
      && (Array.isArray(infoHandleSource) ? infoHandleSource.length === 0 : infoHandleSource == null || infoHandleSource === ''));
  let handles = [];
  if (!clearExisting && datasetHandles && datasetHandles.length) {
    handles = mergeCurveHandles(handles, datasetHandles);
  }
  if (infoHandles && infoHandles.length) {
    handles = mergeCurveHandles(handles, infoHandles);
  } else if (clearExisting) {
    handles = [];
  }

  if (Number.isFinite(overrides.curveOverride)) {
    const anchor = Number.isFinite(overrides.anchorOverride) ? overrides.anchorOverride : DEFAULT_CURVE_ANCHOR;
    handles = mergeCurveHandles(handles, [{ position: anchor, offset: overrides.curveOverride }]);
  }

  return handles.map(handle => ({
    position: clampHandlePosition(handle.position),
    offset: clampHandleOffset(handle.offset)
  }));
}

function distanceSq(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dy = (a.y ?? 0) - (b.y ?? 0);
  return dx * dx + dy * dy;
}

function segmentsIntersect(p1, p2, p3, p4) {
  if (!p1 || !p2 || !p3 || !p4) return false;
  const threshold = 1e-6;
  if (distanceSq(p1, p3) < threshold || distanceSq(p1, p4) < threshold || distanceSq(p2, p3) < threshold || distanceSq(p2, p4) < threshold) {
    return false;
  }
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);

  if (Math.abs(o1) < threshold && onSegment(p1, p2, p3)) return true;
  if (Math.abs(o2) < threshold && onSegment(p1, p2, p4)) return true;
  if (Math.abs(o3) < threshold && onSegment(p3, p4, p1)) return true;
  if (Math.abs(o4) < threshold && onSegment(p3, p4, p2)) return true;

  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function onSegment(p, q, r) {
  const minX = Math.min(p.x, r.x) - 0.001;
  const maxX = Math.max(p.x, r.x) + 0.001;
  const minY = Math.min(p.y, r.y) - 0.001;
  const maxY = Math.max(p.y, r.y) + 0.001;
  return q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY;
}

function buildCurvePoints(segment, handles) {
  const { startX, startY, endX, endY, ux, uy } = segment;
  const dx = endX - startX;
  const dy = endY - startY;
  const length = segment.trimmedLength || Math.hypot(dx, dy) || 1;
  const nx = -uy;
  const ny = ux;
  const points = [{ x: startX, y: startY }];
  const meta = [];
  handles.forEach(handle => {
    const position = clampHandlePosition(handle.position);
    const baseX = startX + dx * position;
    const baseY = startY + dy * position;
    const normalized = clampHandleOffset(handle.offset);
    const weight = getHandleWeight(position);
    const offset = normalized * length * weight;
    const point = {
      x: baseX + nx * offset,
      y: baseY + ny * offset
    };
    points.push(point);
    meta.push({
      position,
      offset: normalized,
      base: { x: baseX, y: baseY },
      weight,
      point
    });
  });
  points.push({ x: endX, y: endY });
  return { points, meta };
}

function buildCurveSegments(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const segments = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : points.length - 1];
    const c1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6
    };
    const c2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6
    };
    segments.push({
      from: p1,
      to: p2,
      c1,
      c2
    });
  }
  return segments;
}

function cubicPoint(p0, c1, c2, p1, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * c1.x + 3 * mt * t2 * c2.x + t * t2 * p1.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * c1.y + 3 * mt * t2 * c2.y + t * t2 * p1.y
  };
}

function cubicTangent(p0, c1, c2, p1, t) {
  const dx = 3 * (1 - t) * (1 - t) * (c1.x - p0.x) + 6 * (1 - t) * t * (c2.x - c1.x) + 3 * t * t * (p1.x - c2.x);
  const dy = 3 * (1 - t) * (1 - t) * (c1.y - p0.y) + 6 * (1 - t) * t * (c2.y - c1.y) + 3 * t * t * (p1.y - c2.y);
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function approximateCubicLength(p0, c1, c2, p1) {
  let prev = p0;
  let length = 0;
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const next = cubicPoint(p0, c1, c2, p1, t);
    length += Math.hypot(next.x - prev.x, next.y - prev.y);
    prev = next;
  }
  return length;
}

function buildPathData(start, segments) {
  if (!start) return '';
  if (!segments.length) return '';
  let path = `M${start.x} ${start.y}`;
  segments.forEach(segment => {
    path += ` C${segment.c1.x} ${segment.c1.y} ${segment.c2.x} ${segment.c2.y} ${segment.to.x} ${segment.to.y}`;
  });
  return path;
}

function computeSegmentIntersectionPoint(a1, a2, b1, b2) {
  const denom = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) {
    return null;
  }
  const detA = a1.x * a2.y - a1.y * a2.x;
  const detB = b1.x * b2.y - b1.y * b2.x;
  const x = (detA * (b1.x - b2.x) - (a1.x - a2.x) * detB) / denom;
  const y = (detA * (b1.y - b2.y) - (a1.y - a2.y) * detB) / denom;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function boundsOverlap(a, b, buffer = LINE_GAP_MIN_DISTANCE) {
  if (!a || !b) return false;
  return !(
    a.maxX + buffer < b.minX
    || a.minX - buffer > b.maxX
    || a.maxY + buffer < b.minY
    || a.minY - buffer > b.maxY
  );
}

function segmentBoundsOverlap(a, b) {
  return boundsOverlap(a, b, LINE_GAP_MIN_DISTANCE * 0.6);
}

function edgesShareEndpoint(lineA, lineB) {
  if (!lineA?.dataset || !lineB?.dataset) return false;
  const a1 = String(lineA.dataset.a ?? '');
  const a2 = String(lineA.dataset.b ?? '');
  const b1 = String(lineB.dataset.a ?? '');
  const b2 = String(lineB.dataset.b ?? '');
  return a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2;
}

function computeSampledGeometry(geometry) {
  if (!geometry) {
    return { points: [], segments: [], bounds: null };
  }
  const points = [];
  const segments = geometry.segments || [];
  const start = { x: geometry.startX, y: geometry.startY };
  if (Number.isFinite(start.x) && Number.isFinite(start.y)) {
    points.push(start);
  }
  if (Array.isArray(segments) && segments.length) {
    segments.forEach(segment => {
      const length = approximateCubicLength(segment.from, segment.c1, segment.c2, segment.to);
      const steps = Math.max(4, Math.ceil(length / 24));
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const point = cubicPoint(segment.from, segment.c1, segment.c2, segment.to, t);
        points.push(point);
      }
    });
  } else {
    points.push({ x: geometry.endX, y: geometry.endY });
  }

  const filtered = [];
  points.forEach(point => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const last = filtered[filtered.length - 1];
    if (last && distanceSq(last, point) < 1e-6) return;
    filtered.push(point);
  });

  const sampleSegments = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  filtered.forEach((point, index) => {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
    if (index === 0) return;
    const prev = filtered[index - 1];
    const segmentBounds = {
      minX: Math.min(prev.x, point.x),
      maxX: Math.max(prev.x, point.x),
      minY: Math.min(prev.y, point.y),
      maxY: Math.max(prev.y, point.y)
    };
    sampleSegments.push({ from: prev, to: point, bounds: segmentBounds });
  });

  if (!sampleSegments.length) {
    return { points: filtered, segments: [], bounds: null };
  }

  return { points: filtered, segments: sampleSegments, bounds };
}

function getLineGapSample(line, geometry) {
  if (!line) {
    return computeSampledGeometry(geometry);
  }
  const key = geometry?.pathData || '';
  const cached = line._gapSample;
  if (cached && cached.key === key) {
    return cached.value;
  }
  const value = computeSampledGeometry(geometry);
  line._gapSample = { key, value };
  return value;
}

function ensureLineGapLayer(line) {
  if (!line) return null;
  const parent = line.parentNode;
  if (!parent) return null;
  let layer = line._gapLayer;
  if (!layer || layer.parentNode !== parent) {
    if (layer?.parentNode) {
      layer.remove();
    }
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.classList.add('map-edge-gap-layer');
    layer.setAttribute('pointer-events', 'none');
    parent.appendChild(layer);
    line._gapLayer = layer;
  }
  return layer;
}

function removeLineGap(line) {
  if (!line) return;
  if (line._gapLayer) {
    line._gapLayer.remove();
    line._gapLayer = null;
  }
  if (line._gapSample) {
    line._gapSample = null;
  }
}

function updateLineGapVisuals(line) {
  if (!line?._gapLayer) return;
  const baseWidth = Number(line.dataset?.baseWidth) || getLineThicknessValue(line.dataset?.thickness);
  const strokeWidth = Math.max(baseWidth * LINE_GAP_STROKE_MULTIPLIER, baseWidth + 4);
  const radius = Math.max(baseWidth * 0.75, 3);
  line._gapLayer.querySelectorAll('.map-edge-gap').forEach(circle => {
    circle.setAttribute('stroke-width', strokeWidth);
    circle.setAttribute('r', radius);
  });
}

function updateLineCrossovers(line, geometry, options = {}) {
  removeLineGap(line);
}

function getPointAlongSegments(segments, ratio) {
  if (!segments.length) return null;
  const clamped = clamp(ratio, 0, 1);
  let total = 0;
  const lengths = segments.map(segment => {
    const length = approximateCubicLength(segment.from, segment.c1, segment.c2, segment.to);
    total += length;
    return length;
  });
  if (!total) {
    const first = segments[0].from;
    const last = segments[segments.length - 1].to;
    return {
      point: {
        x: first.x + (last.x - first.x) * clamped,
        y: first.y + (last.y - first.y) * clamped
      },
      tangent: normalizeVector(last.x - first.x, last.y - first.y)
    };
  }
  let accumulated = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const length = lengths[i];
    const nextAccum = accumulated + length;
    const threshold = clamped * total;
    if (threshold <= nextAccum || i === segments.length - 1) {
      const remaining = threshold - accumulated;
      const localT = length ? clamp(remaining / length, 0, 1) : 0;
      const point = cubicPoint(segment.from, segment.c1, segment.c2, segment.to, localT);
      const tangent = cubicTangent(segment.from, segment.c1, segment.c2, segment.to, localT);
      return { point, tangent };
    }
    accumulated = nextAccum;
  }
  const lastSegment = segments[segments.length - 1];
  const lastPoint = { ...lastSegment.to };
  const tangent = cubicTangent(lastSegment.from, lastSegment.c1, lastSegment.c2, lastSegment.to, 1);
  return { point: lastPoint, tangent };
}

function findNearestHandleIndex(geometry, pointer) {
  if (!geometry || !Array.isArray(geometry.handles) || !geometry.handles.length || !pointer) {
    return 0;
  }
  let bestIndex = 0;
  let bestDist = Infinity;
  geometry.handles.forEach((handle, index) => {
    const px = handle.point?.x ?? handle.base?.x ?? 0;
    const py = handle.point?.y ?? handle.base?.y ?? 0;
    const dist = Math.hypot(pointer.x - px, pointer.y - py);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function buildHandleMetaFromPointer(geometry, pointer) {
  if (!geometry || !pointer) return null;
  const dx = geometry.endX - geometry.startX;
  const dy = geometry.endY - geometry.startY;
  const baseLength = geometry.trimmedLength || Math.hypot(dx, dy) || 1;
  if (!baseLength) return null;
  const projection = ((pointer.x - geometry.startX) * dx + (pointer.y - geometry.startY) * dy) / (baseLength * baseLength);
  const position = clampHandlePosition(projection);
  const baseX = geometry.startX + dx * position;
  const baseY = geometry.startY + dy * position;
  const nx = -geometry.uy;
  const ny = geometry.ux;
  const weight = getHandleWeight(position);
  const rawOffset = ((pointer.x - baseX) * nx + (pointer.y - baseY) * ny) / (baseLength || 1);
  const normalized = clampHandleOffset(rawOffset / (weight || 1));
  const offsetDistance = normalized * baseLength * weight;
  const point = {
    x: baseX + nx * offsetDistance,
    y: baseY + ny * offsetDistance
  };
  return { position, offset: normalized, base: { x: baseX, y: baseY }, weight, point };
}

function prepareHandlesForDrag(geometry, pointer, hintIndex = 0, options = {}) {
  if (!geometry) {
    return { handles: [], index: -1 };
  }
  const handles = Array.isArray(geometry.handles)
    ? geometry.handles.map(handle => ({
      position: clampHandlePosition(handle.position),
      offset: clampHandleOffset(handle.offset),
      base: handle.base,
      point: handle.point,
      weight: handle.weight ?? getHandleWeight(handle.position)
    }))
    : [];

  const originalLength = handles.length;
  let createdIndex = -1;
  const { forceCreate = false } = options;
  let insertedHandle = null;
  let index = clamp(Math.round(hintIndex ?? 0), 0, Math.max(0, handles.length - 1));
  const pointerMeta = pointer ? { x: pointer.x, y: pointer.y } : null;

  if (pointerMeta) {
    let nearestIndex = handles.length ? findNearestHandleIndex({ ...geometry, handles }, pointerMeta) : -1;
    let nearestDistance = Infinity;
    if (handles.length && nearestIndex >= 0) {
      const candidate = handles[nearestIndex];
      const px = candidate?.point?.x ?? candidate?.base?.x ?? geometry.startX;
      const py = candidate?.point?.y ?? candidate?.base?.y ?? geometry.startY;
      nearestDistance = Math.hypot(pointerMeta.x - px, pointerMeta.y - py);
    }
    const threshold = Math.max((geometry.baseWidth || 6) * 2.4, 26);
    const shouldInsert = forceCreate || !handles.length || nearestDistance > threshold;
    if (shouldInsert) {
      const inserted = buildHandleMetaFromPointer(geometry, pointerMeta);
      if (inserted) {
        handles.push(inserted);
        handles.sort((a, b) => a.position - b.position);
        nearestIndex = handles.indexOf(inserted);
        createdIndex = nearestIndex;
        insertedHandle = inserted;
      }
    }
    if (handles.length) {
      const targetIndex = nearestIndex >= 0 ? nearestIndex : handles.indexOf(insertedHandle);
      index = clamp(targetIndex >= 0 ? targetIndex : index, 0, handles.length - 1);
    }
  } else if (forceCreate) {
    const defaultPointer = {
      x: geometry.startX + (geometry.endX - geometry.startX) * DEFAULT_CURVE_ANCHOR,
      y: geometry.startY + (geometry.endY - geometry.startY) * DEFAULT_CURVE_ANCHOR
    };
    const inserted = buildHandleMetaFromPointer(geometry, defaultPointer);
    if (inserted) {
      handles.push(inserted);
      handles.sort((a, b) => a.position - b.position);
      createdIndex = handles.indexOf(inserted);
      index = clamp(createdIndex, 0, handles.length - 1);
    }
  }

  geometry.handles = handles;
  return { handles, index, createdIndex, originalLength };
}

function computeDecorationTrim(decoration, direction, baseWidth) {
  const arrowAllowance = Math.max(22, baseWidth * 4.2);
  const inhibitAllowance = Math.max(12, baseWidth * 2.6);
  let trimA = 0;
  let trimB = 0;
  if (decoration === 'arrow') {
    if (direction === 'start' || direction === 'both') {
      trimA += arrowAllowance;
    }
    if (direction === 'end' || direction === 'both') {
      trimB += arrowAllowance;
    }
  }
  if (decoration === 'inhibit') {
    if (direction === 'start' || direction === 'both') {
      trimA += inhibitAllowance;
    }
    if (direction === 'end' || direction === 'both') {
      trimB += inhibitAllowance;
    }
  }
  return { trimA, trimB };
}

function getLineGeometry(aId, bId, options = {}) {
  const line = options.line || null;
  const appearanceSource = {
    style: options.style ?? options.linkStyle ?? line?.dataset?.style,
    decoration: options.decoration ?? line?.dataset?.decoration,
    decorationDirection:
      options.decorationDirection ?? options.direction ?? line?.dataset?.direction ?? line?.dataset?.decorationDirection,
    glow: options.glow ?? line?.dataset?.glow
  };
  const appearance = normalizeLinkAppearance(appearanceSource);
  const { style, decoration, decorationDirection } = appearance;
  const thicknessKey = options.thickness ?? line?.dataset?.thickness ?? DEFAULT_LINE_THICKNESS;
  const baseWidth = getLineThicknessValue(thicknessKey);
  const trims = computeDecorationTrim(decoration, decorationDirection, baseWidth);
  const segment = computeTrimmedSegment(aId, bId, trims);
  if (!segment) return null;
  let curveOverride;
  if (Object.prototype.hasOwnProperty.call(options, 'curve')) {
    const manual = Number(options.curve);
    curveOverride = Number.isFinite(manual) ? clampHandleOffset(manual) : undefined;
  } else if (line && Object.prototype.hasOwnProperty.call(line.dataset || {}, 'curve')) {
    const manual = Number(line.dataset.curve);
    curveOverride = Number.isFinite(manual) ? clampHandleOffset(manual) : undefined;
  }

  let anchorOverride;
  if (Object.prototype.hasOwnProperty.call(options, 'anchor')) {
    anchorOverride = normalizeAnchorValue(options.anchor);
  } else if (Object.prototype.hasOwnProperty.call(options, 'curveAnchor')) {
    anchorOverride = normalizeAnchorValue(options.curveAnchor);
  } else if (line && Object.prototype.hasOwnProperty.call(line.dataset || {}, 'anchor')) {
    anchorOverride = normalizeAnchorValue(line.dataset.anchor);
  }

  const handles = resolveLineHandles(
    line,
    options,
    { curveOverride, anchorOverride },
    { segment, aId, bId, decoration, decorationDirection }
  );
  const { points, meta } = buildCurvePoints(segment, handles);
  const segments = buildCurveSegments(points);
  const pathData = buildPathData(points[0], segments);
  const mid = getPointAlongSegments(segments, 0.5) || { point: points[Math.floor(points.length / 2)], tangent: { x: segment.ux, y: segment.uy } };
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  const startTangent = firstSegment ? cubicTangent(firstSegment.from, firstSegment.c1, firstSegment.c2, firstSegment.to, 0) : { x: segment.ux, y: segment.uy };
  const endTangent = lastSegment ? cubicTangent(lastSegment.from, lastSegment.c1, lastSegment.c2, lastSegment.to, 1) : { x: segment.ux, y: segment.uy };
  let dominant = { position: DEFAULT_CURVE_ANCHOR, offset: 0 };
  meta.forEach(handle => {
    if (Math.abs(handle.offset) > Math.abs(dominant.offset)) {
      dominant = { position: handle.position, offset: handle.offset };
    }
  });

  const geometry = {
    ...segment,
    style,
    decoration,
    decorationDirection,
    baseWidth,
    anchor: dominant.position,
    curve: dominant.offset,
    handles: meta,
    pathData,
    startTangent,
    endTangent,
    midPoint: mid.point,
    midTangent: mid.tangent,
    segments
  };

  if (line) {
    line._lastSegment = segment;
  }

  return geometry;
}

function calcPath(aId, bId, line = null, info = {}) {
  const geometry = getLineGeometry(aId, bId, { ...info, line });
  if (!geometry) return '';
  return geometry.pathData || '';
}

function hashMarkerKey(input = '') {
  const text = String(input);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function applyMarkerColor(marker, color) {
  if (!marker) return;
  marker.setAttribute('color', color);
  marker.style.color = color;
  marker.querySelectorAll('path').forEach(path => {
    path.setAttribute('fill', color);
    path.setAttribute('stroke', color);
  });
}

function ensureArrowMarker(color, direction) {
  const defs = mapState.markerDefs;
  if (!defs || !direction) {
    return direction === 'start' ? 'arrow-start' : 'arrow-end';
  }
  const normalizedColor = (color || DEFAULT_LINK_COLOR).trim();
  if (!mapState.lineMarkerCache) {
    mapState.lineMarkerCache = new Map();
  }
  const key = `${direction}:${normalizedColor}`;
  if (mapState.lineMarkerCache.has(key)) {
    return mapState.lineMarkerCache.get(key);
  }
  const baseId = direction === 'start' ? 'arrow-start' : 'arrow-end';
  const baseMarker = mapState.lineMarkers?.get(baseId) || document.getElementById(baseId);
  const uniqueId = `${baseId}-${hashMarkerKey(key)}`;
  let marker = mapState.lineMarkers?.get(uniqueId) || document.getElementById(uniqueId);
  if (!marker) {
    if (baseMarker) {
      marker = baseMarker.cloneNode(true);
    } else {
      marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('viewBox', '0 0 16 16');
      marker.setAttribute('markerUnits', 'strokeWidth');
      marker.setAttribute('markerWidth', '9');
      marker.setAttribute('markerHeight', '9');
      marker.setAttribute('orient', 'auto');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = direction === 'start' ? 'M14 2 L2 8 L14 14 L10 8 Z' : 'M2 2 L14 8 L2 14 L6 8 Z';
      path.setAttribute('d', d);
      marker.appendChild(path);
    }
    marker.setAttribute('id', uniqueId);
    defs.appendChild(marker);
  }
  applyMarkerColor(marker, normalizedColor);
  if (mapState.lineMarkers) {
    mapState.lineMarkers.set(uniqueId, marker);
  }
  mapState.lineMarkerCache.set(key, uniqueId);
  updateMarkerSizes();
  return uniqueId;
}


function applyLineStyle(line, info = {}) {
  if (!line) return;
  if (line.dataset && Object.prototype.hasOwnProperty.call(line.dataset, 'autoCurve')) {
    delete line.dataset.autoCurve;
  }
  const previousColor = line.dataset.color;
  const previousThickness = line.dataset.thickness;
  const previousLabel = line.dataset.label;
  const color = info.color ?? previousColor ?? DEFAULT_LINK_COLOR;
  const thickness = info.thickness ?? previousThickness ?? DEFAULT_LINE_THICKNESS;
  const label = info.name ?? previousLabel ?? '';

  const datasetAppearance = {
    style: line.dataset.style,
    decoration: line.dataset.decoration,
    decorationDirection: line.dataset.direction ?? line.dataset.decorationDirection,
    glow: line.dataset.glow
  };
  const overrideAppearance = {};
  if (Object.prototype.hasOwnProperty.call(info, 'style')) overrideAppearance.style = info.style;
  if (Object.prototype.hasOwnProperty.call(info, 'decoration')) overrideAppearance.decoration = info.decoration;
  if (Object.prototype.hasOwnProperty.call(info, 'decorationDirection')) {
    overrideAppearance.decorationDirection = info.decorationDirection;
  } else if (Object.prototype.hasOwnProperty.call(info, 'direction')) {
    overrideAppearance.decorationDirection = info.direction;
  }
  if (Object.prototype.hasOwnProperty.call(info, 'glow')) overrideAppearance.glow = info.glow;
  const appearance = normalizeLinkAppearance({
    ...datasetAppearance,
    ...overrideAppearance
  });
  const { style, decoration, decorationDirection, glow } = appearance;

  line.dataset.color = color;
  line.dataset.style = style;
  if (decoration && decoration !== 'none') {
    line.dataset.decoration = decoration;
  } else {
    delete line.dataset.decoration;
  }
  if (decorationDirection) {
    line.dataset.direction = decorationDirection;
  } else {
    delete line.dataset.direction;
  }
  if (glow) {
    line.dataset.glow = '1';
  } else {
    delete line.dataset.glow;
  }
  const baseWidthValue = getLineThicknessValue(thickness);
  line.dataset.thickness = thickness;
  line.dataset.baseWidth = String(baseWidthValue);
  line.dataset.label = label;

  const hasExplicitHandles =
    Object.prototype.hasOwnProperty.call(info, 'curveHandles')
    || Object.prototype.hasOwnProperty.call(info, 'curvePoints')
    || Object.prototype.hasOwnProperty.call(info, 'curveOffsets')
    || Object.prototype.hasOwnProperty.call(info, 'handles');
  const handleSource = hasExplicitHandles
    ? info.curveHandles ?? info.curvePoints ?? info.curveOffsets ?? info.handles
    : undefined;
  const shouldClearHandles = hasExplicitHandles
    && (!handleSource || (Array.isArray(handleSource) && handleSource.length === 0));

  let curveOverride = Object.prototype.hasOwnProperty.call(info, 'curve')
    ? clampHandleOffset(info.curve)
    : undefined;
  let anchorOverride = Object.prototype.hasOwnProperty.call(info, 'anchor')
    ? normalizeAnchorValue(info.anchor)
    : Object.prototype.hasOwnProperty.call(info, 'curveAnchor')
      ? normalizeAnchorValue(info.curveAnchor)
      : undefined;
  if (shouldClearHandles) {
    curveOverride = undefined;
    if (!Number.isFinite(anchorOverride)) {
      anchorOverride = undefined;
    }
  }

  const aId = line.dataset.a;
  const bId = line.dataset.b;
  let segmentContext = null;
  if (aId && bId) {
    segmentContext = computeTrimmedSegment(aId, bId, computeDecorationTrim(decoration, decorationDirection, baseWidthValue));
  }
  const handles = resolveLineHandles(
    line,
    info,
    { curveOverride, anchorOverride },
    { segment: segmentContext, aId, bId, decoration, decorationDirection },
    { clearExisting: shouldClearHandles }
  );
  const encodedHandles = encodeCurveHandles(handles);
  if (encodedHandles) {
    line.dataset.handles = encodedHandles;
  } else {
    delete line.dataset.handles;
  }

  let dominant = { position: DEFAULT_CURVE_ANCHOR, offset: 0 };
  handles.forEach(handle => {
    if (Math.abs(handle.offset) > Math.abs(dominant.offset)) {
      dominant = handle;
    }
  });
  if (handles.length && Math.abs(dominant.offset) > 0.0001) {
    line.dataset.curve = String(clampHandleOffset(dominant.offset));
  } else {
    delete line.dataset.curve;
  }
  if (handles.length && Number.isFinite(dominant.position)) {
    line.dataset.anchor = String(clampHandlePosition(dominant.position));
  } else {
    delete line.dataset.anchor;
  }

  let geometry = null;
  if (line.dataset.a && line.dataset.b) {
    geometry = getLineGeometry(line.dataset.a, line.dataset.b, {
      ...info,
      style,
      decoration,
      decorationDirection,
      curveHandles: handles,
      curve: dominant.offset,
      anchor: dominant.position,
      line
    });
    if (geometry?.pathData) {
      line.setAttribute('d', geometry.pathData);
    }
  }

  line._lastGeometry = geometry || null;

  updateLineCrossovers(line, geometry);

  updateLineStrokeWidth(line);

  syncLineHandles(line, geometry);

  LINE_STYLE_CLASSNAMES.forEach(cls => line.classList.remove(cls));
  if (style) {
    line.classList.add(`map-edge--${style}`);
  }
  LINE_DECORATION_CLASSNAMES.forEach(cls => line.classList.remove(cls));
  if (decoration && decoration !== 'none') {
    line.classList.add(`map-edge--decoration-${decoration}`);
  }
  line.classList.toggle('map-edge--glow', glow);
  line.classList.toggle('edge-glow', glow);

  line.style.stroke = color;
  line.style.color = color;
  line.setAttribute('stroke', color);
  line.setAttribute('color', color);
  line.style.filter = '';
  line.removeAttribute('marker-start');
  line.removeAttribute('marker-end');
  line.removeAttribute('marker-mid');
  line.removeAttribute('stroke-dasharray');

  if (style === 'dashed') {
    const base = getLineThicknessValue(thickness);
    line.setAttribute('stroke-dasharray', `${base * 3},${base * 2}`);
    line.setAttribute('stroke-linecap', 'round');
  } else if (style === 'dotted') {
    const base = Math.max(1, getLineThicknessValue(thickness) * 0.9);
    line.setAttribute('stroke-dasharray', `${base},${base * 2.1}`);
    line.setAttribute('stroke-linecap', 'round');
  } else {
    line.removeAttribute('stroke-dasharray');
    line.setAttribute('stroke-linecap', 'round');
  }

  if (decoration === 'arrow') {
    if (decorationDirection === 'start' || decorationDirection === 'both') {
      const startId = ensureArrowMarker(color, 'start');
      line.setAttribute('marker-start', `url(#${startId})`);
    }
    if (decorationDirection === 'end' || decorationDirection === 'both') {
      const endId = ensureArrowMarker(color, 'end');
      line.setAttribute('marker-end', `url(#${endId})`);
    }
  }

  const title = line.querySelector('title');
  if (title) title.remove();
  if (label) {
    line.setAttribute('aria-label', label);
  } else {
    line.removeAttribute('aria-label');
  }

  if (mapState.hoveredEdge === line) {
    if (label) {
      showEdgeTooltip(line, { clientX: mapState.hoveredEdgePointer.x, clientY: mapState.hoveredEdgePointer.y });
    } else {
      hideEdgeTooltip(line);
    }
  }

  syncLineDecoration(line, geometry);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeAnchorValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return clamp(num, 0.1, 0.9);
}

function updateLineStrokeWidth(line) {
  if (!line) return;
  const baseWidth = Number(line.dataset.baseWidth) || getLineThicknessValue(line.dataset.thickness);
  const { lineScale = 1 } = getCurrentScales();
  const multiplier = line._hoverActive ? LINE_HOVER_WIDTH_MULTIPLIER : 1;
  const strokeWidth = baseWidth * lineScale * multiplier;
  if (Number.isFinite(strokeWidth)) {
    line.setAttribute('stroke-width', strokeWidth);
  }
  if (line._overlay) {
    const overlayBase = Number(line._overlay.dataset.baseWidth) || baseWidth * 0.85;
    const overlayWidth = overlayBase * lineScale * multiplier;
    if (Number.isFinite(overlayWidth)) {
      line._overlay.setAttribute('stroke-width', overlayWidth);
    }
  }
  updateLineGapVisuals(line);
}

function isLineHovered(line) {
  if (!line) return false;
  if (typeof line.matches === 'function' && line.matches(':hover')) {
    return true;
  }
  if (Array.isArray(line._handleElements)) {
    return line._handleElements.some(handle => typeof handle.matches === 'function' && handle.matches(':hover'));
  }
  return false;
}

function applyLineHover(line) {
  if (!line || line._hoverActive) return;
  line._hoverActive = true;
  updateLineStrokeWidth(line);
  line.classList.add('map-edge--hover');
}

function clearLineHover(line, options = {}) {
  if (!line) return;
  const { force = false } = options;
  if (!force && isLineHovered(line)) {
    return;
  }
  if (line._hoverActive) {
    line._hoverActive = false;
    updateLineStrokeWidth(line);
  }
  line.classList.remove('map-edge--hover');
}

function removeLineHandles(line) {
  if (!line) return;
  if (line._handleElements) {
    line._handleElements.forEach(circle => circle.remove());
  }
  line._handleElements = null;
  if (line._handleHideTimer) {
    clearTimeout(line._handleHideTimer);
    line._handleHideTimer = null;
  }
  if (line._handleStickyRelease) {
    clearTimeout(line._handleStickyRelease);
    line._handleStickyRelease = null;
  }
  line._handleVisible = false;
  line._handleSticky = false;
}

function holdLineHandles(line) {
  if (!line) return;
  if (line._handleStickyRelease) {
    clearTimeout(line._handleStickyRelease);
    line._handleStickyRelease = null;
  }
  setLineHandlesVisible(line, true, { sticky: true });
}

function scheduleHandleRelease(line) {
  if (!line) return;
  if (line._handleStickyRelease) {
    clearTimeout(line._handleStickyRelease);
  }
  line._handleStickyRelease = setTimeout(() => {
    line._handleStickyRelease = null;
    line._handleSticky = false;
    if (!isLineHovered(line)) {
      hideLineHandles(line, { force: true });
    }
  }, HANDLE_STICKY_RELEASE_DELAY);
}

function ensureLineHandles(line, geometry) {
  if (!line) return;
  const parent = line.parentNode;
  if (!parent) {
    removeLineHandles(line);
    return;
  }
  const handles = Array.isArray(geometry?.handles) ? geometry.handles : [];
  if (!handles.length) {
    removeLineHandles(line);
    return;
  }
  const elements = Array.isArray(line._handleElements) ? line._handleElements.slice() : [];
  const nextElements = [];
  const color = getLineStrokeColor(line);
  const { lineScale = 1 } = getCurrentScales();
  const baseRadius = clamp((geometry?.baseWidth || 3) * lineScale * 1.15 + 6, 6, 16);
  const targetRadius = baseRadius + Math.max(6, baseRadius * 0.8);

  const updateEntry = (entry, handle, index) => {
    const point = handle?.point || handle?.base || {
      x: geometry.startX + (geometry.endX - geometry.startX) * (handle?.position ?? DEFAULT_CURVE_ANCHOR),
      y: geometry.startY + (geometry.endY - geometry.startY) * (handle?.position ?? DEFAULT_CURVE_ANCHOR)
    };
    entry.dataset.index = String(index);
    entry.dataset.position = String(handle?.position ?? DEFAULT_CURVE_ANCHOR);
    entry._target.dataset.index = entry.dataset.index;
    entry._target.dataset.position = entry.dataset.position;
    entry._target.setAttribute('cx', point.x);
    entry._target.setAttribute('cy', point.y);
    entry._target.setAttribute('r', targetRadius);
    entry._visual.setAttribute('cx', point.x);
    entry._visual.setAttribute('cy', point.y);
    entry._visual.setAttribute('r', baseRadius);
    entry._visual.style.stroke = color;
    entry._visual.style.color = color;
  };

  const createHandleEntry = () => {
    const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    wrapper.classList.add('map-edge-handle');
    const target = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    target.classList.add('map-edge-handle__target');
    target.setAttribute('fill', 'transparent');
    target.setAttribute('stroke', 'rgba(34, 197, 94, 0)');
    target.setAttribute('stroke-width', '10');
    target.setAttribute('pointer-events', 'all');
    target.style.cursor = 'grab';
    target.style.transition = 'stroke 140ms ease, stroke-width 140ms ease';
    const visual = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    visual.classList.add('map-edge-handle__visual');
    visual.setAttribute('fill', 'rgba(15, 23, 42, 0.85)');
    visual.setAttribute('stroke-width', '2');
    visual.setAttribute('pointer-events', 'none');
    visual.style.transition = 'transform 140ms ease, fill 140ms ease, filter 140ms ease';
    wrapper.append(target, visual);
    wrapper._target = target;
    wrapper._visual = visual;
    wrapper._hoverActive = false;
    wrapper._setHover = active => {
      wrapper._hoverActive = active;
      wrapper.classList.toggle('is-hovered', active);
      target.setAttribute('stroke', active ? 'rgba(34, 197, 94, 0.6)' : 'rgba(34, 197, 94, 0)');
      target.setAttribute('stroke-width', active ? '12' : '10');
      visual.setAttribute('fill', active ? 'rgba(34, 197, 94, 0.82)' : 'rgba(15, 23, 42, 0.85)');
      visual.style.filter = active ? 'drop-shadow(0 0 10px rgba(34, 197, 94, 0.45))' : '';
      visual.style.transform = active ? 'scale(1.18)' : 'scale(1)';
    };
    target.addEventListener('pointerdown', evt => {
      if (evt.button !== 0) return;
      if (mapState.tool !== TOOL.NAVIGATE) return;
      evt.stopPropagation();
      if (typeof evt.preventDefault === 'function') {
        evt.preventDefault();
      }
      const handleIndex = Number(evt.currentTarget?.dataset?.index) || 0;
      startHandlePress(line, handleIndex, evt);
    });
    target.addEventListener('pointerenter', () => {
      if (typeof wrapper._setHover === 'function') {
        wrapper._setHover(true);
      }
      showLineHandles(line);
      holdLineHandles(line);
      applyLineHover(line);
    });
    target.addEventListener('pointerleave', () => {
      if (typeof wrapper._setHover === 'function') {
        wrapper._setHover(false);
      }
      scheduleHandleRelease(line);
      clearLineHover(line);
    });
    target.addEventListener('pointercancel', () => {
      if (typeof wrapper._setHover === 'function') {
        wrapper._setHover(false);
      }
    });
    parent.appendChild(wrapper);
    return wrapper;
  };

  handles.forEach((handle, index) => {
    let entry = elements.shift();
    if (!entry) {
      entry = createHandleEntry();
    }
    updateEntry(entry, handle, index);
    nextElements.push(entry);
  });

  elements.forEach(entry => entry.remove());
  line._handleElements = nextElements;
  line._handleGeometry = geometry || null;
}

function setLineHandlesVisible(line, visible, options = {}) {
  if (!line?._handleElements) return;
  const { force = false, sticky } = options;
  if (typeof sticky === 'boolean') {
    line._handleSticky = sticky;
  }
  if (!visible && line._handleSticky && !force) {
    return;
  }
  if (line._handleHideTimer) {
    clearTimeout(line._handleHideTimer);
    line._handleHideTimer = null;
  }
  line._handleElements.forEach(entry => {
    if (!visible && typeof entry._setHover === 'function') {
      entry._setHover(false);
    }
    entry.classList.toggle('visible', visible);
    if (entry._target) {
      entry._target.style.pointerEvents = visible ? 'auto' : 'none';
    }
  });
  line._handleVisible = visible;
}

function showLineHandles(line, geometry = null) {
  if (!line) return;
  const geo = geometry || getLineGeometry(line.dataset?.a, line.dataset?.b, { line });
  if (!geo) return;
  ensureLineHandles(line, geo);
  setLineHandlesVisible(line, true);
}

function hideLineHandles(line, options = {}) {
  if (!line) return;
  const { force = false } = options;
  if (line._handleSticky && !force) {
    return;
  }
  if (line._handleStickyRelease) {
    clearTimeout(line._handleStickyRelease);
    line._handleStickyRelease = null;
  }
  if (line._handleHideTimer) {
    clearTimeout(line._handleHideTimer);
  }
  const delay = force ? 0 : 120;
  line._handleHideTimer = setTimeout(() => {
    line._handleHideTimer = null;
    if ((line._handleSticky && !force) || (!force && isLineHovered(line))) {
      if (!force) {
        setLineHandlesVisible(line, true, { force: true });
      }
      return;
    }
    setLineHandlesVisible(line, false, { force: true });
    if (!isLineHovered(line) || force) {
      clearLineHover(line, { force: true });
    }
  }, delay);
}

function syncLineHandles(line, geometry = null) {
  if (!line) return;
  if (!line._handleElements || (!line._handleVisible && !line._handleSticky && mapState.edgeDrag?.line !== line)) {
    return;
  }
  const geo = geometry || getLineGeometry(line.dataset?.a, line.dataset?.b, { line });
  if (!geo) return;
  ensureLineHandles(line, geo);
  if (line._handleVisible) {
    setLineHandlesVisible(line, true, { force: true });
  }
}

function syncLineDecoration(line, geometry = null) {
  const decoration = line?.dataset?.decoration || DEFAULT_LINE_DECORATION;
  if (decoration === 'block') {
    const overlay = ensureLineOverlay(line);
    if (overlay) updateBlockedOverlay(line, overlay, geometry);
  } else if (decoration === 'inhibit') {
    const overlay = ensureLineOverlay(line);
    if (overlay) updateInhibitOverlay(line, overlay, geometry);
  } else {
    removeLineOverlay(line);
  }
}

function getLineStrokeColor(line) {
  if (!line) return DEFAULT_LINK_COLOR;
  return line.dataset?.color || line.getAttribute?.('stroke') || DEFAULT_LINK_COLOR;
}

function ensureLineOverlay(line) {
  if (!line || !line.parentNode) return null;
  let overlay = line._overlay;
  if (overlay && overlay.parentNode !== line.parentNode) {
    overlay.remove();
    overlay = null;
  }
  if (!overlay) {
    overlay = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    overlay.classList.add('map-edge-decoration');
    overlay.setAttribute('fill', 'none');
    overlay.setAttribute('pointer-events', 'none');
    overlay.setAttribute('stroke-linecap', 'round');
    overlay.setAttribute('stroke-linejoin', 'round');
    line.parentNode.insertBefore(overlay, line.nextSibling);
    line._overlay = overlay;
  }
  return overlay;
}

function removeLineOverlay(line) {
  if (line && line._overlay) {
    line._overlay.remove();
    line._overlay = null;
  }
}

function normalizeVector(x, y) {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function updateBlockedOverlay(line, overlay, geometryOverride = null) {
  if (!line || !overlay) return;
  const geometry = geometryOverride || getLineGeometry(line.dataset.a, line.dataset.b, { line });
  if (!geometry) return;
  const mid = geometry.midPoint || {
    x: (geometry.startX + geometry.endX) / 2,
    y: (geometry.startY + geometry.endY) / 2
  };
  const tangent = geometry.midTangent || { x: geometry.ux, y: geometry.uy };
  const normal = { x: -tangent.y, y: tangent.x };
  const diag1 = normalizeVector(tangent.x + normal.x, tangent.y + normal.y);
  const diag2 = normalizeVector(tangent.x - normal.x, tangent.y - normal.y);
  const { lineScale = 1 } = getCurrentScales();
  const scaledWidth = geometry.baseWidth * lineScale;
  const armLength = Math.max(26, scaledWidth * 3.8);
  const pathData =
    `M${mid.x - diag1.x * armLength} ${mid.y - diag1.y * armLength}`
    + ` L${mid.x + diag1.x * armLength} ${mid.y + diag1.y * armLength}`
    + ` M${mid.x - diag2.x * armLength} ${mid.y - diag2.y * armLength}`
    + ` L${mid.x + diag2.x * armLength} ${mid.y + diag2.y * armLength}`;
  overlay.setAttribute('d', pathData);
  const overlayBase = Math.max(geometry.baseWidth * 1.35, 2.8);
  overlay.dataset.baseWidth = String(overlayBase);
  overlay.dataset.decoration = 'block';
  const color = getLineStrokeColor(line);
  overlay.setAttribute('stroke', color);
  overlay.style.stroke = color;
  overlay.setAttribute('stroke-width', overlayBase * lineScale);
}

function ensureItemLinks(item) {
  if (!item) return [];
  if (!Array.isArray(item.links)) {
    item.links = [];
  }
  return item.links;
}

function applyLocalLinkAddition(aId, bId, info = {}) {
  const source = mapState.itemMap?.[aId];
  const target = mapState.itemMap?.[bId];
  if (!source || !target) return null;
  const forward = normalizeLinkEntry(bId, info);
  const reverse = normalizeLinkEntry(aId, info);
  if (reverse.decoration && reverse.decoration !== 'none' && reverse.decoration !== 'block') {
    reverse.decorationDirection = flipDecorationDirection(forward.decorationDirection);
  }
  source.links = ensureItemLinks(source).filter(link => String(link?.id) !== String(bId));
  target.links = ensureItemLinks(target).filter(link => String(link?.id) !== String(aId));
  source.links.push({ ...forward });
  target.links.push({ ...reverse });
  return { forward: { ...forward }, reverse: { ...reverse }, source, target };
}

function applyLocalLinkHidden(aId, bId, hidden) {
  const source = mapState.itemMap?.[aId];
  const target = mapState.itemMap?.[bId];
  if (source) {
    ensureItemLinks(source).forEach(link => {
      if (String(link?.id) === String(bId)) {
        link.hidden = hidden;
      }
    });
  }
  if (target) {
    ensureItemLinks(target).forEach(link => {
      if (String(link?.id) === String(aId)) {
        link.hidden = hidden;
      }
    });
  }
}

function applyLocalLinkRemoval(aId, bId) {
  const source = mapState.itemMap?.[aId];
  const target = mapState.itemMap?.[bId];
  if (source) {
    source.links = ensureItemLinks(source).filter(link => String(link?.id) !== String(bId));
  }
  if (target) {
    target.links = ensureItemLinks(target).filter(link => String(link?.id) !== String(aId));
  }
}

function applyLocalNodeHidden(id, hidden) {
  const item = mapState.itemMap?.[id];
  if (item) {
    item.mapHidden = hidden;
  }
  if (!hidden) {
    return;
  }
  if (mapState.selectionIds?.length) {
    mapState.selectionIds = mapState.selectionIds.filter(selected => selected !== id);
    updateSelectionHighlight();
  }
  if (mapState.positions && Object.prototype.hasOwnProperty.call(mapState.positions, id)) {
    delete mapState.positions[id];
  }
  const entry = mapState.elements.get(id);
  if (entry) {
    entry.circle?.remove();
    entry.label?.remove();
    mapState.elements.delete(id);
  }
  if (mapState.edgeRefs) {
    const edges = mapState.edgeRefs.get(String(id));
    if (edges && edges.size) {
      Array.from(edges).forEach(edge => {
        const other = edge?.dataset?.a === String(id) ? edge?.dataset?.b : edge?.dataset?.a;
        if (other) {
          applyLinkVisibility(id, other, { hidden: true });
        }
      });
    }
  }
  updatePendingHighlight();
}

function updateInhibitOverlay(line, overlay, geometryOverride = null) {
  if (!line || !overlay) return;
  const geometry = geometryOverride || getLineGeometry(line.dataset.a, line.dataset.b, { line });
  if (!geometry) return;
  const start = { x: geometry.startX, y: geometry.startY };
  const end = { x: geometry.endX, y: geometry.endY };
  const { lineScale = 1 } = getCurrentScales();
  const scaledWidth = geometry.baseWidth * lineScale;
  const stemLength = Math.max(24, scaledWidth * 4.4);
  const barLength = Math.max(22, scaledWidth * 3.2);
  const retreat = Math.max(8, scaledWidth * 1.35);
  const segments = [];
  const buildSegment = (tip, tangent, directionSign) => {
    const stemStart = { x: tip.x - tangent.x * stemLength * directionSign, y: tip.y - tangent.y * stemLength * directionSign };
    const mid = { x: tip.x - tangent.x * retreat * directionSign, y: tip.y - tangent.y * retreat * directionSign };
    const normal = { x: -tangent.y, y: tangent.x };
    const halfBar = barLength / 2;
    const barA = { x: mid.x + normal.x * halfBar, y: mid.y + normal.y * halfBar };
    const barB = { x: mid.x - normal.x * halfBar, y: mid.y - normal.y * halfBar };
    return `M${stemStart.x} ${stemStart.y} L${tip.x} ${tip.y} M${barA.x} ${barA.y} L${barB.x} ${barB.y}`;
  };
  const direction = geometry.decorationDirection || line.dataset.direction || DEFAULT_DECORATION_DIRECTION;
  if (direction === 'start' || direction === 'both') {
    const tangentStart = geometry.startTangent || { x: geometry.ux, y: geometry.uy };
    segments.push(buildSegment(start, tangentStart, -1));
  }
  if (direction === 'end' || direction === 'both') {
    const tangentEnd = geometry.endTangent || { x: geometry.ux, y: geometry.uy };
    segments.push(buildSegment(end, tangentEnd, 1));
  }
  overlay.setAttribute('d', segments.join(' '));
  const overlayBase = Math.max(geometry.baseWidth * 0.95, 2.6);
  overlay.dataset.baseWidth = String(overlayBase);
  overlay.dataset.decoration = 'inhibit';
  overlay.dataset.direction = direction;
  const color = getLineStrokeColor(line);
  overlay.setAttribute('stroke', color);
  overlay.style.stroke = color;
  overlay.setAttribute('stroke-width', overlayBase * lineScale);
}

async function setNodeHidden(id, hidden) {
  const item = await getItem(id);
  if (!item) return;
  item.mapHidden = hidden;
  await upsertItem(item);
}

async function createLink(aId, bId, info) {
  const a = await getItem(aId);
  const b = await getItem(bId);
  if (!a || !b) return null;
  const linkInfo = normalizeLinkEntry(bId, info);
  const reverseInfo = normalizeLinkEntry(aId, info);
  if (reverseInfo.decoration && reverseInfo.decoration !== 'none' && reverseInfo.decoration !== 'block') {
    reverseInfo.decorationDirection = flipDecorationDirection(linkInfo.decorationDirection);
  }
  a.links = Array.isArray(a.links) ? a.links.filter(l => String(l?.id) !== String(bId)) : [];
  b.links = Array.isArray(b.links) ? b.links.filter(l => String(l?.id) !== String(aId)) : [];
  a.links.push({ ...linkInfo });
  b.links.push({ ...reverseInfo });
  await upsertItem(a);
  await upsertItem(b);
  return { source: a, target: b, forward: { ...linkInfo }, reverse: { ...reverseInfo } };
}

async function removeLink(aId, bId) {
  const a = await getItem(aId);
  const b = await getItem(bId);
  if (!a || !b) return null;
  a.links = (a.links || []).filter(l => l.id !== bId);
  b.links = (b.links || []).filter(l => l.id !== aId);
  await upsertItem(a);
  await upsertItem(b);
  return { source: a, target: b };
}

async function setLinkHidden(aId, bId, hidden) {
  return updateLink(aId, bId, { hidden });
}

function titleOf(item) {
  return item?.name || item?.concept || '';
}

function closeLineMenu(options = {}) {
  const { commit = false } = options;
  const active = mapState.activeLineMenu;
  if (!active) return;
  if (active.cleanup) {
    try {
      active.cleanup();
    } catch {}
  }
  if (!commit && active.restore) {
    try {
      active.restore();
    } catch {}
  }
  if (active.menu?.parentNode) {
    active.menu.remove();
  }
  mapState.activeLineMenu = null;
}

function positionLineMenu(menu, pageX, pageY) {
  if (!menu) return;
  const margin = 12;
  const width = menu.offsetWidth || 0;
  const height = menu.offsetHeight || 0;
  const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || document.documentElement.clientWidth || width;
  const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || document.documentElement.clientHeight || height;
  const scrollX = typeof window !== 'undefined' ? window.scrollX : document.documentElement?.scrollLeft || 0;
  const scrollY = typeof window !== 'undefined' ? window.scrollY : document.documentElement?.scrollTop || 0;
  const left = clamp(pageX + margin, margin + scrollX, scrollX + viewportWidth - width - margin);
  const top = clamp(pageY + margin, margin + scrollY, scrollY + viewportHeight - height - margin);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function openLineMenu(evt, line, aId, bId) {
  closeLineMenu();

  const existing = await getItem(aId);
  if (!existing) return;
  const link = existing.links.find(l => l.id === bId) || {};
  const appearance = normalizeLinkAppearance({
    style: link.style ?? link.linkStyle ?? DEFAULT_LINE_STYLE,
    decoration: link.decoration,
    decorationDirection: link.decorationDirection,
    glow: link.glow
  });
  const initial = {
    color: line?.dataset?.color || link.color || DEFAULT_LINK_COLOR,
    style: line?.dataset?.style || appearance.style,
    decoration: line?.dataset?.decoration || appearance.decoration,
    decorationDirection:
      line?.dataset?.direction
        || line?.dataset?.decorationDirection
        || appearance.decorationDirection
        || DEFAULT_DECORATION_DIRECTION,
    glow: line?.dataset?.glow === '1' || Boolean(appearance.glow),
    thickness: line?.dataset?.thickness || link.thickness || DEFAULT_LINE_THICKNESS,
    name: line?.dataset?.label || link.name || ''
  };

  const existingHandles = parseCurveHandles(line?.dataset?.handles) || [];
  const initialCurveMagnitude = Math.abs(Number(line?.dataset?.curve || 0));
  const canStraighten = existingHandles.length > 0 || initialCurveMagnitude > 0.001;

  const menu = document.createElement('div');
  menu.className = 'line-menu';

  const header = document.createElement('div');
  header.className = 'line-menu__header';
  const titleEl = document.createElement('h3');
  titleEl.textContent = 'Line styling';
  header.appendChild(titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'line-menu__close';
  closeBtn.innerHTML = ICONS.close;
  closeBtn.addEventListener('click', () => closeLineMenu());
  header.appendChild(closeBtn);
  menu.appendChild(header);

  const body = document.createElement('div');
  body.className = 'line-menu__body';
  menu.appendChild(body);

  const colorLabel = document.createElement('label');
  colorLabel.className = 'line-menu__field';
  colorLabel.textContent = 'Color';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(initial.color) ? initial.color : '#888888';
  colorLabel.appendChild(colorInput);
  body.appendChild(colorLabel);

  const typeLabel = document.createElement('label');
  typeLabel.className = 'line-menu__field';
  typeLabel.textContent = 'Line type';
  const typeSel = document.createElement('select');
  LINE_TYPE_PRESETS.forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    typeSel.appendChild(opt);
  });
  const initialPresetValue = inferLineTypePreset(initial.style, initial.decoration);
  typeSel.value = initialPresetValue;
  typeLabel.appendChild(typeSel);
  const typeRow = document.createElement('div');
  typeRow.className = 'line-menu__row';
  typeRow.appendChild(typeLabel);
  const flipBtn = document.createElement('button');
  flipBtn.type = 'button';
  flipBtn.className = 'btn ghost';
  flipBtn.textContent = 'Flip direction';
  typeRow.appendChild(flipBtn);
  body.appendChild(typeRow);

  let currentDirection = initial.decoration === 'arrow' || initial.decoration === 'inhibit'
    ? initial.decorationDirection
    : DEFAULT_DECORATION_DIRECTION;

  const glowField = document.createElement('label');
  glowField.className = 'line-menu-toggle';
  const glowInput = document.createElement('input');
  glowInput.type = 'checkbox';
  glowInput.checked = initial.glow;
  glowField.appendChild(glowInput);
  glowField.appendChild(document.createTextNode(' Glow highlight'));
  body.appendChild(glowField);

  const thickLabel = document.createElement('label');
  thickLabel.className = 'line-menu__field';
  thickLabel.textContent = 'Thickness';
  const thickSel = document.createElement('select');
  LINE_THICKNESS_OPTIONS.forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    thickSel.appendChild(opt);
  });
  thickSel.value = initial.thickness;
  thickLabel.appendChild(thickSel);
  body.appendChild(thickLabel);

  const nameLabel = document.createElement('label');
  nameLabel.className = 'line-menu__field';
  nameLabel.textContent = 'Label';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = initial.name;
  nameLabel.appendChild(nameInput);
  body.appendChild(nameLabel);

  let updateStraightenState = () => {};

  const buildPatch = () => {
    const preset = getLineTypePreset(typeSel.value);
    const styleValue = preset?.style ?? DEFAULT_LINE_STYLE;
    const decorationValue = preset?.decoration ?? DEFAULT_LINE_DECORATION;
    const directional = isDirectionalPreset(preset);
    const directionValue = directional
      ? normalizeDecorationDirection(currentDirection, decorationValue, styleValue)
      : DEFAULT_DECORATION_DIRECTION;
    return {
      color: colorInput.value,
      style: styleValue,
      decoration: decorationValue,
      decorationDirection: directionValue,
      glow: glowInput.checked,
      thickness: thickSel.value,
      name: nameInput.value
    };
  };

  const applyPreview = () => {
    applyLineStyle(line, buildPatch());
    updateStraightenState();
  };

  const updateFlipState = () => {
    const preset = getLineTypePreset(typeSel.value);
    const directional = isDirectionalPreset(preset);
    if (directional) {
      currentDirection = normalizeDecorationDirection(currentDirection, preset.decoration, preset.style);
    } else {
      currentDirection = DEFAULT_DECORATION_DIRECTION;
    }
    flipBtn.hidden = !directional;
    flipBtn.disabled = !directional || currentDirection === 'both';
  };

  flipBtn.addEventListener('click', () => {
    const preset = getLineTypePreset(typeSel.value);
    if (!isDirectionalPreset(preset)) return;
    if (currentDirection === 'both') {
      currentDirection = preset.direction ?? DEFAULT_DECORATION_DIRECTION;
    } else {
      currentDirection = currentDirection === 'start' ? 'end' : 'start';
    }
    updateFlipState();
    applyPreview();
  });

  typeSel.addEventListener('change', () => {
    const preset = getLineTypePreset(typeSel.value);
    if (isDirectionalPreset(preset)) {
      if (preset.value !== initialPresetValue) {
        currentDirection = preset.direction ?? DEFAULT_DECORATION_DIRECTION;
      } else {
        currentDirection = normalizeDecorationDirection(currentDirection, preset.decoration, preset.style);
      }
    } else {
      currentDirection = DEFAULT_DECORATION_DIRECTION;
    }
    updateFlipState();
    applyPreview();
  });

  const actions = document.createElement('div');
  actions.className = 'line-menu__actions';

  const straightenBtn = document.createElement('button');
  straightenBtn.type = 'button';
  straightenBtn.className = 'btn ghost';
  straightenBtn.textContent = 'Straighten line';
  straightenBtn.disabled = !canStraighten;
  straightenBtn.addEventListener('click', async () => {
    if (straightenBtn.disabled) return;
    straightenBtn.disabled = true;
    await straightenLine(line);
    applyPreview();
  });
  actions.appendChild(straightenBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn primary';
  saveBtn.textContent = 'Save changes';
  saveBtn.addEventListener('click', async () => {
    const patch = buildPatch();
    await updateLink(aId, bId, patch);
    applyLineStyle(line, patch);
    closeLineMenu({ commit: true });
  });
  actions.appendChild(saveBtn);

  menu.appendChild(actions);

  updateStraightenState = () => {
    const handles = parseCurveHandles(line?.dataset?.handles) || [];
    const magnitude = Math.abs(Number(line?.dataset?.curve || 0));
    straightenBtn.disabled = !(handles.length || magnitude > 0.001);
  };
  updateStraightenState();

  let observer = null;
  if (typeof MutationObserver !== 'undefined' && line) {
    observer = new MutationObserver(updateStraightenState);
    observer.observe(line, { attributes: true, attributeFilter: ['data-handles', 'data-curve'] });
  }

  colorInput.addEventListener('input', applyPreview);
  glowInput.addEventListener('change', applyPreview);
  thickSel.addEventListener('change', applyPreview);
  nameInput.addEventListener('input', applyPreview);

  updateFlipState();
  applyPreview();

  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    positionLineMenu(menu, evt.pageX, evt.pageY);
  });

  const handleOutside = event => {
    if (menu.contains(event.target)) return;
    closeLineMenu();
  };
  document.addEventListener('pointerdown', handleOutside, true);

  const menuState = {
    menu,
    restore: () => applyLineStyle(line, initial),
    cleanup: () => {
      document.removeEventListener('pointerdown', handleOutside, true);
      if (observer) observer.disconnect();
    }
  };
  mapState.activeLineMenu = menuState;
}

async function updateLink(aId, bId, patch) {
  const a = await getItem(aId);
  const b = await getItem(bId);
  if (!a || !b) return null;
  const existingForward = Array.isArray(a.links)
    ? a.links.find(x => String(x?.id) === String(bId))
    : null;
  const forwardDecoration = Object.prototype.hasOwnProperty.call(patch, 'decoration')
    ? patch.decoration
    : existingForward?.decoration ?? DEFAULT_LINE_DECORATION;
  const forwardDirection = Object.prototype.hasOwnProperty.call(patch, 'decorationDirection')
    ? patch.decorationDirection
    : existingForward?.decorationDirection ?? DEFAULT_DECORATION_DIRECTION;
  const reversePatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, 'decoration')) {
    reversePatch.decoration = forwardDecoration;
  }
  if (forwardDecoration && forwardDecoration !== 'none' && forwardDecoration !== 'block') {
    reversePatch.decorationDirection = flipDecorationDirection(forwardDirection);
  } else if (Object.prototype.hasOwnProperty.call(patch, 'decorationDirection')) {
    reversePatch.decorationDirection = DEFAULT_DECORATION_DIRECTION;
  }

  const apply = (item, otherId, patchValue) => {
    item.links = item.links || [];
    let link = item.links.find(x => String(x?.id) === String(otherId));
    if (link) {
      Object.assign(link, patchValue);
    } else {
      link = normalizeLinkEntry(otherId, patchValue);
      item.links.push(link);
    }
    return { ...link };
  };
  const forward = apply(a, bId, patch);
  const reverse = apply(b, aId, reversePatch);
  await upsertItem(a);
  await upsertItem(b);
  return { source: a, target: b, forward, reverse };
}

function applyLinkPatchToState(aId, bId, patch = {}) {
  const source = mapState.itemMap?.[aId];
  const forwardLink = source?.links?.find(x => String(x?.id) === String(bId)) || null;
  const forwardDecoration = Object.prototype.hasOwnProperty.call(patch, 'decoration')
    ? patch.decoration
    : forwardLink?.decoration ?? DEFAULT_LINE_DECORATION;
  const forwardDirection = Object.prototype.hasOwnProperty.call(patch, 'decorationDirection')
    ? patch.decorationDirection
    : forwardLink?.decorationDirection ?? DEFAULT_DECORATION_DIRECTION;
  const reversePatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, 'decoration')) {
    reversePatch.decoration = forwardDecoration;
  }
  if (forwardDecoration && forwardDecoration !== 'none' && forwardDecoration !== 'block') {
    reversePatch.decorationDirection = flipDecorationDirection(forwardDirection);
  } else if (Object.prototype.hasOwnProperty.call(patch, 'decorationDirection')) {
    reversePatch.decorationDirection = DEFAULT_DECORATION_DIRECTION;
  }

  const assign = (item, otherId, patchValue) => {
    if (!item || !Array.isArray(item.links)) return;
    const link = item.links.find(x => String(x?.id) === String(otherId));
    if (link) Object.assign(link, patchValue);
  };
  assign(source, bId, patch);
  assign(mapState.itemMap?.[bId], aId, reversePatch);
}
