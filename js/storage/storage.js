import { openDB } from './idb.js';
import {
  listLecturesByBlock as fetchLecturesByBlock,
  listAllLectures as fetchAllLectures,
  saveLecture as persistLecture,
  deleteLectureRecord as dropLectureRecord,
  removeLecturesForBlock as dropLecturesForBlock,
  lectureKey as composeLectureKey
} from './lectures.js';

export {
  listLecturesByBlock,
  listAllLectures,
  saveLecture,
  deleteLectureRecord,
  removeLecturesForBlock,
  bulkUpdateLectureStatus,
  DEFAULT_PASS_PLAN,
  DEFAULT_LECTURE_STATUS,
  lectureKey
} from './lectures.js';
import { exportJSON, importJSON as rawImportJSON, exportAnkiCSV } from './export.js';
import { DEFAULT_REVIEW_STEPS } from '../review/constants.js';
import { normalizeReviewSteps } from '../review/settings.js';
import { DEFAULT_PLANNER_DEFAULTS, normalizePlannerDefaults } from '../lectures/scheduler.js';

let dbPromise;
let itemsVersion = 0;
const queryCache = new Map();
const MAX_QUERY_CACHE = 20;

const DEFAULT_KINDS = ['disease', 'drug', 'concept'];
const RESULT_BATCH_SIZE = 50;
const DATA_BACKUP_KEY = 'arc-backup-snapshot';
const DATA_BACKUP_STORES = ['items', 'blocks', 'exams', 'settings', 'exam_sessions', 'study_sessions', 'lectures'];

const DEFAULT_APP_SETTINGS = {
  id: 'app',
  dailyCount: 20,
  theme: 'dark',
  reviewSteps: { ...DEFAULT_REVIEW_STEPS },
  plannerDefaults: normalizePlannerDefaults(DEFAULT_PLANNER_DEFAULTS)
};

let backupTimer = null;

const KIND_VARIANTS = {
  disease: ['disease', 'diseases', 'Disease', 'Diseases', 'DISEASE', 'DISEASES'],
  drug: ['drug', 'drugs', 'Drug', 'Drugs', 'DRUG', 'DRUGS'],
  concept: ['concept', 'concepts', 'Concept', 'Concepts', 'CONCEPT', 'CONCEPTS']
};

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalizeKindValue(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'diseases') return 'disease';
  if (normalized === 'drugs') return 'drug';
  if (normalized === 'concepts') return 'concept';
  return normalized;
}

function expandKindVariants(types = []) {
  const expanded = new Set();
  types.forEach(type => {
    if (typeof type !== 'string') return;
    const raw = type.trim();
    if (raw) expanded.add(raw);
    const normalized = normalizeKindValue(raw);
    if (!normalized) return;
    const variants = KIND_VARIANTS[normalized] || [normalized];
    variants.forEach(variant => expanded.add(variant));
  });
  return Array.from(expanded);
}

function inferKindFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.concept === 'string' && item.concept.trim()) return 'concept';
  const drugSignals = ['moa', 'uses', 'sideEffects', 'contraindications', 'source', 'class'];
  if (drugSignals.some(key => typeof item[key] === 'string' && item[key].trim())) {
    return 'drug';
  }
  const conceptSignals = ['definition', 'mechanism', 'clinicalRelevance', 'example', 'type'];
  if (conceptSignals.some(key => typeof item[key] === 'string' && item[key].trim())) {
    return 'concept';
  }
  const diseaseSignals = ['etiology', 'pathophys', 'clinical', 'diagnosis', 'treatment', 'complications', 'mnemonic'];
  if (diseaseSignals.some(key => typeof item[key] === 'string' && item[key].trim())) {
    return 'disease';
  }
  return 'disease';
}

function normalizeItemKind(item) {
  if (!item || typeof item !== 'object') return item;
  const normalized = normalizeKindValue(item.kind);
  if (!normalized || normalized === item.kind) return item;
  return { ...item, kind: normalized };
}

function ensureItemKind(item) {
  if (!item || typeof item !== 'object') return item;
  const normalized = normalizeItemKind(item);
  if (normalized?.kind) return normalized;
  const inferred = inferKindFromItem(normalized);
  if (!inferred) return normalized;
  return { ...normalized, kind: inferred };
}

function markItemsUpdated() {
  itemsVersion += 1;
  queryCache.clear();
}

