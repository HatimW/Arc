const DB_NAME = 'sevenn-db';
const DB_VERSION = 3;
const MEMORY_STORAGE_KEY = 'sevenn-memory-db';

const STORE_KEY_PATHS = {
  items: 'id',
  blocks: 'blockId',
  exams: 'id',
  settings: 'id',
  exam_sessions: 'examId'
};

const enqueue = typeof queueMicrotask === 'function'
  ? queueMicrotask.bind(globalThis)
  : (cb => Promise.resolve().then(cb));

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

class MemoryRequest {
  constructor(tx, executor) {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    tx._requestStarted();
    enqueue(() => {
      try {
        this.result = executor();
        if (typeof this.onsuccess === 'function') {
          this.onsuccess({ target: this });
        }
        tx._requestFinished();
      } catch (err) {
        this.error = err;
        if (typeof this.onerror === 'function') {
          this.onerror({ target: this });
        }
        tx._requestFailed(err);
      }
    });
  }
}

class MemoryIndex {
  constructor(store, extractor, multiEntry = false) {
    this.store = store;
    this.extractor = extractor;
    this.multiEntry = multiEntry;
  }

  getAll(value) {
    return new MemoryRequest(this.store.tx, () => {
      const results = [];
      for (const item of this.store._map().values()) {
        const extracted = this.extractor(item);
        if (this.multiEntry && Array.isArray(extracted)) {
          if (extracted.includes(value)) results.push(clone(item));
        } else if (extracted === value) {
          results.push(clone(item));
        }
      }
      return results;
    });
  }
}

class MemoryStore {
  constructor(tx, name) {
    this.tx = tx;
    this.name = name;
  }

  _map() {
    if (!this.tx.db.maps[this.name]) {
      this.tx.db.maps[this.name] = new Map();
    }
    return this.tx.db.maps[this.name];
  }

  _keyFromValue(value) {
    const keyPath = STORE_KEY_PATHS[this.name];
    if (!keyPath) return undefined;
    return value?.[keyPath];
  }

  get(key) {
    return new MemoryRequest(this.tx, () => {
      const found = this._map().get(key);
      return clone(found);
    });
  }

  getAll() {
    return new MemoryRequest(this.tx, () => {
      return Array.from(this._map().values()).map(clone);
    });
  }

  put(value) {
    return new MemoryRequest(this.tx, () => {
      const key = this._keyFromValue(value);
      if (key == null) throw new Error(`Missing key for store ${this.name}`);
      this._map().set(key, clone(value));
      this.tx.db._persist();
      return clone(value);
    });
  }

  delete(key) {
    return new MemoryRequest(this.tx, () => {
      this._map().delete(key);
      this.tx.db._persist();
      return undefined;
    });
  }

  clear() {
    return new MemoryRequest(this.tx, () => {
      this._map().clear();
      this.tx.db._persist();
      return undefined;
    });
  }

  index(name) {
    if (this.name === 'items' && name === 'by_kind') {
      return new MemoryIndex(this, item => item.kind || null);
    }
    return {
      getAll: () => new MemoryRequest(this.tx, () => [])
    };
  }
}

class MemoryTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.names = Array.isArray(names) ? names : [names];
    this.mode = mode;
    this._stores = new Map();
    this._pending = 0;
    this._failed = false;
    this._completePending = false;
    this._errorPending = null;
    this._oncomplete = null;
    this._onerror = null;

    Object.defineProperty(this, 'oncomplete', {
      get: () => this._oncomplete,
      set: fn => {
        this._oncomplete = fn;
        if (this._completePending && typeof fn === 'function') {
          this._completePending = false;
          enqueue(() => fn({ target: this }));
        }
      }
    });

    Object.defineProperty(this, 'onerror', {
      get: () => this._onerror,
      set: fn => {
        this._onerror = fn;
        if (this._errorPending && typeof fn === 'function') {
          const err = this._errorPending;
          this._errorPending = null;
          enqueue(() => fn({ target: this, error: err }));
        }
      }
    });
  }

  objectStore(name) {
    if (!this._stores.has(name)) {
      this._stores.set(name, new MemoryStore(this, name));
    }
    return this._stores.get(name);
  }

  _requestStarted() {
    this._pending += 1;
  }

  _requestFinished() {
    if (this._pending > 0) this._pending -= 1;
    if (this._pending === 0 && !this._failed) {
      if (typeof this._oncomplete === 'function') {
        enqueue(() => this._oncomplete({ target: this }));
      } else {
        this._completePending = true;
      }
    }
  }

  _requestFailed(error) {
    this._failed = true;
    if (typeof this._onerror === 'function') {
      enqueue(() => this._onerror({ target: this, error }));
    } else {
      this._errorPending = error;
    }
  }
}

