const STORAGE_KEY = 'arc-ui-preferences';
let cache = null;
let pendingWriteHandle = null;
let pendingPayload = null;

const globalScope = typeof globalThis !== 'undefined' ? globalThis : window;

function schedule(callback) {
  if (typeof globalScope.requestIdleCallback === 'function') {
    return globalScope.requestIdleCallback(callback, { timeout: 500 });
  }
  return setTimeout(callback, 0);
}

function cancel(handle) {
  if (handle == null) return;
  if (typeof globalScope.cancelIdleCallback === 'function') {
    globalScope.cancelIdleCallback(handle);
  } else {
    clearTimeout(handle);
  }
}

function flushPendingWrite() {
  if (!pendingPayload) {
    return;
  }
  if (!canUseStorage()) {
    pendingPayload = null;
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingPayload));
  } catch (err) {
    console.warn('Failed to persist UI preferences', err);
  }
  pendingPayload = null;
}

function schedulePersist() {
  if (pendingWriteHandle != null) {
    return;
  }
  pendingWriteHandle = schedule(() => {
    pendingWriteHandle = null;
    flushPendingWrite();
  });
}

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
    return { ...current };
  }
  cache = current;
  pendingPayload = { ...current };
  schedulePersist();
  return { ...current };
}

if (globalScope && typeof globalScope.addEventListener === 'function') {
  globalScope.addEventListener(
    'beforeunload',
    () => {
      if (pendingWriteHandle != null) {
        cancel(pendingWriteHandle);
        pendingWriteHandle = null;
      }
      flushPendingWrite();
    },
    { once: true }
  );
}
