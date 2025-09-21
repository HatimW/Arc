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

  const layout = document.createElement('div');
  layout.className = 'settings-layout';
  root.appendChild(layout);

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
  stepsHeading.textContent = 'Spaced repetition steps (minutes)';
  reviewForm.appendChild(stepsHeading);

  const grid = document.createElement('div');
  grid.className = 'settings-review-grid';
  reviewForm.appendChild(grid);

  const labels = {
    again: 'Again',
    hard: 'Hard',
    good: 'Good',
    easy: 'Easy'
  };

  const reviewInputs = new Map();
  for (const rating of REVIEW_RATINGS) {
    const row = document.createElement('label');
    row.className = 'settings-review-row';

    const label = document.createElement('span');
    label.textContent = labels[rating] || rating;
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.required = true;
    input.className = 'input settings-review-input';
    input.value = String(reviewSteps[rating] ?? DEFAULT_REVIEW_STEPS[rating]);
    input.dataset.rating = rating;
    row.appendChild(input);

    reviewInputs.set(rating, input);
    grid.appendChild(row);
  }

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
    for (const [rating, input] of reviewInputs) {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0) {
        reviewStatus.textContent = 'Enter a positive number of minutes for each step.';
        reviewStatus.classList.add('is-error');
        reviewStatus.hidden = false;
        input.focus();
        return;
      }
      const rounded = Math.max(1, Math.round(value));
      nextSteps[rating] = rounded;
    }

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
      for (const [rating, input] of reviewInputs) {
        const value = normalized[rating];
        if (Number.isFinite(value) && value > 0) {
          input.value = String(value);
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

  function renderPassEditor() {
    passList.innerHTML = '';
    if (!passConfigs.length) {
      const empty = document.createElement('div');
      empty.className = 'lecture-pass-empty';
      empty.textContent = 'No passes planned. Increase the count above to build a default schedule.';
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
    const template = passConfigs.length
      ? { schedule: passConfigs.slice() }
      : planTemplate;
    passConfigs = adjustPassConfigs(passConfigs, next, template);
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

    try {
      await saveSettings({ plannerDefaults: { anchorOffsets, passes: payloadPasses } });
      const updated = await getSettings();
      currentPlannerDefaults = updated?.plannerDefaults || DEFAULT_PLANNER_DEFAULTS;
      const refreshedPlan = plannerDefaultsToPassPlan(currentPlannerDefaults);
      planTemplate = refreshedPlan;
      passConfigs = Array.isArray(refreshedPlan.schedule)
        ? refreshedPlan.schedule.map(step => ({ ...step }))
        : [];
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

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn';
  exportBtn.textContent = 'Export DB';
  exportBtn.addEventListener('click', async () => {
    const dump = await exportJSON();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sevenn-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  dataCard.appendChild(exportBtn);

  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json';
  importInput.style.display = 'none';
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await importJSON(json);
      alert(res.message);
      location.reload();
    } catch (e) {
      alert('Import failed');
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
    a.download = 'sevenn-anki.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  dataCard.appendChild(ankiBtn);

  layout.appendChild(dataCard);
}
