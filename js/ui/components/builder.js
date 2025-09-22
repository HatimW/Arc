import { state, setBuilder, setCohort, resetBlockMode, setBlockMode, setSubtab, setFlashSession, setQuizSession, setStudySelectedMode, setTab } from '../../state.js';
import { listItemsByKind } from '../../storage/storage.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { setToggleState } from '../../utils.js';
import { hydrateStudySessions, getStudySessionEntry, removeAllStudySessions, removeStudySession } from '../../study/study-sessions.js';

import { collectDueSections } from '../../review/scheduler.js';
import { loadReviewSourceItems } from '../../review/pool.js';


const MODE_KEY = {
  Flashcards: 'flashcards',
  Quiz: 'quiz',
  Blocks: 'blocks'
};


let lectureSource = {};
let builderBlockOrder = [];
let builderWeekMap = new Map();

function setLectureSource(map) {
  lectureSource = {};
  for (const [blockId, list] of Object.entries(map || {})) {
    lectureSource[blockId] = Array.isArray(list)
      ? list.map(lecture => ({ ...lecture }))
      : [];
  }
}

function lectureListFor(blockId, options = {}) {
  const list = lectureSource[blockId];
  if (!Array.isArray(list)) return [];
  if (options.clone === false) return list;
  return list.map(lecture => ({ ...lecture }));
}


function collectReviewCount(items) {
  try {
    return collectDueSections(items, { now: Date.now() }).length;
  } catch (err) {
    console.warn('Failed to calculate review queue size', err);
    return 0;
  }
}


function notifyBuilderChanged() {
  removeAllStudySessions().catch(err => console.warn('Failed to clear saved sessions', err));
}

export async function renderBuilder(root, redraw) {
  const [blocks] = await Promise.all([
    loadBlocks(),
    hydrateStudySessions().catch(err => {
      console.error('Unable to load study sessions', err);
      return null;
    })
  ]);
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'builder';
  root.appendChild(wrap);
  drawBuilder(wrap, blocks, redraw);
}

async function loadBlocks() {
  const catalog = await loadBlockCatalog();
  const lectureLists = { ...catalog.lectureLists };
  catalog.blocks.forEach(block => {
    if (!Array.isArray(lectureLists[block.blockId])) {
      lectureLists[block.blockId] = [];
    }
  });
  lectureLists.__unlabeled = [];
  setLectureSource(lectureLists);
  const blocks = catalog.blocks.map(block => ({ ...block }));
  blocks.push({ blockId: '__unlabeled', title: 'Unlabeled', weeks: 0 });
  return blocks;
}

function drawBuilder(container, blocks, redraw) {
  container.innerHTML = '';
  if (state.builder.weeks.length) {
    setBuilder({ weeks: [] });
  }
  const rerender = () => drawBuilder(container, blocks, redraw);

  const contexts = blocks.map(block => {
    const blockId = block.blockId;
    const lectures = lectureListFor(blockId);
    lectures.sort((a, b) => {
      const weekDiff = (a.week ?? 0) - (b.week ?? 0);
      if (weekDiff !== 0) return weekDiff;
      return (a.name || '').localeCompare(b.name || '');
    });
    const weeks = groupByWeek(lectures);
    return { block, lectures, weeks };
  });

  builderBlockOrder = contexts.map(ctx => ctx.block.blockId);
  builderWeekMap = new Map();
  contexts.forEach(ctx => {
    const blockId = ctx.block.blockId;
    const entries = ctx.weeks.map(({ week }) => ({
      key: weekKeyFor(blockId, week),
      week
    }));
    builderWeekMap.set(blockId, entries);
  });

  const activeBlockId = ensureActiveBlock(contexts);
  ensureWeekForBlock(activeBlockId);

  const layout = document.createElement('div');
  layout.className = 'builder-layout';
  container.appendChild(layout);

  const blockColumn = document.createElement('div');
  blockColumn.className = 'builder-blocks';
  layout.appendChild(blockColumn);
  contexts.forEach(context => {
    blockColumn.appendChild(renderBlockPanel(context, rerender));
  });

  const controls = renderControls(rerender, redraw);
  layout.appendChild(controls);
}

