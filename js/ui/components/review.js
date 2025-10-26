
import { setFlashSession, setSubtab, setCohort } from '../../state.js';
import {
  collectDueSections,
  collectUpcomingSections,
  getReviewDurations,
  rateSection,
  suspendSection
} from '../../review/scheduler.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { getSectionLabel } from './section-utils.js';
import { hydrateStudySessions, getStudySessionEntry, removeStudySession } from '../../study/study-sessions.js';
import { loadReviewSourceItems } from '../../review/pool.js';
import { RETIRE_RATING } from '../../review/constants.js';
import { upsertItem } from '../../storage/storage.js';
import { createFloatingWindow } from './window-manager.js';


let blockTitleCache = null;

export function ensureBlockTitleMap(blocks) {
  if (blockTitleCache) return blockTitleCache;
  const map = new Map();
  blocks.forEach(block => {
    if (!block || !block.blockId) return;
    map.set(block.blockId, block.title || block.blockId);

  });
  blockTitleCache = map;
  return map;
}

const DEFAULT_BLOCK_ACCENTS = [
  '#38bdf8',
  '#a855f7',
  '#f97316',
  '#22d3ee',
  '#f59e0b',
  '#34d399',
  '#f472b6'
];

export function ensureBlockAccentMap(blocks = []) {
  const map = new Map();
  let fallbackIndex = 0;
  blocks.forEach(block => {
    if (!block || !block.blockId) return;
    const raw = typeof block.color === 'string' && block.color.trim()
      ? block.color.trim()
      : DEFAULT_BLOCK_ACCENTS[fallbackIndex % DEFAULT_BLOCK_ACCENTS.length];
    fallbackIndex += 1;
    map.set(block.blockId, raw);
  });
  map.set('__unassigned', map.get('__unassigned') || '#64748b');
  return map;
}

function titleOf(item) {
  return item?.name || item?.concept || 'Untitled';
}

function formatOverdue(due, now) {
  const diffMs = Math.max(0, now - due);
  if (diffMs < 60 * 1000) return 'due now';
  const minutes = Math.round(diffMs / (60 * 1000));
  if (minutes < 60) return `${minutes} min overdue`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr overdue`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} overdue`;
}

function formatTimeUntil(due, now) {
  const diffMs = Math.max(0, due - now);
  if (diffMs < 60 * 1000) return 'due in under a minute';
  const minutes = Math.round(diffMs / (60 * 1000));
  if (minutes < 60) return `due in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `due in ${hours} hr`;
  const days = Math.round(hours / 24);
  return `due in ${days} day${days === 1 ? '' : 's'}`;
}

function formatIntervalMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo`;
  const years = Math.round(months / 12);
  return `${years} yr`;
}

function entryKey(entry) {
  if (!entry) return null;
  const itemId = entry.itemId || entry.item?.id || entry.item?.slug || entry.item?.name || 'item';
  return `${itemId}::${entry.sectionKey}`;
}

function describePhase(phase) {
  switch (phase) {
    case 'learning':
      return 'Learning';
    case 'relearning':
      return 'Relearning';
    case 'review':
      return 'Review';
    case 'new':
      return 'New';
    default:
      return '';
  }
}

function buildSessionPayload(entries) {
  return entries.map(entry => ({ item: entry.item, sections: [entry.sectionKey] }));
}

function renderEmptyState(container) {
  const empty = document.createElement('div');
  empty.className = 'review-empty';
  empty.textContent = 'No cards are due right now. Nice work!';
  container.appendChild(empty);
}


const UNASSIGNED_BLOCK = '__unassigned';
const UNASSIGNED_WEEK = '__unassigned';
const UNASSIGNED_LECTURE = '__unassigned';

function registerEntry(bucket, entry) {
  if (!bucket || !entry) return;
  if (!bucket.entryMap) bucket.entryMap = new Map();
  const key = entryKey(entry);
  if (!key || bucket.entryMap.has(key)) return;
  bucket.entryMap.set(key, entry);
}

function finalizeEntries(bucket) {
  if (!bucket) return;
  const entries = bucket.entryMap ? Array.from(bucket.entryMap.values()) : [];
  bucket.entries = entries;
  delete bucket.entryMap;
}

function createBlockOrder(blocks = []) {
  const order = new Map();
  if (!Array.isArray(blocks)) return order;
  blocks.forEach((block, index) => {
    if (!block || !block.blockId) return;
    order.set(block.blockId, index);
  });
  return order;
}

function resolveEntryRefs(entry, blockTitles, blockAccents) {
  const item = entry?.item || {};
  const lectures = Array.isArray(item.lectures) ? item.lectures.filter(Boolean) : [];
  const blocks = Array.isArray(item.blocks) && item.blocks.length
    ? item.blocks
    : [];
  const weeks = Array.isArray(item.weeks) ? item.weeks : [];
  const results = [];

  if (lectures.length) {
    const seen = new Set();
    lectures.forEach(lec => {
      if (!lec) return;
      const blockId = lec.blockId || blocks[0] || UNASSIGNED_BLOCK;
      const lectureId = lec.id != null ? lec.id : UNASSIGNED_LECTURE;
      const rawWeek = lec.week;
      const weekNumber = Number.isFinite(Number(rawWeek)) ? Number(rawWeek) : null;
      const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
      const blockTitle = blockTitles.get(blockId) || (blockId === UNASSIGNED_BLOCK ? 'Unassigned block' : blockId || 'Unassigned block');
      const accent = blockAccents?.get(blockId) || blockAccents?.get(UNASSIGNED_BLOCK) || null;
      const lectureLabel = lec.name ? lec.name : (lectureId !== UNASSIGNED_LECTURE ? `Lecture ${lectureId}` : 'Unassigned lecture');
      const weekLabel = weekNumber != null ? `Week ${weekNumber}` : 'Unassigned week';
      const lectureKey = `${blockId || UNASSIGNED_BLOCK}::${lectureId}`;
      const dedupKey = `${blockId || UNASSIGNED_BLOCK}::${weekId}::${lectureKey}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      results.push({
        blockId: blockId || UNASSIGNED_BLOCK,
        blockTitle,
        accent,
        weekId,
        weekNumber,
        weekLabel,
        lectureKey,
        lectureId,
        lectureLabel
      });
    });
  } else {
    const blockIds = blocks.length ? blocks : [UNASSIGNED_BLOCK];
    const weekValues = weeks.length ? weeks : [null];
    const seen = new Set();
    blockIds.forEach(blockRaw => {
      const blockId = blockRaw || UNASSIGNED_BLOCK;
      const blockTitle = blockTitles.get(blockId) || (blockId === UNASSIGNED_BLOCK ? 'Unassigned block' : blockId || 'Unassigned block');
      const accent = blockAccents?.get(blockId) || blockAccents?.get(UNASSIGNED_BLOCK) || null;
      weekValues.forEach(weekValue => {
        const weekNumber = Number.isFinite(Number(weekValue)) ? Number(weekValue) : null;
        const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
        const weekLabel = weekNumber != null ? `Week ${weekNumber}` : 'Unassigned week';
        const dedupKey = `${blockId}::${weekId}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        results.push({
          blockId,
          blockTitle,
          accent,
          weekId,
          weekNumber,
          weekLabel,
          lectureKey: `${blockId}::${UNASSIGNED_LECTURE}`,
          lectureId: UNASSIGNED_LECTURE,
          lectureLabel: 'Unassigned lecture'
        });
      });
    });
    if (!results.length) {
      results.push({
        blockId: UNASSIGNED_BLOCK,
        blockTitle: 'Unassigned block',
        accent: blockAccents?.get(UNASSIGNED_BLOCK) || null,
        weekId: UNASSIGNED_WEEK,
        weekNumber: null,
        weekLabel: 'Unassigned week',
        lectureKey: `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`,
        lectureId: UNASSIGNED_LECTURE,
        lectureLabel: 'Unassigned lecture'
      });
    }
  }

  return results;
}

