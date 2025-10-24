import { state, setLecturesState } from '../../state.js';
import { loadBlockCatalog, invalidateBlockCatalog } from '../../storage/block-catalog.js';
import { saveLecture, deleteLecture, getSettings } from '../../storage/storage.js';
import {
  exportLectureTransfer,
  exportWeekTransfer,
  exportBlockTransfer,
  importLectureTransfer
} from '../../storage/transfers.js';
import { confirmModal } from './confirm.js';
import { debounce, findActiveBlockId } from '../../utils.js';
import {
  DEFAULT_PASS_PLAN,
  clonePassPlan,
  plannerDefaultsToPassPlan,
  deriveLectureStatus,
  calculateNextDue
} from '../../lectures/scheduler.js';
import { LECTURE_PASS_ACTIONS } from '../../lectures/actions.js';
import { passColorForOrder, setPassColorPalette } from './pass-colors.js';

function findLectureScrollContainer(element) {
  if (element && typeof element.closest === 'function') {
    const main = element.closest('main');
    if (main && typeof main.scrollTop === 'number') {
      return main;
    }
  }
  const doc = document.scrollingElement || document.documentElement || document.body;
  return doc;
}

function ensureLectureState() {
  if (!state.lectures) {
    setLecturesState({});
  }
  return state.lectures;
}

function captureLectureViewState() {
  const container = document.querySelector('.lectures-view');
  if (!container) {
    return;
  }
  const openBlocks = Array.from(
    container.querySelectorAll('.lectures-block-group')
  )
    .filter(details => {
      if (!details) return false;
      if (typeof details.open === 'boolean') return details.open;
      return details.hasAttribute('open');
    })
    .map(details => String(details.dataset.blockKey ?? ''));
  const openWeeks = Array.from(container.querySelectorAll('.lectures-week-group'))
    .filter(details => {
      if (!details) return false;
      if (typeof details.open === 'boolean') return details.open;
      return details.hasAttribute('open');
    })
    .map(details => {
      const blockEl = details.closest('.lectures-block-group');
      const blockKey = blockEl?.dataset?.blockKey ?? '';
      const weekValue = details.dataset?.weekValue ?? '';
      return `${String(blockKey)}::${String(weekValue)}`;
    });
  setLecturesState({
    openBlocks,
    openWeeks,
    openSnapshot: Date.now(),
    scrollTop: findLectureScrollContainer(container)?.scrollTop ?? window.scrollY
  });
}

function collectLectures(catalog) {
  const lists = catalog?.lectureLists || {};
  const result = [];
  for (const list of Object.values(lists)) {
    if (!Array.isArray(list)) continue;
    list.forEach(entry => {
      if (entry && typeof entry === 'object') {
        result.push({ ...entry });
      }
    });
  }
  return result;
}

function buildBlockOrderMap(blocks) {
  const order = new Map();
  blocks.forEach((block, index) => {
    if (!block || !block.blockId) return;
    order.set(block.blockId, index);
    order.set(String(block.blockId), index);
  });
  return order;
}

function slugify(value, fallback = 'export') {
  if (value == null) return fallback;
  const text = String(value).toLowerCase();
  const slug = text
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || fallback;
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function describeWeekValue(value) {
  if (value == null || value === '') return 'No week assigned';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return `Week ${numeric}`;
  }
  return `Week ${value}`;
}

function detectImportConflicts(bundle, catalog) {
  if (!bundle || typeof bundle !== 'object') {
    return { hasConflicts: false };
  }
  const scopeRaw = typeof bundle.scope === 'string' ? bundle.scope.toLowerCase() : 'lecture';
  const scope = scopeRaw === 'block' || scopeRaw === 'week' ? scopeRaw : 'lecture';
  const blockId = bundle.block && bundle.block.blockId != null ? String(bundle.block.blockId) : '';
  const blocks = Array.isArray(catalog?.blocks) ? catalog.blocks : [];
  const lectureLists = catalog?.lectureLists || {};
  const lectureIndex = catalog?.lectureIndex || {};
  const blockInfo = blocks.find(block => String(block?.blockId) === blockId) || null;
  const blockTitle = blockInfo?.title || bundle?.block?.title || blockId || 'Block';
  const blockExists = Boolean(blockInfo);
  const conflicts = {
    scope,
    blockId,
    blockTitle,
    blockExists: scope === 'block' && blockExists,
    weeks: [],
    lectures: []
  };
  const existingLectures = lectureIndex[blockId] || {};
  const weekSet = new Set();
  if (Array.isArray(bundle?.lectures)) {
    bundle.lectures.forEach(lecture => {
      const lectureId = lecture?.id;
      const hasLectureConflict = Object.values(existingLectures).some(existing => {
        if (!existing) return false;
        const existingId = existing.id;
        if (Number.isFinite(Number(existingId)) && Number.isFinite(Number(lectureId))) {
          return Number(existingId) === Number(lectureId);
        }
        return String(existingId) === String(lectureId);
      });
      if (hasLectureConflict) {
        conflicts.lectures.push({
          id: lectureId,
          name: lecture?.name || `Lecture ${lectureId}`
        });
      }
      if (scope !== 'lecture') {
        const weekValue = lecture?.week == null ? null : lecture.week;
        if (!weekSet.has(weekValue)) {
          const existingWeek = (lectureLists[blockId] || []).some(entry => {
            const entryWeek = entry?.week == null ? null : entry.week;
            return entryWeek === weekValue;
          });
          if (existingWeek) {
            conflicts.weeks.push(weekValue);
          }
          weekSet.add(weekValue);
        }
      }
    });
  }
  conflicts.hasConflicts = conflicts.blockExists || conflicts.weeks.length > 0 || conflicts.lectures.length > 0;
  return conflicts;
}

function promptImportStrategy(conflicts) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal import-conflict-modal';

    const card = document.createElement('div');
    card.className = 'card import-conflict-card';

    const title = document.createElement('h3');
    title.textContent = 'Content already exists';
    card.appendChild(title);

    const message = document.createElement('p');
    message.textContent = 'Choose whether to replace the existing content or merge the new material.';
    card.appendChild(message);

    const list = document.createElement('ul');
    list.className = 'import-conflict-list';

    if (conflicts.blockExists) {
      const item = document.createElement('li');
      item.textContent = `Block "${conflicts.blockTitle}" already exists.`;
      list.appendChild(item);
    }
    if (Array.isArray(conflicts.weeks) && conflicts.weeks.length) {
      const item = document.createElement('li');
      const labels = conflicts.weeks.map(describeWeekValue).join(', ');
      item.textContent = `Week assignments already exist: ${labels}.`;
      list.appendChild(item);
    }
    if (Array.isArray(conflicts.lectures) && conflicts.lectures.length) {
      const item = document.createElement('li');
      const names = conflicts.lectures.map(entry => entry.name || `Lecture ${entry.id}`).join(', ');
      item.textContent = `Lectures already exist: ${names}.`;
      list.appendChild(item);
    }

    if (list.childElementCount) {
      card.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.className = 'row import-conflict-actions';

    function cleanup(result) {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
      resolve(result);
    }

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.className = 'btn';
    replaceBtn.textContent = 'Replace';
    replaceBtn.addEventListener('click', () => cleanup('replace'));

    const mergeBtn = document.createElement('button');
    mergeBtn.type = 'button';
    mergeBtn.className = 'btn secondary';
    mergeBtn.textContent = 'Merge';
    mergeBtn.addEventListener('click', () => cleanup('merge'));

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => cleanup(null));

    actions.appendChild(replaceBtn);
    actions.appendChild(mergeBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);

    overlay.appendChild(card);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        cleanup(null);
      }
    });

    document.body.appendChild(overlay);
    replaceBtn.focus();
  });
}

function normalizeWeekValue(value) {
  if (value == null || value === '') return '';
  return String(value);
}

function formatWeekLabel(week) {
  if (week == null || week === '') return '—';
  const num = Number(week);
  if (!Number.isFinite(num)) return String(week);
  return `Week ${num}`;
}

function collectBlockWeekOptions(blockId, blocks = [], lectureLists = {}) {
  if (!blockId) return [];
  const normalizedId = String(blockId);
  const blockInfo = blocks.find(block => String(block?.blockId) === normalizedId) || null;
  const result = new Set();
  const weeksValue = Number(blockInfo?.weeks);
  if (Number.isFinite(weeksValue) && weeksValue > 0) {
    const total = Math.max(1, Math.round(weeksValue));
    for (let i = 1; i <= total; i += 1) {
      result.add(i);
    }
  }
  const list = Array.isArray(lectureLists?.[normalizedId]) ? lectureLists[normalizedId] : [];
  list.forEach(entry => {
    const weekNum = Number(entry?.week);
    if (Number.isFinite(weekNum) && weekNum >= 0) {
      result.add(weekNum);
    }
  });
  return Array.from(result).sort((a, b) => a - b);
}

function populateWeekSelect(select, blockId, blocks, lectureLists, options = {}) {
  if (!select) return;
  const {
    selectedValue = '',
    includeBlank = true,
    blankLabel = 'No week'
  } = options;
  const normalizedValue = normalizeWeekValue(selectedValue);
  select.innerHTML = '';
  if (includeBlank) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankLabel;
    select.appendChild(blank);
  }
  const weeks = collectBlockWeekOptions(blockId, blocks, lectureLists);
  weeks.forEach(week => {
    const option = document.createElement('option');
    option.value = String(week);
    option.textContent = formatWeekLabel(week);
    select.appendChild(option);
  });
  if (normalizedValue && !weeks.some(week => String(week) === normalizedValue)) {
    const custom = document.createElement('option');
    custom.value = normalizedValue;
    custom.textContent = formatWeekLabel(normalizedValue);
    select.appendChild(custom);
  }
  select.value = normalizedValue;
}

function formatOffset(minutes) {
  if (!Number.isFinite(minutes)) return '0m';
  const abs = Math.abs(minutes);
  if (abs < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (Math.abs(hours) < 24) return `${Math.round(hours)}h`;
  const days = minutes / (60 * 24);
  if (Math.abs(days) < 7) return `${Math.round(days)}d`;
  const weeks = minutes / (60 * 24 * 7);
  if (Math.abs(weeks) < 4) return `${Math.round(weeks)}w`;
  const months = minutes / (60 * 24 * 30);
  return `${Math.round(months)}mo`;
}

const OFFSET_UNITS = [
  { id: 'minutes', label: 'minutes', minutes: 1 },
  { id: 'hours', label: 'hours', minutes: 60 },
  { id: 'days', label: 'days', minutes: 60 * 24 },
  { id: 'weeks', label: 'weeks', minutes: 60 * 24 * 7 }
];

function normalizeOffsetUnit(id) {
  const fallback = OFFSET_UNITS[2];
  if (typeof id !== 'string') return fallback.id;
  const match = OFFSET_UNITS.find(option => option.id === id);
  return match ? match.id : fallback.id;
}

function splitOffsetMinutes(minutes) {
  const value = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  if (value === 0) {
    return { value: 0, unit: 'days' };
  }
  const preferred = [...OFFSET_UNITS].reverse().find(option => value % option.minutes === 0);
  if (preferred) {
    return { value: Math.round(value / preferred.minutes), unit: preferred.id };
  }
  if (value < 60) {
    return { value, unit: 'minutes' };
  }
  if (value < 60 * 24) {
    return { value: Math.round(value / 60), unit: 'hours' };
  }
  return { value: Math.round(value / (60 * 24)), unit: 'days' };
}

function combineOffsetValueUnit(value, unitId) {
  const normalizedUnit = normalizeOffsetUnit(unitId);
  const option = OFFSET_UNITS.find(entry => entry.id === normalizedUnit) || OFFSET_UNITS[2];
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(numeric * option.minutes));
}

