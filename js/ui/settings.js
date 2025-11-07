import {
  upsertBlock,
  deleteBlock,
  exportJSON,
  importJSON,
  exportAnkiCSV,
  getSettings,
  saveSettings
} from '../storage/storage.js';
import { loadBlockCatalog, invalidateBlockCatalog } from '../storage/block-catalog.js';
import { confirmModal } from './components/confirm.js';
import { DEFAULT_REVIEW_STEPS, REVIEW_RATINGS } from '../review/constants.js';
import { DEFAULT_PASS_PLAN, DEFAULT_PLANNER_DEFAULTS, plannerDefaultsToPassPlan } from '../lectures/scheduler.js';
import { LECTURE_PASS_ACTIONS } from '../lectures/actions.js';
import { DEFAULT_PASS_COLORS } from './components/pass-colors.js';

function createEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'settings-empty-blocks';
  empty.textContent = 'No blocks yet. Use “Add block” to create one.';
  return empty;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;
const MAX_PASS_COUNT = 20;

const OFFSET_UNITS = [
  { id: 'minutes', label: 'minutes', minutes: 1 },
  { id: 'hours', label: 'hours', minutes: 60 },
  { id: 'days', label: 'days', minutes: 60 * 24 },
  { id: 'weeks', label: 'weeks', minutes: 60 * 24 * 7 }
];

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

function formatWeekCount(weeks) {
  if (!Number.isFinite(weeks) || weeks <= 0) return null;
  const rounded = Math.max(1, Math.round(weeks));
  return `${rounded} week${rounded === 1 ? '' : 's'}`;
}

function parseBlockDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatBlockDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  const date = parseBlockDate(value);
  if (!date) return null;
  const formatter = new Intl.DateTimeFormat(undefined, options);
  return formatter.format(date);
}

function formatDateRange(start, end) {
  const startDate = parseBlockDate(start);
  const endDate = parseBlockDate(end);
  if (!startDate && !endDate) return null;
  if (startDate && endDate) {
    const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `${formatter.format(startDate)} → ${formatter.format(endDate)}`;
  }
  if (startDate) {
    const formatted = formatBlockDate(startDate);
    return formatted ? `Starts ${formatted}` : null;
  }
  const formatted = formatBlockDate(endDate);
  return formatted ? `Ends ${formatted}` : null;
}

function computeSpanDays(start, end) {
  const startDate = parseBlockDate(start);
  const endDate = parseBlockDate(end);
  if (!startDate || !endDate) return null;
  const diff = endDate.getTime() - startDate.getTime();
  if (diff < 0) return null;
  return Math.round(diff / DAY_MS) + 1;
}

function formatBlockMeta(block) {
  if (!block) return 'No block data';
  const parts = [];
  const weeks = formatWeekCount(Number(block.weeks));
  if (weeks) parts.push(weeks);
  const range = formatDateRange(block.startDate, block.endDate);
  if (range) parts.push(range);
  const spanDays = computeSpanDays(block.startDate, block.endDate);
  if (spanDays) parts.push(`${spanDays} day${spanDays === 1 ? '' : 's'}`);
  return parts.join(' • ') || 'Block details unavailable';
}

