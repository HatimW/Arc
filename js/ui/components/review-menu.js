import { createFloatingWindow } from './window-manager.js';
import { getSectionLabel } from './section-utils.js';
import { suspendSection, retireSection } from '../../review/scheduler.js';
import { upsertItem } from '../../storage/storage.js';
import {
  buildSessionPayload,
  summarizeEntry,
  formatIntervalMinutes,
  formatOverdue,
  describePhase,
  computeMasteryStage,
  formatRelativePast
} from '../../review/view-model.js';

function normalizeMap(mapLike) {
  if (mapLike instanceof Map) return mapLike;
  if (!mapLike || typeof mapLike !== 'object') return new Map();
  return new Map(Object.entries(mapLike));
}

function createStatusElement() {
  const status = document.createElement('div');
  status.className = 'review-menu-status';
  const setStatus = (message = '', variant = '') => {
    status.textContent = message;
    status.classList.remove('is-error', 'is-success');
    if (variant === 'error') status.classList.add('is-error');
    if (variant === 'success') status.classList.add('is-success');
  };
  return { element: status, setStatus };
}

function matchesScope(record, scope) {
  if (!scope || scope.type === 'all') return true;
  if (scope.type === 'block') {
    return record.scopes.some(ref => ref.blockId === scope.blockId);
  }
  if (scope.type === 'week') {
    return record.scopes.some(ref => ref.blockId === scope.blockId && ref.weekId === scope.weekId);
  }
  if (scope.type === 'lecture') {
    return record.scopes.some(ref => ref.blockId === scope.blockId
      && ref.weekId === scope.weekId
      && ref.lectureKey === scope.lectureId);
  }
  return true;
}

function scopeLabel(scope, hierarchy) {
  if (!scope || scope.type === 'all') return 'All due cards';
  if (scope.type === 'block') {
    const block = hierarchy.blocks.find(entry => entry.id === scope.blockId);
    return block ? block.title : 'Block';
  }
  if (scope.type === 'week') {
    const block = hierarchy.blocks.find(entry => entry.id === scope.blockId);
    if (!block) return 'Week';
    const week = block.weeks.find(entry => entry.id === scope.weekId);
    return week ? `${week.label} – ${block.title}` : 'Week';
  }
  if (scope.type === 'lecture') {
    const block = hierarchy.blocks.find(entry => entry.id === scope.blockId);
    if (!block) return 'Lecture';
    const week = block.weeks.find(entry => entry.id === scope.weekId);
    const lecture = week?.lectures.find(entry => entry.id === scope.lectureId);
    if (!lecture) return 'Lecture';
    const weekTitle = week ? week.label : '';
    return weekTitle ? `${lecture.title} – ${weekTitle}` : lecture.title;
  }
  return 'Cards';
}

function formatRefs(refs) {
  if (!Array.isArray(refs) || !refs.length) return [];
  return refs.map(ref => ({
    block: ref.blockTitle,
    week: ref.weekLabel,
    lecture: ref.lectureLabel
  }));
}

function buildRecord(entry, blockTitleMap, now) {
  const summary = summarizeEntry(entry, blockTitleMap, now);
  const key = summary.key;
  const scopes = Array.isArray(summary.refs) ? summary.refs.map(ref => ({
    blockId: ref.blockId,
    weekId: ref.weekId,
    lectureId: ref.lectureId,
    lectureKey: ref.lectureKey
  })) : [];
  return {
    key,
    entry,
    summary,
    scopes
  };
}

