import { openDB } from './idb.js';
import { buildTokens, buildSearchMeta } from '../search.js';
import { lectureKey, normalizeLectureRecord } from './lecture-schema.js';
import { uid, deepClone } from '../utils.js';

const MAP_CONFIG_KEY = 'map-config';
const TRANSACTION_STORES = [
  'items',
  'blocks',
  'exams',
  'settings',
  'exam_sessions',
  'study_sessions',
  'lectures'
];

function prom(req){
  return new Promise((resolve,reject)=>{
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

function coerceBlockId(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const maybeNumber = Number(trimmed);
    if (Number.isFinite(maybeNumber) && String(maybeNumber) === trimmed) {
      return maybeNumber;
    }
    return trimmed;
  }
  return null;
}

function normalizeBlockRecord(record, fallback = {}) {
  if (!record || typeof record !== 'object') return null;
  const copy = deepClone(record);
  const fallbackId = fallback.blockId ?? fallback.id ?? fallback.block ?? null;
  const normalizedId = coerceBlockId(copy.blockId ?? fallbackId);
  if (normalizedId == null) return null;
  copy.blockId = normalizedId;
  if (Array.isArray(copy.lectures)) delete copy.lectures;
  return copy;
}

function normalizeLectureReference(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const blockId = coerceBlockId(ref.blockId ?? ref.block ?? null);
  const lectureIdRaw = ref.id ?? ref.lectureId ?? ref.key ?? null;
  if (lectureIdRaw == null) return null;
  const lectureIdNumber = Number(lectureIdRaw);
  const lectureId = Number.isFinite(lectureIdNumber) && `${lectureIdNumber}` === `${lectureIdRaw}`
    ? lectureIdNumber
    : lectureIdRaw;
  return {
    blockId,
    id: lectureId,
    name: typeof ref.name === 'string' ? ref.name : '',
    week: ref.week ?? ref.weekNumber ?? null
  };
}

function normalizeItemRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const copy = deepClone(item);
  if (copy.id == null || copy.id === '') {
    copy.id = copy.uid || uid();
  }
  copy.kind = typeof copy.kind === 'string' && copy.kind ? copy.kind : 'concept';
  copy.blocks = Array.isArray(copy.blocks)
    ? Array.from(new Set(
        copy.blocks
          .map(coerceBlockId)
          .filter(id => id != null)
      ))
    : [];
  copy.weeks = Array.isArray(copy.weeks)
    ? Array.from(new Set(
        copy.weeks
          .map(week => {
            const num = Number(week);
            return Number.isFinite(num) ? num : null;
          })
          .filter(value => value != null)
      ))
    : [];
  copy.lectures = Array.isArray(copy.lectures)
    ? copy.lectures.map(normalizeLectureReference).filter(Boolean)
    : [];
  return copy;
}

export async function exportJSON(){
  const db = await openDB();
  const tx = db.transaction(TRANSACTION_STORES);
  const itemsStore = tx.objectStore('items');
  const blocksStore = tx.objectStore('blocks');
  const examsStore = tx.objectStore('exams');
  const settingsStore = tx.objectStore('settings');
  const examSessionsStore = tx.objectStore('exam_sessions');
  const studySessionsStore = tx.objectStore('study_sessions');
  const lecturesStore = tx.objectStore('lectures');

  const [
    items = [],
    blocks = [],
    exams = [],
    settingsArr = [],
    examSessions = [],
    studySessions = [],
    lectures = []
  ] = await Promise.all([
    prom(itemsStore.getAll()),
    prom(blocksStore.getAll()),
    prom(examsStore.getAll()),
    prom(settingsStore.getAll()),
    prom(examSessionsStore.getAll()),
    prom(studySessionsStore.getAll()),
    prom(lecturesStore.getAll())
  ]);

  const settings = settingsArr.find(s => s?.id === 'app') || { id:'app', dailyCount:20, theme:'dark' };
  const mapConfigEntry = settingsArr.find(s => s?.id === MAP_CONFIG_KEY);
  const mapConfig = mapConfigEntry && typeof mapConfigEntry === 'object' ? mapConfigEntry.config : null;
  const additionalSettings = settingsArr.filter(entry => {
    if (!entry || typeof entry !== 'object') return false;
    if (!entry.id || entry.id === 'app' || entry.id === MAP_CONFIG_KEY) return false;
    return true;
  });

  return {
    items,
    blocks,
    exams,
    lectures,
    examSessions,
    studySessions,
    settings,
    mapConfig,
    settingsEntries: additionalSettings
  };
}

export async function importJSON(dbDump){
  try {
    if (!dbDump || typeof dbDump !== 'object') {
      throw new Error('File is not a valid Arc export.');
    }
    const db = await openDB();
    const tx = db.transaction(TRANSACTION_STORES,'readwrite');
    const items = tx.objectStore('items');
    const blocks = tx.objectStore('blocks');
    const exams = tx.objectStore('exams');
    const settings = tx.objectStore('settings');
    const examSessions = tx.objectStore('exam_sessions');
    const studySessions = tx.objectStore('study_sessions');
    const lectures = tx.objectStore('lectures');

    await Promise.all([
      prom(items.clear()),
      prom(blocks.clear()),
      prom(exams.clear()),
      prom(settings.clear()),
      prom(examSessions.clear()),
      prom(studySessions.clear()),
      prom(lectures.clear())
    ]);

    const additionalSettings = Array.isArray(dbDump?.settingsEntries)
      ? dbDump.settingsEntries.filter(entry => entry && typeof entry === 'object' && entry.id && entry.id !== 'app')
      : [];

    if (dbDump?.settings && typeof dbDump.settings === 'object') {
      await prom(settings.put({ ...dbDump.settings, id:'app' }));
    } else {
      await prom(settings.put({ id:'app', dailyCount:20, theme:'dark' }));
    }
    if (dbDump?.mapConfig && typeof dbDump.mapConfig === 'object') {
      await prom(settings.put({ id: MAP_CONFIG_KEY, config: dbDump.mapConfig }));
    }
    for (const entry of additionalSettings) {
      await prom(settings.put(entry));
    }
    const lectureRecords = new Map();
    const addLectureRecord = (record, { preferExisting = false } = {}) => {
      if (!record || typeof record !== 'object') return;
      const blockId = coerceBlockId(record.blockId ?? record.block ?? null);
      const lectureIdRaw = record.id ?? record.lectureId ?? null;
      if (lectureIdRaw == null) return;
      const lectureIdNumber = Number(lectureIdRaw);
      const lectureId = Number.isFinite(lectureIdNumber) && `${lectureIdNumber}` === `${lectureIdRaw}`
        ? lectureIdNumber
        : lectureIdRaw;
      if (blockId == null || lectureId == null) return;
      const key = record.key || lectureKey(blockId, lectureId);
      if (!key) return;
      if (preferExisting && lectureRecords.has(key)) return;
      const payload = deepClone({ ...record, key, blockId, id: lectureId });
      lectureRecords.set(key, payload);
    };

    if (Array.isArray(dbDump?.lectures)) {
      for (const lecture of dbDump.lectures) {
        addLectureRecord(lecture);
      }
    }

    const migrationTimestamp = Date.now();
    if (Array.isArray(dbDump?.blocks)) {
      for (const b of dbDump.blocks) {
        if (!b || typeof b !== 'object') continue;
        const { lectures: legacyLectures, ...rest } = b;
        const blockRecord = normalizeBlockRecord(rest, b);
        if (!blockRecord) continue;
        await prom(blocks.put(blockRecord));
        if (!Array.isArray(legacyLectures) || legacyLectures.length === 0) continue;
        const blockId = blockRecord?.blockId;
        if (blockId == null) continue;
        for (const legacy of legacyLectures) {
          const normalized = normalizeLectureRecord(blockId, legacy, migrationTimestamp);
          if (!normalized) continue;
          if (typeof legacy?.createdAt === 'number' && Number.isFinite(legacy.createdAt)) {
            normalized.createdAt = legacy.createdAt;
          }
          if (typeof legacy?.updatedAt === 'number' && Number.isFinite(legacy.updatedAt)) {
            normalized.updatedAt = legacy.updatedAt;
          }
          addLectureRecord(normalized, { preferExisting: true });
        }
      }
    }

    if (lectureRecords.size) {
      for (const lecture of lectureRecords.values()) {
        await prom(lectures.put(lecture));
      }
    }

    if (Array.isArray(dbDump?.items)) {
      for (const it of dbDump.items) {
        const normalizedItem = normalizeItemRecord(it);
        if (!normalizedItem) continue;
        normalizedItem.tokens = buildTokens(normalizedItem);
        normalizedItem.searchMeta = buildSearchMeta(normalizedItem);
        await prom(items.put(normalizedItem));
      }
    }
    if (Array.isArray(dbDump?.exams)) {
      for (const ex of dbDump.exams) {
        if (!ex || typeof ex !== 'object') continue;
        await prom(exams.put(ex));
      }
    }
    if (Array.isArray(dbDump?.examSessions)) {
      for (const session of dbDump.examSessions) {
        if (!session || typeof session !== 'object') continue;
        await prom(examSessions.put(session));
      }
    }
    if (Array.isArray(dbDump?.studySessions)) {
      for (const session of dbDump.studySessions) {
        if (!session || typeof session !== 'object') continue;
        await prom(studySessions.put(session));
      }
    }

    await new Promise((resolve,reject)=>{ tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); });
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_) {}
    }
    return { ok:true, message:'Import complete' };
  } catch (e) {
    console.error('Import failed', e);
    const detail = e?.message ? `Import failed: ${e.message}` : 'Import failed';
    return { ok:false, message: detail };
  }
}