async function store(name, mode = 'readonly') {
  const db = await dbPromise;
  return db.transaction(name, mode).objectStore(name);
}

function canUseStorage() {
  return typeof localStorage !== 'undefined';
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
    await prom(s.put(DEFAULT_APP_SETTINGS));
  }
  scheduleBackup();
}

export async function getSettings() {
  const s = await store('settings');
  const settings = await prom(s.get('app'));
  if (!settings) return { ...DEFAULT_APP_SETTINGS };
  const merged = { ...DEFAULT_APP_SETTINGS, ...settings };
  merged.reviewSteps = normalizeReviewSteps(settings.reviewSteps || merged.reviewSteps);
  merged.plannerDefaults = normalizePlannerDefaults(settings.plannerDefaults || merged.plannerDefaults);
  return merged;
}

export async function saveSettings(patch) {
  const s = await store('settings', 'readwrite');
  const current = await prom(s.get('app')) || { ...DEFAULT_APP_SETTINGS };
  const mergedSteps = normalizeReviewSteps({
    ...DEFAULT_APP_SETTINGS.reviewSteps,
    ...(current.reviewSteps || {}),
    ...(patch.reviewSteps || {})
  });
  const basePlanner = current.plannerDefaults || DEFAULT_APP_SETTINGS.plannerDefaults;
  const patchPlanner = patch?.plannerDefaults || {};
  const mergedPlannerDefaults = normalizePlannerDefaults({
    anchorOffsets: {
      ...(DEFAULT_APP_SETTINGS.plannerDefaults?.anchorOffsets || {}),
      ...(basePlanner?.anchorOffsets || {}),
      ...(patchPlanner.anchorOffsets || {})
    },
    passes: Array.isArray(patchPlanner.passes) && patchPlanner.passes.length
      ? patchPlanner.passes
      : basePlanner?.passes || DEFAULT_APP_SETTINGS.plannerDefaults?.passes,
    passColors: Array.isArray(patchPlanner.passColors) && patchPlanner.passColors.length
      ? patchPlanner.passColors
      : basePlanner?.passColors || DEFAULT_APP_SETTINGS.plannerDefaults?.passColors
  });
  const next = {
    ...current,
    ...patch,
    id: 'app',
    reviewSteps: mergedSteps,
    plannerDefaults: mergedPlannerDefaults
  };
  await prom(s.put(next));
  scheduleBackup();
}

export async function listBlocks() {
  try {
    const lecturePromise = fetchAllLectures();
    const blockStore = await store('blocks');
    const all = await prom(blockStore.getAll());
    const lectures = await lecturePromise;
    const blocks = (all || [])
      .map(block => {
        if (!block || typeof block !== 'object') return block;
        const { lectures: _ignored, ...rest } = block;
        return { ...rest };
      })
      .sort((a, b) => {
        const ao = a.order ?? a.createdAt;
        const bo = b.order ?? b.createdAt;
        return bo - ao;
      });

    const lectureIndex = {};
    for (const lecture of lectures || []) {
      if (!lecture || lecture.blockId == null || lecture.id == null) continue;
      const blockId = lecture.blockId;
      if (!lectureIndex[blockId]) lectureIndex[blockId] = {};
      lectureIndex[blockId][lecture.id] = { ...lecture };
    }

    return { blocks, lectureIndex };
  } catch (err) {
    console.warn('listBlocks failed', err);
    return { blocks: [], lectureIndex: {} };
  }
}

function slugifyBlockTitle(title) {
  if (typeof title !== 'string' || !title.trim()) return 'block';
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'block';
}

async function generateBlockId(storeRef, title) {
  const base = slugifyBlockTitle(title);
  let candidate = base;
  let attempt = 1;
  while (true) {
    const existing = candidate ? await prom(storeRef.get(candidate)) : null;
    if (!existing && candidate) {
      return candidate;
    }
    attempt += 1;
    candidate = `${base}-${attempt}`;
    if (attempt > 1000) {
      return `block-${Date.now()}`;
    }
  }
}

function normalizeDateInput(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  return null;
}

