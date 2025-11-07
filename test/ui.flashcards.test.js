import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

import * as stateModule from '../js/state.js';
import { initDB } from '../js/storage/storage.js';
import { renderFlashcards } from '../js/ui/components/flashcards.js';

function makeConcept(id, overrides = {}) {
  return {
    id,
    kind: 'concept',
    name: `Concept ${id}`,
    definition: `${id} definition`,
    mechanism: `${id} mechanism`,
    clinicalRelevance: `${id} relevance`,
    ...overrides
  };
}

describe('flashcard review UI', () => {
  let dom;

  beforeEach(async () => {
    dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'https://example.org/' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.HTMLElement = dom.window.HTMLElement;
    global.Node = dom.window.Node;
    global.NodeFilter = dom.window.NodeFilter;
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: dom.window.navigator
    });
    global.localStorage = dom.window.localStorage;
    global.requestAnimationFrame = cb => cb();
    global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    if (typeof window.scrollTo !== 'function') {
      window.scrollTo = () => {};
    }

    stateModule.state.flashSession = null;
    stateModule.state.cohort = [];
    stateModule.state.study = { selectedMode: 'Flashcards' };

    await initDB();
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.HTMLElement;
    delete global.Node;
    delete global.NodeFilter;
    delete global.navigator;
    delete global.localStorage;
    delete global.requestAnimationFrame;
    delete global.getComputedStyle;
  });

  it('reorders upcoming cards when the ordering preset changes', async () => {
    const pool = [
      { __testId: 'current', item: makeConcept('a'), sections: ['definition'], category: 'review' },
      { __testId: 'new', item: makeConcept('b'), sections: ['definition'], category: 'new' },
      { __testId: 'learning', item: makeConcept('c'), sections: ['mechanism'], category: 'learning' },
      { __testId: 'review-2', item: makeConcept('d'), sections: ['definition'], category: 'review' }
    ];

    stateModule.state.flashSession = {
      mode: 'review',
      idx: 0,
      pool: pool.map(entry => ({ ...entry })),
      ratings: {},
      ratingBaselines: {},
      reviewOrdering: { mode: 'prioritized', priorities: ['review', 'learning', 'new'] }
    };
    stateModule.state.cohort = stateModule.state.flashSession.pool.slice();

    const root = document.getElementById('root');
    await renderFlashcards(root, () => {});
    await Promise.resolve();
    await Promise.resolve();

    const select = root.querySelector('.flashcard-ordering-select');
    assert.ok(select, 'ordering select renders');
    select.value = 'learning-review-new';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const session = stateModule.state.flashSession;
    assert.ok(session, 'session should persist after reordering');
    assert.equal(session.reviewOrdering.mode, 'prioritized');
    assert.deepEqual(session.reviewOrdering.priorities, ['learning', 'review', 'new']);
    assert.deepEqual(
      session.pool.map(entry => entry.__testId),
      ['current', 'learning', 'review-2', 'new']
    );

    const previewNodes = root.querySelectorAll('.flash-rating-preview');
    assert.ok(previewNodes.length >= 4, 'rating previews render for each rating button');
  });

  it('shows a finish button that clears the review session explicitly', async () => {
    const pool = [
      { __testId: 'first', item: makeConcept('p'), sections: ['definition'], category: 'review' },
      { __testId: 'second', item: makeConcept('q'), sections: ['mechanism'], category: 'learning' }
    ];

    stateModule.state.flashSession = {
      mode: 'review',
      idx: pool.length - 1,
      pool: pool.map(entry => ({ ...entry })),
      ratings: {},
      ratingBaselines: {},
      reviewOrdering: { mode: 'prioritized', priorities: ['review', 'learning', 'new'] }
    };
    stateModule.state.cohort = stateModule.state.flashSession.pool.slice();

    const root = document.getElementById('root');
    await renderFlashcards(root, () => {});
    await Promise.resolve();
    await Promise.resolve();

    const nextBtn = root.querySelector('.flash-controls .btn:nth-child(2)');
    assert.ok(nextBtn, 'next button renders');
    assert.equal(nextBtn.textContent, 'Next');
    assert.ok(nextBtn.disabled, 'next button is disabled on the last review card');

    const finishBtn = root.querySelector('.flash-finish-btn');
    assert.ok(finishBtn, 'finish button renders in review mode');
    finishBtn.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(stateModule.state.flashSession, null, 'active review session cleared');
    assert.equal(stateModule.state.study.selectedMode, 'Flashcards');
    assert.equal(stateModule.state.subtab.Study, 'Review');
  });
});
