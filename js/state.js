import { loadUIPreferences, updateUIPreferences } from './storage/preferences.js';

const DEFAULT_ENTRY_FILTERS = {
  types: ['disease', 'drug', 'concept'],
  block: '',
  week: '',
  onlyFav: false,
  sort: 'updated-desc'
};

const DEFAULT_LECTURE_STATE = {
  query: '',
  blockId: '',
  week: '',
  status: '',
  tag: '',
  sort: 'position-asc',
  openBlocks: [],
  openWeeks: [],
  openSnapshot: 0,
  scrollTop: 0
};

const DEFAULT_ENTRY_LAYOUT = {
  mode: 'list',
  columns: 3,
  scale: 1,
  controlsVisible: false
};

const DEFAULT_EXAM_LAYOUT = {
  mode: 'grid',
  detailsVisible: true
};

const preferences = loadUIPreferences();

function arrayShallowEqual(a, b) {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  if (arrA.length !== arrB.length) {
    return false;
  }
  for (let i = 0; i < arrA.length; i += 1) {
    if (arrA[i] !== arrB[i]) {
      return false;
    }
  }
  return true;
}

function sanitizeEntryFilters(value) {
  if (!value || typeof value !== 'object') return {};
  const next = {};
  if (Array.isArray(value.types)) {
    const unique = Array.from(
      new Set(
        value.types
          .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean)
      )
    );
    if (unique.length) next.types = unique;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'block')) {
    next.block = String(value.block ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'week')) {
    const raw = value.week;
    if (raw === '' || raw === null || typeof raw === 'undefined') {
      next.week = '';
    } else if (Number.isFinite(Number(raw))) {
      next.week = String(Number(raw));
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'onlyFav')) {
    next.onlyFav = Boolean(value.onlyFav);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'sort')) {
    next.sort = String(value.sort ?? '');
  }
  return next;
}

function sanitizeLectureState(value, { forPersist = false } = {}) {
  if (!value || typeof value !== 'object') return {};
  const next = {};
  const stringKeys = ['query', 'blockId', 'week', 'status', 'tag', 'sort'];
  stringKeys.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      next[key] = String(value[key] ?? '');
    }
  });
  if (Array.isArray(value.openBlocks)) {
    const uniqueBlocks = Array.from(
      new Set(value.openBlocks.map(block => String(block ?? '')))
    );
    next.openBlocks = uniqueBlocks;
  }
  if (Array.isArray(value.openWeeks)) {
    const uniqueWeeks = Array.from(
      new Set(value.openWeeks.map(week => String(week ?? '')))
    );
    next.openWeeks = uniqueWeeks;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'openSnapshot')) {
    const stamp = Number(value.openSnapshot);
    next.openSnapshot = Number.isFinite(stamp) ? stamp : 0;
  }
  if (!forPersist && Object.prototype.hasOwnProperty.call(value, 'scrollTop')) {
    const top = Number(value.scrollTop);
    next.scrollTop = Number.isFinite(top) && top > 0 ? Math.max(0, Math.round(top)) : 0;
  }
  return next;
}

function sanitizeEntryLayout(value) {
  if (!value || typeof value !== 'object') return {};
  const next = {};
  if (Object.prototype.hasOwnProperty.call(value, 'mode')) {
    next.mode = value.mode === 'grid' ? 'grid' : 'list';
  }
  if (Object.prototype.hasOwnProperty.call(value, 'columns')) {
    const cols = Number(value.columns);
    if (!Number.isNaN(cols)) {
      next.columns = Math.max(1, Math.min(6, Math.round(cols)));
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'scale')) {
    const scl = Number(value.scale);
    if (!Number.isNaN(scl)) {
      next.scale = Math.max(0.6, Math.min(1.4, scl));
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'controlsVisible')) {
    next.controlsVisible = Boolean(value.controlsVisible);
  }
  return next;
}

function sanitizeExamLayout(value) {
  if (!value || typeof value !== 'object') return {};
  const next = {};
  if (value.mode === 'row' || value.mode === 'grid') {
    next.mode = value.mode;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'detailsVisible')) {
    next.detailsVisible = Boolean(value.detailsVisible);
  }
  return next;
}

