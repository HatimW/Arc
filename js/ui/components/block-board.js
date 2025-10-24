import { state, setBlockBoardState } from '../../state.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { getSettings, listAllLectures, saveLecture } from '../../storage/storage.js';
import {
  groupLectureQueues,
  markPassCompleted,
  deriveLectureStatus,
  calculateNextDue
} from '../../lectures/scheduler.js';
import { passColorForOrder, setPassColorPalette } from './pass-colors.js';

let loadCatalog = loadBlockCatalog;
let fetchLectures = listAllLectures;
let persistLecture = saveLecture;
let fetchSettings = getSettings;

export function __setBlockBoardDeps({ loadBlockCatalog: loadFn, listAllLectures: listFn, saveLecture: saveFn, getSettings: settingsFn } = {}) {
  loadCatalog = typeof loadFn === 'function' ? loadFn : loadBlockCatalog;
  fetchLectures = typeof listFn === 'function' ? listFn : listAllLectures;
  persistLecture = typeof saveFn === 'function' ? saveFn : saveLecture;
  fetchSettings = typeof settingsFn === 'function' ? settingsFn : getSettings;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BOARD_DAYS = 14;
const SHIFT_OFFSET_UNITS = [
  { id: 'minutes', label: 'minutes', minutes: 1 },
  { id: 'hours', label: 'hours', minutes: 60 },
  { id: 'days', label: 'days', minutes: 60 * 24 },
  { id: 'weeks', label: 'weeks', minutes: 60 * 24 * 7 }
];
const TIMELINE_BASE_UNIT_HEIGHT = 20;
const TIMELINE_MAX_BAR_HEIGHT = 200;
const TIMELINE_MIN_SEGMENT_HEIGHT = 12;

const BLOCK_RANGE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
});

const PASS_DUE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
});

const PASS_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
});

function ensureBoardState() {
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
  if (!Array.isArray(state.blockBoard.collapsedBlocks)) {
    state.blockBoard.collapsedBlocks = [];
  }
  if (!Array.isArray(state.blockBoard.hiddenTimelines)) {
    state.blockBoard.hiddenTimelines = [];
    if (state.blockBoard.showDensity === false && !state.blockBoard.hiddenTimelines.includes('__all__')) {
      state.blockBoard.hiddenTimelines.push('__all__');
    }
  }
  if (!Array.isArray(state.blockBoard.autoCollapsed)) {
    state.blockBoard.autoCollapsed = [];
  }
  if (!Array.isArray(state.blockBoard.autoHidden)) {
    state.blockBoard.autoHidden = [];
  }
  if (!Array.isArray(state.blockBoard.manualExpanded)) {
    state.blockBoard.manualExpanded = [];
  }
  if (!Array.isArray(state.blockBoard.manualTimeline)) {
    state.blockBoard.manualTimeline = [];
  }
  return state.blockBoard;
}

function passColor(order = 1) {
  return passColorForOrder(order);
}

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDay(timestamp) {
  const date = new Date(Number(timestamp));
  const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return formatter.format(date);
}

function parseBlockDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatBlockDate(value) {
  const date = parseBlockDate(value);
  if (!date) return null;
  return BLOCK_RANGE_FORMAT.format(date);
}

function blockRangeLabel(block) {
  const start = formatBlockDate(block?.startDate);
  const end = formatBlockDate(block?.endDate);
  if (start && end) return `${start} → ${end}`;
  if (start) return `Starts ${start}`;
  if (end) return `Ends ${end}`;
  return null;
}

function blockSpanDays(block) {
  const start = parseBlockDate(block?.startDate);
  const end = parseBlockDate(block?.endDate);
  if (!start || !end) return null;
  const diff = end.getTime() - start.getTime();
  if (diff < 0) return null;
  return Math.round(diff / DAY_MS) + 1;
}

function normalizeShiftUnit(id) {
  if (typeof id !== 'string') return 'days';
  const normalized = SHIFT_OFFSET_UNITS.find(option => option.id === id);
  return normalized ? normalized.id : 'days';
}

function combineShiftValueUnit(value, unitId) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  const unit = SHIFT_OFFSET_UNITS.find(option => option.id === normalizeShiftUnit(unitId)) || SHIFT_OFFSET_UNITS[2];
  return Math.max(0, Math.round(numeric * unit.minutes));
}

function resolveLatestBlockId(blocks = []) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  let latestId = null;
  let latestScore = -Infinity;
  let fallbackId = null;
  const total = blocks.length;
  blocks.forEach((block, index) => {
    if (!block || block.blockId == null) return;
    const blockId = String(block.blockId);
    if (!fallbackId) fallbackId = blockId;
    const orderScore = Number(block?.order);
    const createdScore = Number(block?.createdAt);
    const start = parseBlockDate(block?.startDate);
    const end = parseBlockDate(block?.endDate);
    const startScore = start instanceof Date ? start.getTime() : null;
    const endScore = end instanceof Date ? end.getTime() : null;
    let score;
    if (Number.isFinite(orderScore)) {
      score = orderScore;
    } else if (Number.isFinite(createdScore)) {
      score = createdScore;
    } else if (Number.isFinite(startScore)) {
      score = startScore;
    } else if (Number.isFinite(endScore)) {
      score = endScore;
    } else {
      score = total - index;
    }
    if (latestId == null || score > latestScore) {
      latestId = blockId;
      latestScore = score;
    }
  });
  return latestId ?? fallbackId;
}

function buildScopeOptions(mode) {
  if (mode === 'pull') {
    return [
      { id: 'single', label: 'Only this pass' },
      { id: 'chain-before', label: 'This & preceding passes' }
    ];
  }
  return [
    { id: 'single', label: 'Only this pass' },
    { id: 'chain-after', label: 'This & following passes' }
  ];
}

