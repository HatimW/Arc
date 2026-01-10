import { getSettings } from '../storage/storage.js';
import { sectionsForItem, hasSectionContent, getSectionContent } from '../ui/components/section-utils.js';
import { DEFAULT_REVIEW_STEPS, REVIEW_RATINGS, RETIRE_RATING } from './constants.js';
import { normalizeReviewSteps } from './settings.js';
import { SR_VERSION, defaultSectionState, normalizeSectionRecord, normalizeSrRecord } from './sr-data.js';

const UNASSIGNED_LECTURE_TOKEN = '__unassigned|__none';

function digestContent(value) {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return null;
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0; // eslint-disable-line no-bitwise
  }
  return hash.toString(16);
}

function normalizeLectureScope(scope) {
  if (!Array.isArray(scope) || !scope.length) return [];
  const normalized = scope
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}

function computeLectureScope(item) {
  if (!item || !Array.isArray(item.lectures) || !item.lectures.length) {
    return [UNASSIGNED_LECTURE_TOKEN];
  }
  const tokens = item.lectures.map(lecture => {
    if (!lecture || typeof lecture !== 'object') return '';
    const blockId = lecture.blockId == null ? '' : String(lecture.blockId);
    const id = lecture.id == null ? '' : String(lecture.id);
    return `${blockId}|${id}`.trim();
  });
  return normalizeLectureScope(tokens);
}

function computeSectionDigest(item, key) {
  if (!item || !key) return null;
  const raw = getSectionContent(item, key);
  return digestContent(raw);
}

let cachedDurations = null;

export async function getReviewDurations() {
  if (cachedDurations) return cachedDurations;
  try {
    const settings = await getSettings();
    cachedDurations = normalizeReviewSteps(settings?.reviewSteps);
  } catch (err) {
    console.warn('Failed to load review settings, using defaults', err);
    cachedDurations = { ...DEFAULT_REVIEW_STEPS };
  }
  return cachedDurations;
}

export function invalidateReviewDurationsCache() {
  cachedDurations = null;
}

export function ensureItemSr(item) {
  if (!item || typeof item !== 'object') return { version: SR_VERSION, sections: {} };
  const sr = item.sr && typeof item.sr === 'object' ? item.sr : { version: SR_VERSION, sections: {} };
  if (sr.version !== SR_VERSION || typeof sr.sections !== 'object' || !sr.sections) {
    item.sr = normalizeSrRecord(sr);
    return item.sr;
  }
  item.sr.sections = item.sr.sections || {};
  return item.sr;
}

export function ensureSectionState(item, key) {
  const sr = ensureItemSr(item);
  if (!sr.sections[key] || typeof sr.sections[key] !== 'object') {
    sr.sections[key] = defaultSectionState();
  } else {
    sr.sections[key] = normalizeSectionRecord(sr.sections[key]);
  }
  return sr.sections[key];
}

export function getSectionStateSnapshot(item, key) {
  const sr = item?.sr;
  if (!sr || typeof sr !== 'object') return null;
  const entry = sr.sections && typeof sr.sections === 'object' ? sr.sections[key] : null;
  if (!entry || typeof entry !== 'object') return null;
  const normalized = normalizeSectionRecord(entry);
  const digest = computeSectionDigest(item, key);
  const scope = computeLectureScope(item);
  const storedDigest = normalized.contentDigest;
  const storedScope = normalizeLectureScope(normalized.lectureScope);
  const removedLectures = storedScope.length ? storedScope.some(token => !scope.includes(token)) : false;
  const contentChanged = storedDigest != null && digest != null && storedDigest !== digest;
  if (contentChanged || removedLectures) {
    const nowTs = Date.now();
    normalized.streak = 0;
    normalized.lastRating = null;
    normalized.last = nowTs;
    normalized.due = nowTs;
    normalized.retired = false;
    normalized.suspended = false;
    normalized.phase = 'new';
    normalized.learningStepIndex = 0;
    normalized.interval = 0;
    normalized.pendingInterval = 0;
    normalized.ease = DEFAULT_REVIEW_STEPS.startingEase;
    normalized.lapses = 0;
  }
  normalized.contentDigest = digest;
  normalized.lectureScope = scope;
  sr.sections[key] = normalized;
  return normalized;
}

function asMinutes(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.round(num));
}

