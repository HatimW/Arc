import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { openDB } from '../js/storage/idb.js';
import {
  listLecturesByBlock,
  DEFAULT_PASS_PLAN,
  DEFAULT_LECTURE_STATUS
} from '../js/storage/lectures.js';

const DB_NAME = 'arc-db';

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function resetDatabase() {
  if (!globalThis.indexedDB) return;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function seedLegacyDatabase() {
  await resetDatabase();
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = event => {
      const db = event.target.result;
      const items = db.createObjectStore('items', { keyPath: 'id' });
      items.createIndex('by_kind', 'kind');
      items.createIndex('by_updatedAt', 'updatedAt');
      items.createIndex('by_favorite', 'favorite');
      items.createIndex('by_blocks', 'blocks', { multiEntry: true });
      items.createIndex('by_weeks', 'weeks', { multiEntry: true });
      items.createIndex('by_lecture_ids', 'lectures.id', { multiEntry: true });
      items.createIndex('by_search', 'tokens');

      const blocks = db.createObjectStore('blocks', { keyPath: 'blockId' });
      blocks.createIndex('by_title', 'title');
      blocks.createIndex('by_createdAt', 'createdAt');

      const exams = db.createObjectStore('exams', { keyPath: 'id' });
      exams.createIndex('by_createdAt', 'createdAt');

      db.createObjectStore('settings', { keyPath: 'id' });

      const examSessions = db.createObjectStore('exam_sessions', { keyPath: 'examId' });
      examSessions.createIndex('by_updatedAt', 'updatedAt');

      const studySessions = db.createObjectStore('study_sessions', { keyPath: 'mode' });
      studySessions.createIndex('by_updatedAt', 'updatedAt');

      const blockStore = event.target.transaction.objectStore('blocks');
      blockStore.put({
        blockId: 'block-1',
        title: 'Legacy Block',
        weeks: 12,
        lectures: [
          { id: 1, name: 'Intro', week: 1 },
          { id: 2, name: 'Deep dive', week: 2 }
        ],
        createdAt: 111,
        updatedAt: 222
      });
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

test('lecture migration moves embedded data into dedicated store', async () => {
  await seedLegacyDatabase();
  const db = await openDB();
  const tx = db.transaction('blocks', 'readonly');
  const blockStore = tx.objectStore('blocks');
  const migratedBlock = await requestToPromise(blockStore.get('block-1'));
  assert.ok(migratedBlock, 'block should exist after upgrade');
  assert.ok(!('lectures' in migratedBlock) || !migratedBlock.lectures || migratedBlock.lectures.length === 0,
    'legacy lecture arrays should be stripped from blocks');

  const lectures = await listLecturesByBlock('block-1');
  assert.equal(lectures.length, 2, 'lectures are migrated into dedicated store');

  const intro = lectures.find(l => l.id === 1);
  const deep = lectures.find(l => l.id === 2);
  assert.ok(intro, 'first lecture preserved');
  assert.ok(deep, 'second lecture preserved');

  assert.equal(intro.blockId, 'block-1');
  assert.equal(intro.name, 'Intro');
  assert.equal(intro.week, 1);

  assert.equal(deep.blockId, 'block-1');
  assert.equal(deep.name, 'Deep dive');
  assert.equal(deep.week, 2);

  assert.deepEqual(intro.passPlan, DEFAULT_PASS_PLAN, 'default pass plan applied');
  assert.deepEqual(intro.status, DEFAULT_LECTURE_STATUS, 'default status applied');
  assert.ok(Array.isArray(intro.passes), 'passes array initialized');
  assert.equal(intro.passes.length, DEFAULT_PASS_PLAN.schedule.length, 'passes match plan count');
  intro.passes.forEach(pass => {
    assert.ok(pass.label, 'pass label defined');
    assert.ok(Number.isFinite(pass.due), 'pass due scheduled');
    assert.equal(pass.completedAt, null, 'pass completion defaults to null');
    assert.ok(Array.isArray(pass.attachments), 'pass attachments array');
  });
  assert.ok(intro.plannerDefaults, 'planner defaults stored');
  assert.ok(Array.isArray(intro.tags), 'tags array initialized');
  assert.ok(Number.isFinite(intro.nextDueAt), 'nextDueAt scheduled');

  db.close();
});

