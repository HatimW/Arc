import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rateSection,
  collectDueSections,
  collectUpcomingSections,
  getSectionStateSnapshot,
  suspendSection,
  retireSection
} from '../js/review/scheduler.js';
import { DEFAULT_REVIEW_STEPS } from '../js/review/constants.js';

const baseDurations = {
  ...DEFAULT_REVIEW_STEPS,
  again: 5,
  hard: 10,
  good: 60,
  easy: 120,
  learningSteps: [5, 10],
  relearningSteps: [5],
  graduatingGood: 30,
  graduatingEasy: 60,
  intervalModifier: 1,
  hardIntervalMultiplier: 1.5,
  easyIntervalBonus: 2,
  lapseIntervalMultiplier: 0.5,
  easeBonus: 0.2,
  easePenalty: 0.3,
  hardEasePenalty: 0.1
};

function approxEqual(actual, expected, tolerance = 1_500) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} ≈ ${expected}`);
}

function createItem({ id, kind = 'disease', fields = {}, sr = null, lectures = [] }) {
  return {
    id,
    kind,
    name: id,
    etiology: '',
    pathophys: '',
    clinical: '',
    diagnosis: '',
    treatment: '',
    complications: '',
    mnemonic: '',
    ...fields,
    sr: sr || { version: 2, sections: {} },
    blocks: [],
    lectures
  };
}

test('rateSection transitions through learning, review, and relearning phases', () => {
  const item = createItem({ id: 'alpha' });
  const now = Date.now();

  let state = rateSection(item, 'etiology', 'again', baseDurations, now);
  assert.equal(state.phase, 'learning');
  assert.equal(state.learningStepIndex, 0);
  approxEqual(state.due, now + baseDurations.learningSteps[0] * 60 * 1000);

  const firstStep = now + 1_000;
  state = rateSection(item, 'etiology', 'good', baseDurations, firstStep);
  assert.equal(state.phase, 'learning');
  assert.equal(state.learningStepIndex, 1);
  approxEqual(state.due, firstStep + baseDurations.learningSteps[1] * 60 * 1000);

  const graduateAt = firstStep + 1_000;
  state = rateSection(item, 'etiology', 'good', baseDurations, graduateAt);
  assert.equal(state.phase, 'review');
  assert.equal(state.learningStepIndex, 0);
  assert.equal(state.interval, baseDurations.graduatingGood);
  approxEqual(state.due, graduateAt + baseDurations.graduatingGood * 60 * 1000);

  const easyAt = graduateAt + 1_000;
  const beforeEase = state.ease;
  state = rateSection(item, 'etiology', 'easy', baseDurations, easyAt);
  assert.equal(state.phase, 'review');
  assert.ok(state.interval > baseDurations.graduatingGood);
  assert.ok(state.ease > beforeEase);

  const relapseAt = easyAt + 1_000;
  const relapsed = rateSection(item, 'etiology', 'again', baseDurations, relapseAt);
  assert.equal(relapsed.phase, 'relearning');
  assert.equal(relapsed.lapses >= 1, true);
  approxEqual(relapsed.due, relapseAt + baseDurations.relearningSteps[0] * 60 * 1000);

  const pendingInterval = relapsed.pendingInterval;
  const recoverAt = relapseAt + 1_000;
  state = rateSection(item, 'etiology', 'good', baseDurations, recoverAt);
  assert.equal(state.phase, 'review');
  assert.equal(state.pendingInterval, 0);
  assert.equal(state.interval, Math.max(1, Math.round(pendingInterval * baseDurations.intervalModifier)));
});

test('retiring and suspending cards remove them from review queues', () => {
  const now = Date.now();
  const item = createItem({ id: 'retire-test' });
  const active = rateSection(item, 'etiology', 'good', baseDurations, now);
  assert.equal(active.retired, false);
  const retired = retireSection(item, 'etiology', now + 500);
  assert.equal(retired.retired, true);
  assert.equal(retired.due, Number.MAX_SAFE_INTEGER);
  assert.equal(retired.interval, 0);
  assert.equal(retired.phase, 'new');

  const restarted = rateSection(item, 'etiology', 'good', baseDurations, now + 1_000);
  assert.equal(restarted.retired, false);
  assert.equal(restarted.phase, 'learning');

  const suspendedItem = createItem({
    id: 'suspend-test',
    sr: {
      version: 2,
      sections: {
        etiology: { last: now - 10_000, due: now - 5_000, retired: false }
      }
    }
  });
  suspendSection(suspendedItem, 'etiology', now);

  const due = collectDueSections([item, suspendedItem], { now: now + 2_000 });
  assert.equal(due.length, 0);
});

test('collectDueSections and collectUpcomingSections respect state metadata', () => {
  const now = Date.now();
  const overdue = createItem({
    id: 'due-1',
    fields: { etiology: '<p>due</p>' },
    sr: {
      version: 2,
      sections: {
        etiology: { last: now - 10_000, due: now - 1_000, retired: false }
      }
    }
  });
  const soon = createItem({
    id: 'soon-1',
    fields: { etiology: '<p>soon</p>' },
    sr: {
      version: 2,
      sections: {
        etiology: { last: now - 5_000, due: now + 5 * 60_000, retired: false, phase: 'review' }
      }
    }
  });
  const later = createItem({
    id: 'later-1',
    fields: { etiology: '<p>later</p>' },
    sr: {
      version: 2,
      sections: {
        etiology: { last: now - 5_000, due: now + 60 * 60_000, retired: false, phase: 'review' }
      }
    }
  });

  const dueEntries = collectDueSections([overdue, soon, later], { now });
  assert.equal(dueEntries.length, 1);
  assert.equal(dueEntries[0].itemId, 'due-1');

  const upcoming = collectUpcomingSections([overdue, soon, later], { now });
  assert.equal(upcoming.length, 2);
  assert.equal(upcoming[0].itemId, 'soon-1');
  assert.equal(upcoming[1].itemId, 'later-1');
  assert.equal(upcoming[0].phase, 'review');
});

test('content changes reset scheduling metadata', () => {
  const now = Date.now();
  const item = createItem({
    id: 'update-card',
    fields: { etiology: '<p>first</p>' },
    lectures: [{ blockId: 'renal', id: 5 }]
  });
  rateSection(item, 'etiology', 'good', baseDurations, now);
  item.etiology = '<p>second</p>';
  const snapshot = getSectionStateSnapshot(item, 'etiology');
  assert.equal(snapshot.lastRating, null);
  assert.equal(snapshot.phase, 'new');
  assert.equal(snapshot.learningStepIndex, 0);
  assert.equal(snapshot.suspended, false);
  assert.equal(snapshot.lapses, 0);
  assert.equal(snapshot.ease, DEFAULT_REVIEW_STEPS.startingEase);
  const dueEntries = collectDueSections([item], { now: Date.now() + 100 });
  assert.equal(dueEntries.length, 1);
});

test('removing a lecture resets ratings but additions maintain scope', () => {
  const now = Date.now();
  const item = createItem({
    id: 'lecture-move',
    fields: { etiology: '<p>stable</p>' },
    lectures: [{ blockId: 'heme', id: 1 }]
  });
  rateSection(item, 'etiology', 'good', baseDurations, now);

  item.lectures = [{ blockId: 'heme', id: 1 }, { blockId: 'heme', id: 2 }];
  const snapshotAdd = getSectionStateSnapshot(item, 'etiology');
  assert.equal(snapshotAdd.lastRating, 'good');
  assert.deepEqual(snapshotAdd.lectureScope, ['heme|1', 'heme|2']);

  item.lectures = [{ blockId: 'heme', id: 2 }];
  const snapshotRemoved = getSectionStateSnapshot(item, 'etiology');
  assert.equal(snapshotRemoved.lastRating, null);
  assert.equal(snapshotRemoved.phase, 'new');
});