function normalizeStepList(list, fallback) {
  if (Array.isArray(list) && list.length) {
    const parsed = list
      .map((value) => asMinutes(value, 0))
      .filter((value) => value > 0);
    if (parsed.length) return parsed;
  }
  return fallback;
}

function ensurePhase(section) {
  if (!section.phase) {
    section.phase = section.interval > 0 ? 'review' : 'new';
  }
  if (section.phase === 'suspended') {
    section.phase = section.interval > 0 ? 'review' : 'learning';
  }
  return section.phase;
}

function minutesToMs(minutes) {
  return Math.max(0, Math.round(minutes * 60 * 1000));
}

function scheduleDue(section, minutes, now) {
  const clamped = Math.max(1, Math.round(minutes));
  section.due = now + minutesToMs(clamped);
  return clamped;
}

function applyRatingState(section, rating, config, now) {
  if (rating === RETIRE_RATING) {
    section.streak = 0;
    section.lastRating = RETIRE_RATING;
    section.last = now;
    section.interval = Number.MAX_SAFE_INTEGER;
    section.pendingInterval = 0;
    section.phase = 'review';
    section.due = Number.MAX_SAFE_INTEGER;
    section.retired = true;
    section.suspended = false;
    return section;
  }

  const normalizedRating = REVIEW_RATINGS.includes(rating) ? rating : 'good';
  const baseAgain = asMinutes(config.again ?? DEFAULT_REVIEW_STEPS.again, DEFAULT_REVIEW_STEPS.again);
  const baseHard = asMinutes(config.hard ?? DEFAULT_REVIEW_STEPS.hard, baseAgain);
  const baseGood = asMinutes(config.good ?? DEFAULT_REVIEW_STEPS.good, baseHard);
  const baseEasy = asMinutes(config.easy ?? DEFAULT_REVIEW_STEPS.easy, baseGood);
  const learningSteps = normalizeStepList(config.learningSteps, [baseAgain]);
  const relearningSteps = normalizeStepList(config.relearningSteps, [baseAgain]);
  const intervalModifier = Number.isFinite(config.intervalModifier) && config.intervalModifier > 0
    ? config.intervalModifier
    : 1;
  const lapseIntervalMultiplier = Number.isFinite(config.lapseIntervalMultiplier) && config.lapseIntervalMultiplier > 0
    ? config.lapseIntervalMultiplier
    : 0.5;
  const easyIntervalBonus = Number.isFinite(config.easyIntervalBonus) && config.easyIntervalBonus > 0
    ? config.easyIntervalBonus
    : 1.5;
  const hardIntervalMultiplier = Number.isFinite(config.hardIntervalMultiplier) && config.hardIntervalMultiplier > 0
    ? config.hardIntervalMultiplier
    : 1.2;
  const startingEase = Number.isFinite(config.startingEase) && config.startingEase > 0
    ? config.startingEase
    : DEFAULT_REVIEW_STEPS.startingEase;
  const minimumEase = Number.isFinite(config.minimumEase) && config.minimumEase > 0
    ? config.minimumEase
    : DEFAULT_REVIEW_STEPS.minimumEase;
  const easeBonus = Number.isFinite(config.easeBonus) ? config.easeBonus : DEFAULT_REVIEW_STEPS.easeBonus;
  const easePenalty = Number.isFinite(config.easePenalty) ? config.easePenalty : DEFAULT_REVIEW_STEPS.easePenalty;
  const hardEasePenalty = Number.isFinite(config.hardEasePenalty)
    ? config.hardEasePenalty
    : DEFAULT_REVIEW_STEPS.hardEasePenalty;

  ensurePhase(section);
  section.suspended = false;
  if (!Number.isFinite(section.ease) || section.ease <= 0) {
    section.ease = startingEase;
  }
  section.ease = Math.max(minimumEase, section.ease);
  section.retired = false;

  const applyReviewInterval = (minutes, { easeDelta = 0 } = {}) => {
    const finalMinutes = scheduleDue(section, minutes, now);
    section.interval = finalMinutes;
    section.pendingInterval = 0;
    section.learningStepIndex = 0;
    section.phase = 'review';
    section.ease = Math.max(minimumEase, section.ease + easeDelta);
    section.streak = Math.max(1, (section.streak || 0) + 1);
  };

  const scheduleLearning = (minutes, nextIndex = 0) => {
    section.phase = 'learning';
    section.learningStepIndex = nextIndex;
    section.streak = 0;
    scheduleDue(section, minutes, now);
  };

  const scheduleRelearning = (minutes, nextIndex = 0) => {
    section.phase = 'relearning';
    section.learningStepIndex = nextIndex;
    section.streak = 0;
    scheduleDue(section, minutes, now);
  };

  const currentInterval = section.interval && Number.isFinite(section.interval)
    ? Math.max(1, Math.round(section.interval))
    : 0;

  if (section.phase === 'new' || section.phase === 'learning') {
    const index = Math.max(0, section.learningStepIndex || 0);
    if (normalizedRating === 'again') {
      scheduleLearning(learningSteps[0] ?? baseAgain, 0);
    } else if (normalizedRating === 'hard') {
      const step = learningSteps[Math.min(index, learningSteps.length - 1)] ?? baseHard;
      const extended = Math.max(step, Math.round(step * hardIntervalMultiplier));
      scheduleLearning(extended, index);
    } else if (normalizedRating === 'good') {
      const nextIndex = index + 1;
      if (nextIndex < learningSteps.length) {
        scheduleLearning(learningSteps[nextIndex] ?? baseGood, nextIndex);
      } else {
        const graduateInterval = asMinutes(config.graduatingGood ?? baseGood, baseGood) * intervalModifier;
        section.ease = Math.max(minimumEase, startingEase);
        applyReviewInterval(graduateInterval);
      }
    } else if (normalizedRating === 'easy') {
      const graduateInterval = asMinutes(config.graduatingEasy ?? baseEasy, baseEasy) * intervalModifier;
      section.ease = Math.max(minimumEase, startingEase + easeBonus);
      applyReviewInterval(graduateInterval);
    }
  } else if (section.phase === 'relearning') {
    const index = Math.max(0, section.learningStepIndex || 0);
    if (normalizedRating === 'again') {
      scheduleRelearning(relearningSteps[0] ?? baseAgain, 0);
    } else if (normalizedRating === 'hard') {
      const step = relearningSteps[Math.min(index, relearningSteps.length - 1)] ?? baseHard;
      const extended = Math.max(step, Math.round(step * hardIntervalMultiplier));
      scheduleRelearning(extended, index);
    } else {
      const nextIndex = index + 1;
      if (nextIndex < relearningSteps.length && normalizedRating !== 'easy') {
        scheduleRelearning(relearningSteps[nextIndex] ?? baseGood, nextIndex);
      } else {
        const pending = section.pendingInterval && section.pendingInterval > 0
          ? section.pendingInterval
          : Math.max(1, Math.round((currentInterval || baseGood) * lapseIntervalMultiplier));
        const intervalBase = normalizedRating === 'easy'
          ? Math.max(pending, Math.round(pending * easyIntervalBonus))
          : pending;
        const finalInterval = Math.max(1, Math.round(intervalBase * intervalModifier));
        const easeDelta = normalizedRating === 'easy' ? easeBonus : 0;
        section.ease = Math.max(minimumEase, section.ease + easeDelta);
        applyReviewInterval(finalInterval, { easeDelta: 0 });
        section.pendingInterval = 0;
      }
    }
  } else {
    if (normalizedRating === 'again') {
      section.ease = Math.max(minimumEase, section.ease - easePenalty);
      section.lapses = Math.max(0, (section.lapses || 0) + 1);
      section.interval = 0;
      section.pendingInterval = 0;
      scheduleLearning(learningSteps[0] ?? baseAgain, 0);
    } else if (normalizedRating === 'hard') {
      section.ease = Math.max(minimumEase, section.ease - hardEasePenalty);
      section.interval = 0;
      section.pendingInterval = 0;
      const hardIndex = learningSteps.length > 1 ? 1 : 0;
      const hardStep = learningSteps[Math.min(hardIndex, learningSteps.length - 1)] ?? baseHard;
      scheduleLearning(hardStep, Math.min(hardIndex, learningSteps.length - 1));
    } else if (normalizedRating === 'good') {
      const base = currentInterval || baseGood;
      const rawInterval = Math.max(base, Math.round(base * section.ease));
      const nextInterval = Math.max(1, Math.round(rawInterval * intervalModifier));
      applyReviewInterval(nextInterval);
    } else if (normalizedRating === 'easy') {
      const base = currentInterval || baseEasy;
      section.ease = Math.max(minimumEase, section.ease + easeBonus);
      const rawInterval = Math.max(base, Math.round(base * section.ease * easyIntervalBonus));
      const nextInterval = Math.max(1, Math.round(rawInterval * intervalModifier));
      applyReviewInterval(nextInterval);
    }
  }

  section.lastRating = normalizedRating;
  section.last = now;
  return section;
}

