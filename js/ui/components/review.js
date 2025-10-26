
import { setFlashSession, setSubtab, setCohort } from '../../state.js';
import { collectDueSections, collectUpcomingSections } from '../../review/scheduler.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { getSectionLabel } from './section-utils.js';
import { hydrateStudySessions, getStudySessionEntry, removeStudySession } from '../../study/study-sessions.js';
import { loadReviewSourceItems } from '../../review/pool.js';
import {
  ensureBlockTitleMap,
  titleOf,
  formatOverdue,
  formatTimeUntil,
  formatIntervalMinutes,
  entryKey,
  describePhase,
  buildSessionPayload,
  buildReviewHierarchy
} from '../../review/view-model.js';
import { openReviewEntryMenu } from './review-menu.js';

function renderEmptyState(container) {
  const empty = document.createElement('div');
  empty.className = 'review-empty';
  empty.textContent = 'No cards are due right now. Nice work!';
  container.appendChild(empty);
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

function renderHierarchy(container, hierarchy, blockTitleMap, { startSession, now, redraw }) {
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
    onMenu: () => openReviewEntryMenu({
      hierarchy,
      blockTitleMap,
      now,
      startSession,
      onChange: refresh,
      focus: { type: 'all' },
      title: 'All due cards'
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
      onMenu: () => openReviewEntryMenu({
        hierarchy,
        blockTitleMap,
        now,
        startSession,
        onChange: refresh,
        focus: { type: 'block', blockId: blockNode.id },
        title: `${blockNode.title} — cards`
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
        onMenu: () => openReviewEntryMenu({
          hierarchy,
          blockTitleMap,
          now,
          startSession,
          onChange: refresh,
          focus: { type: 'week', blockId: blockNode.id, weekId: weekNode.id },
          title: `${blockNode.title} • ${weekTitle}`
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
          onMenu: () => openReviewEntryMenu({
            hierarchy,
            blockTitleMap,
            now,
            startSession,
            onChange: refresh,
            focus: {
              type: 'lecture',
              blockId: blockNode.id,
              weekId: weekNode.id,
              lectureId: lectureNode.id
            },
            title: `${blockNode.title} • ${weekTitle} • ${lectureNode.title}`
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
    renderHierarchy(body, hierarchy, blockTitles, { startSession, now, redraw });
  } else {
    renderEmptyState(body);
  }

  if (upcomingEntries.length) {
    renderUpcomingSection(body, upcomingEntries, now, startSession);
  }

  root.appendChild(wrapper);
}
