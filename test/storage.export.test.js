import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { importJSON } from '../js/storage/export.js';
import { openDB } from '../js/storage/idb.js';

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

test('importJSON migrates legacy block lecture arrays', async () => {
  await resetDatabase();
  const dump = {
    blocks: [
      {
        blockId: 'legacy-block',
        title: 'Legacy Block',
        lectures: [
          { id: 1, name: 'Legacy Intro', week: 1 }
        ],
        createdAt: 123,
        updatedAt: 456
      }
    ]
  };

  const result = await importJSON(dump);
  assert.equal(result.ok, true);

  const db = await openDB();
  const blockTx = db.transaction('blocks', 'readonly');
  const blockStore = blockTx.objectStore('blocks');
  const storedBlock = await requestToPromise(blockStore.get('legacy-block'));
  assert.ok(storedBlock, 'block should be stored during import');
  assert.ok(!Object.prototype.hasOwnProperty.call(storedBlock, 'lectures'), 'legacy lecture arrays removed from block payload');

  const lectureStore = db.transaction('lectures', 'readonly').objectStore('lectures');
  const lectures = await requestToPromise(lectureStore.getAll());
  db.close();

  assert.equal(lectures.length, 1, 'lecture migrated into dedicated store');
  const lecture = lectures[0];
  assert.equal(lecture.blockId, 'legacy-block');
  assert.equal(lecture.id, 1);
  assert.equal(lecture.name, 'Legacy Intro');
  assert.equal(lecture.week, 1);

  await resetDatabase();
});

test('importJSON prefers explicit lecture dumps over legacy arrays', async () => {
  await resetDatabase();
  const dump = {
    lectures: [
      {
        key: 'block-a|7',
        blockId: 'block-a',
        id: 7,
        name: 'Explicit Lecture',
        week: 4,
        tags: ['core'],
        passes: [
          { order: 1, label: 'Pass 1', offsetMinutes: 0, anchor: 'start', due: 123, completedAt: 0, attachments: [], action: 'review' }
        ],
        passPlan: { id: 'default', schedule: [{ order: 1, label: 'Pass 1', offsetMinutes: 0, anchor: 'start', action: 'review' }] },
        plannerDefaults: { anchorOffsets: { today: 480 }, passes: [] },
        status: { state: 'done', completedPasses: 1, lastCompletedAt: 321 },
        nextDueAt: 999,
        startAt: 111,
        createdAt: 222,
        updatedAt: 333
      }
    ],
    blocks: [
      {
        blockId: 'block-a',
        title: 'Block A',
        lectures: [
          { id: 7, name: 'Legacy Copy', week: 2 }
        ]
      }
    ]
  };

  const result = await importJSON(dump);
  assert.equal(result.ok, true);

  const db = await openDB();
  const lectureStore = db.transaction('lectures', 'readonly').objectStore('lectures');
  const lectures = await requestToPromise(lectureStore.getAll());
  db.close();

  assert.equal(lectures.length, 1);
  const lecture = lectures[0];
  assert.equal(lecture.name, 'Explicit Lecture');
  assert.equal(lecture.week, 4);
  assert.equal(lecture.status?.state, 'done');
  assert.equal(lecture.nextDueAt, 999);
  assert.equal(lecture.createdAt, 222);
  assert.equal(lecture.updatedAt, 333);
  assert.ok(Array.isArray(lecture.passes), 'passes preserved from explicit dump');
  assert.equal(lecture.passes.length, 1);
  assert.equal(lecture.passes[0].label, 'Pass 1');

  await resetDatabase();
});

test('importJSON ignores invalid exam and study session records', async () => {
  await resetDatabase();
  const dump = {
    exams: [
      { title: 'Missing id' },
      { id: 'exam-1', title: 'Valid exam' }
    ],
    examSessions: [
      { score: 75 },
      { examId: 'exam-1', progress: { correct: 10 } }
    ],
    studySessions: [
      { session: { idx: 0 } },
      { mode: 'study', session: { idx: 2 }, cohort: [{ id: 'item-1' }], metadata: { foo: 'bar' } }
    ]
  };

  const result = await importJSON(dump);
  assert.equal(result.ok, true, 'import should succeed when invalid entries are present');

  const db = await openDB();

  const examsStore = db.transaction('exams', 'readonly').objectStore('exams');
  const exams = await requestToPromise(examsStore.getAll());
  assert.equal(exams.length, 1, 'only valid exams should be stored');
  assert.equal(exams[0].id, 'exam-1');

  const examSessionsStore = db.transaction('exam_sessions', 'readonly').objectStore('exam_sessions');
  const examSessions = await requestToPromise(examSessionsStore.getAll());
  assert.equal(examSessions.length, 1, 'invalid exam sessions should be ignored');
  assert.equal(examSessions[0].examId, 'exam-1');

  const studySessionsStore = db.transaction('study_sessions', 'readonly').objectStore('study_sessions');
  const studySessions = await requestToPromise(studySessionsStore.getAll());
  assert.equal(studySessions.length, 1, 'study session without mode should be skipped');
  assert.equal(studySessions[0].mode, 'study');
  assert.deepEqual(studySessions[0].session, { idx: 2, mode: 'study' });
  assert.deepEqual(studySessions[0].cohort, [{ id: 'item-1' }]);
  assert.deepEqual(studySessions[0].metadata, { foo: 'bar' });

  db.close();
  await resetDatabase();
});
