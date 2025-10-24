import { REVIEW_RATINGS, RETIRE_RATING, DEFAULT_REVIEW_STEPS } from './constants.js';

export const SR_VERSION = 2;

function sanitizeNumber(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
}

export function defaultSectionState() {
  return {
    streak: 0,
    lastRating: null,
    last: 0,
    due: 0,
    retired: false,
    suspended: false,
    contentDigest: null,
    lectureScope: [],
    interval: 0,
    ease: DEFAULT_REVIEW_STEPS.startingEase,
    lapses: 0,
    learningStepIndex: 0,
    phase: 'new',
    pendingInterval: 0
  };
}

export function normalizeSectionRecord(record) {
  const base = defaultSectionState();
  if (!record || typeof record !== 'object') return base;
  if (typeof record.streak === 'number' && Number.isFinite(record.streak) && record.streak > 0) {
    base.streak = Math.max(0, Math.round(record.streak));
  }
  if (typeof record.lastRating === 'string') {
    const rating = record.lastRating;
    if (REVIEW_RATINGS.includes(rating) || rating === RETIRE_RATING) {
      base.lastRating = rating;
    }
  }
  base.last = sanitizeNumber(record.last, 0);
  base.due = sanitizeNumber(record.due, 0);
  base.retired = Boolean(record.retired);
  if (typeof record.suspended === 'boolean') {
    base.suspended = record.suspended;
  }
  if (typeof record.contentDigest === 'string' && record.contentDigest) {
    base.contentDigest = record.contentDigest;
  }
  if (Array.isArray(record.lectureScope) && record.lectureScope.length) {
    const normalizedScope = record.lectureScope
      .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);
    base.lectureScope = Array.from(new Set(normalizedScope)).sort();
  }
  if (typeof record.interval === 'number' && Number.isFinite(record.interval) && record.interval >= 0) {
    base.interval = Math.max(0, record.interval);
  }
  if (typeof record.ease === 'number' && Number.isFinite(record.ease) && record.ease > 0) {
    base.ease = record.ease;
  }
  if (typeof record.lapses === 'number' && Number.isFinite(record.lapses) && record.lapses >= 0) {
    base.lapses = Math.max(0, Math.round(record.lapses));
  }
  if (typeof record.learningStepIndex === 'number' && Number.isFinite(record.learningStepIndex) && record.learningStepIndex >= 0) {
    base.learningStepIndex = Math.max(0, Math.round(record.learningStepIndex));
  }
  if (typeof record.phase === 'string') {
    const phase = record.phase.trim();
    const allowed = ['new', 'learning', 'review', 'relearning', 'suspended'];
    if (allowed.includes(phase)) {
      base.phase = phase;
    }
  }
  if (typeof record.pendingInterval === 'number' && Number.isFinite(record.pendingInterval) && record.pendingInterval >= 0) {
    base.pendingInterval = Math.max(0, record.pendingInterval);
  }
  return base;
}

export function normalizeSrRecord(sr) {
  const normalized = { version: SR_VERSION, sections: {} };
  if (!sr || typeof sr !== 'object') return normalized;
  const sections = sr.sections && typeof sr.sections === 'object' ? sr.sections : {};
  for (const [key, value] of Object.entries(sections)) {
    if (!key) continue;
    normalized.sections[key] = normalizeSectionRecord(value);
  }
  return normalized;
}