export async function renderSettings(root) {
  root.innerHTML = '';

  const content = document.createElement('div');
  content.className = 'tab-content settings-content';
  root.appendChild(content);

  const layout = document.createElement('div');
  layout.className = 'settings-layout';
  content.appendChild(layout);

  const [catalogResult, settingsResult] = await Promise.allSettled([
    loadBlockCatalog(),
    getSettings()
  ]);

  if (catalogResult.status === 'rejected') {
    console.warn('Failed to load block catalog', catalogResult.reason);
  }
  if (settingsResult.status === 'rejected') {
    console.warn('Failed to load app settings', settingsResult.reason);
  }

  const catalog = catalogResult.status === 'fulfilled' && catalogResult.value
    ? catalogResult.value
    : { blocks: [] };
  const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
  const blocks = Array.isArray(catalog.blocks) ? catalog.blocks : [];
  const reviewSteps = {
    ...DEFAULT_REVIEW_STEPS,
    ...(settings?.reviewSteps || {})
  };
  const durationUnits = [
    { value: 'minutes', label: 'minutes', factor: 1 },
    { value: 'hours', label: 'hours', factor: 60 },
    { value: 'days', label: 'days', factor: 1440 },
    { value: 'weeks', label: 'weeks', factor: 10080 }
  ];
  const durationFactorMap = durationUnits.reduce((acc, unit) => {
    acc[unit.value] = unit.factor;
    return acc;
  }, {});
  const durationAliasFactors = {
    m: 1,
    min: 1,
    mins: 1,
    minute: 1,
    minutes: 1,
    h: 60,
    hr: 60,
    hrs: 60,
    hour: 60,
    hours: 60,
    d: 1440,
    day: 1440,
    days: 1440,
    w: 10080,
    wk: 10080,
    wks: 10080,
    week: 10080,
    weeks: 10080
  };

  const minutesToParts = (minutes) => {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { value: '', unit: 'minutes' };
    }
    const unitCandidates = [
      { unit: 'weeks', factor: durationFactorMap.weeks },
      { unit: 'days', factor: durationFactorMap.days },
      { unit: 'hours', factor: durationFactorMap.hours },
      { unit: 'minutes', factor: 1 }
    ];
    for (const { unit, factor } of unitCandidates) {
      if (!factor) continue;
      const value = minutes / factor;
      if (value >= 1 && Number.isInteger(value)) {
        return { value, unit };
      }
    }
    for (const { unit, factor } of unitCandidates) {
      if (!factor) continue;
      const value = minutes / factor;
      if (value >= 1) {
        return { value: Math.round(value * 100) / 100, unit };
      }
    }
    return { value: Math.round(minutes * 100) / 100, unit: 'minutes' };
  };

  const convertToMinutes = (amount, unit) => {
    const factor = durationFactorMap[unit] || 1;
    const raw = Number(amount);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.max(1, Math.round(raw * factor));
  };

  const parseDurationToken = (token) => {
    if (!token) return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.max(1, Math.round(numeric));
    }
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitToken = (match[2] || 'minutes').toLowerCase();
    const factor = durationAliasFactors[unitToken];
    if (!factor) return null;
    return Math.max(1, Math.round(amount * factor));
  };

  const parseDurationListString = (value) => {
    const raw = (value || '').trim();
    if (!raw) return [];
    const entries = raw.split(/[;,\n]+/);
    const results = [];
    for (const entry of entries) {
      const minutes = parseDurationToken(entry);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return null;
      }
      results.push(minutes);
    }
    return results;
  };

  const formatDurationDisplay = (minutes) => {
    if (!Number.isFinite(minutes) || minutes <= 0) return '';
    if (minutes % durationFactorMap.weeks === 0) {
      const value = minutes / durationFactorMap.weeks;
      return `${value} ${value === 1 ? 'week' : 'weeks'}`;
    }
    if (minutes % durationFactorMap.days === 0) {
      const value = minutes / durationFactorMap.days;
      return `${value} ${value === 1 ? 'day' : 'days'}`;
    }
    if (minutes % durationFactorMap.hours === 0) {
      const value = minutes / durationFactorMap.hours;
      return `${value} ${value === 1 ? 'hour' : 'hours'}`;
    }
    const rounded = Math.round(minutes * 100) / 100;
    return `${rounded} ${rounded === 1 ? 'minute' : 'minutes'}`;
  };

  const createDurationControl = (minutes) => {
    const control = document.createElement('div');
    control.className = 'settings-review-control';
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0.1';
    amountInput.step = '0.1';
    amountInput.className = 'input settings-review-input';
    const unitSelect = document.createElement('select');
    unitSelect.className = 'input settings-review-unit';
    durationUnits.forEach(unit => {
      const option = document.createElement('option');
      option.value = unit.value;
      option.textContent = unit.label;
      unitSelect.appendChild(option);
    });
    const parts = minutesToParts(minutes);
    if (parts.value !== '') amountInput.value = String(parts.value);
    unitSelect.value = parts.unit;
    control.appendChild(amountInput);
    control.appendChild(unitSelect);
    return { wrapper: control, amountInput, unitSelect };
  };

  const plannerDefaults = settings?.plannerDefaults || DEFAULT_PLANNER_DEFAULTS;

  const blocksCard = document.createElement('section');
  blocksCard.className = 'card';
  const bHeading = document.createElement('h2');
  bHeading.textContent = 'Blocks';
  blocksCard.appendChild(bHeading);

  const list = document.createElement('div');
  list.className = 'block-list';
  blocksCard.appendChild(list);

  if (!blocks.length) {
    list.appendChild(createEmptyState());
  }

  blocks.forEach((block, index) => {
    if (!block) return;
    const wrap = document.createElement('div');
    wrap.className = 'settings-block-row';
    if (block.color) {
      wrap.style.setProperty('--block-accent', block.color);
      wrap.classList.add('has-accent');
    }

    const header = document.createElement('div');
    header.className = 'settings-block-header';
    const title = document.createElement('h3');
    title.className = 'settings-block-title';
    title.textContent = block.title || 'Untitled block';
    if (block.color) {
      title.style.setProperty('--block-accent', block.color);
      title.classList.add('has-accent');
    }
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'settings-block-meta';
    meta.textContent = formatBlockMeta(block);
    header.appendChild(meta);

    const controls = document.createElement('div');
    controls.className = 'settings-block-controls';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn tertiary';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', async () => {
      const other = blocks[index - 1];
      if (!other) return;
      const tmp = block.order;
      block.order = other.order;
      other.order = tmp;
      await upsertBlock(block);
      await upsertBlock(other);
      invalidateBlockCatalog();
      await renderSettings(root);
    });
    controls.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn tertiary';
    downBtn.textContent = '↓';
    downBtn.disabled = index === blocks.length - 1;
    downBtn.addEventListener('click', async () => {
      const other = blocks[index + 1];
      if (!other) return;
      const tmp = block.order;
      block.order = other.order;
      other.order = tmp;
      await upsertBlock(block);
      await upsertBlock(other);
      invalidateBlockCatalog();
      await renderSettings(root);
    });
    controls.appendChild(downBtn);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn secondary';
    editBtn.textContent = 'Edit';
    controls.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn secondary';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!(await confirmModal('Delete block?'))) return;
      await deleteBlock(block.blockId);
      invalidateBlockCatalog();
      await renderSettings(root);
    });
    controls.appendChild(deleteBtn);

    header.appendChild(controls);

    wrap.appendChild(header);

    const detailGrid = document.createElement('div');
    detailGrid.className = 'settings-block-detail-grid';

    const startDetail = document.createElement('div');
    startDetail.className = 'settings-block-detail';
    startDetail.innerHTML = `<span>Start</span><strong>${formatBlockDate(block.startDate) || '—'}</strong>`;
    detailGrid.appendChild(startDetail);

    const endDetail = document.createElement('div');
    endDetail.className = 'settings-block-detail';
    endDetail.innerHTML = `<span>End</span><strong>${formatBlockDate(block.endDate) || '—'}</strong>`;
    detailGrid.appendChild(endDetail);

    const weeksDetail = document.createElement('div');
    weeksDetail.className = 'settings-block-detail';
    weeksDetail.innerHTML = `<span>Weeks</span><strong>${formatWeekCount(Number(block.weeks)) || '—'}</strong>`;
    detailGrid.appendChild(weeksDetail);

    const spanDays = computeSpanDays(block.startDate, block.endDate);
    const daysDetail = document.createElement('div');
    daysDetail.className = 'settings-block-detail';
    daysDetail.innerHTML = `<span>Span</span><strong>${spanDays ? `${spanDays} day${spanDays === 1 ? '' : 's'}` : '—'}</strong>`;
    detailGrid.appendChild(daysDetail);

    wrap.appendChild(detailGrid);

    const editForm = document.createElement('form');
    editForm.className = 'settings-block-edit';
    editForm.hidden = true;

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.required = true;
    titleInput.className = 'input';
    titleInput.value = block.title || '';

    const weeksInput = document.createElement('input');
    weeksInput.type = 'number';
    weeksInput.min = '1';
    weeksInput.required = true;
    weeksInput.className = 'input';
    weeksInput.value = block.weeks != null ? String(block.weeks) : '1';

    const startInput = document.createElement('input');
    startInput.type = 'date';
    startInput.className = 'input';
    startInput.value = block.startDate || '';

    const endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.className = 'input';
    endInput.value = block.endDate || '';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'input';
    colorInput.value = block.color || '#ffffff';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn';
    saveBtn.textContent = 'Save changes';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      editForm.hidden = true;
    });

    editForm.append(titleInput, startInput, endInput, weeksInput, colorInput, saveBtn, cancelBtn);
    editForm.addEventListener('submit', async event => {
      event.preventDefault();
      const titleValue = titleInput.value.trim();
      const weeksValue = Number(weeksInput.value);
      if (!titleValue || !Number.isFinite(weeksValue) || weeksValue <= 0) {
        return;
      }
      let startValue = startInput.value || null;
      let endValue = endInput.value || null;
      if (startValue && endValue) {
        const startDate = new Date(startValue);
        const endDate = new Date(endValue);
        if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime()) && startDate > endDate) {
          const swap = startValue;
          startValue = endValue;
          endValue = swap;
        }
      }
      const payload = {
        ...block,
        title: titleValue,
        weeks: weeksValue,
        color: colorInput.value || null,
        startDate: startValue,
        endDate: endValue
      };
      await upsertBlock(payload);
      invalidateBlockCatalog();
      await renderSettings(root);
    });

    wrap.appendChild(editForm);

    editBtn.addEventListener('click', () => {
      editForm.hidden = !editForm.hidden;
    });

    list.appendChild(wrap);
  });

  const form = document.createElement('form');
  form.className = 'settings-block-add';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.required = true;
  titleInput.placeholder = 'Block title';
  titleInput.className = 'input';

  const startInput = document.createElement('input');
  startInput.type = 'date';
  startInput.className = 'input';
  startInput.placeholder = 'Start date';
  startInput.setAttribute('aria-label', 'Block start date');

  const endInput = document.createElement('input');
  endInput.type = 'date';
  endInput.className = 'input';
  endInput.placeholder = 'End date';
  endInput.setAttribute('aria-label', 'Block end date');

  const weeksInput = document.createElement('input');
  weeksInput.type = 'number';
  weeksInput.min = '1';
  weeksInput.required = true;
  weeksInput.value = '1';
  weeksInput.placeholder = 'Weeks';
  weeksInput.className = 'input';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'input';
  colorInput.value = '#ffffff';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn';
  submitBtn.textContent = 'Add block (top)';

  form.append(titleInput, startInput, endInput, weeksInput, colorInput, submitBtn);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const titleValue = titleInput.value.trim();
    const weeksValue = Number(weeksInput.value);
    if (!titleValue || !Number.isFinite(weeksValue) || weeksValue <= 0) {
      return;
    }
    let startValue = startInput.value || null;
    let endValue = endInput.value || null;
    if (startValue && endValue) {
      const startDate = new Date(startValue);
      const endDate = new Date(endValue);
      if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime()) && startDate > endDate) {
        const swap = startValue;
        startValue = endValue;
        endValue = swap;
      }
    }
    await upsertBlock({
      title: titleValue,
      weeks: weeksValue,
      color: colorInput.value || null,
      startDate: startValue,
      endDate: endValue
    });
    titleInput.value = '';
    startInput.value = '';
    endInput.value = '';
    weeksInput.value = '1';
    colorInput.value = '#ffffff';
    invalidateBlockCatalog();
    await renderSettings(root);
  });

  blocksCard.appendChild(form);

  layout.appendChild(blocksCard);

  const reviewCard = document.createElement('section');
  reviewCard.className = 'card';
  const rHeading = document.createElement('h2');
  rHeading.textContent = 'Review';
  reviewCard.appendChild(rHeading);

  const reviewForm = document.createElement('form');
  reviewForm.className = 'settings-review-form';
  reviewForm.dataset.section = 'review';

  const stepsHeading = document.createElement('h3');
  stepsHeading.className = 'settings-subheading';
  stepsHeading.textContent = 'Button delays (when each rating shows up again)';
  reviewForm.appendChild(stepsHeading);

  const stepsDescription = document.createElement('p');
  stepsDescription.className = 'settings-review-help';
  stepsDescription.textContent = 'Use these to control how soon you will see a card again after choosing Again, Hard, Good, or Easy.';
  reviewForm.appendChild(stepsDescription);

  const grid = document.createElement('div');
  grid.className = 'settings-review-grid';
  reviewForm.appendChild(grid);

  const ratingLabels = {
    again: 'Again',
    hard: 'Hard',
    good: 'Good',
    easy: 'Easy'
  };

  const ratingDescriptions = {
    again: 'Repeat almost immediately when you didn’t remember.',
    hard: 'Give yourself a short break after a difficult recall.',
    good: 'Normal delay for a comfortable review.',
    easy: 'A longer break when the card feels effortless.'
  };

  const reviewInputs = new Map();
  for (const rating of REVIEW_RATINGS) {
    const row = document.createElement('label');
    row.className = 'settings-review-row';

    const title = document.createElement('span');
    title.className = 'settings-review-title';
    title.textContent = ratingLabels[rating] || rating;
    row.appendChild(title);

    if (ratingDescriptions[rating]) {
      const desc = document.createElement('span');
      desc.className = 'settings-review-help';
      desc.textContent = ratingDescriptions[rating];
      row.appendChild(desc);
    }

    const control = document.createElement('div');
    control.className = 'settings-review-control';

    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0.1';
    amountInput.step = '0.1';
    amountInput.required = true;
    amountInput.className = 'input settings-review-input';
    amountInput.dataset.rating = rating;
    const unitSelect = document.createElement('select');
    unitSelect.className = 'input settings-review-unit';
    durationUnits.forEach(unit => {
      const option = document.createElement('option');
      option.value = unit.value;
      option.textContent = unit.label;
      unitSelect.appendChild(option);
    });
    const parts = minutesToParts(reviewSteps[rating] ?? DEFAULT_REVIEW_STEPS[rating]);
    if (parts.value !== '') {
      amountInput.value = String(parts.value);
    }
    unitSelect.value = parts.unit;
    control.appendChild(amountInput);
    control.appendChild(unitSelect);
    row.appendChild(control);

    reviewInputs.set(rating, { amount: amountInput, unit: unitSelect });
    grid.appendChild(row);
  }

  const advancedHeading = document.createElement('h3');
  advancedHeading.className = 'settings-subheading';
  advancedHeading.textContent = 'Fine-tune spaced repetition (optional)';
  reviewForm.appendChild(advancedHeading);

  const advancedIntro = document.createElement('p');
  advancedIntro.className = 'settings-review-help';
  advancedIntro.textContent = 'Tweak how cards graduate, how ease changes, and how lapses behave. Leave any field blank to keep the default.';
  reviewForm.appendChild(advancedIntro);

  const advancedGrid = document.createElement('div');
  advancedGrid.className = 'settings-review-grid';
  reviewForm.appendChild(advancedGrid);

  const advancedInputs = new Map();
  const advancedFields = [
    {
      key: 'learningSteps',
      label: 'Extra learning reviews',
      description: 'Short delays right after you learn a card. Separate times with commas (e.g., "10 min, 1 hour").',
      type: 'list',
      placeholder: '10 min, 1 hour'
    },
    {
      key: 'relearningSteps',
      label: 'Relearning reviews after a lapse',
      description: 'Used when you miss a mature card.',
      type: 'list',
      placeholder: '10 min'
    },
    {
      key: 'graduatingGood',
      label: '“Good” graduation delay',
      description: 'How long until the next review when you finish learning with Good.',
      type: 'duration'
    },
    {
      key: 'graduatingEasy',
      label: '“Easy” graduation delay',
      description: 'How long until the next review when you finish learning with Easy.',
      type: 'duration'
    },
    {
      key: 'startingEase',
      label: 'Starting ease',
      description: 'How quickly intervals grow after a card graduates.',
      type: 'number',
      min: 0.5,
      step: 0.05
    },
    {
      key: 'minimumEase',
      label: 'Minimum ease',
      description: 'Prevents ease from dropping too low after misses.',
      type: 'number',
      min: 0.5,
      step: 0.05
    },
    {
      key: 'easeBonus',
      label: 'Easy bonus',
      description: 'Extra boost applied when you choose Easy.',
      type: 'number',
      min: 0,
      step: 0.05,
      allowZero: true
    },
    {
      key: 'easePenalty',
      label: '“Again” penalty',
      description: 'Ease reduction when you miss a card.',
      type: 'number',
      min: 0,
      step: 0.05,
      allowZero: true
    },
    {
      key: 'hardEasePenalty',
      label: '“Hard” penalty',
      description: 'Small ease decrease applied after choosing Hard.',
      type: 'number',
      min: 0,
      step: 0.05,
      allowZero: true
    },
    {
      key: 'hardIntervalMultiplier',
      label: '“Hard” interval multiplier',
      description: 'Scales the next review interval when you choose Hard.',
      type: 'number',
      min: 0.1,
      step: 0.05
    },
    {
      key: 'easyIntervalBonus',
      label: '“Easy” interval bonus',
      description: 'Multiplier for the next interval when you choose Easy.',
      type: 'number',
      min: 0.1,
      step: 0.05
    },
    {
      key: 'intervalModifier',
      label: 'Overall pacing multiplier',
      description: 'Adjust every interval globally. Values above 1 slow things down.',
      type: 'number',
      min: 0.1,
      step: 0.05
    },
    {
      key: 'lapseIntervalMultiplier',
      label: 'Lapse interval restart',
      description: 'How much of the previous interval you keep after a lapse.',
      type: 'number',
      min: 0.1,
      step: 0.05
    }
  ];

  advancedFields.forEach(field => {
    const row = document.createElement('label');
    row.className = 'settings-review-row';
    const title = document.createElement('span');
    title.className = 'settings-review-title';
    title.textContent = field.label;
    row.appendChild(title);
    if (field.description) {
      const desc = document.createElement('span');
      desc.className = 'settings-review-help';
      desc.textContent = field.description;
      row.appendChild(desc);
    }

    if (field.type === 'list') {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input settings-review-input';
      if (field.placeholder) input.placeholder = field.placeholder;
      const currentValue = reviewSteps[field.key];
      if (Array.isArray(currentValue)) {
        input.value = currentValue.map(formatDurationDisplay).filter(Boolean).join(', ');
      }
      row.appendChild(input);
      advancedInputs.set(field.key, { type: 'list', input });
    } else if (field.type === 'duration') {
      const currentMinutes = Number.isFinite(Number(reviewSteps[field.key]))
        ? Number(reviewSteps[field.key])
        : Number(DEFAULT_REVIEW_STEPS[field.key]);
      const control = createDurationControl(currentMinutes);
      row.appendChild(control.wrapper);
      advancedInputs.set(field.key, { type: 'duration', amount: control.amountInput, unit: control.unitSelect });
    } else {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input settings-review-input';
      if (field.min != null) input.min = String(field.min);
      if (field.step != null) input.step = String(field.step);
      const currentValue = reviewSteps[field.key];
      if (currentValue != null) {
        input.value = String(currentValue);
      }
      row.appendChild(input);
      advancedInputs.set(field.key, { type: 'number', input, allowZero: field.allowZero || false, min: field.min ?? 0 });
    }

    advancedGrid.appendChild(row);
  });

  const saveReviewBtn = document.createElement('button');
  saveReviewBtn.type = 'submit';
  saveReviewBtn.className = 'btn';
  saveReviewBtn.textContent = 'Save review settings';
  reviewForm.appendChild(saveReviewBtn);

  const reviewStatus = document.createElement('p');
  reviewStatus.className = 'settings-review-status';
  reviewStatus.hidden = true;
  reviewForm.appendChild(reviewStatus);

  reviewForm.addEventListener('submit', async event => {
    event.preventDefault();
    reviewStatus.textContent = '';
    reviewStatus.hidden = true;
    reviewStatus.classList.remove('is-error');

    const nextSteps = {};
    for (const [rating, control] of reviewInputs) {
      const minutes = convertToMinutes(control.amount.value, control.unit.value);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        reviewStatus.textContent = 'Enter a positive time for each rating button.';
        reviewStatus.classList.add('is-error');
        reviewStatus.hidden = false;
        control.amount.focus();
        return;
      }
      nextSteps[rating] = minutes;
    }

    const advancedPatch = {};

    const failField = (message, input) => {
      reviewStatus.textContent = message;
      reviewStatus.classList.add('is-error');
      reviewStatus.hidden = false;
      if (input) input.focus();
      return false;
    };

    const parseListField = (key, label) => {
      const entry = advancedInputs.get(key);
      if (!entry || entry.type !== 'list') return true;
      const raw = (entry.input.value || '').trim();
      if (!raw) return true;
      const values = parseDurationListString(raw);
      if (!values || !values.length) {
        return failField(`Enter positive times for ${label}.`, entry.input);
      }
      advancedPatch[key] = values;
      return true;
    };

    const parseDurationField = (key, label) => {
      const entry = advancedInputs.get(key);
      if (!entry || entry.type !== 'duration') return true;
      const minutes = convertToMinutes(entry.amount.value, entry.unit.value);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return failField(`Enter a positive time for ${label}.`, entry.amount);
      }
      advancedPatch[key] = minutes;
      return true;
    };

    const parseNumberField = (key, label, { min = 0, allowZero = false } = {}) => {
      const entry = advancedInputs.get(key);
      if (!entry || entry.type !== 'number') return true;
      const raw = entry.input.value;
      if (raw == null || raw === '') return true;
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return failField(`Enter a number for ${label}.`, entry.input);
      }
      if (value < min && !(allowZero && value === 0)) {
        return failField(`Value for ${label} must be at least ${min}.`, entry.input);
      }
      if (!allowZero && value === 0) {
        return failField(`Value for ${label} must be greater than zero.`, entry.input);
      }
      advancedPatch[key] = value;
      return true;
    };

    if (!parseListField('learningSteps', 'extra learning reviews')) return;
    if (!parseListField('relearningSteps', 'relearning reviews')) return;
    if (!parseDurationField('graduatingGood', 'the “Good” graduation delay')) return;
    if (!parseDurationField('graduatingEasy', 'the “Easy” graduation delay')) return;
    if (!parseNumberField('startingEase', 'starting ease', { min: 0.5, allowZero: false })) return;
    if (!parseNumberField('minimumEase', 'minimum ease', { min: 0.5, allowZero: false })) return;
    if (!parseNumberField('easeBonus', 'easy bonus', { min: 0, allowZero: true })) return;
    if (!parseNumberField('easePenalty', '“Again” penalty', { min: 0, allowZero: true })) return;
    if (!parseNumberField('hardEasePenalty', '“Hard” penalty', { min: 0, allowZero: true })) return;
    if (!parseNumberField('hardIntervalMultiplier', '“Hard” interval multiplier', { min: 0.1, allowZero: false })) return;
    if (!parseNumberField('easyIntervalBonus', '“Easy” interval bonus', { min: 0.1, allowZero: false })) return;
    if (!parseNumberField('intervalModifier', 'overall pacing multiplier', { min: 0.1, allowZero: false })) return;
    if (!parseNumberField('lapseIntervalMultiplier', 'lapse interval restart', { min: 0.1, allowZero: false })) return;

    Object.assign(nextSteps, advancedPatch);

    const originalText = saveReviewBtn.textContent;
    saveReviewBtn.disabled = true;
    saveReviewBtn.textContent = 'Saving…';

    try {
      await saveSettings({ reviewSteps: nextSteps });
      const updated = await getSettings();
      const normalized = {
        ...DEFAULT_REVIEW_STEPS,
        ...(updated?.reviewSteps || {})
      };
      for (const [rating, control] of reviewInputs) {
        const value = normalized[rating];
        const parts = minutesToParts(value);
        control.amount.value = parts.value !== '' ? String(parts.value) : '';
        control.unit.value = parts.unit;
      }
      for (const [key, entry] of advancedInputs) {
        if (!entry) continue;
        const value = normalized[key];
        if (entry.type === 'list') {
          if (Array.isArray(value)) {
            entry.input.value = value.map(formatDurationDisplay).filter(Boolean).join(', ');
          } else {
            entry.input.value = '';
          }
        } else if (entry.type === 'duration') {
          const parts = minutesToParts(value);
          entry.amount.value = parts.value !== '' ? String(parts.value) : '';
          entry.unit.value = parts.unit;
        } else if (entry.type === 'number') {
          entry.input.value = value != null ? String(value) : '';
        }
      }
      reviewStatus.textContent = 'Review settings saved.';
      reviewStatus.hidden = false;
    } catch (err) {
      console.warn('Failed to save review settings', err);
      reviewStatus.textContent = 'Failed to save review settings.';
      reviewStatus.classList.add('is-error');
      reviewStatus.hidden = false;
    } finally {
      saveReviewBtn.disabled = false;
      saveReviewBtn.textContent = originalText;
    }
  });

  reviewCard.appendChild(reviewForm);
  layout.appendChild(reviewCard);

  const passDefaultsCard = document.createElement('section');
  passDefaultsCard.className = 'card';
  const passHeading = document.createElement('h2');
  passHeading.textContent = 'Lecture pass defaults';
  passDefaultsCard.appendChild(passHeading);

  const passDescription = document.createElement('p');
  passDescription.className = 'settings-pass-description';
  passDescription.textContent = 'Configure the default pass count, timing, and pass functions applied to new lectures.';
  passDefaultsCard.appendChild(passDescription);

  const passForm = document.createElement('form');
  passForm.className = 'settings-pass-form';
  passDefaultsCard.appendChild(passForm);

  let currentPlannerDefaults = plannerDefaults;
  const defaultPlan = plannerDefaultsToPassPlan(currentPlannerDefaults);
  let planTemplate = defaultPlan;
  let passConfigs = Array.isArray(defaultPlan.schedule)
    ? defaultPlan.schedule.map(step => ({ ...step }))
    : [];
  let passColors = Array.isArray(currentPlannerDefaults?.passColors) && currentPlannerDefaults.passColors.length
    ? currentPlannerDefaults.passColors.slice()
    : DEFAULT_PASS_COLORS.slice();

  function ensurePassColorCount(count) {
    const normalized = Math.max(0, Number.isFinite(count) ? Math.round(count) : 0);
    const next = [];
    for (let i = 0; i < normalized; i += 1) {
      const existing = passColors[i];
      if (typeof existing === 'string' && existing.trim()) {
        next.push(existing.trim());
      } else {
        next.push(DEFAULT_PASS_COLORS[i % DEFAULT_PASS_COLORS.length]);
      }
    }
    passColors = next;
  }

  function resolvedPassColor(index) {
    if (typeof passColors[index] === 'string' && passColors[index].trim()) {
      return passColors[index].trim();
    }
    return DEFAULT_PASS_COLORS[index % DEFAULT_PASS_COLORS.length];
  }

  ensurePassColorCount(passConfigs.length);

  const passCountField = document.createElement('label');
  passCountField.className = 'lecture-pass-count settings-pass-count';
  passCountField.textContent = 'Default pass count';
  const passCountInput = document.createElement('input');
  passCountInput.type = 'number';
  passCountInput.min = '0';
  passCountInput.max = String(MAX_PASS_COUNT);
  passCountInput.className = 'input';
  passCountInput.value = String(passConfigs.length);
  passCountField.appendChild(passCountInput);
  const passCountHelp = document.createElement('span');
  passCountHelp.className = 'lecture-pass-help';
  passCountHelp.textContent = 'Set the default number of spaced passes for new lectures.';
  passCountField.appendChild(passCountHelp);
  passForm.appendChild(passCountField);

  const passColorSection = document.createElement('div');
  passColorSection.className = 'settings-pass-colors';
  const passColorTitle = document.createElement('h3');
  passColorTitle.className = 'settings-pass-colors-title';
  passColorTitle.textContent = 'Pass colors';
  passColorSection.appendChild(passColorTitle);
  const passColorHint = document.createElement('p');
  passColorHint.className = 'settings-pass-colors-hint';
  passColorHint.textContent = 'Choose the accent color used for pass chips and timeline bars.';
  passColorSection.appendChild(passColorHint);
  const passColorList = document.createElement('div');
  passColorList.className = 'settings-pass-color-list';
  passColorSection.appendChild(passColorList);
  const passColorActions = document.createElement('div');
  passColorActions.className = 'settings-pass-color-actions';
  const passColorReset = document.createElement('button');
  passColorReset.type = 'button';
  passColorReset.className = 'settings-pass-colors-reset';
  passColorReset.textContent = 'Reset to defaults';
  passColorActions.appendChild(passColorReset);
  passColorSection.appendChild(passColorActions);
  passForm.appendChild(passColorSection);

  const passSummary = document.createElement('div');
  passSummary.className = 'lecture-pass-summary-line settings-pass-summary';
  passForm.appendChild(passSummary);

  const passAdvanced = document.createElement('details');
  passAdvanced.className = 'lecture-pass-advanced settings-pass-advanced';
  passAdvanced.open = true;
  const passAdvancedSummary = document.createElement('summary');
  passAdvancedSummary.textContent = `Pass details (${passConfigs.length})`;
  passAdvanced.appendChild(passAdvancedSummary);

  const passAdvancedHint = document.createElement('p');
  passAdvancedHint.className = 'lecture-pass-advanced-hint';
  passAdvancedHint.textContent = 'Tune the pass function and spacing for each default pass.';
  passAdvanced.appendChild(passAdvancedHint);

  const passList = document.createElement('div');
  passList.className = 'lecture-pass-editor settings-pass-editor';
  passAdvanced.appendChild(passList);
  passForm.appendChild(passAdvanced);

  const passStatus = document.createElement('p');
  passStatus.className = 'settings-pass-status';
  passStatus.hidden = true;
  passForm.appendChild(passStatus);

  const passSaveBtn = document.createElement('button');
  passSaveBtn.type = 'submit';
  passSaveBtn.className = 'btn';
  passSaveBtn.textContent = 'Save pass defaults';
  passForm.appendChild(passSaveBtn);

  function updatePassSummary() {
    if (!passConfigs.length) {
      passSummary.textContent = 'No default passes scheduled.';
    } else {
      const previewPlan = buildPassPlanPayload(passConfigs, planTemplate);
      const previewText = formatPassPlan(previewPlan);
      const cleaned = previewText.startsWith('Plan: ')
        ? previewText.slice(6)
        : previewText;
      passSummary.textContent = `${passConfigs.length} pass${passConfigs.length === 1 ? '' : 'es'} • ${cleaned}`;
    }
    passAdvancedSummary.textContent = `Pass details (${passConfigs.length})`;
  }

  function renderPassColorInputs() {
    passColorList.innerHTML = '';
    ensurePassColorCount(passConfigs.length);
    if (!passColors.length) {
      passColorReset.disabled = true;
      const empty = document.createElement('p');
      empty.className = 'settings-pass-colors-empty';
      empty.textContent = 'Increase the pass count above to configure colors.';
      passColorList.appendChild(empty);
      return;
    }
    passColorReset.disabled = false;
    passColors = passColors.map((_, index) => resolvedPassColor(index));
    passColors.forEach((color, index) => {
      const row = document.createElement('div');
      row.className = 'settings-pass-color';
      const label = document.createElement('span');
      label.className = 'settings-pass-color-label';
      label.textContent = `Pass ${index + 1}`;
      const swatch = document.createElement('span');
      swatch.className = 'settings-pass-color-swatch';
      swatch.style.setProperty('--swatch-color', color);
      const input = document.createElement('input');
      input.className = 'input settings-pass-color-input';
      input.type = 'text';
      input.value = color;
      input.placeholder = DEFAULT_PASS_COLORS[index % DEFAULT_PASS_COLORS.length];
      input.addEventListener('input', event => {
        const next = event.target.value.trim();
        const value = next || DEFAULT_PASS_COLORS[index % DEFAULT_PASS_COLORS.length];
        passColors[index] = value;
        swatch.style.setProperty('--swatch-color', value);
      });
      row.append(label, swatch, input);
      passColorList.appendChild(row);
    });
  }

  function renderPassEditor() {
    passList.innerHTML = '';
    if (!passConfigs.length) {
      const empty = document.createElement('div');
      empty.className = 'lecture-pass-empty';
      empty.textContent = 'No passes planned. Increase the count above to build a default schedule.';
      passList.appendChild(empty);
      updatePassSummary();
      renderPassColorInputs();
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
    renderPassColorInputs();
  }

  renderPassEditor();

  passColorReset.addEventListener('click', () => {
    passColors = DEFAULT_PASS_COLORS.slice(0, passConfigs.length || DEFAULT_PASS_COLORS.length);
    ensurePassColorCount(passConfigs.length);
    renderPassColorInputs();
  });

  passCountInput.addEventListener('change', () => {
    const next = clampPassCount(passCountInput.value);
    passCountInput.value = String(next);
    const template = passConfigs.length
      ? { schedule: passConfigs.slice() }
      : planTemplate;
    passConfigs = adjustPassConfigs(passConfigs, next, template);
    ensurePassColorCount(next);
    renderPassEditor();
  });

  passForm.addEventListener('submit', async event => {
    event.preventDefault();
    passStatus.textContent = '';
    passStatus.hidden = true;
    passStatus.classList.remove('is-error');

    const anchorOffsets = {
      ...(DEFAULT_PLANNER_DEFAULTS.anchorOffsets || {}),
      ...(currentPlannerDefaults?.anchorOffsets || {})
    };
    const payloadPlan = buildPassPlanPayload(passConfigs, planTemplate);
    const payloadPasses = payloadPlan.schedule.map(step => ({
      order: step.order,
      label: step.label,
      offsetMinutes: step.offsetMinutes,
      anchor: step.anchor,
      action: step.action
    }));

    const originalText = passSaveBtn.textContent;
    passSaveBtn.disabled = true;
    passSaveBtn.textContent = 'Saving…';

    const palette = passColors.map((color, index) => {
      if (typeof color === 'string') {
        const trimmed = color.trim();
        if (trimmed) return trimmed;
      }
      return DEFAULT_PASS_COLORS[index % DEFAULT_PASS_COLORS.length];
    });

    try {
      await saveSettings({ plannerDefaults: { anchorOffsets, passes: payloadPasses, passColors: palette } });
      const updated = await getSettings();
      currentPlannerDefaults = updated?.plannerDefaults || DEFAULT_PLANNER_DEFAULTS;
      const refreshedPlan = plannerDefaultsToPassPlan(currentPlannerDefaults);
      planTemplate = refreshedPlan;
      passConfigs = Array.isArray(refreshedPlan.schedule)
        ? refreshedPlan.schedule.map(step => ({ ...step }))
        : [];
      passColors = Array.isArray(currentPlannerDefaults?.passColors) && currentPlannerDefaults.passColors.length
        ? currentPlannerDefaults.passColors.slice()
        : DEFAULT_PASS_COLORS.slice();
      passCountInput.value = String(passConfigs.length);
      renderPassEditor();
      passStatus.textContent = 'Pass defaults saved.';
      passStatus.hidden = false;
    } catch (err) {
      console.warn('Failed to save pass defaults', err);
      passStatus.textContent = 'Failed to save pass defaults.';
      passStatus.classList.add('is-error');
      passStatus.hidden = false;
    } finally {
      passSaveBtn.disabled = false;
      passSaveBtn.textContent = originalText;
    }
  });

  layout.appendChild(passDefaultsCard);

  const dataCard = document.createElement('section');
  dataCard.className = 'card';
  const dHeading = document.createElement('h2');
  dHeading.textContent = 'Data';
  dataCard.appendChild(dHeading);

  async function triggerExportDownload(options = {}) {
    const { prefix = 'arc-export', withTimestamp = false } = options;
    const dump = await exportJSON();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = withTimestamp ? `-${timestamp}` : '';
    const a = document.createElement('a');
    a.href = url;
    a.download = `${prefix}${suffix}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn';
  exportBtn.textContent = 'Export DB';
  exportBtn.addEventListener('click', async () => {
    try {
      await triggerExportDownload();
    } catch (err) {
      console.error('Failed to export database', err);
      alert('Export failed');
    }
  });
  dataCard.appendChild(exportBtn);

  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json,.arc';
  importInput.style.display = 'none';
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const confirmBackup = window.confirm(
        'Importing will replace your current data. Would you like to download a backup first?'
      );
      if (confirmBackup) {
        try {
          await triggerExportDownload({ prefix: 'arc-backup', withTimestamp: true });
        } catch (err) {
          console.error('Failed to create backup prior to import', err);
          alert('Backup failed. Import cancelled.');
          importInput.value = '';
          return;
        }
      }
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await importJSON(json);
      if (!res?.ok) {
        alert(res?.message || 'Import failed');
        return;
      }
      alert(res.message || 'Import complete');
      location.reload();
    } catch (e) {
      alert('Import failed');
    } finally {
      importInput.value = '';
    }
  });

  const importBtn = document.createElement('button');
  importBtn.className = 'btn';
  importBtn.textContent = 'Import DB';
  importBtn.addEventListener('click', () => importInput.click());
  dataCard.appendChild(importBtn);
  dataCard.appendChild(importInput);

  const ankiBtn = document.createElement('button');
  ankiBtn.className = 'btn';
  ankiBtn.textContent = 'Export Anki CSV';
  ankiBtn.addEventListener('click', async () => {
    const dump = await exportJSON();
    const blob = await exportAnkiCSV('qa', dump.items || []);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arc-anki.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  dataCard.appendChild(ankiBtn);

  layout.appendChild(dataCard);
}
