import { openDB } from './idb.js';
import {
  saveLecture,
  deleteLecture,
  deleteBlock,
  upsertBlock,
  listLecturesByBlock,
  lectureKey,
  DEFAULT_LECTURE_STATUS,
  upsertItem
} from './storage.js';
import { buildTokens, buildSearchMeta } from '../search.js';
import { cleanItem } from '../validators.js';
import { uid, deepClone } from '../utils.js';

const TRANSFER_VERSION = 1;

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function sanitizeBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const copy = deepClone(block);
  return {
    blockId: copy.blockId,
    title: copy.title || '',
    color: copy.color || null,
    weeks: Number.isFinite(copy.weeks) ? copy.weeks : null,
    startDate: null,
    endDate: null
  };
}

function sanitizeLecture(lecture) {
  if (!lecture || typeof lecture !== 'object') return null;
  const copy = deepClone(lecture);
  return {
    blockId: copy.blockId,
    id: copy.id,
    name: copy.name || '',
    week: copy.week ?? null,
    tags: Array.isArray(copy.tags) ? copy.tags.slice() : [],
    passPlan: copy.passPlan ? deepClone(copy.passPlan) : null,
    plannerDefaults: copy.plannerDefaults ? deepClone(copy.plannerDefaults) : null,
    notes: typeof copy.notes === 'string' ? copy.notes : '',
    position: Number.isFinite(copy.position) ? copy.position : null
  };
}

function buildLectureKey(blockId, lectureId) {
  if (blockId == null || lectureId == null) return null;
  return `${blockId}|${lectureId}`;
}

function readLegacyField(source, key) {
  if (!source || typeof source !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return source[key];
  }
  if (source.data && typeof source.data === 'object' && Object.prototype.hasOwnProperty.call(source.data, key)) {
    return source.data[key];
  }
  if (source.payload && typeof source.payload === 'object' && Object.prototype.hasOwnProperty.call(source.payload, key)) {
    return source.payload[key];
  }
  return undefined;
}

function normalizeScopeValue(rawScope, lectures) {
  if (typeof rawScope === 'string') {
    const normalized = rawScope.trim().toLowerCase();
    if (normalized === 'block' || normalized === 'blocks') {
      return 'block';
    }
    if (normalized === 'week' || normalized === 'weeks') {
      return 'week';
    }
    if (normalized === 'lecture' || normalized === 'lectures') {
      return 'lecture';
    }
    if ((normalized === 'all' || normalized === 'full') && Array.isArray(lectures) && lectures.length > 1) {
      return 'block';
    }
  }
  return 'lecture';
}


function collectLectureKeys(lectures) {
  const keys = new Set();
  lectures.forEach(lecture => {
    const key = buildLectureKey(lecture.blockId, lecture.id);
    if (key) keys.add(key);
  });
  return keys;
}

function matchItemToScope(item, { blockId, week, lectureKeys, includeLooseBlockItems = false }) {
  if (!item) return false;
  const itemLectures = Array.isArray(item.lectures) ? item.lectures : [];
  for (const ref of itemLectures) {
    const key = buildLectureKey(ref?.blockId, ref?.id);
    if (key && lectureKeys.has(key)) {
      return true;
    }
    if (week != null && ref && ref.blockId === blockId) {
      const refWeek = ref.week == null ? null : ref.week;
      if (refWeek === week) return true;
    }
  }
  if (includeLooseBlockItems) {
    const itemBlocks = Array.isArray(item.blocks) ? item.blocks : [];
    if (itemBlocks.some(id => id === blockId)) {
      if (week == null) return true;
      const weeks = Array.isArray(item.weeks) ? item.weeks : [];
      if (weeks.some(w => w === week)) return true;
    }
  }
  return false;
}

async function fetchBlockRecord(blockId) {
  if (!blockId) return null;
  const db = await openDB();
  const tx = db.transaction('blocks');
  const store = tx.objectStore('blocks');
  const record = await prom(store.get(blockId));
  if (!record) return null;
  const { lectures, ...rest } = record;
  return rest;
}