function openShiftDialog(mode, { title, description, defaultValue = 1, defaultUnit = 'days' } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal block-board-shift-modal';

    const card = document.createElement('div');
    card.className = 'card block-board-shift-card';

    const heading = document.createElement('h3');
    heading.textContent = title || (mode === 'push' ? 'Push later' : 'Pull earlier');
    card.appendChild(heading);

    if (description) {
      const desc = document.createElement('p');
      desc.className = 'block-board-shift-description';
      desc.textContent = description;
      card.appendChild(desc);
    }

    const fields = document.createElement('div');
    fields.className = 'block-board-shift-fields';

    const amountField = document.createElement('label');
    amountField.className = 'block-board-shift-field';
    amountField.textContent = 'Amount';
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.className = 'input block-board-shift-input';
    amountInput.min = '0';
    amountInput.step = '1';
    amountInput.value = String(defaultValue);
    amountField.appendChild(amountInput);
    fields.appendChild(amountField);

    const unitField = document.createElement('label');
    unitField.className = 'block-board-shift-field';
    unitField.textContent = 'Unit';
    const unitSelect = document.createElement('select');
    unitSelect.className = 'input block-board-shift-unit';
    SHIFT_OFFSET_UNITS.forEach(option => {
      const opt = document.createElement('option');
      opt.value = option.id;
      opt.textContent = option.label;
      unitSelect.appendChild(opt);
    });
    unitSelect.value = normalizeShiftUnit(defaultUnit);
    unitField.appendChild(unitSelect);
    fields.appendChild(unitField);

    card.appendChild(fields);

    const scopeGroup = document.createElement('fieldset');
    scopeGroup.className = 'block-board-shift-scope';
    const legend = document.createElement('legend');
    legend.textContent = 'Scope';
    scopeGroup.appendChild(legend);
    const scopeInputs = [];
    buildScopeOptions(mode).forEach((option, index) => {
      const wrapper = document.createElement('label');
      wrapper.className = 'block-board-shift-scope-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'block-board-shift-scope';
      input.value = option.id;
      if (index === 0) input.checked = true;
      const span = document.createElement('span');
      span.textContent = option.label;
      wrapper.appendChild(input);
      wrapper.appendChild(span);
      scopeGroup.appendChild(wrapper);
      scopeInputs.push(input);
    });
    card.appendChild(scopeGroup);

    const feedback = document.createElement('div');
    feedback.className = 'block-board-shift-error';
    card.appendChild(feedback);

    const actions = document.createElement('div');
    actions.className = 'block-board-shift-actions';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn';
    confirm.textContent = mode === 'push' ? 'Push later' : 'Pull earlier';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn secondary';
    cancel.textContent = 'Cancel';
    actions.appendChild(confirm);
    actions.appendChild(cancel);
    card.appendChild(actions);

    function cleanup(result) {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
      resolve(result);
    }

    confirm.addEventListener('click', () => {
      const minutes = combineShiftValueUnit(amountInput.value, unitSelect.value);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        feedback.textContent = 'Enter a value greater than zero.';
        feedback.classList.add('is-visible');
        amountInput.focus();
        return;
      }
      const selectedScope = scopeInputs.find(input => input.checked)?.value || 'single';
      cleanup({ minutes, scope: selectedScope });
    });

    cancel.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        cleanup(null);
      }
    });

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    amountInput.focus({ preventScroll: true });
  });
}

function shiftPassesForScope(lecture, passOrder, deltaMinutes, scope) {
  if (!lecture || typeof lecture !== 'object') return lecture;
  const targetOrder = Number(passOrder);
  if (!Number.isFinite(targetOrder)) return lecture;
  const delta = Number(deltaMinutes);
  if (!Number.isFinite(delta) || delta === 0) return lecture;
  const passes = Array.isArray(lecture.passes) ? lecture.passes.map(pass => ({ ...pass })) : [];
  if (!passes.length) return lecture;
  const shiftMs = Math.round(delta * 60 * 1000);
  const normalizedScope = scope === 'chain-after' || scope === 'chain-before' ? scope : 'single';
  passes.forEach(pass => {
    const order = Number(pass?.order);
    if (!Number.isFinite(order)) return;
    const inScope = normalizedScope === 'chain-after'
      ? order >= targetOrder
      : normalizedScope === 'chain-before'
        ? order <= targetOrder
        : order === targetOrder;
    if (!inScope) return;
    if (!Number.isFinite(pass?.due)) return;
    if (Number.isFinite(pass?.completedAt)) return;
    const nextDue = Math.max(0, Math.round(pass.due + shiftMs));
    pass.due = nextDue;
  });
  const status = deriveLectureStatus(passes, lecture.status);
  const nextDueAt = calculateNextDue(passes);
  return {
    ...lecture,
    passes,
    status,
    nextDueAt
  };
}

function collectTimelineSegments(blockLectures, days) {
  const dayMap = new Map(days.map(day => [day, []]));
  blockLectures.forEach(lecture => {
    const passes = Array.isArray(lecture?.passes) ? lecture.passes : [];
    passes.forEach(pass => {
      if (!pass) return;
      const due = Number(pass?.due);
      if (!Number.isFinite(due)) return;
      const dayKey = startOfDay(due);
      if (!dayMap.has(dayKey)) return;
      dayMap.get(dayKey).push({
        lecture,
        pass,
        order: Number(pass?.order),
        completed: Number.isFinite(pass?.completedAt)
      });
    });
  });
  return days.map(day => {
    const entries = (dayMap.get(day) || []).slice().sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const orderA = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
      const orderB = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
      if (orderA !== orderB) return orderA - orderB;
      const nameA = a.lecture?.name || '';
      const nameB = b.lecture?.name || '';
      return nameA.localeCompare(nameB);
    });
    return { day, entries };
  });
}

function formatDueTime(due) {
  if (!Number.isFinite(due)) return 'Unscheduled';
  const formatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  return formatter.format(new Date(due));
}

function formatPassDueLabel(due) {
  if (!Number.isFinite(due)) return '';
  const date = new Date(due);
  const datePart = PASS_DUE_FORMAT.format(date);
  const timePart = PASS_TIME_FORMAT.format(date);
  return `${datePart} • ${timePart}`;
}

function collectDefaultBoardDays(now = Date.now()) {
  const today = startOfDay(now);
  const start = today - 2 * DAY_MS;
  return Array.from({ length: DEFAULT_BOARD_DAYS }, (_, idx) => start + idx * DAY_MS);
}

function collectLectureDueRange(lectures) {
  let start = null;
  let end = null;
  if (!Array.isArray(lectures)) return { start, end };
  lectures.forEach(lecture => {
    const passes = Array.isArray(lecture?.passes) ? lecture.passes : [];
    passes.forEach(pass => {
      const due = Number(pass?.due);
      if (!Number.isFinite(due)) return;
      const day = startOfDay(due);
      if (start == null || day < start) start = day;
      if (end == null || day > end) end = day;
    });
  });
  return { start, end };
}