export async function upsertBlock(def) {
  const title = typeof def?.title === 'string' ? def.title : '';
  let blockId = typeof def?.blockId === 'string' && def.blockId.trim() ? def.blockId.trim() : '';
  const readStore = await store('blocks');
  if (!blockId) {
    blockId = await generateBlockId(readStore, title || 'block');
  }
  const existing = await prom(readStore.get(blockId));
  const existingLectures = await fetchLecturesByBlock(blockId);
  const now = Date.now();
  const incomingLectures = Array.isArray(def.lectures)
    ? def.lectures.map(lecture => ({
        ...lecture,
        blockId
      }))
    : existingLectures.map(lecture => ({
        blockId: lecture.blockId,
        id: lecture.id,
        name: lecture.name,
        week: lecture.week,
        tags: Array.isArray(lecture.tags) ? lecture.tags : []
      }));

  const removedLectureIds = [];
  let itemsTouched = false;
  let prunedLectures = incomingLectures;

  if (existing && typeof def.weeks === 'number' && def.weeks < existing.weeks) {
    const maxWeek = def.weeks;
    prunedLectures = incomingLectures.filter(lecture => {
      const week = lecture?.week;
      const keep = week == null || week <= maxWeek;
      if (!keep && lecture?.id != null) {
        removedLectureIds.push(lecture.id);
      }
      return keep;
    });
    const i = await store('items', 'readwrite');
    const all = await prom(i.getAll());
    for (const it of all) {
      let changed = false;
      if (it.lectures) {
        const before = it.lectures.length;
        it.lectures = it.lectures.filter(l => !(l.blockId === blockId && l.week > maxWeek));
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
        itemsTouched = true;
      }
    }
  }

  const next = {
    ...def,
    blockId,
    color: def.color || existing?.color || null,
    order: def.order || existing?.order || now,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    weeks: typeof def.weeks === 'number' ? def.weeks : existing?.weeks,
    startDate:
      def.startDate !== undefined
        ? normalizeDateInput(def.startDate)
        : existing?.startDate
          ? normalizeDateInput(existing.startDate)
          : null,
    endDate:
      def.endDate !== undefined
        ? normalizeDateInput(def.endDate)
        : existing?.endDate
          ? normalizeDateInput(existing.endDate)
          : null
  };
  delete next.lectures;
  const writeStore = await store('blocks', 'readwrite');
  await prom(writeStore.put(next));

  const incomingKeySet = new Set(
    prunedLectures
      .filter(lecture => lecture?.id != null)
      .map(lecture => composeLectureKey(blockId, lecture.id))
  );
  for (const lecture of existingLectures) {
    const key = lecture?.key || composeLectureKey(lecture.blockId, lecture.id);
    if (!incomingKeySet.has(key) && lecture?.id != null) {
      removedLectureIds.push(lecture.id);
    }
  }

  for (const lecture of prunedLectures) {
    if (lecture?.id == null) continue;
    await persistLecture({
      blockId,
      id: lecture.id,
      name: lecture.name,
      week: lecture.week,
      tags: Array.isArray(lecture.tags) ? lecture.tags : undefined,
      passes: Array.isArray(lecture.passes) ? lecture.passes : undefined,
      passPlan: lecture.passPlan,
      status: lecture.status,
      nextDueAt: lecture.nextDueAt
    });
  }

  const uniqueRemoved = Array.from(new Set(removedLectureIds.filter(id => id != null)));
  for (const lectureId of uniqueRemoved) {
    await dropLectureRecord(blockId, lectureId);
  }
  if (uniqueRemoved.length) {
    const removed = await removeLectureReferencesFromItems(blockId, uniqueRemoved);
    itemsTouched = itemsTouched || removed;
  }
  if (itemsTouched) {
    markItemsUpdated();
  }

  scheduleBackup();
}

async function removeLectureReferencesFromItems(blockId, lectureIds) {
  if (!lectureIds.length) return false;
  const i = await store('items', 'readwrite');
  const all = await prom(i.getAll());
  let touched = false;
  for (const it of all) {
    const before = it.lectures?.length || 0;
    if (!before) continue;
    it.lectures = it.lectures.filter(l => !(l.blockId === blockId && lectureIds.includes(l.id)));
    if (it.lectures.length !== before) {
      it.blocks = it.blocks?.filter(bid => bid !== blockId || it.lectures.some(l => l.blockId === bid));
      const validWeeks = new Set((it.lectures || []).map(l => l.week));
      it.weeks = Array.from(validWeeks);
      it.tokens = buildTokens(it);
      it.searchMeta = buildSearchMeta(it);
      await prom(i.put(it));
      touched = true;
    }
  }
  return touched;
}