class MemoryDB {
  constructor() {
    this.maps = {};
    this.persistKey = MEMORY_STORAGE_KEY;
    this.canPersist = false;
    if (typeof localStorage !== 'undefined') {
      try {
        const testKey = `${MEMORY_STORAGE_KEY}-test`;
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
        this.canPersist = true;
      } catch (err) {
        this.canPersist = false;
      }
    }
    for (const name of Object.keys(STORE_KEY_PATHS)) {
      this.maps[name] = new Map();
    }
    this._load();
  }

  _load() {
    if (!this.canPersist) return;
    try {
      const raw = localStorage.getItem(this.persistKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const name of Object.keys(STORE_KEY_PATHS)) {
        const list = parsed?.[name];
        if (Array.isArray(list)) {
          for (const entry of list) {
            const keyPath = STORE_KEY_PATHS[name];
            const key = entry?.[keyPath];
            if (key != null) {
              this.maps[name].set(key, clone(entry));
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load memory DB from storage', err);
      for (const name of Object.keys(STORE_KEY_PATHS)) {
        this.maps[name].clear();
      }
    }
  }

  _persist() {
    if (!this.canPersist) return;
    try {
      const payload = {};
      for (const name of Object.keys(STORE_KEY_PATHS)) {
        payload[name] = Array.from(this.maps[name].values()).map(clone);
      }
      localStorage.setItem(this.persistKey, JSON.stringify(payload));
    } catch (err) {
      console.warn('Failed to persist memory DB', err);
      this.canPersist = false;
    }
  }

  transaction(names, mode = 'readonly') {
    return new MemoryTransaction(this, names, mode);
  }

  close() {}
}

function fallbackToMemory(message, error) {
  if (message) {
    console.warn(message, error);
  }
  return new MemoryDB();
}

export function openDB() {
  if (!('indexedDB' in globalThis)) {
    return Promise.resolve(fallbackToMemory('IndexedDB unavailable, using in-memory storage.'));
  }
  return new Promise(resolve => {
    let settled = false;
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      settled = true;
      resolve(fallbackToMemory('IndexedDB threw during open, using in-memory storage.', err));
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallbackToMemory('IndexedDB open timeout, using in-memory storage.'));
      }
    }, 5000);
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallbackToMemory('IndexedDB failed to open, using in-memory storage.', req.error));
    };
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('items')) {
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('by_kind', 'kind');
        items.createIndex('by_updatedAt', 'updatedAt');
        items.createIndex('by_favorite', 'favorite');
        items.createIndex('by_blocks', 'blocks', { multiEntry: true });
        items.createIndex('by_weeks', 'weeks', { multiEntry: true });
        items.createIndex('by_lecture_ids', 'lectures.id', { multiEntry: true });
        items.createIndex('by_search', 'tokens');
      }

      if (!db.objectStoreNames.contains('blocks')) {
        const blocks = db.createObjectStore('blocks', { keyPath: 'blockId' });
        blocks.createIndex('by_title', 'title');
        blocks.createIndex('by_createdAt', 'createdAt');
      }

      if (!db.objectStoreNames.contains('exams')) {
        const exams = db.createObjectStore('exams', { keyPath: 'id' });
        exams.createIndex('by_createdAt', 'createdAt');
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('exam_sessions')) {
        const sessions = db.createObjectStore('exam_sessions', { keyPath: 'examId' });
        sessions.createIndex('by_updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(req.result);
    };
  });
}