function ensureActiveBlock(contexts) {
  if (!Array.isArray(contexts) || !contexts.length) {
    if (
      state.builder.activeBlockId ||
      (state.builder.collapsedBlocks && state.builder.collapsedBlocks.length) ||
      state.builder.activeWeekKey ||
      (state.builder.collapsedWeeks && state.builder.collapsedWeeks.length)
    ) {
      setBuilder({ activeBlockId: '', collapsedBlocks: [], activeWeekKey: '', collapsedWeeks: [] });
    }
    return '';
  }
  const blockIds = builderBlockOrder;
  let activeBlockId = state.builder.activeBlockId;
  if (!activeBlockId || !blockIds.includes(activeBlockId)) {
    activeBlockId = chooseDefaultBlock(contexts);
  }
  if (!activeBlockId && blockIds.length) {
    activeBlockId = blockIds[0];
  }
  setActiveBlock(activeBlockId);
  return activeBlockId;
}

function chooseDefaultBlock(contexts) {
  const lectureSelections = Array.isArray(state.builder.lectures) ? state.builder.lectures : [];
  if (lectureSelections.length) {
    const last = lectureSelections[lectureSelections.length - 1];
    const [blockId] = last.split('|');
    if (blockId && builderBlockOrder.includes(blockId)) return blockId;
  }
  const selectedBlocks = Array.isArray(state.builder.blocks) ? state.builder.blocks : [];
  const blockMatch = selectedBlocks.find(id => builderBlockOrder.includes(id));
  if (blockMatch) return blockMatch;
  const withLectures = contexts.find(ctx => ctx.block.blockId !== '__unlabeled' && ctx.lectures.length);
  if (withLectures) return withLectures.block.blockId;
  return contexts[0]?.block.blockId || '';
}

function ensureWeekForBlock(blockId) {
  if (!blockId) {
    return;
  }
  const entries = builderWeekMap.get(blockId) || [];
  if (!entries.length) {
    clearActiveWeek(blockId);
    return;
  }
  const currentKey = state.builder.activeWeekKey;
  if (currentKey && currentKey.startsWith(`${blockId}|`)) {
    const hasCurrent = entries.some(entry => entry.key === currentKey);
    if (hasCurrent) {
      applyWeekSelection(blockId, currentKey, entries);
      return;
    }
  }
  applyWeekSelection(blockId, entries[0].key, entries);
}

function setActiveBlock(blockId) {
  if (!blockId || !builderBlockOrder.includes(blockId)) return;
  const collapsed = builderBlockOrder.filter(id => id !== blockId);
  const patch = {};
  if (!arraysEqual(collapsed, state.builder.collapsedBlocks || [])) {
    patch.collapsedBlocks = collapsed;
  }
  if (state.builder.activeBlockId !== blockId) {
    patch.activeBlockId = blockId;
  }
  if (patch.activeBlockId && state.builder.activeWeekKey && !state.builder.activeWeekKey.startsWith(`${blockId}|`)) {
    patch.activeWeekKey = '';
  }
  if (Object.keys(patch).length) {
    setBuilder(patch);
  }
}

function setActiveWeek(blockId, week) {
  if (!blockId) return;
  const entries = builderWeekMap.get(blockId) || [];
  if (!entries.length) {
    clearActiveWeek(blockId);
    return;
  }
  const normalizedWeek = week != null ? week : -1;
  const target = entries.find(entry => entry.week === normalizedWeek) || entries[0];
  applyWeekSelection(blockId, target.key, entries);
}

function applyWeekSelection(blockId, key, entries) {
  if (!key || !Array.isArray(entries)) return;
  const collapsed = new Set(state.builder.collapsedWeeks || []);
  const validKeys = entries.map(entry => entry.key);
  for (const value of Array.from(collapsed)) {
    if (value.startsWith(`${blockId}|`) && !validKeys.includes(value) && value !== key) {
      collapsed.delete(value);
    }
  }
  entries.forEach(entry => {
    if (entry.key === key) {
      collapsed.delete(entry.key);
    } else {
      collapsed.add(entry.key);
    }
  });
  const patch = {};
  const collapsedArr = Array.from(collapsed);
  if (!arraysEqual(collapsedArr, state.builder.collapsedWeeks || [])) {
    patch.collapsedWeeks = collapsedArr;
  }
  if (state.builder.activeWeekKey !== key) {
    patch.activeWeekKey = key;
  }
  if (Object.keys(patch).length) {
    setBuilder(patch);
  }
}

