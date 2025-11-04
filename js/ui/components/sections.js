const SECTION_DEFS = {
  disease: [
    { key: 'etiology', label: 'Etiology' },
    { key: 'pathophys', label: 'Pathophys' },
    { key: 'clinical', label: 'Clinical Presentation' },
    { key: 'diagnosis', label: 'Diagnosis' },
    { key: 'treatment', label: 'Treatment' },
    { key: 'complications', label: 'Complications' },
    { key: 'mnemonic', label: 'Mnemonic' }
  ],
  drug: [
    { key: 'moa', label: 'Mechanism' },
    { key: 'uses', label: 'Uses' },
    { key: 'sideEffects', label: 'Side Effects' },
    { key: 'contraindications', label: 'Contraindications' },
    { key: 'mnemonic', label: 'Mnemonic' }
  ],
  concept: [
    { key: 'definition', label: 'Definition' },
    { key: 'mechanism', label: 'Mechanism' },
    { key: 'clinicalRelevance', label: 'Clinical Relevance' },
    { key: 'example', label: 'Example' },
    { key: 'mnemonic', label: 'Mnemonic' }
  ]
};

let layoutInstrumentation = null;

function createNoopInstrumentation() {
  return {
    noteRender() {},
    trackSectionUsage() {}
  };
}

function initLayoutInstrumentation() {
  if (layoutInstrumentation) return layoutInstrumentation;
  if (typeof window === 'undefined') {
    layoutInstrumentation = createNoopInstrumentation();
    return layoutInstrumentation;
  }

  const userAgent = typeof navigator === 'object' ? String(navigator.userAgent || '') : '';
  const isElectron = /Electron/i.test(userAgent);
  if (!isElectron) {
    layoutInstrumentation = createNoopInstrumentation();
    return layoutInstrumentation;
  }

  const lastRenderByScope = new Map();
  const sectionHitCache = new Map();
  const getTime = () => {
    if (typeof performance === 'object' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  };

  const scheduleFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb => setTimeout(cb, 16));

  let flushTimer = 0;
  const layoutSummary = { shifts: 0, longTasks: 0 };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      const { shifts, longTasks } = layoutSummary;
      if (shifts >= 4 || longTasks >= 1) {
        console.warn('[layout-monitor] Frequent layout work detected', {
          layoutShifts: Number(shifts.toFixed ? shifts.toFixed(3) : shifts),
          longTasks
        });
      }
      layoutSummary.shifts = 0;
      layoutSummary.longTasks = 0;
    }, 160);
  };

  if (typeof PerformanceObserver === 'function') {
    try {
      const layoutObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry && entry.value && !entry.hadRecentInput) {
            layoutSummary.shifts += entry.value;
          }
        }
        scheduleFlush();
      });
      layoutObserver.observe({ type: 'layout-shift', buffered: true });
    } catch (err) {
      console.debug('[layout-monitor] Layout shift observer unavailable', err);
    }

    try {
      const longTaskObserver = new PerformanceObserver(list => {
        const entries = list.getEntries();
        if (entries && entries.length) {
          layoutSummary.longTasks += entries.length;
          scheduleFlush();
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch (err) {
      console.debug('[layout-monitor] Long task observer unavailable', err);
    }
  }

  function noteRender(scope) {
    if (!scope) return;
    const now = getTime();
    const previous = lastRenderByScope.get(scope);
    lastRenderByScope.set(scope, now);
    if (previous && now - previous < 48) {
      console.warn('[layout-monitor] Duplicate render detected', {
        scope,
        delta: Math.round(now - previous)
      });
    }
  }

  function trackSectionUsage(itemId, sectionKey) {
    if (!sectionKey) return;
    const id = itemId != null ? String(itemId) : 'unknown';
    const signature = `${id}::${sectionKey}`;
    const now = getTime();
    const previous = sectionHitCache.get(signature);
    sectionHitCache.set(signature, now);
    scheduleFrame(() => {
      const timestamp = sectionHitCache.get(signature);
      if (timestamp && now !== timestamp && now < timestamp) {
        // value updated, skip duplicate warning because a newer render superseded.
        return;
      }
      // expire entries older than ~2 seconds to cap memory
      const LIMIT = 200;
      if (sectionHitCache.size > LIMIT) {
        const cutoff = getTime() - 2000;
        for (const [key, value] of sectionHitCache.entries()) {
          if (value < cutoff) sectionHitCache.delete(key);
        }
      }
    });
    if (previous && now - previous < 250) {
      console.warn('[layout-monitor] Rapid section reuse detected', {
        itemId: id,
        sectionKey,
        delta: Math.round(now - previous)
      });
    }
  }

  layoutInstrumentation = { noteRender, trackSectionUsage };
  return layoutInstrumentation;
}

function getLayoutInstrumentation() {
  if (!layoutInstrumentation) {
    layoutInstrumentation = initLayoutInstrumentation();
  }
  return layoutInstrumentation;
}

export function sectionDefsForKind(kind) {
  return SECTION_DEFS[kind] || [];
}

export function allSectionDefs() {
  return SECTION_DEFS;
}

export function noteTabRender(scope) {
  getLayoutInstrumentation().noteRender(scope);
}

export function noteSectionUsage(itemId, sectionKey) {
  getLayoutInstrumentation().trackSectionUsage(itemId, sectionKey);
}