export function rateSection(item, key, rating, durations, now = Date.now()) {
  if (!item || !key) return null;
  const config = normalizeReviewSteps(durations);
  const section = ensureSectionState(item, key);
  section.contentDigest = computeSectionDigest(item, key);
  section.lectureScope = computeLectureScope(item);
  applyRatingState(section, rating, config, now);
  return section;
}

export function projectSectionRating(item, key, rating, durations, now = Date.now()) {
  if (!item || !key) return null;
  const snapshot = getSectionStateSnapshot(item, key);
  if (!snapshot) return null;
  const config = normalizeReviewSteps(durations);
  const copy = JSON.parse(JSON.stringify(snapshot));
  applyRatingState(copy, rating, config, now);
  return copy;
}

export function suspendSection(item, key, now = Date.now()) {
  if (!item || !key) return null;
  const section = ensureSectionState(item, key);
  section.suspended = true;
  section.last = now;
  section.phase = 'suspended';
  section.due = Number.MAX_SAFE_INTEGER;
  return section;
}

export function resumeSection(item, key, now = Date.now()) {
  if (!item || !key) return null;
  const section = ensureSectionState(item, key);
  section.suspended = false;
  section.last = now;
  if (!section.phase || section.phase === 'suspended') {
    section.phase = section.interval > 0 ? 'review' : 'learning';
  }
  if (!Number.isFinite(section.due) || section.due === Number.MAX_SAFE_INTEGER) {
    section.due = now;
  }
  return section;
}