function clearActiveWeek(blockId) {
  if (!blockId) return;
  const prefix = `${blockId}|`;
  const nextCollapsed = (state.builder.collapsedWeeks || []).filter(key => !key.startsWith(prefix));
  const patch = {};
  if (!arraysEqual(nextCollapsed, state.builder.collapsedWeeks || [])) {
    patch.collapsedWeeks = nextCollapsed;
  }
  if (state.builder.activeWeekKey && state.builder.activeWeekKey.startsWith(prefix)) {
    patch.activeWeekKey = '';
  }
  if (Object.keys(patch).length) {
    setBuilder(patch);
  }
}

function findNextBlock(currentId) {
  if (!builderBlockOrder.length) return null;
  const index = builderBlockOrder.indexOf(currentId);
  if (index === -1) return builderBlockOrder[0] || null;
  for (let offset = 1; offset < builderBlockOrder.length; offset += 1) {
    const candidate = builderBlockOrder[(index + offset) % builderBlockOrder.length];
    if (candidate) return candidate;
  }
  return currentId || null;
}

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function renderBlockPanel(context, rerender) {
  const { block, lectures, weeks } = context;
  const blockId = block.blockId;
  const hasLectureSelection = hasAnyLectureSelected(blockId, lectures);
  const blockFullySelected = isBlockFullySelected(block, lectures);
  const blockCollapsed = isBlockCollapsed(blockId);

  const card = document.createElement('div');
  card.className = 'card builder-block-card';
  if (blockFullySelected) card.classList.add('active');
  if (blockCollapsed) card.classList.add('is-collapsed');

  const header = document.createElement('div');
  header.className = 'builder-block-header';

  const blockCollapseBtn = createCollapseToggle({
    collapsed: blockCollapsed,
    label: blockCollapsed ? 'Show weeks' : 'Hide weeks',
    onToggle: () => {
      toggleBlockCollapsed(blockId);
      rerender();
    },
    variant: 'block'
  });
  header.appendChild(blockCollapseBtn);

  const title = document.createElement('h3');
  title.textContent = block.title || blockId;
  header.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'builder-block-meta';
  const weekCount = weeks.length;
  const lectureCount = lectures.length;
  const metaParts = [];
  if (weekCount) metaParts.push(`${weekCount} week${weekCount === 1 ? '' : 's'}`);
  if (lectureCount) metaParts.push(`${lectureCount} lecture${lectureCount === 1 ? '' : 's'}`);
  meta.textContent = metaParts.join(' • ') || 'No lectures linked yet';
  header.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'builder-block-actions';

  if (lectures.length || blockId === '__unlabeled') {
    const label = blockId === '__unlabeled' ? 'Include unlabeled cards' : 'Select all lectures';
    const allBtn = createAction(label, () => {
      selectEntireBlock(block);
      rerender();
    });
    if (lectures.length && areAllLecturesSelected(blockId, lectures)) {
      allBtn.disabled = true;
    }
    actions.appendChild(allBtn);
  }

  if (hasLectureSelection || blockFullySelected) {
    const clearBtn = createAction('Clear block', () => {
      clearBlock(blockId);
      rerender();
    }, 'danger');
    actions.appendChild(clearBtn);
  }

  header.appendChild(actions);
  card.appendChild(header);

  if (blockId === '__unlabeled') {
    const note = document.createElement('div');
    note.className = 'builder-unlabeled-note';
    note.textContent = 'Include to study cards without block or lecture tags.';
    card.appendChild(note);
    return card;
  }

  const weekList = document.createElement('div');
  weekList.className = 'builder-week-list';
  weekList.hidden = blockCollapsed;
  if (!weeks.length) {
    const empty = document.createElement('div');
    empty.className = 'builder-empty';
    empty.textContent = 'No lectures added yet.';
    weekList.appendChild(empty);
  } else {
    weeks.forEach(({ week, items }) => {
      weekList.appendChild(renderWeek(block, week, items, rerender));
    });
  }
  card.appendChild(weekList);
  return card;
}

