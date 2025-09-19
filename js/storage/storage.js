import { openDB } from './idb.js';
import { exportJSON, importJSON, exportAnkiCSV } from './export.js';

let dbPromise;

const DEFAULT_KINDS = ['disease', 'drug', 'concept'];
const RESULT_BATCH_SIZE = 50;
const MAP_CONFIG_KEY = 'map-config';
const MAP_CONFIG_BACKUP_KEY = 'sevenn-map-config-backup';
const DATA_BACKUP_KEY = 'sevenn-backup-snapshot';
const DATA_BACKUP_STORES = ['items', 'blocks', 'exams', 'settings', 'exam_sessions'];

let backupTimer = null;

const DEFAULT_MAP_CONFIG = {
  activeTabId: 'default',
  tabs: [
    {
      id: 'default',
      name: 'All concepts',
      includeLinked: true,
      manualMode: false,
      manualIds: [],
      layout: {},
      layoutSeeded: true,
      filter: { blockId: '', week: '', lectureKey: '' }
    }
  ]
};

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await dbPromise;
  return db.transaction(name, mode).objectStore(name);
}

function canUseStorage() {
  return typeof localStorage !== 'undefined';
}

function readMapConfigBackup() {
  if (!canUseStorage()) return null;
  try {
    const raw = localStorage.getItem(MAP_CONFIG_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (err) {
    console.warn('Failed to read map backup', err);
  }
  return null;
}

function writeMapConfigBackup(config) {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(MAP_CONFIG_BACKUP_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn('Failed to persist map backup', err);
  }
}

async function writeDataBackup() {
  if (!canUseStorage()) return;
  try {
    const db = await dbPromise;
    if (!db || typeof db.transaction !== 'function') return;
    const snapshot = {};
    for (const name of DATA_BACKUP_STORES) {
      try {
        const tx = db.transaction(name, 'readonly');
        const s = tx.objectStore(name);
        const all = await prom(s.getAll());
        snapshot[name] = Array.isArray(all) ? all : [];
      } catch (err) {
        console.warn(`Failed to snapshot store ${name}`, err);
        snapshot[name] = [];
      }
    }
    snapshot.__timestamp = Date.now();
    localStorage.setItem(DATA_BACKUP_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('Failed to persist data backup', err);
  }
}

function scheduleBackup() {
  if (!canUseStorage()) return;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    writeDataBackup().catch(err => console.warn('Backup write failed', err));
  }, 1000);
}

async function maybeRestoreFromBackup() {
  if (!canUseStorage()) return;
  let parsed;
  try {
    const raw = localStorage.getItem(DATA_BACKUP_KEY);
    if (!raw) return;
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('Failed to parse saved backup', err);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  try {
    const db = await dbPromise;
    if (!db || typeof db.transaction !== 'function') return;
    const emptyChecks = await Promise.all(DATA_BACKUP_STORES.map(async name => {
      try {
        const tx = db.transaction(name, 'readonly');
        const s = tx.objectStore(name);
        const existing = await prom(s.getAll());
        return !existing || existing.length === 0;
      } catch (err) {
        console.warn(`Failed to inspect store ${name}`, err);
        return false;
      }
    }));
    if (!emptyChecks.every(Boolean)) return;
    for (const name of DATA_BACKUP_STORES) {
      const list = Array.isArray(parsed[name]) ? parsed[name] : [];
      if (!list.length) continue;
      try {
        const tx = db.transaction(name, 'readwrite');
        const s = tx.objectStore(name);
        for (const entry of list) {
          await prom(s.put(entry));
        }
      } catch (err) {
        console.warn(`Failed to restore store ${name}`, err);
      }
    }
  } catch (err) {
    console.warn('Failed to restore data from backup', err);
  }
}

export async function initDB() {
  if (!dbPromise) dbPromise = openDB();
  await maybeRestoreFromBackup();
  const s = await store('settings', 'readwrite');
  const existing = await prom(s.get('app'));
  if (!existing) {
    const defaults = { id: 'app', dailyCount: 20, theme: 'dark' };
    await prom(s.put(defaults));
  }
  scheduleBackup();
}

export async function getSettings() {
  const s = await store('settings');
  const settings = await prom(s.get('app'));
  return settings || { id: 'app', dailyCount: 20, theme: 'dark' };
}

export async function saveSettings(patch) {
  const s = await store('settings', 'readwrite');
  const current = await prom(s.get('app')) || { id: 'app', dailyCount: 20, theme: 'dark' };
  const next = { ...current, ...patch, id: 'app' };
  await prom(s.put(next));
  scheduleBackup();
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

export async function getMapConfig() {
  try {
    const s = await store('settings', 'readwrite');
    const existing = await prom(s.get(MAP_CONFIG_KEY));
    if (existing && existing.config) {
      const config = cloneConfig(existing.config);
      writeMapConfigBackup(config);
      return config;
    }
    const backup = readMapConfigBackup();
    if (backup) {
      const payload = cloneConfig(backup);
      await prom(s.put({ id: MAP_CONFIG_KEY, config: payload }));
      writeMapConfigBackup(payload);
      scheduleBackup();
      return payload;
    }
    const fallback = cloneConfig(DEFAULT_MAP_CONFIG);
    await prom(s.put({ id: MAP_CONFIG_KEY, config: fallback }));
    writeMapConfigBackup(fallback);
    scheduleBackup();
    return fallback;
  } catch (err) {
    console.warn('getMapConfig failed', err);
    const backup = readMapConfigBackup();
    if (backup) {
      return cloneConfig(backup);
    }
    return cloneConfig(DEFAULT_MAP_CONFIG);
  }
}

export async function saveMapConfig(config) {
  const payload = config ? cloneConfig(config) : cloneConfig(DEFAULT_MAP_CONFIG);
  const s = await store('settings', 'readwrite');
  await prom(s.put({ id: MAP_CONFIG_KEY, config: payload }));
  writeMapConfigBackup(payload);
  scheduleBackup();
}

export async function listBlocks() {
  try {
    const b = await store('blocks');
    const all = await prom(b.getAll());
    return all.sort((a,b)=>{
      const ao = a.order ?? a.createdAt;
      const bo = b.order ?? b.createdAt;
      return bo - ao;
    });
  } catch (err) {
    console.warn('listBlocks failed', err);
    return [];
  }
}

export async function upsertBlock(def) {
  const b = await store('blocks', 'readwrite');
  const existing = await prom(b.get(def.blockId));
  const now = Date.now();
  let lectures = def.lectures || existing?.lectures || [];
  if (existing && typeof def.weeks === 'number' && def.weeks < existing.weeks) {
    const maxWeek = def.weeks;
    lectures = lectures.filter(l => l.week <= maxWeek);
    const i = await store('items', 'readwrite');
    const all = await prom(i.getAll());
    for (const it of all) {
      let changed = false;
      if (it.lectures) {
        const before = it.lectures.length;
        it.lectures = it.lectures.filter(l => !(l.blockId === def.blockId && l.week > maxWeek));
        if (it.lectures.length !== before) changed = true;
      }
      if (it.weeks) {
        const beforeW = it.weeks.length;
        it.weeks = it.weeks.filter(w => w <= maxWeek);
        if (it.weeks.length !== beforeW) changed = true;
      }
      if (changed) {
        it.tokens = buildTokens(it);
        it.searchMeta = buildSearchMeta(it);
        await prom(i.put(it));
      }
    }
  }
  const next = {
    ...def,
    lectures,
    color: def.color || existing?.color || null,
    order: def.order || existing?.order || now,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await prom(b.put(next));
  scheduleBackup();
}

export async function deleteBlock(blockId) {
  const b = await store('blocks', 'readwrite');
  await prom(b.delete(blockId));
  // remove references from items to keep them "unlabeled"
  const i = await store('items', 'readwrite');
  const all = await prom(i.getAll());
  for (const it of all) {
    const beforeBlocks = it.blocks?.length || 0;
    const beforeLects = it.lectures?.length || 0;
    if (beforeBlocks || beforeLects) {
      if (it.blocks) it.blocks = it.blocks.filter(bId => bId !== blockId);
      if (it.lectures) it.lectures = it.lectures.filter(l => l.blockId !== blockId);
      // recompute weeks based on remaining lectures
      if (it.weeks) {
        const validWeeks = new Set((it.lectures || []).map(l => l.week));
        it.weeks = Array.from(validWeeks);
      }
      if ((it.blocks?.length || 0) !== beforeBlocks || (it.lectures?.length || 0) !== beforeLects) {
        it.tokens = buildTokens(it);
        it.searchMeta = buildSearchMeta(it);
        await prom(i.put(it));
      }
    }
  }
  scheduleBackup();
}

export async function deleteLecture(blockId, lectureId) {
  const b = await store('blocks', 'readwrite');
  const blk = await prom(b.get(blockId));
  if (blk) {
    blk.lectures = (blk.lectures || []).filter(l => l.id !== lectureId);
    await prom(b.put(blk));
  }
  const i = await store('items', 'readwrite');
  const all = await prom(i.getAll());
  for (const it of all) {
    const before = it.lectures?.length || 0;
    if (before) {
      it.lectures = it.lectures.filter(l => !(l.blockId === blockId && l.id === lectureId));
      if (it.lectures.length !== before) {
        it.blocks = it.blocks?.filter(bid => bid !== blockId || it.lectures.some(l => l.blockId === bid));
        const validWeeks = new Set((it.lectures || []).map(l => l.week));
        it.weeks = Array.from(validWeeks);
        it.tokens = buildTokens(it);
        it.searchMeta = buildSearchMeta(it);
        await prom(i.put(it));
      }
    }
  }
  scheduleBackup();
}

export async function updateLecture(blockId, lecture) {
  const b = await store('blocks', 'readwrite');
  const blk = await prom(b.get(blockId));
  if (blk) {
    blk.lectures = (blk.lectures || []).map(l => l.id === lecture.id ? lecture : l);
    await prom(b.put(blk));
  }
  const i = await store('items', 'readwrite');
  const all = await prom(i.getAll());
  for (const it of all) {
    let changed = false;
    if (it.lectures) {
      it.lectures = it.lectures.map(l => {
        if (l.blockId === blockId && l.id === lecture.id) {
          changed = true;
          return { blockId, id: lecture.id, name: lecture.name, week: lecture.week };
        }
        return l;
      });
    }
    if (changed) {
      const validWeeks = new Set((it.lectures || []).map(l => l.week));
      it.weeks = Array.from(validWeeks);
      it.tokens = buildTokens(it);
      it.searchMeta = buildSearchMeta(it);
      await prom(i.put(it));
    }
  }
  scheduleBackup();
}

import { buildTokens, tokenize, buildSearchMeta } from '../search.js';
import { cleanItem } from '../validators.js';

export async function listItemsByKind(kind) {
  const i = await store('items');
  const idx = i.index('by_kind');
  return await prom(idx.getAll(kind));
}

function titleOf(item){
  return item.name || item.concept || '';
}

function normalizeFilter(filter = {}) {
  const rawTypes = Array.isArray(filter.types) ? filter.types.filter(t => typeof t === 'string' && t) : [];
  const types = rawTypes.length ? Array.from(new Set(rawTypes)) : DEFAULT_KINDS;
  const block = typeof filter.block === 'string' ? filter.block : '';
  const weekRaw = filter.week;
  let week = null;
  if (typeof weekRaw === 'number' && !Number.isNaN(weekRaw)) {
    week = weekRaw;
  } else if (typeof weekRaw === 'string' && weekRaw.trim()) {
    const parsed = Number(weekRaw);
    if (!Number.isNaN(parsed)) week = parsed;
  }
  const onlyFav = Boolean(filter.onlyFav);
  const query = typeof filter.query === 'string' ? filter.query.trim() : '';
  const tokens = query ? tokenize(query) : [];
  return {
    types,
    block,
    week,
    onlyFav,
    tokens: tokens.length ? tokens : null,
    sort: filter.sort === 'name' ? 'name' : 'updated'
  };
}

async function getKeySet(storeRef, indexName, value) {
  if (value === null || value === undefined || value === '' || value !== value) return null;
  if (typeof storeRef.index !== 'function') return null;
  const idx = storeRef.index(indexName);
  if (!idx || typeof idx.getAllKeys !== 'function') return null;
  const keys = await prom(idx.getAllKeys(value));
  return new Set(keys);
}

async function keysForKinds(storeRef, kinds) {
  const idx = typeof storeRef.index === 'function' ? storeRef.index('by_kind') : null;
  const seen = new Set();
  const allKeys = [];
  for (const kind of kinds) {
    if (!kind) continue;
    let keys = [];
    if (idx && typeof idx.getAllKeys === 'function') {
      keys = await prom(idx.getAllKeys(kind));
    } else if (idx && typeof idx.getAll === 'function') {
      const values = await prom(idx.getAll(kind));
      keys = values.map(v => v?.id).filter(Boolean);
    }
    for (const key of keys) {
      if (!seen.has(key)) {
        seen.add(key);
        allKeys.push(key);
      }
    }
  }
  return allKeys;
}

async function executeItemQuery(filter) {
  const normalized = normalizeFilter(filter);
  const itemsStore = await store('items');

  const blockSet = normalized.block && normalized.block !== '__unlabeled'
    ? await getKeySet(itemsStore, 'by_blocks', normalized.block)
    : null;
  const weekSet = normalized.week != null
    ? await getKeySet(itemsStore, 'by_weeks', normalized.week)
    : null;
  const favoriteSet = normalized.onlyFav
    ? await getKeySet(itemsStore, 'by_favorite', true)
    : null;

  const baseKeys = await keysForKinds(itemsStore, normalized.types);
  const filteredKeys = baseKeys.filter(id => {
    if (!id) return false;
    if (blockSet && !blockSet.has(id)) return false;
    if (weekSet && !weekSet.has(id)) return false;
    if (favoriteSet && !favoriteSet.has(id)) return false;
    return true;
  });

  const results = [];
  for (let i = 0; i < filteredKeys.length; i += RESULT_BATCH_SIZE) {
    const chunk = filteredKeys.slice(i, i + RESULT_BATCH_SIZE);
    const fetched = await Promise.all(chunk.map(id => prom(itemsStore.get(id))));
    for (const item of fetched) {
      if (!item) continue;
      if (normalized.block === '__unlabeled' && Array.isArray(item.blocks) && item.blocks.length) continue;
      if (normalized.tokens) {
        const tokenField = item.tokens || '';
        const metaField = item.searchMeta || buildSearchMeta(item);
        const matches = normalized.tokens.every(tok => tokenField.includes(tok) || metaField.includes(tok));
        if (!matches) continue;
      }
      results.push(item);
    }
  }

  if (normalized.sort === 'name') {
    results.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  } else {
    results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return results;
}

export function findItemsByFilter(filter) {
  let memo;
  const run = () => {
    if (!memo) memo = executeItemQuery(filter);
    return memo;
  };
  return {
    async toArray() {
      const items = await run();
      return items.slice();
    },
    async *[Symbol.asyncIterator]() {
      const items = await run();
      for (let i = 0; i < items.length; i += RESULT_BATCH_SIZE) {
        yield items.slice(i, i + RESULT_BATCH_SIZE);
      }
    }
  };
}

export async function getItem(id) {
  const i = await store('items');
  return await prom(i.get(id));
}

export async function upsertItem(item) {
  const i = await store('items', 'readwrite');
  const existing = await prom(i.get(item.id));
  const now = Date.now();
  const next = cleanItem({
    ...item,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  next.tokens = buildTokens(next);
  next.searchMeta = buildSearchMeta(next);
  // enforce link symmetry (basic)
  for (const link of next.links) {
    const other = await prom(i.get(link.id));
    if (other) {
      other.links = other.links || [];
      if (!other.links.find(l => l.id === next.id)) {
        other.links.push({ id: next.id, type: link.type });
        other.tokens = buildTokens(other);
        other.searchMeta = buildSearchMeta(other);
        await prom(i.put(other));
      }
    }
  }
  await prom(i.put(next));
  scheduleBackup();
}

export async function deleteItem(id) {
  const i = await store('items', 'readwrite');
  const all = await prom(i.getAll());
  for (const it of all) {
    if (it.links?.some(l => l.id === id)) {
      it.links = it.links.filter(l => l.id !== id);
      it.tokens = buildTokens(it);
      it.searchMeta = buildSearchMeta(it);
      await prom(i.put(it));
    }
  }
  await prom(i.delete(id));
  scheduleBackup();
}

export async function listExams() {
  const e = await store('exams');
  return await prom(e.getAll());
}

export async function upsertExam(exam) {
  const e = await store('exams', 'readwrite');
  const existing = await prom(e.get(exam.id));
  const now = Date.now();
  const next = {
    ...exam,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    results: exam.results || existing?.results || []
  };
  await prom(e.put(next));
  scheduleBackup();
}

export async function deleteExam(id) {
  const e = await store('exams', 'readwrite');
  await prom(e.delete(id));
  scheduleBackup();
}

export async function listExamSessions() {
  const s = await store('exam_sessions');
  return await prom(s.getAll());
}

export async function loadExamSession(examId) {
  const s = await store('exam_sessions');
  return await prom(s.get(examId));
}

export async function saveExamSessionProgress(progress) {
  const s = await store('exam_sessions', 'readwrite');
  const now = Date.now();
  await prom(s.put({ ...progress, updatedAt: now }));
  scheduleBackup();
}

export async function deleteExamSessionProgress(examId) {
  const s = await store('exam_sessions', 'readwrite');
  await prom(s.delete(examId));
  scheduleBackup();
}

// export/import helpers
export { exportJSON, importJSON, exportAnkiCSV };
