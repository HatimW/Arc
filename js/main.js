import { state, setTab, setSubtab, setQuery, setFilters } from './state.js';
import { initDB, findItemsByFilter } from './storage/storage.js';
import { loadBlockCatalog } from './storage/block-catalog.js';
import { createAppShell } from './app-shell.js';

function createLazyRenderer(loader, exportName) {
  let cachedPromise;
  const load = () => {
    if (!cachedPromise) {
      cachedPromise = loader()
        .then(mod => {
          const resolved = exportName ? mod[exportName] : mod?.default;
          if (typeof resolved !== 'function') {
            throw new TypeError(`Expected ${exportName || 'default'} export to be a function`);
          }
          return resolved;
        })
        .catch(err => {
          cachedPromise = null;
          throw err;
        });
    }
    return cachedPromise;
  };
  const runner = async (...args) => {
    const fn = await load();
    return fn(...args);
  };
  runner.preload = () => load().then(() => undefined);
  return runner;
}

const renderSettings = createLazyRenderer(() => import('./ui/settings.js'), 'renderSettings');
const renderCardList = createLazyRenderer(() => import('./ui/components/cardlist.js'), 'renderCardList');
const renderCards = createLazyRenderer(() => import('./ui/components/cards.js'), 'renderCards');
const renderBuilder = createLazyRenderer(() => import('./ui/components/builder.js'), 'renderBuilder');
const renderLectures = createLazyRenderer(() => import('./ui/components/lectures.js'), 'renderLectures');
const renderFlashcards = createLazyRenderer(() => import('./ui/components/flashcards.js'), 'renderFlashcards');
const renderReview = createLazyRenderer(() => import('./ui/components/review.js'), 'renderReview');
const renderQuiz = createLazyRenderer(() => import('./ui/components/quiz.js'), 'renderQuiz');
const renderBlockMode = createLazyRenderer(() => import('./ui/components/block-mode.js'), 'renderBlockMode');
const renderBlockBoard = createLazyRenderer(() => import('./ui/components/block-board.js'), 'renderBlockBoard');
const renderExams = createLazyRenderer(() => import('./ui/components/exams.js'), 'renderExams');
const renderExamRunner = createLazyRenderer(() => import('./ui/components/exams.js'), 'renderExamRunner');
const createEntryAddControl = createLazyRenderer(() => import('./ui/components/entry-controls.js'), 'createEntryAddControl');

const { renderApp, tabs, resolveListKind } = createAppShell({
  state,
  setTab,
  setSubtab,
  setQuery,
  setFilters,
  findItemsByFilter,
  renderSettings,
  renderCardList,
  renderCards,
  renderBuilder,
  renderLectures,
  renderFlashcards,
  renderReview,
  renderQuiz,
  renderBlockMode,
  renderBlockBoard,
  renderExams,
  renderExamRunner,
  createEntryAddControl
});

async function bootstrap() {
  try {
    const performanceReady = import('./ui/performance.js');
    await initDB();
    if (typeof window === 'undefined') {
      loadBlockCatalog().catch(err => {
        console.warn('Failed to prime block catalog', err);
      });
    } else {
      const schedule = typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback.bind(window)
        : (cb) => setTimeout(cb, 200);
      schedule(() => {
        loadBlockCatalog().catch(err => {
          console.warn('Failed to prime block catalog', err);
        });
      });
    }
    await performanceReady;
    await renderApp();
    schedulePrefetch();
  } catch (err) {
    const root = document.getElementById('app');
    if (root) root.textContent = 'Failed to load app';
    console.error(err);
  }
}

function schedulePrefetch() {
  if (typeof window === 'undefined') return;
  const tasks = [
    () => renderSettings.preload(),
    () => renderCardList.preload(),
    () => renderCards.preload(),
    () => renderBuilder.preload(),
    () => renderLectures.preload(),
    () => renderFlashcards.preload(),
    () => renderReview.preload(),
    () => renderQuiz.preload(),
    () => renderBlockMode.preload(),
    () => renderBlockBoard.preload(),
    () => renderExams.preload(),
    () => renderExamRunner.preload(),
    () => createEntryAddControl.preload()
  ];
  const schedule = typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback.bind(window)
    : (cb) => setTimeout(cb, 200);
  schedule(() => {
    tasks.reduce((chain, task) => chain.then(task).catch(() => undefined), Promise.resolve());
  });
}

if (typeof window !== 'undefined' && !globalThis.__ARC_TEST__) {
  bootstrap();
}

export { renderApp, renderApp as render, tabs, resolveListKind };
