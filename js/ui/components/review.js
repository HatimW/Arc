
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

function ensureBlockTitleMap(blocks) {
  if (blockTitleCache) return blockTitleCache;
  const map = new Map();
  blocks.forEach(block => {
    if (!block || !block.blockId) return;
    map.set(block.blockId, block.title || block.blockId);

  });
  blockTitleCache = map;
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

function resolveEntryRefs(entry, blockTitles) {
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
      const lectureLabel = lec.name ? lec.name : (lectureId !== UNASSIGNED_LECTURE ? `Lecture ${lectureId}` : 'Unassigned lecture');
      const weekLabel = weekNumber != null ? `Week ${weekNumber}` : 'Unassigned week';
      const lectureKey = `${blockId || UNASSIGNED_BLOCK}::${lectureId}`;
      const dedupKey = `${blockId || UNASSIGNED_BLOCK}::${weekId}::${lectureKey}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      results.push({
        blockId: blockId || UNASSIGNED_BLOCK,
        blockTitle,
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

function buildReviewHierarchy(entries, blocks, blockTitles) {
  const order = createBlockOrder(blocks);
  const root = {
    id: 'all',
    title: 'All cards',
    blocks: new Map(),
    entryMap: new Map()
  };

  const blockMap = root.blocks;
  entries.forEach(entry => {
    registerEntry(root, entry);
    const refs = resolveEntryRefs(entry, blockTitles);
    refs.forEach(ref => {
      const blockId = ref.blockId || UNASSIGNED_BLOCK;
      let blockNode = blockMap.get(blockId);
      if (!blockNode) {
        blockNode = {
          id: blockId,
          title: ref.blockTitle,
          order: order.has(blockId) ? order.get(blockId) : Number.MAX_SAFE_INTEGER,
          weeks: new Map(),
          entryMap: new Map()
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
          entryMap: new Map()
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
          entryMap: new Map()
        };
        weekNode.lectures.set(lectureKey, lectureNode);
      }
      registerEntry(lectureNode, entry);
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
    blocks: blocksList
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
  defaultOpen = false
}) {
  const details = document.createElement('details');
  details.className = `review-node review-node-level-${level}`;
  if (defaultOpen) details.open = true;

  const summary = document.createElement('summary');
  summary.className = 'review-node-summary';

  const header = document.createElement('div');
  header.className = 'review-node-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'review-node-title';
  titleEl.textContent = title;
  const countEl = document.createElement('span');
  countEl.className = 'review-node-count';
  countEl.textContent = `${count} card${count === 1 ? '' : 's'}`;
  header.appendChild(titleEl);
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

function openEntryMenu(entries, {
  title = 'Entries',
  now = Date.now(),
  startSession,
  metadata = {},
  onChange
} = {}) {
  const normalized = Array.isArray(entries) ? entries.slice() : [];
  const sorted = normalized.slice().sort((a, b) => (a.due || 0) - (b.due || 0));
  const win = createFloatingWindow({ title, width: 720 });
  const body = win.querySelector('.floating-body');
  body.classList.add('review-popup');

  let remainingEntries = sorted;

  const status = document.createElement('div');
  status.className = 'review-popup-status';

  const updateStatus = (message = '', variant = '') => {
    status.textContent = message;
    status.classList.remove('is-error', 'is-success');
    if (variant) {
      status.classList.add(variant === 'error' ? 'is-error' : 'is-success');
    }
  };

  const controls = document.createElement('div');
  controls.className = 'review-popup-controls';
  const reviewAllBtn = document.createElement('button');
  reviewAllBtn.type = 'button';
  reviewAllBtn.className = 'btn';
  const updateReviewAllLabel = () => {
    reviewAllBtn.textContent = `Review (${remainingEntries.length})`;
    reviewAllBtn.disabled = remainingEntries.length === 0;
  };
  updateReviewAllLabel();
  reviewAllBtn.addEventListener('click', () => {
    if (!remainingEntries.length) return;
    if (typeof startSession === 'function') {
      startSession(buildSessionPayload(remainingEntries), metadata || {});
    }
  });
  controls.appendChild(reviewAllBtn);
  body.appendChild(controls);

  const table = document.createElement('table');
  table.className = 'review-entry-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Card', 'Section', 'Due', 'Phase', 'Actions'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const bodyRows = document.createElement('tbody');
  table.appendChild(bodyRows);
  body.appendChild(table);
  body.appendChild(status);

  const rowsByKey = new Map();

  const removeEntry = entry => {
    const key = entryKey(entry);
    if (!key) return;
    remainingEntries = remainingEntries.filter(item => entryKey(item) !== key);
    const row = rowsByKey.get(key);
    if (row) {
      row.classList.add('is-removed');
      setTimeout(() => {
        row.remove();
      }, 160);
      rowsByKey.delete(key);
    }
    updateReviewAllLabel();
  };

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

  sorted.forEach(entry => {
    const key = entryKey(entry);
    const row = document.createElement('tr');
    row.className = 'review-entry-table-row';

    const titleCell = document.createElement('td');
    titleCell.className = 'review-entry-cell title';
    titleCell.textContent = titleOf(entry.item);
    row.appendChild(titleCell);

    const sectionCell = document.createElement('td');
    sectionCell.className = 'review-entry-cell section';
    sectionCell.textContent = getSectionLabel(entry.item, entry.sectionKey);
    row.appendChild(sectionCell);

    const dueCell = document.createElement('td');
    dueCell.className = 'review-entry-cell due';
    dueCell.textContent = formatOverdue(entry.due, now);
    row.appendChild(dueCell);

    const phaseCell = document.createElement('td');
    phaseCell.className = 'review-entry-cell phase';
    const phaseLabel = describePhase(entry.phase);
    const interval = entry?.state?.interval;
    let phaseText = phaseLabel;
    if (Number.isFinite(interval) && interval > 0) {
      const intervalText = `Last interval • ${formatIntervalMinutes(interval)}`;
      phaseText = phaseText ? `${phaseText}
${intervalText}` : intervalText;
    }
    phaseCell.textContent = phaseText || '—';
    row.appendChild(phaseCell);

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
        const nowTs = Date.now();
        suspendSection(entry.item, entry.sectionKey, nowTs);
        await upsertItem(entry.item);
        updateStatus('Card suspended.', 'success');
        removeEntry(entry);
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

    bodyRows.appendChild(row);
    if (key) rowsByKey.set(key, row);
  });

  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'review-popup-empty';
    empty.textContent = 'No entries available.';
    body.insertBefore(empty, controls.nextSibling);
    table.hidden = true;
  }

  return win;
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
    onMenu: () => openEntryMenu(hierarchy.root.entries, {
      title: 'All due cards',
      now,
      startSession,
      metadata: allMeta,
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
      onMenu: () => openEntryMenu(blockNode.entries, {
        title: `${blockNode.title} — cards`,
        now,
        startSession,
        metadata: blockMeta,
        onChange: refresh
      })
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
        week: weekNode.weekNumber
      };
      const week = createCollapsibleNode({
        level: 2,
        title: weekTitle,
        count: weekNode.entries.length,
        reviewLabel: 'Review week',
        onReview: () => startSession(buildSessionPayload(weekNode.entries), weekMeta),
        onMenu: () => openEntryMenu(weekNode.entries, {
          title: `${blockNode.title} • ${weekTitle}`,
          now,
          startSession,
          metadata: weekMeta,
          onChange: refresh
        })
      });
      weekList.appendChild(week.element);

      const lectureList = document.createElement('div');
      lectureList.className = 'review-lecture-list';
      week.content.appendChild(lectureList);

      weekNode.lectures.forEach(lectureNode => {
        const lectureRow = document.createElement('div');
        lectureRow.className = 'review-lecture-row';
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
          blockId: blockNode.id,
          week: lectureNode.weekNumber
        };
        const actions = createNodeActions({
          count: lectureNode.entries.length,
          reviewLabel: 'Review lecture',
          onReview: () => startSession(buildSessionPayload(lectureNode.entries), lectureMeta),
          onMenu: () => openEntryMenu(lectureNode.entries, {
            title: `${blockNode.title} • ${weekTitle} • ${lectureNode.title}`,
            now,
            startSession,
            metadata: lectureMeta,
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
    const hierarchy = buildReviewHierarchy(dueEntries, blocks, blockTitles);
    renderHierarchy(body, hierarchy, { startSession, now, redraw });
  } else {
    renderEmptyState(body);
  }

  if (upcomingEntries.length) {
    renderUpcomingSection(body, upcomingEntries, now, startSession);
  }

  root.appendChild(wrapper);
}