export function buildReviewHierarchy(entries, blocks, blockTitles, blockAccents = ensureBlockAccentMap(blocks)) {
  const order = createBlockOrder(blocks);
  const root = {
    id: 'all',
    title: 'All cards',
    blocks: new Map(),
    entryMap: new Map()
  };

  const blockMap = root.blocks;
  const contexts = new Map();

  const registerContext = (entry, context) => {
    const key = entryKey(entry);
    if (!key) return;
    if (!contexts.has(key)) {
      contexts.set(key, []);
    }
    const list = contexts.get(key);
    const exists = list.some(existing => (
      existing.blockId === context.blockId &&
      existing.weekId === context.weekId &&
      existing.lectureKey === context.lectureKey
    ));
    if (!exists) {
      list.push(context);
    }
  };
  entries.forEach(entry => {
    registerEntry(root, entry);
    const refs = resolveEntryRefs(entry, blockTitles, blockAccents);
    refs.forEach(ref => {
      const blockId = ref.blockId || UNASSIGNED_BLOCK;
      let blockNode = blockMap.get(blockId);
      if (!blockNode) {
        blockNode = {
          id: blockId,
          title: ref.blockTitle,
          order: order.has(blockId) ? order.get(blockId) : Number.MAX_SAFE_INTEGER,
          weeks: new Map(),
          entryMap: new Map(),
          accent: blockAccents?.get(blockId) || blockAccents?.get(UNASSIGNED_BLOCK) || null
        };
        blockMap.set(blockId, blockNode);
      }
      registerEntry(blockNode, entry);

      const weekKey = ref.weekId || UNASSIGNED_WEEK;
      let weekNode = blockNode.weeks.get(weekKey);
      if (!weekNode) {
        weekNode = {
          id: weekKey,
          blockId,
          label: ref.weekLabel,
          weekNumber: ref.weekNumber,
          lectures: new Map(),
          entryMap: new Map(),
          accent: blockNode.accent
        };
        blockNode.weeks.set(weekKey, weekNode);
      }
      registerEntry(weekNode, entry);

      const lectureKey = ref.lectureKey || `${blockId}::${UNASSIGNED_LECTURE}`;
      let lectureNode = weekNode.lectures.get(lectureKey);
      if (!lectureNode) {
        lectureNode = {
          id: lectureKey,
          blockId,
          weekId: weekKey,
          weekNumber: ref.weekNumber,
          title: ref.lectureLabel,
          lectureId: ref.lectureId,
          entryMap: new Map(),
          accent: weekNode.accent
        };
        weekNode.lectures.set(lectureKey, lectureNode);
      }
      registerEntry(lectureNode, entry);

      registerContext(entry, {
        blockId,
        blockTitle: blockNode.title,
        weekId: weekKey,
        weekLabel: weekNode.label,
        lectureKey,
        lectureTitle: lectureNode.title,
        accent: lectureNode.accent
      });
    });
  });

  const blocksList = Array.from(blockMap.values());
  blocksList.forEach(blockNode => {
    const weekList = Array.from(blockNode.weeks.values());
    weekList.forEach(weekNode => {
      const lectureList = Array.from(weekNode.lectures.values());
      lectureList.forEach(lectureNode => finalizeEntries(lectureNode));
      lectureList.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      weekNode.lectures = lectureList;
      finalizeEntries(weekNode);
    });
    weekList.sort((a, b) => {
      const aNum = a.weekNumber;
      const bNum = b.weekNumber;
      if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
        if (aNum !== bNum) return aNum - bNum;
      } else if (Number.isFinite(aNum)) {
        return -1;
      } else if (Number.isFinite(bNum)) {
        return 1;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
    blockNode.weeks = weekList;
    finalizeEntries(blockNode);
  });

  blocksList.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });

  finalizeEntries(root);

  return {
    root,
    blocks: blocksList,
    contexts,
    accents: blockAccents
  };
}

function createNodeActions({
  count = 0,
  reviewLabel = 'Review',
  onReview,
  onMenu,
  preventToggle = false
}) {
  const actions = document.createElement('div');
  actions.className = 'review-node-actions';

  const reviewBtn = document.createElement('button');
  reviewBtn.type = 'button';
  reviewBtn.className = 'btn tertiary review-node-action';
  reviewBtn.textContent = `${reviewLabel}${count ? ` (${count})` : ''}`;
  reviewBtn.disabled = !count;
  reviewBtn.addEventListener('click', event => {
    if (preventToggle) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!count) return;
    if (typeof onReview === 'function') onReview();
  });
  actions.appendChild(reviewBtn);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'icon-button review-node-gear';
  menuBtn.innerHTML = '⚙';
  menuBtn.title = 'View entries';
  menuBtn.disabled = !count;
  menuBtn.addEventListener('click', event => {
    if (preventToggle) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (typeof onMenu === 'function') onMenu();
  });
  actions.appendChild(menuBtn);

  return actions;
}

function createCollapsibleNode({
  level = 0,
  title,
  count,
  reviewLabel,
  onReview,
  onMenu,
  defaultOpen = false,
  accent = null
}) {
  const details = document.createElement('details');
  details.className = `review-node review-node-level-${level}`;
  if (defaultOpen) details.open = true;
  if (accent) {
    details.classList.add('has-accent');
    details.style.setProperty('--review-accent', accent);
  }

  const summary = document.createElement('summary');
  summary.className = 'review-node-summary';

  const header = document.createElement('div');
  header.className = 'review-node-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'review-node-title-wrap';
  const accentDot = document.createElement('span');
  accentDot.className = 'review-node-accent-dot';
  if (accent) {
    accentDot.style.setProperty('--review-accent', accent);
  } else {
    accentDot.hidden = true;
  }
  const titleEl = document.createElement('div');
  titleEl.className = 'review-node-title';
  titleEl.textContent = title;
  titleWrap.appendChild(accentDot);
  titleWrap.appendChild(titleEl);
  const countEl = document.createElement('span');
  countEl.className = 'review-node-count';
  countEl.textContent = `${count} card${count === 1 ? '' : 's'}`;
  header.appendChild(titleWrap);
  header.appendChild(countEl);
  summary.appendChild(header);

  const actions = createNodeActions({
    count,
    reviewLabel,
    onReview,
    onMenu,
    preventToggle: true
  });
  summary.appendChild(actions);

  details.appendChild(summary);

  const content = document.createElement('div');
  content.className = 'review-node-content';
  details.appendChild(content);

  return { element: details, content, actions };
}