const PASS_DUE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
});

const PASS_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
});

function formatDateForInput(timestamp = Date.now()) {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value) {
  if (typeof value !== 'string' || !value) return null;
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const date = new Date(year, month, day, 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function passAccent(order = 1) {
  return passColorForOrder(order);
}

function formatPassDueTimestamp(due) {
  if (!Number.isFinite(due)) return '';
  const date = new Date(due);
  return `${PASS_DUE_FORMAT.format(date)} • ${PASS_TIME_FORMAT.format(date)}`;
}

function describePassCountdown(due, now = Date.now()) {
  if (!Number.isFinite(due)) return 'Unscheduled';
  const diffMs = due - now;
  const dayMs = 24 * 60 * 60 * 1000;
  if (Math.abs(diffMs) < dayMs) {
    return diffMs >= 0 ? 'Due today' : 'Overdue today';
  }
  if (diffMs > 0) {
    const days = Math.ceil(diffMs / dayMs);
    return days === 1 ? 'In 1 day' : `In ${days} days`;
  }
  const overdueDays = Math.ceil(Math.abs(diffMs) / dayMs);
  return overdueDays === 1 ? '1 day overdue' : `${overdueDays} days overdue`;
}

function buildPassDisplayList(lecture) {
  const scheduleList = Array.isArray(lecture?.passPlan?.schedule)
    ? lecture.passPlan.schedule
    : [];
  const scheduleByOrder = new Map();
  scheduleList.forEach((step, index) => {
    const order = Number.isFinite(step?.order) ? step.order : index + 1;
    scheduleByOrder.set(order, { ...step, order });
  });
  const passes = Array.isArray(lecture?.passes) ? lecture.passes : [];
  const passByOrder = new Map();
  passes.forEach(pass => {
    const order = Number(pass?.order);
    if (Number.isFinite(order)) {
      passByOrder.set(order, pass);
    }
  });
  const orders = new Set([
    ...scheduleByOrder.keys(),
    ...passByOrder.keys()
  ]);
  if (!orders.size) {
    const planLength = scheduleList.length;
    for (let i = 1; i <= planLength; i += 1) {
      orders.add(i);
    }
  }
  return Array.from(orders)
    .filter(order => Number.isFinite(order))
    .sort((a, b) => a - b)
    .map(order => {
      const schedule = scheduleByOrder.get(order) || {};
      const pass = passByOrder.get(order) || {};
      return {
        order,
        label: schedule.label || pass.label || `Pass ${order}`,
        action: schedule.action || pass.action || '',
        due: Number.isFinite(pass?.due) ? pass.due : null,
        completedAt: Number.isFinite(pass?.completedAt) ? pass.completedAt : null,
        offsetMinutes: Number.isFinite(schedule?.offsetMinutes) ? schedule.offsetMinutes : null,
        anchor: schedule.anchor || pass.anchor || null
      };
    });
}

function createPassChipDisplay(info, now = Date.now(), options = {}) {
  const { onOpen, onToggle } = options || {};
  const chip = document.createElement('div');
  chip.className = 'lecture-pass-chip';
  chip.style.setProperty('--chip-accent', passAccent(info?.order));
  chip.dataset.passOrder = String(info?.order ?? '');
  chip.setAttribute('role', 'button');
  chip.tabIndex = 0;

  const passTitle = info?.action || info?.label || `Pass ${info?.order ?? ''}`;
  const statusWrap = document.createElement('div');
  statusWrap.className = 'lecture-pass-chip-status';

  const toggleButton = document.createElement('button');
  toggleButton.type = 'button';
  toggleButton.className = 'lecture-pass-chip-toggle';
  toggleButton.setAttribute('aria-label', `Mark ${passTitle} as complete`);
  toggleButton.setAttribute('aria-pressed', 'false');

  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'lecture-pass-chip-toggle-icon';
  toggleIcon.setAttribute('aria-hidden', 'true');
  toggleIcon.textContent = '✓';

  toggleButton.append(toggleIcon);
  statusWrap.appendChild(toggleButton);
  chip.appendChild(statusWrap);

  const body = document.createElement('div');
  body.className = 'lecture-pass-chip-body';
  chip.appendChild(body);

  const header = document.createElement('div');
  header.className = 'lecture-pass-chip-header';
  const badge = document.createElement('span');
  badge.className = 'lecture-pass-chip-order';
  badge.textContent = `P${info?.order ?? ''}`;
  header.appendChild(badge);

  const defaultLabel = `Pass ${info?.order ?? ''}`.trim();
  const primaryText = (info?.action || '').trim();
  const fallbackText = (info?.label || '').trim();
  const functionText = primaryText || (fallbackText && fallbackText !== defaultLabel ? fallbackText : '');
  if (functionText) {
    const functionEl = document.createElement('span');
    functionEl.className = 'lecture-pass-chip-function';
    functionEl.textContent = functionText;
    header.appendChild(functionEl);
  }
  body.appendChild(header);

  const timing = document.createElement('div');
  timing.className = 'lecture-pass-chip-due';
  timing.textContent = Number.isFinite(info?.due)
    ? formatPassDueTimestamp(info.due)
    : 'No scheduled date';
  body.appendChild(timing);

  const countdown = document.createElement('div');
  countdown.className = 'lecture-pass-chip-countdown';
  countdown.textContent = describePassCountdown(info?.due, now);
  body.appendChild(countdown);

  const isInitiallyComplete = Number.isFinite(info?.completedAt);
  const dueTimestamp = Number.isFinite(info?.due) ? info.due : null;

  function applyCompletionState(complete) {
    chip.classList.toggle('is-complete', complete);
    const overdue = !complete && Number.isFinite(dueTimestamp) && dueTimestamp < now;
    chip.classList.toggle('is-overdue', overdue);
    toggleButton.classList.toggle('is-active', complete);
    toggleButton.setAttribute('aria-pressed', complete ? 'true' : 'false');
    toggleButton.setAttribute(
      'aria-label',
      complete ? `Mark ${passTitle} as incomplete` : `Mark ${passTitle} as complete`
    );
  }

  applyCompletionState(isInitiallyComplete);

  let busy = false;
  toggleButton.addEventListener('click', async () => {
    if (typeof onToggle !== 'function') return;
    if (busy) return;
    const desired = !toggleButton.classList.contains('is-active');
    busy = true;
    chip.classList.add('is-pending');
    toggleButton.disabled = true;
    try {
      await onToggle(desired);
      applyCompletionState(desired);
    } catch (err) {
      console.error(err);
    }
    chip.classList.remove('is-pending');
    toggleButton.disabled = false;
    busy = false;
  });

  chip.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('.lecture-pass-chip-toggle')) {
      return;
    }
    if (typeof onOpen === 'function') {
      onOpen();
    }
  });

  chip.addEventListener('keydown', event => {
    if (event.target !== chip) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (typeof onOpen === 'function') onOpen();
    }
  });

  return chip;
}

const MAX_PASS_COUNT = 20;
const DAY_MINUTES = 24 * 60;

function defaultActionForIndex(index) {
  if (!Array.isArray(LECTURE_PASS_ACTIONS) || !LECTURE_PASS_ACTIONS.length) return '';
  const normalized = index % LECTURE_PASS_ACTIONS.length;
  return LECTURE_PASS_ACTIONS[Math.max(0, normalized)];
}

function baseSchedule(plan) {
  if (plan && Array.isArray(plan.schedule)) {
    return plan.schedule;
  }
  return DEFAULT_PASS_PLAN.schedule;
}

function computeDefaultGap(schedule) {
  if (!Array.isArray(schedule) || schedule.length < 2) return DAY_MINUTES;
  const deltas = [];
  for (let i = 1; i < schedule.length; i += 1) {
    const prev = Number(schedule[i - 1]?.offsetMinutes);
    const current = Number(schedule[i]?.offsetMinutes);
    if (Number.isFinite(prev) && Number.isFinite(current)) {
      const delta = current - prev;
      if (delta > 0) deltas.push(delta);
    }
  }
  return deltas.length ? deltas[deltas.length - 1] : DAY_MINUTES;
}

function fallbackAnchor(index) {
  if (index === 0) return 'today';
  if (index === 1) return 'tomorrow';
  return 'upcoming';
}

function buildScheduleTemplate(plan, count) {
  const template = baseSchedule(plan);
  const numericCount = Number(count);
  const safeCount = Math.max(0, Number.isFinite(numericCount) ? Math.round(numericCount) : 0);
  const defaultGap = computeDefaultGap(template);
  const schedule = [];
  for (let i = 0; i < safeCount; i += 1) {
    const source = template[i] || {};
    const previous = schedule[i - 1] || null;
    const order = i + 1;
    const offset = Number.isFinite(source.offsetMinutes)
      ? source.offsetMinutes
      : previous
        ? previous.offsetMinutes + defaultGap
        : i === 0
          ? 0
          : defaultGap * i;
    const anchor = typeof source.anchor === 'string' && source.anchor.trim()
      ? source.anchor.trim()
      : previous?.anchor || fallbackAnchor(i);
    const label = typeof source.label === 'string' && source.label.trim()
      ? source.label.trim()
      : `Pass ${order}`;
    const action = typeof source.action === 'string' && source.action.trim()
      ? source.action.trim()
      : defaultActionForIndex(i);
    schedule.push({
      order,
      offsetMinutes: offset,
      anchor,
      label,
      action
    });
  }
  return schedule;
}

function adjustPassConfigs(current, count, plan) {
  const template = buildScheduleTemplate(plan || { schedule: current }, count);
  const byOrder = new Map();
  (Array.isArray(current) ? current : []).forEach(entry => {
    const order = Number(entry?.order);
    if (Number.isFinite(order) && !byOrder.has(order)) {
      byOrder.set(order, entry);
    }
  });
  return template.map((step, index) => {
    const existing = byOrder.get(step.order) || current[index] || {};
    const action = typeof existing?.action === 'string' && existing.action.trim()
      ? existing.action.trim()
      : step.action;
    const offsetMinutes = Number.isFinite(existing?.offsetMinutes)
      ? Math.max(0, Math.round(existing.offsetMinutes))
      : step.offsetMinutes;
    const anchor = typeof existing?.anchor === 'string' && existing.anchor.trim()
      ? existing.anchor.trim()
      : step.anchor;
    const label = typeof existing?.label === 'string' && existing.label.trim()
      ? existing.label.trim()
      : step.label;
    return { ...step, action, offsetMinutes, anchor, label };
  });
}

function clampPassCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(MAX_PASS_COUNT, Math.max(0, Math.round(parsed)));
}