function escapeCSV(value){
  return '"' + String(value).replace(/"/g,'""') + '"';
}

export async function exportAnkiCSV(profile, cohort){
  const rows = [];
  if (profile === 'cloze') {
    const regex = /\{\{c\d+::(.*?)\}\}/g;
    for (const item of cohort) {
      const title = item.name || item.concept || '';
      for (const [key, val] of Object.entries(item)) {
        if (typeof val !== 'string') continue;
        let m;
        while ((m = regex.exec(val))) {
          const answer = m[1];
          const question = val.replace(regex, '_____');
          rows.push([question, answer, title]);
        }
      }
    }
  } else {
    const qaMap = {
      disease: [
        ['etiology','Etiology of NAME?'],
        ['pathophys','Pathophysiology of NAME?'],
        ['clinical','Clinical features of NAME?'],
        ['diagnosis','Diagnosis of NAME?'],
        ['treatment','Treatment of NAME?'],
        ['complications','Complications of NAME?']
      ],
      drug: [
        ['class','Class of NAME?'],
        ['moa','Mechanism of action of NAME?'],
        ['uses','Uses of NAME?'],
        ['sideEffects','Side effects of NAME?'],
        ['contraindications','Contraindications of NAME?']
      ],
      concept: [
        ['definition','Definition of NAME?'],
        ['mechanism','Mechanism of NAME?'],
        ['clinicalRelevance','Clinical relevance of NAME?'],
        ['example','Example of NAME?']
      ]
    };
    for (const item of cohort) {
      const title = item.name || item.concept || '';
      const mappings = qaMap[item.kind] || [];
      for (const [field, tmpl] of mappings) {
        const val = item[field];
        if (!val) continue;
        const question = tmpl.replace('NAME', title);
        rows.push([question, val, title]);
      }
    }
  }
  const csv = rows.map(r => r.map(escapeCSV).join(',')).join('\n');
  return new Blob([csv], { type:'text/csv' });
}