function createUpcomingEntry(entry, now, startSession) {
  const item = document.createElement('li');
  item.className = 'review-entry is-upcoming';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'review-entry-trigger';

  const title = document.createElement('div');
  title.className = 'review-entry-title';
  title.textContent = titleOf(entry.item);
  trigger.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'review-entry-meta';
  meta.textContent = `${getSectionLabel(entry.item, entry.sectionKey)} • ${formatTimeUntil(entry.due, now)}`;
  trigger.appendChild(meta);

  const phaseLabel = describePhase(entry.phase);
  const interval = entry?.state?.interval;
  if (phaseLabel || Number.isFinite(interval)) {
    const extra = document.createElement('div');
    extra.className = 'review-entry-extra';
    if (phaseLabel) {
      const chip = document.createElement('span');
      chip.className = 'review-entry-chip';
      chip.textContent = phaseLabel;
      extra.appendChild(chip);
    }
    if (Number.isFinite(interval) && interval > 0) {
      const chip = document.createElement('span');
      chip.className = 'review-entry-chip';
      chip.textContent = `Last interval • ${formatIntervalMinutes(interval)}`;
      extra.appendChild(chip);
    }
    trigger.appendChild(extra);
  }

  trigger.addEventListener('click', () => {
    if (typeof startSession !== 'function') return;
    startSession(buildSessionPayload([entry]), {
      scope: 'single',
      label: `Focused review – ${titleOf(entry.item)}`
    });
  });

  item.appendChild(trigger);
  return item;
}

function renderUpcomingSection(container, upcomingEntries, now, startSession) {
  if (!Array.isArray(upcomingEntries) || !upcomingEntries.length) return;

  const section = document.createElement('div');
  section.className = 'review-upcoming-section';

  const heading = document.createElement('div');
  heading.className = 'review-upcoming-title';
  heading.textContent = 'Upcoming cards';
  section.appendChild(heading);

  const note = document.createElement('div');
  note.className = 'review-upcoming-note';
  note.textContent = `Next ${upcomingEntries.length} card${upcomingEntries.length === 1 ? '' : 's'} in the queue`;
  section.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'review-upcoming-actions';
  const startUpcomingBtn = document.createElement('button');
  startUpcomingBtn.type = 'button';
  startUpcomingBtn.className = 'btn secondary';
  startUpcomingBtn.textContent = `Review upcoming (${upcomingEntries.length})`;
  startUpcomingBtn.addEventListener('click', () => {
    if (!upcomingEntries.length) return;
    if (typeof startSession === 'function') {
      startSession(buildSessionPayload(upcomingEntries), { scope: 'upcoming', label: 'Upcoming cards' });
    }
  });
  actions.appendChild(startUpcomingBtn);
  section.appendChild(actions);

  const list = document.createElement('ul');
  list.className = 'review-entry-list';
  upcomingEntries.forEach(entry => {
    list.appendChild(createUpcomingEntry(entry, now, startSession));
  });
  section.appendChild(list);

  container.appendChild(section);
}