const initialFilters = { ...DEFAULT_ENTRY_FILTERS, ...sanitizeEntryFilters(preferences.filters) };
const initialLectures = { ...DEFAULT_LECTURE_STATE, ...sanitizeLectureState(preferences.lectures || {}) };
const initialEntryLayout = { ...DEFAULT_ENTRY_LAYOUT, ...sanitizeEntryLayout(preferences.entryLayout) };
const initialExamLayout = { ...DEFAULT_EXAM_LAYOUT, ...sanitizeExamLayout(preferences.examLayout) };

export const state = {
  tab: "Block Board",
  subtab: {
    Diseases: "Browse",
    Drugs: "Browse",
    Concepts: "Browse",
    Lists: "Diseases",
    Study: "Builder",
    Exams: "", // placeholder
    Map: "",
    Settings: ""
  },
  query: "",
  filters: initialFilters,
  lectures: initialLectures,
  entryLayout: initialEntryLayout,
  blockBoard: {
    collapsedBlocks: [],
    hiddenTimelines: [],
    autoCollapsed: [],
    autoHidden: [],
    manualExpanded: [],
    manualTimeline: []
  },
  builder: {
    blocks:[],
    weeks:[],
    lectures:[],
    types:["disease","drug","concept"],
    tags:[],
    onlyFav:false,
    manualPicks:[],
    collapsedBlocks:[],
    collapsedWeeks:[],
    activeBlockId:'',
    activeWeekKey:''
  },
  cards: {
    collapsedBlocks: [],
    collapsedWeeks: [],
    initialized: false
  },
  cohort: [],
  review: { count:20, format:"flashcards" },
  quizSession: null,
  flashSession: null,
  examSession: null,
  examAttemptExpanded: {},
  examLayout: initialExamLayout,
  map: { panzoom:false },
  blockMode: { section:"", assignments:{}, reveal:{}, order:{} },
  study: { selectedMode: 'Flashcards' },
  studySessions: {},
  studySessionsLoaded: false
};

export function setTab(value) {
  if (value == null) return false;
  const next = String(value);
  if (state.tab === next) return false;
  state.tab = next;
  return true;
}

export function setSubtab(tab, sub) {
  if (!state.subtab || typeof state.subtab !== 'object') {
    state.subtab = {};
  }
  if (tab == null) return false;
  const tabKey = String(tab);
  if (!tabKey) return false;
  const next = sub == null ? '' : String(sub);
  if (state.subtab[tabKey] === next) return false;
  state.subtab[tabKey] = next;
  return true;
}

