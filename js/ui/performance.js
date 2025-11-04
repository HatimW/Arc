const subscribers = new Set();
const listComplexity = new Map();
let windowCount = 0;
let mode = '';

const isElectronEnvironment = typeof navigator !== 'undefined'
  && /Electron/i.test((navigator.userAgent || ''));
const globalScope = typeof window !== 'undefined' ? window : undefined;
const electronBridge = globalScope && globalScope.arc && globalScope.arc.performance
  ? globalScope.arc.performance
  : null;
const electronState = {
  available: Boolean(electronBridge),
  settings: {
    disableHardwareAcceleration: false,
    backgroundThrottling: true
  }
};
let lastRecomputeAt = 0;
let recomputeTimer = null;
const ELECTRON_RECOMPUTE_INTERVAL = 150;

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
    if (isElectronEnvironment) {
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

function applyElectronSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  electronState.settings = {
    disableHardwareAcceleration: Boolean(settings.disableHardwareAcceleration),
    backgroundThrottling: settings.backgroundThrottling !== false
  };
  withDocumentBody(body => {
    body.dataset.electronHardwareAcceleration = electronState.settings.disableHardwareAcceleration ? 'disabled' : 'enabled';
    body.dataset.electronBackgroundThrottling = electronState.settings.backgroundThrottling ? 'on' : 'off';
  });
}

if (electronBridge) {
  if (typeof electronBridge.getSettings === 'function') {
    electronBridge.getSettings()
      .then(settings => {
        if (settings) applyElectronSettings(settings);
      })
      .catch(err => {
        console.warn('Failed to load electron performance settings', err);
      });
  }
  if (typeof electronBridge.onSettingsChanged === 'function') {
    electronBridge.onSettingsChanged(nextSettings => {
      applyElectronSettings(nextSettings);
    });
  }
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

function recomputeModeImmediate() {
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

function scheduleRecompute() {
  if (!isElectronEnvironment) {
    recomputeModeImmediate();
    return;
  }
  const now = Date.now();
  if (now - lastRecomputeAt >= ELECTRON_RECOMPUTE_INTERVAL) {
    lastRecomputeAt = now;
    recomputeModeImmediate();
    return;
  }
  if (recomputeTimer) return;
  const delay = Math.max(16, ELECTRON_RECOMPUTE_INTERVAL - (now - lastRecomputeAt));
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    lastRecomputeAt = Date.now();
    recomputeModeImmediate();
  }, delay);
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
  scheduleRecompute();
  return getPerformanceMode();
}

export function registerWindowPresence() {
  windowCount += 1;
  scheduleRecompute();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    windowCount = Math.max(0, windowCount - 1);
    scheduleRecompute();
  };
}

export function getElectronPerformanceSettings() {
  return {
    available: electronState.available,
    ...electronState.settings
  };
}

export async function configureElectronPerformance(options = {}) {
  if (!electronBridge || typeof electronBridge.updateSettings !== 'function') {
    return { success: false, reason: 'unavailable' };
  }
  try {
    const result = await electronBridge.updateSettings(options);
    if (result && result.settings) {
      applyElectronSettings(result.settings);
    }
    return { success: true, ...result };
  } catch (err) {
    console.error('Failed to configure electron performance settings', err);
    return { success: false, error: err };
  }
}

export function forcePerformanceMode(nextMode) {
  if (!nextMode) return;
  if (!['standard', 'balanced', 'conservative'].includes(nextMode)) return;
  applyMode(nextMode);
}