function collectDaysForBlock(block, lectures = [], now = Date.now()) {
  const startDate = parseBlockDate(block?.startDate);
  const endDate = parseBlockDate(block?.endDate);
  const dueRange = collectLectureDueRange(lectures);
  const weeks = Number(block?.weeks);

  let startDay = startDate ? startOfDay(startDate.getTime()) : null;
  let endDay = endDate ? startOfDay(endDate.getTime()) : null;

  if (Number.isFinite(weeks) && weeks > 0) {
    const totalDays = Math.max(1, Math.round(weeks * 7));
    if (startDay != null && endDay == null) {
      endDay = startDay + (totalDays - 1) * DAY_MS;
    } else if (endDay != null && startDay == null) {
      startDay = endDay - (totalDays - 1) * DAY_MS;
    }
  }

  if (dueRange.start != null) {
    startDay = startDay == null ? dueRange.start : Math.min(startDay, dueRange.start);
  }
  if (dueRange.end != null) {
    endDay = endDay == null ? dueRange.end : Math.max(endDay, dueRange.end);
  }

  if (startDay != null && endDay != null && endDay >= startDay) {
    const spanDays = Math.floor((endDay - startDay) / DAY_MS) + 1;
    if (spanDays < 3) {
      const deficit = 3 - spanDays;
      const padBefore = Math.ceil(deficit / 2);
      const padAfter = deficit - padBefore;
      startDay -= padBefore * DAY_MS;
      endDay += padAfter * DAY_MS;
    }
    const days = [];
    for (let ts = startDay; ts <= endDay; ts += DAY_MS) {
      days.push(ts);
    }
    return days;
  }

  if (Number.isFinite(weeks) && weeks > 0) {
    const totalDays = Math.max(1, Math.round(weeks * 7));
    const anchor = dueRange.start != null ? dueRange.start : startOfDay(now);
    return Array.from({ length: totalDays }, (_, idx) => anchor + idx * DAY_MS);
  }

  if (dueRange.start != null && dueRange.end != null && dueRange.end >= dueRange.start) {
    const days = [];
    for (let ts = dueRange.start; ts <= dueRange.end; ts += DAY_MS) {
      days.push(ts);
    }
    return days;
  }

  if (startDate) {
    const start = startOfDay(startDate.getTime());
    return Array.from({ length: 7 }, (_, idx) => start + idx * DAY_MS);
  }

  return [];
}

function buildPassElement(entry, onComplete, onShift) {
  const chip = document.createElement('div');
  chip.className = 'block-board-pass-chip';
  chip.style.setProperty('--chip-accent', passColor(entry?.pass?.order));
  const chipComplete = Number.isFinite(entry?.pass?.completedAt);
  chip.classList.toggle('is-complete', chipComplete);
  chip.classList.toggle('is-pending', !chipComplete);
  chip.dataset.passOrder = String(entry?.pass?.order ?? '');
  const title = document.createElement('div');
  title.className = 'block-board-pass-title';
  title.textContent = entry?.lecture?.name || `Lecture ${entry?.lecture?.id}`;
  chip.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'block-board-pass-meta';
  const label = entry?.pass?.label || `Pass ${entry?.pass?.order ?? ''}`;
  const action = entry?.pass?.action ? entry.pass.action : '';
  const dueLabel = Number.isFinite(entry?.pass?.due)
    ? formatPassDueLabel(entry.pass.due)
    : 'Unscheduled';
  const parts = [label];
  if (action) parts.push(action);
  if (dueLabel) parts.push(dueLabel);
  meta.textContent = parts.join(' • ');
  chip.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'block-board-pass-actions';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn tertiary';
  done.textContent = 'Mark done';
  done.addEventListener('click', () => {
    chip.classList.add('is-complete');
    chip.classList.remove('is-pending');
    onComplete(entry);
  });
  actions.appendChild(done);

  if (typeof onShift === 'function') {
    const push = document.createElement('button');
    push.type = 'button';
    push.className = 'btn tertiary';
    push.textContent = 'Push';
    push.addEventListener('click', () => onShift(entry, 'push'));
    actions.appendChild(push);

    const pull = document.createElement('button');
    pull.type = 'button';
    pull.className = 'btn tertiary';
    pull.textContent = 'Pull';
    pull.addEventListener('click', () => onShift(entry, 'pull'));
    actions.appendChild(pull);
  }

  chip.appendChild(actions);
  return chip;
}

function applyPassDueUpdate(lecture, passOrder, newDue) {
  const passes = Array.isArray(lecture?.passes)
    ? lecture.passes.map(pass => ({ ...pass }))
    : [];
  const index = passes.findIndex(pass => pass?.order === passOrder);
  if (index >= 0) {
    passes[index] = { ...passes[index], due: newDue ?? null };
    if (!Number.isFinite(newDue)) {
      passes[index].due = null;
    }
    passes[index].completedAt = passes[index].completedAt ?? null;
    if (passes[index].completedAt && newDue && newDue > passes[index].completedAt) {
      passes[index].completedAt = null;
    }
  }
  const status = deriveLectureStatus(passes, lecture?.status);
  const nextDueAt = calculateNextDue(passes);
  return { ...lecture, passes, status, nextDueAt };
}