export function openEntryManager(hierarchy, {
  title = 'Entries',
  now = Date.now(),
  startSession,
  metadata = {},
  focus = {},
  highlightEntryKey = null,
  onChange
} = {}) {
  const floating = createFloatingWindow({ title, width: 920 });
  const body = floating.body;
  const element = floating.element;
  if (element) element.classList.add('review-entry-window');
  if (!body) {
    console.error('Entry manager window missing body element');
    return floating;
  }
  body.classList.add('review-popup');
  body.classList.add('review-entry-body');
  body.innerHTML = '';

  const contextsMap = hierarchy?.contexts instanceof Map ? hierarchy.contexts : new Map();
  const allEntries = Array.isArray(hierarchy?.root?.entries) ? hierarchy.root.entries.slice() : [];
  const sorted = allEntries.slice().sort((a, b) => (a.due || 0) - (b.due || 0));

  const entriesByKey = new Map();
  const remainingKeys = new Set();
  sorted.forEach(entry => {
    const key = entryKey(entry);
    if (!key) return;
    entriesByKey.set(key, entry);
    remainingKeys.add(key);
  });

  const status = document.createElement('div');
  status.className = 'review-popup-status';

  const updateStatus = (message = '', variant = '') => {
    status.textContent = message;
    status.classList.remove('is-error', 'is-success');
    if (variant) {
      status.classList.add(variant === 'error' ? 'is-error' : 'is-success');
    }
  };

  const emptyState = document.createElement('div');
  emptyState.className = 'review-popup-empty';
  emptyState.textContent = 'No entries available.';
  emptyState.hidden = true;

  const layout = document.createElement('div');
  layout.className = 'review-entry-layout';
  body.appendChild(layout);

  const nav = document.createElement('nav');
  nav.className = 'review-entry-nav';
  layout.appendChild(nav);

  const navHeader = document.createElement('div');
  navHeader.className = 'review-entry-nav-header';
  navHeader.textContent = 'Quick nav';
  nav.appendChild(navHeader);

  const navList = document.createElement('div');
  navList.className = 'review-entry-nav-tree';
  nav.appendChild(navList);

  const content = document.createElement('div');
  content.className = 'review-entry-content';
  layout.appendChild(content);

  const controls = document.createElement('div');
  controls.className = 'review-popup-controls review-entry-controls';
  content.appendChild(controls);

  const filterLabel = document.createElement('div');
  filterLabel.className = 'review-entry-filter-label';
  controls.appendChild(filterLabel);

  const reviewFilteredBtn = document.createElement('button');
  reviewFilteredBtn.type = 'button';
  reviewFilteredBtn.className = 'btn';
  controls.appendChild(reviewFilteredBtn);

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'btn tertiary';
  selectAllBtn.textContent = 'Select all';
  controls.appendChild(selectAllBtn);

  const clearSelectionBtn = document.createElement('button');
  clearSelectionBtn.type = 'button';
  clearSelectionBtn.className = 'btn tertiary';
  clearSelectionBtn.textContent = 'Clear selection';
  controls.appendChild(clearSelectionBtn);

  const table = document.createElement('table');
  table.className = 'review-entry-table modern';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Select', 'Card', 'Part', 'Block', 'Week', 'Lecture', 'Stage', 'Due', 'Time', 'Actions'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const bodyRows = document.createElement('tbody');
  table.appendChild(bodyRows);
  const tableWrap = document.createElement('div');
  tableWrap.className = 'review-entry-table-wrap';
  tableWrap.appendChild(table);
  content.appendChild(tableWrap);
  content.appendChild(emptyState);
  content.appendChild(status);

  const selectionBar = document.createElement('div');
  selectionBar.className = 'review-selection-bar';
  selectionBar.hidden = true;
  const selectionInfo = document.createElement('div');
  selectionInfo.className = 'review-selection-info';
  selectionBar.appendChild(selectionInfo);

  const selectionControls = document.createElement('div');
  selectionControls.className = 'review-selection-actions';
  const suspendSelectedBtn = document.createElement('button');
  suspendSelectedBtn.type = 'button';
  suspendSelectedBtn.className = 'btn secondary';
  suspendSelectedBtn.textContent = 'Suspend selected';
  selectionControls.appendChild(suspendSelectedBtn);
  const retireSelectedBtn = document.createElement('button');
  retireSelectedBtn.type = 'button';
  retireSelectedBtn.className = 'btn danger';
  retireSelectedBtn.textContent = 'Retire selected';
  selectionControls.appendChild(retireSelectedBtn);
  selectionBar.appendChild(selectionControls);

  const selectionStatus = document.createElement('div');
  selectionStatus.className = 'review-selection-status';
  selectionBar.appendChild(selectionStatus);
  content.appendChild(selectionBar);

  const nodeCounts = new Map();
  const navCountElements = new Map();
  const navMetadata = new Map();
  const navGroupStates = new Map();

  const rootNodeKey = 'root';
  const blockNodeKey = blockId => `block:${blockId}`;
  const weekNodeKey = (blockId, weekId) => `week:${blockId}::${weekId}`;
  const lectureNodeKey = lectureKey => `lecture:${lectureKey}`;

  const setGroupExpanded = (nodeKey, expanded = true) => {
    const state = navGroupStates.get(nodeKey);
    if (!state) return;
    state.setExpanded(expanded);
  };

  const openGroup = nodeKey => setGroupExpanded(nodeKey, true);

  const clearGroupHighlights = () => {
    navGroupStates.forEach(state => {
      state.group.classList.remove('has-active');
    });
  };

  const markGroupActive = nodeKey => {
    const state = navGroupStates.get(nodeKey);
    if (!state) return;
    state.group.classList.add('has-active');
  };

  const adjustCount = (nodeKey, delta) => {
    const current = nodeCounts.get(nodeKey) || 0;
    const next = Math.max(0, current + delta);
    nodeCounts.set(nodeKey, next);
    const badge = navCountElements.get(nodeKey);
    if (badge) badge.textContent = String(next);
  };

  const getEntryContexts = entry => {
    const key = entryKey(entry);
    if (!key) return [];
    const ctx = contextsMap.get(key);
    if (Array.isArray(ctx) && ctx.length) return ctx;
    return [{
      blockId: UNASSIGNED_BLOCK,
      blockTitle: 'Unassigned block',
      weekId: UNASSIGNED_WEEK,
      weekLabel: 'Unassigned week',
      lectureKey: `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`,
      lectureTitle: 'Unassigned lecture'
    }];
  };

  sorted.forEach(entry => {
    const key = entryKey(entry);
    if (!key) return;
    adjustCount(rootNodeKey, 1);
    const contexts = getEntryContexts(entry);
    contexts.forEach(ctx => {
      adjustCount(blockNodeKey(ctx.blockId), 1);
      adjustCount(weekNodeKey(ctx.blockId, ctx.weekId), 1);
      adjustCount(lectureNodeKey(ctx.lectureKey), 1);
    });
  });

  const rootMeta = { scope: 'all', label: 'All due cards' };
  navMetadata.set(rootNodeKey, rootMeta);

  const selectedKeys = new Set();
  const rowsByKey = new Map();

  let cachedDurations = null;
  const ensureDurations = async () => {
    if (cachedDurations) return cachedDurations;
    cachedDurations = await getReviewDurations();
    return cachedDurations;
  };

  const handleEntryChange = async () => {
    if (typeof onChange === 'function') {
      try {
        await onChange();
      } catch (err) {
        console.error(err);
      }
    }
  };

  const matchesFilter = (entry, filter) => {
    if (!filter || filter.scope === 'all') return true;
    const contexts = getEntryContexts(entry);
    if (!contexts.length) return filter.scope === 'all';
    return contexts.some(ctx => {
      if (filter.scope === 'block') {
        return ctx.blockId === filter.blockId;
      }
      if (filter.scope === 'week') {
        return ctx.blockId === filter.blockId && ctx.weekId === filter.weekId;
      }
      if (filter.scope === 'lecture') {
        return ctx.lectureKey === filter.lectureKey;
      }
      return true;
    });
  };

  const listFilteredEntries = filter => sorted.filter(entry => {
    const key = entryKey(entry);
    if (!key || !remainingKeys.has(key)) return false;
    return matchesFilter(entry, filter);
  });

  const normalizeFilter = (input = {}) => {
    const scope = ['block', 'week', 'lecture'].includes(input.scope) ? input.scope : 'all';
    if (scope === 'block') {
      return { scope, blockId: input.blockId ?? UNASSIGNED_BLOCK };
    }
    if (scope === 'week') {
      const blockId = input.blockId ?? UNASSIGNED_BLOCK;
      const weekId = input.weekId ?? (input.week != null ? String(input.week) : UNASSIGNED_WEEK);
      return { scope, blockId, weekId };
    }
    if (scope === 'lecture') {
      const lectureKey = input.lectureKey || input.lectureId || input.lecture || `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`;
      return { scope, lectureKey, blockId: input.blockId ?? UNASSIGNED_BLOCK, weekId: input.weekId ?? (input.week != null ? String(input.week) : UNASSIGNED_WEEK) };
    }
    return { scope: 'all' };
  };

  const nodeKeyForFilter = filter => {
    if (!filter) return rootNodeKey;
    switch (filter.scope) {
      case 'block':
        return blockNodeKey(filter.blockId ?? UNASSIGNED_BLOCK);
      case 'week':
        return weekNodeKey(filter.blockId ?? UNASSIGNED_BLOCK, filter.weekId ?? UNASSIGNED_WEEK);
      case 'lecture':
        return lectureNodeKey(filter.lectureKey ?? `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`);
      default:
        return rootNodeKey;
    }
  };

  const initialFilter = (() => {
    if (focus && focus.scope) {
      return normalizeFilter(focus);
    }
    if (highlightEntryKey && entriesByKey.has(highlightEntryKey)) {
      const entry = entriesByKey.get(highlightEntryKey);
      const contexts = getEntryContexts(entry);
      if (contexts.length) {
        const ctx = contexts[0];
        return { scope: 'lecture', lectureKey: ctx.lectureKey, blockId: ctx.blockId, weekId: ctx.weekId };
      }
    }
    return { scope: 'all' };
  })();

  let currentFilter = initialFilter;
  let activeNodeKey = nodeKeyForFilter(currentFilter);
  let currentMetadata = navMetadata.get(activeNodeKey) || metadata || { scope: 'all', label: 'All due cards' };

  const setActiveNav = nodeKey => {
    const prev = navList.querySelector('.review-entry-nav-btn.is-active');
    if (prev) prev.classList.remove('is-active');
    const next = navList.querySelector(`.review-entry-nav-btn[data-node-key="${nodeKey}"]`);
    if (next) next.classList.add('is-active');

    clearGroupHighlights();
    const meta = navMetadata.get(nodeKey);
    if (meta && meta.blockId) {
      const blockKey = blockNodeKey(meta.blockId);
      openGroup(blockKey);
      markGroupActive(blockKey);
      if (meta.weekId) {
        const weekKey = weekNodeKey(meta.blockId, meta.weekId);
        openGroup(weekKey);
        markGroupActive(weekKey);
      }
    }
    if (next) {
      const parentGroup = next.closest('.review-entry-nav-group');
      if (parentGroup) parentGroup.classList.add('has-active');
    }
  };

  const updateFilterLabel = () => {
    filterLabel.textContent = currentMetadata?.label || 'All due cards';
  };

  const updateReviewButton = () => {
    const filtered = listFilteredEntries(currentFilter);
    reviewFilteredBtn.textContent = filtered.length ? `Start review (${filtered.length})` : 'Start review';
    reviewFilteredBtn.disabled = filtered.length === 0;
    selectAllBtn.disabled = filtered.length === 0;
  };

  const updateSelectionBar = () => {
    const count = selectedKeys.size;
    selectionBar.hidden = count === 0;
    selectionInfo.textContent = `${count} selected`;
    suspendSelectedBtn.disabled = count === 0;
    retireSelectedBtn.disabled = count === 0;
    if (count === 0) {
      selectionStatus.textContent = '';
      selectionStatus.classList.remove('is-error', 'is-success');
    }
  };

  const setSelectionStatus = (message = '', variant = '') => {
    selectionStatus.textContent = message;
    selectionStatus.classList.remove('is-error', 'is-success');
    if (variant) {
      selectionStatus.classList.add(variant === 'error' ? 'is-error' : 'is-success');
    }
  };

  const clearSelection = () => {
    selectedKeys.clear();
    rowsByKey.forEach(row => row.classList.remove('is-selected'));
    rowsByKey.forEach(row => {
      const checkbox = row.querySelector('.review-entry-checkbox');
      if (checkbox) checkbox.checked = false;
    });
    updateSelectionBar();
  };

  const removeEntry = entry => {
    const key = entryKey(entry);
    if (!key || !remainingKeys.has(key)) return;
    remainingKeys.delete(key);
    if (selectedKeys.has(key)) selectedKeys.delete(key);

    adjustCount(rootNodeKey, -1);
    const contexts = getEntryContexts(entry);
    contexts.forEach(ctx => {
      adjustCount(blockNodeKey(ctx.blockId), -1);
      adjustCount(weekNodeKey(ctx.blockId, ctx.weekId), -1);
      adjustCount(lectureNodeKey(ctx.lectureKey), -1);
    });

    rowsByKey.delete(key);
    updateSelectionBar();
  };

  let pendingHighlight = highlightEntryKey;

  const renderTable = () => {
    const filtered = listFilteredEntries(currentFilter);
    bodyRows.innerHTML = '';
    rowsByKey.clear();

    if (!filtered.length) {
      table.hidden = true;
      tableWrap.hidden = true;
      emptyState.hidden = false;
      return;
    }

    table.hidden = false;
    tableWrap.hidden = false;
    emptyState.hidden = true;

    filtered.forEach(entry => {
      const key = entryKey(entry);
      if (!key) return;
      const row = document.createElement('tr');
      row.className = 'review-entry-table-row';
      row.dataset.entryKey = key;

      const contexts = getEntryContexts(entry);
      const blockNames = Array.from(new Set(contexts.map(ctx => ctx.blockTitle))).join(', ');
      const weekNames = Array.from(new Set(contexts.map(ctx => ctx.weekLabel))).join(', ');
      const lectureNames = Array.from(new Set(contexts.map(ctx => ctx.lectureTitle))).join(', ');
      const accent = contexts.length ? (contexts[0]?.accent || null) : null;
      if (accent) {
        row.classList.add('has-accent');
        row.style.setProperty('--entry-accent', accent);
      }

      const selectCell = document.createElement('td');
      selectCell.className = 'review-entry-cell select';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'review-entry-checkbox';
      checkbox.checked = selectedKeys.has(key);
      checkbox.addEventListener('change', event => {
        if (event.target.checked) {
          selectedKeys.add(key);
          row.classList.add('is-selected');
        } else {
          selectedKeys.delete(key);
          row.classList.remove('is-selected');
        }
        updateSelectionBar();
      });
      selectCell.appendChild(checkbox);
      row.appendChild(selectCell);

      const titleCell = document.createElement('td');
      titleCell.className = 'review-entry-cell title';
      titleCell.textContent = titleOf(entry.item);
      row.appendChild(titleCell);

      const partCell = document.createElement('td');
      partCell.className = 'review-entry-cell part';
      partCell.textContent = getSectionLabel(entry.item, entry.sectionKey);
      row.appendChild(partCell);

      const blockCell = document.createElement('td');
      blockCell.className = 'review-entry-cell block';
      blockCell.textContent = blockNames || '—';
      row.appendChild(blockCell);

      const weekCell = document.createElement('td');
      weekCell.className = 'review-entry-cell week';
      weekCell.textContent = weekNames || '—';
      row.appendChild(weekCell);

      const lectureCell = document.createElement('td');
      lectureCell.className = 'review-entry-cell lecture';
      lectureCell.textContent = lectureNames || '—';
      row.appendChild(lectureCell);

      const phaseCell = document.createElement('td');
      phaseCell.className = 'review-entry-cell phase';
      const phaseLabel = describePhase(entry.phase);
      const interval = entry?.state?.interval;
      const intervalText = Number.isFinite(interval) && interval > 0 ? `Last interval • ${formatIntervalMinutes(interval)}` : '';
      phaseCell.textContent = intervalText ? `${phaseLabel || '—'} (${intervalText})` : (phaseLabel || '—');
      row.appendChild(phaseCell);

      const dueCell = document.createElement('td');
      dueCell.className = 'review-entry-cell due';
      dueCell.textContent = formatOverdue(entry.due, now);
      row.appendChild(dueCell);

      const timeCell = document.createElement('td');
      timeCell.className = 'review-entry-cell timestamp';
      timeCell.textContent = entry.due ? new Date(entry.due).toLocaleString() : '—';
      row.appendChild(timeCell);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'review-entry-cell actions';
      const actionGroup = document.createElement('div');
      actionGroup.className = 'review-entry-actions';

      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'btn tertiary';
      reviewBtn.textContent = 'Review';
      reviewBtn.addEventListener('click', () => {
        if (typeof startSession === 'function') {
          startSession(buildSessionPayload([entry]), {
            scope: 'single',
            label: `Focused review – ${titleOf(entry.item)}`
          });
        }
      });
      actionGroup.appendChild(reviewBtn);

      const suspendBtn = document.createElement('button');
      suspendBtn.type = 'button';
      suspendBtn.className = 'btn tertiary';
      suspendBtn.textContent = 'Suspend';
      suspendBtn.addEventListener('click', async () => {
        if (suspendBtn.disabled) return;
        suspendBtn.disabled = true;
        retireBtn.disabled = true;
        updateStatus('Suspending…');
        try {
          suspendSection(entry.item, entry.sectionKey, Date.now());
          await upsertItem(entry.item);
          updateStatus('Card suspended.', 'success');
          removeEntry(entry);
          renderTable();
          updateReviewButton();
          await handleEntryChange();
        } catch (err) {
          console.error('Failed to suspend entry', err);
          updateStatus('Failed to suspend card.', 'error');
          suspendBtn.disabled = false;
          retireBtn.disabled = false;
        }
      });
      actionGroup.appendChild(suspendBtn);

      const retireBtn = document.createElement('button');
      retireBtn.type = 'button';
      retireBtn.className = 'btn tertiary danger';
      retireBtn.textContent = 'Retire';
      retireBtn.addEventListener('click', async () => {
        if (retireBtn.disabled) return;
        retireBtn.disabled = true;
        suspendBtn.disabled = true;
        updateStatus('Retiring…');
        try {
          const steps = await ensureDurations();
          const nowTs = Date.now();
          rateSection(entry.item, entry.sectionKey, RETIRE_RATING, steps, nowTs);
          await upsertItem(entry.item);
          updateStatus('Card retired.', 'success');
          removeEntry(entry);
          renderTable();
          updateReviewButton();
          await handleEntryChange();
        } catch (err) {
          console.error('Failed to retire entry', err);
          updateStatus('Failed to retire card.', 'error');
          retireBtn.disabled = false;
          suspendBtn.disabled = false;
        }
      });
      actionGroup.appendChild(retireBtn);

      actionsCell.appendChild(actionGroup);
      row.appendChild(actionsCell);

      const toggleSelection = () => {
        if (selectedKeys.has(key)) {
          selectedKeys.delete(key);
          row.classList.remove('is-selected');
          checkbox.checked = false;
        } else {
          selectedKeys.add(key);
          row.classList.add('is-selected');
          checkbox.checked = true;
        }
        updateSelectionBar();
      };

      row.addEventListener('click', event => {
        if (event.target instanceof HTMLElement) {
          if (event.target.closest('button')) return;
          if (event.target.closest('input')) return;
        }
        toggleSelection();
      });

      let dragMode = null;
      const stopDrag = () => {
        dragMode = null;
        document.removeEventListener('pointerup', stopDrag);
      };

      row.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (event.target instanceof HTMLElement && event.target.closest('button')) return;
        if (event.target instanceof HTMLElement && event.target.closest('input')) return;
        dragMode = selectedKeys.has(key) ? 'deselect' : 'select';
        if (dragMode === 'select') {
          selectedKeys.add(key);
          row.classList.add('is-selected');
          checkbox.checked = true;
        } else {
          selectedKeys.delete(key);
          row.classList.remove('is-selected');
          checkbox.checked = false;
        }
        updateSelectionBar();
        document.addEventListener('pointerup', stopDrag);
      });

      row.addEventListener('pointerenter', () => {
        if (!dragMode) return;
        if (dragMode === 'select') {
          selectedKeys.add(key);
          row.classList.add('is-selected');
          checkbox.checked = true;
        } else {
          selectedKeys.delete(key);
          row.classList.remove('is-selected');
          checkbox.checked = false;
        }
        updateSelectionBar();
      });

      if (selectedKeys.has(key)) {
        row.classList.add('is-selected');
      }

      if (pendingHighlight && pendingHighlight === key) {
        row.classList.add('is-highlighted');
        queueMicrotask(() => {
          row.scrollIntoView({ block: 'nearest' });
        });
        pendingHighlight = null;
      }

      rowsByKey.set(key, row);
      bodyRows.appendChild(row);
    });

    updateSelectionBar();
  };

  const openPathForFilter = filter => {
    if (!filter) return;
    if (filter.scope === 'block') {
      const blockId = filter.blockId ?? UNASSIGNED_BLOCK;
      openGroup(blockNodeKey(blockId));
    } else if (filter.scope === 'week' || filter.scope === 'lecture') {
      const blockId = filter.blockId ?? UNASSIGNED_BLOCK;
      const weekId = filter.weekId ?? UNASSIGNED_WEEK;
      openGroup(blockNodeKey(blockId));
      openGroup(weekNodeKey(blockId, weekId));
    }
  };

  const setFilter = (filter, nodeKey) => {
    currentFilter = filter;
    activeNodeKey = nodeKey;
    currentMetadata = navMetadata.get(nodeKey) || metadata || { scope: 'all', label: 'All due cards' };
    openPathForFilter(filter);
    setActiveNav(nodeKey);
    updateFilterLabel();
    renderTable();
    updateReviewButton();
  };

  const createNavButton = ({ label, nodeKey, depth, filter, count, meta, accent, variant = 'leaf' }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `review-entry-nav-btn depth-${depth}`;
    button.dataset.nodeKey = nodeKey;
    if (variant === 'group') {
      button.classList.add('is-group');
    }
    if (accent) {
      button.dataset.accent = accent;
      button.style.setProperty('--nav-accent', accent);
    }
    const text = document.createElement('span');
    text.className = 'review-entry-nav-label';
    text.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'review-entry-nav-count';
    badge.textContent = String(count || 0);
    navCountElements.set(nodeKey, badge);
    navMetadata.set(nodeKey, meta);
    button.appendChild(text);
    button.appendChild(badge);
    button.addEventListener('click', () => {
      if (variant === 'group') {
        openGroup(nodeKey);
      }
      setFilter(filter, nodeKey);
    });
    return button;
  };

  const createNavGroup = ({ label, nodeKey, depth, filter, count, meta, accent, defaultOpen = false }) => {
    const group = document.createElement('div');
    group.className = `review-entry-nav-group depth-${depth}`;
    if (accent) {
      group.style.setProperty('--nav-accent', accent);
    }

    const header = document.createElement('div');
    header.className = 'review-entry-nav-group-header';
    group.appendChild(header);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'review-entry-nav-toggle';
    toggle.setAttribute('aria-label', `Toggle ${label}`);
    header.appendChild(toggle);

    const button = createNavButton({
      label,
      nodeKey,
      depth,
      filter,
      count,
      meta,
      accent,
      variant: 'group'
    });
    header.appendChild(button);

    const children = document.createElement('div');
    children.className = 'review-entry-nav-children';
    group.appendChild(children);

    const setExpanded = expanded => {
      if (expanded) {
        group.classList.add('is-open');
        children.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        toggle.innerHTML = '<span aria-hidden="true">▾</span>';
      } else {
        group.classList.remove('is-open');
        children.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = '<span aria-hidden="true">▸</span>';
      }
    };

    setExpanded(defaultOpen);

    toggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setExpanded(!group.classList.contains('is-open'));
    });

    navGroupStates.set(nodeKey, { group, children, toggle, setExpanded });

    return { group, children, button };
  };

  navList.appendChild(createNavButton({
    label: 'All cards',
    nodeKey: rootNodeKey,
    depth: 0,
    filter: { scope: 'all' },
    count: nodeCounts.get(rootNodeKey) || 0,
    meta: navMetadata.get(rootNodeKey)
  }));

  hierarchy.blocks.forEach((blockNode, blockIndex) => {
    const blockKey = blockNodeKey(blockNode.id);
    const blockMeta = { scope: 'block', label: `Block – ${blockNode.title}`, blockId: blockNode.id };
    const shouldOpenBlock = (() => {
      if (!initialFilter || initialFilter.scope === 'all') return blockIndex === 0;
      if (!['block', 'week', 'lecture'].includes(initialFilter.scope)) return blockIndex === 0;
      return (initialFilter.blockId ?? UNASSIGNED_BLOCK) === blockNode.id;
    })();
    const blockGroup = createNavGroup({
      label: blockNode.title,
      nodeKey: blockKey,
      depth: 1,
      filter: { scope: 'block', blockId: blockNode.id },
      count: nodeCounts.get(blockKey) || 0,
      meta: blockMeta,
      accent: blockNode.accent,
      defaultOpen: shouldOpenBlock
    });
    navList.appendChild(blockGroup.group);

    blockNode.weeks.forEach(weekNode => {
      const weekKey = weekNodeKey(blockNode.id, weekNode.id);
      const weekLabel = weekNode.weekNumber != null ? `Week ${weekNode.weekNumber}` : weekNode.label;
      const weekMeta = {
        scope: 'week',
        label: `${weekLabel} – ${blockNode.title}`,
        blockId: blockNode.id,
        weekId: weekNode.id
      };
      const shouldOpenWeek = (() => {
        if (!initialFilter) return false;
        if (!['week', 'lecture'].includes(initialFilter.scope)) return false;
        const blockMatch = (initialFilter.blockId ?? UNASSIGNED_BLOCK) === blockNode.id;
        const weekMatch = (initialFilter.weekId ?? UNASSIGNED_WEEK) === weekNode.id;
        return blockMatch && weekMatch;
      })();
      const weekGroup = createNavGroup({
        label: weekLabel,
        nodeKey: weekKey,
        depth: 2,
        filter: { scope: 'week', blockId: blockNode.id, weekId: weekNode.id },
        count: nodeCounts.get(weekKey) || 0,
        meta: weekMeta,
        accent: weekNode.accent,
        defaultOpen: shouldOpenWeek
      });
      blockGroup.children.appendChild(weekGroup.group);

      const lectureList = document.createElement('div');
      lectureList.className = 'review-entry-nav-leaves';
      weekGroup.children.appendChild(lectureList);

      weekNode.lectures.forEach(lectureNode => {
        const lectureKey = lectureNodeKey(lectureNode.id);
        const lectureMeta = {
          scope: 'lecture',
          label: `${lectureNode.title} – ${blockNode.title}`,
          lectureKey: lectureNode.id,
          blockId: blockNode.id,
          weekId: weekNode.id
        };
        lectureList.appendChild(createNavButton({
          label: lectureNode.title,
          nodeKey: lectureKey,
          depth: 3,
          filter: { scope: 'lecture', lectureKey: lectureNode.id, blockId: blockNode.id, weekId: weekNode.id },
          count: nodeCounts.get(lectureKey) || 0,
          meta: lectureMeta,
          accent: lectureNode.accent
        }));
      });
    });
  });

  setFilter(currentFilter, activeNodeKey);
  if (metadata && typeof metadata === 'object') {
    currentMetadata = metadata;
    updateFilterLabel();
    updateReviewButton();
  }

  reviewFilteredBtn.addEventListener('click', () => {
    const filtered = listFilteredEntries(currentFilter);
    if (!filtered.length || typeof startSession !== 'function') return;
    startSession(buildSessionPayload(filtered), currentMetadata || {});
  });

  selectAllBtn.addEventListener('click', () => {
    const filtered = listFilteredEntries(currentFilter);
    filtered.forEach(entry => {
      const key = entryKey(entry);
      if (!key) return;
      selectedKeys.add(key);
      const row = rowsByKey.get(key);
      if (row) {
        row.classList.add('is-selected');
        const checkbox = row.querySelector('.review-entry-checkbox');
        if (checkbox) checkbox.checked = true;
      }
    });
    updateSelectionBar();
  });

  clearSelectionBtn.addEventListener('click', () => {
    clearSelection();
  });

  const bulkSuspend = async keys => {
    if (!keys.length) return;
    selectionBar.classList.add('is-busy');
    setSelectionStatus('Suspending…');
    try {
      for (const key of keys) {
        const entry = entriesByKey.get(key);
        if (!entry) continue;
        suspendSection(entry.item, entry.sectionKey, Date.now());
        await upsertItem(entry.item);
        removeEntry(entry);
      }
      renderTable();
      updateReviewButton();
      clearSelection();
      setSelectionStatus('Cards suspended.', 'success');
      await handleEntryChange();
    } catch (err) {
      console.error('Failed to suspend cards', err);
      setSelectionStatus('Failed to suspend cards.', 'error');
    } finally {
      selectionBar.classList.remove('is-busy');
    }
  };

  const bulkRetire = async keys => {
    if (!keys.length) return;
    selectionBar.classList.add('is-busy');
    setSelectionStatus('Retiring…');
    try {
      const steps = await ensureDurations();
      for (const key of keys) {
        const entry = entriesByKey.get(key);
        if (!entry) continue;
        rateSection(entry.item, entry.sectionKey, RETIRE_RATING, steps, Date.now());
        await upsertItem(entry.item);
        removeEntry(entry);
      }
      renderTable();
      updateReviewButton();
      clearSelection();
      setSelectionStatus('Cards retired.', 'success');
      await handleEntryChange();
    } catch (err) {
      console.error('Failed to retire cards', err);
      setSelectionStatus('Failed to retire cards.', 'error');
    } finally {
      selectionBar.classList.remove('is-busy');
    }
  };

  suspendSelectedBtn.addEventListener('click', () => {
    bulkSuspend(Array.from(selectedKeys));
  });

  retireSelectedBtn.addEventListener('click', () => {
    bulkRetire(Array.from(selectedKeys));
  });

  return floating;
}