function renderWeek(block, week, lectures, rerender) {
  const blockId = block.blockId;
  const weekCollapsed = isWeekCollapsed(blockId, week);
  const row = document.createElement('div');
  row.className = 'builder-week-card';
  if (hasAnyLectureSelected(blockId, lectures)) row.classList.add('is-active');
  if (weekCollapsed) row.classList.add('is-collapsed');

  const header = document.createElement('div');
  header.className = 'builder-week-header';

  const weekCollapseBtn = createCollapseToggle({
    collapsed: weekCollapsed,
    label: weekCollapsed ? 'Show lectures' : 'Hide lectures',
    onToggle: () => {
      toggleWeekCollapsed(blockId, week);
      rerender();
    }
  });
  header.appendChild(weekCollapseBtn);

  const label = document.createElement('span');
  label.className = 'builder-week-title';
  label.textContent = formatWeekLabel(week);
  header.appendChild(label);

  const meta = document.createElement('span');
  meta.className = 'builder-week-meta';
  meta.textContent = `${lectures.length} lecture${lectures.length === 1 ? '' : 's'}`;
  header.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'builder-week-actions';
  const allBtn = createAction('Select all', () => {
    selectWeek(block, week);
    rerender();
  });
  const clearBtn = createAction('Clear', () => {
    clearWeek(block, week);
    rerender();
  }, 'danger');

  if (areAllLecturesSelected(blockId, lectures)) {
    allBtn.disabled = true;
  }
  if (!hasAnyLectureSelected(blockId, lectures)) {
    clearBtn.disabled = true;
  }

  actions.appendChild(allBtn);
  actions.appendChild(clearBtn);
  header.appendChild(actions);

  row.appendChild(header);

  const lectureList = document.createElement('div');
  lectureList.className = 'builder-lecture-list';
  lectureList.hidden = weekCollapsed;
  lectures.forEach(lecture => {
    lectureList.appendChild(renderLecture(block, lecture, rerender));
  });
  row.appendChild(lectureList);

  return row;
}

function renderLecture(block, lecture, rerender) {
  const blockId = block.blockId;
  const lectureKey = lectureKeyFor(blockId, lecture.id);
  const active = state.builder.lectures.includes(lectureKey);
  const pill = createPill(active, lecture.name || `Lecture ${lecture.id}`, () => {
    toggleLecture(block, lecture);
    rerender();
  }, 'lecture');
  return pill;
}

function renderControls(rerender, redraw) {
  const aside = document.createElement('aside');
  aside.className = 'builder-controls';

  aside.appendChild(renderFilterCard(rerender));
  aside.appendChild(renderSummaryCard(rerender, redraw));
  aside.appendChild(renderModeCard(rerender, redraw));
  aside.appendChild(renderReviewCard(redraw));

  return aside;
}

function renderFilterCard(rerender) {
  const card = document.createElement('div');
  card.className = 'card builder-filter-card';

  const title = document.createElement('h3');
  title.textContent = 'Filters';
  card.appendChild(title);

  const typeLabel = document.createElement('div');
  typeLabel.className = 'builder-section-title';
  typeLabel.textContent = 'Card types';
  card.appendChild(typeLabel);

  const pillRow = document.createElement('div');
  pillRow.className = 'builder-pill-row';
  const typeMap = { disease: 'Disease', drug: 'Drug', concept: 'Concept' };
  Object.entries(typeMap).forEach(([value, label]) => {
    const active = state.builder.types.includes(value);
    const pill = createPill(active, label, () => {
      toggleType(value);
      rerender();
    }, 'small');
    pillRow.appendChild(pill);
  });
  card.appendChild(pillRow);

  const favToggle = createPill(state.builder.onlyFav, 'Only favorites', () => {
    setBuilder({ onlyFav: !state.builder.onlyFav });
    notifyBuilderChanged();
    rerender();
  }, 'small outline');
  card.appendChild(favToggle);

  return card;
}

function renderSummaryCard(rerender, redraw) {
  const card = document.createElement('div');
  card.className = 'card builder-summary-card';

  const title = document.createElement('h3');
  title.textContent = 'Study set';
  card.appendChild(title);

  const selectionMeta = document.createElement('div');
  selectionMeta.className = 'builder-selection-meta';
  const blockCount = countSelectedBlocks();
  const lectureCount = state.builder.lectures.length;
  selectionMeta.innerHTML = `
    <span>Blocks: ${blockCount}</span>
    <span>Lectures: ${lectureCount}</span>
  `;
  card.appendChild(selectionMeta);

  const count = document.createElement('div');
  count.className = 'builder-count';
  count.textContent = `Set size: ${state.cohort.length}`;
  card.appendChild(count);

  const actions = document.createElement('div');
  actions.className = 'builder-summary-actions';

  const buildBtn = document.createElement('button');
  buildBtn.type = 'button';
  buildBtn.className = 'btn';
  buildBtn.textContent = 'Build set';
  buildBtn.addEventListener('click', async () => {
    await buildSet(buildBtn, count, rerender);
    await removeAllStudySessions().catch(err => console.warn('Failed to clear saved sessions', err));
    redraw();
  });
  actions.appendChild(buildBtn);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn secondary builder-clear-btn';
  clearBtn.textContent = 'Clear selection';
  clearBtn.disabled = !hasAnySelection();
  clearBtn.addEventListener('click', () => {
    setBuilder({ blocks: [], weeks: [], lectures: [] });
    notifyBuilderChanged();
    rerender();
  });
  actions.appendChild(clearBtn);

  card.appendChild(actions);
  return card;
}

