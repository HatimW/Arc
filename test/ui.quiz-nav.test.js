import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

import * as stateModule from '../js/state.js';
import { renderQuiz } from '../js/ui/components/quiz.js';
import { initDB } from '../js/storage/storage.js';

function makeConcept(id) {
  return {
    id,
    kind: 'concept',
    name: `Concept ${id}`,
    definition: `${id} definition`,
    mechanism: `${id} mechanism`,
    clinicalRelevance: `${id} relevance`
  };
}

describe('quiz navigation controls', () => {
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
    window.scrollTo = () => {};

    stateModule.state.quizSession = null;
    stateModule.state.study = { selectedMode: 'Quiz' };

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
  });

  it('wraps to the first card when advancing past the end', async () => {
    stateModule.state.quizSession = {
      pool: [makeConcept('a'), makeConcept('b')],
      idx: 1,
      answers: {
        1: { value: 'b', isCorrect: false, checked: true, revealed: true }
      },
      ratings: {},
      ratingBaselines: {},
      score: 0
    };

    const root = document.getElementById('root');
    await renderQuiz(root, () => {});
    await new Promise(resolve => setTimeout(resolve, 0));

    const nextBtn = root.querySelector('.quiz-controls .btn:last-child');
    assert.ok(nextBtn, 'next button renders');
    assert.equal(nextBtn.textContent, 'Next');
    assert.ok(!nextBtn.disabled, 'next button enabled for solved card');

    nextBtn.click();
    assert.equal(stateModule.state.quizSession.idx, 0, 'wraps to the first question');
  });

  it('wraps to the final card when backing up from the first question', async () => {
    stateModule.state.quizSession = {
      pool: [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      idx: 0,
      answers: {
        0: { value: 'a', isCorrect: true, checked: true, revealed: false }
      },
      ratings: {},
      ratingBaselines: {},
      score: 1
    };

    const root = document.getElementById('root');
    await renderQuiz(root, () => {});
    await new Promise(resolve => setTimeout(resolve, 0));

    const backBtn = root.querySelector('.quiz-controls .btn:first-child');
    assert.ok(backBtn, 'back button renders');
    assert.equal(backBtn.textContent, 'Back');
    assert.ok(!backBtn.disabled, 'back button stays enabled');

    backBtn.click();
    assert.equal(stateModule.state.quizSession.idx, 2, 'wraps to the final question');
  });
});