function createPassCard(entry, onDrag) {
  const card = document.createElement('div');
  card.className = 'block-board-pass-card';
  card.draggable = true;
  card.style.setProperty('--card-accent', passColor(entry?.pass?.order));
  const isComplete = Number.isFinite(entry?.pass?.completedAt);
  card.classList.toggle('is-complete', isComplete);
  card.classList.toggle('is-pending', !isComplete);
  card.dataset.blockId = entry?.lecture?.blockId ?? '';
  card.dataset.lectureId = entry?.lecture?.id ?? '';
  card.dataset.passOrder = entry?.pass?.order ?? '';
  card.dataset.passDue = Number.isFinite(entry?.pass?.due) ? String(entry.pass.due) : '';
  card.dataset.status = isComplete ? 'complete' : 'pending';

  const lectureName = entry?.lecture?.name || 'Lecture';
  const title = document.createElement('div');
  title.className = 'block-board-pass-title card-title';
  const titleInner = document.createElement('span');
  titleInner.className = 'block-board-pass-title-inner';
  titleInner.textContent = lectureName;
  title.appendChild(titleInner);
  card.appendChild(title);

  const scheduleMarquee = () => {
    const container = title;
    const inner = titleInner;
    if (!container || !inner) return;
    const available = container.clientWidth;
    const content = inner.scrollWidth;
    const overflow = Math.round(content - available);
    if (available > 0 && overflow > 8) {
      const distance = overflow + 24;
      const duration = Math.min(22, Math.max(8, distance / 24));
      container.classList.add('is-animated');
      container.style.setProperty('--marquee-distance', `${distance}px`);
      container.style.setProperty('--marquee-duration', `${duration}s`);
    } else {
      container.classList.remove('is-animated');
      container.style.removeProperty('--marquee-distance');
      container.style.removeProperty('--marquee-duration');
    }
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(scheduleMarquee);
  } else {
    setTimeout(scheduleMarquee, 0);
  }

  const passLabel = entry?.pass?.label || (entry?.pass?.order != null ? `Pass ${entry.pass.order}` : 'Pass');
  const dueFullLabel = Number.isFinite(entry?.pass?.due)
    ? formatPassDueLabel(entry.pass.due)
    : 'Unscheduled';
  const passOrder = document.createElement('span');
  passOrder.className = 'block-board-pass-pill-order';
  passOrder.textContent = passLabel;
  card.appendChild(passOrder);

  const descriptionParts = [lectureName, passLabel];
  if (entry?.pass?.action) descriptionParts.push(entry.pass.action);
  if (dueFullLabel) descriptionParts.push(dueFullLabel);
  card.setAttribute('aria-label', descriptionParts.join(' • '));
  card.title = descriptionParts.join(' • ');

  card.addEventListener('dragstart', (event) => {
    if (!event.dataTransfer) return;
    const payload = {
      blockId: card.dataset.blockId,
      lectureId: card.dataset.lectureId,
      passOrder: Number(card.dataset.passOrder),
      due: card.dataset.passDue ? Number(card.dataset.passDue) : null
    };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/json', JSON.stringify(payload));
    onDrag?.(payload);
  });
  return card;
}

function createDayColumn(dayTs) {
  const column = document.createElement('div');
  column.className = 'block-board-day-column';
  column.dataset.day = String(dayTs);
  const header = document.createElement('div');
  header.className = 'block-board-day-header';
  header.textContent = formatDay(dayTs);
  if (startOfDay(Date.now()) === dayTs) {
    column.classList.add('today');
  }
  column.appendChild(header);
  const list = document.createElement('div');
  list.className = 'block-board-day-list';
  column.appendChild(list);
  column.addEventListener('dragover', (event) => {
    event.preventDefault();
    column.classList.add('dropping');
  });
  column.addEventListener('dragleave', () => {
    column.classList.remove('dropping');
  });
  return column;
}

