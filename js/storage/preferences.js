const STORAGE_KEY = 'arc-ui-preferences';
let cache = null;

function canUseStorage() {
  try {
    return typeof localStorage !== 'undefined';
  } catch (err) {
    return false;
  }
}

function readPreferences() {
  if (cache) {
    return cache;
  }
  if (!canUseStorage()) {
    cache = {};
    return cache;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('Failed to read UI preferences', err);
    cache = {};
  }
  return cache;
}

export function loadUIPreferences() {
  const stored = readPreferences();
  return stored ? { ...stored } : {};
}

export function updateUIPreferences(patch) {
  if (!patch || typeof patch !== 'object') {
    return loadUIPreferences();
  }
  const current = { ...readPreferences() };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'undefined') continue;
    if (current[key] !== value) {
      current[key] = value;
      changed = true;
    }
  }
  if (!changed) {
    return current;
  }
  cache = current;
  if (canUseStorage()) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (err) {
      console.warn('Failed to persist UI preferences', err);
    }
  }
  return current;
}