export function setQuery(value) {
  const next = value == null ? '' : String(value);
  if (state.query === next) return false;
  state.query = next;
  return true;
}
export function setFilters(patch) {
  if (!patch) return;
  const current = state.filters && typeof state.filters === 'object'
    ? state.filters
    : { ...DEFAULT_ENTRY_FILTERS };
  const next = { ...current };
  let changed = false;

  if (Array.isArray(patch.types)) {
    const unique = Array.from(
      new Set(
        patch.types
          .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean)
      )
    );
    if (unique.length) {
      if (!arrayShallowEqual(current.types, unique)) {
        next.types = unique;
        changed = true;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'block')) {
    const value = String(patch.block ?? '');
    if ((current.block ?? '') !== value) {
      next.block = value;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'week')) {
    const raw = patch.week;
    let normalized;
    if (raw === '' || raw === null || typeof raw === 'undefined') {
      normalized = '';
    } else if (Number.isFinite(Number(raw))) {
      normalized = String(Number(raw));
    }
    if (typeof normalized !== 'undefined' && (current.week ?? '') !== normalized) {
      next.week = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'onlyFav')) {
    const value = Boolean(patch.onlyFav);
    if (Boolean(current.onlyFav) !== value) {
      next.onlyFav = value;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'sort')) {
    const value = String(patch.sort ?? '');
    if ((current.sort ?? '') !== value) {
      next.sort = value;
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  state.filters = next;
  updateUIPreferences({ filters: sanitizeEntryFilters(next) });
}
export function setBuilder(patch){ Object.assign(state.builder, patch); }
export function setBlockBoardState(patch) {
  if (!patch) return;
  if (!state.blockBoard) {
    state.blockBoard = {
      collapsedBlocks: [],
      hiddenTimelines: [],
      autoCollapsed: [],
      autoHidden: [],
      manualExpanded: [],
      manualTimeline: []
    };
  }
  const current = state.blockBoard;
  if (!Array.isArray(current.hiddenTimelines)) {
    current.hiddenTimelines = [];
  }
  if (!Array.isArray(current.autoCollapsed)) {
    current.autoCollapsed = [];
  }
  if (!Array.isArray(current.autoHidden)) {
    current.autoHidden = [];
  }
  if (!Array.isArray(current.manualExpanded)) {
    current.manualExpanded = [];
  }
  if (!Array.isArray(current.manualTimeline)) {
    current.manualTimeline = [];
  }
  if (Array.isArray(patch.collapsedBlocks)) {
    const unique = Array.from(new Set(patch.collapsedBlocks.map(id => String(id))));
    current.collapsedBlocks = unique;
  }
  if (Array.isArray(patch.hiddenTimelines)) {
    const uniqueHidden = Array.from(new Set(patch.hiddenTimelines.map(id => String(id))));
    current.hiddenTimelines = uniqueHidden;
  }
  if (Array.isArray(patch.autoCollapsed)) {
    const autoSet = Array.from(new Set(patch.autoCollapsed.map(id => String(id))));
    current.autoCollapsed = autoSet;
  }
  if (Array.isArray(patch.autoHidden)) {
    const autoHiddenSet = Array.from(new Set(patch.autoHidden.map(id => String(id))));
    current.autoHidden = autoHiddenSet;
  }
  if (Array.isArray(patch.manualExpanded)) {
    const manualExpandedSet = Array.from(new Set(patch.manualExpanded.map(id => String(id))));
    current.manualExpanded = manualExpandedSet;
  }
  if (Array.isArray(patch.manualTimeline)) {
    const manualTimelineSet = Array.from(new Set(patch.manualTimeline.map(id => String(id))));
    current.manualTimeline = manualTimelineSet;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'showDensity')) {
    const show = Boolean(patch.showDensity);
    if (show) {
      current.hiddenTimelines = current.hiddenTimelines.filter(id => id !== '__all__');
    } else if (!current.hiddenTimelines.includes('__all__')) {
      current.hiddenTimelines = [...current.hiddenTimelines, '__all__'];
    }
  }
}
export function setLecturesState(patch) {
  if (!patch) return;
  if (!state.lectures) {
    state.lectures = { ...DEFAULT_LECTURE_STATE };
  }
  const current = state.lectures;
  const next = { ...current };
  let changed = false;
  const stringKeys = ['query', 'blockId', 'week', 'status', 'tag'];
  stringKeys.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const value = String(patch[key] ?? '');
      if ((current?.[key] ?? '') !== value) {
        next[key] = value;
        changed = true;
      }
    }
  });
  if (Object.prototype.hasOwnProperty.call(patch, 'sort')) {
    const value = patch.sort;
    let normalized = current?.sort ?? '';
    if (typeof value === 'string') {
      normalized = value;
    } else if (value && typeof value === 'object') {
      const field =
        typeof value.field === 'string' && value.field.trim() ? value.field.trim() : 'position';
      const direction = value.direction === 'desc' ? 'desc' : 'asc';
      normalized = `${field}-${direction}`;
    }
    if ((current?.sort ?? '') !== normalized) {
      next.sort = normalized;
      changed = true;
    }
  }
  if (Array.isArray(patch.openBlocks)) {
    const unique = Array.from(
      new Set(patch.openBlocks.map(block => String(block ?? '')))
    );
    if (!arrayShallowEqual(current?.openBlocks, unique)) {
      next.openBlocks = unique;
      changed = true;
    }
  }
  if (Array.isArray(patch.openWeeks)) {
    const unique = Array.from(
      new Set(patch.openWeeks.map(week => String(week ?? '')))
    );
    if (!arrayShallowEqual(current?.openWeeks, unique)) {
      next.openWeeks = unique;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'openSnapshot')) {
    const stamp = Number(patch.openSnapshot);
    const normalized = Number.isFinite(stamp) ? stamp : 0;
    if ((current?.openSnapshot ?? 0) !== normalized) {
      next.openSnapshot = normalized;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'scrollTop')) {
    const top = Number(patch.scrollTop);
    const normalized = Number.isFinite(top) && top > 0 ? Math.max(0, Math.round(top)) : 0;
    if ((current?.scrollTop ?? 0) !== normalized) {
      next.scrollTop = normalized;
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  state.lectures = next;
  updateUIPreferences({ lectures: sanitizeLectureState(next, { forPersist: true }) });
}

export function resetLecturesState() {
  state.lectures = { ...DEFAULT_LECTURE_STATE };
  updateUIPreferences({ lectures: sanitizeLectureState(state.lectures, { forPersist: true }) });
}
export function setCardsState(patch){
  if (!patch) return;
  if (!state.cards) {
    state.cards = { collapsedBlocks: [], collapsedWeeks: [], initialized: false };
  }
  const { collapsedBlocks, collapsedWeeks } = patch;
  if (Array.isArray(collapsedBlocks)) {
    const unique = Array.from(new Set(collapsedBlocks.filter(Boolean)));
    state.cards.collapsedBlocks = unique;
  }
  if (Array.isArray(collapsedWeeks)) {
    const unique = Array.from(new Set(collapsedWeeks.filter(Boolean)));
    state.cards.collapsedWeeks = unique;
  }
  state.cards.initialized = true;
}
export function setCohort(items){ state.cohort = items; }
export function resetTransientSessions(){ state.quizSession = null; state.flashSession = null; state.examSession = null; }
export function setFlashSession(sess){ state.flashSession = sess; }
export function setQuizSession(sess){ state.quizSession = sess; }
export function setReviewConfig(patch){ Object.assign(state.review, patch); }
export function setExamSession(sess){ state.examSession = sess; }
export function setExamAttemptExpanded(examId, expanded){
  state.examAttemptExpanded[examId] = expanded;
}
export function setExamLayout(patch) {
  if (!patch) return;
  const current = state.examLayout && typeof state.examLayout === 'object'
    ? state.examLayout
    : { ...DEFAULT_EXAM_LAYOUT };
  const next = { ...current };
  let changed = false;
  if (patch.mode === 'row' || patch.mode === 'grid') {
    if (current.mode !== patch.mode) {
      next.mode = patch.mode;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'detailsVisible')) {
    const value = Boolean(patch.detailsVisible);
    if (Boolean(current.detailsVisible) !== value) {
      next.detailsVisible = value;
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  state.examLayout = next;
  updateUIPreferences({ examLayout: sanitizeExamLayout(next) });
}
export function setBlockMode(patch){ Object.assign(state.blockMode, patch); }
export function resetBlockMode(){ state.blockMode = { section:"", assignments:{}, reveal:{}, order:{} }; }
export function setEntryLayout(patch) {
  if (!patch) return;
  const current = state.entryLayout && typeof state.entryLayout === 'object'
    ? state.entryLayout
    : { ...DEFAULT_ENTRY_LAYOUT };
  const next = { ...current };
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'columns')) {
    const cols = Number(patch.columns);
    if (!Number.isNaN(cols)) {
      const normalized = Math.max(1, Math.min(6, Math.round(cols)));
      if (current.columns !== normalized) {
        next.columns = normalized;
        changed = true;
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'scale')) {
    const scl = Number(patch.scale);
    if (!Number.isNaN(scl)) {
      const normalized = Math.max(0.6, Math.min(1.4, scl));
      if (current.scale !== normalized) {
        next.scale = normalized;
        changed = true;
      }
    }
  }
  if (patch.mode === 'list' || patch.mode === 'grid') {
    if (current.mode !== patch.mode) {
      next.mode = patch.mode;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'controlsVisible')) {
    const value = Boolean(patch.controlsVisible);
    if (Boolean(current.controlsVisible) !== value) {
      next.controlsVisible = value;
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  state.entryLayout = next;
  updateUIPreferences({ entryLayout: sanitizeEntryLayout(next) });
}

export function setStudySelectedMode(mode) {
  if (!state.study) state.study = { selectedMode: 'Flashcards' };
  if (mode === 'Flashcards' || mode === 'Quiz' || mode === 'Blocks') {
    state.study.selectedMode = mode;
  }
}

export function setStudySessions(map) {
  state.studySessions = map ? { ...map } : {};
  state.studySessionsLoaded = true;
}

export function setStudySessionEntry(mode, entry) {
  if (!mode) return;
  const next = { ...(state.studySessions || {}) };
  if (entry) {
    next[mode] = entry;
  } else {
    delete next[mode];
  }
  state.studySessions = next;
}

export function clearStudySessionsState() {
  state.studySessions = {};
  state.studySessionsLoaded = false;
}