function buildPassPlanPayload(passConfigs, existingPlan) {
  const planId = existingPlan && typeof existingPlan.id === 'string' && existingPlan.id.trim()
    ? existingPlan.id.trim()
    : 'custom';
  return {
    id: planId,
    schedule: passConfigs.map((config, index) => {
      const order = index + 1;
      const label = typeof config.label === 'string' && config.label.trim()
        ? config.label.trim()
        : `Pass ${order}`;
      const offset = Number.isFinite(config.offsetMinutes)
        ? Math.max(0, Math.round(config.offsetMinutes))
        : index === 0
          ? 0
          : (passConfigs[index - 1]?.offsetMinutes ?? 0) + DAY_MINUTES;
      const anchor = typeof config.anchor === 'string' && config.anchor.trim()
        ? config.anchor.trim()
        : fallbackAnchor(index);
      const action = typeof config.action === 'string' && config.action.trim()
        ? config.action.trim()
        : defaultActionForIndex(index);
      return {
        order,
        label,
        offsetMinutes: offset,
        anchor,
        action
      };
    })
  };
}

function formatPassPlan(plan) {
  if (!plan || !Array.isArray(plan.schedule) || !plan.schedule.length) {
    return 'No passes scheduled';
  }
  const steps = plan.schedule
    .slice()
    .sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
    .map(step => {
      const action = typeof step?.action === 'string' && step.action.trim()
        ? step.action.trim()
        : `Pass ${step?.order ?? ''}`;
      const offset = formatOffset(step?.offsetMinutes ?? 0);
      return `${action} • ${offset}`;
    });
  return `Plan: ${steps.join(', ')}`;
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

function formatNextDue(nextDueAt, now = Date.now()) {
  if (nextDueAt == null) return 'Not scheduled';
  if (!Number.isFinite(nextDueAt)) return '—';
  if (nextDueAt <= now) return formatOverdue(nextDueAt, now);
  return formatTimeUntil(nextDueAt, now);
}

function formatNextDueDescriptor(nextDueAt, now = Date.now()) {
  if (nextDueAt == null || !Number.isFinite(nextDueAt)) return 'Not scheduled';
  const date = new Date(nextDueAt);
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
  const relative = nextDueAt <= now ? formatOverdue(nextDueAt, now) : formatTimeUntil(nextDueAt, now);
  return `${dateLabel} • ${relative}`;
}

function formatPassSummary(lecture) {
  const total = Array.isArray(lecture?.passes)
    ? lecture.passes.length
    : Array.isArray(lecture?.passPlan?.schedule)
      ? lecture.passPlan.schedule.length
      : 0;
  const completed = Array.isArray(lecture?.passes)
    ? lecture.passes.filter(pass => Number.isFinite(pass?.completedAt)).length
    : lecture?.status?.completedPasses ?? 0;
  const stateLabel = lecture?.status?.state ? lecture.status.state : 'pending';
  return `${completed}/${total} passes • ${stateLabel}`;
}

function renderEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'lectures-empty';
  empty.textContent = 'No lectures found. Use “Add Lecture” to create one.';
  return empty;
}


function computeLecturePassStats(lecture) {
  const passes = Array.isArray(lecture?.passes) ? lecture.passes : [];
  const scheduled = Array.isArray(lecture?.passPlan?.schedule) ? lecture.passPlan.schedule.length : 0;
  const statusTotal = Number.isFinite(lecture?.status?.totalPasses) ? lecture.status.totalPasses : 0;
  let planned = Math.max(scheduled, passes.length, statusTotal);
  const completedFromPasses = passes.filter(pass => Number.isFinite(pass?.completedAt)).length;
  const completedFromStatus = Number.isFinite(lecture?.status?.completedPasses)
    ? lecture.status.completedPasses
    : 0;
  const completed = Math.max(completedFromPasses, completedFromStatus);
  planned = Math.max(planned, completed);
  const remaining = Math.max(0, planned - completed);
  return { planned, completed, remaining };
}

function summarizeLectures(lectures) {
  return (Array.isArray(lectures) ? lectures : []).reduce(
    (acc, lecture) => {
      const stats = computeLecturePassStats(lecture);
      acc.totalPasses += stats.planned;
      acc.completed += stats.completed;
      return acc;
    },
    { totalPasses: 0, completed: 0 }
  );
}

function formatPassTotals(summary) {
  if (!summary || summary.totalPasses === 0) return '0 passes planned';
  return `${summary.completed}/${summary.totalPasses} passes complete`;
}

function labelForWeekKey(weekKey) {
  if (weekKey === '__no-week') return 'No week assigned';
  return formatWeekLabel(weekKey);
}

const LECTURE_SORT_FIELDS = ['position', 'created', 'nextDue'];
const DEFAULT_LECTURE_SORT = { field: 'position', direction: 'asc' };

function normalizeLectureSort(value) {
  if (!value) return { ...DEFAULT_LECTURE_SORT };
  let field = DEFAULT_LECTURE_SORT.field;
  let direction = DEFAULT_LECTURE_SORT.direction;
  if (typeof value === 'string') {
    const parts = value.split('-');
    if (parts.length === 1) {
      field = parts[0];
    } else if (parts.length >= 2) {
      [field, direction] = parts;
    }
  } else if (typeof value === 'object') {
    if (typeof value.field === 'string') field = value.field;
    if (value.direction === 'asc' || value.direction === 'desc') direction = value.direction;
  }
  if (!LECTURE_SORT_FIELDS.includes(field)) {
    field = DEFAULT_LECTURE_SORT.field;
  }
  direction = direction === 'desc' ? 'desc' : 'asc';
  return { field, direction };
}

function formatLectureSortValue(sort) {
  const normalized = normalizeLectureSort(sort);
  return `${normalized.field}-${normalized.direction}`;
}

function describeSortDirectionLabel(field, direction) {
  if (field === 'created') {
    return direction === 'desc' ? 'Newest first' : 'Oldest first';
  }
  if (field === 'nextDue') {
    return direction === 'asc' ? 'Soonest due' : 'Latest due';
  }
  return direction === 'desc' ? 'High → Low' : 'Low → High';
}

function describeSortDirectionAria(field, direction) {
  if (field === 'created') {
    return `Toggle sort order (currently ${direction === 'desc' ? 'newest first' : 'oldest first'})`;
  }
  if (field === 'nextDue') {
    return `Toggle sort order (currently ${direction === 'asc' ? 'soonest due first' : 'latest due first'})`;
  }
  return `Toggle sort order (currently ${direction === 'asc' ? 'ascending' : 'descending'})`;
}

function sortLecturesForDisplay(lectures, sort) {
  const { field, direction } = normalizeLectureSort(sort);
  const multiplier = direction === 'desc' ? -1 : 1;
  const list = Array.isArray(lectures) ? lectures.slice() : [];
  return list.sort((a, b) => {
    let comparison = 0;
    if (field === 'created') {
      const aValue = Number(a?.createdAt);
      const bValue = Number(b?.createdAt);
      const aRank = Number.isFinite(aValue)
        ? aValue
        : direction === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      const bRank = Number.isFinite(bValue)
        ? bValue
        : direction === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      if (aRank !== bRank) {
        comparison = aRank < bRank ? -1 : 1;
      }
    } else if (field === 'nextDue') {
      const aDue = resolveNextDueAt(a);
      const bDue = resolveNextDueAt(b);
      const aRank = Number.isFinite(aDue)
        ? aDue
        : direction === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      const bRank = Number.isFinite(bDue)
        ? bDue
        : direction === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      if (aRank !== bRank) {
        comparison = aRank < bRank ? -1 : 1;
      }
    } else {
      const posA = Number(a?.position);
      const posB = Number(b?.position);
      const posAValid = Number.isFinite(posA);
      const posBValid = Number.isFinite(posB);
      if (posAValid && posBValid && posA !== posB) {
        comparison = posA < posB ? -1 : 1;
      } else if (posAValid && !posBValid) {
        comparison = -1;
      } else if (!posAValid && posBValid) {
        comparison = 1;
      }
    }

    if (comparison !== 0) {
      return comparison * multiplier;
    }

    const nameA = (a?.name || '').toLowerCase();
    const nameB = (b?.name || '').toLowerCase();
    if (nameA && nameB && nameA !== nameB) return nameA.localeCompare(nameB);
    const idA = Number(a?.id);
    const idB = Number(b?.id);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idA - idB;
    return 0;
  });
}

function resolveNextDueAt(lecture) {
  if (Number.isFinite(lecture?.nextDueAt)) return lecture.nextDueAt;
  const passes = Array.isArray(lecture?.passes) ? lecture.passes : [];
  for (const pass of passes) {
    if (!pass || Number.isFinite(pass?.completedAt)) continue;
    if (Number.isFinite(pass?.due)) return pass.due;
  }
  return null;
}

function getLectureState(lecture, stats) {
  if (lecture?.status?.state) return lecture.status.state;
  const counts = stats || computeLecturePassStats(lecture);
  if (!counts.planned) return 'unscheduled';
  if (counts.completed >= counts.planned) return 'complete';
  if (counts.completed > 0) return 'in-progress';
  return 'pending';
}

function renderLectureWeekRow(lecture, onEdit, onDelete, onEditPass, onTogglePass, onExport, now = Date.now()) {
  const row = document.createElement('div');
  row.className = 'lecture-row';
  row.dataset.lectureRow = 'true';
  row.dataset.lectureId = String(lecture.id);
  row.dataset.blockId = String(lecture.blockId ?? '');

  const stats = computeLecturePassStats(lecture);
  const stateLabel = getLectureState(lecture, stats);

  const overviewCell = document.createElement('div');
  overviewCell.className = 'lecture-col lecture-overview lecture-col-lecture';

  const header = document.createElement('div');
  header.className = 'lecture-overview-header';

  const name = document.createElement('span');
  name.className = 'lecture-name';
  name.textContent = lecture.name || `Lecture ${lecture.id}`;
  header.appendChild(name);

  const status = document.createElement('span');
  status.className = 'lecture-status-pill';
  status.dataset.status = stateLabel;
  status.textContent = stateLabel;
  header.appendChild(status);

  overviewCell.appendChild(header);

  const nextDueLine = document.createElement('div');
  nextDueLine.className = 'lecture-next-indicator';
  nextDueLine.textContent = formatNextDueDescriptor(resolveNextDueAt(lecture), now);
  overviewCell.appendChild(nextDueLine);

  if (lecture.position != null) {
    const position = document.createElement('div');
    position.className = 'lecture-overview-position';
    position.textContent = `Position: ${lecture.position}`;
    overviewCell.appendChild(position);
  }

  const tags = Array.isArray(lecture.tags) ? lecture.tags.filter(Boolean) : [];
  if (tags.length) {
    const tagList = document.createElement('div');
    tagList.className = 'lecture-tags';
    tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'lecture-tag';
      chip.textContent = tag;
      tagList.appendChild(chip);
    });
    overviewCell.appendChild(tagList);
  }

  const metrics = document.createElement('div');
  metrics.className = 'lecture-overview-metrics';

  const completedMetric = document.createElement('span');
  completedMetric.className = 'lecture-metric lecture-metric-complete';
  completedMetric.textContent = `${stats.completed} complete`;
  metrics.appendChild(completedMetric);

  const remainingMetric = document.createElement('span');
  remainingMetric.className = 'lecture-metric lecture-metric-remaining';
  remainingMetric.textContent = `${stats.remaining} remaining`;
  metrics.appendChild(remainingMetric);

  overviewCell.appendChild(metrics);

  row.appendChild(overviewCell);

  const passesCell = document.createElement('div');
  passesCell.className = 'lecture-col lecture-passes-cell lecture-col-passes';
  const passScroller = document.createElement('div');
  passScroller.className = 'lecture-pass-scroller';
  const passList = buildPassDisplayList(lecture);
  if (!passList.length) {
    const empty = document.createElement('div');
    empty.className = 'lecture-pass-empty';
    empty.textContent = 'No passes planned';
    passScroller.appendChild(empty);
  } else {
    passList.forEach(info => {
      const chip = createPassChipDisplay(info, now, {
        onOpen: () => onEditPass(lecture, info),
        onToggle: checked => onTogglePass?.(lecture, info, checked)
      });
      passScroller.appendChild(chip);
    });
  }
  passesCell.appendChild(passScroller);
  row.appendChild(passesCell);

  const actions = document.createElement('div');
  actions.className = 'lecture-col lecture-actions lecture-col-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn secondary';
  editBtn.dataset.action = 'edit-lecture';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => onEdit(lecture));
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn secondary';
  deleteBtn.dataset.action = 'delete-lecture';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => onDelete(lecture));
  actions.appendChild(deleteBtn);

  if (typeof onExport === 'function') {
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn secondary';
    exportBtn.dataset.action = 'export-lecture';
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', event => {
      event.stopPropagation();
      onExport(lecture);
    });
    actions.appendChild(exportBtn);
  }

  row.appendChild(actions);

  return row;
}

