import { state, setTab, setSubtab, setQuery } from './state.js';
import { initDB, findItemsByFilter } from './storage/storage.js';
import { loadBlockCatalog } from './storage/block-catalog.js';
import { renderSettings } from './ui/settings.js';
import { renderCardList } from './ui/components/cardlist.js';
import { renderCards } from './ui/components/cards.js';
import { renderBuilder } from './ui/components/builder.js';
import { renderLectures } from './ui/components/lectures.js';
import { renderFlashcards } from './ui/components/flashcards.js';
import { renderReview } from './ui/components/review.js';
import { renderQuiz } from './ui/components/quiz.js';
import { renderBlockMode } from './ui/components/block-mode.js';
import { renderBlockBoard } from './ui/components/block-board.js';
import { renderExams, renderExamRunner } from './ui/components/exams.js';
import { renderMap } from './ui/components/map.js';
import { createEntryAddControl } from './ui/components/entry-controls.js';
import './ui/performance.js';
import { createAppShell } from './app-shell.js';

const { renderApp, tabs, resolveListKind } = createAppShell({
  state,
  setTab,
  setSubtab,
  setQuery,
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
  renderMap,
  createEntryAddControl
});

async function bootstrap() {
  try {
    await initDB();
    try {
      await loadBlockCatalog();
    } catch (err) {
      console.warn('Failed to prime block catalog', err);
    }
    renderApp();
  } catch (err) {
    const root = document.getElementById('app');
    if (root) root.textContent = 'Failed to load app';
    console.error(err);
  }
}

if (typeof window !== 'undefined' && !globalThis.__ARC_TEST__) {
  bootstrap();
}

export { renderApp, renderApp as render, tabs, resolveListKind };
