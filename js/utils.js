export function uid() {
  const g = globalThis;
  return g.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
}

export function debounce(fn, delay = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const structuredCloneFn = typeof globalThis.structuredClone === 'function'
  ? globalThis.structuredClone.bind(globalThis)
  : null;

function cloneArrayBuffer(buffer) {
  if (typeof buffer.slice === 'function') {
    return buffer.slice(0);
  }
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buffer));
  return copy;
}

function cloneArrayBufferView(view, seen) {
  if (typeof view?.constructor?.from === 'function') {
    return view.constructor.from(view);
  }
  if (ArrayBuffer.isView(view)) {
    const bufferCopy = deepClone(view.buffer, seen);
    if (typeof DataView !== 'undefined' && view instanceof DataView) {
      return new DataView(bufferCopy, view.byteOffset, view.byteLength);
    }
    return new view.constructor(bufferCopy, view.byteOffset, view.length ?? undefined);
  }
  return view;
}

export function deepClone(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  if (structuredCloneFn) {
    try {
      return structuredCloneFn(value);
    } catch (err) {
      // Fall through to manual cloning when structuredClone cannot handle the input
      // (for example, functions or DOM nodes).
    }
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags);
    copy.lastIndex = value.lastIndex;
    return copy;
  }

  if (ArrayBuffer.isView(value)) {
    const cloned = cloneArrayBufferView(value, seen);
    seen.set(value, cloned);
    return cloned;
  }

  if (value instanceof ArrayBuffer) {
    const copy = cloneArrayBuffer(value);
    seen.set(value, copy);
    return copy;
  }

  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (let i = 0; i < value.length; i += 1) {
      result[i] = deepClone(value[i], seen);
    }
    return result;
  }

  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    value.forEach((mapValue, key) => {
      const clonedKey = typeof key === 'object' && key !== null
        ? deepClone(key, seen)
        : key;
      result.set(clonedKey, deepClone(mapValue, seen));
    });
    return result;
  }

  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    value.forEach(entry => {
      result.add(deepClone(entry, seen));
    });
    return result;
  }

  const result = {};
  seen.set(value, result);
  for (const [key, val] of Object.entries(value)) {
    result[key] = deepClone(val, seen);
  }
  return result;
}

function parseDateValue(value) {
  if (!value) return Number.NaN;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? Number.NaN : time;
  }
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? Number.NaN : time;
}

export function findActiveBlockId(blocks, now = Date.now()) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const nowTs = Number.isFinite(now) ? now : Date.now();
  let current = null;
  let upcoming = null;
  let recent = null;

  blocks.forEach(block => {
    if (!block || block.blockId == null) return;
    const id = String(block.blockId);
    const start = parseDateValue(block.startDate);
    const end = parseDateValue(block.endDate);

    const hasStart = Number.isFinite(start);
    const hasEnd = Number.isFinite(end);

    if (hasStart && hasEnd) {
      if (start <= nowTs && nowTs <= end) {
        if (!current || start < current.start || (start === current.start && end < current.end)) {
          current = { id, start, end };
        }
        return;
      }
      if (start > nowTs) {
        if (!upcoming || start < upcoming.start) {
          upcoming = { id, start };
        }
        return;
      }
      if (!recent || end > recent.end) {
        recent = { id, end };
      }
      return;
    }

    if (hasStart) {
      if (start <= nowTs) {
        if (!recent || start > recent.end) {
          recent = { id, end: start };
        }
      } else if (!upcoming || start < upcoming.start) {
        upcoming = { id, start };
      }
      return;
    }

    if (hasEnd) {
      if (nowTs <= end) {
        if (!current || end < current.end) {
          current = { id, start: end, end };
        }
      } else if (!recent || end > recent.end) {
        recent = { id, end };
      }
    }
  });

  if (current) return current.id;
  if (upcoming) return upcoming.id;
  if (recent) return recent.id;

  const first = blocks.find(block => block && block.blockId != null);
  return first ? String(first.blockId) : '';
}

export function setToggleState(element, active, className = 'active') {
  if (!element) return;
  const isActive = Boolean(active);
  if (element.dataset) {
    element.dataset.toggle = 'true';
    element.dataset.active = isActive ? 'true' : 'false';
  }
  if (className && element.classList) {
    element.classList.toggle(className, isActive);
  }
  if (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement) {
    const role = element.getAttribute('role');
    if ((element.tagName === 'BUTTON' || role === 'button') && typeof element.setAttribute === 'function') {
      element.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }
}