function renderLectureTable(
  blocks,
  lectures,
  filters,
  onEdit,
  onDelete,
  onEditPass,
  onTogglePass,
  onExportLecture,
  onExportWeek,
  onExportBlock
) {
  const card = document.createElement('section');
  card.className = 'card lectures-card';

  const title = document.createElement('h2');
  title.textContent = 'Lectures';
  card.appendChild(title);

  if (!lectures.length) {
    card.appendChild(renderEmptyState());
    return card;
  }

  const blockMap = new Map();
  blocks.forEach(block => {
    if (!block || block.blockId == null) return;
    blockMap.set(String(block.blockId), block);
  });
  const orderMap = buildBlockOrderMap(blocks);
  const blockFilter = String(filters?.blockId || '').trim();
  const weekFilter = String(filters?.week || '').trim();
  const now = Date.now();
  const sortConfig = normalizeLectureSort(filters?.sort);
  const openSnapshot = Number(filters?.openSnapshot) || 0;
  const storedBlockKeys = new Set(
    Array.isArray(filters?.openBlocks)
      ? filters.openBlocks.map(value => String(value ?? ''))
      : []
  );
  const storedWeekKeys = new Set(
    Array.isArray(filters?.openWeeks)
      ? filters.openWeeks.map(value => String(value ?? ''))
      : []
  );
  const useStoredExpansion = openSnapshot > 0;

  function composeWeekKey(blockKey, weekValue) {
    return `${String(blockKey)}::${String(weekValue)}`;
  }

  function recordBlockOpen(blockKey, isOpen) {
    const key = String(blockKey ?? '');
    const lectureState = ensureLectureState();
    const openBlocks = new Set(
      Array.isArray(lectureState.openBlocks)
        ? lectureState.openBlocks.map(value => String(value ?? ''))
        : []
    );
    const openWeeks = new Set(
      Array.isArray(lectureState.openWeeks)
        ? lectureState.openWeeks.map(value => String(value ?? ''))
        : []
    );
    if (isOpen) {
      openBlocks.add(key);
    } else {
      openBlocks.delete(key);
      Array.from(openWeeks).forEach(entry => {
        if (entry.startsWith(`${key}::`)) {
          openWeeks.delete(entry);
        }
      });
    }
    setLecturesState({
      openBlocks: Array.from(openBlocks),
      openWeeks: Array.from(openWeeks),
      openSnapshot: Date.now()
    });
  }

  function recordWeekOpen(blockKey, weekValue, isOpen) {
    const composite = composeWeekKey(blockKey, weekValue);
    const lectureState = ensureLectureState();
    const openWeeks = new Set(
      Array.isArray(lectureState.openWeeks)
        ? lectureState.openWeeks.map(value => String(value ?? ''))
        : []
    );
    if (isOpen) {
      openWeeks.add(composite);
    } else {
      openWeeks.delete(composite);
    }
    setLecturesState({
      openWeeks: Array.from(openWeeks),
      openSnapshot: Date.now()
    });
  }

  const blockGroups = new Map();

  lectures.forEach(lecture => {
    if (!lecture) return;
    const rawBlockId = lecture.blockId == null || lecture.blockId === '' ? '' : lecture.blockId;
    const key = rawBlockId === '' ? '__no-block' : String(rawBlockId);
    if (!blockGroups.has(key)) {
      const blockInfo = blockMap.get(String(rawBlockId));
      const fallbackTitle = rawBlockId === '' ? 'No block assigned' : `Block ${rawBlockId}`;
      blockGroups.set(key, {
        key,
        blockId: rawBlockId,
        block: blockInfo || { blockId: rawBlockId, title: blockInfo?.title || fallbackTitle, color: blockInfo?.color || null },
        lectures: [],
        weeks: new Map()
      });
    }
    const group = blockGroups.get(key);
    group.lectures.push(lecture);
    const weekKey = lecture.week == null || lecture.week === '' ? '__no-week' : String(lecture.week);
    if (!group.weeks.has(weekKey)) {
      group.weeks.set(weekKey, []);
    }
    group.weeks.get(weekKey).push(lecture);
  });

  const groupsContainer = document.createElement('div');
  groupsContainer.className = 'lectures-groups';

  const sortedGroups = Array.from(blockGroups.values()).sort((a, b) => {
    const ao = orderMap.has(a.blockId) ? orderMap.get(a.blockId) : orderMap.get(String(a.blockId)) ?? Number.POSITIVE_INFINITY;
    const bo = orderMap.has(b.blockId) ? orderMap.get(b.blockId) : orderMap.get(String(b.blockId)) ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const nameA = (a.block?.title || a.block?.name || String(a.blockId || '') || '').toLowerCase();
    const nameB = (b.block?.title || b.block?.name || String(b.blockId || '') || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const activeBlockId = findActiveBlockId(blocks);
  const defaultBlockId = (() => {
    if (blockFilter) return blockFilter;
    if (activeBlockId) return activeBlockId;
    const firstWithId = sortedGroups.find(group => {
      const id = String(group.blockId ?? '');
      return id !== '';
    });
    if (firstWithId) return String(firstWithId.blockId ?? '');
    return String(sortedGroups[0]?.blockId ?? '');
  })();

  sortedGroups.forEach(group => {
    const blockDetails = document.createElement('details');
    blockDetails.className = 'lectures-block-group';
    const normalizedGroupId = String(group.blockId ?? '');
    const blockKey = String(group.key ?? normalizedGroupId);
    blockDetails.dataset.blockId = normalizedGroupId;
    blockDetails.dataset.blockKey = blockKey;
    const blockInfo = group.block || {};
    if (blockInfo.color) {
      blockDetails.style.setProperty('--block-accent', blockInfo.color);
      blockDetails.classList.add('has-accent');
    }

    const blockSummary = document.createElement('summary');
    blockSummary.className = 'lectures-block-summary';

    const blockTitle = document.createElement('span');
    blockTitle.className = 'lectures-block-name';
    blockTitle.textContent = blockInfo.title || blockInfo.name || (group.blockId ? `Block ${group.blockId}` : 'No block assigned');
    blockSummary.appendChild(blockTitle);

    const blockStats = summarizeLectures(group.lectures);
    const blockCounts = document.createElement('span');
    blockCounts.className = 'lectures-block-counts';
    const lectureCount = group.lectures.length;
    const lectureLabel = `${lectureCount} lecture${lectureCount === 1 ? '' : 's'}`;
    blockCounts.textContent = `${lectureLabel} • ${formatPassTotals(blockStats)}`;
    blockSummary.appendChild(blockCounts);

    if (typeof onExportBlock === 'function') {
      const blockExportBtn = document.createElement('button');
      blockExportBtn.type = 'button';
      blockExportBtn.className = 'btn secondary lectures-block-export';
      blockExportBtn.textContent = 'Export block';
      blockExportBtn.addEventListener('click', event => {
        event.stopPropagation();
        onExportBlock(group.block);
      });
      blockSummary.appendChild(blockExportBtn);
    }

    blockDetails.appendChild(blockSummary);

    const weekWrapper = document.createElement('div');
    weekWrapper.className = 'lectures-week-groups';

    const sortedWeeks = Array.from(group.weeks.entries()).sort((aEntry, bEntry) => {
      const [aKey] = aEntry;
      const [bKey] = bEntry;
      if (aKey === '__no-week' && bKey === '__no-week') return 0;
      if (aKey === '__no-week') return 1;
      if (bKey === '__no-week') return -1;
      const aNum = Number(aKey);
      const bNum = Number(bKey);
      if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return bNum - aNum;
      if (Number.isFinite(aNum) && !Number.isFinite(bNum)) return -1;
      if (!Number.isFinite(aNum) && Number.isFinite(bNum)) return 1;
      return String(bKey).localeCompare(String(aKey));
    });

    const matchesWeekFilter = weekFilter
      ? sortedWeeks.some(([weekKey]) => {
          const normalized = weekKey === '__no-week' ? '' : String(weekKey);
          return normalized === weekFilter;
        })
      : false;

    let shouldOpenBlock;
    if (blockFilter) {
      shouldOpenBlock = blockFilter === normalizedGroupId;
    } else if (matchesWeekFilter) {
      shouldOpenBlock = true;
    } else if (useStoredExpansion) {
      shouldOpenBlock = storedBlockKeys.has(blockKey);
    } else {
      shouldOpenBlock = defaultBlockId === normalizedGroupId;
    }
    blockDetails.open = shouldOpenBlock;
    blockDetails.addEventListener('toggle', () => {
      recordBlockOpen(blockKey, blockDetails.open);
    });

    sortedWeeks.forEach(([weekKey, weekLectures], index) => {
      const weekDetails = document.createElement('details');
      weekDetails.className = 'lectures-week-group';
      const normalizedWeek = weekKey === '__no-week' ? '' : String(weekKey);
      weekDetails.dataset.week = normalizedWeek;
      weekDetails.dataset.weekValue = normalizedWeek;
      weekDetails.dataset.weekKey = String(weekKey ?? '');
      const compositeKey = composeWeekKey(blockKey, normalizedWeek);
      let shouldOpenWeek;
      if (weekFilter) {
        shouldOpenWeek = weekFilter === normalizedWeek;
      } else if (useStoredExpansion) {
        shouldOpenWeek = storedWeekKeys.has(compositeKey);
      } else {
        shouldOpenWeek = blockDetails.open && index === 0;
      }
      weekDetails.open = blockDetails.open && shouldOpenWeek;
      weekDetails.addEventListener('toggle', () => {
        recordWeekOpen(blockKey, normalizedWeek, weekDetails.open);
      });

      const weekSummary = document.createElement('summary');
      weekSummary.className = 'lectures-week-summary';

      const weekTitle = document.createElement('span');
      weekTitle.className = 'lectures-week-title';
      weekTitle.textContent = labelForWeekKey(weekKey);
      weekSummary.appendChild(weekTitle);

      const weekStats = summarizeLectures(weekLectures);
      const weekCounts = document.createElement('span');
      weekCounts.className = 'lectures-week-counts';
      const weekLectureCount = weekLectures.length;
      const weekLectureLabel = `${weekLectureCount} lecture${weekLectureCount === 1 ? '' : 's'}`;
      weekCounts.textContent = `${weekLectureLabel} • ${formatPassTotals(weekStats)}`;
      weekSummary.appendChild(weekCounts);

      if (typeof onExportWeek === 'function') {
        const weekExportBtn = document.createElement('button');
        weekExportBtn.type = 'button';
        weekExportBtn.className = 'btn secondary lectures-week-export';
        weekExportBtn.textContent = 'Export week';
        weekExportBtn.addEventListener('click', event => {
          event.stopPropagation();
          const targetWeek = weekLectures[0]?.week == null ? null : weekLectures[0].week;
          onExportWeek(group.block, targetWeek);
        });
        weekSummary.appendChild(weekExportBtn);
      }

      weekDetails.appendChild(weekSummary);

      const weekBody = document.createElement('div');
      weekBody.className = 'lectures-week-body';

      const list = document.createElement('div');
      list.className = 'lectures-week-list';

      const headerRow = document.createElement('div');
      headerRow.className = 'lecture-row lecture-row-header';
      [
        { label: 'Lecture', className: 'lecture-col-lecture' },
        { label: 'Passes', className: 'lecture-col-passes' },
        { label: 'Actions', className: 'lecture-col-actions' }
      ].forEach(column => {
        const cell = document.createElement('div');
        cell.className = `lecture-col ${column.className}`;
        cell.textContent = column.label;
        headerRow.appendChild(cell);
      });
      list.appendChild(headerRow);

      sortLecturesForDisplay(weekLectures, sortConfig).forEach(entry => {
        const row = renderLectureWeekRow(
          entry,
          onEdit,
          onDelete,
          onEditPass,
          onTogglePass,
          lecture => onExportLecture?.(lecture, group.block),
          now
        );
        list.appendChild(row);
      });

      weekBody.appendChild(list);
      weekDetails.appendChild(weekBody);
      weekWrapper.appendChild(weekDetails);
    });

    blockDetails.appendChild(weekWrapper);
    groupsContainer.appendChild(blockDetails);
  });

  card.appendChild(groupsContainer);
  return card;
}

function uniqueStatusValues(lectures) {
  const set = new Set();
  lectures.forEach(lecture => {
    const state = lecture?.status?.state;
    if (state) set.add(state);
  });
  return Array.from(set);
}

function uniqueWeeks(lectures) {
  const set = new Set();
  lectures.forEach(lecture => {
    if (lecture.week == null) {
      set.add('');
    } else {
      set.add(String(lecture.week));
    }
  });
  return Array.from(set)
    .filter(value => value !== '')
    .map(value => Number(value))
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function applyFilters(lectures, filters) {
  const query = (filters.query || '').trim().toLowerCase();
  const blockId = (filters.blockId || '').trim();
  const weekFilter = (filters.week || '').trim();
  const statusFilter = (filters.status || '').trim();
  const tagFilter = (filters.tag || '').trim().toLowerCase();

  return lectures.filter(lecture => {
    if (blockId && String(lecture.blockId) !== blockId) return false;
    if (weekFilter) {
      const week = lecture.week == null ? '' : String(lecture.week);
      if (week !== weekFilter) return false;
    }
    if (statusFilter && statusFilter !== 'all') {
      const statusState = lecture?.status?.state || '';
      if (statusState !== statusFilter) return false;
    }
    if (query) {
      const actionTerms = Array.isArray(lecture?.passPlan?.schedule)
        ? lecture.passPlan.schedule.map(step => step?.action || '')
        : [];
      const haystacks = [lecture.name, lecture.id != null ? String(lecture.id) : '', lecture.blockId, ...actionTerms];
      if (!haystacks.some(value => String(value || '').toLowerCase().includes(query))) {
        return false;
      }
    }
    if (tagFilter) {
      const tags = Array.isArray(lecture.tags) ? lecture.tags : [];
      if (!tags.some(tag => String(tag).toLowerCase().includes(tagFilter))) {
        return false;
      }
    }
    return true;
  });
}

function buildToolbar(blocks, lectures, lectureLists, redraw, defaultPassPlan, onImport) {
  const filters = ensureLectureState();
  const toolbar = document.createElement('div');
  toolbar.className = 'lectures-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Lecture filters');

  const filterGroup = document.createElement('div');
  filterGroup.className = 'lectures-toolbar-filters';
  toolbar.appendChild(filterGroup);

  const actionsGroup = document.createElement('div');
  actionsGroup.className = 'lectures-toolbar-actions';
  toolbar.appendChild(actionsGroup);

  if (typeof onImport === 'function') {
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = 'application/json';
    importInput.style.display = 'none';

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'btn secondary lectures-import-btn';
    importBtn.textContent = 'Import bundle';
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        await onImport(json);
      } catch (err) {
        console.error('Failed to import lecture bundle', err);
        alert('Import failed.');
      } finally {
        importInput.value = '';
      }
    });

    actionsGroup.appendChild(importBtn);
    toolbar.appendChild(importInput);
  }

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'input lectures-search';
  search.placeholder = 'Search lectures';
  search.value = filters.query || '';
  const debouncedSearch = debounce(value => {
    setLecturesState({ query: value });
    redraw();
  }, 150);
  search.addEventListener('input', e => {
    debouncedSearch(e.target.value);
  });
  filterGroup.appendChild(search);

  const sortState = normalizeLectureSort(filters.sort);
  const sortControls = document.createElement('div');
  sortControls.className = 'lectures-sort-controls';

  const sortSelect = document.createElement('select');
  sortSelect.className = 'input lectures-sort-field';
  sortSelect.setAttribute('aria-label', 'Sort lectures');
  [
    { value: 'position', label: 'Manual order' },
    { value: 'created', label: 'Date added' },
    { value: 'nextDue', label: 'Next pass due' }
  ].forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    sortSelect.appendChild(opt);
  });
  sortSelect.value = sortState.field;
  sortSelect.addEventListener('change', () => {
    sortState.field = sortSelect.value;
    syncDirectionControl();
    setLecturesState({ sort: formatLectureSortValue(sortState) });
    redraw();
  });
  sortControls.appendChild(sortSelect);

  const directionBtn = document.createElement('button');
  directionBtn.type = 'button';
  directionBtn.className = 'btn secondary lectures-sort-direction';
  directionBtn.addEventListener('click', () => {
    sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
    syncDirectionControl();
    setLecturesState({ sort: formatLectureSortValue(sortState) });
    redraw();
  });

  function syncDirectionControl() {
    directionBtn.dataset.direction = sortState.direction;
    directionBtn.textContent = describeSortDirectionLabel(sortState.field, sortState.direction);
    directionBtn.setAttribute('aria-label', describeSortDirectionAria(sortState.field, sortState.direction));
  }

  syncDirectionControl();
  sortControls.appendChild(directionBtn);
  filterGroup.appendChild(sortControls);

  const blockSelect = document.createElement('select');
  blockSelect.className = 'input lectures-filter';
  blockSelect.setAttribute('aria-label', 'Filter by block');
  const allBlocksOption = document.createElement('option');
  allBlocksOption.value = '';
  allBlocksOption.textContent = 'All blocks';
  blockSelect.appendChild(allBlocksOption);
  blocks.forEach(block => {
    if (!block || !block.blockId) return;
    const option = document.createElement('option');
    option.value = block.blockId;
    option.textContent = block.title || block.blockId;
    blockSelect.appendChild(option);
  });
  blockSelect.value = filters.blockId || '';
  blockSelect.addEventListener('change', () => {
    setLecturesState({ blockId: blockSelect.value });
    redraw();
  });
  filterGroup.appendChild(blockSelect);

  const weekSelect = document.createElement('select');
  weekSelect.className = 'input lectures-filter';
  weekSelect.setAttribute('aria-label', 'Filter by week');
  const allWeeksOption = document.createElement('option');
  allWeeksOption.value = '';
  allWeeksOption.textContent = 'All weeks';
  weekSelect.appendChild(allWeeksOption);
  uniqueWeeks(lectures).forEach(week => {
    const option = document.createElement('option');
    option.value = String(week);
    option.textContent = `Week ${week}`;
    weekSelect.appendChild(option);
  });
  weekSelect.value = normalizeWeekValue(filters.week);
  weekSelect.addEventListener('change', () => {
    setLecturesState({ week: weekSelect.value });
    redraw();
  });
  filterGroup.appendChild(weekSelect);

  const statuses = uniqueStatusValues(lectures);
  if (statuses.length) {
    const statusSelect = document.createElement('select');
    statusSelect.className = 'input lectures-filter';
    statusSelect.setAttribute('aria-label', 'Filter by status');
    const allStatusOption = document.createElement('option');
    allStatusOption.value = 'all';
    allStatusOption.textContent = 'All statuses';
    statusSelect.appendChild(allStatusOption);
    statuses.sort().forEach(status => {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = status.charAt(0).toUpperCase() + status.slice(1);
      statusSelect.appendChild(option);
    });
    statusSelect.value = filters.status || 'all';
    statusSelect.addEventListener('change', () => {
      setLecturesState({ status: statusSelect.value });
      redraw();
    });
    filterGroup.appendChild(statusSelect);
  }

  const tagSearch = document.createElement('input');
  tagSearch.type = 'search';
  tagSearch.className = 'input lectures-tag-search';
  tagSearch.placeholder = 'Filter tags';
  tagSearch.value = filters.tag || '';
  const debouncedTag = debounce(value => {
    setLecturesState({ tag: value });
    redraw();
  }, 150);
  tagSearch.addEventListener('input', e => {
    debouncedTag(e.target.value);
  });
  filterGroup.appendChild(tagSearch);

  const addBlockSelect = document.createElement('select');
  addBlockSelect.className = 'input lectures-add-select';
  addBlockSelect.setAttribute('aria-label', 'Select block for new lecture');
  const addBlockPlaceholder = document.createElement('option');
  addBlockPlaceholder.value = '';
  addBlockPlaceholder.textContent = 'Select block';
  addBlockSelect.appendChild(addBlockPlaceholder);
  blocks.forEach(block => {
    if (!block || !block.blockId) return;
    const option = document.createElement('option');
    option.value = block.blockId;
    option.textContent = block.title || block.blockId;
    addBlockSelect.appendChild(option);
  });
  const defaultAddBlock = blocks.find(block => block.blockId === filters.blockId)?.blockId
    || (blocks[0]?.blockId ?? '');
  if (defaultAddBlock) {
    addBlockSelect.value = defaultAddBlock;
  }
  actionsGroup.appendChild(addBlockSelect);

  const addWeekSelect = document.createElement('select');
  addWeekSelect.className = 'input lectures-add-select';
  addWeekSelect.setAttribute('aria-label', 'Select week for new lecture');
  actionsGroup.appendChild(addWeekSelect);

  let addWeekValue = normalizeWeekValue(filters.week);
  const updateAddWeekSelect = () => {
    const blockId = addBlockSelect.value;
    const blankLabel = blockId ? 'No week' : 'Select block first';
    populateWeekSelect(addWeekSelect, blockId, blocks, lectureLists, {
      selectedValue: addWeekValue,
      blankLabel
    });
    addWeekSelect.disabled = !blockId;
    addWeekValue = addWeekSelect.value;
  };

  updateAddWeekSelect();

  addBlockSelect.addEventListener('change', () => {
    if (filters.blockId && filters.blockId === addBlockSelect.value) {
      addWeekValue = normalizeWeekValue(filters.week);
    } else {
      addWeekValue = '';
    }
    updateAddWeekSelect();
    syncAddButtonState();
  });

  addWeekSelect.addEventListener('change', () => {
    addWeekValue = addWeekSelect.value;
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn primary add-lecture-btn';
  addBtn.dataset.action = 'add-lecture';
  const addIcon = document.createElement('span');
  addIcon.className = 'add-lecture-btn-icon';
  addIcon.setAttribute('aria-hidden', 'true');
  addIcon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
  const addLabel = document.createElement('span');
  addLabel.className = 'add-lecture-btn-label';
  addLabel.textContent = 'Add lecture';
  addBtn.append(addIcon, addLabel);
  actionsGroup.appendChild(addBtn);

  const syncAddButtonState = () => {
    addBtn.disabled = !blocks.length || !addBlockSelect.value;
  };

  syncAddButtonState();

  addBtn.addEventListener('click', () => {
    const selectedBlockId = addBlockSelect.value || (blocks[0]?.blockId || '');
    if (!selectedBlockId) return;
    const passPlanTemplate = clonePassPlan(
      defaultPassPlan && Array.isArray(defaultPassPlan.schedule) ? defaultPassPlan : undefined
    );
    const rawWeek = addWeekSelect.disabled ? '' : addWeekSelect.value;
    const numericWeek = rawWeek === '' ? '' : Number(rawWeek);
    const selectedWeek = rawWeek === '' || Number.isNaN(numericWeek) ? '' : numericWeek;
    openLectureDialog({
      mode: 'create',
      blocks,
      lectureLists,
      defaults: {
        blockId: selectedBlockId,
        name: '',
        week: selectedWeek === '' ? '' : selectedWeek,
        passPlan: passPlanTemplate,
        startAt: Date.now()
      },
      onSubmit: async payload => {
        await saveLecture(payload);
        await invalidateBlockCatalog();
        await redraw();
      }
    });
  });

  return toolbar;
}

function openLectureDialog(options) {
  const { mode, blocks, defaults = {}, lectureLists = {}, onSubmit } = options;
  const overlay = document.createElement('div');
  overlay.className = 'modal lecture-dialog';
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h2');
  title.textContent = mode === 'edit' ? 'Edit lecture' : 'Add lecture';
  card.appendChild(title);

  const form = document.createElement('form');
  form.className = 'lecture-form';

  const basicsSection = document.createElement('section');
  basicsSection.className = 'lecture-form-section';
  const basicsTitle = document.createElement('h3');
  basicsTitle.className = 'lecture-form-section-title';
  basicsTitle.textContent = 'Lecture details';
  basicsSection.appendChild(basicsTitle);
  const basicsGrid = document.createElement('div');
  basicsGrid.className = 'lecture-form-grid';
  basicsSection.appendChild(basicsGrid);

  const blockField = document.createElement('label');
  blockField.className = 'lecture-form-field';
  blockField.textContent = 'Block';
  const blockSelect = document.createElement('select');
  blockSelect.className = 'input';
  blockSelect.dataset.field = 'blockId';
  blocks.forEach(block => {
    if (!block || !block.blockId) return;
    const option = document.createElement('option');
    option.value = block.blockId;
    option.textContent = block.title || block.blockId;
    blockSelect.appendChild(option);
  });
  blockSelect.value = defaults.blockId || (blocks[0]?.blockId || '');
  if (mode === 'edit') {
    blockSelect.disabled = true;
  }
  blockField.appendChild(blockSelect);
  basicsGrid.appendChild(blockField);

  const nameField = document.createElement('label');
  nameField.className = 'lecture-form-field';
  nameField.dataset.span = 'full';
  nameField.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.placeholder = 'Lecture name';
  nameInput.className = 'input';
  nameInput.dataset.field = 'name';
  nameInput.value = defaults.name ?? '';
  nameField.appendChild(nameInput);
  basicsGrid.appendChild(nameField);

  const weekField = document.createElement('label');
  weekField.className = 'lecture-form-field';
  weekField.textContent = 'Week';
  const weekSelect = document.createElement('select');
  weekSelect.className = 'input';
  weekSelect.dataset.field = 'week';
  weekField.appendChild(weekSelect);
  basicsGrid.appendChild(weekField);

  const defaultStartAt = Number.isFinite(defaults.startAt) ? defaults.startAt : Date.now();
  const startField = document.createElement('label');
  startField.className = 'lecture-form-field';
  startField.textContent = 'First pass date';
  const startInput = document.createElement('input');
  startInput.type = 'date';
  startInput.required = true;
  startInput.className = 'input';
  const startValue = formatDateForInput(defaultStartAt);
  startInput.value = startValue || formatDateForInput(Date.now());
  startField.appendChild(startInput);
  const startHint = document.createElement('span');
  startHint.className = 'lecture-field-hint';
  startHint.textContent = 'Controls when pass 1 begins.';
  startField.appendChild(startHint);
  basicsGrid.appendChild(startField);

  form.appendChild(basicsSection);

  let dialogWeekValue = normalizeWeekValue(defaults.week);
  const updateDialogWeekOptions = () => {
    const blockId = blockSelect.value;
    populateWeekSelect(weekSelect, blockId, blocks, lectureLists, {
      selectedValue: dialogWeekValue,
      blankLabel: 'No week'
    });
    dialogWeekValue = weekSelect.value;
  };

  updateDialogWeekOptions();

  weekSelect.addEventListener('change', () => {
    dialogWeekValue = weekSelect.value;
  });

  const planTemplate = defaults.passPlan && Array.isArray(defaults.passPlan.schedule)
    ? defaults.passPlan
    : clonePassPlan();
  const initialSchedule = Array.isArray(planTemplate.schedule) ? planTemplate.schedule : [];
  const defaultFallbackCount = Array.isArray(DEFAULT_PASS_PLAN.schedule)
    ? DEFAULT_PASS_PLAN.schedule.length
    : 0;
  const initialCount = clampPassCount(
    initialSchedule.length > 0
      ? initialSchedule.length
      : defaults.passPlan
        ? 0
        : defaultFallbackCount
  );
  let passConfigs = adjustPassConfigs(initialSchedule, initialCount, planTemplate);

  const planningSection = document.createElement('section');
  planningSection.className = 'lecture-form-section';
  const planningTitle = document.createElement('h3');
  planningTitle.className = 'lecture-form-section-title';
  planningTitle.textContent = 'Pass planning';
  planningSection.appendChild(planningTitle);

  const passCountField = document.createElement('label');
  passCountField.className = 'lecture-pass-count';
  passCountField.textContent = 'Planned passes';
  const passCountInput = document.createElement('input');
  passCountInput.type = 'number';
  passCountInput.min = '0';
  passCountInput.max = String(MAX_PASS_COUNT);
  passCountInput.className = 'input';
  passCountInput.value = String(passConfigs.length);
  passCountField.appendChild(passCountInput);
  const passHelp = document.createElement('span');
  passHelp.className = 'lecture-pass-help';
  passHelp.textContent = 'Set how many times you want to revisit this lecture.';
  passCountField.appendChild(passHelp);
  planningSection.appendChild(passCountField);

  const passSummary = document.createElement('div');
  passSummary.className = 'lecture-pass-summary-line';
  planningSection.appendChild(passSummary);

  const advanced = document.createElement('details');
  advanced.className = 'lecture-pass-advanced';
  if (mode === 'edit') {
    advanced.open = true;
  }
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = `Advanced pass settings (${passConfigs.length})`;
  advanced.appendChild(advancedSummary);

  const advancedHint = document.createElement('p');
  advancedHint.className = 'lecture-pass-advanced-hint';
  advancedHint.textContent = 'Tune the pass function and timing for each pass.';
  advanced.appendChild(advancedHint);

  const passList = document.createElement('div');
  passList.className = 'lecture-pass-editor';
  advanced.appendChild(passList);
  planningSection.appendChild(advanced);
  form.appendChild(planningSection);

  function updatePassSummary() {
    if (!passConfigs.length) {
      passSummary.textContent = 'No passes scheduled for this lecture.';
    } else {
      const planPreview = buildPassPlanPayload(passConfigs, planTemplate);
      const previewText = formatPassPlan(planPreview);
      const cleaned = previewText.startsWith('Plan: ')
        ? previewText.slice(6)
        : previewText;
      passSummary.textContent = `${passConfigs.length} pass${passConfigs.length === 1 ? '' : 'es'} • ${cleaned}`;
    }
    advancedSummary.textContent = `Advanced pass settings (${passConfigs.length})`;
  }

  function renderPassEditor() {
    passList.innerHTML = '';
    if (!passConfigs.length) {
      const empty = document.createElement('div');
      empty.className = 'lecture-pass-empty';
      empty.textContent = 'No passes planned. Increase the pass count to build a schedule.';
      passList.appendChild(empty);
      updatePassSummary();
      return;
    }
    passConfigs.forEach((config, index) => {
      const row = document.createElement('div');
      row.className = 'lecture-pass-row';

      const label = document.createElement('div');
      label.className = 'lecture-pass-label';
      label.textContent = `Pass ${index + 1}`;
      row.appendChild(label);

      const controls = document.createElement('div');
      controls.className = 'lecture-pass-controls';

      const actionField = document.createElement('div');
      actionField.className = 'lecture-pass-field';
      const actionLabel = document.createElement('span');
      actionLabel.className = 'lecture-pass-field-label';
      actionLabel.textContent = 'Pass function';
      actionField.appendChild(actionLabel);
      const select = document.createElement('select');
      select.className = 'input lecture-pass-action';
      LECTURE_PASS_ACTIONS.forEach(action => {
        const option = document.createElement('option');
        option.value = action;
        option.textContent = action;
        select.appendChild(option);
      });
      if (config.action && !LECTURE_PASS_ACTIONS.includes(config.action)) {
        const custom = document.createElement('option');
        custom.value = config.action;
        custom.textContent = config.action;
        select.appendChild(custom);
      }
      select.value = config.action || '';
      select.addEventListener('change', event => {
        const value = event.target.value;
        passConfigs[index] = { ...passConfigs[index], action: value };
        updatePassSummary();
      });
      actionField.appendChild(select);
      controls.appendChild(actionField);

      const offsetField = document.createElement('div');
      offsetField.className = 'lecture-pass-field lecture-pass-offset-field';
      const offsetLabel = document.createElement('span');
      offsetLabel.className = 'lecture-pass-field-label';
      offsetLabel.textContent = 'Timing';
      offsetField.appendChild(offsetLabel);

      const offsetInputs = document.createElement('div');
      offsetInputs.className = 'lecture-pass-offset-inputs';
      const split = splitOffsetMinutes(config.offsetMinutes ?? 0);
      const offsetInput = document.createElement('input');
      offsetInput.type = 'number';
      offsetInput.min = '0';
      offsetInput.step = '1';
      offsetInput.className = 'input lecture-pass-offset-value';
      offsetInput.value = String(split.value);
      const unitSelect = document.createElement('select');
      unitSelect.className = 'input lecture-pass-offset-unit';
      OFFSET_UNITS.forEach(option => {
        const opt = document.createElement('option');
        opt.value = option.id;
        opt.textContent = option.label;
        unitSelect.appendChild(opt);
      });
      unitSelect.value = split.unit;
      offsetInputs.appendChild(offsetInput);
      offsetInputs.appendChild(unitSelect);
      offsetField.appendChild(offsetInputs);

      const preview = document.createElement('span');
      preview.className = 'lecture-pass-offset-preview';
      preview.textContent = formatOffset(config.offsetMinutes ?? 0);
      offsetField.appendChild(preview);

      function commitOffset() {
        const minutes = combineOffsetValueUnit(offsetInput.value, unitSelect.value);
        passConfigs[index] = {
          ...passConfigs[index],
          offsetMinutes: minutes
        };
        preview.textContent = formatOffset(passConfigs[index].offsetMinutes ?? 0);
        updatePassSummary();
      }

      offsetInput.addEventListener('change', () => {
        const numeric = Number(offsetInput.value);
        if (!Number.isFinite(numeric) || numeric < 0) {
          offsetInput.value = '0';
        }
        commitOffset();
      });
      offsetInput.addEventListener('blur', () => {
        const numeric = Math.max(0, Math.round(Number(offsetInput.value) || 0));
        offsetInput.value = String(numeric);
        commitOffset();
      });
      unitSelect.addEventListener('change', commitOffset);

      controls.appendChild(offsetField);
      row.appendChild(controls);
      passList.appendChild(row);
    });

    updatePassSummary();
  }

  renderPassEditor();

  passCountInput.addEventListener('change', () => {
    const next = clampPassCount(passCountInput.value);
    passCountInput.value = String(next);
    passConfigs = adjustPassConfigs(passConfigs, next, planTemplate);
    renderPassEditor();
  });

  if (mode !== 'edit') {
    blockSelect.addEventListener('change', () => {
      dialogWeekValue = '';
      updateDialogWeekOptions();
    });
  }

  const actions = document.createElement('div');
  actions.className = 'row lecture-dialog-actions';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn';
  submitBtn.textContent = mode === 'edit' ? 'Save changes' : 'Add lecture';
  actions.appendChild(submitBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const blockId = blockSelect.value.trim();
    const name = nameInput.value.trim();
    const weekValue = weekSelect.value;
    const week = weekValue === '' ? null : Number(weekValue);
    let startAt = parseDateInputValue(startInput.value);
    if (!Number.isFinite(startAt)) {
      startAt = Date.now();
    }
    if (!blockId || !name || (weekValue !== '' && Number.isNaN(week))) {
      return;
    }
    const passPlan = buildPassPlanPayload(passConfigs, defaults.passPlan);
    const payload = {
      blockId,
      name,
      week,
      passPlan,
      startAt
    };
    if (mode === 'edit') {
      payload.id = defaults.id;
    }
    await onSubmit(payload);
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  });

  card.appendChild(form);
  overlay.appendChild(card);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) {
      document.body.removeChild(overlay);
    }
  });
  document.body.appendChild(overlay);
  nameInput.focus();
}

