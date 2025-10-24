import { openDB } from './idb.js';
import { buildTokens, buildSearchMeta } from '../search.js';
import { lectureKey, normalizeLectureRecord } from './lecture-schema.js';
import { deepClone } from '../utils.js';

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
      const blockId = record.blockId ?? record.block ?? null;
      const lectureId = record.id ?? record.lectureId ?? null;
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
        await prom(blocks.put(rest));
        if (!Array.isArray(legacyLectures) || legacyLectures.length === 0) continue;
        const blockId = rest?.blockId;
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
        if (!it || typeof it !== 'object') continue;
        it.tokens = buildTokens(it);
        it.searchMeta = buildSearchMeta(it);
        await prom(items.put(it));
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
    return { ok:false, message:e.message };
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