export async function deleteBlock(blockId) {
  const b = await store('blocks', 'readwrite');
  await prom(b.delete(blockId));
  await dropLecturesForBlock(blockId);
  // remove references from items to keep them "unlabeled"
  const i = await store('items', 'readwrite');
  const all = await prom(i.getAll());
  let itemsTouched = false;
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
        itemsTouched = true;
      }
    }
  }
  if (itemsTouched) {
    markItemsUpdated();
  }
  scheduleBackup();
}

export async function deleteLecture(blockId, lectureId) {
  await dropLectureRecord(blockId, lectureId);
  const touched = await removeLectureReferencesFromItems(blockId, [lectureId]);
  if (touched) {
    markItemsUpdated();
  }
  scheduleBackup();
}

export async function updateLecture(blockId, lecture) {
  if (!lecture || lecture.id == null) return;
  await persistLecture({ ...lecture, blockId });
  const i = await store('items', 'readwrite');
  const all = await prom(i.getAll());
  let itemsTouched = false;
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
      itemsTouched = true;
    }
  }
  if (itemsTouched) {
    markItemsUpdated();
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

export async function listAllItems() {
  const i = await store('items');
  return await prom(i.getAll());
}

function titleOf(item){
  return item.name || item.concept || '';
}

const DEFAULT_SORT = { mode: 'updated', direction: 'desc' };

function normalizeSort(sort) {
  const raw = typeof sort === 'string' ? sort.toLowerCase() : '';
  switch (raw) {
    case 'updated-asc':
      return { mode: 'updated', direction: 'asc' };
    case 'updated-desc':
    case 'updated':
      return { mode: 'updated', direction: 'desc' };
    case 'created-asc':
      return { mode: 'created', direction: 'asc' };
    case 'created-desc':
    case 'created':
      return { mode: 'created', direction: 'desc' };
    case 'lecture-asc':
      return { mode: 'lecture', direction: 'asc' };
    case 'lecture-desc':
    case 'lecture':
      return { mode: 'lecture', direction: 'desc' };
    case 'name-desc':
      return { mode: 'name', direction: 'desc' };
    case 'name':
    case 'name-asc':
      return { mode: 'name', direction: 'asc' };
    default:
      return { ...DEFAULT_SORT };
  }
}

function normalizeFilter(filter = {}) {
  const rawTypes = Array.isArray(filter.types) ? filter.types.filter(t => typeof t === 'string' && t) : [];
  const selectedTypes = rawTypes.length ? rawTypes : DEFAULT_KINDS;
  const types = expandKindVariants(selectedTypes);
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
  const normalizedQuery = query.toLowerCase();
  const tokens = query ? tokenize(query) : [];
  return {
    types,
    block,
    week,
    onlyFav,
    tokens: tokens.length ? tokens : null,
    query: normalizedQuery,
    sort: normalizeSort(filter.sort)
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
  let idx = null;
  if (typeof storeRef.index === 'function') {
    try {
      idx = storeRef.index('by_kind');
    } catch (err) {
      idx = null;
    }
  }
  const seen = new Set();
  const allKeys = [];
  if (idx && (typeof idx.getAllKeys === 'function' || typeof idx.getAll === 'function')) {
    for (const kind of kinds) {
      if (!kind) continue;
      let keys = [];
      if (typeof idx.getAllKeys === 'function') {
        keys = await prom(idx.getAllKeys(kind));
      } else if (typeof idx.getAll === 'function') {
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

  const all = await prom(storeRef.getAll());
  const kindsSet = new Set(kinds.filter(Boolean));
  (Array.isArray(all) ? all : []).forEach(item => {
    if (!item || !kindsSet.has(item.kind)) return;
    if (!seen.has(item.id)) {
      seen.add(item.id);
      allKeys.push(item.id);
    }
  });
  return allKeys;
}

async function executeItemQuery(filter, options = {}) {
  const normalized = options.normalized ? filter : normalizeFilter(filter);
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
      const normalizedItem = normalizeItemKind(item);
      if (normalized.block === '__unlabeled' && Array.isArray(normalizedItem.blocks) && normalizedItem.blocks.length) {
        continue;
      }
      if (normalized.tokens) {
        const tokenField = normalizedItem.tokens || '';
        const metaField = normalizedItem.searchMeta || buildSearchMeta(normalizedItem);
        const matches = normalized.tokens.every(tok => tokenField.includes(tok) || metaField.includes(tok));
        if (!matches) continue;
      }
      results.push(normalizedItem);
    }
  }

  let lectureDateIndex = null;
  if (normalized.sort.mode === 'lecture') {
    const lectures = await fetchAllLectures();
    lectureDateIndex = new Map();
    (lectures || []).forEach(lecture => {
      if (!lecture || lecture.blockId == null || lecture.id == null) return;
      const key = composeLectureKey(lecture.blockId, lecture.id);
      const created = typeof lecture.createdAt === 'number' ? lecture.createdAt : 0;
      lectureDateIndex.set(key, created);
    });
  }

  const lectureSortCache = new Map();
  function lectureTimestamp(item) {
    if (!lectureDateIndex) return 0;
    const cacheKey = item?.id ?? null;
    if (cacheKey != null && lectureSortCache.has(cacheKey)) {
      return lectureSortCache.get(cacheKey);
    }
    const links = Array.isArray(item?.lectures) ? item.lectures : [];
    let latest = 0;
    for (const link of links) {
      if (!link || link.blockId == null || link.id == null) continue;
      const key = composeLectureKey(link.blockId, link.id);
      const created = lectureDateIndex.get(key);
      if (typeof created === 'number' && created > latest) {
        latest = created;
      }
    }
    if (cacheKey != null) lectureSortCache.set(cacheKey, latest);
    return latest;
  }

  const queryString = typeof normalized.query === 'string' ? normalized.query : '';
  const hasQueryString = queryString.length > 0;

  function nameMatchScore(item) {
    if (!hasQueryString) return 0;
    const title = titleOf(item).toLowerCase();
    if (!title) return 0;
    if (title.startsWith(queryString)) return 2;
    if (title.includes(queryString)) return 1;
    return 0;
  }

  results.sort((a, b) => {
    if (hasQueryString) {
      const aScore = nameMatchScore(a);
      const bScore = nameMatchScore(b);
      if (aScore !== bScore) {
        return bScore - aScore;
      }
    }
    let cmp = 0;
    switch (normalized.sort.mode) {
      case 'name':
        cmp = titleOf(a).localeCompare(titleOf(b));
        break;
      case 'created': {
        const av = typeof a.createdAt === 'number' ? a.createdAt : 0;
        const bv = typeof b.createdAt === 'number' ? b.createdAt : 0;
        cmp = av - bv;
        break;
      }
      case 'lecture':
        cmp = lectureTimestamp(a) - lectureTimestamp(b);
        break;
      case 'updated':
      default: {
        const av = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
        const bv = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
        cmp = av - bv;
        break;
      }
    }
    if (cmp === 0 && normalized.sort.mode !== 'name') {
      cmp = titleOf(a).localeCompare(titleOf(b));
    }
    return normalized.sort.direction === 'asc' ? cmp : -cmp;
  });

  return results;
}

export async function filterItemsLocally(items, filter) {
  const normalized = normalizeFilter(filter);
  const kindsSet = new Set(normalized.types.filter(Boolean));
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const normalizedItem = ensureItemKind(item);
    const kind = normalizedItem?.kind;
    if (!kind || !kindsSet.has(kind)) continue;
    if (normalized.block === '__unlabeled') {
      if (Array.isArray(normalizedItem.blocks) && normalizedItem.blocks.length) continue;
    } else if (normalized.block) {
      const blocks = Array.isArray(normalizedItem.blocks) ? normalizedItem.blocks : [];
      if (!blocks.includes(normalized.block)) continue;
    }
    if (normalized.week != null) {
      const weeks = Array.isArray(normalizedItem.weeks) ? normalizedItem.weeks : [];
      if (!weeks.includes(normalized.week)) continue;
    }
    if (normalized.onlyFav && !normalizedItem.favorite) continue;
    if (normalized.tokens) {
      const tokenField = normalizedItem.tokens || '';
      const metaField = normalizedItem.searchMeta || buildSearchMeta(normalizedItem);
      const matches = normalized.tokens.every(tok => tokenField.includes(tok) || metaField.includes(tok));
      if (!matches) continue;
    }
    results.push(normalizedItem);
  }

  let lectureDateIndex = null;
  if (normalized.sort.mode === 'lecture') {
    const lectures = await fetchAllLectures();
    lectureDateIndex = new Map();
    (lectures || []).forEach(lecture => {
      if (!lecture || lecture.blockId == null || lecture.id == null) return;
      const key = composeLectureKey(lecture.blockId, lecture.id);
      const created = typeof lecture.createdAt === 'number' ? lecture.createdAt : 0;
      lectureDateIndex.set(key, created);
    });
  }

  const lectureSortCache = new Map();
  function lectureTimestamp(item) {
    if (!lectureDateIndex) return 0;
    const cacheKey = item?.id ?? null;
    if (cacheKey != null && lectureSortCache.has(cacheKey)) {
      return lectureSortCache.get(cacheKey);
    }
    const links = Array.isArray(item?.lectures) ? item.lectures : [];
    let latest = 0;
    for (const link of links) {
      if (!link || link.blockId == null || link.id == null) continue;
      const key = composeLectureKey(link.blockId, link.id);
      const created = lectureDateIndex.get(key);
      if (typeof created === 'number' && created > latest) {
        latest = created;
      }
    }
    if (cacheKey != null) lectureSortCache.set(cacheKey, latest);
    return latest;
  }

  const queryString = typeof normalized.query === 'string' ? normalized.query : '';
  const hasQueryString = queryString.length > 0;

  function nameMatchScore(item) {
    if (!hasQueryString) return 0;
    const title = titleOf(item).toLowerCase();
    if (!title) return 0;
    if (title.startsWith(queryString)) return 2;
    if (title.includes(queryString)) return 1;
    return 0;
  }

  results.sort((a, b) => {
    if (hasQueryString) {
      const aScore = nameMatchScore(a);
      const bScore = nameMatchScore(b);
      if (aScore !== bScore) {
        return bScore - aScore;
      }
    }
    let cmp = 0;
    switch (normalized.sort.mode) {
      case 'name':
        cmp = titleOf(a).localeCompare(titleOf(b));
        break;
      case 'created': {
        const av = typeof a.createdAt === 'number' ? a.createdAt : 0;
        const bv = typeof b.createdAt === 'number' ? b.createdAt : 0;
        cmp = av - bv;
        break;
      }
      case 'lecture':
        cmp = lectureTimestamp(a) - lectureTimestamp(b);
        break;
      case 'updated':
      default: {
        const av = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
        const bv = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
        cmp = av - bv;
        break;
      }
    }
    if (cmp === 0 && normalized.sort.mode !== 'name') {
      cmp = titleOf(a).localeCompare(titleOf(b));
    }
    return normalized.sort.direction === 'asc' ? cmp : -cmp;
  });

  return results;
}

export function findItemsByFilter(filter) {
  let memo;
  const run = () => {
    if (!memo) {
      const normalized = normalizeFilter(filter);
      const cacheKey = JSON.stringify(normalized);
      const cached = queryCache.get(cacheKey);
      if (cached && cached.version === itemsVersion) {
        memo = cached.promise;
      } else {
        memo = executeItemQuery(normalized, { normalized: true });
        queryCache.set(cacheKey, { version: itemsVersion, promise: memo });
        if (queryCache.size > MAX_QUERY_CACHE) {
          const oldestKey = queryCache.keys().next().value;
          if (oldestKey) queryCache.delete(oldestKey);
        }
      }
    }
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
  markItemsUpdated();
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
  markItemsUpdated();
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

export async function listStudySessions() {
  try {
    const s = await store('study_sessions');
    const list = await prom(s.getAll());
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('Failed to list study sessions', err);
    return [];
  }
}

export async function saveStudySessionRecord(record) {
  if (!record || !record.mode) throw new Error('Study session record requires a mode');
  const s = await store('study_sessions', 'readwrite');
  const now = Date.now();
  await prom(s.put({ ...record, updatedAt: now }));
  scheduleBackup();
}

export async function deleteStudySessionRecord(mode) {
  if (!mode) return;
  const s = await store('study_sessions', 'readwrite');
  await prom(s.delete(mode));
  scheduleBackup();
}

export async function clearAllStudySessionRecords() {
  const s = await store('study_sessions', 'readwrite');
  await prom(s.clear());
  scheduleBackup();
}

export async function importJSON(...args) {
  const result = await rawImportJSON(...args);
  markItemsUpdated();
  return result;
}

// export/import helpers
export { exportJSON, exportAnkiCSV };
