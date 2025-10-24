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

const STEP_ARRAY_KEYS = ['learningSteps', 'relearningSteps'];

function toNumber(value, { min = 0, fallback = 0, allowZero = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return allowZero && num === 0 ? 0 : fallback;
  return num;
}

function parseStepList(raw, fallback = []) {
  const ensurePositive = (value) => {
    const minutes = Math.round(Number(value));
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  };
  if (Array.isArray(raw)) {
    const parsed = raw.map(ensurePositive).filter((v) => v != null);
    return parsed.length ? parsed : fallback;
  }
  if (typeof raw === 'string') {
    const parsed = raw
      .split(/[,\s]+/)
      .map(ensurePositive)
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
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      normalized[key] = Math.round(num);
    }
  }

  for (const key of STEP_ARRAY_KEYS) {
    const list = parseStepList(raw[key], normalized[key]);
    normalized[key] = list.length ? list : normalized[key];
  }

  for (const key of NUMERIC_KEYS) {
    const defaults = DEFAULT_REVIEW_STEPS[key];
    const fallback = typeof defaults === 'number' ? defaults : 0;
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
