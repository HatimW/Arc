export const REVIEW_ORDER_CATEGORIES = ['review', 'learning', 'new'];

export const DEFAULT_REVIEW_ORDERING = Object.freeze({
  mode: 'prioritized',
  priorities: ['review', 'learning', 'new']
});

export function normalizeReviewCategory(value) {
  if (value === 'review' || value === 'learning') {
    return value;
  }
  if (value === 'new') return 'new';
  return 'new';
}

export function normalizeReviewOrdering(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_REVIEW_ORDERING };
  }
  const mode = raw.mode === 'mixed' ? 'mixed' : 'prioritized';
  let priorities = Array.isArray(raw.priorities) ? raw.priorities : [];
  priorities = priorities
    .map(value => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
    .filter(value => REVIEW_ORDER_CATEGORIES.includes(value));
  const unique = [];
  priorities.forEach(value => {
    if (!unique.includes(value)) unique.push(value);
  });
  if (!unique.length) {
    unique.push(...DEFAULT_REVIEW_ORDERING.priorities);
  }
  return {
    mode,
    priorities: unique
  };
}

function shuffleEntries(entries) {
  const copy = Array.from(entries);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

export function orderReviewEntries(entries, ordering = DEFAULT_REVIEW_ORDERING) {
  if (!Array.isArray(entries) || !entries.length) return Array.isArray(entries) ? Array.from(entries) : [];
  const normalized = normalizeReviewOrdering(ordering);
  if (normalized.mode === 'mixed') {
    return shuffleEntries(entries);
  }
  const priorities = normalized.priorities;
  const categoryOrder = [...priorities];
  REVIEW_ORDER_CATEGORIES.forEach(category => {
    if (!categoryOrder.includes(category)) categoryOrder.push(category);
  });
  const buckets = new Map();
  entries.forEach(entry => {
    const rawCategory = entry && typeof entry === 'object' ? entry.category : null;
    const normalizedCategory = normalizeReviewCategory(rawCategory);
    if (!buckets.has(normalizedCategory)) {
      buckets.set(normalizedCategory, []);
    }
    buckets.get(normalizedCategory).push(entry);
  });
  const ordered = [];
  categoryOrder.forEach(category => {
    const list = buckets.get(category);
    if (list && list.length) {
      ordered.push(...list);
      buckets.delete(category);
    }
  });
  buckets.forEach(list => {
    ordered.push(...list);
  });
  return ordered;
}

export function ensureReviewOrdering(raw) {
  return normalizeReviewOrdering(raw);
}