function scrollGridToToday(grid) {
  if (!grid) return;
  const todayColumn = grid.querySelector('.block-board-day-column.today');
  if (!todayColumn) return;
  if (grid.scrollWidth <= grid.clientWidth + 1) return;
  const apply = () => {
    const columnRect = todayColumn.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const relativeLeft = columnRect.left - gridRect.left + grid.scrollLeft;
    const halfWidth = Math.max(0, (grid.clientWidth - todayColumn.clientWidth) / 2);
    const maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
    const target = Math.max(0, Math.min(maxScroll, relativeLeft - halfWidth));
    if (typeof grid.scrollTo === 'function') {
      grid.scrollTo({ left: target, behavior: 'auto' });
    } else {
      grid.scrollLeft = target;
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(apply);
  } else {
    setTimeout(apply, 0);
  }
}

function sortPassEntries(entries) {
  return entries.slice().sort((a, b) => {
    const aComplete = Number.isFinite(a?.pass?.completedAt);
    const bComplete = Number.isFinite(b?.pass?.completedAt);
    if (aComplete !== bComplete) return aComplete ? 1 : -1;
    const orderA = Number.isFinite(a?.pass?.order) ? a.pass.order : Number.POSITIVE_INFINITY;
    const orderB = Number.isFinite(b?.pass?.order) ? b.pass.order : Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;
    const nameA = a?.lecture?.name || '';
    const nameB = b?.lecture?.name || '';
    return nameA.localeCompare(nameB);
  });
}

async function updateLectureSchedule(lecture, updateFn) {
  const updated = updateFn(lecture);
  await persistLecture(updated);
}

function renderUrgentQueues(root, queues, handlers) {
  const wrapper = document.createElement('section');
  wrapper.className = 'block-board-summary';
  const config = [
    { key: 'today', label: "Today's To-Do", empty: 'Nothing due today.', accent: 'var(--blue)' },
    { key: 'tomorrow', label: 'Due Tomorrow', empty: 'Nothing due tomorrow.', accent: 'var(--yellow)' },
    { key: 'overdue', label: 'Overdue', empty: 'No overdue passes. 🎉', accent: 'var(--rose)' }
  ];
  config.forEach(({ key, label, empty, accent }) => {
    const card = document.createElement('article');
    card.className = 'block-board-summary-card';
    if (accent) card.style.setProperty('--summary-accent', accent);

    const header = document.createElement('div');
    header.className = 'block-board-summary-header';

    const title = document.createElement('h3');
    title.className = 'block-board-summary-title';
    title.textContent = label;
    header.appendChild(title);

    const entries = queues[key] || [];
    const count = document.createElement('span');
    count.className = 'block-board-summary-count';
    count.textContent = String(entries.length);
    header.appendChild(count);

    card.appendChild(header);

    const list = document.createElement('div');
    list.className = 'block-board-summary-list';
    if (!entries.length) {
      const emptyState = document.createElement('div');
      emptyState.className = 'block-board-summary-empty';
      emptyState.textContent = empty || 'Nothing queued.';
      list.appendChild(emptyState);
    } else {
      entries.forEach(entry => {
        const chip = buildPassElement(entry, handlers.onComplete, handlers.onShift);
        list.appendChild(chip);
      });
    }
    card.appendChild(list);
    wrapper.appendChild(card);
  });
  root.appendChild(wrapper);
}

function buildDayAssignments(blockLectures, days) {
  const assignments = new Map();
  blockLectures.forEach(lecture => {
    const passes = Array.isArray(lecture?.passes) ? lecture.passes : [];
    passes.forEach(pass => {
      if (!pass || Number.isFinite(pass.completedAt)) return;
      const due = Number.isFinite(pass.due) ? startOfDay(pass.due) : null;
      const key = due != null ? due : 'unscheduled';
      if (!assignments.has(key)) assignments.set(key, []);
      assignments.get(key).push({ lecture, pass });
    });
  });
  days.forEach(day => {
    if (!assignments.has(day)) assignments.set(day, []);
  });
  const unscheduled = assignments.get('unscheduled');
  if (!unscheduled || !unscheduled.length) {
    assignments.delete('unscheduled');
  }
  return assignments;
}

function attachDropHandlers(column, blockEntries, refresh) {
  column.addEventListener('drop', async (event) => {
    event.preventDefault();
    column.classList.remove('dropping');
    const payloadRaw = event.dataTransfer?.getData('application/json');
    if (!payloadRaw) return;
    let payload;
    try {
      payload = JSON.parse(payloadRaw);
    } catch (err) {
      return;
    }
    const { lectureId, passOrder } = payload || {};
    const lecture = blockEntries.find(item => String(item.lecture?.id) === String(lectureId))?.lecture;
    if (!lecture) return;
    const dayValue = column.dataset.day;
    const targetDay = dayValue ? Number(dayValue) : null;
    const newDue = targetDay != null ? targetDay + (payload?.due != null ? (payload.due % DAY_MS) : 9 * 60 * 60 * 1000) : null;
    await updateLectureSchedule(lecture, lec => applyPassDueUpdate(lec, passOrder, newDue));
    await refresh({ full: true });
  });
}

function renderBlockBoardBlock(container, block, blockLectures, days, refresh, gridScrollState = new Map()) {
  const boardState = ensureBoardState();
  const wrapper = document.createElement('section');
  wrapper.className = 'block-board-block';
  wrapper.dataset.blockId = String(block?.blockId ?? '');
  if (block?.color) {
    wrapper.style.setProperty('--block-accent', block.color);
    wrapper.classList.add('has-accent');
  }

  const header = document.createElement('div');
  header.className = 'block-board-block-header';
  const heading = document.createElement('div');
  heading.className = 'block-board-block-heading';
  const title = document.createElement('h2');
  title.className = 'block-board-block-title';
  title.textContent = block?.title || block?.name || `Block ${block?.blockId}`;
  if (block?.color) {
    title.style.setProperty('--block-accent', block.color);
    title.classList.add('has-accent');
  }
  heading.appendChild(title);

  const metaParts = [];
  const rangeText = blockRangeLabel(block);
  if (rangeText) metaParts.push(rangeText);
  const weekValue = Number(block?.weeks);
  if (Number.isFinite(weekValue) && weekValue > 0) {
    const weeks = Math.round(weekValue);
    metaParts.push(`${weeks} week${weeks === 1 ? '' : 's'}`);
  }
  const span = blockSpanDays(block);
  if (span) metaParts.push(`${span} day${span === 1 ? '' : 's'}`);
  if (metaParts.length) {
    const meta = document.createElement('div');
    meta.className = 'block-board-block-meta';
    meta.textContent = metaParts.join(' • ');
    heading.appendChild(meta);
  }
  header.appendChild(heading);
  const controls = document.createElement('div');
  controls.className = 'block-board-block-controls';
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'btn secondary';
  const blockKey = String(block?.blockId ?? '');
  const isCollapsed = blockKey ? boardState.collapsedBlocks.includes(blockKey) : false;
  collapseBtn.textContent = isCollapsed ? 'Expand' : 'Minimize';
  collapseBtn.addEventListener('click', () => {
    if (!blockKey) return;
    const current = ensureBoardState();
    const nextCollapsed = new Set((current.collapsedBlocks || []).map(String));
    const manualExpanded = new Set((current.manualExpanded || []).map(String));
    const autoCollapsed = new Set((current.autoCollapsed || []).map(String));
    if (nextCollapsed.has(blockKey)) {
      nextCollapsed.delete(blockKey);
      manualExpanded.add(blockKey);
      autoCollapsed.delete(blockKey);
    } else {
      nextCollapsed.add(blockKey);
      manualExpanded.delete(blockKey);
      autoCollapsed.delete(blockKey);
    }
    setBlockBoardState({
      collapsedBlocks: Array.from(nextCollapsed),
      manualExpanded: Array.from(manualExpanded),
      autoCollapsed: Array.from(autoCollapsed)
    });
    refresh();
  });
  controls.appendChild(collapseBtn);
  const hiddenTimelineSet = new Set((boardState.hiddenTimelines || []).map(id => String(id)));
  const timelineHidden = hiddenTimelineSet.has('__all__') || hiddenTimelineSet.has(blockKey);
  const timelineBtn = document.createElement('button');
  timelineBtn.type = 'button';
  timelineBtn.className = 'btn secondary';
  timelineBtn.textContent = timelineHidden ? 'Show timeline' : 'Hide timeline';
  timelineBtn.addEventListener('click', () => {
    if (!blockKey) return;
    const current = ensureBoardState();
    const nextHidden = new Set((current.hiddenTimelines || []).map(id => String(id)));
    const manualTimeline = new Set((current.manualTimeline || []).map(String));
    const autoHidden = new Set((current.autoHidden || []).map(String));
    const hideAll = nextHidden.has('__all__');
    nextHidden.delete('__all__');
    if (timelineHidden) {
      nextHidden.delete(blockKey);
      manualTimeline.add(blockKey);
      autoHidden.delete(blockKey);
    } else {
      nextHidden.add(blockKey);
      manualTimeline.delete(blockKey);
      autoHidden.delete(blockKey);
    }
    if (hideAll) {
      nextHidden.add('__all__');
    }
    setBlockBoardState({
      hiddenTimelines: Array.from(nextHidden),
      manualTimeline: Array.from(manualTimeline),
      autoHidden: Array.from(autoHidden)
    });
    refresh();
  });
  controls.appendChild(timelineBtn);
  header.appendChild(controls);
  wrapper.appendChild(header);

  const assignments = buildDayAssignments(blockLectures, days);
  const unscheduledEntries = sortPassEntries(assignments.get('unscheduled') || []);
  assignments.delete('unscheduled');

  const blockEntries = [];
  assignments.forEach(entries => {
    sortPassEntries(entries).forEach(entry => blockEntries.push(entry));
  });
  unscheduledEntries.forEach(entry => blockEntries.push(entry));

  if (!timelineHidden) {
    const timelineData = collectTimelineSegments(blockLectures, days);
    const timeline = document.createElement('div');
    timeline.className = 'block-board-timeline';

    const timelineHeader = document.createElement('div');
    timelineHeader.className = 'block-board-timeline-header';
    const timelineTitle = document.createElement('h3');
    timelineTitle.className = 'block-board-timeline-title';
    timelineTitle.textContent = `Block Timeline — ${block?.title || block?.name || 'Block'}`;
    timelineHeader.appendChild(timelineTitle);

    const spanCount = blockSpanDays(block) || days.length;
    const spanLabel = document.createElement('span');
    spanLabel.className = 'block-board-timeline-span';
    spanLabel.textContent = `${spanCount} day${spanCount === 1 ? '' : 's'}`;
    timelineHeader.appendChild(spanLabel);

    timeline.appendChild(timelineHeader);

    const track = document.createElement('div');
    track.className = 'block-board-timeline-track';
    const todayKey = startOfDay(Date.now());
    timelineData.forEach(({ day, entries }) => {
      const column = document.createElement('div');
      column.className = 'block-board-timeline-column';
      if (day === todayKey) {
        column.classList.add('is-today');
      }
      const date = new Date(day);

      const isoDate = Number.isFinite(day) ? date.toISOString().slice(0, 10) : '';
      const tooltip = isoDate ? `${isoDate} • ${entries.length} due` : `${date.toLocaleDateString()} • ${entries.length} due`;
      column.setAttribute('data-count', String(entries.length));

      const bar = document.createElement('div');
      bar.className = 'block-board-timeline-bar';
      bar.title = tooltip;

      const count = entries.length;
      if (count > 0) {
        const hasCompleted = entries.some(entry => entry.completed);
        if (hasCompleted) {
          bar.classList.add('has-complete');
        } else {
          bar.classList.add('is-pending');
        }
        const gap = 0;
        let segmentHeight = TIMELINE_BASE_UNIT_HEIGHT;
        const gapTotal = gap * Math.max(0, count - 1);
        let totalHeight = segmentHeight * count + gapTotal;
        if (totalHeight > TIMELINE_MAX_BAR_HEIGHT) {
          const available = Math.max(TIMELINE_MAX_BAR_HEIGHT - gapTotal, TIMELINE_MIN_SEGMENT_HEIGHT * count);
          segmentHeight = Math.max(TIMELINE_MIN_SEGMENT_HEIGHT, available / count);
          totalHeight = segmentHeight * count + gapTotal;
        }
        bar.style.height = `${Math.max(totalHeight, TIMELINE_MIN_SEGMENT_HEIGHT)}px`;
        entries.forEach(entry => {
          const segment = document.createElement('div');
          segment.className = 'block-board-timeline-segment';
          segment.style.setProperty('--segment-color', passColor(entry.order));
          segment.style.height = `${segmentHeight}px`;
          if (entry.completed) {
            segment.classList.add('is-complete');
          } else {
            segment.classList.add('is-pending');
          }
          bar.appendChild(segment);
        });
      } else {
        bar.classList.add('is-empty');
      }
      column.appendChild(bar);

      const label = document.createElement('div');
      label.className = 'block-board-timeline-day';
      label.textContent = date.getDate();

      label.setAttribute('aria-hidden', 'true');
      column.appendChild(label);

      if (tooltip) {
        column.setAttribute('aria-label', tooltip);
      }


      track.appendChild(column);
    });
    timeline.appendChild(track);
    wrapper.appendChild(timeline);
  }

  if (isCollapsed) {
    container.appendChild(wrapper);
    return;
  }

  if (unscheduledEntries.length) {
    const backlog = document.createElement('div');
    backlog.className = 'block-board-backlog';
    const backlogTitle = document.createElement('h3');
    backlogTitle.className = 'block-board-backlog-title';
    backlogTitle.textContent = 'Needs a date';
    backlog.appendChild(backlogTitle);
    const backlogHint = document.createElement('p');
    backlogHint.className = 'block-board-backlog-hint';
    backlogHint.textContent = 'Drag a pass onto a day to schedule it.';
    backlog.appendChild(backlogHint);
    const backlogList = document.createElement('div');
    backlogList.className = 'block-board-backlog-list';
    unscheduledEntries.forEach(entry => {
      const card = createPassCard(entry);
      backlogList.appendChild(card);
    });
    backlog.appendChild(backlogList);
    wrapper.appendChild(backlog);
  }

  const board = document.createElement('div');
  board.className = 'block-board-grid';

  days.forEach(day => {
    const column = createDayColumn(day);
    const entries = sortPassEntries(assignments.get(day) || []);
    entries.forEach(entry => {
      const card = createPassCard(entry);
      column.querySelector('.block-board-day-list').appendChild(card);
    });
    attachDropHandlers(column, blockEntries, refresh);
    board.appendChild(column);
  });

  wrapper.appendChild(board);

  const blockId = String(block?.blockId ?? '');
  if (blockId && !gridScrollState.has(blockId)) {
    scrollGridToToday(board);
  }

  container.appendChild(wrapper);
}

export async function renderBlockBoard(container, refresh) {
  if (!container) return;
  const scrollSnapshot = captureBoardScrollState(container);
  container.innerHTML = '';
  container.classList.add('block-board-container');

  const boardState = ensureBoardState();
  const [catalog, lectures] = await Promise.all([
    loadCatalog(),
    fetchLectures()
  ]);
  let settings = null;
  try {
    settings = await fetchSettings();
  } catch (err) {
    settings = null;
  }
  const { blocks } = catalog;
  setPassColorPalette(settings?.plannerDefaults?.passColors);
  if (Array.isArray(blocks) && blocks.length) {
    const validBlockIds = new Set();
    blocks.forEach(block => {
      if (!block || block.blockId == null) return;
      validBlockIds.add(String(block.blockId));
    });

    const normalizedCollapsed = new Set((boardState.collapsedBlocks || []).map(id => String(id)));
    const hideAllTimelines = Array.isArray(boardState.hiddenTimelines)
      ? boardState.hiddenTimelines.includes('__all__')
      : false;
    const normalizedHidden = new Set(
      (boardState.hiddenTimelines || [])
        .map(id => String(id))
        .filter(id => id !== '__all__')
    );
    const manualExpanded = new Set((boardState.manualExpanded || []).map(id => String(id)));
    const manualTimeline = new Set((boardState.manualTimeline || []).map(id => String(id)));
    const autoCollapsed = new Set((boardState.autoCollapsed || []).map(id => String(id)));
    const autoHidden = new Set((boardState.autoHidden || []).map(id => String(id)));

    let manualExpandedChanged = false;
    let manualTimelineChanged = false;
    let autoCollapsedChanged = false;
    let autoHiddenChanged = false;
    manualExpanded.forEach(id => {
      if (!validBlockIds.has(id)) {
        manualExpanded.delete(id);
        manualExpandedChanged = true;
      }
    });
    manualTimeline.forEach(id => {
      if (!validBlockIds.has(id)) {
        manualTimeline.delete(id);
        manualTimelineChanged = true;
      }
    });
    autoCollapsed.forEach(id => {
      if (!validBlockIds.has(id)) {
        autoCollapsed.delete(id);
        autoCollapsedChanged = true;
      }
    });
    autoHidden.forEach(id => {
      if (!validBlockIds.has(id)) {
        autoHidden.delete(id);
        autoHiddenChanged = true;
      }
    });

    const latestBlockId = resolveLatestBlockId(blocks);
    let collapsedChanged = false;
    let hiddenChanged = false;
    blocks.forEach(block => {
      if (!block || block.blockId == null) return;
      const blockId = String(block.blockId);
      const isLatest = latestBlockId != null && blockId === latestBlockId;
      const keepOpen = isLatest || manualExpanded.has(blockId);
      if (keepOpen) {
        if (normalizedCollapsed.has(blockId) && autoCollapsed.has(blockId)) {
          normalizedCollapsed.delete(blockId);
          collapsedChanged = true;
        }
        if (autoCollapsed.delete(blockId)) {
          autoCollapsedChanged = true;
        }
      } else if (!normalizedCollapsed.has(blockId)) {
        normalizedCollapsed.add(blockId);
        collapsedChanged = true;
        if (!autoCollapsed.has(blockId)) {
          autoCollapsed.add(blockId);
          autoCollapsedChanged = true;
        }
      }

      if (!hideAllTimelines) {
        const manualShow = manualTimeline.has(blockId);
        const shouldAutoHide = !keepOpen && !manualShow;
        if (shouldAutoHide) {
          if (!normalizedHidden.has(blockId)) {
            normalizedHidden.add(blockId);
            hiddenChanged = true;
          }
          if (!autoHidden.has(blockId)) {
            autoHidden.add(blockId);
            autoHiddenChanged = true;
          }
        } else {
          const wasAutoHidden = autoHidden.has(blockId);
          if (wasAutoHidden && normalizedHidden.has(blockId) && (manualShow || keepOpen)) {
            normalizedHidden.delete(blockId);
            hiddenChanged = true;
          }
          if (wasAutoHidden) {
            autoHidden.delete(blockId);
            autoHiddenChanged = true;
          }
        }
      }
    });

    const collapsedArr = Array.from(normalizedCollapsed);
    const hiddenArr = hideAllTimelines ? ['__all__'] : Array.from(normalizedHidden);
    const manualExpandedArr = Array.from(manualExpanded);
    const manualTimelineArr = Array.from(manualTimeline);
    const autoCollapsedArr = Array.from(autoCollapsed);
    const autoHiddenArr = Array.from(autoHidden);

    const arraysEqual = (a = [], b = []) => {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    };

    const patch = {};
    if (!arraysEqual(boardState.collapsedBlocks || [], collapsedArr)) {
      patch.collapsedBlocks = collapsedArr;
    }
    if (!arraysEqual(boardState.hiddenTimelines || [], hiddenArr)) {
      patch.hiddenTimelines = hiddenArr;
    }
    if (manualExpandedChanged || !arraysEqual(boardState.manualExpanded || [], manualExpandedArr)) {
      patch.manualExpanded = manualExpandedArr;
    }
    if (manualTimelineChanged || !arraysEqual(boardState.manualTimeline || [], manualTimelineArr)) {
      patch.manualTimeline = manualTimelineArr;
    }
    if (autoCollapsedChanged || !arraysEqual(boardState.autoCollapsed || [], autoCollapsedArr)) {
      patch.autoCollapsed = autoCollapsedArr;
    }
    if (autoHiddenChanged || !arraysEqual(boardState.autoHidden || [], autoHiddenArr)) {
      patch.autoHidden = autoHiddenArr;
    }
    if (Object.keys(patch).length) {
      setBlockBoardState(patch);
      if (patch.collapsedBlocks) boardState.collapsedBlocks = patch.collapsedBlocks;
      if (patch.hiddenTimelines) boardState.hiddenTimelines = patch.hiddenTimelines;
      if (patch.manualExpanded) boardState.manualExpanded = patch.manualExpanded;
      if (patch.manualTimeline) boardState.manualTimeline = patch.manualTimeline;
      if (patch.autoCollapsed) boardState.autoCollapsed = patch.autoCollapsed;
      if (patch.autoHidden) boardState.autoHidden = patch.autoHidden;
    }
  }
  const fallbackDays = collectDefaultBoardDays();

  const refreshBoard = async (options = {}) => {
    if (options && options.full && typeof refresh === 'function') {
      await refresh();
    } else {
      await renderBlockBoard(container, refresh);
    }
  };

  const queues = groupLectureQueues(lectures);

  const urgentHost = document.createElement('div');
  renderUrgentQueues(urgentHost, queues, {
    onComplete: async (entry) => {
      const passOrder = entry?.pass?.order;
      const lecture = entry?.lecture;
      if (!lecture || !Number.isFinite(passOrder)) return;
      const passIndex = Array.isArray(lecture.passes)
        ? lecture.passes.findIndex(pass => pass?.order === passOrder)
        : -1;
      if (passIndex < 0) return;
      await updateLectureSchedule(lecture, lec => markPassCompleted(lec, passIndex));
      await refreshBoard({ full: true });
    },
    onShift: async (entry, mode) => {
      if (!entry?.lecture) return;
      const lecture = entry.lecture;
      const passOrder = Number(entry?.pass?.order);
      if (!Number.isFinite(passOrder)) return;
      const lectureLabel = lecture?.name || `Lecture ${lecture?.id ?? ''}`;
      const passLabel = entry?.pass?.label || (Number.isFinite(passOrder) ? `Pass ${passOrder}` : 'Pass');
      const result = await openShiftDialog(mode, {
        description: `${lectureLabel} • ${passLabel}`,
        defaultUnit: 'days',
        defaultValue: 1
      });
      if (!result || !Number.isFinite(result.minutes) || result.minutes <= 0) return;
      const delta = mode === 'push' ? result.minutes : -result.minutes;
      try {
        await updateLectureSchedule(lecture, lec => shiftPassesForScope(lec, passOrder, delta, result.scope));
        await refreshBoard({ full: true });
      } catch (err) {
        console.error('Failed to shift pass timing', err);
      }
    }
  });
  container.appendChild(urgentHost);

  const previousGridScroll = new Map();
  const gridEntries = Array.isArray(scrollSnapshot?.gridScroll) ? scrollSnapshot.gridScroll : [];
  gridEntries.forEach(entry => {
    if (!entry) return;
    const blockId = entry?.blockId;
    if (blockId == null) return;
    previousGridScroll.set(String(blockId), Number(entry?.left) || 0);
  });

  const blockList = document.createElement('div');
  blockList.className = 'block-board-list';
  const lecturesByBlock = new Map();
  lectures.forEach(lecture => {
    const key = String(lecture?.blockId ?? '');
    if (!lecturesByBlock.has(key)) lecturesByBlock.set(key, []);
    lecturesByBlock.get(key).push(lecture);
  });
  blocks.forEach(block => {
    const blockLectures = lecturesByBlock.get(String(block.blockId)) || [];
    const blockDays = collectDaysForBlock(block, blockLectures);
    const daysForBlock = blockDays.length ? blockDays : fallbackDays;
    renderBlockBoardBlock(blockList, block, blockLectures, daysForBlock, refreshBoard, previousGridScroll);
  });
  container.appendChild(blockList);
  restoreBoardScrollState(container, scrollSnapshot);
}

function captureBoardScrollState(container) {
  if (!container || typeof container !== 'object') return null;
  const dayScroll = [];
  container.querySelectorAll('.block-board-day-list').forEach(list => {
    const column = list.closest('.block-board-day-column');
    const block = list.closest('.block-board-block');
    const blockId = block?.dataset?.blockId ?? '';
    const day = column?.dataset?.day ?? '';
    if (blockId && day) {
      dayScroll.push({ key: `${blockId}::${day}`, top: list.scrollTop });
    }
  });
  const gridScroll = [];
  container.querySelectorAll('.block-board-block').forEach(blockEl => {
    const blockId = blockEl?.dataset?.blockId ?? '';
    if (!blockId) return;
    const grid = blockEl.querySelector('.block-board-grid');
    if (!grid) return;
    gridScroll.push({ blockId, left: grid.scrollLeft });
  });
  const snapshot = {
    containerTop: container.scrollTop,
    containerLeft: container.scrollLeft,
    dayScroll,
    gridScroll,
    windowX: typeof window !== 'undefined' ? window.scrollX : null,
    windowY: typeof window !== 'undefined' ? window.scrollY : null
  };
  return snapshot;
}

function restoreBoardScrollState(container, snapshot) {
  if (!container || !snapshot) return;
  const apply = () => {
    if (typeof container.scrollTo === 'function') {
      container.scrollTo(snapshot.containerLeft ?? 0, snapshot.containerTop ?? 0);
    } else {
      container.scrollLeft = snapshot.containerLeft ?? 0;
      container.scrollTop = snapshot.containerTop ?? 0;
    }
    if (snapshot.windowX != null && snapshot.windowY != null && typeof window !== 'undefined') {
      const nav = typeof navigator !== 'undefined'
        ? navigator
        : typeof window.navigator !== 'undefined'
          ? window.navigator
          : null;
      const ua = nav && typeof nav.userAgent === 'string'
        ? nav.userAgent.toLowerCase()
        : '';
      const shouldRestoreWindow = !ua.includes('jsdom') && typeof window.scrollTo === 'function';
      if (shouldRestoreWindow) {
        try {
          window.scrollTo(snapshot.windowX, snapshot.windowY);
        } catch (err) {
          /* ignore unsupported scroll restoration */
        }
      }
    }
    const dayEntries = Array.isArray(snapshot.dayScroll) ? snapshot.dayScroll : [];
    const dayScrollMap = new Map(dayEntries.map(entry => [entry.key, entry.top]));
    if (dayScrollMap.size) {
      container.querySelectorAll('.block-board-block').forEach(blockEl => {
        const blockId = blockEl?.dataset?.blockId ?? '';
        if (!blockId) return;
        blockEl.querySelectorAll('.block-board-day-column').forEach(column => {
          const day = column?.dataset?.day ?? '';
          if (!day) return;
          const key = `${blockId}::${day}`;
          if (!dayScrollMap.has(key)) return;
          const list = column.querySelector('.block-board-day-list');
          if (list) list.scrollTop = dayScrollMap.get(key) ?? 0;
        });
      });
    }
    const gridEntries = Array.isArray(snapshot.gridScroll) ? snapshot.gridScroll : [];
    if (gridEntries.length) {
      const gridScrollMap = new Map(gridEntries.map(entry => [String(entry.blockId ?? ''), Number(entry.left) || 0]));
      container.querySelectorAll('.block-board-block').forEach(blockEl => {
        const blockId = blockEl?.dataset?.blockId ?? '';
        if (!blockId || !gridScrollMap.has(blockId)) return;
        const grid = blockEl.querySelector('.block-board-grid');
        if (!grid) return;
        const target = gridScrollMap.get(blockId);
        if (typeof grid.scrollTo === 'function') {
          grid.scrollTo({ left: target, behavior: 'auto' });
        } else {
          grid.scrollLeft = target;
        }
      });
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(apply);
  } else {
    setTimeout(apply, 0);
  }
}
