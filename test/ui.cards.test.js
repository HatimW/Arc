import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';

import { renderCards, __setCardsDeps } from '../js/ui/components/cards.js';

describe('cards tab rendering', () => {
  let container;

  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.HTMLElement = dom.window.HTMLElement;
    global.Node = dom.window.Node;
    global.requestAnimationFrame = (cb) => cb();
    global.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    __setCardsDeps({});
    mock.restoreAll();
  });

  it('continues rendering when the block catalog fails to load', async () => {
    __setCardsDeps({
      loadBlockCatalog: async () => {
        throw new Error('catalog offline');
      }
    });

    const items = [
      {
        id: 'c1',
        kind: 'disease',
        name: 'Sample card',
        createdAt: 1,
        lectures: [{ blockId: 'b1', week: 1, id: 1, name: 'Intro' }]
      }
    ];

    await renderCards(container, items, () => {});

    const heroTitle = container.querySelector('.cards-hero__title');
    assert(heroTitle);
    assert.equal(heroTitle.textContent, 'Card decks');

    const blockSections = container.querySelectorAll('.card-block-section');
    assert.equal(blockSections.length, 1);
  });
});