function handleEdit(lecture, blocks, lectureLists, redraw) {
  openLectureDialog({
    mode: 'edit',
    blocks,
    lectureLists,
    defaults: {
      blockId: lecture.blockId,
      id: lecture.id,
      name: lecture.name || '',
      week: lecture.week ?? '',
      passPlan: lecture.passPlan,
      startAt: lecture.startAt
    },
    onSubmit: async payload => {
      await saveLecture({
        blockId: lecture.blockId,
        id: lecture.id,
        name: payload.name,
        week: payload.week,
        passPlan: payload.passPlan,
        startAt: payload.startAt
      });
      await invalidateBlockCatalog();
      await redraw();
    }
  });
}

function handleDelete(lecture, redraw) {
  (async () => {
    if (!(await confirmModal('Delete lecture?'))) return;
    await deleteLecture(lecture.blockId, lecture.id);
    await invalidateBlockCatalog();
    await redraw();
  })();
}

function passScopeModal(mode) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal lecture-pass-scope-modal';

    const card = document.createElement('div');
    card.className = 'card lecture-pass-scope-card';

    const title = document.createElement('h3');
    title.textContent = mode === 'push'
      ? 'Push pass timing'
      : 'Pull pass timing';
    card.appendChild(title);

    const message = document.createElement('p');
    message.textContent = mode === 'push'
      ? 'Choose how far the push should ripple.'
      : 'Choose how far the pull should ripple.';
    card.appendChild(message);

    const buttons = document.createElement('div');
    buttons.className = 'row lecture-pass-scope-buttons';

    const single = document.createElement('button');
    single.className = 'btn secondary';
    single.textContent = 'Only this pass';
    single.addEventListener('click', () => {
      cleanup('single');
    });

    const cascade = document.createElement('button');
    cascade.className = 'btn';
    cascade.textContent = mode === 'push' ? 'This & following' : 'This & preceding';
    cascade.addEventListener('click', () => {
      cleanup(mode === 'push' ? 'chain-after' : 'chain-before');
    });

    const cancel = document.createElement('button');
    cancel.className = 'btn secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      cleanup(null);
    });

    buttons.appendChild(single);
    buttons.appendChild(cascade);
    buttons.appendChild(cancel);
    card.appendChild(buttons);

    overlay.appendChild(card);

    function cleanup(result) {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
      resolve(result);
    }

    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        cleanup(null);
      }
    });

    document.body.appendChild(overlay);
    single.focus();
  });
}

