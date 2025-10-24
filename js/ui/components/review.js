
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


const REVIEW_SCOPES = ['all', 'blocks', 'lectures'];
let activeScope = 'all';
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

function createSelectionModel(onChange) {
  const selected = new Map();
  const api = {
    keyOf: entryKey,
    toggle(entry, active = true) {
      const key = entryKey(entry);
      if (!key) return;
      if (active) {
        selected.set(key, entry);
      } else {
        selected.delete(key);
      }
      if (typeof onChange === 'function') onChange(api);
    },
    clear() {
      if (!selected.size) return;
      selected.clear();
      if (typeof onChange === 'function') onChange(api);
    },
    selectAll(entries = []) {
      let changed = false;
      entries.forEach(entry => {
        const key = entryKey(entry);
        if (!key) return;
        if (!selected.has(key)) {
          selected.set(key, entry);
          changed = true;
        }
      });
      if (changed && typeof onChange === 'function') onChange(api);
    },
    entries() {
      return Array.from(selected.values());
    },
    has(entry) {
      return selected.has(entryKey(entry));
    },
    hasKey(key) {
      return selected.has(key);
    },
    size() {
      return selected.size;
    },
    keys() {
      return Array.from(selected.keys());
    }
  };
  return api;
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

function groupByBlock(entries, blockTitles) {
  const groups = new Map();
  entries.forEach(entry => {
    const blocks = Array.isArray(entry.item.blocks) && entry.item.blocks.length
      ? entry.item.blocks
      : ['__unassigned'];
    blocks.forEach(blockId => {
      const group = groups.get(blockId) || { id: blockId, entries: [] };
      group.entries.push(entry);
      groups.set(blockId, group);
    });
  });
  return Array.from(groups.values()).map(group => ({
    id: group.id,
    title: group.id === '__unassigned' ? 'Unassigned' : (blockTitles.get(group.id) || group.id),
    entries: group.entries
  })).sort((a, b) => b.entries.length - a.entries.length);
}

function groupByLecture(entries, blockTitles) {
  const groups = new Map();
  entries.forEach(entry => {
    const lectures = Array.isArray(entry.item.lectures) && entry.item.lectures.length
      ? entry.item.lectures
      : [{ blockId: '__unassigned', id: '__none', name: 'Unassigned lecture' }];
    lectures.forEach(lec => {
      const key = `${lec.blockId || '__unassigned'}::${lec.id}`;
      const blockTitle = blockTitles.get(lec.blockId) || lec.blockId || 'Unassigned';
      const title = lec.name ? `${blockTitle} – ${lec.name}` : `${blockTitle} – Lecture ${lec.id}`;
      const group = groups.get(key) || { id: key, title, entries: [] };
      group.entries.push(entry);
      groups.set(key, group);
    });
  });
  return Array.from(groups.values()).sort((a, b) => b.entries.length - a.entries.length);
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

function renderAllView(container, dueEntries, upcomingEntries, now, start, blocks, redraw) {
  const allEntries = [...dueEntries, ...upcomingEntries];
  const entryRefs = new Map();
  let busy = false;
  const normalizedBlocks = Array.isArray(blocks) ? blocks : [];

  let updateSelectionUI = () => {};
  const selectionModel = createSelectionModel(() => updateSelectionUI());

  const actionRow = document.createElement('div');
  actionRow.className = 'review-actions';
  const startBtn = document.createElement('button');
  startBtn.className = 'btn';
  startBtn.textContent = `Start review (${dueEntries.length})`;
  startBtn.disabled = dueEntries.length === 0;
  startBtn.addEventListener('click', () => {
    if (!dueEntries.length) return;
    start(buildSessionPayload(dueEntries), { scope: 'all', label: 'All due cards' });
  });
  actionRow.appendChild(startBtn);

  if (upcomingEntries.length) {
    const upcomingBtn = document.createElement('button');
    upcomingBtn.className = 'btn secondary';
    upcomingBtn.textContent = `Review upcoming (${upcomingEntries.length})`;
    upcomingBtn.addEventListener('click', () => {
      if (!upcomingEntries.length) return;
      start(buildSessionPayload(upcomingEntries), { scope: 'upcoming', label: 'Upcoming cards' });
    });
    actionRow.appendChild(upcomingBtn);
  }
  container.appendChild(actionRow);

  const selectionBar = document.createElement('div');
  selectionBar.className = 'review-selection-bar';
  const selectionInfo = document.createElement('div');
  selectionInfo.className = 'review-selection-info';
  selectionInfo.textContent = 'Select cards to manage them.';
  selectionBar.appendChild(selectionInfo);

  const selectionControls = document.createElement('div');
  selectionControls.className = 'review-selection-controls';
  selectionBar.appendChild(selectionControls);

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'btn tertiary';
  selectAllBtn.textContent = 'Select all';
  selectAllBtn.addEventListener('click', () => {
    selectionModel.selectAll(allEntries);
  });
  selectionControls.appendChild(selectAllBtn);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn tertiary';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => selectionModel.clear());
  selectionControls.appendChild(clearBtn);

  const selectionActions = document.createElement('div');
  selectionActions.className = 'review-selection-actions';
  selectionBar.appendChild(selectionActions);

  const startSelectedBtn = document.createElement('button');
  startSelectedBtn.type = 'button';
  startSelectedBtn.className = 'btn secondary';
  startSelectedBtn.textContent = 'Start selected';
  startSelectedBtn.addEventListener('click', () => {
    const entries = selectionModel.entries();
    if (!entries.length) return;
    start(buildSessionPayload(entries), {
      scope: 'selection',
      label: `Custom review (${entries.length})`
    });
  });
  selectionActions.appendChild(startSelectedBtn);

  const suspendBtn = document.createElement('button');
  suspendBtn.type = 'button';
  suspendBtn.className = 'btn secondary';
  suspendBtn.textContent = 'Suspend';
  selectionActions.appendChild(suspendBtn);

  const retireBtn = document.createElement('button');
  retireBtn.type = 'button';
  retireBtn.className = 'btn secondary danger';
  retireBtn.textContent = 'Retire';
  selectionActions.appendChild(retireBtn);

  const moveBtn = document.createElement('button');
  moveBtn.type = 'button';
  moveBtn.className = 'btn secondary';
  moveBtn.textContent = 'Move';
  selectionActions.appendChild(moveBtn);

  const selectionStatus = document.createElement('div');
  selectionStatus.className = 'review-selection-status';
  selectionBar.appendChild(selectionStatus);

  const movePanel = document.createElement('div');
  movePanel.className = 'review-move-panel';
  movePanel.hidden = true;

  const moveLabel = document.createElement('label');
  moveLabel.className = 'review-move-label';
  moveLabel.textContent = 'Move to block';
  const moveSelect = document.createElement('select');
  moveSelect.className = 'input review-move-select';
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = 'Choose…';
  placeholderOption.disabled = true;
  placeholderOption.selected = true;
  moveSelect.appendChild(placeholderOption);
  normalizedBlocks.forEach(block => {
    if (!block) return;
    const option = document.createElement('option');
    option.value = block.blockId;
    option.textContent = block.title || block.blockId || 'Untitled block';
    moveSelect.appendChild(option);
  });
  const unassignOption = document.createElement('option');
  unassignOption.value = '__unassigned';
  unassignOption.textContent = 'Unassign from blocks';
  moveSelect.appendChild(unassignOption);
  moveLabel.appendChild(moveSelect);
  movePanel.appendChild(moveLabel);

  const replaceWrap = document.createElement('label');
  replaceWrap.className = 'review-move-replace';
  const replaceCheckbox = document.createElement('input');
  replaceCheckbox.type = 'checkbox';
  replaceWrap.appendChild(replaceCheckbox);
  const replaceText = document.createElement('span');
  replaceText.textContent = 'Replace existing blocks';
  replaceWrap.appendChild(replaceText);
  movePanel.appendChild(replaceWrap);

  const moveActions = document.createElement('div');
  moveActions.className = 'review-move-actions';
  const applyMoveBtn = document.createElement('button');
  applyMoveBtn.type = 'button';
  applyMoveBtn.className = 'btn';
  applyMoveBtn.textContent = 'Apply move';
  const cancelMoveBtn = document.createElement('button');
  cancelMoveBtn.type = 'button';
  cancelMoveBtn.className = 'btn tertiary';
  cancelMoveBtn.textContent = 'Cancel';
  moveActions.appendChild(applyMoveBtn);
  moveActions.appendChild(cancelMoveBtn);
  movePanel.appendChild(moveActions);
  selectionBar.appendChild(movePanel);

  container.appendChild(selectionBar);

  const setBusy = (value) => {
    busy = value;
    selectionBar.classList.toggle('is-busy', value);
    moveSelect.disabled = value;
    replaceCheckbox.disabled = value;
    applyMoveBtn.disabled = value;
    cancelMoveBtn.disabled = value;
    updateSelectionUI();
  };

  updateSelectionUI = () => {
    const selectedKeys = selectionModel.keys();
    const count = selectionModel.size();
    selectionInfo.textContent = count ? `${count} card${count === 1 ? '' : 's'} selected` : 'Select cards to manage them.';
    const disableActions = busy || count === 0;
    startSelectedBtn.disabled = disableActions;
    suspendBtn.disabled = disableActions;
    retireBtn.disabled = disableActions;
    moveBtn.disabled = disableActions;
    clearBtn.disabled = busy || count === 0;
    selectAllBtn.disabled = busy || !allEntries.length || count === allEntries.length;
    const selectedSet = new Set(selectedKeys);
    entryRefs.forEach((refs, key) => {
      const selected = selectedSet.has(key);
      if (refs.checkbox) refs.checkbox.checked = selected;
      if (refs.element) refs.element.classList.toggle('is-selected', selected);
    });
  };

  const runBulkAction = async (handler, { successMessage, failureMessage }) => {
    const entries = selectionModel.entries();
    if (!entries.length) return false;
    let succeeded = false;
    setBusy(true);
    selectionStatus.textContent = 'Working…';
    selectionStatus.classList.remove('is-error', 'is-success');
    try {
      await handler(entries);
      selectionStatus.textContent = successMessage || 'Done.';
      selectionStatus.classList.add('is-success');
      selectionModel.clear();
      succeeded = true;
    } catch (err) {
      console.error('Bulk review action failed', err);
      selectionStatus.textContent = failureMessage || 'Action failed.';
      selectionStatus.classList.add('is-error');
    } finally {
      setBusy(false);
      setTimeout(() => {
        selectionStatus.textContent = '';
        selectionStatus.classList.remove('is-error', 'is-success');
      }, 2400);
    }
    return succeeded;
  };

  suspendBtn.addEventListener('click', async () => {
    const success = await runBulkAction(async entries => {
      const nowTs = Date.now();
      for (const entry of entries) {
        suspendSection(entry.item, entry.sectionKey, nowTs);
        await upsertItem(entry.item);
      }
    }, { successMessage: 'Suspended selected cards.' });
    if (success && typeof redraw === 'function') redraw();
  });

  retireBtn.addEventListener('click', async () => {
    const success = await runBulkAction(async entries => {
      const steps = await getReviewDurations();
      const nowTs = Date.now();
      for (const entry of entries) {
        rateSection(entry.item, entry.sectionKey, RETIRE_RATING, steps, nowTs);
        await upsertItem(entry.item);
      }
    }, { successMessage: 'Retired selected cards.' });
    if (success && typeof redraw === 'function') redraw();
  });

  moveBtn.addEventListener('click', () => {
    if (movePanel.hidden) {
      movePanel.hidden = false;
      moveBtn.classList.add('is-active');
      moveSelect.focus();
    } else {
      movePanel.hidden = true;
      moveBtn.classList.remove('is-active');
    }
  });

  cancelMoveBtn.addEventListener('click', () => {
    movePanel.hidden = true;
    moveBtn.classList.remove('is-active');
  });

  applyMoveBtn.addEventListener('click', async () => {
    const target = moveSelect.value;
    if (!target) {
      moveSelect.focus();
      return;
    }
    const replace = replaceCheckbox.checked;
    const success = await runBulkAction(async entries => {
      for (const entry of entries) {
        const item = entry.item;
        const currentBlocks = Array.isArray(item.blocks) ? [...item.blocks] : [];
        if (target === '__unassigned') {
          item.blocks = [];
        } else if (replace) {
          item.blocks = [target];
        } else {
          const next = new Set(currentBlocks);
          next.add(target);
          item.blocks = Array.from(next);
        }
        await upsertItem(item);
      }
    }, {
      successMessage: target === '__unassigned' ? 'Unassigned selected cards.' : 'Updated block assignments.'
    });
    movePanel.hidden = true;
    moveBtn.classList.remove('is-active');
    if (success && typeof redraw === 'function') redraw();
  });

  const registerEntry = (entry, checkbox, element) => {
    const key = selectionModel.keyOf(entry);
    if (!key) return;
    entryRefs.set(key, { checkbox, element });
  };

  if (!dueEntries.length && !upcomingEntries.length) {
    renderEmptyState(container);
    updateSelectionUI();
    return;
  }

  const buildEntryElement = (entry, { upcoming = false } = {}) => {
    const item = document.createElement('li');
    item.className = 'review-entry';
    if (upcoming) item.classList.add('is-upcoming');

    const row = document.createElement('div');
    row.className = 'review-entry-row';

    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'review-entry-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'review-entry-check';
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', event => {
      event.stopPropagation();
      selectionModel.toggle(entry, checkbox.checked);
    });
    checkboxLabel.appendChild(checkbox);
    row.appendChild(checkboxLabel);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'review-entry-trigger';
    trigger.setAttribute('aria-label', upcoming
      ? `Review ${titleOf(entry.item)} early`
      : `Review ${titleOf(entry.item)} immediately`);

    const title = document.createElement('div');
    title.className = 'review-entry-title';
    title.textContent = titleOf(entry.item);
    trigger.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'review-entry-meta';
    meta.textContent = `${getSectionLabel(entry.item, entry.sectionKey)} • ${upcoming
      ? formatTimeUntil(entry.due, now)
      : formatOverdue(entry.due, now)}`;
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

    const launch = () => {
      start(buildSessionPayload([entry]), { scope: 'single', label: `Focused review – ${titleOf(entry.item)}` });
    };
    trigger.addEventListener('click', launch);

    row.appendChild(trigger);
    item.appendChild(row);

    registerEntry(entry, checkbox, item);
    return item;
  };

  if (!dueEntries.length) {
    const info = document.createElement('div');
    info.className = 'review-empty';
    info.textContent = 'No cards are due right now. Upcoming cards are listed below.';
    container.appendChild(info);
  } else {
    const list = document.createElement('ul');
    list.className = 'review-entry-list';
    dueEntries.forEach(entry => {
      list.appendChild(buildEntryElement(entry));
    });
    container.appendChild(list);
  }

  if (upcomingEntries.length) {
    const upcomingSection = document.createElement('div');
    upcomingSection.className = 'review-upcoming-section';

    const heading = document.createElement('div');
    heading.className = 'review-upcoming-title';
    heading.textContent = 'Upcoming cards';
    upcomingSection.appendChild(heading);

    const note = document.createElement('div');
    note.className = 'review-upcoming-note';
    note.textContent = `Next ${upcomingEntries.length} card${upcomingEntries.length === 1 ? '' : 's'} in the queue`;
    upcomingSection.appendChild(note);

    const list = document.createElement('ul');
    list.className = 'review-entry-list';
    upcomingEntries.forEach(entry => {
      list.appendChild(buildEntryElement(entry, { upcoming: true }));
    });
    upcomingSection.appendChild(list);
    container.appendChild(upcomingSection);
  }

  updateSelectionUI();
}


