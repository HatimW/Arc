import { openDB } from './idb.js';
import { lectureKey, normalizeLectureRecord } from './lecture-schema.js';
import { deepClone } from '../utils.js';

const clone = deepClone;

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function lectureStore(mode = 'readonly') {
  const db = await openDB();
  return db.transaction('lectures', mode).objectStore('lectures');
}

async function fetchLecturesForBlock(storeRef, blockId) {
  if (!blockId) return [];
  try {
    if (typeof storeRef.index === 'function') {
      const idx = storeRef.index('by_block');
      if (idx && typeof idx.getAll === 'function') {
        const results = await prom(idx.getAll(blockId));
        return Array.isArray(results) ? results : [];
      }
    }
  } catch (err) {
    console.warn('Failed to use lecture block index, falling back to scan', err);
  }
  const all = await prom(storeRef.getAll());
  return (Array.isArray(all) ? all : []).filter(entry => entry?.blockId === blockId);
}

function buildNormalizedLecture(blockId, input, existing, now) {
  const lectureId = input?.id ?? existing?.id;
  if (blockId == null || lectureId == null) return null;
  const tags = Array.isArray(input?.tags)
    ? input.tags
    : Array.isArray(existing?.tags)
      ? existing.tags
      : undefined;
  const explicitPasses = Array.isArray(input?.passes);
  const passPlanChanged = Boolean(input?.passPlan);
  const plannerDefaultsChanged = Boolean(input?.plannerDefaults);
  const startProvided = input?.startAt !== undefined;
  const passContextChanged = passPlanChanged || plannerDefaultsChanged || startProvided;
  const shouldPreserveScheduleState = !explicitPasses && !passContextChanged;
  let passes;
  if (explicitPasses) {
    passes = input.passes;
  } else if (passContextChanged && Array.isArray(existing?.passes)) {
    passes = existing.passes.map(pass => {
      if (!pass || typeof pass !== 'object') return pass;
      const next = { ...pass };
      delete next.due;
      return next;
    });
  } else {
    passes = Array.isArray(existing?.passes)
      ? existing.passes
      : undefined;
  }
  const passPlan = passPlanChanged
    ? { ...(existing?.passPlan || {}), ...input.passPlan }
    : existing?.passPlan;
  const status = input?.status
    ? { ...(existing?.status || {}), ...input.status }
    : existing?.status;
  const plannerDefaults = plannerDefaultsChanged
    ? { ...(existing?.plannerDefaults || {}), ...input.plannerDefaults }
    : existing?.plannerDefaults;
  const nextDueAt = input?.nextDueAt !== undefined
    ? input.nextDueAt
    : existing?.nextDueAt;

  const composite = {
    ...(existing || {}),
    ...(input || {}),
    blockId,
    id: lectureId,
    key: lectureKey(blockId, lectureId),
    tags,
    passes,
    passPlan,
    plannerDefaults,
    status,
    nextDueAt
  };

  const normalized = normalizeLectureRecord(blockId, composite, now);
  if (existing?.createdAt != null) normalized.createdAt = existing.createdAt;
  if (existing && !input?.passPlan && existing.passPlan) normalized.passPlan = clone(existing.passPlan);
  if (existing && shouldPreserveScheduleState && !input?.status && existing.status) {
    normalized.status = clone(existing.status);
  }
  if (existing && shouldPreserveScheduleState && Array.isArray(existing.passes)) {
    normalized.passes = clone(existing.passes);
  }
  if (existing && !Array.isArray(input?.tags) && Array.isArray(existing.tags)) {
    normalized.tags = clone(existing.tags);
  }
  if (existing && shouldPreserveScheduleState && input?.nextDueAt === undefined && existing.nextDueAt !== undefined) {
    normalized.nextDueAt = existing.nextDueAt ?? null;
  }
  return normalized;
}