function clampOffsetMinutes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric));
}

function cloneLecturePasses(lecture) {
  return Array.isArray(lecture?.passes)
    ? lecture.passes.map(pass => ({ ...pass }))
    : [];
}

async function togglePassCompletion(lecture, order, completed, redraw) {
  if (!lecture || lecture.blockId == null || lecture.id == null) return;
  const targetOrder = Number(order);
  if (!Number.isFinite(targetOrder)) return;
  const passes = cloneLecturePasses(lecture);
  const index = passes.findIndex(pass => Number(pass?.order) === targetOrder);
  if (index < 0) return;
  const next = { ...passes[index] };
  if (completed) {
    next.completedAt = Number.isFinite(next.completedAt) ? next.completedAt : Date.now();
  } else {
    next.completedAt = null;
  }
  passes[index] = next;
  const status = deriveLectureStatus(passes, lecture.status);
  const nextDueAt = calculateNextDue(passes);
  await saveLecture({
    blockId: lecture.blockId,
    id: lecture.id,
    passes,
    status,
    nextDueAt
  });
  await invalidateBlockCatalog();
  await redraw();
}

function normalizeSchedule(plan) {
  return Array.isArray(plan?.schedule)
    ? plan.schedule.map(step => ({ ...step }))
    : [];
}