function renderModeCard(rerender, redraw) {
  const card = document.createElement('div');
  card.className = 'card builder-mode-card';

  const title = document.createElement('h3');
  title.textContent = 'Modes';
  card.appendChild(title);

  const layout = document.createElement('div');
  layout.className = 'builder-mode-layout';

  const controls = document.createElement('div');
  controls.className = 'builder-mode-controls';

  const status = document.createElement('div');
  status.className = 'builder-mode-status';
  controls.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'builder-mode-actions';

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'btn builder-start-btn';

  const resumeBtn = document.createElement('button');
  resumeBtn.type = 'button';
  resumeBtn.className = 'btn builder-resume-btn';
  resumeBtn.textContent = 'Resume';

  const modes = ['Flashcards', 'Quiz', 'Blocks'];
  const selected = state.study?.selectedMode || 'Flashcards';

  const modeColumn = document.createElement('div');
  modeColumn.className = 'builder-mode-option-column';

  const modeLabel = document.createElement('div');
  modeLabel.className = 'builder-mode-options-title';
  modeLabel.textContent = 'Choose a mode';
  modeColumn.appendChild(modeLabel);

  const modeRow = document.createElement('div');
  modeRow.className = 'builder-mode-options';
  modes.forEach(mode => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'builder-mode-toggle';
    btn.dataset.mode = mode.toLowerCase();
    const isActive = mode === selected;
    if (isActive) btn.classList.add('is-active');
    btn.dataset.active = isActive ? 'true' : 'false';
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    btn.textContent = mode;
    btn.addEventListener('click', () => {
      setStudySelectedMode(mode);
      rerender();
    });
    modeRow.appendChild(btn);
  });
  modeColumn.appendChild(modeRow);

  const storageKey = MODE_KEY[selected] || null;
  const savedEntry = storageKey ? getStudySessionEntry(storageKey) : null;
  const hasSaved = !!(savedEntry && savedEntry.session);
  const cohort = Array.isArray(state.cohort) ? state.cohort : [];
  const hasCohort = cohort.length > 0;
  const canStart = selected === 'Blocks' ? hasCohort : hasCohort;
  const labelTitle = selected.toLowerCase();

  startBtn.textContent = 'Start';
  startBtn.disabled = !canStart;
  startBtn.classList.toggle('is-ready', canStart);

  resumeBtn.disabled = !hasSaved;
  resumeBtn.classList.toggle('is-ready', hasSaved);

  if (hasSaved) {
    const count = Array.isArray(savedEntry?.cohort) ? savedEntry.cohort.length : 0;
    status.textContent = `Saved ${labelTitle} session${count ? ` • ${count} cards` : ''}`;
  } else if (!hasCohort && selected !== 'Blocks') {
    status.textContent = 'Build a study set to enable this mode.';
  } else if (selected === 'Blocks' && !hasCohort) {
    status.textContent = 'Assemble a study set to open Blocks mode.';
  } else {
    status.textContent = `Ready to start ${labelTitle}.`;
  }

  const handleError = (err) => console.warn('Failed to update study session state', err);

  startBtn.addEventListener('click', async () => {
    if (!canStart) return;
    setStudySelectedMode(selected);
    const key = MODE_KEY[selected];

    if (selected === 'Blocks') {
      if (key) {
        await removeStudySession(key).catch(handleError);
      }
      resetBlockMode();
      setSubtab('Study', 'Blocks');
      setTab('Block Board');
      redraw();
      return;
    }

    if (!key) return;

    await removeStudySession(key).catch(handleError);
    if (!cohort.length) return;

    if (selected === 'Flashcards') {
      setFlashSession({ idx: 0, pool: cohort, ratings: {}, mode: 'study' });
    } else if (selected === 'Quiz') {
      setQuizSession({ idx: 0, score: 0, pool: cohort });
    }
    setSubtab('Study', 'Builder');
    setTab('Study');
    redraw();
  });


  resumeBtn.addEventListener('click', async () => {
    if (!hasSaved || !storageKey || !savedEntry) return;
    setStudySelectedMode(selected);
    await removeStudySession(storageKey).catch(handleError);
    const restoredCohort = Array.isArray(savedEntry.cohort) ? savedEntry.cohort : [];
    setCohort(restoredCohort);
    if (selected === 'Blocks') {
      resetBlockMode();
      if (savedEntry.session && typeof savedEntry.session === 'object') {
        setBlockMode(savedEntry.session);
      }
      setSubtab('Study', 'Blocks');
      setTab('Block Board');
      redraw();
      return;
    }


    if (selected === 'Flashcards') {
      setFlashSession(savedEntry.session);
    } else if (selected === 'Quiz') {
      setQuizSession(savedEntry.session);
    }
    setSubtab('Study', 'Builder');
    setTab('Study');
    redraw();
  });


  actions.appendChild(startBtn);
  actions.appendChild(resumeBtn);

  controls.appendChild(actions);

  layout.appendChild(modeColumn);
  layout.appendChild(controls);

  card.appendChild(layout);
  return card;
}