function buildCounts(records) {
  const counts = {
    all: records.length,
    blocks: new Map(),
    weeks: new Map(),
    lectures: new Map()
  };
  records.forEach(record => {
    const seen = new Set();
    record.scopes.forEach(ref => {
      const blockKey = ref.blockId;
      if (blockKey && !seen.has(`block:${blockKey}`)) {
        counts.blocks.set(blockKey, (counts.blocks.get(blockKey) || 0) + 1);
        seen.add(`block:${blockKey}`);
      }
      const weekKey = ref.blockId && ref.weekId ? `${ref.blockId}::${ref.weekId}` : null;
      if (weekKey && !seen.has(`week:${weekKey}`)) {
        counts.weeks.set(weekKey, (counts.weeks.get(weekKey) || 0) + 1);
        seen.add(`week:${weekKey}`);
      }
      const lectureKey = ref.lectureKey;
      if (lectureKey && !seen.has(`lecture:${lectureKey}`)) {
        counts.lectures.set(lectureKey, (counts.lectures.get(lectureKey) || 0) + 1);
        seen.add(`lecture:${lectureKey}`);
      }
    });
  });
  return counts;
}

function updateCountLabel(el, count) {
  if (!el) return;
  el.textContent = count;
  el.parentElement?.classList.toggle('is-empty', count === 0);
}

function createNav(hierarchy, counts, onSelect) {
  const nav = document.createElement('nav');
  nav.className = 'review-menu-nav';

  const allItem = document.createElement('button');
  allItem.type = 'button';
  allItem.className = 'review-menu-nav-item is-active';
  allItem.textContent = `All cards (${counts.all})`;
  allItem.dataset.scope = 'all';
  nav.appendChild(allItem);

  const sections = document.createElement('div');
  sections.className = 'review-menu-nav-groups';
  nav.appendChild(sections);

  const blockCountEls = new Map();
  const weekCountEls = new Map();
  const lectureCountEls = new Map();

  hierarchy.blocks.forEach(block => {
    const blockBtn = document.createElement('button');
    blockBtn.type = 'button';
    blockBtn.className = 'review-menu-nav-item block';
    blockBtn.dataset.scope = 'block';
    blockBtn.dataset.blockId = block.id;

    const label = document.createElement('span');
    label.className = 'review-menu-nav-label';
    label.textContent = block.title;
    blockBtn.appendChild(label);

    const countEl = document.createElement('span');
    countEl.className = 'review-menu-nav-count';
    updateCountLabel(countEl, counts.blocks.get(block.id) || 0);
    blockBtn.appendChild(countEl);
    blockCountEls.set(block.id, countEl);

    sections.appendChild(blockBtn);

    if (block.weeks && block.weeks.length) {
      const weekList = document.createElement('div');
      weekList.className = 'review-menu-nav-children';
      sections.appendChild(weekList);

      block.weeks.forEach(week => {
        const weekBtn = document.createElement('button');
        weekBtn.type = 'button';
        weekBtn.className = 'review-menu-nav-item week';
        weekBtn.dataset.scope = 'week';
        weekBtn.dataset.blockId = block.id;
        weekBtn.dataset.weekId = week.id;

        const weekLabel = document.createElement('span');
        weekLabel.className = 'review-menu-nav-label';
        weekLabel.textContent = week.label;
        weekBtn.appendChild(weekLabel);

        const weekCountKey = `${block.id}::${week.id}`;
        const weekCount = document.createElement('span');
        weekCount.className = 'review-menu-nav-count';
        updateCountLabel(weekCount, counts.weeks.get(weekCountKey) || 0);
        weekBtn.appendChild(weekCount);
        weekCountEls.set(weekCountKey, weekCount);

        weekList.appendChild(weekBtn);

        if (week.lectures && week.lectures.length) {
          const lectureList = document.createElement('div');
          lectureList.className = 'review-menu-nav-children lectures';
          weekList.appendChild(lectureList);

          week.lectures.forEach(lecture => {
            const lectureBtn = document.createElement('button');
            lectureBtn.type = 'button';
            lectureBtn.className = 'review-menu-nav-item lecture';
            lectureBtn.dataset.scope = 'lecture';
            lectureBtn.dataset.blockId = block.id;
            lectureBtn.dataset.weekId = week.id;
            lectureBtn.dataset.lectureId = lecture.id;

            const lectureLabel = document.createElement('span');
            lectureLabel.className = 'review-menu-nav-label';
            lectureLabel.textContent = lecture.title;
            lectureBtn.appendChild(lectureLabel);

            const lectureCount = document.createElement('span');
            lectureCount.className = 'review-menu-nav-count';
            updateCountLabel(lectureCount, counts.lectures.get(lecture.id) || 0);
            lectureBtn.appendChild(lectureCount);
            lectureCountEls.set(lecture.id, lectureCount);

            lectureList.appendChild(lectureBtn);
          });
        }
      });
    }
  });

  nav.addEventListener('click', event => {
    const target = event.target.closest('button.review-menu-nav-item');
    if (!target) return;
    event.preventDefault();
    const scope = target.dataset.scope;
    const previous = nav.querySelector('.review-menu-nav-item.is-active');
    if (previous) previous.classList.remove('is-active');
    target.classList.add('is-active');
    if (scope === 'block') {
      onSelect({ type: 'block', blockId: target.dataset.blockId });
    } else if (scope === 'week') {
      onSelect({
        type: 'week',
        blockId: target.dataset.blockId,
        weekId: target.dataset.weekId
      });
    } else if (scope === 'lecture') {
      onSelect({
        type: 'lecture',
        blockId: target.dataset.blockId,
        weekId: target.dataset.weekId,
        lectureId: target.dataset.lectureId
      });
    } else {
      onSelect({ type: 'all' });
    }
  });

  const updateAllCount = count => {
    allItem.textContent = `All cards (${count})`;
  };

  return { nav, blockCountEls, weekCountEls, lectureCountEls, updateAllCount, selectScope(scopeObj) {
    const selector = scopeObj?.type === 'block'
      ? `.review-menu-nav-item.block[data-block-id="${scopeObj.blockId}"]`
      : scopeObj?.type === 'week'
        ? `.review-menu-nav-item.week[data-block-id="${scopeObj.blockId}"][data-week-id="${scopeObj.weekId}"]`
        : scopeObj?.type === 'lecture'
          ? `.review-menu-nav-item.lecture[data-lecture-id="${scopeObj.lectureId}"]`
          : '.review-menu-nav-item.is-active';
    const target = nav.querySelector(selector) || nav.querySelector('.review-menu-nav-item');
    nav.querySelectorAll('.review-menu-nav-item').forEach(btn => btn.classList.toggle('is-active', btn === target));
    if (target) target.scrollIntoView({ block: 'nearest' });
  } };
}