async function updatePassFunction(lecture, order, action, redraw) {
  if (!lecture || lecture.blockId == null || lecture.id == null) return;
  const plan = clonePassPlan(lecture.passPlan || {});
  const schedule = normalizeSchedule(plan);
  const step = schedule.find(entry => Number(entry?.order) === Number(order));
  if (!step) return;
  step.action = action;
  const passes = cloneLecturePasses(lecture);
  const pass = passes.find(entry => Number(entry?.order) === Number(order));
  if (pass) {
    pass.action = action;
  }
  plan.schedule = schedule;
  await saveLecture({
    blockId: lecture.blockId,
    id: lecture.id,
    passPlan: plan,
    passes
  });
  await invalidateBlockCatalog();
  await redraw();
}

async function shiftPassTiming(lecture, order, deltaMinutes, scope, redraw) {
  if (!lecture || lecture.blockId == null || lecture.id == null) return;
  if (!Number.isFinite(deltaMinutes) || deltaMinutes === 0) return;
  const plan = clonePassPlan(lecture.passPlan || {});
  const schedule = normalizeSchedule(plan);
  if (!schedule.length) return;

  const targetOrder = Number(order);
  if (!Number.isFinite(targetOrder)) return;

  const affectedOrders = new Set();
  schedule.forEach(step => {
    const currentOrder = Number(step?.order);
    if (!Number.isFinite(currentOrder)) return;
    if (scope === 'chain-after' && currentOrder >= targetOrder) {
      affectedOrders.add(currentOrder);
    } else if (scope === 'chain-before' && currentOrder <= targetOrder) {
      affectedOrders.add(currentOrder);
    } else if (!scope || scope === 'single') {
      if (currentOrder === targetOrder) affectedOrders.add(currentOrder);
    }
  });
  if (!affectedOrders.size) affectedOrders.add(targetOrder);

  schedule.forEach(step => {
    const currentOrder = Number(step?.order);
    if (!Number.isFinite(currentOrder)) return;
    const offset = clampOffsetMinutes(step.offsetMinutes);
    if (affectedOrders.has(currentOrder)) {
      step.offsetMinutes = Math.max(0, offset + deltaMinutes);
    } else {
      step.offsetMinutes = offset;
    }
  });

  const minuteMs = 60 * 1000;
  const passMap = new Map();
  cloneLecturePasses(lecture).forEach(pass => {
    const orderKey = Number(pass?.order);
    if (Number.isFinite(orderKey) && !passMap.has(orderKey)) {
      passMap.set(orderKey, { ...pass });
    }
  });

  affectedOrders.forEach(orderKey => {
    const pass = passMap.get(orderKey);
    if (pass && Number.isFinite(pass.due)) {
      const nextDue = Math.max(0, Math.round(pass.due + deltaMinutes * minuteMs));
      pass.due = nextDue;
      passMap.set(orderKey, pass);
    }
  });

  const decorated = schedule.map((step, index) => ({
    ...step,
    originalOrder: Number(step?.order) || index + 1,
    offsetMinutes: clampOffsetMinutes(step.offsetMinutes)
  }));

  decorated.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.originalOrder - b.originalOrder;
  });

  const newSchedule = [];
  const reassignedPasses = [];
  decorated.forEach((entry, index) => {
    const newOrder = index + 1;
    const base = { ...entry };
    delete base.originalOrder;
    base.order = newOrder;
    newSchedule.push(base);
    const pass = passMap.get(entry.originalOrder);
    if (pass) {
      pass.order = newOrder;
      reassignedPasses.push(pass);
      passMap.delete(entry.originalOrder);
    }
  });

  passMap.forEach(pass => {
    reassignedPasses.push(pass);
  });

  reassignedPasses.sort((a, b) => {
    const ao = Number(a?.order) || 0;
    const bo = Number(b?.order) || 0;
    return ao - bo;
  });

  plan.schedule = newSchedule;

  await saveLecture({
    blockId: lecture.blockId,
    id: lecture.id,
    passPlan: plan,
    passes: reassignedPasses
  });
  await invalidateBlockCatalog();
  await redraw();
}