function renderHierarchy(container, hierarchy, { startSession, now, redraw }) {
  if (!hierarchy.root.entries.length) {
    renderEmptyState(container);
    return;
  }

  const tree = document.createElement('div');
  tree.className = 'review-tree';
  container.appendChild(tree);

  const refresh = () => {
    if (typeof redraw === 'function') redraw();
  };

  const allMeta = { scope: 'all', label: 'All due cards' };
  const allNode = createCollapsibleNode({
    level: 0,
    title: 'All cards',
    count: hierarchy.root.entries.length,
    reviewLabel: 'Review all',
    onReview: () => startSession(buildSessionPayload(hierarchy.root.entries), allMeta),
    onMenu: () => openEntryManager(hierarchy, {
      title: 'All due cards',
      now,
      startSession,
      metadata: allMeta,
      focus: { scope: 'all' },
      onChange: refresh
    }),
    defaultOpen: true
  });

  tree.appendChild(allNode.element);

  const blockList = document.createElement('div');
  blockList.className = 'review-tree-children';
  allNode.content.appendChild(blockList);

  hierarchy.blocks.forEach(blockNode => {
    const blockMeta = {
      scope: 'block',
      label: `Block – ${blockNode.title}`,
      blockId: blockNode.id
    };
    const block = createCollapsibleNode({
      level: 1,
      title: blockNode.title,
      count: blockNode.entries.length,
      reviewLabel: 'Review block',
      onReview: () => startSession(buildSessionPayload(blockNode.entries), blockMeta),
      onMenu: () => openEntryManager(hierarchy, {
        title: `${blockNode.title} — cards`,
        now,
        startSession,
        metadata: blockMeta,
        focus: { scope: 'block', blockId: blockNode.id },
        onChange: refresh
      }),
      accent: blockNode.accent
    });
    blockList.appendChild(block.element);

    const weekList = document.createElement('div');
    weekList.className = 'review-tree-children';
    block.content.appendChild(weekList);

    blockNode.weeks.forEach(weekNode => {
      const weekTitle = weekNode.weekNumber != null ? `Week ${weekNode.weekNumber}` : 'Unassigned week';
      const weekMeta = {
        scope: 'week',
        label: `${weekTitle} – ${blockNode.title}`,
        blockId: blockNode.id,
        week: weekNode.weekNumber,
        weekId: weekNode.id
      };
      const week = createCollapsibleNode({
        level: 2,
        title: weekTitle,
        count: weekNode.entries.length,
        reviewLabel: 'Review week',
        onReview: () => startSession(buildSessionPayload(weekNode.entries), weekMeta),
        onMenu: () => openEntryManager(hierarchy, {
          title: `${blockNode.title} • ${weekTitle}`,
          now,
          startSession,
          metadata: weekMeta,
          focus: { scope: 'week', blockId: blockNode.id, weekId: weekNode.id },
          onChange: refresh
        }),
        accent: weekNode.accent
      });
      weekList.appendChild(week.element);

      const lectureList = document.createElement('div');
      lectureList.className = 'review-lecture-list';
      week.content.appendChild(lectureList);

      weekNode.lectures.forEach(lectureNode => {
        const lectureRow = document.createElement('div');
        lectureRow.className = 'review-lecture-row';
        if (lectureNode.accent) {
          lectureRow.classList.add('has-accent');
          lectureRow.style.setProperty('--review-accent', lectureNode.accent);
        }
        const info = document.createElement('div');
        info.className = 'review-lecture-info';
        const titleEl = document.createElement('div');
        titleEl.className = 'review-lecture-title';
        titleEl.textContent = lectureNode.title;
        info.appendChild(titleEl);
        const countEl = document.createElement('div');
        countEl.className = 'review-lecture-count';
        countEl.textContent = `${lectureNode.entries.length} card${lectureNode.entries.length === 1 ? '' : 's'}`;
        info.appendChild(countEl);
        lectureRow.appendChild(info);

        const lectureMeta = {
          scope: 'lecture',
          label: `${lectureNode.title} – ${blockNode.title}`,
          lectureId: lectureNode.id,
          lectureKey: lectureNode.id,
          blockId: blockNode.id,
          week: lectureNode.weekNumber,
          weekId: weekNode.id
        };
        const actions = createNodeActions({
          count: lectureNode.entries.length,
          reviewLabel: 'Review lecture',
          onReview: () => startSession(buildSessionPayload(lectureNode.entries), lectureMeta),
          onMenu: () => openEntryManager(hierarchy, {
            title: `${blockNode.title} • ${weekTitle} • ${lectureNode.title}`,
            now,
            startSession,
            metadata: lectureMeta,
            focus: { scope: 'lecture', lectureKey: lectureNode.id, blockId: blockNode.id, weekId: weekNode.id },
            onChange: refresh
          })
        });
        actions.classList.add('review-lecture-actions');
        lectureRow.appendChild(actions);

        lectureList.appendChild(lectureRow);
      });
    });
  });
}
export async function renderReview(root, redraw) {
  root.innerHTML = '';
  await hydrateStudySessions().catch(err => console.error('Failed to load saved sessions', err));

  const cohort = await loadReviewSourceItems();
  if (!Array.isArray(cohort) || !cohort.length) {
    const empty = document.createElement('div');
    empty.className = 'review-empty';
    empty.textContent = 'Add study cards to start building a review queue.';
    root.appendChild(empty);
    return;
  }
  setCohort(cohort);

  const now = Date.now();
  const dueEntries = collectDueSections(cohort, { now });
  const upcomingEntries = collectUpcomingSections(cohort, { now, limit: 50 });
  const { blocks } = await loadBlockCatalog();
  const blockTitles = ensureBlockTitleMap(blocks);
  const blockAccents = ensureBlockAccentMap(blocks);

  const savedEntry = getStudySessionEntry('review');


  const wrapper = document.createElement('section');
  wrapper.className = 'card review-panel';

  const backRow = document.createElement('div');
  backRow.className = 'review-back-row';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn secondary';
  backBtn.textContent = 'Back to study';
  backBtn.addEventListener('click', () => {
    setSubtab('Study', 'Builder');
    redraw();

  });
  backRow.appendChild(backBtn);
  wrapper.appendChild(backRow);

  const heading = document.createElement('h2');
  heading.textContent = 'Review queue';
  wrapper.appendChild(heading);

  const summary = document.createElement('div');
  summary.className = 'review-summary';
  summary.textContent = `Cards due: ${dueEntries.length} • Upcoming: ${upcomingEntries.length}`;
  wrapper.appendChild(summary);

  if (savedEntry?.session) {
    const resumeRow = document.createElement('div');
    resumeRow.className = 'review-resume-row';
    const resumeLabel = document.createElement('div');
    resumeLabel.className = 'review-resume-label';
    resumeLabel.textContent = savedEntry.metadata?.label || 'Saved review session available';
    resumeRow.appendChild(resumeLabel);
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'btn';
    resumeBtn.textContent = 'Resume';
    resumeBtn.addEventListener('click', async () => {
      await removeStudySession('review').catch(err => console.warn('Failed to clear saved review entry', err));
      const restored = Array.isArray(savedEntry.cohort) ? savedEntry.cohort : null;
      if (restored) {
        setCohort(restored);
      }
      setFlashSession(savedEntry.session);
      redraw();
    });
    resumeRow.appendChild(resumeBtn);
    wrapper.appendChild(resumeRow);
  }

  const body = document.createElement('div');
  body.className = 'review-body';
  wrapper.appendChild(body);


  const startSession = async (pool, metadata = {}) => {
    if (!pool.length) return;
    await removeStudySession('review').catch(err => console.warn('Failed to discard existing review save', err));
    setFlashSession({ idx: 0, pool, ratings: {}, mode: 'review', metadata });

    redraw();
  };

  if (dueEntries.length) {
    const hierarchy = buildReviewHierarchy(dueEntries, blocks, blockTitles, blockAccents);
    renderHierarchy(body, hierarchy, { startSession, now, redraw });
  } else {
    renderEmptyState(body);
  }

  if (upcomingEntries.length) {
    renderUpcomingSection(body, upcomingEntries, now, startSession);
  }

  root.appendChild(wrapper);
}
