
import { setFlashSession, setSubtab, setCohort } from '../../state.js';
import {
  collectDueSections,
  collectUpcomingSections
} from '../../review/scheduler.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { getSectionLabel } from './section-utils.js';
import { hydrateStudySessions, getStudySessionEntry, removeStudySession } from '../../study/study-sessions.js';
import { loadReviewSourceItems } from '../../review/pool.js';
import { openReviewMenu, buildSessionPayload } from './review-menu.js';
import { createBlockTitleMap, resolveSectionContexts, UNASSIGNED_BLOCK, UNASSIGNED_WEEK, UNASSIGNED_LECTURE } from '../../review/context.js';


let blockTitleCache = null;

function ensureBlockTitleMap(blocks) {
  blockTitleCache = createBlockTitleMap(blocks);
  return blockTitleCache;
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

function renderEmptyState(container) {
  const empty = document.createElement('div');
  empty.className = 'review-empty';
  empty.textContent = 'No cards are due right now. Nice work!';
  container.appendChild(empty);
}


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

export function buildReviewHierarchy(entries, blocks, blockTitles) {
  const order = createBlockOrder(blocks);
  const root = {
    id: 'all',
    title: 'All cards',
    blocks: new Map(),
    entryMap: new Map(),
    nodeId: 'root',
    type: 'root',
    parent: null,
    children: []
  };

  const blockMap = root.blocks;
  entries.forEach(entry => {
    registerEntry(root, entry);
    const contexts = resolveSectionContexts(entry.item, blockTitles);
    entry.contexts = contexts;
    entry.primaryContext = contexts && contexts.length ? contexts[0] : null;
    contexts.forEach(ref => {
      const blockId = ref.blockId || UNASSIGNED_BLOCK;
      let blockNode = blockMap.get(blockId);
      if (!blockNode) {
        blockNode = {
          id: blockId,
          title: ref.blockTitle,
          order: order.has(blockId) ? order.get(blockId) : Number.MAX_SAFE_INTEGER,
          weeks: new Map(),
          entryMap: new Map(),
          blockId,
          blockTitle: ref.blockTitle,
          nodeId: `block:${blockId}`,
          type: 'block',
          parent: root
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
          title: ref.weekLabel,
          weekNumber: ref.weekNumber,
          lectures: new Map(),
          entryMap: new Map(),
          blockTitle: ref.blockTitle,
          nodeId: `${blockNode.nodeId}|week:${weekKey}`,
          type: 'week',
          parent: blockNode
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
          blockTitle: ref.blockTitle,
          weekLabel: ref.weekLabel,
          nodeId: `${weekNode.nodeId}|lecture:${lectureKey}`,
          type: 'lecture',
          parent: weekNode
        };
        weekNode.lectures.set(lectureKey, lectureNode);
      }
      registerEntry(lectureNode, entry);
    });
  });

  const blocksList = Array.from(blockMap.values());
  blocksList.forEach(blockNode => {
    blockNode.children = [];
    const weekList = Array.from(blockNode.weeks.values());
    weekList.forEach(weekNode => {
      weekNode.children = [];
      const lectureList = Array.from(weekNode.lectures.values());
      lectureList.forEach(lectureNode => finalizeEntries(lectureNode));
      lectureList.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      lectureList.forEach(lectureNode => {
        lectureNode.children = [];
      });
      weekNode.lectures = lectureList;
      weekNode.children = lectureList;
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
    blockNode.children = weekList;
    finalizeEntries(blockNode);
  });

  blocksList.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });

  finalizeEntries(root);
  root.children = blocksList;

  return {
    root,
    blocks: blocksList,
    blockTitles
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
    onMenu: () => openReviewMenu(hierarchy, {
      title: 'All due cards',
      now,
      startSession,
      focus: { type: 'root' },
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
      onMenu: () => openReviewMenu(hierarchy, {
        title: `${blockNode.title} — cards`,
        now,
        startSession,
        focus: { type: 'block', blockId: blockNode.id },
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
        onMenu: () => openReviewMenu(hierarchy, {
          title: `${blockNode.title} • ${weekTitle}`,
          now,
          startSession,
          focus: { type: 'week', blockId: blockNode.id, weekId: weekNode.id },
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
          onMenu: () => openReviewMenu(hierarchy, {
            title: `${blockNode.title} • ${weekTitle} • ${lectureNode.title}`,
            now,
            startSession,
            focus: {
              type: 'lecture',
              blockId: blockNode.id,
              weekId: weekNode.id,
              lectureId: lectureNode.lectureId,
              lectureKey: lectureNode.id
            },
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
