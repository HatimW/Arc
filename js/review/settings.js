import { DEFAULT_REVIEW_STEPS, REVIEW_RATINGS } from './constants.js';

const NUMERIC_KEYS = [
  'graduatingGood',
  'graduatingEasy',
  'startingEase',
  'minimumEase',
  'easeBonus',
  'easePenalty',
  'hardEasePenalty',
  'hardIntervalMultiplier',
  'easyIntervalBonus',
  'intervalModifier',
  'lapseIntervalMultiplier'
];

const DURATION_NUMERIC_KEYS = new Set(['graduatingGood', 'graduatingEasy']);

const STEP_ARRAY_KEYS = ['learningSteps', 'relearningSteps'];

const DURATION_UNIT_FACTORS = {
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

function toNumber(value, { min = 0, fallback = 0, allowZero = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return allowZero && num === 0 ? 0 : fallback;
  return num;
}

function parseDurationValue(raw, fallback = null, { allowZero = false } = {}) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fallback;
    if (raw < 0 || (!allowZero && raw === 0)) return fallback;
    const clamped = allowZero ? Math.max(0, raw) : Math.max(1, raw);
    return Math.round(clamped);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      if (numeric < 0 || (!allowZero && numeric === 0)) return fallback;
      const clamped = allowZero ? Math.max(0, numeric) : Math.max(1, numeric);
      return Math.round(clamped);
    }
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (!match) return fallback;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return fallback;
    const unitToken = (match[2] || 'minutes').toLowerCase();
    const factor = DURATION_UNIT_FACTORS[unitToken];
    if (!factor) return fallback;
    const minutes = value * factor;
    if (!Number.isFinite(minutes)) return fallback;
    if (minutes < 0 || (!allowZero && minutes === 0)) return fallback;
    const clamped = allowZero ? Math.max(0, minutes) : Math.max(1, minutes);
    return Math.round(clamped);
  }
  return fallback;
}

function parseStepList(raw, fallback = []) {
  const ensurePositive = (value) => {
    const minutes = parseDurationValue(value, null);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  };
  if (Array.isArray(raw)) {
    const parsed = raw.map(ensurePositive).filter((v) => v != null);
    return parsed.length ? parsed : fallback;
  }
  if (typeof raw === 'string') {
    const parsed = raw
      .split(/[;,\n]+/)
      .map(entry => ensurePositive(entry))
      .filter((v) => v != null);
    return parsed.length ? parsed : fallback;
  }
  return fallback;
}

export function normalizeReviewSteps(raw) {
  const normalized = { ...DEFAULT_REVIEW_STEPS };
  if (!raw || typeof raw !== 'object') return normalized;
  for (const key of REVIEW_RATINGS) {
    const value = raw[key];
    const minutes = parseDurationValue(value, null);
    if (Number.isFinite(minutes) && minutes > 0) {
      normalized[key] = minutes;
    }
  }

  for (const key of STEP_ARRAY_KEYS) {
    const list = parseStepList(raw[key], normalized[key]);
    normalized[key] = list.length ? list : normalized[key];
  }

  for (const key of NUMERIC_KEYS) {
    const defaults = DEFAULT_REVIEW_STEPS[key];
    const fallback = typeof defaults === 'number' ? defaults : 0;
    if (DURATION_NUMERIC_KEYS.has(key)) {
      const minutes = parseDurationValue(raw[key], fallback);
      normalized[key] = Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
      continue;
    }
    const min = key.endsWith('Ease') ? 0 : 0.0001;
    const allowZero = key === 'intervalModifier';
    const value = toNumber(raw[key], { min, fallback, allowZero });
    if (key === 'minimumEase') {
      normalized[key] = Math.max(0.5, value);
    } else if (key === 'startingEase') {
      normalized[key] = Math.max(normalized.minimumEase || 1.3, value);
    } else if (key === 'intervalModifier' && value <= 0) {
      normalized[key] = fallback || 1;
    } else {
      normalized[key] = value;
    }
  }

  // Ensure ease constraints remain valid after normalization.
  if (normalized.startingEase < normalized.minimumEase) {
    normalized.startingEase = normalized.minimumEase;
  }

  return normalized;
}