async function fetchLectures(blockId) {
  const db = await openDB();
  const tx = db.transaction('lectures');
  const store = tx.objectStore('lectures');
  if (!blockId) {
    const all = await prom(store.getAll());
    return Array.isArray(all) ? all : [];
  }
  const index = typeof store.index === 'function' ? store.index('by_block') : null;
  if (index && typeof index.getAll === 'function') {
    return await prom(index.getAll(blockId));
  }
  const all = await prom(store.getAll());
  return (Array.isArray(all) ? all : []).filter(lecture => lecture?.blockId === blockId);
}

async function fetchAllItems() {
  const db = await openDB();
  const tx = db.transaction('items');
  const store = tx.objectStore('items');
  const all = await prom(store.getAll());
  return Array.isArray(all) ? all : [];
}

function sanitizeItems(items) {
  return items.map(item => {
    const copy = deepClone(item);
    delete copy.tokens;
    delete copy.searchMeta;
    return copy;
  });
}

function buildBundle({ scope, block, lectures, items }) {
  return {
    version: TRANSFER_VERSION,
    scope,
    exportedAt: Date.now(),
    block: block ? sanitizeBlock(block) : null,
    lectures: Array.isArray(lectures) ? lectures.map(sanitizeLecture).filter(Boolean) : [],
    items: sanitizeItems(items || [])
  };
}

async function exportBundleForLectures(lectures, options = {}) {
  if (!Array.isArray(lectures) || !lectures.length) {
    throw new Error('No lectures to export');
  }
  const blockId = lectures[0].blockId;
  const block = blockId ? await fetchBlockRecord(blockId) : null;
  const lectureKeys = collectLectureKeys(lectures);
  const allItems = await fetchAllItems();
  const items = allItems.filter(item =>
    matchItemToScope(item, {
      blockId,
      week: options.week ?? null,
      lectureKeys,
      includeLooseBlockItems: options.includeLooseBlockItems === true
    })
  );
  return buildBundle({ scope: options.scope || 'lecture', block, lectures, items });
}

export async function exportLectureTransfer(blockId, lectureId) {
  if (blockId == null || lectureId == null) {
    throw new Error('Missing lecture identity');
  }
  const lectures = await fetchLectures(blockId);
  const numericId = Number(lectureId);
  const match = lectures.find(lecture => {
    const id = Number(lecture?.id);
    if (Number.isFinite(id) && Number.isFinite(numericId)) return id === numericId;
    return lecture?.id === lectureId;
  });
  if (!match) {
    throw new Error('Lecture not found');
  }
  return exportBundleForLectures([match], { scope: 'lecture', week: match.week ?? null });
}

export async function exportWeekTransfer(blockId, week) {
  if (blockId == null) {
    throw new Error('Missing block identity');
  }
  const lectures = await fetchLectures(blockId);
  const normalizedWeek = week == null || week === '' ? null : week;
  const filtered = lectures.filter(lecture => {
    const lectureWeek = lecture.week == null ? null : lecture.week;
    if (normalizedWeek == null) {
      return lectureWeek == null;
    }
    return lectureWeek === normalizedWeek;
  });
  if (!filtered.length) {
    throw new Error('No lectures found for week');
  }
  return exportBundleForLectures(filtered, { scope: 'week', week: normalizedWeek });
}

export async function exportBlockTransfer(blockId) {
  if (!blockId) {
    throw new Error('Missing block identity');
  }
  const lectures = await fetchLectures(blockId);
  if (!lectures.length) {
    throw new Error('No lectures found for block');
  }
  return exportBundleForLectures(lectures, { scope: 'block', includeLooseBlockItems: true });
}

function ensureLectureDefaults(lecture) {
  const base = sanitizeLecture(lecture) || {};
  base.passes = [];
  base.passPlan = base.passPlan || null;
  base.plannerDefaults = base.plannerDefaults || null;
  base.status = { ...DEFAULT_LECTURE_STATUS, state: 'unscheduled', completedPasses: 0, lastCompletedAt: null };
  base.nextDueAt = null;
  base.startAt = null;
  return base;
}

