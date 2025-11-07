import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_REVIEW_ORDERING,
  normalizeReviewOrdering,
  orderReviewEntries
} from '../js/review/order.js';

function makeEntry(id, category) {
  return { id, category };
}

describe('review ordering helpers', () => {
  it('normalizes invalid ordering payloads to defaults', () => {
    const normalized = normalizeReviewOrdering(null);
    assert.deepEqual(normalized, DEFAULT_REVIEW_ORDERING);

    const custom = normalizeReviewOrdering({
      mode: 'prioritized',
      priorities: ['review', 'review', 'invalid', 'learning']
    });
    assert.equal(custom.mode, 'prioritized');
    assert.deepEqual(custom.priorities, ['review', 'learning']);
  });

  it('orders entries according to priority fallbacks', () => {
    const entries = [
      makeEntry('a', 'learning'),
      makeEntry('b', 'new'),
      makeEntry('c', 'review'),
      makeEntry('d', 'learning'),
      makeEntry('e', 'review')
    ];

    const ordered = orderReviewEntries(entries, {
      mode: 'prioritized',
      priorities: ['review', 'learning', 'new']
    });

    assert.deepEqual(
      ordered.map(entry => entry.id),
      ['c', 'e', 'a', 'd', 'b']
    );
  });

  it('shuffles entries when using mixed ordering', () => {
    const entries = [makeEntry('a', 'new'), makeEntry('b', 'learning'), makeEntry('c', 'review')];
    const original = entries.map(entry => entry.id);

    const originalRandom = Math.random;
    let calls = 0;
    const sequence = [0.2, 0.8, 0.1, 0.6, 0.3];
    Math.random = () => {
      const value = sequence[calls % sequence.length];
      calls += 1;
      return value;
    };

    try {
      const shuffled = orderReviewEntries(entries, { mode: 'mixed', priorities: [] });
      assert.equal(shuffled.length, entries.length);
      assert.notDeepEqual(shuffled.map(entry => entry.id), original);
      assert.deepEqual(
        shuffled.map(entry => entry.id).sort(),
        entries.map(entry => entry.id).sort()
      );
    } finally {
      Math.random = originalRandom;
    }
  });
});