function createCard(record, options) {
  const { onToggle, onReview, onSuspend, onRetire } = options;
  const { entry, summary } = record;

  const card = document.createElement('div');
  card.className = 'review-menu-card';
  card.dataset.key = record.key;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'review-menu-checkbox';
  checkbox.addEventListener('change', () => {
    if (typeof onToggle === 'function') onToggle(record.key, checkbox.checked);
  });
  card.appendChild(checkbox);

  const header = document.createElement('div');
  header.className = 'review-menu-card-header';
  const title = document.createElement('div');
  title.className = 'review-menu-card-title';
  title.textContent = summary.title;
  header.appendChild(title);
  const section = document.createElement('div');
  section.className = 'review-menu-card-section';
  section.textContent = getSectionLabel(entry.item, entry.sectionKey);
  header.appendChild(section);
  card.appendChild(header);

  const chips = document.createElement('div');
  chips.className = 'review-menu-card-chips';
  formatRefs(summary.refs).forEach(ref => {
    if (ref.block) {
      const chip = document.createElement('span');
      chip.className = 'review-menu-chip';
      chip.textContent = ref.block;
      chips.appendChild(chip);
    }
    if (ref.week) {
      const chip = document.createElement('span');
      chip.className = 'review-menu-chip subtle';
      chip.textContent = ref.week;
      chips.appendChild(chip);
    }
    if (ref.lecture) {
      const chip = document.createElement('span');
      chip.className = 'review-menu-chip subtle';
      chip.textContent = ref.lecture;
      chips.appendChild(chip);
    }
  });
  card.appendChild(chips);

  const stats = document.createElement('dl');
  stats.className = 'review-menu-card-stats';

  const due = document.createElement('div');
  due.className = 'review-menu-card-stat';
  due.innerHTML = `<dt>Due</dt><dd>${formatOverdue(entry.due, options.now)}</dd>`;
  stats.appendChild(due);

  const stage = document.createElement('div');
  stage.className = 'review-menu-card-stat';
  stage.innerHTML = `<dt>Stage</dt><dd>${computeMasteryStage(entry.state)}</dd>`;
  stats.appendChild(stage);

  const phase = document.createElement('div');
  phase.className = 'review-menu-card-stat';
  const interval = entry?.state?.interval;
  const intervalText = Number.isFinite(interval) && interval > 0 ? formatIntervalMinutes(interval) : '—';
  phase.innerHTML = `<dt>${describePhase(entry.phase) || 'Phase'}</dt><dd>${intervalText}</dd>`;
  stats.appendChild(phase);

  const last = document.createElement('div');
  last.className = 'review-menu-card-stat';
  last.innerHTML = `<dt>Last</dt><dd>${formatRelativePast(entry?.state?.last, options.now)}</dd>`;
  stats.appendChild(last);

  card.appendChild(stats);

  const actions = document.createElement('div');
  actions.className = 'review-menu-card-actions';

  if (typeof onReview === 'function') {
    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'btn tertiary';
    reviewBtn.textContent = 'Review';
    reviewBtn.addEventListener('click', () => onReview(record.key));
    actions.appendChild(reviewBtn);
  }

  const suspendBtn = document.createElement('button');
  suspendBtn.type = 'button';
  suspendBtn.className = 'btn tertiary';
  suspendBtn.textContent = 'Suspend';
  suspendBtn.addEventListener('click', () => onSuspend(record.key));
  actions.appendChild(suspendBtn);

  const retireBtn = document.createElement('button');
  retireBtn.type = 'button';
  retireBtn.className = 'btn tertiary danger';
  retireBtn.textContent = 'Retire';
  retireBtn.addEventListener('click', () => onRetire(record.key));
  actions.appendChild(retireBtn);

  card.appendChild(actions);

  return { card, checkbox };
}