export function hasContentForSection(item, key) {
  return hasSectionContent(item, key);
}

function classifySectionCategory(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'new';
  const lastRating = typeof snapshot.lastRating === 'string' ? snapshot.lastRating : null;
  const phase = snapshot.phase;
  if (phase === 'review') return 'review';
  if (phase === 'relearning') return 'learning';
  if (phase === 'learning') {
    if (!lastRating || lastRating === 'again') return 'new';
    return 'learning';
  }
  if (lastRating === 'again') return 'new';
  if (lastRating === 'easy' || lastRating === 'good' || lastRating === 'hard') return 'learning';
  return 'new';
}

function collectReviewEntries(items, { now = Date.now(), predicate } = {}) {
  const results = [];
  if (!Array.isArray(items) || !items.length) return results;
  for (const item of items) {
    const sections = sectionsForItem(item);
    for (const section of sections) {
      const snapshot = getSectionStateSnapshot(item, section.key);
      if (!snapshot || snapshot.retired || snapshot.suspended) continue;
      if (typeof predicate === 'function' && !predicate(snapshot, now, item, section)) continue;
      const category = classifySectionCategory(snapshot);
      results.push({
        item,
        itemId: item.id,
        sectionKey: section.key,
        sectionLabel: section.label,
        due: snapshot.due,
        phase: snapshot.phase,
        state: snapshot,
        category
      });
    }
  }
  results.sort((a, b) => a.due - b.due);
  return results;
}

export function collectDueSections(items, { now = Date.now() } = {}) {
  return collectReviewEntries(items, {
    now,
    predicate: (snapshot, currentNow) => Boolean(snapshot.last) && snapshot.due <= currentNow
  });
}

export function collectAllSections(items, { now = Date.now() } = {}) {
  return collectReviewEntries(items, { now });
}

export function collectUpcomingSections(items, { now = Date.now(), limit = 50 } = {}) {
  const entries = collectReviewEntries(items, {
    now,
    predicate: (snapshot, currentNow) => {
      if (!snapshot.last) return false;
      const due = snapshot.due;
      if (!Number.isFinite(due)) return false;
      if (due === Number.MAX_SAFE_INTEGER) return false;
      return due > currentNow;
    }
  });
  if (Number.isFinite(limit) && limit > 0) {
    return entries.slice(0, limit);
  }
  return entries;
}