function renderReviewCard(redraw) {
  const card = document.createElement('div');
  card.className = 'card builder-review-card';

  const title = document.createElement('h3');
  title.textContent = 'Review';
  card.appendChild(title);

  const status = document.createElement('div');
  status.className = 'builder-review-status';
  status.textContent = 'Loading review queue…';
  card.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'builder-review-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn secondary';
  openBtn.textContent = 'Open review';

  openBtn.disabled = false;

  openBtn.addEventListener('click', () => {
    setSubtab('Study', 'Review');
    redraw();
  });
  actions.appendChild(openBtn);

  const saved = getStudySessionEntry('review');
  if (saved?.session) {
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'btn builder-review-resume';
    resumeBtn.textContent = 'Resume review';
    resumeBtn.addEventListener('click', async () => {
      await removeStudySession('review').catch(err => console.warn('Failed to clear review session stub', err));
      const restored = Array.isArray(saved.cohort) ? saved.cohort : null;
      if (restored) {
        setCohort(restored);
      }
      setFlashSession(saved.session);
      setSubtab('Study', 'Review');
      redraw();
    });
    actions.appendChild(resumeBtn);
  }

  card.appendChild(actions);
  updateReviewSummary(saved);
  return card;

  async function updateReviewSummary(savedEntry = null) {
    try {
      const items = await loadReviewSourceItems();
      const dueCount = collectReviewCount(items);
      if (items.length) {
        const base = dueCount ? `${dueCount} card${dueCount === 1 ? '' : 's'} due` : 'All caught up!';
        if (savedEntry?.session) {
          const savedLabel = savedEntry.metadata?.label ? savedEntry.metadata.label : 'Saved review session ready';
          status.textContent = `${base} • ${savedLabel}`;
        } else {
          status.textContent = base;
        }

      } else {
        status.textContent = 'Review queue ready — no cards due yet.';

      }
    } catch (err) {
      console.warn('Failed to summarize review queue', err);
      status.textContent = 'Unable to load review queue.';
    }
  }
}


