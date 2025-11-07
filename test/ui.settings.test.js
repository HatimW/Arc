import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

import { renderSettings } from '../js/ui/settings.js';
import { initDB, getSettings, listBlocks } from '../js/storage/storage.js';
import { openDB } from '../js/storage/idb.js';
import { invalidateBlockCatalog } from '../js/storage/block-catalog.js';
import { DEFAULT_REVIEW_STEPS } from '../js/review/constants.js';

async function clearStore(name) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(predicate, options = {}) {
  const { timeout = 500 } = options;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

describe('settings UI', () => {
  beforeEach(async () => {
    const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'https://example.org/' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.HTMLElement = dom.window.HTMLElement;
    global.Node = dom.window.Node;
    global.requestAnimationFrame = cb => cb();
    global.localStorage = dom.window.localStorage;
    localStorage.clear();
    globalThis.__ARC_TEST__ = true;

    await initDB();
    await clearStore('items');
    await clearStore('blocks');
    await clearStore('lectures');
    await clearStore('settings');
    await initDB();
    invalidateBlockCatalog();
  });

  it('creates a block from the add form', async () => {
    const root = document.getElementById('root');
    await renderSettings(root);

    const form = root.querySelector('.settings-block-add');
    assert.ok(form, 'add block form should render');

    const titleInput = form.querySelector('input[type="text"]');
    const weeksInput = form.querySelector('input[type="number"]');
    const colorInput = form.querySelector('input[type="color"]');
    assert.ok(titleInput && weeksInput && colorInput, 'add block inputs should exist');

    titleInput.value = 'Renal';
    weeksInput.value = '4';
    colorInput.value = '#336699';

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await waitFor(() => root.querySelectorAll('.settings-block-row').length === 1);

    const { blocks } = await listBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].title, 'Renal');
    assert.equal(blocks[0].weeks, 4);
    assert.equal(blocks[0].color, '#336699');

    const rows = root.querySelectorAll('.settings-block-row');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].textContent.includes('Renal'));
  });

  it('updates review steps through the review form', async () => {
    const root = document.getElementById('root');
    await renderSettings(root);

    const form = root.querySelector('.settings-review-form');
    assert.ok(form, 'review form should render');

    const againInput = form.querySelector('input[data-rating="again"]');
    const hardInput = form.querySelector('input[data-rating="hard"]');
    const goodInput = form.querySelector('input[data-rating="good"]');
    const easyInput = form.querySelector('input[data-rating="easy"]');
    assert.ok(againInput && hardInput && goodInput && easyInput, 'review inputs should exist');

    const againUnit = againInput.closest('.settings-review-row').querySelector('select');
    const hardUnit = hardInput.closest('.settings-review-row').querySelector('select');
    const goodUnit = goodInput.closest('.settings-review-row').querySelector('select');
    const easyUnit = easyInput.closest('.settings-review-row').querySelector('select');

    const factor = unit => ({ minutes: 1, hours: 60, days: 1440, weeks: 10080 })[unit] || 1;
    const toMinutes = (input, unitSelect) => Math.round(Number(input.value) * factor(unitSelect.value));

    assert.equal(toMinutes(againInput, againUnit), DEFAULT_REVIEW_STEPS.again);
    assert.equal(toMinutes(hardInput, hardUnit), DEFAULT_REVIEW_STEPS.hard);
    assert.equal(toMinutes(goodInput, goodUnit), DEFAULT_REVIEW_STEPS.good);
    assert.equal(toMinutes(easyInput, easyUnit), DEFAULT_REVIEW_STEPS.easy);

    againInput.value = '15';
    againUnit.value = 'minutes';
    hardInput.value = '1.5';
    hardUnit.value = 'hours';
    goodInput.value = '10';
    goodUnit.value = 'hours';
    easyInput.value = '2';
    easyUnit.value = 'days';

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      const status = root.querySelector('.settings-review-status');
      return status && !status.hidden && /saved/i.test(status.textContent);
    });

    const updated = await getSettings();
    assert.equal(updated.reviewSteps.again, 15);
    assert.equal(updated.reviewSteps.hard, 90);
    assert.equal(updated.reviewSteps.good, 600);
    assert.equal(updated.reviewSteps.easy, 2880);

    const refreshedAgainInput = form.querySelector('input[data-rating="again"]');
    const refreshedHardInput = form.querySelector('input[data-rating="hard"]');
    const refreshedGoodInput = form.querySelector('input[data-rating="good"]');
    const refreshedEasyInput = form.querySelector('input[data-rating="easy"]');
    const refreshedAgainUnit = refreshedAgainInput.closest('.settings-review-row').querySelector('select');
    const refreshedHardUnit = refreshedHardInput.closest('.settings-review-row').querySelector('select');
    const refreshedGoodUnit = refreshedGoodInput.closest('.settings-review-row').querySelector('select');
    const refreshedEasyUnit = refreshedEasyInput.closest('.settings-review-row').querySelector('select');

    assert.equal(toMinutes(refreshedAgainInput, refreshedAgainUnit), 15);
    assert.equal(toMinutes(refreshedHardInput, refreshedHardUnit), 90);
    assert.equal(toMinutes(refreshedGoodInput, refreshedGoodUnit), 600);
    assert.equal(toMinutes(refreshedEasyInput, refreshedEasyUnit), 2880);
  });

  it('prefers friendly units when displaying default review steps', async () => {
    const root = document.getElementById('root');
    await renderSettings(root);

    const form = root.querySelector('.settings-review-form');
    assert.ok(form, 'review form should render');

    const againRow = form.querySelector('input[data-rating="again"]').closest('.settings-review-row');
    const hardRow = form.querySelector('input[data-rating="hard"]').closest('.settings-review-row');
    const goodRow = form.querySelector('input[data-rating="good"]').closest('.settings-review-row');
    const easyRow = form.querySelector('input[data-rating="easy"]').closest('.settings-review-row');
    assert.ok(againRow && hardRow && goodRow && easyRow, 'all rating rows should exist');

    const valueOf = row => row.querySelector('input').value;
    const unitOf = row => row.querySelector('select').value;

    assert.equal(valueOf(againRow), '10');
    assert.equal(unitOf(againRow), 'minutes');
    assert.equal(valueOf(hardRow), '1');
    assert.equal(unitOf(hardRow), 'hours');
    assert.equal(valueOf(goodRow), '12');
    assert.equal(unitOf(goodRow), 'hours');
    assert.equal(valueOf(easyRow), '36');
    assert.equal(unitOf(easyRow), 'hours');
  });

  it('saves fractional review times based on the selected unit', async () => {
    const root = document.getElementById('root');
    await renderSettings(root);

    const form = root.querySelector('.settings-review-form');
    assert.ok(form, 'review form should render');

    const againInput = form.querySelector('input[data-rating="again"]');
    const againUnit = againInput.closest('.settings-review-row').querySelector('select');
    againInput.value = '1.5';
    againUnit.value = 'hours';

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      const status = root.querySelector('.settings-review-status');
      return status && !status.hidden && /saved/i.test(status.textContent);
    });

    const updated = await getSettings();
    assert.equal(updated.reviewSteps.again, 90);

    const refreshedAgain = form.querySelector('input[data-rating="again"]').value;
    const refreshedUnit = form.querySelector('input[data-rating="again"]').closest('.settings-review-row')
      .querySelector('select').value;
    assert.equal(refreshedAgain, '90');
    assert.equal(refreshedUnit, 'minutes');
  });
});