function ensureLectureSchedule(lecture, now = Date.now()) {
  if (!lecture || typeof lecture !== 'object') return lecture;
  const schedule = Array.isArray(lecture?.passPlan?.schedule) ? lecture.passPlan.schedule : [];
  const hasSchedule = schedule.length > 0;
  const hasPasses = Array.isArray(lecture?.passes) && lecture.passes.length > 0;
  const hasNextDue = Number.isFinite(lecture?.nextDueAt);
  if (!hasSchedule || (hasPasses && hasNextDue)) {
    return lecture;
  }
  const normalized = normalizeLectureRecord(lecture.blockId, lecture, now);
  if (!normalized) return lecture;
  if (lecture.createdAt != null) normalized.createdAt = lecture.createdAt;
  if (lecture.updatedAt != null) normalized.updatedAt = lecture.updatedAt;
  return normalized;
}

export async function listLecturesByBlock(blockId) {
  try {
    const store = await lectureStore();
    const rows = await fetchLecturesForBlock(store, blockId);
    const now = Date.now();
    return rows.map(row => ensureLectureSchedule(clone(row), now));
  } catch (err) {
    console.warn('listLecturesByBlock failed', err);
    return [];
  }
}

export async function listAllLectures() {
  try {
    const store = await lectureStore();
    const rows = await prom(store.getAll());
    const now = Date.now();
    return Array.isArray(rows) ? rows.map(row => ensureLectureSchedule(clone(row), now)) : [];
  } catch (err) {
    console.warn('listAllLectures failed', err);
    return [];
  }
}

export async function saveLecture(lecture) {
  if (!lecture || lecture.blockId == null) {
    throw new Error('Missing lecture identity for save');
  }
  const store = await lectureStore('readwrite');
  let lectureId = lecture.id;
  if (lectureId == null) {
    const rows = await fetchLecturesForBlock(store, lecture.blockId);
    let maxId = 0;
    for (const row of rows) {
      const value = Number(row?.id);
      if (Number.isFinite(value) && value > maxId) {
        maxId = value;
      }
    }
    lectureId = maxId + 1;
  }
  if (typeof lectureId === 'string') {
    const parsed = Number(lectureId);
    if (!Number.isNaN(parsed)) {
      lectureId = parsed;
    }
  }
  const key = lectureKey(lecture.blockId, lectureId);
  const existing = await prom(store.get(key));
  const now = Date.now();
  const normalized = buildNormalizedLecture(lecture.blockId, { ...lecture, id: lectureId }, existing, now);
  if (!normalized) throw new Error('Failed to normalize lecture payload');
  await prom(store.put(normalized));
  return clone(normalized);
}

export async function deleteLectureRecord(blockId, lectureId) {
  if (blockId == null || lectureId == null) return;
  const store = await lectureStore('readwrite');
  await prom(store.delete(lectureKey(blockId, lectureId)));
}

export async function removeLecturesForBlock(blockId) {
  if (!blockId) return;
  const store = await lectureStore('readwrite');
  const rows = await fetchLecturesForBlock(store, blockId);
  for (const row of rows) {
    await prom(store.delete(row.key));
  }
}

export async function bulkUpdateLectureStatus(updates) {
  if (!Array.isArray(updates) || !updates.length) return;
  const store = await lectureStore('readwrite');
  const now = Date.now();
  for (const update of updates) {
    if (!update || update.blockId == null || update.lectureId == null) continue;
    const key = lectureKey(update.blockId, update.lectureId);
    const existing = await prom(store.get(key));
    if (!existing) continue;
    const normalized = buildNormalizedLecture(
      update.blockId,
      {
        id: update.lectureId,
        status: update.status,
        passes: update.passes,
        nextDueAt: update.nextDueAt,
        passPlan: update.passPlan,
        tags: update.tags
      },
      existing,
      now
    );
    if (!normalized) continue;
    await prom(store.put(normalized));
  }
}

export {
  DEFAULT_PASS_PLAN,
  DEFAULT_LECTURE_STATUS,
  lectureKey
} from './lecture-schema.js';