function normalizeTransferPayload(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Invalid transfer payload');
  }
  const version = Number(bundle.version);
  if (Number.isFinite(version) && version > TRANSFER_VERSION) {
    throw new Error('Unsupported transfer version');
  }

  const rawLectures = readLegacyField(bundle, 'lectures');
  const lectureList = Array.isArray(rawLectures) ? rawLectures : [];
  const lectures = lectureList.map(ensureLectureDefaults).filter(Boolean);

  const rawScope = readLegacyField(bundle, 'scope');
  const scope = normalizeScopeValue(rawScope, lectureList);

  const rawBlock = readLegacyField(bundle, 'block') ?? readLegacyField(bundle, 'blockInfo') ?? {};
  let block = sanitizeBlock(rawBlock) || null;
  if (!block) {
    block = { blockId: null, title: '', color: null, weeks: null, startDate: null, endDate: null };
  }
  if (!block.blockId) {
    const fallbackLecture = lectures.find(lecture => lecture?.blockId != null) || null;
    if (fallbackLecture && fallbackLecture.blockId != null) {
      block.blockId = fallbackLecture.blockId;
    }
  }
  lectures.forEach(lecture => {
    if (!lecture.blockId && block.blockId != null) {
      lecture.blockId = block.blockId;
    }
  });
  if (!block.blockId) {
    throw new Error('Transfer missing block information');
  }

  const rawItems = readLegacyField(bundle, 'items');
  const items = Array.isArray(rawItems)
    ? rawItems.map(item => {
        const cleaned = cleanItem({ ...deepClone(item) });
        delete cleaned.tokens;
        delete cleaned.searchMeta;
        return cleaned;
      })
    : [];

  return { scope, block, lectures, items };
}

async function deleteExisting(scope, blockId, lectures, strategy) {
  if (strategy !== 'replace') return;
  if (!blockId) return;
  if (scope === 'block') {
    await deleteBlock(blockId);
    return;
  }
  if (scope === 'week') {
    const targetWeek = lectures[0]?.week ?? null;
    const existing = await listLecturesByBlock(blockId);
    const matches = existing.filter(lecture => {
      const lectureWeek = lecture.week == null ? null : lecture.week;
      if (targetWeek == null) {
        return lectureWeek == null;
      }
      return lectureWeek === targetWeek;
    });
    for (const lecture of matches) {
      await deleteLecture(blockId, lecture.id);
    }
    return;
  }
  if (scope === 'lecture') {
    const lecture = lectures[0];
    if (!lecture) return;
    await deleteLecture(blockId, lecture.id);
  }
}

function remapLectureIds(blockId, lectures, existingLectures, strategy) {
  const remapped = [];
  const lectureIdMap = new Map();
  let maxId = existingLectures.reduce((max, lecture) => {
    const num = Number(lecture?.id);
    if (Number.isFinite(num) && num > max) return num;
    return max;
  }, 0);
  const existingIds = new Set(existingLectures.map(lecture => lecture.id));
  lectures.forEach(lecture => {
    const normalized = ensureLectureDefaults(lecture);
    normalized.blockId = blockId;
    const desired = Number.isFinite(Number(lecture.id)) ? Number(lecture.id) : lecture.id;
    let finalId = desired;
    if (strategy === 'merge' && existingIds.has(desired)) {
      maxId += 1;
      finalId = maxId;
    }
    normalized.id = finalId;
    existingIds.add(finalId);
    const key = buildLectureKey(blockId, lecture.id);
    if (key) {
      lectureIdMap.set(key, {
        blockId,
        lectureId: finalId,
        name: normalized.name,
        week: normalized.week ?? null
      });
    }
    remapped.push(normalized);
  });
  return { lectures: remapped, lectureIdMap };
}

function remapLectureRefs(refs, lectureIdMap) {
  if (!Array.isArray(refs)) return [];
  return refs.map(ref => {
    if (!ref || typeof ref !== 'object') return ref;
    const key = buildLectureKey(ref.blockId, ref.id);
    if (key && lectureIdMap.has(key)) {
      const mapping = lectureIdMap.get(key);
      return {
        blockId: mapping.blockId,
        id: mapping.lectureId,
        name: mapping.name || ref.name || '',
        week: mapping.week ?? ref.week ?? null
      };
    }
    return ref;
  });
}

