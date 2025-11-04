const subscribers = new Set();
const listComplexity = new Map();
let windowCount = 0;
let mode = '';

function detectBaseMode() {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) {
        return 'conservative';
      }
    } catch (err) {
      console.warn('Failed to evaluate transparency preference', err);
    }
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    if (/Electron/i.test(ua)) {
      return 'conservative';
    }
    const memory = Number(navigator.deviceMemory);
    if (Number.isFinite(memory) && memory > 0) {
      if (memory <= 4) {
        return 'conservative';
      }
      if (memory <= 8) {
        return 'balanced';
      }
    }
  }
  return 'standard';
}

const baseMode = detectBaseMode();

function withDocumentBody(fn) {
  if (typeof document === 'undefined') return;
  if (document.body) {
    fn(document.body);
    return;
  }
  const handler = () => {
    if (!document.body) return;
    fn(document.body);
    document.removeEventListener('DOMContentLoaded', handler);
  };
  document.addEventListener('DOMContentLoaded', handler);
}

function applyMode(nextMode) {
  if (!nextMode) nextMode = 'standard';
  if (mode === nextMode) return;
  mode = nextMode;
  withDocumentBody(body => {
    body.dataset.performanceMode = nextMode;
    body.style.setProperty('--performance-mode', nextMode);
  });
  subscribers.forEach(listener => {
    try {
      listener(nextMode);
    } catch (err) {
      console.error('Performance listener failed', err);
    }
  });
}

function computeComplexityScore(options) {
  if (options == null) return 0;
  if (typeof options === 'number') {
    return Number.isFinite(options) ? Math.max(0, Math.round(options)) : 0;
  }
  const items = Number.isFinite(options.items) ? Math.max(0, options.items) : 0;
  const columns = Number.isFinite(options.columns) ? Math.max(1, options.columns) : 1;
  const extras = Number.isFinite(options.extras) ? Math.max(0, options.extras) : 0;
  const weight = Number.isFinite(options.weight) ? Math.max(0.1, options.weight) : 1;
  return Math.round((items * columns * weight) + extras);
}

function recomputeMode() {
  const heaviestList = listComplexity.size
    ? Math.max(...listComplexity.values())
    : 0;
  let nextMode = baseMode;
  if (baseMode === 'conservative') {
    nextMode = 'conservative';
  } else if (windowCount >= 3 || heaviestList >= 240) {
    nextMode = 'conservative';
  } else if (windowCount >= 2 || heaviestList >= 140) {
    nextMode = baseMode === 'standard' ? 'balanced' : baseMode;
  }
  applyMode(nextMode);
}

applyMode(baseMode);

export function getPerformanceMode() {
  return mode || 'standard';
}

export function isPerformanceConstrained() {
  const current = getPerformanceMode();
  return current === 'balanced' || current === 'conservative';
}

export function onPerformanceModeChange(listener) {
  if (typeof listener !== 'function') return () => {};
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function reportListComplexity(key, options) {
  if (!key) return getPerformanceMode();
  const score = computeComplexityScore(options);
  if (score > 0) {
    listComplexity.set(key, score);
  } else {
    listComplexity.delete(key);
  }
  recomputeMode();
  return getPerformanceMode();
}

export function registerWindowPresence() {
  windowCount += 1;
  recomputeMode();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    windowCount = Math.max(0, windowCount - 1);
    recomputeMode();
  };
}

export function forcePerformanceMode(nextMode) {
  if (!nextMode) return;
  if (!['standard', 'balanced', 'conservative'].includes(nextMode)) return;
  applyMode(nextMode);
}