async function buildSet(button, countEl, rerender) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Building…';
  try {
    const items = await gatherItems();
    setCohort(items);
    resetBlockMode();
    countEl.textContent = `Set size: ${items.length}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
  rerender();
}

async function gatherItems() {
  let items = [];
  for (const kind of state.builder.types) {
    const byKind = await listItemsByKind(kind);
    items = items.concat(byKind);
  }
  return items.filter(item => {
    if (state.builder.onlyFav && !item.favorite) return false;
    if (state.builder.blocks.length) {
      const wantUnlabeled = state.builder.blocks.includes('__unlabeled');
      const hasBlockMatch = item.blocks?.some(b => state.builder.blocks.includes(b));
      if (!hasBlockMatch) {
        const isUnlabeled = !item.blocks || !item.blocks.length;
        if (!(wantUnlabeled && isUnlabeled)) return false;
      }
    }
    if (state.builder.lectures.length) {
      const ok = item.lectures?.some(lecture => {
        const key = lectureKeyFor(lecture.blockId, lecture.id);
        return state.builder.lectures.includes(key);
      });
      if (!ok) return false;
    }
    return true;
  });
}

function selectEntireBlock(block) {
  const blockId = block.blockId;
  const blockSet = new Set(state.builder.blocks);
  const lectureSet = new Set(state.builder.lectures);

  const lectures = lectureListFor(blockId, { clone: false });
  if (lectures.length) {
    lectures.forEach(lecture => {
      lectureSet.add(lectureKeyFor(blockId, lecture.id));
    });
    syncBlockWithLectureSelection(blockSet, lectureSet, block);
  } else {
    blockSet.add(blockId);
  }

  setActiveBlock(blockId);
  ensureWeekForBlock(blockId);
  notifyBuilderChanged();
  setBuilder({
    blocks: Array.from(blockSet),
    lectures: Array.from(lectureSet),
    weeks: []
  });
}

function clearBlock(blockId) {
  const lectureSet = new Set(state.builder.lectures);
  const blockSet = new Set(state.builder.blocks);
  for (const key of Array.from(lectureSet)) {
    if (key.startsWith(`${blockId}|`)) lectureSet.delete(key);
  }
  blockSet.delete(blockId);
  setActiveBlock(blockId);
  ensureWeekForBlock(blockId);
  notifyBuilderChanged();
  setBuilder({
    blocks: Array.from(blockSet),
    lectures: Array.from(lectureSet),
    weeks: []
  });
}

function selectWeek(block, week) {
  const blockId = block.blockId;
  const lectureSet = new Set(state.builder.lectures);
  const blockSet = new Set(state.builder.blocks);
  const lectures = lectureListFor(blockId, { clone: false });
  lectures.forEach(lecture => {
    if (lecture.week === week) {
      lectureSet.add(lectureKeyFor(blockId, lecture.id));
    }
  });
  syncBlockWithLectureSelection(blockSet, lectureSet, block);
  setActiveBlock(blockId);
  setActiveWeek(blockId, week);
  notifyBuilderChanged();
  setBuilder({
    lectures: Array.from(lectureSet),
    blocks: Array.from(blockSet),
    weeks: []
  });
}

function clearWeek(block, week) {
  const blockId = block.blockId;
  const lectureSet = new Set(state.builder.lectures);
  const blockSet = new Set(state.builder.blocks);
  const lectures = lectureListFor(blockId, { clone: false });
  lectures.forEach(lecture => {
    if (lecture.week === week) {
      lectureSet.delete(lectureKeyFor(blockId, lecture.id));
    }
  });
  syncBlockWithLectureSelection(blockSet, lectureSet, block);
  setActiveBlock(blockId);
  setActiveWeek(blockId, week);
  notifyBuilderChanged();
  setBuilder({
    lectures: Array.from(lectureSet),
    blocks: Array.from(blockSet),
    weeks: []
  });
}

function toggleLecture(block, lecture) {
  const key = lectureKeyFor(block.blockId, lecture.id);
  const lectureSet = new Set(state.builder.lectures);
  const blockSet = new Set(state.builder.blocks);
  if (lectureSet.has(key)) {
    lectureSet.delete(key);
  } else {
    lectureSet.add(key);
  }
  syncBlockWithLectureSelection(blockSet, lectureSet, block);
  setActiveBlock(block.blockId);
  setActiveWeek(block.blockId, lecture.week != null ? lecture.week : -1);
  notifyBuilderChanged();
  setBuilder({
    lectures: Array.from(lectureSet),
    blocks: Array.from(blockSet),
    weeks: []
  });
}

function toggleType(type) {
  const types = new Set(state.builder.types);
  if (types.has(type)) types.delete(type); else types.add(type);
  notifyBuilderChanged();
  setBuilder({ types: Array.from(types) });
}

function isBlockCollapsed(blockId) {
  if (state.builder.activeBlockId) {
    return state.builder.activeBlockId !== blockId;
  }
  return (state.builder.collapsedBlocks || []).includes(blockId);
}

function toggleBlockCollapsed(blockId) {
  if (!blockId) return;
  if (isBlockCollapsed(blockId)) {
    setActiveBlock(blockId);
    ensureWeekForBlock(blockId);
    return;
  }
  const fallback = findNextBlock(blockId);
  if (!fallback || fallback === blockId) {
    return;
  }
  setActiveBlock(fallback);
  ensureWeekForBlock(fallback);
}

function isWeekCollapsed(blockId, week) {
  const activeBlockId = state.builder.activeBlockId;
  if (!activeBlockId) {
    return (state.builder.collapsedWeeks || []).includes(weekKeyFor(blockId, week));
  }
  if (blockId !== activeBlockId) return true;
  const activeWeekKey = state.builder.activeWeekKey;
  const entries = builderWeekMap.get(blockId) || [];
  if (!entries.length) return true;
  const key = weekKeyFor(blockId, week);
  if (!activeWeekKey) {
    return key !== entries[0].key;
  }
  return activeWeekKey !== key;
}

function toggleWeekCollapsed(blockId, week) {
  const normalizedWeek = week;
  if (isWeekCollapsed(blockId, normalizedWeek)) {
    setActiveBlock(blockId);
    setActiveWeek(blockId, normalizedWeek);
    ensureWeekForBlock(blockId);
    return;
  }
  const entries = builderWeekMap.get(blockId) || [];
  const currentKey = weekKeyFor(blockId, normalizedWeek);
  const fallback = entries.find(entry => entry.key !== currentKey);
  if (!fallback) return;
  setActiveWeek(blockId, fallback.week);
}

function isBlockFullySelected(block, lectures) {
  if (!block) return false;
  const blockId = block.blockId;
  if (!state.builder.blocks.includes(blockId)) return false;
  if (!lectures?.length) return true;
  return areAllLecturesSelected(blockId, lectures);
}

function hasAnySelection() {
  return state.builder.blocks.length || state.builder.lectures.length;
}

function countSelectedBlocks() {
  const blockSet = new Set(state.builder.blocks);
  for (const key of state.builder.lectures) {
    const [blockId] = key.split('|');
    if (blockId) blockSet.add(blockId);
  }
  return blockSet.size;
}

function groupByWeek(lectures) {
  const map = new Map();
  lectures.forEach(lecture => {
    const week = lecture.week != null ? lecture.week : -1;
    if (!map.has(week)) map.set(week, []);
    map.get(week).push(lecture);
  });
  return Array.from(map.entries())
    .sort((a, b) => {
      const [weekA, weekB] = [a[0], b[0]];
      const specialA = weekA == null || weekA < 0;
      const specialB = weekB == null || weekB < 0;
      if (specialA && specialB) return 0;
      if (specialA) return 1;
      if (specialB) return -1;
      return weekB - weekA;
    })
    .map(([week, items]) => ({ week, items }));
}

function weekKeyFor(blockId, week) {
  return `${blockId}|${week}`;
}

function lectureKeyFor(blockId, lectureId) {
  return `${blockId}|${lectureId}`;
}

function formatWeekLabel(week) {
  if (week == null || week < 0) return 'No week';
  return `Week ${week}`;
}

function hasAnyLectureSelected(blockId, lectures) {
  if (!lectures?.length) return false;
  const lectureSet = new Set(state.builder.lectures);
  return lectures.some(lecture => lectureSet.has(lectureKeyFor(blockId, lecture.id)));
}

function areAllLecturesSelected(blockId, lectures) {
  if (!lectures?.length) return false;
  const lectureSet = new Set(state.builder.lectures);
  return lectures.every(lecture => lectureSet.has(lectureKeyFor(blockId, lecture.id)));
}

function syncBlockWithLectureSelection(blockSet, lectureSet, block) {
  if (!block) return;
  const blockId = block.blockId;
  const prefix = `${blockId}|`;
  let hasLecture = false;
  for (const key of lectureSet) {
    if (key.startsWith(prefix)) {
      hasLecture = true;
      break;
    }
  }
  if (!hasLecture) {
    blockSet.delete(blockId);
    return;
  }
  const blockLectures = lectureListFor(blockId, { clone: false });
  if (!blockLectures.length) {
    blockSet.add(blockId);
    return;
  }
  const allSelected = blockLectures.every(lecture => lectureSet.has(lectureKeyFor(blockId, lecture.id)));
  if (allSelected) {
    blockSet.add(blockId);
  } else {
    blockSet.delete(blockId);
  }
}

function createPill(active, label, onClick, variant = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'builder-pill';
  if (variant) {
    const variants = Array.isArray(variant) ? variant : variant.split(' ');
    variants.filter(Boolean).forEach(name => btn.classList.add(`builder-pill-${name}`));
  }
  setToggleState(btn, active);
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function createAction(label, onClick, variant = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'builder-action';
  if (variant) {
    const variants = Array.isArray(variant) ? variant : variant.split(' ');
    variants.filter(Boolean).forEach(name => btn.classList.add(`builder-action-${name}`));
  }
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function createCollapseToggle({ collapsed, label, onToggle, variant = 'week' }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'builder-collapse-toggle';
  if (variant === 'block') btn.classList.add('builder-collapse-toggle-block');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', label);
  btn.textContent = collapsed ? '▸' : '▾';
  btn.addEventListener('click', onToggle);
  return btn;
}