function renderGroupView(container, groups, label, start, metaBuilder = null) {

  if (!groups.length) {
    renderEmptyState(container);
    return;
  }
  const list = document.createElement('div');
  list.className = 'review-group-list';
  groups.forEach(group => {
    const card = document.createElement('div');
    card.className = 'review-group-card';
    const heading = document.createElement('div');
    heading.className = 'review-group-heading';
    const title = document.createElement('div');
    title.className = 'review-group-title';
    title.textContent = group.title;
    const count = document.createElement('span');
    count.className = 'review-group-count';
    count.textContent = `${group.entries.length} card${group.entries.length === 1 ? '' : 's'}`;
    heading.appendChild(title);
    heading.appendChild(count);
    card.appendChild(heading);


    const actions = document.createElement('div');
    actions.className = 'review-group-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'btn';
    startBtn.textContent = `Start ${label}`;
    startBtn.addEventListener('click', () => {
      const metadata = typeof metaBuilder === 'function' ? metaBuilder(group) : { label };
      start(buildSessionPayload(group.entries), metadata);
    });
    actions.appendChild(startBtn);
    card.appendChild(actions);

    list.appendChild(card);

  });
  container.appendChild(list);
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

  const tabs = document.createElement('div');
  tabs.className = 'review-tabs';
  REVIEW_SCOPES.forEach(scope => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    const label = scope === 'all' ? 'All' : scope === 'blocks' ? 'By block' : 'By lecture';
    if (activeScope === scope) btn.classList.add('active');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (activeScope === scope) return;
      activeScope = scope;
      renderReview(root, redraw);
    });
    tabs.appendChild(btn);
  });

  wrapper.appendChild(tabs);

  const body = document.createElement('div');
  body.className = 'review-body';
  wrapper.appendChild(body);


  const startSession = async (pool, metadata = {}) => {
    if (!pool.length) return;
    await removeStudySession('review').catch(err => console.warn('Failed to discard existing review save', err));
    setFlashSession({ idx: 0, pool, ratings: {}, mode: 'review', metadata });

    redraw();
  };

  if (activeScope === 'all') {
    renderAllView(body, dueEntries, upcomingEntries, now, startSession, blocks, redraw);
  } else if (activeScope === 'blocks') {
    const groups = groupByBlock(dueEntries, blockTitles);

    renderGroupView(body, groups, 'block review', startSession, (group) => ({
      scope: 'block',
      label: `Block – ${group.title}`,
      blockId: group.id
    }));
  } else {
    const groups = groupByLecture(dueEntries, blockTitles);
    renderGroupView(body, groups, 'lecture review', startSession, (group) => ({
      scope: 'lecture',
      label: `Lecture – ${group.title}`,
      lectureId: group.id
    }));

  }

  root.appendChild(wrapper);
}