function openPassEditDialog({ lecture, passInfo, onUpdateAction, onShift }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal lecture-pass-modal';

  const card = document.createElement('div');
  card.className = 'card lecture-pass-card';

  const title = document.createElement('h2');
  const passLabel = passInfo?.label || `Pass ${passInfo?.order ?? ''}`;
  title.textContent = `Edit ${passLabel}`;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'lecture-pass-meta';

  const dateLine = document.createElement('div');
  dateLine.className = 'lecture-pass-meta-line';
  dateLine.textContent = Number.isFinite(passInfo?.due)
    ? formatPassDueTimestamp(passInfo.due)
    : 'No scheduled date';
  meta.appendChild(dateLine);

  const countdownLine = document.createElement('div');
  countdownLine.className = 'lecture-pass-meta-line';
  countdownLine.textContent = describePassCountdown(passInfo?.due);
  meta.appendChild(countdownLine);

  card.appendChild(meta);

  const actionField = document.createElement('label');
  actionField.className = 'lecture-pass-modal-field';
  actionField.textContent = 'Pass function';
  const actionInput = document.createElement('input');
  actionInput.type = 'text';
  actionInput.className = 'input';
  actionInput.value = passInfo?.action || passInfo?.label || '';
  const actionListId = `pass-action-${lecture.blockId}-${lecture.id}-${passInfo?.order}`
    .replace(/[^a-zA-Z0-9_-]/g, '-');
  const actionDatalist = document.createElement('datalist');
  actionDatalist.id = actionListId;
  LECTURE_PASS_ACTIONS.forEach(action => {
    const option = document.createElement('option');
    option.value = action;
    actionDatalist.appendChild(option);
  });
  actionInput.setAttribute('list', actionListId);
  actionField.appendChild(actionInput);
  actionField.appendChild(actionDatalist);
  card.appendChild(actionField);

  const adjustSection = document.createElement('section');
  adjustSection.className = 'lecture-pass-adjust';

  const adjustTitle = document.createElement('h3');
  adjustTitle.textContent = 'Adjust timing';
  adjustSection.appendChild(adjustTitle);

  const adjustControls = document.createElement('div');
  adjustControls.className = 'lecture-pass-adjust-controls';

  const amountInput = document.createElement('input');
  amountInput.type = 'number';
  amountInput.className = 'input lecture-pass-adjust-value';
  amountInput.min = '0';
  amountInput.step = '1';
  amountInput.value = '1';

  const unitSelect = document.createElement('select');
  unitSelect.className = 'input lecture-pass-adjust-unit';
  OFFSET_UNITS.forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.id;
    opt.textContent = option.label;
    unitSelect.appendChild(opt);
  });
  unitSelect.value = 'days';

  adjustControls.appendChild(amountInput);
  adjustControls.appendChild(unitSelect);
  adjustSection.appendChild(adjustControls);

  const adjustButtons = document.createElement('div');
  adjustButtons.className = 'lecture-pass-adjust-buttons';

  const pushBtn = document.createElement('button');
  pushBtn.type = 'button';
  pushBtn.className = 'btn';
  pushBtn.textContent = 'Push later';

  const pullBtn = document.createElement('button');
  pullBtn.type = 'button';
  pullBtn.className = 'btn secondary';
  pullBtn.textContent = 'Pull earlier';

  adjustButtons.appendChild(pushBtn);
  adjustButtons.appendChild(pullBtn);
  adjustSection.appendChild(adjustButtons);

  card.appendChild(adjustSection);

  const feedback = document.createElement('div');
  feedback.className = 'lecture-pass-feedback';
  card.appendChild(feedback);

  const actions = document.createElement('div');
  actions.className = 'row lecture-pass-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save function';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn secondary';
  closeBtn.textContent = 'Close';

  actions.appendChild(saveBtn);
  actions.appendChild(closeBtn);
  card.appendChild(actions);

  overlay.appendChild(card);

  function showMessage(message) {
    feedback.textContent = message || '';
    if (message) {
      feedback.classList.add('is-visible');
    } else {
      feedback.classList.remove('is-visible');
    }
  }

  let busy = false;

  function setBusy(value) {
    busy = Boolean(value);
    saveBtn.disabled = busy;
    pushBtn.disabled = busy;
    pullBtn.disabled = busy;
  }

  function close() {
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  }

  async function handleSave() {
    if (busy) return;
    const value = actionInput.value.trim();
    if (!value) {
      showMessage('Enter a function for this pass.');
      return;
    }
    setBusy(true);
    try {
      await onUpdateAction(value);
      close();
    } catch (err) {
      console.error(err);
      showMessage('Failed to update pass. Please try again.');
      setBusy(false);
    }
  }

  async function handleShift(mode) {
    if (busy) return;
    const amount = Number(amountInput.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showMessage('Enter how much to adjust the pass by.');
      return;
    }
    const minutes = combineOffsetValueUnit(amount, unitSelect.value);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      showMessage('Pick a timing greater than zero.');
      return;
    }
    const scope = await passScopeModal(mode);
    if (!scope) return;
    const delta = mode === 'push' ? minutes : -minutes;
    setBusy(true);
    try {
      await onShift(delta, scope);
      close();
    } catch (err) {
      console.error(err);
      showMessage('Failed to adjust timing. Please try again.');
      setBusy(false);
    }
  }

  saveBtn.addEventListener('click', handleSave);
  pushBtn.addEventListener('click', () => handleShift('push'));
  pullBtn.addEventListener('click', () => handleShift('pull'));
  closeBtn.addEventListener('click', close);

  overlay.addEventListener('click', event => {
    if (event.target === overlay) {
      close();
    }
  });

  document.body.appendChild(overlay);
  actionInput.focus();
}

function handlePassEdit(lecture, passInfo, redraw) {
  if (!lecture || !passInfo) return;
  openPassEditDialog({
    lecture,
    passInfo,
    onUpdateAction: action => updatePassFunction(lecture, passInfo.order, action, redraw),
    onShift: (delta, scope) => shiftPassTiming(lecture, passInfo.order, delta, scope, redraw)
  });
}

async function handlePassToggle(lecture, passInfo, checked, redraw) {
  if (!lecture || !passInfo) return;
  await togglePassCompletion(lecture, passInfo.order, checked, redraw);
}

export async function renderLectures(root, redraw) {
  const [catalog, settings] = await Promise.all([
    loadBlockCatalog(),
    getSettings()
  ]);
  setPassColorPalette(settings?.plannerDefaults?.passColors);
  const filters = ensureLectureState();
  const blocks = (catalog.blocks || []).map(block => ({ ...block }));
  const allLectures = collectLectures(catalog);
  const lectureLists = catalog.lectureLists || {};
  const filtered = applyFilters(allLectures, filters);
  const defaultPassPlan = plannerDefaultsToPassPlan(settings?.plannerDefaults);
  const requestRedraw = () => {
    captureLectureViewState();
    return redraw();
  };

  const resolveBlockLabel = blockInfo => {
    if (!blockInfo) return 'block';
    return blockInfo.title || blockInfo.name || blockInfo.blockId || 'block';
  };

  async function handleExportLectureBundle(lecture, blockInfo) {
    if (!lecture || lecture.id == null) {
      alert('Lecture information is incomplete.');
      return;
    }
    const normalizedBlockId = String(lecture.blockId ?? '').trim();
    if (!normalizedBlockId) {
      alert('Assign this lecture to a block before exporting.');
      return;
    }
    try {
      const bundle = await exportLectureTransfer(normalizedBlockId, lecture.id);
      const blockLabel = resolveBlockLabel(blockInfo) || lecture.blockId || 'block';
      const lectureLabel = lecture.name || `lecture-${lecture.id}`;
      const filename = `lecture-${slugify(blockLabel)}-${slugify(lectureLabel)}.json`;
      downloadJson(bundle, filename);
    } catch (err) {
      console.error('Failed to export lecture bundle', err);
      alert('Failed to export lecture.');
    }
  }

  async function handleExportWeekBundle(blockInfo, weekValue) {
    const blockId = blockInfo?.blockId;
    if (!blockId) {
      alert('Assign the lectures to a block before exporting a week.');
      return;
    }
    try {
      const bundle = await exportWeekTransfer(blockId, weekValue == null ? null : weekValue);
      const blockLabel = resolveBlockLabel(blockInfo);
      const weekSlug = weekValue == null ? 'no-week' : `week-${weekValue}`;
      const filename = `week-${slugify(blockLabel)}-${slugify(weekSlug)}.json`;
      downloadJson(bundle, filename);
    } catch (err) {
      console.error('Failed to export week bundle', err);
      alert('Failed to export week.');
    }
  }

  async function handleExportBlockBundle(blockInfo) {
    const blockId = blockInfo?.blockId;
    if (!blockId) {
      alert('Select a block to export.');
      return;
    }
    try {
      const bundle = await exportBlockTransfer(blockId);
      const filename = `block-${slugify(resolveBlockLabel(blockInfo))}.json`;
      downloadJson(bundle, filename);
    } catch (err) {
      console.error('Failed to export block bundle', err);
      alert('Failed to export block.');
    }
  }

  async function handleImportBundle(payload) {
    try {
      const conflicts = detectImportConflicts(payload, catalog);
      let strategy = 'merge';
      if (conflicts.hasConflicts) {
        const choice = await promptImportStrategy(conflicts);
        if (!choice) {
          return;
      }
      strategy = choice;
    }
    await importLectureTransfer(payload, { strategy });
    await invalidateBlockCatalog();
    await requestRedraw();
    alert('Import complete.');
  } catch (err) {
    console.error('Failed to import lecture bundle', err);
    alert('Import failed.');
  }
  }

  root.innerHTML = '';
  const layout = document.createElement('div');
  layout.className = 'lectures-view';
  root.appendChild(layout);

  const toolbar = buildToolbar(
    blocks,
    allLectures,
    lectureLists,
    requestRedraw,
    defaultPassPlan,
    handleImportBundle
  );
  layout.appendChild(toolbar);

  const table = renderLectureTable(
    blocks,
    filtered,
    filters,
    lecture => handleEdit(lecture, blocks, lectureLists, requestRedraw),
    lecture => handleDelete(lecture, requestRedraw),
    (lecture, pass) => handlePassEdit(lecture, pass, requestRedraw),
    (lecture, pass, checked) => handlePassToggle(lecture, pass, checked, requestRedraw),
    (lecture, blockInfo) => handleExportLectureBundle(lecture, blockInfo || blocks.find(block => block.blockId === lecture.blockId)),
    (blockInfo, weekValue) => handleExportWeekBundle(blockInfo, weekValue),
    blockInfo => handleExportBlockBundle(blockInfo)
  );
  layout.appendChild(table);

  const scroller = findLectureScrollContainer(root);
  requestAnimationFrame(() => {
    const target = Number(filters?.scrollTop);
    if (Number.isFinite(target) && target > 0) {
      if (scroller && typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: target, left: 0, behavior: 'auto' });
      } else if (scroller && 'scrollTop' in scroller) {
        scroller.scrollTop = target;
      } else {
        window.scrollTo({ top: target, left: 0, behavior: 'auto' });
      }
    }
  });
}