export function openReviewEntryMenu({
  hierarchy,
  blockTitleMap,
  now = Date.now(),
  startSession,
  onChange,
  focus = { type: 'all' },
  title
} = {}) {
  const blockMap = normalizeMap(blockTitleMap);
  const entries = Array.isArray(hierarchy?.root?.entries) ? hierarchy.root.entries : [];
  if (!entries.length) {
    const win = createFloatingWindow({ title: title || 'Review cards', width: 820 });
    const body = win.querySelector('.floating-body');
    body.textContent = 'No review entries available.';
    return win;
  }

  const records = entries.map(entry => buildRecord(entry, blockMap, now));
  const recordMap = new Map(records.map(record => [record.key, record]));
  const counts = buildCounts(records);

  const win = createFloatingWindow({ title: title || 'Review cards', width: 960 });
  const body = win.querySelector('.floating-body');
  body.classList.add('review-menu');

  const { element: statusEl, setStatus } = createStatusElement();

  const layout = document.createElement('div');
  layout.className = 'review-menu-layout';
  body.appendChild(layout);

  let activeScope = focus && typeof focus === 'object' ? { ...focus } : { type: 'all' };

  const navContext = createNav(hierarchy, counts, scope => {
    activeScope = scope;
    renderGrid();
    clearSelection();
    statusEl.textContent = '';
  });
  const { nav, blockCountEls, weekCountEls, lectureCountEls, updateAllCount, selectScope } = navContext;
  layout.appendChild(nav);

  const content = document.createElement('div');
  content.className = 'review-menu-content';
  layout.appendChild(content);

  const toolbar = document.createElement('div');
  toolbar.className = 'review-menu-toolbar';
  content.appendChild(toolbar);

  const scopeLabelEl = document.createElement('h3');
  scopeLabelEl.className = 'review-menu-scope';
  scopeLabelEl.textContent = scopeLabel(activeScope, hierarchy);
  toolbar.appendChild(scopeLabelEl);

  const selectionInfo = document.createElement('div');
  selectionInfo.className = 'review-menu-selection-info';
  toolbar.appendChild(selectionInfo);

  const selectionButtons = document.createElement('div');
  selectionButtons.className = 'review-menu-selection-actions';
  toolbar.appendChild(selectionButtons);

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'btn tertiary';
  selectAllBtn.textContent = 'Select all';
  selectionButtons.appendChild(selectAllBtn);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn tertiary';
  clearBtn.textContent = 'Clear';
  selectionButtons.appendChild(clearBtn);

  const actionButtons = document.createElement('div');
  actionButtons.className = 'review-menu-bulk-actions';
  content.appendChild(actionButtons);

  const reviewSelectedBtn = document.createElement('button');
  reviewSelectedBtn.type = 'button';
  reviewSelectedBtn.className = 'btn';
  reviewSelectedBtn.textContent = 'Review selected';
  reviewSelectedBtn.disabled = true;
  if (typeof startSession !== 'function') {
    reviewSelectedBtn.disabled = true;
    reviewSelectedBtn.classList.add('is-hidden');
  }
  actionButtons.appendChild(reviewSelectedBtn);

  const suspendSelectedBtn = document.createElement('button');
  suspendSelectedBtn.type = 'button';
  suspendSelectedBtn.className = 'btn tertiary';
  suspendSelectedBtn.textContent = 'Suspend selected';
  suspendSelectedBtn.disabled = true;
  actionButtons.appendChild(suspendSelectedBtn);

  const retireSelectedBtn = document.createElement('button');
  retireSelectedBtn.type = 'button';
  retireSelectedBtn.className = 'btn tertiary danger';
  retireSelectedBtn.textContent = 'Retire selected';
  retireSelectedBtn.disabled = true;
  actionButtons.appendChild(retireSelectedBtn);

  const grid = document.createElement('div');
  grid.className = 'review-menu-grid';
  content.appendChild(grid);
  content.appendChild(statusEl);

  const cardsByKey = new Map();
  const checkboxesByKey = new Map();
  let selectedKeys = new Set();
  let dragging = null;

  const setSelection = (keys, value) => {
    const next = new Set(selectedKeys);
    if (Array.isArray(keys)) {
      keys.forEach(key => {
        if (!recordMap.has(key)) return;
        if (value) {
          next.add(key);
        } else {
          next.delete(key);
        }
      });
    } else if (typeof keys === 'string') {
      if (!recordMap.has(keys)) return;
      if (value) next.add(keys);
      else next.delete(keys);
    }
    if (next.size === selectedKeys.size && Array.from(next).every(key => selectedKeys.has(key))) {
      return;
    }
    selectedKeys = next;
    cardsByKey.forEach((card, key) => {
      const isSelected = selectedKeys.has(key);
      card.classList.toggle('is-selected', isSelected);
      const checkbox = checkboxesByKey.get(key);
      if (checkbox && checkbox.checked !== isSelected) {
        checkbox.checked = isSelected;
      }
    });
    updateSelectionInfo();
  };

  const toggleSelection = (key, value) => {
    setSelection([key], value);
  };

  const clearSelection = () => {
    selectedKeys = new Set();
    cardsByKey.forEach((card, key) => {
      card.classList.remove('is-selected');
      const checkbox = checkboxesByKey.get(key);
      if (checkbox) checkbox.checked = false;
    });
    updateSelectionInfo();
  };

  const updateSelectionInfo = () => {
    const count = selectedKeys.size;
    if (count) {
      selectionInfo.textContent = `${count} card${count === 1 ? '' : 's'} selected`;
    } else {
      selectionInfo.textContent = 'No cards selected';
    }
    const hasSelection = count > 0;
    reviewSelectedBtn.disabled = !hasSelection || typeof startSession !== 'function';
    suspendSelectedBtn.disabled = !hasSelection;
    retireSelectedBtn.disabled = !hasSelection;
  };

  const applyAction = async (keys, action) => {
    if (!Array.isArray(keys) || !keys.length) return;
    const uniqueKeys = Array.from(new Set(keys.filter(key => recordMap.has(key))));
    if (!uniqueKeys.length) return;

    const actionLabel = action === 'suspend' ? 'Suspending…' : 'Retiring…';
    setStatus(`${actionLabel}`);
    suspendSelectedBtn.disabled = true;
    retireSelectedBtn.disabled = true;
    reviewSelectedBtn.disabled = true;

    const changedItems = new Set();
    try {
      const nowTs = Date.now();
      uniqueKeys.forEach(key => {
        const record = recordMap.get(key);
        if (!record) return;
        const { entry } = record;
        if (action === 'suspend') {
          suspendSection(entry.item, entry.sectionKey, nowTs);
        } else if (action === 'retire') {
          retireSection(entry.item, entry.sectionKey, nowTs);
        }
        changedItems.add(entry.item);
      });
      for (const item of changedItems) {
        // eslint-disable-next-line no-await-in-loop
        await upsertItem(item);
      }
      removeRecords(uniqueKeys);
      setStatus(action === 'suspend' ? 'Cards suspended.' : 'Cards retired.', 'success');
      if (typeof onChange === 'function') {
        onChange({ removedKeys: uniqueKeys, action });
      }
    } catch (err) {
      console.error('Failed to update review entries', err);
      setStatus('Action failed.', 'error');
    } finally {
      updateSelectionInfo();
    }
  };

  const removeRecords = keys => {
    const removed = [];
    keys.forEach(key => {
      const record = recordMap.get(key);
      if (!record) return;
      removed.push(record);
      recordMap.delete(key);
    });
    if (!removed.length) return;

    records.splice(0, records.length, ...records.filter(record => !recordMap.has(record.key)));
    selectedKeys = new Set(Array.from(selectedKeys).filter(key => recordMap.has(key)));

    removed.forEach(record => {
      const card = cardsByKey.get(record.key);
      if (card) {
        card.classList.add('is-removed');
        setTimeout(() => card.remove(), 160);
      }
      cardsByKey.delete(record.key);
      checkboxesByKey.delete(record.key);
    });

    removed.forEach(record => {
      const seen = new Set();
      record.scopes.forEach(ref => {
        if (ref.blockId != null && !seen.has(`block:${ref.blockId}`) && counts.blocks.has(ref.blockId)) {
          const next = Math.max(0, (counts.blocks.get(ref.blockId) || 0) - 1);
          counts.blocks.set(ref.blockId, next);
          seen.add(`block:${ref.blockId}`);
        }
        const weekKey = `${ref.blockId}::${ref.weekId}`;
        if (!seen.has(`week:${weekKey}`) && counts.weeks.has(weekKey)) {
          const next = Math.max(0, (counts.weeks.get(weekKey) || 0) - 1);
          counts.weeks.set(weekKey, next);
          seen.add(`week:${weekKey}`);
        }
        if (ref.lectureKey != null && !seen.has(`lecture:${ref.lectureKey}`) && counts.lectures.has(ref.lectureKey)) {
          const next = Math.max(0, (counts.lectures.get(ref.lectureKey) || 0) - 1);
          counts.lectures.set(ref.lectureKey, next);
          seen.add(`lecture:${ref.lectureKey}`);
        }
      });
    });
    counts.all = records.length;

    updateAllCount(counts.all);
    removed.forEach(record => {
      record.scopes.forEach(ref => {
        if (ref.blockId != null) {
          const blockEl = blockCountEls.get(ref.blockId);
          if (blockEl) updateCountLabel(blockEl, counts.blocks.get(ref.blockId) || 0);
        }
        const weekKey = `${ref.blockId}::${ref.weekId}`;
        if (weekCountEls.has(weekKey)) {
          updateCountLabel(weekCountEls.get(weekKey), counts.weeks.get(weekKey) || 0);
        }
        if (ref.lectureKey != null && lectureCountEls.has(ref.lectureKey)) {
          updateCountLabel(lectureCountEls.get(ref.lectureKey), counts.lectures.get(ref.lectureKey) || 0);
        }
      });
    });

    updateSelectionInfo();
    renderGrid();
    setStatus('');
  };

  const handleReview = keys => {
    if (typeof startSession !== 'function') return;
    const selectedEntries = keys
      .map(key => recordMap.get(key)?.entry)
      .filter(Boolean);
    if (!selectedEntries.length) return;
    startSession(buildSessionPayload(selectedEntries), { scope: 'custom', label: 'Focused review' });
  };

  const renderGrid = () => {
    grid.innerHTML = '';
    cardsByKey.clear();
    checkboxesByKey.clear();
    scopeLabelEl.textContent = scopeLabel(activeScope, hierarchy);
    const filtered = records.filter(record => matchesScope(record, activeScope));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'review-menu-empty';
      empty.textContent = 'No cards in this scope.';
      grid.appendChild(empty);
      return;
    }

    filtered.forEach(record => {
      const { card, checkbox } = createCard(record, {
        now,
        onToggle: toggleSelection,
        onReview: key => handleReview([key]),
        onSuspend: key => applyAction([key], 'suspend'),
        onRetire: key => applyAction([key], 'retire')
      });
      cardsByKey.set(record.key, card);
      checkboxesByKey.set(record.key, checkbox);
      grid.appendChild(card);
    });

    updateSelectionInfo();
  };

  selectAllBtn.addEventListener('click', () => {
    const filtered = records.filter(record => matchesScope(record, activeScope)).map(record => record.key);
    setSelection(filtered, true);
  });

  clearBtn.addEventListener('click', () => {
    clearSelection();
  });

  reviewSelectedBtn.addEventListener('click', () => {
    if (!selectedKeys.size) return;
    handleReview(Array.from(selectedKeys));
  });

  suspendSelectedBtn.addEventListener('click', () => {
    if (!selectedKeys.size) return;
    applyAction(Array.from(selectedKeys), 'suspend');
  });

  retireSelectedBtn.addEventListener('click', () => {
    if (!selectedKeys.size) return;
    applyAction(Array.from(selectedKeys), 'retire');
  });

  grid.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    const card = event.target.closest('.review-menu-card');
    if (!card || event.button !== 0) return;
    const key = card.dataset.key;
    if (!key) return;
    event.preventDefault();
    const willSelect = !selectedKeys.has(key);
    dragging = { pointerId: event.pointerId, mode: willSelect ? 'select' : 'deselect' };
    toggleSelection(key, willSelect);
  });

  grid.addEventListener('pointerenter', event => {
    if (!dragging || (event.pointerId !== undefined && event.pointerId !== dragging.pointerId)) return;
    const card = event.target.closest('.review-menu-card');
    if (!card) return;
    const key = card.dataset.key;
    if (!key) return;
    toggleSelection(key, dragging.mode === 'select');
  });

  grid.addEventListener('pointerup', event => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    dragging = null;
  });

  grid.addEventListener('pointercancel', () => {
    dragging = null;
  });

  renderGrid();
  selectScope(activeScope);
  updateSelectionInfo();

  return win;
}