function remapLinks(links, itemIdMap) {
  if (!Array.isArray(links)) return [];
  return links.map(link => {
    if (!link || typeof link !== 'object') return link;
    const mappedId = itemIdMap.get(link.id);
    if (mappedId) {
      return { ...link, id: mappedId };
    }
    return link;
  });
}

async function persistLectures(blockId, lectures, lectureIdMap) {
  for (const lecture of lectures) {
    const payload = {
      blockId,
      id: lecture.id,
      name: lecture.name,
      week: lecture.week,
      passPlan: lecture.passPlan || null,
      startAt: Date.now(),
      tags: Array.isArray(lecture.tags) ? lecture.tags.slice() : [],
      plannerDefaults: lecture.plannerDefaults || null,
      position: lecture.position
    };
    await saveLecture(payload);
    const db = await openDB();
    const tx = db.transaction('lectures', 'readwrite');
    const store = tx.objectStore('lectures');
    const key = lectureKey(blockId, lecture.id);
    const record = await prom(store.get(key));
    if (record) {
      record.passes = [];
      record.status = { ...DEFAULT_LECTURE_STATUS, state: 'unscheduled', completedPasses: 0, lastCompletedAt: null };
      record.nextDueAt = null;
      record.startAt = null;
      record.plannerDefaults = lecture.plannerDefaults || null;
      record.updatedAt = Date.now();
      await prom(store.put(record));
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const keyStr = buildLectureKey(blockId, lecture.id);
    if (keyStr) {
      lectureIdMap.set(keyStr, {
        blockId,
        lectureId: lecture.id,
        name: lecture.name,
        week: lecture.week ?? null
      });
    }
  }
}

async function persistItems(items, lectureIdMap, strategy) {
  const existingIds = new Set();
  const allExisting = await fetchAllItems();
  allExisting.forEach(item => {
    if (item?.id) existingIds.add(item.id);
  });
  const plans = [];
  const itemIdMap = new Map();
  for (const rawItem of items) {
    const originalId = rawItem?.id || null;
    let finalId = originalId;
    if (!originalId) {
      finalId = uid();
    } else if (!existingIds.has(originalId)) {
      finalId = originalId;
    } else if (strategy === 'replace') {
      finalId = originalId;
    } else {
      let candidate = `${originalId}-${uid().slice(0, 6)}`;
      while (existingIds.has(candidate)) {
        candidate = `${originalId}-${uid().slice(0, 6)}`;
      }
      finalId = candidate;
      itemIdMap.set(originalId, finalId);
    }
    existingIds.add(finalId);
    plans.push({ raw: rawItem, finalId });
  }

  for (const plan of plans) {
    const item = cleanItem({ ...plan.raw });
    item.id = plan.finalId;
    item.lectures = remapLectureRefs(item.lectures, lectureIdMap);
    item.links = remapLinks(item.links, itemIdMap);
    delete item.tokens;
    delete item.searchMeta;
    item.tokens = buildTokens(item);
    item.searchMeta = buildSearchMeta(item);
    await upsertItem(item);
  }
  return itemIdMap;
}

export async function importLectureTransfer(bundle, options = {}) {
  const { scope, block, lectures, items } = normalizeTransferPayload(bundle);
  if (!block || !block.blockId) {
    throw new Error('Transfer missing block information');
  }
  const strategy = options.strategy === 'replace' ? 'replace' : 'merge';
  const blockId = block.blockId;

  await deleteExisting(scope, blockId, lectures, strategy);

  const existingBlock = await fetchBlockRecord(blockId);
  if (!existingBlock) {
    await upsertBlock({
      blockId,
      title: block.title,
      color: block.color,
      weeks: block.weeks,
      startDate: null,
      endDate: null,
      lectures: []
    });
  }

  const existingLectures = await listLecturesByBlock(blockId);
  const { lectures: normalizedLectures, lectureIdMap } = remapLectureIds(blockId, lectures, existingLectures, strategy);
  await persistLectures(blockId, normalizedLectures, lectureIdMap);
  const itemIdMap = await persistItems(items, lectureIdMap, strategy);
}
