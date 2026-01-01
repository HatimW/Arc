import { listExams, upsertExam, deleteExam, listExamSessions, loadExamSession, saveExamSessionProgress, deleteExamSessionProgress } from '../../storage/storage.js';
import { state, setExamSession, setExamAttemptExpanded, setExamLayout, setSubtab } from '../../state.js';
import { uid, setToggleState, deepClone, resolveLatestBlockId } from '../../utils.js';
import { confirmModal } from './confirm.js';
import { createRichTextEditor, sanitizeHtml, htmlToPlainText, isEmptyHtml } from './rich-text.js';
import { readFileAsDataUrl } from './media-upload.js';
import { createFloatingWindow } from './window-manager.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';

const DEFAULT_SECONDS = 60;
const CSV_TEMPLATE_MIN_OPTIONS = 12;
const CSV_BASE_HEADERS = ['type', 'examTitle', 'timerMode', 'secondsPerQuestion', 'stem'];
const CSV_ROW_META = 'meta';
const CSV_ROW_QUESTION = 'question';
const QBANK_EXAM_ID = '__qbank__';
const QBANK_DEFAULT_COUNT = 20;

const qbankSelectionState = {
  blockId: '',
  week: '',
  selectedBlocks: new Set(),
  selectedWeeks: new Set(),
  selectedLectures: new Set(),
  questionCount: QBANK_DEFAULT_COUNT,
  includeUntagged: false,
  includeAnswered: false,
  answeredFilters: {
    incorrect: false,
    correct: false,
    flagged: false
  }
};

function csvOptionIndex(optionNumber) {
  return 5 + (optionNumber - 1) * 2;
}

function csvOptionCorrectIndex(optionNumber) {
  return csvOptionIndex(optionNumber) + 1;
}

function buildCsvHeaders(maxOptions) {
  const base = [...CSV_BASE_HEADERS];
  for (let i = 1; i <= maxOptions; i += 1) {
    base.push(`option${i}`);
    base.push(`option${i}Correct`);
  }
  base.push('explanation', 'tags', 'media');
  return base;
}

function getCsvMaxOptionsFromExam(exam) {
  const questions = Array.isArray(exam?.questions) ? exam.questions : [];
  const max = questions.reduce((current, question) => {
    const options = Array.isArray(question?.options) ? question.options.length : 0;
    return Math.max(current, options);
  }, 0);
  return Math.max(CSV_TEMPLATE_MIN_OPTIONS, max);
}

function getCsvHeaderIndexes(headers) {
  return {
    explanationIndex: headers.indexOf('explanation'),
    tagsIndex: headers.indexOf('tags'),
    mediaIndex: headers.indexOf('media')
  };
}

function getCsvMaxOptionsFromHeader(header) {
  return header.reduce((max, name) => {
    const match = /^option(\d+)(correct)?$/i.exec(String(name || '').trim());
    if (!match) return max;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return max;
    return Math.max(max, value);
  }, 0);
}

const timerHandles = new WeakMap();
let keyHandler = null;
let keyHandlerSession = null;
let lastExamStatusMessage = '';
let examViewScrollTop = 0;

function sanitizeRichText(value) {
  const raw = value == null ? '' : String(value);
  if (!raw) return '';
  const looksHtml = /<([a-z][^>]*>)/i.test(raw);
  const normalized = looksHtml ? raw : raw.replace(/\r?\n/g, '<br>');
  const sanitized = sanitizeHtml(normalized);
  return isEmptyHtml(sanitized) ? '' : sanitized;
}

function ensureArrayTags(tags) {
  if (!Array.isArray(tags)) {
    if (tags == null) return [];
    if (typeof tags === 'string') {
      return tags.split(/[|,]/).map(tag => tag.trim()).filter(Boolean);
    }
    return [];
  }
  return tags.map(tag => String(tag).trim()).filter(Boolean);
}

function normalizeLectureRefs(lectures) {
  if (!Array.isArray(lectures)) return [];
  const seen = new Set();
  return lectures.map(ref => {
    if (!ref || ref.blockId == null || ref.id == null) return null;
    const blockId = String(ref.blockId).trim();
    const id = Number(ref.id);
    if (!blockId || !Number.isFinite(id)) return null;
    const key = `${blockId}|${id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const name = ref.name != null ? String(ref.name) : '';
    const week = Number.isFinite(Number(ref.week)) ? Number(ref.week) : null;
    return { blockId, id, name, week };
  }).filter(Boolean);
}

function parseTagString(tags) {
  if (!tags) return [];
  return String(tags).split(/[|,]/).map(tag => tag.trim()).filter(Boolean);
}

function resolveDefaultBlockId(catalog) {
  const blocks = Array.isArray(catalog?.blocks) ? catalog.blocks : [];
  const latestBlockId = resolveLatestBlockId(blocks);
  if (latestBlockId) return String(latestBlockId);
  const candidate = state.builder?.activeBlockId
    || state.lectures?.blockId
    || state.filters?.block
    || state.listFilters?.block
    || '';
  if (!candidate) return '';
  const value = String(candidate);
  const found = blocks.some(block => String(block.blockId ?? block.id ?? '') === value);
  return found ? value : '';
}

function qbankSignatureFor(exams) {
  return exams
    .map(exam => `${exam.id}:${exam.updatedAt || 0}:${exam.questions.length}`)
    .join('|');
}

function buildQBankExam(exams, existing) {
  const base = ensureExamShape(existing || {
    id: QBANK_EXAM_ID,
    examTitle: 'QBank',
    timerMode: 'untimed',
    secondsPerQuestion: DEFAULT_SECONDS,
    questions: [],
    results: []
  }).exam;
  const questions = [];
  exams.forEach(exam => {
    (exam.questions || []).forEach(question => {
      const cloned = clone(question);
      cloned.originalIndex = questions.length;
      cloned.sourceExamId = exam.id;
      cloned.sourceExamTitle = exam.examTitle;
      questions.push(cloned);
    });
  });
  return {
    ...base,
    id: QBANK_EXAM_ID,
    examTitle: 'QBank',
    timerMode: 'untimed',
    secondsPerQuestion: DEFAULT_SECONDS,
    questions
  };
}

function shuffleIndices(indices) {
  const list = [...indices];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function qbankMatchesSelection(question, selection) {
  const selectedBlocks = selection.selectedBlocks;
  const selectedWeeks = selection.selectedWeeks;
  const selectedLectures = selection.selectedLectures;
  const hasAnySelection = selectedBlocks.size || selectedWeeks.size || selectedLectures.size;
  if (!hasAnySelection) return true;
  const lectures = normalizeLectureRefs(question.lectures);
  if (!lectures.length) return Boolean(selection.includeUntagged);
  return lectures.some(ref => {
    const blockId = String(ref.blockId ?? '');
    const lectureKey = `${blockId}|${ref.id}`;
    const weekKey = ref.week != null ? `${blockId}|${ref.week}` : '';
    return selectedLectures.has(lectureKey)
      || (blockId && selectedBlocks.has(blockId))
      || (weekKey && selectedWeeks.has(weekKey));
  });
}

function qbankKeyForQuestion(question, fallbackExamId = '') {
  if (!question) return '';
  const examId = question.sourceExamId || fallbackExamId;
  const questionId = question.id;
  if (!examId || !questionId) return '';
  return `${examId}|${questionId}`;
}

function buildQBankAnswerHistory(exams, qbankExam) {
  const history = new Map();
  const ensure = key => {
    if (!history.has(key)) {
      history.set(key, {
        answered: false,
        correct: false,
        incorrect: false,
        flagged: false
      });
    }
    return history.get(key);
  };
  const ingestResultAnswers = (exam, result, resolveKey) => {
    if (!result || !exam) return;
    const answers = result.answers || {};
    Object.entries(answers).forEach(([idxKey, value]) => {
      const idx = Number(idxKey);
      if (!Number.isFinite(idx)) return;
      const question = exam.questions?.[idx];
      if (!question) return;
      const key = resolveKey(question);
      if (!key) return;
      const entry = ensure(key);
      entry.answered = true;
      if (value === question.answer) {
        entry.correct = true;
      } else {
        entry.incorrect = true;
      }
    });
    if (Array.isArray(result.flagged)) {
      result.flagged.forEach(flagIdx => {
        const idx = Number(flagIdx);
        if (!Number.isFinite(idx)) return;
        const question = exam.questions?.[idx];
        if (!question) return;
        const key = resolveKey(question);
        if (!key) return;
        const entry = ensure(key);
        entry.flagged = true;
      });
    }
  };
  exams.forEach(exam => {
    const resolveKey = question => qbankKeyForQuestion(question, exam.id);
    (exam.results || []).forEach(result => {
      ingestResultAnswers(exam, result, resolveKey);
    });
  });
  if (qbankExam) {
    const resolveKey = question => qbankKeyForQuestion(question, question.sourceExamId || qbankExam.id);
    (qbankExam.results || []).forEach(result => {
      ingestResultAnswers(qbankExam, result, resolveKey);
    });
  }
  return history;
}

function parseBooleanFlag(value) {
  if (value == null) return false;
  const str = String(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'correct'].includes(str);
}

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  if (!str) return '';
  if (/["]/.test(str) || /[\n\r,]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function scorePercentage(result) {
  if (!result || !Number.isFinite(result.correct) || !Number.isFinite(result.total) || result.total <= 0) {
    return null;
  }
  return Math.round((result.correct / result.total) * 100);
}

function scoreBadgeClass(pct) {
  if (!Number.isFinite(pct)) return 'neutral';
  if (pct >= 85) return 'good';
  if (pct >= 70) return 'warn';
  return 'bad';
}

function createScoreBadge(result, label) {
  const pct = scorePercentage(result);
  const badge = document.createElement('span');
  badge.className = ['exam-score-badge', `exam-score-badge--${scoreBadgeClass(pct)}`].join(' ');
  if (label) {
    const labelEl = document.createElement('span');
    labelEl.className = 'exam-score-badge-label';
    labelEl.textContent = label;
    badge.appendChild(labelEl);
  }
  const value = document.createElement('span');
  value.className = 'exam-score-badge-value';
  if (pct == null) {
    value.textContent = '—';
  } else {
    value.textContent = `${pct}%`;
  }
  badge.appendChild(value);
  return badge;
}

function setTimerElement(sess, element) {
  if (!sess) return;
  sess.__timerElement = element || null;
  if (element) {
    updateTimerElement(sess);
  }
}

function updateTimerElement(sess) {
  if (!sess) return;
  const el = sess.__timerElement;
  if (!el) return;
  const remaining = typeof sess.remainingMs === 'number'
    ? Math.max(0, sess.remainingMs)
    : totalExamTimeMs(sess.exam);
  el.textContent = formatCountdown(remaining);
}

function ensureQuestionStats(sess) {
  const questionCount = sess?.exam?.questions?.length || 0;
  if (!sess) return;
  if (!Array.isArray(sess.questionStats)) {
    sess.questionStats = Array.from({ length: questionCount }, () => ({
      timeMs: 0,
      changes: [],
      enteredAt: null,
      initialAnswer: null,
      initialAnswerAt: null
    }));
    return;
  }
  if (sess.questionStats.length !== questionCount) {
    const next = Array.from({ length: questionCount }, (_, idx) => {
      const prev = sess.questionStats[idx] || {};
      return {
        timeMs: Number.isFinite(prev.timeMs) ? prev.timeMs : 0,
        changes: Array.isArray(prev.changes) ? [...prev.changes] : [],
        enteredAt: null,
        initialAnswer: prev.initialAnswer ?? null,
        initialAnswerAt: prev.initialAnswerAt ?? null
      };
    });
    sess.questionStats = next;
    return;
  }
  sess.questionStats.forEach(stat => {
    if (!stat) return;
    if (!Array.isArray(stat.changes)) stat.changes = [];
    if (!Number.isFinite(stat.timeMs)) stat.timeMs = 0;
    if (stat.enteredAt == null) stat.enteredAt = null;
    if (!('initialAnswer' in stat)) stat.initialAnswer = null;
    if (!('initialAnswerAt' in stat)) stat.initialAnswerAt = null;
  });
}

function beginQuestionTiming(sess, idx) {
  if (!sess || sess.mode !== 'taking') return;
  ensureQuestionStats(sess);
  const stat = sess.questionStats?.[idx];
  if (!stat) return;
  if (stat.enteredAt == null) {
    stat.enteredAt = Date.now();
  }
}

function finalizeQuestionTiming(sess, idx) {
  if (!sess || sess.mode !== 'taking') return;
  ensureQuestionStats(sess);
  const stat = sess.questionStats?.[idx];
  if (!stat || stat.enteredAt == null) return;
  const now = Date.now();
  const delta = Math.max(0, now - stat.enteredAt);
  stat.timeMs = (Number.isFinite(stat.timeMs) ? stat.timeMs : 0) + delta;
  stat.enteredAt = null;
}

function finalizeActiveQuestionTiming(sess) {
  if (!sess || typeof sess.idx !== 'number') return;
  finalizeQuestionTiming(sess, sess.idx);
}

function ensureScrollPositions(sess) {
  if (!sess) return;
  if (!sess.scrollPositions || typeof sess.scrollPositions !== 'object') {
    sess.scrollPositions = {};
  }
}

function captureExamScroll(sess) {
  if (!sess || typeof sess.idx !== 'number') return;
  const scroller = resolveScrollContainer();
  if (!scroller) return;
  const scrollPos = readScrollPosition(scroller);
  storeScrollPosition(sess, sess.idx, scrollPos);
  sess.__lastKnownScrollY = scrollPos;
  sess.__pendingScrollRestore = true;
  captureExamMediaState(sess);
}

function resolveScrollContainer(root) {
  const hasDocument = typeof document !== 'undefined';
  if (root) {
    if (typeof root.querySelector === 'function') {
      const main = root.querySelector('.exam-main');
      if (main) return main;
      const runner = root.querySelector('.exam-runner');
      if (runner) return runner;
    }
    if (root.classList?.contains('exam-view') || root.classList?.contains('exam-session') || root.classList?.contains('exam-qbank-view')) {
      return root;
    }
    if (typeof root.closest === 'function') {
      const scoped = root.closest('.tab-content');
      if (scoped) return scoped;
    }
  }
  if (hasDocument) {
    const main = document.querySelector('.exam-session .exam-main');
    if (main) return main;
    const runner = document.querySelector('.exam-session .exam-runner');
    if (runner) return runner;
    const view = document.querySelector('.exam-view');
    if (view) return view;
    const mainElement = document.querySelector('main');
    if (mainElement) return mainElement;
  }
  if (typeof window !== 'undefined') return window;
  return null;
}

function isWindowScroller(scroller) {
  return typeof window !== 'undefined' && scroller === window;
}

function readScrollPosition(scroller) {
  if (!scroller) return 0;
  if (isWindowScroller(scroller)) {
    return window.scrollY || window.pageYOffset || 0;
  }
  return scroller.scrollTop || 0;
}

function applyScrollPosition(scroller, value) {
  if (!scroller) return;
  const top = Number.isFinite(value) ? value : 0;
  if (isWindowScroller(scroller)) {
    if (typeof window.scrollTo === 'function') {
      window.scrollTo({ left: 0, top, behavior: 'auto' });
    }
    return;
  }
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ left: 0, top, behavior: 'auto' });
  } else {
    scroller.scrollTop = top;
  }
}

function captureExamMediaState(sess) {
  if (!sess || typeof sess.idx !== 'number' || typeof document === 'undefined') return;
  const container = document.querySelector('.exam-main');
  if (!container) return;
  const media = container.querySelector('video, audio');
  if (!media) return;
  if (!sess.mediaState || typeof sess.mediaState !== 'object') {
    sess.mediaState = {};
  }
  sess.mediaState[sess.idx] = {
    currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0,
    paused: media.paused,
    src: media.currentSrc || media.src || ''
  };
}

function restoreExamMediaState(sess, container) {
  if (!sess || typeof sess.idx !== 'number' || !container) return;
  const state = sess.mediaState?.[sess.idx];
  if (!state) return;
  const media = container.querySelector('video, audio');
  if (!media) return;
  const currentSrc = media.currentSrc || media.src || '';
  if (state.src && currentSrc && state.src !== currentSrc) return;
  if (Number.isFinite(state.currentTime)) {
    try {
      const duration = Number.isFinite(media.duration) ? media.duration : null;
      const targetTime = duration != null ? Math.min(state.currentTime, duration) : state.currentTime;
      media.currentTime = Math.max(0, targetTime);
    } catch (err) {
      console.warn('Failed to restore media time', err);
    }
  }
  if (state.paused === false && typeof media.play === 'function') {
    const playPromise = media.play();
    if (playPromise?.catch) {
      playPromise.catch(() => {});
    }
  }
}

function storeScrollPosition(sess, idx, value) {
  if (!sess || typeof idx !== 'number') return;
  ensureScrollPositions(sess);
  const numeric = Number.isFinite(value) ? value : 0;
  sess.scrollPositions[idx] = numeric;
}

function getStoredScroll(sess, idx) {
  if (!sess || typeof idx !== 'number') return null;
  const store = sess.scrollPositions;
  if (!store || typeof store !== 'object') return null;
  const value = store[idx];
  return Number.isFinite(value) ? value : null;
}

function navigateToQuestion(sess, nextIdx, render) {
  if (!sess || typeof nextIdx !== 'number') return;
  const total = sess.exam?.questions?.length || 0;
  if (!total) return;
  const clamped = Math.min(Math.max(nextIdx, 0), Math.max(0, total - 1));
  if (clamped === sess.idx) return;
  if (typeof sess.idx === 'number') {
    const scroller = resolveScrollContainer();
    const scrollPos = readScrollPosition(scroller);
    storeScrollPosition(sess, sess.idx, scrollPos);
    captureExamMediaState(sess);
  }
  if (sess.mode === 'taking') {
    finalizeActiveQuestionTiming(sess);
  }
  sess.idx = clamped;
  if (sess.mode === 'taking') {
    beginQuestionTiming(sess, clamped);
  }
  render();
}

function recordAnswerChange(sess, idx, question, nextAnswer) {
  if (!sess || sess.mode !== 'taking') return;
  ensureQuestionStats(sess);
  const stat = sess.questionStats?.[idx];
  if (!stat) return;
  const prev = sess.answers?.[idx];
  if (prev === nextAnswer) return;
  if (prev == null) {
    if (nextAnswer != null && stat.initialAnswer == null) {
      stat.initialAnswer = nextAnswer;
      stat.initialAnswerAt = Date.now();
    }
    return;
  }
  const change = {
    at: Date.now(),
    from: prev ?? null,
    to: nextAnswer ?? null
  };
  if (prev != null) change.fromCorrect = prev === question.answer;
  if (nextAnswer != null) change.toCorrect = nextAnswer === question.answer;
  if (!Array.isArray(stat.changes)) stat.changes = [];
  stat.changes.push(change);
}

function snapshotQuestionStats(sess) {
  ensureQuestionStats(sess);
  return (sess.questionStats || []).map(stat => ({
    timeMs: Number.isFinite(stat?.timeMs) ? stat.timeMs : 0,
    changes: Array.isArray(stat?.changes) ? stat.changes.map(change => ({ ...change })) : [],
    initialAnswer: stat?.initialAnswer ?? null,
    initialAnswerAt: stat?.initialAnswerAt ?? null
  }));
}

function extractAnswerSequence(stat, finalAnswer) {
  const sequence = [];
  const push = value => {
    if (value == null) return;
    if (sequence[sequence.length - 1] === value) return;
    sequence.push(value);
  };

  if (stat && stat.initialAnswer != null) {
    push(stat.initialAnswer);
  }

  const changes = Array.isArray(stat?.changes) ? stat.changes : [];
  changes.forEach(change => {
    if (!change) return;
    if (change.to != null) push(change.to);
  });

  if (finalAnswer != null) {
    push(finalAnswer);
  }

  return sequence;
}

function analyzeAnswerChange(stat, question, finalAnswer) {
  if (!question) {
    return {
      initialAnswer: null,
      finalAnswer: null,
      initialCorrect: null,
      finalCorrect: null,
      changed: false,
      direction: null,
      switched: false,
      sequence: []
    };
  }

  const answerId = question.answer;
  const sequence = extractAnswerSequence(stat, finalAnswer);
  const initialAnswer = sequence.length ? sequence[0] : (stat?.initialAnswer ?? null);
  const resolvedFinalAnswer = sequence.length ? sequence[sequence.length - 1] : (finalAnswer ?? null);

  const initialCorrect = initialAnswer != null ? initialAnswer === answerId : null;
  const finalCorrect = resolvedFinalAnswer != null ? resolvedFinalAnswer === answerId : null;

  const switched = sequence.length > 1;
  const changed = switched && initialAnswer != null && resolvedFinalAnswer != null && initialAnswer !== resolvedFinalAnswer;

  let direction = null;
  if (changed) {
    if (initialCorrect === true && finalCorrect === false) {
      direction = 'right-to-wrong';
    } else if (initialCorrect === false && finalCorrect === true) {
      direction = 'wrong-to-right';
    } else {
      direction = 'neutral';
    }
  }

  return {
    initialAnswer,
    finalAnswer: resolvedFinalAnswer,
    initialCorrect,
    finalCorrect,
    changed,
    direction,
    switched,
    sequence
  };
}

function countMeaningfulAnswerChanges(stat) {
  if (!stat || !Array.isArray(stat.changes)) return 0;
  let count = 0;
  stat.changes.forEach(change => {
    if (!change) return;
    const from = change.from ?? null;
    const to = change.to ?? null;
    if (from == null) return;
    if (from === to) return;
    count += 1;
  });
  return count;
}

function summarizeAnswerChanges(questionStats, exam, answers = {}) {
  let rightToWrong = 0;
  let wrongToRight = 0;
  let switched = 0;
  let endedDifferent = 0;
  questionStats.forEach((stat, idx) => {
    const question = exam?.questions?.[idx];
    if (!question) return;
    const finalAnswer = answers[idx];
    const details = analyzeAnswerChange(stat, question, finalAnswer);
    if (details.switched) {
      switched += 1;
    }
    if (details.changed) {
      endedDifferent += 1;
      if (details.direction === 'right-to-wrong') rightToWrong += 1;
      if (details.direction === 'wrong-to-right') wrongToRight += 1;
    }
  });
  return {
    rightToWrong,
    wrongToRight,
    switched,
    endedDifferent,
    returnedToOriginal: Math.max(0, switched - endedDifferent),
    totalChanges: switched
  };
}

function clone(value) {
  return value != null ? deepClone(value) : value;
}

function totalExamTimeMs(exam) {
  const seconds = typeof exam.secondsPerQuestion === 'number' ? exam.secondsPerQuestion : DEFAULT_SECONDS;
  return seconds * (exam.questions?.length || 0) * 1000;
}

function stopTimer(sess) {
  finalizeActiveQuestionTiming(sess);
  const handle = timerHandles.get(sess);
  if (handle) {
    clearInterval(handle);
    timerHandles.delete(sess);
  }
  if (sess?.startedAt) {
    const now = Date.now();
    const delta = Math.max(0, now - sess.startedAt);
    sess.elapsedMs = (sess.elapsedMs || 0) + delta;
    if (sess.exam?.timerMode === 'timed' && typeof sess.remainingMs === 'number') {
      sess.remainingMs = Math.max(0, sess.remainingMs - delta);
    }
    sess.startedAt = null;
    updateTimerElement(sess);
  }
}

function ensureTimer(sess, render) {
  if (!sess || sess.mode !== 'taking' || sess.exam.timerMode !== 'timed') return;
  if (timerHandles.has(sess)) return;
  if (typeof sess.remainingMs !== 'number') {
    sess.remainingMs = totalExamTimeMs(sess.exam);
  }
  if (typeof sess.elapsedMs !== 'number') sess.elapsedMs = 0;
  sess.startedAt = Date.now();
  const handle = setInterval(() => {
    const now = Date.now();
    const last = sess.startedAt || now;
    const delta = Math.max(0, now - last);
    sess.startedAt = now;
    sess.elapsedMs = (sess.elapsedMs || 0) + delta;
    sess.remainingMs = Math.max(0, (sess.remainingMs ?? 0) - delta);
    if (sess.remainingMs <= 0) {
      stopTimer(sess);
      finalizeExam(sess, render, { autoSubmit: true });
    } else {
      updateTimerElement(sess);
    }
  }, 1000);
  timerHandles.set(sess, handle);
}

function teardownKeyboardNavigation() {
  if (keyHandler) {
    window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    keyHandlerSession = null;
  }
}

function setupKeyboardNavigation(sess, render) {
  if (!sess || sess.mode === 'summary') {
    teardownKeyboardNavigation();
    return;
  }
  if (keyHandler && keyHandlerSession === sess) return;
  teardownKeyboardNavigation();
  keyHandlerSession = sess;
  keyHandler = event => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    if (event.key === 'ArrowRight') {
      if (sess.idx < sess.exam.questions.length - 1) {
        event.preventDefault();
        navigateToQuestion(sess, sess.idx + 1, render);
      }
    } else if (event.key === 'ArrowLeft') {
      if (sess.idx > 0) {
        event.preventDefault();
        navigateToQuestion(sess, sess.idx - 1, render);
      }
    }
  };
  window.addEventListener('keydown', keyHandler);
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map(val => String(val).padStart(2, '0')).join(':');
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function currentElapsedMs(sess) {
  const base = sess?.elapsedMs || 0;
  if (sess?.startedAt) {
    return base + Math.max(0, Date.now() - sess.startedAt);
  }
  return base;
}

function slugify(text) {
  const lowered = (text || '').toLowerCase();
  const normalized = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'exam';
}

function triggerExamDownload(exam) {
  try {
    const data = JSON.stringify(exam, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(exam.examTitle || 'exam')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch (err) {
    console.warn('Failed to export exam', err);
    return false;
  }
}


function examToCsv(exam) {
  const rows = [];
  const maxOptions = getCsvMaxOptionsFromExam(exam);
  const headers = buildCsvHeaders(maxOptions);
  const { explanationIndex, tagsIndex, mediaIndex } = getCsvHeaderIndexes(headers);
  rows.push(headers);

  const metaRow = new Array(headers.length).fill('');
  metaRow[0] = CSV_ROW_META;
  metaRow[1] = exam.examTitle || '';
  metaRow[2] = exam.timerMode === 'timed' ? 'timed' : 'untimed';
  metaRow[3] = Number.isFinite(exam.secondsPerQuestion) ? String(exam.secondsPerQuestion) : String(DEFAULT_SECONDS);
  rows.push(metaRow);

  (exam.questions || []).forEach(question => {
    const row = new Array(headers.length).fill('');
    row[0] = CSV_ROW_QUESTION;
    row[4] = question.stem || '';
    const options = Array.isArray(question.options) ? question.options : [];
    options.slice(0, maxOptions).forEach((opt, idx) => {
      const optionCol = csvOptionIndex(idx + 1);
      const correctCol = csvOptionCorrectIndex(idx + 1);
      row[optionCol] = opt.text || '';
      row[correctCol] = opt.id === question.answer ? 'TRUE' : '';
    });
    if (explanationIndex >= 0) row[explanationIndex] = question.explanation || '';
    if (tagsIndex >= 0) row[tagsIndex] = Array.isArray(question.tags) ? question.tags.join(' | ') : '';
    if (mediaIndex >= 0) row[mediaIndex] = question.media || '';
    rows.push(row);
  });

  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
}

function downloadExamCsv(exam) {
  const csv = examToCsv(exam);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `${slugify(exam.examTitle || 'exam')}.csv`);
}

function downloadExamCsvTemplate() {
  const sampleQuestion = createBlankQuestion();
  sampleQuestion.stem = sanitizeRichText('What is the capital of France?');
  sampleQuestion.options = [
    { id: uid(), text: sanitizeRichText('Paris') },
    { id: uid(), text: sanitizeRichText('London') },
    { id: uid(), text: sanitizeRichText('Rome') }
  ];
  sampleQuestion.answer = sampleQuestion.options[0]?.id || '';
  sampleQuestion.explanation = sanitizeRichText('Paris is the capital and most populous city of France.');
  sampleQuestion.tags = ['geography'];

  const { exam } = ensureExamShape({
    examTitle: 'Example Exam',
    timerMode: 'untimed',
    secondsPerQuestion: DEFAULT_SECONDS,
    questions: [sampleQuestion],
    results: []
  });

  const csv = examToCsv(exam);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, 'exam-template.csv');
}

function parseCsv(text) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(current);
      current = '';
    } else if (char === '\r') {
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
      if (text[i + 1] === '\n') i += 1;
    } else if (char === '\n') {
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  row.push(current);
  if (row.length > 1 || row[0].trim()) {
    rows.push(row);
  }

  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function examFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) {
    throw new Error('Empty CSV');
  }
  const header = rows[0].map(col => col.trim());
  const indexMap = new Map();
  header.forEach((name, idx) => {
    if (!name) return;
    indexMap.set(name, idx);
  });
  const maxOptions = Math.max(CSV_TEMPLATE_MIN_OPTIONS, getCsvMaxOptionsFromHeader(header));

  const getCell = (row, key) => {
    const idx = indexMap.has(key) ? indexMap.get(key) : -1;
    if (idx == null || idx < 0) return '';
    return row[idx] ?? '';
  };

  const base = {
    examTitle: 'Imported Exam',
    timerMode: 'untimed',
    secondsPerQuestion: DEFAULT_SECONDS,
    questions: [],
    results: []
  };

  rows.slice(1).forEach(row => {
    const type = String(getCell(row, 'type') || '').trim().toLowerCase();
    if (!type) return;
    if (type === CSV_ROW_META) {
      const title = String(getCell(row, 'examTitle') || '').trim();
      if (title) base.examTitle = title;
      const mode = String(getCell(row, 'timerMode') || '').trim().toLowerCase();
      if (mode === 'timed' || mode === 'untimed') base.timerMode = mode;
      const seconds = Number(getCell(row, 'secondsPerQuestion'));
      if (Number.isFinite(seconds) && seconds > 0) base.secondsPerQuestion = seconds;
      return;
    }
    if (type !== CSV_ROW_QUESTION) return;

    const question = createBlankQuestion();
    question.stem = sanitizeRichText(getCell(row, 'stem'));
    question.explanation = sanitizeRichText(getCell(row, 'explanation'));
    question.tags = parseTagString(getCell(row, 'tags'));
    question.media = String(getCell(row, 'media') || '').trim();
    question.options = [];
    question.answer = '';

    for (let i = 1; i <= maxOptions; i += 1) {
      const optionHtml = sanitizeRichText(getCell(row, `option${i}`));
      if (!optionHtml) continue;
      const option = { id: uid(), text: optionHtml };
      question.options.push(option);
      if (!question.answer && parseBooleanFlag(getCell(row, `option${i}Correct`))) {
        question.answer = option.id;
      }
    }

    if (question.options.length < 2) {
      return;
    }
    if (!question.answer) {
      question.answer = question.options[0].id;
    }
    base.questions.push(question);
  });

  if (!base.questions.length) {
    throw new Error('No questions found in CSV');
  }

  return ensureExamShape(base).exam;
}


function ensureExamShape(exam) {
  const next = clone(exam) || {};
  let changed = false;

  if (!next.id) { next.id = uid(); changed = true; }
  if (!next.examTitle) { next.examTitle = 'Untitled Exam'; changed = true; }
  if (next.timerMode !== 'timed') {
    if (next.timerMode !== 'untimed') changed = true;
    next.timerMode = 'untimed';
  }
  if (typeof next.secondsPerQuestion !== 'number' || next.secondsPerQuestion <= 0) {
    next.secondsPerQuestion = DEFAULT_SECONDS;
    changed = true;
  }
  if (!Array.isArray(next.questions)) {
    next.questions = [];
    changed = true;
  }
  next.questions = next.questions.map(q => {
    const question = { ...q };
    if (!question.id) { question.id = uid(); changed = true; }
    const originalStem = question.stem;
    question.stem = sanitizeRichText(question.stem);
    if (originalStem !== question.stem) changed = true;
    if (!Array.isArray(question.options)) {
      question.options = [];
      changed = true;
    }
    question.options = question.options.map(opt => {
      const option = { ...opt };
      if (!option.id) { option.id = uid(); changed = true; }
      const originalText = option.text;
      option.text = sanitizeRichText(option.text);
      if (originalText !== option.text) changed = true;
      return option;
    });
    if (!question.answer || !question.options.some(opt => opt.id === question.answer)) {
      question.answer = question.options[0]?.id || '';
      changed = true;
    }
    const originalExplanation = question.explanation;
    question.explanation = sanitizeRichText(question.explanation);
    if (originalExplanation !== question.explanation) changed = true;
    const normalizedTags = ensureArrayTags(question.tags);
    if (question.tags?.length !== normalizedTags.length || question.tags?.some((t, idx) => t !== normalizedTags[idx])) {
      question.tags = normalizedTags;
      changed = true;
    } else {
      question.tags = normalizedTags;
    }
    const normalizedLectures = normalizeLectureRefs(question.lectures);
    const sameLectures = Array.isArray(question.lectures)
      && question.lectures.length === normalizedLectures.length
      && question.lectures.every((lec, idx) => lec?.blockId === normalizedLectures[idx]?.blockId
        && lec?.id === normalizedLectures[idx]?.id
        && lec?.name === normalizedLectures[idx]?.name
        && lec?.week === normalizedLectures[idx]?.week);
    if (!sameLectures) {
      question.lectures = normalizedLectures;
      changed = true;
    } else {
      question.lectures = normalizedLectures;
    }
    if (question.media == null) { question.media = ''; changed = true; }
    return question;
  });

  if (!Array.isArray(next.results)) {
    next.results = [];
    changed = true;
  }
  next.results = next.results.map(res => {
    const result = { ...res };
    if (!result.id) { result.id = uid(); changed = true; }
    if (typeof result.when !== 'number') { result.when = Date.now(); changed = true; }
    if (typeof result.correct !== 'number') { result.correct = Number(result.correct) || 0; changed = true; }
    if (typeof result.total !== 'number') { result.total = Number(result.total) || (next.questions?.length ?? 0); changed = true; }
    if (!result.answers || typeof result.answers !== 'object') { result.answers = {}; changed = true; }
    if (!Array.isArray(result.flagged)) { result.flagged = []; changed = true; }
    if (typeof result.durationMs !== 'number') { result.durationMs = 0; changed = true; }
    if (typeof result.answered !== 'number') { result.answered = Object.keys(result.answers || {}).length; changed = true; }
    return result;
  });

  return { exam: next, changed };
}

function createBlankQuestion() {
  return {
    id: uid(),
    stem: '',
    options: [1, 2, 3, 4].map(() => ({ id: uid(), text: '' })),
    answer: '',
    explanation: '',
    tags: [],
    lectures: [],
    media: ''
  };
}

function createTakingSession(exam) {
  const snapshot = clone(exam);
  const totalMs = snapshot.timerMode === 'timed' ? totalExamTimeMs(snapshot) : null;
  return {
    mode: 'taking',
    exam: snapshot,
    idx: 0,
    answers: {},
    flagged: {},
    checked: {},
    startedAt: Date.now(),
    elapsedMs: 0,
    remainingMs: totalMs,
    baseExam: null,
    subsetIndices: null,
    questionStats: snapshot.questions.map(() => ({
      timeMs: 0,
      changes: [],
      enteredAt: null,
      initialAnswer: null,
      initialAnswerAt: null
    }))
  };
}

function hydrateSavedSession(saved, fallbackExam) {
  const baseExam = saved?.exam ? ensureExamShape(saved.exam).exam : fallbackExam;
  const exam = clone(baseExam);
  const questionCount = exam.questions.length;
  const idx = Math.min(Math.max(Number(saved?.idx) || 0, 0), Math.max(0, questionCount - 1));
  const remaining = typeof saved?.remainingMs === 'number'
    ? Math.max(0, saved.remainingMs)
    : (exam.timerMode === 'timed' ? totalExamTimeMs(exam) : null);
  const elapsed = Math.max(0, Number(saved?.elapsedMs) || 0);
  return {
    mode: 'taking',
    exam,
    idx,
    answers: saved?.answers ? { ...saved.answers } : {},
    flagged: saved?.flagged ? { ...saved.flagged } : {},
    checked: saved?.checked ? { ...saved.checked } : {},
    startedAt: Date.now(),
    elapsedMs: elapsed,
    remainingMs: remaining,
    baseExam: saved?.baseExam ? ensureExamShape(saved.baseExam).exam : null,
    subsetIndices: Array.isArray(saved?.subsetIndices) ? [...saved.subsetIndices] : null,
    questionStats: exam.questions.map((_, questionIdx) => {
      const stat = saved?.questionStats?.[questionIdx] || {};
      return {
        timeMs: Number.isFinite(stat.timeMs) ? stat.timeMs : 0,
        changes: Array.isArray(stat.changes) ? stat.changes.map(change => ({ ...change })) : [],
        enteredAt: null,
        initialAnswer: stat.initialAnswer ?? null,
        initialAnswerAt: Number.isFinite(stat.initialAnswerAt) ? stat.initialAnswerAt : null
      };
    })
  };
}

async function loadExamOverview() {
  const [stored, savedSessions, lectureCatalog] = await Promise.all([
    listExams(),
    listExamSessions(),
    loadBlockCatalog().catch(() => ({ blocks: [], lectureLists: {} }))
  ]);
  const exams = [];
  let qbankExam = null;
  const pendingUpdates = [];
  for (const raw of stored) {
    const { exam, changed } = ensureExamShape(raw);
    if (exam.id === QBANK_EXAM_ID) {
      qbankExam = exam;
    } else {
      exams.push(exam);
    }
    if (changed) {
      pendingUpdates.push(upsertExam(exam).catch(err => {
        console.warn('Failed to normalize exam', err);
      }));
    }
  }
  if (pendingUpdates.length) {
    await Promise.all(pendingUpdates);
  }
  exams.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const qbankSignature = qbankSignatureFor(exams);
  if (!qbankExam || qbankExam.qbankSignature !== qbankSignature) {
    qbankExam = buildQBankExam(exams, qbankExam);
    qbankExam.qbankSignature = qbankSignature;
    qbankExam.updatedAt = Date.now();
    await upsertExam(qbankExam);
  }

  return { exams, qbankExam, savedSessions, lectureCatalog };
}

export async function renderExams(root, render) {
  const scroller = resolveScrollContainer(root);
  examViewScrollTop = readScrollPosition(scroller);
  root.innerHTML = '';
  root.className = 'tab-content exam-view';

  const controls = document.createElement('div');
  controls.className = 'exam-controls';

  const headerRow = document.createElement('div');
  headerRow.className = 'exam-controls-header';
  controls.appendChild(headerRow);

  const heading = document.createElement('div');
  heading.className = 'exam-heading';
  heading.innerHTML = '<h1>Exams</h1>';
  headerRow.appendChild(heading);

  const actions = document.createElement('div');
  actions.className = 'exam-control-actions';
  headerRow.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'exam-status';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,.csv,application/json,text/csv';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const name = (file.name || '').toLowerCase();
      if (name.endsWith('.csv') || (file.type || '').includes('csv')) {
        const text = await file.text();
        const imported = examFromCsv(text);
        await upsertExam({ ...imported, updatedAt: Date.now() });
        lastExamStatusMessage = `Imported "${imported.examTitle}" from CSV.`;
        render();
      } else {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const { exam } = ensureExamShape(parsed);
        await upsertExam({ ...exam, updatedAt: Date.now() });
        lastExamStatusMessage = `Imported "${exam.examTitle}" from JSON.`;
        render();
      }
    } catch (err) {
      console.warn('Failed to import exam', err);
      status.textContent = 'Unable to import exam — check the file format.';
    } finally {
      fileInput.value = '';
    }
  });

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'btn secondary';
  importBtn.textContent = 'Import JSON/CSV';
  importBtn.addEventListener('click', () => fileInput.click());
  actions.appendChild(importBtn);

  const templateBtn = document.createElement('button');
  templateBtn.type = 'button';
  templateBtn.className = 'btn secondary';
  templateBtn.textContent = 'CSV Template';
  templateBtn.addEventListener('click', () => {
    try {
      downloadExamCsvTemplate();
      status.textContent = 'CSV template downloaded.';
    } catch (err) {
      console.warn('Failed to create CSV template', err);
      status.textContent = 'Unable to download template.';
    }
  });
  actions.appendChild(templateBtn);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'btn';
  newBtn.textContent = 'New Exam';
  newBtn.addEventListener('click', () => openExamEditor(null, render));
  actions.appendChild(newBtn);

  const layout = state.examLayout || { mode: 'grid', detailsVisible: false };
  const viewMode = layout.mode === 'row' ? 'row' : 'grid';
  const detailsVisible = layout.detailsVisible !== false;

  const layoutToggle = document.createElement('button');
  layoutToggle.type = 'button';
  layoutToggle.className = 'exam-layout-toggle';
  layoutToggle.setAttribute('aria-pressed', viewMode === 'row' ? 'true' : 'false');
  layoutToggle.setAttribute('aria-label', viewMode === 'row' ? 'Switch to column view' : 'Switch to row view');
  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'exam-layout-toggle-icon';
  layoutToggle.appendChild(toggleIcon);
  const toggleText = document.createElement('span');
  toggleText.className = 'sr-only';
  toggleText.textContent = viewMode === 'row' ? 'Show exams in columns' : 'Show exams in rows';
  layoutToggle.appendChild(toggleText);
  layoutToggle.addEventListener('click', () => {
    const nextMode = viewMode === 'row' ? 'grid' : 'row';
    setExamLayout({ mode: nextMode });
    render();
  });

  actions.appendChild(layoutToggle);
  controls.appendChild(status);

  root.appendChild(controls);
  root.appendChild(fileInput);

  if (lastExamStatusMessage) {
    status.textContent = lastExamStatusMessage;
    lastExamStatusMessage = '';
  } else {
    status.textContent = '';
  }

  const { exams, qbankExam, savedSessions } = await loadExamOverview();

  const sessionMap = new Map();
  for (const sess of savedSessions) {
    if (sess?.examId) sessionMap.set(sess.examId, sess);
  }

  // Clean up orphaned sessions for removed exams
  const knownExamIds = new Set(exams.map(exam => exam.id));
  if (qbankExam) {
    knownExamIds.add(qbankExam.id);
  }
  const cleanupTasks = [];
  for (const sess of savedSessions) {
    if (!knownExamIds.has(sess.examId)) {
      cleanupTasks.push(deleteExamSessionProgress(sess.examId).catch(err => {
        console.warn('Failed to cleanup orphaned exam session', err);
      }));
    }
  }
  if (cleanupTasks.length) {
    await Promise.all(cleanupTasks);
  }

  const layoutSnapshot = { mode: viewMode, detailsVisible };

  if (qbankExam) {
    root.appendChild(buildQBankShortcut({
      qbankExam,
      render
    }));
  }

  if (!exams.length) {
    const empty = document.createElement('div');
    empty.className = 'exam-empty';
    empty.innerHTML = '<p>No exams yet. Import a JSON or CSV exam, download the template, or create one from scratch.</p>';
    root.appendChild(empty);
    applyScrollPosition(scroller, examViewScrollTop);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'exam-grid';
  if (viewMode === 'row') {
    grid.classList.add('exam-grid--row');
  }
  const frag = document.createDocumentFragment();
  exams.forEach(exam => {
    frag.appendChild(buildExamCard(exam, render, sessionMap.get(exam.id), status, layoutSnapshot));
  });
  grid.appendChild(frag);
  root.appendChild(grid);
  applyScrollPosition(scroller, examViewScrollTop);
}

function buildQBankShortcut({ qbankExam, render }) {
  const section = document.createElement('section');
  section.className = 'exam-qbank-section';

  const pill = document.createElement('span');
  pill.className = 'exam-qbank-pill exam-qbank-pill--header';
  pill.textContent = 'QBank';
  section.appendChild(pill);

  const card = document.createElement('article');
  card.className = 'card exam-qbank-card exam-qbank-card--link';
  section.appendChild(card);

  const header = document.createElement('div');
  header.className = 'exam-qbank-header';
  card.appendChild(header);

  const headerInfo = document.createElement('div');
  headerInfo.className = 'exam-qbank-header-info';
  header.appendChild(headerInfo);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'exam-qbank-title';
  const title = document.createElement('div');
  title.className = 'exam-qbank-title-text';
  title.textContent = 'Custom question study';
  const subtitle = document.createElement('div');
  subtitle.className = 'exam-qbank-subtitle';
  subtitle.textContent = 'Build a focused set from your uploaded exams.';
  titleWrap.append(title, subtitle);
  headerInfo.appendChild(titleWrap);

  const headerMeta = document.createElement('div');
  headerMeta.className = 'exam-qbank-meta';
  header.appendChild(headerMeta);

  const questionChip = document.createElement('span');
  questionChip.className = 'exam-qbank-chip';
  questionChip.textContent = `${qbankExam.questions.length} total question${qbankExam.questions.length === 1 ? '' : 's'}`;
  headerMeta.appendChild(questionChip);

  if (qbankExam.results?.length) {
    const attemptsChip = document.createElement('span');
    attemptsChip.className = 'exam-qbank-chip';
    attemptsChip.textContent = `${qbankExam.results.length} attempt${qbankExam.results.length === 1 ? '' : 's'}`;
    headerMeta.appendChild(attemptsChip);
  }

  const linkRow = document.createElement('div');
  linkRow.className = 'exam-qbank-link-row';
  card.appendChild(linkRow);

  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'exam-qbank-link';
  link.innerHTML = '<span>Open QBank workspace</span><span aria-hidden="true">→</span>';
  link.addEventListener('click', () => {
    setSubtab('Exams', 'QBank');
    render();
  });
  linkRow.appendChild(link);

  return section;
}

export async function renderQBank(root, render) {
  root.innerHTML = '';
  root.className = 'tab-content exam-qbank-view';

  const { exams, qbankExam, savedSessions, lectureCatalog } = await loadExamOverview();
  if (!qbankExam) {
    const empty = document.createElement('div');
    empty.className = 'exam-empty';
    empty.textContent = 'QBank will appear once you upload exams with questions.';
    root.appendChild(empty);
    return;
  }

  const savedSession = savedSessions.find(sess => sess?.examId === QBANK_EXAM_ID) || null;
  const answerHistory = buildQBankAnswerHistory(exams, qbankExam);

  const topbar = document.createElement('div');
  topbar.className = 'exam-qbank-topbar';
  root.appendChild(topbar);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'exam-qbank-back';
  backBtn.innerHTML = '<span aria-hidden="true">←</span><span>Back to exams</span>';
  backBtn.addEventListener('click', () => {
    setSubtab('Exams', 'list');
    render();
  });
  topbar.appendChild(backBtn);

  const heading = document.createElement('div');
  heading.className = 'exam-qbank-heading';
  heading.innerHTML = '<h1>QBank</h1>';
  topbar.appendChild(heading);

  const topMeta = document.createElement('div');
  topMeta.className = 'exam-qbank-top-meta';
  const questionChip = document.createElement('span');
  questionChip.className = 'exam-qbank-chip';
  questionChip.textContent = `${qbankExam.questions.length} total question${qbankExam.questions.length === 1 ? '' : 's'}`;
  topMeta.appendChild(questionChip);
  const attemptChip = document.createElement('span');
  attemptChip.className = 'exam-qbank-chip';
  attemptChip.textContent = `${qbankExam.results?.length || 0} session${qbankExam.results?.length === 1 ? '' : 's'}`;
  topMeta.appendChild(attemptChip);
  topbar.appendChild(topMeta);

  const layout = document.createElement('div');
  layout.className = 'exam-qbank-layout';
  root.appendChild(layout);

  const leftCol = document.createElement('div');
  leftCol.className = 'exam-qbank-column';
  layout.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.className = 'exam-qbank-column';
  layout.appendChild(rightCol);

  const selection = qbankSelectionState;
  const defaultBlockId = resolveDefaultBlockId(lectureCatalog);
  const availableBlocks = Array.isArray(lectureCatalog?.blocks) ? lectureCatalog.blocks : [];
  const availableLectures = lectureCatalog?.lectureLists || {};
  if (defaultBlockId && !selection.blockId) {
    selection.blockId = defaultBlockId;
  }
  if (selection.blockId) {
    const hasBlock = availableBlocks.some(block => String(block.blockId ?? block.id ?? '') === selection.blockId);
    if (!hasBlock) {
      selection.blockId = '';
    }
  }

  const selectionCard = document.createElement('div');
  selectionCard.className = 'exam-qbank-panel exam-qbank-panel--selection';
  leftCol.appendChild(selectionCard);

  const selectionHeader = document.createElement('div');
  selectionHeader.className = 'exam-qbank-selection-header';
  selectionCard.appendChild(selectionHeader);

  const selectionTitle = document.createElement('div');
  selectionTitle.className = 'exam-qbank-selection-title';
  selectionTitle.textContent = 'Lecture selection';
  selectionHeader.appendChild(selectionTitle);

  const selectionMeta = document.createElement('div');
  selectionMeta.className = 'exam-qbank-selection-meta';
  selectionHeader.appendChild(selectionMeta);

  const selectionControls = document.createElement('div');
  selectionControls.className = 'exam-qbank-controls';
  selectionCard.appendChild(selectionControls);

  const blockSelect = document.createElement('select');
  blockSelect.className = 'input exam-qbank-select';
  const blockAll = document.createElement('option');
  blockAll.value = '';
  blockAll.textContent = 'All blocks';
  blockSelect.appendChild(blockAll);
  availableBlocks.forEach(block => {
    const opt = document.createElement('option');
    opt.value = String(block.blockId ?? block.id ?? '');
    opt.textContent = block.title || opt.value;
    blockSelect.appendChild(opt);
  });
  blockSelect.value = selection.blockId || '';
  selectionControls.appendChild(blockSelect);

  const blockToggle = document.createElement('button');
  blockToggle.type = 'button';
  blockToggle.className = 'btn secondary exam-qbank-toggle';
  selectionControls.appendChild(blockToggle);

  const weekSelect = document.createElement('select');
  weekSelect.className = 'input exam-qbank-select';
  selectionControls.appendChild(weekSelect);

  const weekToggle = document.createElement('button');
  weekToggle.type = 'button';
  weekToggle.className = 'btn secondary exam-qbank-toggle';
  selectionControls.appendChild(weekToggle);

  const lectureList = document.createElement('div');
  lectureList.className = 'exam-qbank-lecture-list';
  selectionCard.appendChild(lectureList);

  const selectionActions = document.createElement('div');
  selectionActions.className = 'exam-qbank-selection-actions';
  selectionCard.appendChild(selectionActions);

  const untaggedToggle = document.createElement('button');
  untaggedToggle.type = 'button';
  untaggedToggle.className = 'btn secondary exam-qbank-toggle';
  untaggedToggle.textContent = 'Include untagged';
  selectionActions.appendChild(untaggedToggle);

  const clearSelection = document.createElement('button');
  clearSelection.type = 'button';
  clearSelection.className = 'btn secondary';
  clearSelection.textContent = 'Clear selection';
  selectionActions.appendChild(clearSelection);

  const selectAllLectures = document.createElement('button');
  selectAllLectures.type = 'button';
  selectAllLectures.className = 'btn secondary exam-qbank-select-all';
  selectAllLectures.textContent = 'Select all lectures';
  selectionActions.appendChild(selectAllLectures);

  const answerFilters = document.createElement('div');
  answerFilters.className = 'exam-qbank-answer-filters';
  selectionCard.appendChild(answerFilters);

  const answerHeader = document.createElement('div');
  answerHeader.className = 'exam-qbank-answer-header';
  answerHeader.innerHTML = '<div class="exam-qbank-answer-title">Answer history</div><div class="exam-qbank-answer-subtitle">Include previously answered questions when needed.</div>';
  answerFilters.appendChild(answerHeader);

  const includeAnsweredRow = document.createElement('label');
  includeAnsweredRow.className = 'exam-qbank-answer-toggle';
  const includeAnsweredToggle = document.createElement('input');
  includeAnsweredToggle.type = 'checkbox';
  includeAnsweredToggle.checked = Boolean(selection.includeAnswered);
  includeAnsweredRow.appendChild(includeAnsweredToggle);
  const includeAnsweredLabel = document.createElement('span');
  includeAnsweredLabel.textContent = 'Include answered questions';
  includeAnsweredRow.appendChild(includeAnsweredLabel);
  answerFilters.appendChild(includeAnsweredRow);

  const answeredOptions = document.createElement('div');
  answeredOptions.className = 'exam-qbank-answer-options';
  answerFilters.appendChild(answeredOptions);

  const buildAnswerOption = (key, label) => {
    const row = document.createElement('label');
    row.className = 'exam-qbank-answer-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(selection.answeredFilters?.[key]);
    row.appendChild(input);
    const text = document.createElement('span');
    text.textContent = label;
    row.appendChild(text);
    input.addEventListener('change', () => {
      selection.answeredFilters[key] = input.checked;
      updateSelectionMeta();
      updateAvailability();
    });
    answeredOptions.appendChild(row);
    return input;
  };

  const includeIncorrectToggle = buildAnswerOption('incorrect', 'Incorrectly answered');
  const includeCorrectToggle = buildAnswerOption('correct', 'Correctly answered');
  const includeFlaggedToggle = buildAnswerOption('flagged', 'Flagged questions');

  const status = document.createElement('div');
  status.className = 'exam-qbank-status';
  leftCol.appendChild(status);

  const countPanel = document.createElement('div');
  countPanel.className = 'exam-qbank-count';
  leftCol.appendChild(countPanel);

  const countLabel = document.createElement('div');
  countLabel.className = 'exam-qbank-count-label';
  countLabel.textContent = 'Questions to pull';
  countPanel.appendChild(countLabel);

  const countControls = document.createElement('div');
  countControls.className = 'exam-qbank-count-controls';
  countPanel.appendChild(countControls);

  const countInput = document.createElement('input');
  countInput.type = 'number';
  countInput.className = 'input exam-qbank-count-input';
  countControls.appendChild(countInput);

  const countHelp = document.createElement('div');
  countHelp.className = 'exam-qbank-count-help';
  countControls.appendChild(countHelp);

  const actions = document.createElement('div');
  actions.className = 'exam-qbank-actions';
  leftCol.appendChild(actions);

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'btn';
  startBtn.textContent = 'Start QBank';
  actions.appendChild(startBtn);

  const resumeBtn = document.createElement('button');
  resumeBtn.type = 'button';
  resumeBtn.className = 'btn secondary';
  resumeBtn.textContent = 'Resume';
  resumeBtn.disabled = !savedSession;
  actions.appendChild(resumeBtn);

  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.className = 'btn secondary';
  discardBtn.textContent = 'Delete session';
  discardBtn.disabled = !savedSession;
  actions.appendChild(discardBtn);

  const statsCard = document.createElement('div');
  statsCard.className = 'exam-qbank-panel exam-qbank-panel--stats';
  rightCol.appendChild(statsCard);

  const statsHeader = document.createElement('div');
  statsHeader.className = 'exam-qbank-stats-header';
  statsHeader.innerHTML = '<div class="exam-qbank-stats-title">Performance</div><div class="exam-qbank-stats-subtitle">Across all QBank sessions</div>';
  statsCard.appendChild(statsHeader);

  const statsBody = document.createElement('div');
  statsBody.className = 'exam-qbank-stats-body';
  statsCard.appendChild(statsBody);

  const pie = document.createElement('div');
  pie.className = 'exam-qbank-pie';
  statsBody.appendChild(pie);

  const statList = document.createElement('div');
  statList.className = 'exam-qbank-stat-list';
  statsBody.appendChild(statList);

  const statsEmpty = document.createElement('div');
  statsEmpty.className = 'exam-qbank-empty';
  statsEmpty.textContent = 'No QBank sessions yet.';

  const attemptsWrap = document.createElement('div');
  attemptsWrap.className = 'exam-qbank-panel exam-qbank-panel--history';
  rightCol.appendChild(attemptsWrap);

  const attemptsHeader = document.createElement('div');
  attemptsHeader.className = 'exam-attempts-header';
  attemptsWrap.appendChild(attemptsHeader);

  const attemptsTitle = document.createElement('div');
  attemptsTitle.className = 'exam-attempt-title';
  attemptsTitle.textContent = 'Session history';
  attemptsHeader.appendChild(attemptsTitle);

  const attemptsCount = document.createElement('div');
  attemptsCount.className = 'exam-attempt-count';
  attemptsHeader.appendChild(attemptsCount);

  const attemptsList = document.createElement('div');
  attemptsList.className = 'exam-attempt-list';
  attemptsWrap.appendChild(attemptsList);

  function resolveLectureEntries({ includeAllWeeks = false } = {}) {
    const blockId = selection.blockId;
    const weekValue = includeAllWeeks ? '' : selection.week;
    const entries = [];
    const blockIds = blockId
      ? [blockId]
      : Object.keys(availableLectures);
    blockIds.forEach(id => {
      const lectures = availableLectures?.[id] || [];
      lectures.forEach(lecture => {
        if (weekValue && String(lecture.week ?? '') !== weekValue) return;
        entries.push({ blockId: id, lecture });
      });
    });
    return entries;
  }

  function renderWeekOptions() {
    weekSelect.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All weeks';
    weekSelect.appendChild(allOption);
    const entries = resolveLectureEntries({ includeAllWeeks: true });
    const weeks = new Set();
    entries.forEach(({ lecture }) => {
      if (lecture.week == null || lecture.week === '') return;
      weeks.add(String(lecture.week));
    });
    Array.from(weeks).sort((a, b) => Number(a) - Number(b)).forEach(week => {
      const opt = document.createElement('option');
      opt.value = week;
      opt.textContent = `Week ${week}`;
      weekSelect.appendChild(opt);
    });
    if (!weeks.has(selection.week)) {
      selection.week = '';
    }
    weekSelect.value = selection.week || '';
  }

  function renderLectureList() {
    lectureList.innerHTML = '';
    if (!Object.keys(availableLectures).length) {
      const empty = document.createElement('div');
      empty.className = 'exam-qbank-empty';
      empty.textContent = 'No lectures found.';
      lectureList.appendChild(empty);
      return;
    }
    const entries = resolveLectureEntries();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'exam-qbank-empty';
      empty.textContent = 'No lectures available for this filter.';
      lectureList.appendChild(empty);
      return;
    }
    entries.forEach(({ blockId, lecture }) => {
      const key = `${blockId}|${lecture.id}`;
      const weekKey = lecture.week != null ? `${blockId}|${lecture.week}` : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'exam-qbank-lecture-button';
      const blockLabel = availableBlocks.find(block => String(block.blockId ?? block.id ?? '') === blockId)?.title || blockId;
      const lectureName = lecture.name || `Lecture ${lecture.id}`;
      btn.textContent = selection.blockId ? lectureName : `${blockLabel} • ${lectureName}`;
      const isActive = selection.selectedLectures.has(key)
        || selection.selectedBlocks.has(blockId)
        || (weekKey && selection.selectedWeeks.has(weekKey));
      setToggleState(btn, isActive);
      btn.addEventListener('click', () => {
        if (selection.selectedLectures.has(key)) {
          selection.selectedLectures.delete(key);
        } else {
          selection.selectedLectures.add(key);
        }
        const activeNow = selection.selectedLectures.has(key)
          || selection.selectedBlocks.has(blockId)
          || (weekKey && selection.selectedWeeks.has(weekKey));
        setToggleState(btn, activeNow);
        updateSelectionMeta();
        updateAvailability();
      });
      lectureList.appendChild(btn);
    });
  }

  function updateSelectionMeta() {
    const selectedBlocks = selection.selectedBlocks.size;
    const selectedWeeks = selection.selectedWeeks.size;
    const selectedLectures = selection.selectedLectures.size;
    const answeredLabel = selection.includeAnswered
      ? [
        selection.answeredFilters?.incorrect ? 'Incorrect' : null,
        selection.answeredFilters?.correct ? 'Correct' : null,
        selection.answeredFilters?.flagged ? 'Flagged' : null
      ].filter(Boolean).join(', ') || 'None'
      : 'Off';
    selectionMeta.innerHTML = `
      <span>Blocks: ${selectedBlocks}</span>
      <span>Weeks: ${selectedWeeks}</span>
      <span>Lectures: ${selectedLectures}</span>
      <span>${selection.includeUntagged ? 'Untagged: On' : 'Untagged: Off'}</span>
      <span>Answered: ${answeredLabel}</span>
    `;
    clearSelection.disabled = !(selectedBlocks || selectedWeeks || selectedLectures || selection.includeUntagged);
    const blockIsSelected = selection.blockId && selection.selectedBlocks.has(selection.blockId);
    blockToggle.textContent = blockIsSelected ? 'Block selected' : 'Select block';
    blockToggle.disabled = !selection.blockId;
    setToggleState(blockToggle, Boolean(blockIsSelected));

    const weekKey = selection.blockId && selection.week ? `${selection.blockId}|${selection.week}` : '';
    const weekIsSelected = weekKey && selection.selectedWeeks.has(weekKey);
    weekToggle.textContent = weekIsSelected ? 'Week selected' : 'Select week';
    weekToggle.disabled = !weekKey;
    setToggleState(weekToggle, Boolean(weekIsSelected));
    setToggleState(untaggedToggle, selection.includeUntagged);
  }

  function matchesAnswerFilters(question) {
    const key = qbankKeyForQuestion(question, question.sourceExamId || qbankExam.id);
    const history = key ? answerHistory.get(key) : null;
    const answered = Boolean(history?.answered);
    if (!selection.includeAnswered) {
      return !answered;
    }
    if (!answered) return true;
    const includeCorrect = Boolean(selection.answeredFilters?.correct);
    const includeIncorrect = Boolean(selection.answeredFilters?.incorrect);
    const includeFlagged = Boolean(selection.answeredFilters?.flagged);
    if (!(includeCorrect || includeIncorrect || includeFlagged)) return false;
    return (includeCorrect && history?.correct)
      || (includeIncorrect && history?.incorrect)
      || (includeFlagged && history?.flagged);
  }

  function getAvailableIndices() {
    return qbankExam.questions
      .map((question, idx) => (qbankMatchesSelection(question, selection) && matchesAnswerFilters(question) ? idx : null))
      .filter(Number.isFinite);
  }

  function updateAvailability() {
    const availableIndices = getAvailableIndices();
    const availableCount = availableIndices.length;

    let normalizedCount = Number(selection.questionCount) || QBANK_DEFAULT_COUNT;
    if (availableCount > 0) {
      normalizedCount = Math.min(Math.max(1, normalizedCount), availableCount);
      selection.questionCount = normalizedCount;
    } else {
      normalizedCount = 0;
    }

    countInput.min = availableCount ? '1' : '0';
    countInput.max = String(Math.max(availableCount, 1));
    countInput.value = String(normalizedCount || 0);
    countInput.disabled = availableCount === 0;
    countHelp.textContent = availableCount
      ? `${availableCount} question${availableCount === 1 ? '' : 's'} available with current tags.`
      : 'No questions match the current lecture selection.';
    startBtn.disabled = availableCount === 0;
    return availableIndices;
  }

  function updateStats() {
    const results = qbankExam.results || [];
    const totals = results.reduce((acc, result) => {
      acc.correct += result.correct || 0;
      acc.total += result.total || 0;
      return acc;
    }, { correct: 0, total: 0 });
    const pct = totals.total ? Math.round((totals.correct / totals.total) * 100) : 0;
    pie.style.setProperty('--qbank-score', String(pct));
    pie.innerHTML = `<span>${pct}%</span>`;
    statList.innerHTML = '';
    if (!results.length) {
      statList.appendChild(statsEmpty);
    } else {
      const statItems = [
        { label: 'Sessions', value: String(results.length) },
        { label: 'Questions answered', value: String(totals.total) },
        { label: 'Correct', value: String(totals.correct) }
      ];
      statItems.forEach(item => {
        const row = document.createElement('div');
        row.className = 'exam-qbank-stat';
        row.innerHTML = `<span>${item.label}</span><strong>${item.value}</strong>`;
        statList.appendChild(row);
      });
    }
  }

  function updateHistory() {
    const results = qbankExam.results || [];
    attemptsCount.textContent = String(results.length);
    attemptsList.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'exam-attempt-empty';
      empty.textContent = 'No QBank sessions yet.';
      attemptsList.appendChild(empty);
      return;
    }
    [...results]
      .sort((a, b) => b.when - a.when)
      .forEach(result => {
        attemptsList.appendChild(buildAttemptRow(qbankExam, result, render));
      });
  }

  renderWeekOptions();
  renderLectureList();
  updateSelectionMeta();
  updateAvailability();
  updateStats();
  updateHistory();

  blockSelect.addEventListener('change', () => {
    selection.blockId = blockSelect.value;
    selection.week = '';
    renderWeekOptions();
    renderLectureList();
    updateSelectionMeta();
    updateAvailability();
  });
  weekSelect.addEventListener('change', () => {
    selection.week = weekSelect.value;
    renderLectureList();
    updateSelectionMeta();
    updateAvailability();
  });

  blockToggle.addEventListener('click', () => {
    if (!selection.blockId) return;
    if (selection.selectedBlocks.has(selection.blockId)) {
      selection.selectedBlocks.delete(selection.blockId);
    } else {
      selection.selectedBlocks.add(selection.blockId);
    }
    renderLectureList();
    updateSelectionMeta();
    updateAvailability();
  });

  weekToggle.addEventListener('click', () => {
    const weekKey = selection.blockId && selection.week ? `${selection.blockId}|${selection.week}` : '';
    if (!weekKey) return;
    if (selection.selectedWeeks.has(weekKey)) {
      selection.selectedWeeks.delete(weekKey);
    } else {
      selection.selectedWeeks.add(weekKey);
    }
    renderLectureList();
    updateSelectionMeta();
    updateAvailability();
  });

  untaggedToggle.addEventListener('click', () => {
    selection.includeUntagged = !selection.includeUntagged;
    updateSelectionMeta();
    updateAvailability();
  });

  includeAnsweredToggle.addEventListener('change', () => {
    selection.includeAnswered = includeAnsweredToggle.checked;
    answeredOptions.hidden = !selection.includeAnswered;
    includeIncorrectToggle.disabled = !selection.includeAnswered;
    includeCorrectToggle.disabled = !selection.includeAnswered;
    includeFlaggedToggle.disabled = !selection.includeAnswered;
    if (!selection.includeAnswered) {
      selection.answeredFilters.incorrect = false;
      selection.answeredFilters.correct = false;
      selection.answeredFilters.flagged = false;
      includeIncorrectToggle.checked = false;
      includeCorrectToggle.checked = false;
      includeFlaggedToggle.checked = false;
    }
    updateSelectionMeta();
    updateAvailability();
  });

  clearSelection.addEventListener('click', () => {
    selection.selectedBlocks.clear();
    selection.selectedWeeks.clear();
    selection.selectedLectures.clear();
    selection.includeUntagged = false;
    renderLectureList();
    updateSelectionMeta();
    updateAvailability();
  });

  selectAllLectures.addEventListener('click', () => {
    const entries = resolveLectureEntries({ includeAllWeeks: true });
    if (!entries.length) return;
    entries.forEach(({ blockId, lecture }) => {
      selection.selectedLectures.add(`${blockId}|${lecture.id}`);
    });
    renderLectureList();
    updateSelectionMeta();
    updateAvailability();
  });

  countInput.addEventListener('input', () => {
    selection.questionCount = Number(countInput.value);
  });

  answeredOptions.hidden = !selection.includeAnswered;
  includeIncorrectToggle.disabled = !selection.includeAnswered;
  includeCorrectToggle.disabled = !selection.includeAnswered;
  includeFlaggedToggle.disabled = !selection.includeAnswered;

  if (!selection.includeAnswered) {
    includeIncorrectToggle.checked = false;
    includeCorrectToggle.checked = false;
    includeFlaggedToggle.checked = false;
  }

  startBtn.addEventListener('click', async () => {
    const availableIndices = updateAvailability();
    const availableCount = availableIndices.length;
    if (!availableCount) {
      status.textContent = 'Select lectures to build a question set.';
      return;
    }
    const desired = Math.min(Math.max(1, Number(countInput.value) || selection.questionCount || QBANK_DEFAULT_COUNT), availableCount);
    const selectedIndices = shuffleIndices(availableIndices).slice(0, desired);
    const subset = subsetExamForIndices(qbankExam, null, selectedIndices);
    if (!subset) {
      status.textContent = 'Unable to build a question set. Try adjusting the filters.';
      return;
    }
    await deleteExamSessionProgress(QBANK_EXAM_ID).catch(() => {});
    const session = createTakingSession(subset.exam);
    session.exam.examTitle = 'QBank • Custom Study';
    session.exam.timerMode = 'untimed';
    session.exam.secondsPerQuestion = qbankExam.secondsPerQuestion;
    session.baseExam = clone(qbankExam);
    session.subsetIndices = selectedIndices;
    setExamSession(session);
    render();
  });

  resumeBtn.addEventListener('click', async () => {
    if (!savedSession) return;
    const latest = await loadExamSession(QBANK_EXAM_ID);
    if (!latest) return;
    const session = hydrateSavedSession(latest, qbankExam);
    setExamSession(session);
    render();
  });

  discardBtn.addEventListener('click', async () => {
    if (!savedSession) return;
    const confirm = await confirmModal('Delete this saved QBank session?');
    if (!confirm) return;
    await deleteExamSessionProgress(QBANK_EXAM_ID).catch(() => {});
    status.textContent = 'Saved QBank session deleted.';
    render();
  });

  if (!qbankExam.questions.length) {
    status.textContent = 'QBank will populate once you upload exams with questions.';
  }
}

function buildExamCard(exam, render, savedSession, statusEl, layout) {
  const layoutMode = layout?.mode === 'row' ? 'row' : 'grid';
  const expandedState = state.examAttemptExpanded[exam.id];
  const isExpanded = expandedState === true;
  const last = latestResult(exam);
  const best = bestResult(exam);

  const card = document.createElement('article');
  card.className = 'card exam-card';
  if (layoutMode === 'row') {
    card.classList.add('exam-card--row');
  }
  if (isExpanded) {
    card.classList.add('exam-card--expanded');
  }

  const header = document.createElement('div');
  header.className = 'exam-card-header';
  card.appendChild(header);

  const summary = document.createElement('div');
  summary.className = 'exam-card-summary';
  header.appendChild(summary);

  const summaryContent = document.createElement('div');
  summaryContent.className = 'exam-card-summary-content';
  summary.appendChild(summaryContent);

  const titleGroup = document.createElement('div');
  titleGroup.className = 'exam-card-title-group';
  summaryContent.appendChild(titleGroup);

  const title = document.createElement('h2');
  title.className = 'exam-card-title';
  title.textContent = exam.examTitle;
  titleGroup.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'exam-card-meta';
  const questionCount = document.createElement('span');
  questionCount.textContent = `${exam.questions.length} question${exam.questions.length === 1 ? '' : 's'}`;
  meta.appendChild(questionCount);
  const timerInfo = document.createElement('span');
  timerInfo.textContent = exam.timerMode === 'timed'
    ? `Timed • ${exam.secondsPerQuestion}s/question`
    : 'Untimed';
  meta.appendChild(timerInfo);
  titleGroup.appendChild(meta);

  const glance = document.createElement('div');
  glance.className = 'exam-card-pills';
  summaryContent.appendChild(glance);

  if (exam.results.length) {
    const attemptsChip = document.createElement('span');
    attemptsChip.className = 'exam-card-chip';
    attemptsChip.textContent = `${exam.results.length} attempt${exam.results.length === 1 ? '' : 's'}`;
    attemptsChip.title = `${exam.results.length} recorded attempt${exam.results.length === 1 ? '' : 's'}`;
    glance.appendChild(attemptsChip);
  }

  if (best) {
    const badge = createScoreBadge(best);
    badge.classList.add('exam-score-badge--pill');
    badge.dataset.badge = 'best';
    badge.title = `Best attempt • ${formatScore(best)}`;
    badge.setAttribute('aria-label', `Best attempt ${formatScore(best)}`);
    glance.appendChild(badge);
  }
  if (last && (!best || last.id !== best.id)) {
    const badge = createScoreBadge(last);
    badge.classList.add('exam-score-badge--pill');
    badge.dataset.badge = 'last';
    badge.title = `Last attempt • ${formatScore(last)}`;
    badge.setAttribute('aria-label', `Last attempt ${formatScore(last)}`);
    glance.appendChild(badge);
  }
  if (savedSession) {
    const progressChip = document.createElement('span');
    progressChip.className = 'exam-card-chip exam-card-chip--progress';
    progressChip.textContent = 'In progress';
    glance.appendChild(progressChip);
  }

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'exam-card-caret';
  caret.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
  caret.setAttribute('aria-label', isExpanded ? 'Collapse exam details' : 'Expand exam details');
  summary.appendChild(caret);

  const quickAction = document.createElement('div');
  quickAction.className = 'exam-card-cta';
  header.appendChild(quickAction);

  const quickBtn = document.createElement('button');
  quickBtn.className = 'btn exam-card-primary';
  quickBtn.disabled = !savedSession && !last && exam.questions.length === 0;
  quickAction.appendChild(quickBtn);

  if (savedSession) {
    quickBtn.textContent = 'Resume';
    quickBtn.addEventListener('click', async () => {
      const latest = await loadExamSession(exam.id);
      if (!latest) {
        if (statusEl) statusEl.textContent = 'Saved attempt could not be found.';
        render();
        return;
      }
      const session = hydrateSavedSession(latest, exam);
      setExamSession(session);
      render();
    });
  } else if (last) {
    quickBtn.textContent = 'Review';
    quickBtn.addEventListener('click', () => {
      const reviewPacket = resolveReviewPacket(exam, last);
      setExamSession({ mode: 'review', exam: clone(reviewPacket.exam), result: clone(reviewPacket.result), idx: 0 });
      render();
    });
  } else {
    quickBtn.textContent = 'Start';
    quickBtn.addEventListener('click', () => {
      setExamSession(createTakingSession(exam));
      render();
    });
  }

  const menuWrap = document.createElement('div');
  menuWrap.className = 'exam-card-menu';
  quickAction.appendChild(menuWrap);

  const menuToggle = document.createElement('button');
  menuToggle.type = 'button';
  menuToggle.className = 'exam-card-menu-toggle';
  menuToggle.setAttribute('aria-haspopup', 'true');
  menuToggle.setAttribute('aria-expanded', 'false');
  const menuId = `exam-card-menu-${exam.id}`;
  menuToggle.setAttribute('aria-controls', menuId);

  const menuToggleIcon = document.createElement('span');
  menuToggleIcon.className = 'exam-card-menu-toggle__icon';
  const menuToggleIconBar = document.createElement('span');
  menuToggleIconBar.className = 'exam-card-menu-toggle__icon-bar';
  menuToggleIcon.appendChild(menuToggleIconBar);
  menuToggle.appendChild(menuToggleIcon);

  const menuToggleLabel = document.createElement('span');
  menuToggleLabel.className = 'exam-card-menu-toggle__label';
  menuToggleLabel.textContent = 'Actions';
  menuToggle.appendChild(menuToggleLabel);

  const menuToggleSr = document.createElement('span');
  menuToggleSr.className = 'sr-only';
  menuToggleSr.textContent = 'Toggle exam actions';
  menuToggle.appendChild(menuToggleSr);

  menuWrap.appendChild(menuToggle);

  const menuPanel = document.createElement('div');
  menuPanel.className = 'exam-card-menu-panel';
  menuPanel.id = menuId;
  menuPanel.setAttribute('aria-hidden', 'true');
  menuPanel.setAttribute('role', 'menu');
  menuWrap.appendChild(menuPanel);

  let menuOpen = false;
  const handleOutside = event => {
    if (!menuOpen) return;
    if (menuWrap.contains(event.target)) return;
    closeMenu();
  };

  const handleKeydown = event => {
    if (!menuOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      menuToggle.focus();
    }
  };

  const handleFocus = event => {
    if (!menuOpen) return;
    if (menuWrap.contains(event.target)) return;
    closeMenu();
  };

  function openMenu() {
    if (menuOpen) return;
    const toggleRect = menuToggle.getBoundingClientRect();
    const panelHeight = menuPanel.scrollHeight;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const spaceBelow = viewportHeight - toggleRect.bottom;
    const spaceAbove = toggleRect.top;
    const shouldOpenUp = panelHeight > spaceBelow && spaceAbove > spaceBelow;
    menuWrap.classList.toggle('exam-card-menu--up', shouldOpenUp);
    menuOpen = true;
    card.classList.add('exam-card--menu-open');
    menuWrap.classList.add('exam-card-menu--open');
    menuToggle.setAttribute('aria-expanded', 'true');
    menuPanel.setAttribute('aria-hidden', 'false');
    document.addEventListener('click', handleOutside, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('focusin', handleFocus, true);
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    card.classList.remove('exam-card--menu-open');
    menuWrap.classList.remove('exam-card-menu--open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuPanel.setAttribute('aria-hidden', 'true');
    document.removeEventListener('click', handleOutside, true);
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('focusin', handleFocus, true);
  }

  menuToggle.addEventListener('click', event => {
    event.stopPropagation();
    if (menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  menuPanel.addEventListener('click', event => {
    event.stopPropagation();
  });

  const addMenuAction = (label, handler, options = {}) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'exam-card-menu-item';
    item.setAttribute('role', 'menuitem');
    if (options.variant === 'danger') {
      item.classList.add('is-danger');
    }
    if (options.disabled) {
      item.disabled = true;
    }
    item.textContent = label;
    item.addEventListener('click', async () => {
      if (item.disabled) return;
      const result = await handler();
      if (result === false) return;
      closeMenu();
    });
    menuPanel.appendChild(item);
  };

  addMenuAction('Restart Exam', async () => {
    if (exam.questions.length === 0) return false;
    if (savedSession) {
      const confirm = await confirmModal('Start a new attempt and discard saved progress?');
      if (!confirm) return false;
      await deleteExamSessionProgress(exam.id).catch(() => {});
    }
    setExamSession(createTakingSession(exam));
    render();
  }, { disabled: exam.questions.length === 0 });

  if (last) {
    addMenuAction('Review Last Attempt', () => {
      const reviewPacket = resolveReviewPacket(exam, last);
      setExamSession({ mode: 'review', exam: clone(reviewPacket.exam), result: clone(reviewPacket.result), idx: 0 });
      render();
    });
  }

  addMenuAction('Edit Exam', () => {
    openExamEditor(exam, render);
  });

  addMenuAction('Export JSON', () => {
    const ok = triggerExamDownload(exam);
    if (!ok && statusEl) {
      statusEl.textContent = 'Unable to export exam.';
    } else if (ok && statusEl) {
      statusEl.textContent = 'Exam exported as JSON.';
    }
  });

  addMenuAction('Export CSV', () => {
    try {
      downloadExamCsv(exam);
      if (statusEl) statusEl.textContent = 'Exam exported as CSV.';
    } catch (err) {
      console.warn('Failed to export exam CSV', err);
      if (statusEl) statusEl.textContent = 'Unable to export exam CSV.';
    }
  });

  addMenuAction('Delete Exam', async () => {
    const ok = await confirmModal(`Delete "${exam.examTitle}"? This will remove all attempts.`);
    if (!ok) return false;
    await deleteExamSessionProgress(exam.id).catch(() => {});
    await deleteExam(exam.id);
    render();
  }, { variant: 'danger' });

  const details = document.createElement('div');
  details.className = 'exam-card-details';
  details.setAttribute('aria-hidden', isExpanded ? 'false' : 'true');
  card.appendChild(details);

  if (savedSession) {
    const banner = document.createElement('div');
    banner.className = 'exam-saved-banner';
    const updated = savedSession.updatedAt ? new Date(savedSession.updatedAt).toLocaleString() : null;
    banner.textContent = updated ? `Saved attempt • ${updated}` : 'Saved attempt available';
    details.appendChild(banner);
  }

  const attemptsWrap = document.createElement('div');
  attemptsWrap.className = 'exam-attempts';
  const attemptsHeader = document.createElement('div');
  attemptsHeader.className = 'exam-attempts-header';
  const attemptsTitle = document.createElement('h3');
  attemptsTitle.textContent = 'Attempts';
  attemptsHeader.appendChild(attemptsTitle);
  const attemptsCount = document.createElement('span');
  attemptsCount.className = 'exam-attempt-count';
  attemptsCount.textContent = String(exam.results.length);
  attemptsHeader.appendChild(attemptsCount);
  attemptsWrap.appendChild(attemptsHeader);

  if (!exam.results.length) {
    const none = document.createElement('p');
    none.className = 'exam-attempt-empty';
    none.textContent = 'No attempts yet.';
    attemptsWrap.appendChild(none);
  } else {
    const list = document.createElement('div');
    list.className = 'exam-attempt-list';
    [...exam.results]
      .sort((a, b) => b.when - a.when)
      .forEach(result => {
        list.appendChild(buildAttemptRow(exam, result, render));
      });
    attemptsWrap.appendChild(list);
  }

  details.appendChild(attemptsWrap);

  const setExpandedState = expanded => {
    card.classList.toggle('exam-card--expanded', expanded);
    details.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    caret.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    caret.setAttribute('aria-label', expanded ? 'Collapse exam details' : 'Expand exam details');
  };

  setExpandedState(isExpanded);

  caret.addEventListener('click', event => {
    event.stopPropagation();
    const nextExpanded = !card.classList.contains('exam-card--expanded');
    if (nextExpanded) {
      state.examAttemptExpanded = {};
    }
    setExamAttemptExpanded(exam.id, nextExpanded);
    const gridEl = card.closest('.exam-grid');
    if (gridEl) {
      gridEl.querySelectorAll('.exam-card--expanded').forEach(other => {
        if (other === card) return;
        other.classList.remove('exam-card--expanded');
        const otherDetails = other.querySelector('.exam-card-details');
        if (otherDetails) {
          otherDetails.setAttribute('aria-hidden', 'true');
        }
        const otherCaret = other.querySelector('.exam-card-caret');
        if (otherCaret) {
          otherCaret.setAttribute('aria-expanded', 'false');
          otherCaret.setAttribute('aria-label', 'Expand exam details');
        }
      });
    }
    setExpandedState(nextExpanded);
  });

  return card;
}

function buildAttemptRow(exam, result, render) {
  const row = document.createElement('div');
  row.className = 'exam-attempt-row';
  const isIncorrectReview = Array.isArray(result.subsetIndices) && result.subsetIndices.length > 0;
  if (isIncorrectReview) {
    row.classList.add('exam-attempt-row--incorrect-review');
  }

  const wrongIndices = incorrectQuestionIndices(exam, result);

  const main = document.createElement('div');
  main.className = 'exam-attempt-main';
  row.appendChild(main);

  const badge = createScoreBadge(result);
  badge.classList.add('exam-score-badge--pill', 'exam-attempt-score');
  badge.title = formatScore(result);
  main.appendChild(badge);

  const details = document.createElement('div');
  details.className = 'exam-attempt-details';
  main.appendChild(details);

  const date = document.createElement('div');
  date.className = 'exam-attempt-date';
  date.textContent = new Date(result.when).toLocaleString();
  details.appendChild(date);

  const meta = document.createElement('div');
  meta.className = 'exam-attempt-meta';
  const answeredText = `${result.answered}/${result.total} answered`;
  const flaggedText = `${result.flagged.length} flagged`;
  const durationText = result.durationMs ? formatDuration(result.durationMs) : '—';
  meta.textContent = `${answeredText} • ${flaggedText} • ${durationText}`;
  details.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'exam-attempt-actions';
  row.appendChild(actions);

  const review = document.createElement('button');
  review.className = 'btn secondary exam-attempt-review';
  if (isIncorrectReview) {
    review.classList.add('exam-attempt-review--incorrect');
  }
  review.textContent = 'Review';
  review.addEventListener('click', () => {
    const reviewPacket = resolveReviewPacket(exam, result);
    setExamSession({ mode: 'review', exam: clone(reviewPacket.exam), result: clone(reviewPacket.result), idx: 0 });
    render();
  });
  actions.appendChild(review);

  const retakeIncorrect = document.createElement('button');
  retakeIncorrect.className = 'btn secondary exam-attempt-retake';
  retakeIncorrect.textContent = 'Retake Incorrect';
  retakeIncorrect.disabled = wrongIndices.length === 0;
  retakeIncorrect.addEventListener('click', () => {
    const subset = subsetExamForIndices(exam, null, wrongIndices);
    if (!subset) return;
    const session = createTakingSession(subset.exam);
    session.baseExam = clone(exam);
    session.subsetIndices = [...wrongIndices];
    setExamSession(session);
    render();
  });
  actions.appendChild(retakeIncorrect);

  const removeAttempt = document.createElement('button');
  removeAttempt.className = 'btn secondary exam-attempt-delete';
  removeAttempt.textContent = 'Delete';
  removeAttempt.addEventListener('click', async () => {
    const confirm = await confirmModal('Delete this attempt? This will reset answered status for those questions.');
    if (!confirm) return;
    const nextResults = (exam.results || []).filter(entry => entry !== result);
    await upsertExam({ ...exam, results: nextResults, updatedAt: Date.now() });
    render();
  });
  actions.appendChild(removeAttempt);

  return row;
}

function createStat(label, value) {
  const wrap = document.createElement('div');
  wrap.className = 'exam-stat';
  const lbl = document.createElement('div');
  lbl.className = 'exam-stat-label';
  lbl.textContent = label;
  const val = document.createElement('div');
  val.className = 'exam-stat-value';
  val.textContent = value;
  wrap.appendChild(lbl);
  wrap.appendChild(val);
  return wrap;
}

function latestResult(exam) {
  if (!exam.results?.length) return null;
  return exam.results.reduce((acc, res) => (acc == null || res.when > acc.when ? res : acc), null);
}

function bestResult(exam) {
  if (!exam.results?.length) return null;
  return exam.results.reduce((acc, res) => {
    const pct = res.total ? res.correct / res.total : 0;
    const bestPct = acc?.total ? acc.correct / acc.total : -1;
    if (!acc || pct > bestPct) return res;
    return acc;
  }, null);
}

function formatScore(result) {
  const pct = result.total ? Math.round((result.correct / result.total) * 100) : 0;
  return `${result.correct}/${result.total} • ${pct}%`;
}

function formatDuration(ms) {
  if (ms == null) return '—';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function optionText(question, id) {
  const html = question.options.find(opt => opt.id === id)?.text || '';
  return htmlToPlainText(html).trim();
}

function optionHtml(question, id) {
  const html = question.options.find(opt => opt.id === id)?.text || '';
  return sanitizeRichText(html);
}

function mediaElement(source) {
  if (!source) return null;
  const wrap = document.createElement('div');
  wrap.className = 'exam-media';
  const lower = source.toLowerCase();
  if (lower.startsWith('data:video') || /\.(mp4|webm|ogg)$/i.test(lower)) {
    const video = document.createElement('video');
    video.controls = true;
    video.src = source;
    wrap.appendChild(video);
  } else if (lower.startsWith('data:audio') || /\.(mp3|wav|ogg)$/i.test(lower)) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = source;
    wrap.appendChild(audio);
  } else {
    const img = document.createElement('img');
    img.src = source;
    img.alt = 'Question media';
    img.classList.add('exam-zoomable-media');
    wrap.appendChild(img);
  }
  return wrap;
}

function toggleExamImageZoom(img) {
  if (!img) return;
  const nextState = !img.classList.contains('exam-zoomed');
  img.classList.toggle('exam-zoomed', nextState);
  img.setAttribute('aria-expanded', nextState ? 'true' : 'false');
}

function enhanceExamMedia(container) {
  if (!container) return;
  const selectors = [
    '.exam-media img',
    '.exam-stem img',
    '.exam-option .option-text img',
    '.exam-explanation-body img',
    '.exam-answer-html img'
  ];
  const images = container.querySelectorAll(selectors.join(', '));
  images.forEach(img => {
    img.classList.add('exam-zoomable-media');
    img.addEventListener('dblclick', () => toggleExamImageZoom(img));
  });
}

function answerClass(question, selectedId, optionId) {
  const isCorrect = optionId === question.answer;
  if (selectedId == null) return isCorrect ? 'correct-answer' : '';
  if (selectedId === optionId) {
    return selectedId === question.answer ? 'correct-answer' : 'incorrect-answer';
  }
  return isCorrect ? 'correct-answer' : '';
}

function evaluateQuestionAnswer(question, answer) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const responded = answer != null && answer !== '';
  if (!responded) {
    return {
      responded: false,
      isValid: false,
      isCorrect: false
    };
  }
  const matchedOption = options.find(opt => opt.id === answer) || null;
  const isValid = Boolean(matchedOption);
  const isCorrect = isValid && matchedOption?.id === question?.answer;
  return {
    responded: true,
    isValid,
    isCorrect
  };
}

function incorrectQuestionIndices(exam, result) {
  if (!exam || !result) return [];
  const questions = Array.isArray(exam.questions) ? exam.questions : [];
  const subsetIndices = Array.isArray(result.subsetIndices)
    ? result.subsetIndices.filter(idx => Number.isInteger(idx) && idx >= 0 && idx < questions.length)
    : null;
  const indices = subsetIndices && subsetIndices.length
    ? subsetIndices
    : questions.map((_, idx) => idx);
  return indices.reduce((list, idx) => {
    const question = questions[idx];
    const ans = result.answers?.[idx];
    if (ans == null || ans !== question?.answer) {
      list.push(idx);
    }
    return list;
  }, []);
}

function subsetExamForIndices(exam, result, indices) {
  const valid = Array.isArray(indices)
    ? indices.filter(idx => Number.isInteger(idx) && idx >= 0 && idx < (exam?.questions?.length || 0))
    : [];
  if (!exam || !valid.length) return null;

  const baseQuestions = Array.isArray(exam.questions) ? exam.questions : [];
  const nextExam = clone(exam);
  nextExam.questions = valid.map(idx => ({ ...clone(baseQuestions[idx]), originalIndex: idx }));

  if (!result) return { exam: nextExam };

  const nextResult = clone(result) || {};
  nextResult.answers = {};
  nextResult.flagged = [];
  nextResult.questionStats = [];

  let answered = 0;
  let correct = 0;

  valid.forEach((origIdx, newIdx) => {
    const answer = result.answers?.[origIdx];
    if (answer != null) {
      nextResult.answers[newIdx] = answer;
      answered += 1;
      if (answer === baseQuestions[origIdx]?.answer) {
        correct += 1;
      }
    }

    if (Array.isArray(result.flagged) && result.flagged.includes(origIdx)) {
      nextResult.flagged.push(newIdx);
    }

    const stat = Array.isArray(result.questionStats) ? clone(result.questionStats[origIdx]) : null;
    nextResult.questionStats[newIdx] = stat || {
      timeMs: 0,
      changes: [],
      enteredAt: null,
      initialAnswer: null,
      initialAnswerAt: null
    };
  });

  nextResult.total = nextExam.questions.length;
  nextResult.correct = correct;
  nextResult.answered = answered;
  nextResult.changeSummary = summarizeAnswerChanges(nextResult.questionStats, nextExam, nextResult.answers);

  return { exam: nextExam, result: nextResult };
}

function resolveReviewPacket(exam, result) {
  if (!exam || !result) return { exam, result };
  if (Array.isArray(result.subsetIndices) && result.subsetIndices.length) {
    const subset = subsetExamForIndices(exam, result, result.subsetIndices);
    if (subset) return subset;
  }
  return { exam, result };
}

function renderQuestionMap(sidebar, sess, render) {
  const map = document.createElement('section');
  map.className = 'question-map';

  const header = document.createElement('div');
  header.className = 'question-map__header';
  const title = document.createElement('h3');
  title.textContent = 'Question Map';
  header.appendChild(title);

  const questionCount = sess.exam.questions.length;
  const isReview = sess.mode === 'review';
  const answers = isReview ? sess.result?.answers || {} : sess.answers || {};
  const answeredCount = sess.exam.questions.reduce((count, question, idx) => {
    const answer = answers[idx];
    const evaluation = evaluateQuestionAnswer(question, answer);
    return evaluation.responded ? count + 1 : count;
  }, 0);
  const countBadge = document.createElement('span');
  countBadge.className = 'question-map__count';
  countBadge.textContent = `${answeredCount}/${questionCount} answered`;
  header.appendChild(countBadge);
  map.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'question-map__grid';
  map.appendChild(grid);

  const statsList = isReview
    ? (Array.isArray(sess.result?.questionStats) ? sess.result.questionStats : [])
    : (Array.isArray(sess.questionStats) ? sess.questionStats : []);
  const summary = isReview ? summarizeAnswerChanges(statsList, sess.exam, answers) : null;
  if (isReview && sess.result) {
    sess.result.changeSummary = summary;
  }

  const flaggedSet = new Set(sess.mode === 'review'
    ? (sess.result.flagged || [])
    : Object.entries(sess.flagged || {}).filter(([_, v]) => v).map(([idx]) => Number(idx)));

  sess.exam.questions.forEach((question, idx) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'question-map__item';
    const number = document.createElement('span');
    number.className = 'question-map__item-label';
    number.textContent = String(idx + 1);
    item.appendChild(number);
    const flagIndicator = document.createElement('span');
    flagIndicator.className = 'question-map__item-flag';
    flagIndicator.setAttribute('aria-hidden', 'true');
    flagIndicator.textContent = '🚩';
    item.appendChild(flagIndicator);
    const isCurrent = sess.idx === idx;
    item.classList.toggle('is-current', isCurrent);
    item.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
    if (isCurrent) {
      item.setAttribute('aria-current', 'true');
    } else {
      item.removeAttribute('aria-current');
    }

    const answer = answers[idx];
    const evaluation = evaluateQuestionAnswer(question, answer);
    const { responded, isValid, isCorrect } = evaluation;
    const tooltipParts = [];
    const labelParts = [`Question ${idx + 1}`];
    let status = 'unanswered';
    const wasChecked = !isReview && Boolean(sess.checked?.[idx]);

    if (isReview) {
      if (!responded) {
        status = 'review-unanswered';
        tooltipParts.push('Not answered');
      } else if (!isValid) {
        status = 'invalid';
        tooltipParts.push('Answered (option removed)');
      } else {
        status = isCorrect ? 'correct' : 'incorrect';
        tooltipParts.push(isCorrect ? 'Answered correctly' : 'Answered incorrectly');
      }

      const stat = statsList[idx];
      const changeDetails = analyzeAnswerChange(stat, question, answer);
      delete item.dataset.changeDirection;
      if (changeDetails.changed) {
        if (changeDetails.direction === 'right-to-wrong') {
          item.dataset.changeDirection = 'right-to-wrong';
          tooltipParts.push('Changed from correct to incorrect');
        } else if (changeDetails.direction === 'wrong-to-right') {
          item.dataset.changeDirection = 'wrong-to-right';
          tooltipParts.push('Changed from incorrect to correct');
        } else {
          item.dataset.changeDirection = 'changed';
          tooltipParts.push('Changed answer');
        }
      } else if (changeDetails.switched) {
        item.dataset.changeDirection = 'returned';
        tooltipParts.push('Changed answers but returned to start');
      }
    } else {
      if (!responded) {
        tooltipParts.push(wasChecked ? 'Checked without answer' : 'Not answered');
      } else if (!isValid) {
        status = 'invalid';
        tooltipParts.push('Answer no longer matches options');
      } else if (wasChecked) {
        status = isCorrect ? 'correct' : 'incorrect';
        tooltipParts.push(isCorrect ? 'Checked correct' : 'Checked incorrect');
      } else {
        status = 'answered';
        tooltipParts.push('Answered');
      }
    }

    item.dataset.status = status;
    if (status === 'correct' || status === 'incorrect') {
      item.classList.add('is-graded');
    } else if (status === 'answered') {
      item.classList.add('is-answered');
    } else if (status === 'invalid') {
      item.classList.add('is-invalid');
    } else {
      item.classList.add('is-unanswered');
    }
    if (status === 'review-unanswered') {
      item.classList.add('is-review-unanswered');
    }

    if (status === 'invalid') {
      labelParts.push('Answer needs review');
    }

    if (tooltipParts.length) {
      labelParts.push(...tooltipParts);
    }

    const flagged = flaggedSet.has(idx);
    if (flagged) {
      item.dataset.flagged = 'true';
      flagIndicator.hidden = false;
      labelParts.push('Flagged');
    } else {
      delete item.dataset.flagged;
      flagIndicator.hidden = true;
    }

    if (isCurrent) {
      labelParts.push('Current question');
    }

    if (tooltipParts.length) {
      item.title = tooltipParts.join(' · ');
    }

    item.setAttribute('aria-label', labelParts.join(', '));

    item.addEventListener('click', () => {
      navigateToQuestion(sess, idx, render);
    });

    grid.appendChild(item);
  });

  if (summary) {
    const meta = document.createElement('div');
    meta.className = 'question-map__summary';
    const summaryTitle = document.createElement('div');
    summaryTitle.className = 'question-map__summary-title';
    summaryTitle.textContent = 'Answer changes';
    meta.appendChild(summaryTitle);

    const summaryStats = document.createElement('div');
    summaryStats.className = 'question-map__summary-stats';
    summaryStats.innerHTML = `
      <span><strong>${summary.switched}</strong> switched</span>
      <span><strong>${summary.returnedToOriginal}</strong> returned</span>
      <span><strong>${summary.rightToWrong}</strong> right → wrong</span>
      <span><strong>${summary.wrongToRight}</strong> wrong → right</span>
    `;
    meta.appendChild(summaryStats);
    map.appendChild(meta);
  }

  sidebar.appendChild(map);
  return summary;
}

export function renderExamRunner(root, render) {
  const sess = state.examSession;
  if (!sess) {
    teardownKeyboardNavigation();
    return;
  }
  if (sess.mode === 'review' && !sess.result) {
    teardownKeyboardNavigation();
    root.innerHTML = '';
    root.className = 'tab-content exam-session';
    const empty = document.createElement('div');
    empty.className = 'exam-empty';
    empty.innerHTML = '<p>This review session is missing data.</p>';
    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = 'Back to Exams';
    back.addEventListener('click', () => { setExamSession(null); render(); });
    empty.appendChild(back);
    root.appendChild(empty);
    return;
  }
  const hasWindow = typeof window !== 'undefined';
  const prevIdx = sess.__lastRenderedIdx;
  const prevMode = sess.__lastRenderedMode;
  const hasPendingScroll = Boolean(sess.__pendingScrollRestore);
  const prevScroller = resolveScrollContainer(root);
  const prevScrollY = hasPendingScroll
    ? Number(sess.__lastKnownScrollY) || 0
    : readScrollPosition(prevScroller);
  const questionChanged = typeof prevIdx === 'number' ? prevIdx !== sess.idx : false;
  if (prevScroller && questionChanged && typeof prevIdx === 'number' && !hasPendingScroll) {
    storeScrollPosition(sess, prevIdx, prevScrollY);
  } else if (prevScroller && !questionChanged && typeof prevIdx !== 'number' && typeof sess.idx === 'number' && !hasPendingScroll) {
    storeScrollPosition(sess, sess.idx, prevScrollY);
  }
  if (!questionChanged) {
    captureExamMediaState(sess);
  }
  root.innerHTML = '';
  root.className = 'tab-content exam-session';

  if (sess.mode === 'summary') {
    teardownKeyboardNavigation();
    renderSummary(root, render, sess);
    return;
  }

  ensureScrollPositions(sess);
  setupKeyboardNavigation(sess, render);

  if (!sess.answers) sess.answers = {};
  if (!sess.flagged) sess.flagged = {};
  if (!sess.checked) sess.checked = {};
  if (typeof sess.elapsedMs !== 'number') sess.elapsedMs = 0;
  if (sess.exam.timerMode === 'timed' && typeof sess.remainingMs !== 'number') {
    sess.remainingMs = totalExamTimeMs(sess.exam);
  }
  if (!sess.startedAt) sess.startedAt = Date.now();

  const questionCount = sess.exam.questions.length;
  if (!questionCount) {
    const empty = document.createElement('div');
    empty.className = 'exam-empty';
    empty.innerHTML = '<p>This exam does not contain any questions.</p>';
    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = 'Back to Exams';
    back.addEventListener('click', () => { teardownKeyboardNavigation(); setExamSession(null); render(); });
    empty.appendChild(back);
    root.appendChild(empty);
    return;
  }

  if (sess.mode === 'taking' && sess.exam.timerMode === 'timed') {
    ensureTimer(sess, render);
  }

  if (sess.idx < 0) sess.idx = 0;
  if (sess.idx >= questionCount) sess.idx = questionCount - 1;

  ensureQuestionStats(sess);
  if (sess.mode === 'taking') {
    beginQuestionTiming(sess, sess.idx);
  }

  const container = document.createElement('div');
  container.className = 'exam-runner';
  root.appendChild(container);

  const main = document.createElement('section');
  main.className = 'exam-main';
  container.appendChild(main);

  const sidebar = document.createElement('aside');
  sidebar.className = 'exam-sidebar';
  container.appendChild(sidebar);

  const questionCard = document.createElement('div');
  questionCard.className = 'exam-question-card';
  main.appendChild(questionCard);

  const question = sess.exam.questions[sess.idx];
  const answers = sess.mode === 'review' ? sess.result.answers || {} : sess.answers || {};
  const selected = answers[sess.idx];
  const isInstantCheck = sess.mode === 'taking' && sess.exam.timerMode !== 'timed' && Boolean(sess.checked?.[sess.idx]);
  const showReview = sess.mode === 'review' || isInstantCheck;

  const top = document.createElement('div');
  top.className = 'exam-topbar';
  const progress = document.createElement('div');
  progress.className = 'exam-progress';
  progress.textContent = `${sess.exam.examTitle} • Question ${sess.idx + 1} of ${questionCount}`;
  top.appendChild(progress);

  const flagBtn = document.createElement('button');
  flagBtn.type = 'button';
  flagBtn.className = 'flag-btn';
  const isFlagged = sess.mode === 'review'
    ? (sess.result.flagged || []).includes(sess.idx)
    : Boolean(sess.flagged?.[sess.idx]);
  setToggleState(flagBtn, isFlagged);
  flagBtn.textContent = isFlagged ? '🚩 Flagged' : 'Flag question';
  if (sess.mode === 'taking') {
    flagBtn.addEventListener('click', () => {
      if (!sess.flagged) sess.flagged = {};
      sess.flagged[sess.idx] = !isFlagged;
      captureExamScroll(sess);
      render();
    });
  } else {
    flagBtn.disabled = true;
  }
  top.appendChild(flagBtn);

  if (sess.mode === 'taking' && sess.exam.timerMode === 'timed') {
    const timerEl = document.createElement('div');
    timerEl.className = 'exam-timer';
    const remainingMs = typeof sess.remainingMs === 'number' ? sess.remainingMs : totalExamTimeMs(sess.exam);
    timerEl.textContent = formatCountdown(remainingMs);
    setTimerElement(sess, timerEl);
    top.appendChild(timerEl);
  } else {
    setTimerElement(sess, null);
  }
  if (sess.mode === 'review') {
    const exitReview = document.createElement('button');
    exitReview.type = 'button';
    exitReview.className = 'btn secondary exam-top-exit';
    if (sess.fromSummary) {
      exitReview.textContent = 'Back to Summary';
      exitReview.addEventListener('click', () => {
        setExamSession({ mode: 'summary', exam: sess.exam, latestResult: sess.fromSummary });
        render();
      });
    } else {
      exitReview.textContent = 'Back to Exams';
      exitReview.addEventListener('click', () => { teardownKeyboardNavigation(); setExamSession(null); render(); });
    }
    top.appendChild(exitReview);
  }
  questionCard.appendChild(top);

  const stem = document.createElement('div');
  stem.className = 'exam-stem';
  const stemHtml = question.stem && !isEmptyHtml(question.stem) ? question.stem : '';
  stem.innerHTML = stemHtml || '<p class="exam-stem-empty">(No prompt)</p>';
  questionCard.appendChild(stem);

  const media = mediaElement(question.media);
  if (media) questionCard.appendChild(media);

  if (question.tags?.length) {
    const tagWrap = document.createElement('div');
    tagWrap.className = 'exam-tags';
    question.tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'exam-tag';
      chip.textContent = tag;
      tagWrap.appendChild(chip);
    });
    questionCard.appendChild(tagWrap);
  }

  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'exam-options';
  if (!question.options.length) {
    const warn = document.createElement('p');
    warn.className = 'exam-warning';
    warn.textContent = 'This question has no answer options.';
    optionsWrap.appendChild(warn);
  }

  question.options.forEach(opt => {
    const choice = document.createElement(sess.mode === 'taking' ? 'button' : 'div');
    if (sess.mode === 'taking') choice.type = 'button';
    choice.className = 'exam-option';
    if (sess.mode === 'review') choice.classList.add('review');

    const indicator = document.createElement('span');
    indicator.className = 'option-indicator';
    choice.appendChild(indicator);

    const label = document.createElement('span');
    label.className = 'option-text';
    label.innerHTML = opt.text || '<span class="exam-option-empty">(Empty option)</span>';
    choice.appendChild(label);
    const isSelected = selected === opt.id;
    if (sess.mode === 'taking') {
      setToggleState(choice, isSelected, 'selected');
      choice.addEventListener('click', () => {
        recordAnswerChange(sess, sess.idx, question, opt.id);
        sess.answers[sess.idx] = opt.id;
        if (sess.exam.timerMode !== 'timed' && sess.checked) {
          delete sess.checked[sess.idx];
        }
        captureExamScroll(sess);
        render();
      });
      if (isInstantCheck) {
        const cls = answerClass(question, selected, opt.id);
        if (cls) choice.classList.add(cls);
        if (isSelected) choice.classList.add('chosen');
      }
    } else {
      const cls = answerClass(question, selected, opt.id);
      if (cls) choice.classList.add(cls);
      if (isSelected) choice.classList.add('chosen');
    }
    optionsWrap.appendChild(choice);
  });

  questionCard.appendChild(optionsWrap);

  let explanationPanel = null;
  if (showReview) {
    const verdict = document.createElement('div');
    verdict.className = 'exam-verdict';
    let verdictText = 'Not answered';
    let verdictClass = 'neutral';
    if (selected != null) {
      if (selected === question.answer) {
        verdictText = 'Correct';
        verdictClass = 'correct';
      } else {
        verdictText = 'Incorrect';
        verdictClass = 'incorrect';
      }
    }
    verdict.classList.add(verdictClass);
    verdict.textContent = sess.mode === 'review' ? verdictText : `Checked: ${verdictText}`;
    questionCard.appendChild(verdict);

    const answerSummary = document.createElement('div');
    answerSummary.className = 'exam-answer-summary';

    const answerSummaryList = document.createElement('div');
    answerSummaryList.className = 'exam-answer-summary-list';

    const renderAnswerRow = (labelText, html) => {
      const row = document.createElement('div');
      row.className = 'exam-answer-row';
      const label = document.createElement('strong');
      label.textContent = `${labelText}:`;
      row.appendChild(label);
      const body = document.createElement('div');
      body.className = 'exam-answer-html';
      const safeHtml = html && !isEmptyHtml(html) ? html : '<em>—</em>';
      body.innerHTML = safeHtml;
      row.appendChild(body);
      return row;
    };

    answerSummaryList.appendChild(renderAnswerRow('Your answer', optionHtml(question, selected)));
    answerSummaryList.appendChild(renderAnswerRow('Correct answer', optionHtml(question, question.answer)));

    answerSummary.appendChild(answerSummaryList);
    questionCard.appendChild(answerSummary);

    if (sess.mode === 'review') {
      const stats = sess.result?.questionStats?.[sess.idx];
      if (stats) {
        const insights = document.createElement('div');
        insights.className = 'exam-review-insights';
        const timeSpent = document.createElement('div');
        timeSpent.innerHTML = `<strong>Time spent:</strong> ${formatDuration(stats.timeMs)}`;
        insights.appendChild(timeSpent);

        const finalAnswer = sess.result?.answers?.[sess.idx];
        const changeDetails = analyzeAnswerChange(stats, question, finalAnswer);

        if (changeDetails.switched) {
          const changeInfo = document.createElement('div');
          const label = document.createElement('strong');
          label.textContent = 'Answer change:';
          changeInfo.appendChild(label);
          changeInfo.append(' ');

          const joinChoices = list => {
            if (!list.length) return '';
            if (list.length === 1) return list[0];
            return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
          };

          const formatChoice = (answerId, fallback) => {
            if (answerId == null) return fallback;
            const label = optionText(question, answerId);
            if (label) return `"${label}"`;
            return fallback;
          };
          const initialDisplay = formatChoice(changeDetails.initialAnswer, 'your original choice');
          const finalDisplay = formatChoice(changeDetails.finalAnswer, 'no answer');
          let message = '';

          if (changeDetails.changed) {
            if (changeDetails.direction === 'right-to-wrong') {
              message = `You changed from ${initialDisplay} (correct) to ${finalDisplay} (incorrect).`;
            } else if (changeDetails.direction === 'wrong-to-right') {
              message = `You changed from ${initialDisplay} (incorrect) to ${finalDisplay} (correct).`;
            } else if (changeDetails.initialCorrect === false && changeDetails.finalCorrect === false) {
              message = `You changed from ${initialDisplay} to ${finalDisplay}, but both choices were incorrect.`;
            } else {
              message = `You changed from ${initialDisplay} to ${finalDisplay}.`;
            }
          } else {
            const intermediateIds = [];
            changeDetails.sequence.slice(1, -1).forEach(id => {
              if (id == null) return;
              if (id === changeDetails.initialAnswer) return;
              if (!intermediateIds.includes(id)) intermediateIds.push(id);
            });
            const intermediateLabels = intermediateIds
              .map(id => optionText(question, id))
              .filter(label => label && label.trim().length)
              .map(label => `"${label}"`);
            if (intermediateLabels.length) {
              const joined = joinChoices(intermediateLabels);
              message = `You tried ${joined} but returned to ${initialDisplay}.`;
            } else {
              message = `You briefly changed your answer but returned to ${initialDisplay}.`;
            }
          }

          changeInfo.append(message);
          insights.appendChild(changeInfo);
        }
        questionCard.appendChild(insights);
      }
    }

    if (question.explanation && !isEmptyHtml(question.explanation)) {
      const explain = document.createElement('div');
      explain.className = 'exam-explanation';
      const title = document.createElement('h3');
      title.textContent = 'Explanation';
      const body = document.createElement('div');
      body.className = 'exam-explanation-body';
      body.innerHTML = question.explanation;
      explain.appendChild(title);
      explain.appendChild(body);
      explanationPanel = explain;
    }
  }

  if (explanationPanel) {
    main.appendChild(explanationPanel);
  }

  enhanceExamMedia(main);
  restoreExamMediaState(sess, main);

  const paletteSummary = renderQuestionMap(sidebar, sess, render);
  renderSidebarMeta(sidebar, sess, paletteSummary);

  const nav = document.createElement('div');
  nav.className = 'exam-nav';
  const navStart = document.createElement('div');
  navStart.className = 'exam-nav-group exam-nav-group--start';
  const navMiddle = document.createElement('div');
  navMiddle.className = 'exam-nav-group exam-nav-group--middle';
  const navEnd = document.createElement('div');
  navEnd.className = 'exam-nav-group exam-nav-group--end';

  const prev = document.createElement('button');
  prev.className = 'btn secondary exam-nav-arrow';
  prev.setAttribute('aria-label', 'Previous question');
  prev.textContent = '←';
  prev.disabled = sess.idx === 0;
  prev.addEventListener('click', () => {
    if (sess.idx > 0) {
      navigateToQuestion(sess, sess.idx - 1, render);
    }
  });
  navStart.appendChild(prev);

  if (sess.mode === 'taking') {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn secondary exam-nav-arrow';
    nextBtn.setAttribute('aria-label', 'Next question');
    nextBtn.textContent = '→';
    nextBtn.disabled = sess.idx >= questionCount - 1;
    nextBtn.addEventListener('click', () => {
      if (sess.idx < questionCount - 1) {
        navigateToQuestion(sess, sess.idx + 1, render);
      }
    });
    navStart.appendChild(nextBtn);

    if (sess.exam.timerMode !== 'timed') {
      const checkBtn = document.createElement('button');
      checkBtn.className = 'btn secondary';
      checkBtn.textContent = isInstantCheck ? 'Hide Check' : 'Check Answer';
      checkBtn.disabled = question.options.length === 0;
      checkBtn.addEventListener('click', () => {
        if (!sess.checked) sess.checked = {};
        if (isInstantCheck) {
          delete sess.checked[sess.idx];
        } else {
          sess.checked[sess.idx] = true;
        }
        captureExamScroll(sess);
        render();
      });
      navMiddle.appendChild(checkBtn);
    }

    const submit = document.createElement('button');
    submit.className = 'btn';
    submit.textContent = 'Submit Exam';
    submit.addEventListener('click', async () => {
      await finalizeExam(sess, render);
    });
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn secondary';
    saveBtn.textContent = 'Save & Exit';
    saveBtn.addEventListener('click', async () => {
      await saveProgressAndExit(sess, render);
    });
    navEnd.appendChild(saveBtn);
    navEnd.appendChild(submit);
  } else {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn secondary exam-nav-arrow';
    nextBtn.setAttribute('aria-label', 'Next question');
    nextBtn.textContent = '→';
    nextBtn.disabled = sess.idx >= questionCount - 1;
    nextBtn.addEventListener('click', () => {
      if (sess.idx < questionCount - 1) {
        navigateToQuestion(sess, sess.idx + 1, render);
      }
    });
    navStart.appendChild(nextBtn);

    const exit = document.createElement('button');
    exit.className = 'btn';
    if (sess.fromSummary) {
      exit.textContent = 'Back to Summary';
      exit.addEventListener('click', () => {
        setExamSession({ mode: 'summary', exam: sess.exam, latestResult: sess.fromSummary });
        render();
      });
    } else {
      exit.textContent = 'Back to Exams';
      exit.addEventListener('click', () => { teardownKeyboardNavigation(); setExamSession(null); render(); });
    }
    navEnd.appendChild(exit);
  }

  nav.appendChild(navStart);
  nav.appendChild(navMiddle);
  nav.appendChild(navEnd);

  main.appendChild(nav);

  const scroller = resolveScrollContainer(root);
  const sameQuestion = prevIdx === sess.idx && prevMode === sess.mode;
  sess.__lastRenderedIdx = sess.idx;
  sess.__lastRenderedMode = sess.mode;
  const queueFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? cb => window.requestAnimationFrame(cb)
    : cb => setTimeout(cb, 0);
  if (scroller) {
    if (sameQuestion) {
      const storedScroll = getStoredScroll(sess, sess.idx);
      const targetY = storedScroll ?? prevScrollY ?? 0;
      storeScrollPosition(sess, sess.idx, targetY);
      applyScrollPosition(scroller, targetY);
    } else {
      const storedScroll = getStoredScroll(sess, sess.idx);
      const targetY = storedScroll ?? 0;
      if (typeof sess.idx === 'number' && storedScroll == null) {
        storeScrollPosition(sess, sess.idx, targetY);
      }
      const restore = () => {
        applyScrollPosition(scroller, targetY);
      };
      queueFrame(restore);
    }
  }
  sess.__pendingScrollRestore = false;
}
function renderSidebarMeta(sidebar, sess, changeSummary) {
  const info = document.createElement('div');
  info.className = 'exam-sidebar-info';

  const attempts = document.createElement('div');
  attempts.innerHTML = `<strong>Attempts:</strong> ${sess.exam.results?.length || 0}`;
  info.appendChild(attempts);

  if (sess.mode === 'review') {
    if (sess.result.durationMs) {
      const duration = document.createElement('div');
      duration.innerHTML = `<strong>Duration:</strong> ${formatDuration(sess.result.durationMs)}`;
      info.appendChild(duration);
    }
    const summary = changeSummary
      || (sess.result ? summarizeAnswerChanges(sess.result.questionStats || [], sess.exam, sess.result.answers || {}) : null);
    if (summary) {
      const changeMeta = document.createElement('div');
      changeMeta.innerHTML = `<strong>Answer switches:</strong> ${summary.switched || 0} (Returned: ${summary.returnedToOriginal || 0}, Right → Wrong: ${summary.rightToWrong || 0}, Wrong → Right: ${summary.wrongToRight || 0})`;
      info.appendChild(changeMeta);
    }
  } else if (sess.mode === 'taking') {
    if (sess.exam.timerMode === 'timed') {
      const remaining = typeof sess.remainingMs === 'number' ? sess.remainingMs : totalExamTimeMs(sess.exam);
      const timer = document.createElement('div');
      timer.innerHTML = `<strong>Time Remaining:</strong> ${formatCountdown(remaining)}`;
      info.appendChild(timer);

      const pace = document.createElement('div');
      pace.innerHTML = `<strong>Pace:</strong> ${sess.exam.secondsPerQuestion}s/question`;
      info.appendChild(pace);
    } else {
      const timerMode = document.createElement('div');
      timerMode.innerHTML = '<strong>Timer:</strong> Untimed';
      info.appendChild(timerMode);

      const elapsed = document.createElement('div');
      elapsed.innerHTML = `<strong>Elapsed:</strong> ${formatDuration(currentElapsedMs(sess))}`;
      info.appendChild(elapsed);
    }
  }

  sidebar.appendChild(info);
}

async function saveProgressAndExit(sess, render) {
  stopTimer(sess);
  const questionStats = snapshotQuestionStats(sess);
  const payload = {
    examId: sess.exam.id,
    exam: clone(sess.exam),
    idx: sess.idx,
    answers: { ...(sess.answers || {}) },
    flagged: { ...(sess.flagged || {}) },
    checked: { ...(sess.checked || {}) },
    remainingMs: typeof sess.remainingMs === 'number' ? Math.max(0, sess.remainingMs) : null,
    elapsedMs: sess.elapsedMs || 0,
    mode: 'taking',
    baseExam: sess.baseExam ? clone(sess.baseExam) : null,
    subsetIndices: Array.isArray(sess.subsetIndices) ? [...sess.subsetIndices] : null,
    questionStats
  };
  await saveExamSessionProgress(payload);
  lastExamStatusMessage = 'Attempt saved. You can resume later.';
  teardownKeyboardNavigation();
  setExamSession(null);
  render();
}

async function finalizeExam(sess, render, options = {}) {
  const isAuto = Boolean(options.autoSubmit);
  stopTimer(sess);

  const unanswered = sess.exam.questions
    .map((_, idx) => (sess.answers[idx] == null ? idx + 1 : null))
    .filter(Number.isFinite);
  if (!isAuto && unanswered.length) {
    const list = unanswered.join(', ');
    const confirm = await confirmModal(`You have ${unanswered.length} unanswered question${unanswered.length === 1 ? '' : 's'} (Question${unanswered.length === 1 ? '' : 's'}: ${list}). Submit anyway?`);
    if (!confirm) return;
  }

  const answers = {};
  let correct = 0;
  let answeredCount = 0;
  const indexForQuestion = idx => {
    const question = sess.exam.questions?.[idx];
    const originalIndex = Number.isInteger(question?.originalIndex) ? question.originalIndex : null;
    return originalIndex ?? idx;
  };
  sess.exam.questions.forEach((question, idx) => {
    const ans = sess.answers[idx];
    if (ans != null) {
      const targetIdx = indexForQuestion(idx);
      answers[targetIdx] = ans;
      answeredCount += 1;
      if (ans === question.answer) correct += 1;
    }
  });

  const flagged = Object.entries(sess.flagged || {})
    .filter(([_, val]) => Boolean(val))
    .map(([idx]) => indexForQuestion(Number(idx)))
    .filter(Number.isFinite);

  const questionStatsSnapshot = snapshotQuestionStats(sess);
  const mappedQuestionStats = [];
  questionStatsSnapshot.forEach((stat, idx) => {
    const targetIdx = indexForQuestion(idx);
    mappedQuestionStats[targetIdx] = stat;
  });
  const examForResult = sess.baseExam || sess.exam;
  const changeSummary = summarizeAnswerChanges(mappedQuestionStats, examForResult, answers);

  const result = {
    id: uid(),
    when: Date.now(),
    correct,
    total: sess.exam.questions.length,
    answers,
    flagged,
    durationMs: sess.elapsedMs || 0,
    answered: answeredCount,
    questionStats: mappedQuestionStats,
    changeSummary
  };

  if (sess.baseExam) {
    const subsetIndices = sess.exam.questions
      .map((_, idx) => indexForQuestion(idx))
      .filter(Number.isFinite);
    if (subsetIndices.length && subsetIndices.length < (sess.baseExam.questions?.length || 0)) {
      result.subsetIndices = subsetIndices;
    }
  }

  const updatedExam = clone(examForResult);
  updatedExam.results = [...(updatedExam.results || []), result];
  updatedExam.updatedAt = Date.now();
  await upsertExam(updatedExam);
  await deleteExamSessionProgress(updatedExam.id).catch(() => {});

  if (isAuto) {
    lastExamStatusMessage = 'Time expired. Attempt submitted automatically.';
  }

  teardownKeyboardNavigation();
  setExamSession({ mode: 'summary', exam: updatedExam, latestResult: result });
  render();
}

function renderSummary(root, render, sess) {
  const wrap = document.createElement('div');
  wrap.className = 'exam-summary';

  const title = document.createElement('h2');
  title.textContent = `${sess.exam.examTitle} — Results`;
  wrap.appendChild(title);

  const score = document.createElement('div');
  score.className = 'exam-summary-score';
  const pct = sess.latestResult.total ? Math.round((sess.latestResult.correct / sess.latestResult.total) * 100) : 0;
  score.innerHTML = `<span class="score-number">${sess.latestResult.correct}/${sess.latestResult.total}</span><span class="score-percent">${pct}%</span>`;
  wrap.appendChild(score);

  const metrics = document.createElement('div');
  metrics.className = 'exam-summary-metrics';
  metrics.appendChild(createStat('Answered', `${sess.latestResult.answered}/${sess.latestResult.total}`));
  metrics.appendChild(createStat('Flagged', String(sess.latestResult.flagged.length)));
  metrics.appendChild(createStat('Duration', formatDuration(sess.latestResult.durationMs)));
  wrap.appendChild(metrics);

  const actions = document.createElement('div');
  actions.className = 'exam-summary-actions';

  const wrongIndices = incorrectQuestionIndices(sess.exam, sess.latestResult);

  const reviewBtn = document.createElement('button');
  reviewBtn.className = 'btn';
  reviewBtn.textContent = 'Review Attempt';
  reviewBtn.addEventListener('click', () => {
    const reviewPacket = resolveReviewPacket(sess.exam, sess.latestResult);
    setExamSession({
      mode: 'review',
      exam: clone(reviewPacket.exam),
      result: clone(reviewPacket.result),
      idx: 0,
      fromSummary: clone(sess.latestResult)
    });
    render();
  });
  actions.appendChild(reviewBtn);

  const reviewWrongBtn = document.createElement('button');
  reviewWrongBtn.className = 'btn secondary exam-action-incorrect';
  reviewWrongBtn.textContent = 'Review Incorrect';
  reviewWrongBtn.disabled = wrongIndices.length === 0;
  reviewWrongBtn.addEventListener('click', () => {
    const subset = subsetExamForIndices(sess.exam, sess.latestResult, wrongIndices);
    if (!subset) return;
    setExamSession({
      mode: 'review',
      exam: subset.exam,
      result: subset.result,
      idx: 0,
      fromSummary: clone(sess.latestResult)
    });
    render();
  });
  actions.appendChild(reviewWrongBtn);

  const retake = document.createElement('button');
  retake.className = 'btn secondary';
  retake.textContent = 'Retake Exam';
  retake.addEventListener('click', () => {
    setExamSession(createTakingSession(sess.exam));
    render();
  });
  actions.appendChild(retake);

  const retakeWrong = document.createElement('button');
  retakeWrong.className = 'btn secondary';
  retakeWrong.textContent = 'Retake Incorrect';
  retakeWrong.disabled = wrongIndices.length === 0;
  retakeWrong.addEventListener('click', () => {
    const subset = subsetExamForIndices(sess.exam, null, wrongIndices);
    if (!subset) return;
    const session = createTakingSession(subset.exam);
    session.baseExam = clone(sess.exam);
    session.subsetIndices = [...wrongIndices];
    setExamSession(session);
    render();
  });
  actions.appendChild(retakeWrong);

  const exit = document.createElement('button');
  exit.className = 'btn';
  exit.textContent = 'Back to Exams';
  exit.addEventListener('click', () => { setExamSession(null); render(); });
  actions.appendChild(exit);

  wrap.appendChild(actions);
  root.appendChild(wrap);
}

function openExamEditor(existing, render) {
  const { exam } = ensureExamShape(existing || {
    id: uid(),
    examTitle: 'New Exam',
    timerMode: 'untimed',
    secondsPerQuestion: DEFAULT_SECONDS,
    questions: [],
    results: []
  });

  let dirty = false;
  const markDirty = () => { dirty = true; };

  const cleanupTasks = new Set();

  function registerCleanup(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    cleanupTasks.add(fn);
    return () => {
      cleanupTasks.delete(fn);
    };
  }

  function runAllCleanups() {
    cleanupTasks.forEach(fn => {
      try {
        fn();
      } catch (err) {
        console.error('Failed to cleanup exam editor resources', err);
      }
    });
    cleanupTasks.clear();
  }

  let questionDisposers = [];

  function disposeQuestions() {
    questionDisposers.forEach(dispose => {
      try {
        dispose();
      } catch (err) {
        console.error('Failed to dispose exam question editors', err);
      }
    });
    questionDisposers = [];
  }

  const floating = createFloatingWindow({
    title: existing ? 'Edit Exam' : 'Create Exam',
    width: 980,
    onClose: () => {
      disposeQuestions();
      runAllCleanups();
    },
    onBeforeClose: async (reason) => {
      if (reason === 'saved') return true;
      if (!dirty) return true;
      const choice = await promptSaveChoice();
      if (choice === 'cancel') return false;
      if (choice === 'discard') return true;
      if (choice === 'save') {
        const ok = await persistExam();
        if (ok) {
          dirty = false;
          render();
        }
        return ok;
      }
      return false;
    }
  });
  floating.element.classList.add('exam-editor-window');

  let lectureCatalog = { blocks: [], lectureLists: {} };
  let lectureCatalogReady = false;

  const form = document.createElement('form');
  form.className = 'exam-editor';
  floating.body.appendChild(form);

  const error = document.createElement('div');
  error.className = 'exam-error';
  form.appendChild(error);

  const metaSection = document.createElement('div');
  metaSection.className = 'exam-editor-meta';
  form.appendChild(metaSection);

  const titleField = document.createElement('label');
  titleField.className = 'exam-field';
  const titleLabel = document.createElement('span');
  titleLabel.className = 'exam-field-label';
  titleLabel.textContent = 'Title';
  const titleInput = document.createElement('input');
  titleInput.className = 'input';
  titleInput.value = exam.examTitle;
  titleInput.addEventListener('input', () => { exam.examTitle = titleInput.value; markDirty(); });
  titleField.append(titleLabel, titleInput);
  metaSection.appendChild(titleField);

  const timerRow = document.createElement('div');
  timerRow.className = 'exam-timer-row';
  metaSection.appendChild(timerRow);

  const modeField = document.createElement('label');
  modeField.className = 'exam-field';
  const modeSpan = document.createElement('span');
  modeSpan.className = 'exam-field-label';
  modeSpan.textContent = 'Timer Mode';
  const modeSelect = document.createElement('select');
  modeSelect.className = 'input';
  ['untimed', 'timed'].forEach(mode => {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = mode === 'timed' ? 'Timed' : 'Untimed';
    modeSelect.appendChild(opt);
  });
  modeSelect.value = exam.timerMode;
  modeSelect.addEventListener('change', () => {
    exam.timerMode = modeSelect.value;
    secondsField.classList.toggle('is-hidden', exam.timerMode !== 'timed');
    markDirty();
  });
  modeField.append(modeSpan, modeSelect);
  timerRow.appendChild(modeField);

  const secondsField = document.createElement('label');
  secondsField.className = 'exam-field';
  const secondsSpan = document.createElement('span');
  secondsSpan.className = 'exam-field-label';
  secondsSpan.textContent = 'Seconds per question';
  const secondsInput = document.createElement('input');
  secondsInput.type = 'number';
  secondsInput.min = '10';
  secondsInput.className = 'input';
  secondsInput.value = String(exam.secondsPerQuestion);
  secondsInput.addEventListener('input', () => {
    const val = Number(secondsInput.value);
    if (!Number.isNaN(val) && val > 0) {
      exam.secondsPerQuestion = val;
      markDirty();
    }
  });
  secondsField.append(secondsSpan, secondsInput);
  if (exam.timerMode !== 'timed') secondsField.classList.add('is-hidden');
  timerRow.appendChild(secondsField);

  const bodySection = document.createElement('div');
  bodySection.className = 'exam-editor-body';
  form.appendChild(bodySection);

  const sidebar = document.createElement('aside');
  sidebar.className = 'exam-editor-sidebar';
  sidebar.id = `exam-editor-sidebar-${exam.id}`;
  const sidebarTitle = document.createElement('div');
  sidebarTitle.className = 'exam-editor-sidebar-title';
  const sidebarHeading = document.createElement('h4');
  sidebarHeading.textContent = 'Jump';
  const sidebarCount = document.createElement('span');
  sidebarCount.className = 'exam-editor-sidebar-count';
  sidebarTitle.append(sidebarHeading, sidebarCount);
  const jumpSection = document.createElement('div');
  jumpSection.className = 'exam-editor-sidebar-jump';
  jumpSection.appendChild(sidebarTitle);
  const navList = document.createElement('div');
  navList.className = 'exam-editor-nav-list';
  jumpSection.appendChild(navList);
  sidebar.appendChild(jumpSection);
  bodySection.appendChild(sidebar);

  const mainColumn = document.createElement('div');
  mainColumn.className = 'exam-editor-main';
  bodySection.appendChild(mainColumn);

  const questionSection = document.createElement('div');
  questionSection.className = 'exam-question-section';
  mainColumn.appendChild(questionSection);

  let currentQuestionIndex = 0;
  let prevBtn = null;
  let nextBtn = null;
  const clampQuestionIndex = (next) => {
    if (!exam.questions.length) return 0;
    return Math.max(0, Math.min(next, exam.questions.length - 1));
  };

  const setQuestionIndex = (next) => {
    if (!exam.questions.length) {
      currentQuestionIndex = 0;
      scheduleRenderQuestions();
      return;
    }
    const clamped = clampQuestionIndex(next);
    if (clamped === currentQuestionIndex) return;
    currentQuestionIndex = clamped;
    scheduleRenderQuestions();
  };

  const addNewQuestion = () => {
    exam.questions.push(createBlankQuestion());
    markDirty();
    currentQuestionIndex = exam.questions.length - 1;
    scheduleRenderQuestions();
  };

  function renderQuestions() {
    disposeQuestions();
    questionSection.innerHTML = '';
    navList.innerHTML = '';
    sidebarCount.textContent = `${exam.questions.length} total`;
    exam.questions.forEach((question, idx) => {
      const navButton = document.createElement('button');
      navButton.type = 'button';
      navButton.className = 'exam-editor-nav-item';
      navButton.textContent = String(idx + 1);
      navButton.title = `Jump to Question ${idx + 1}`;
      if (idx === currentQuestionIndex) {
        navButton.classList.add('is-active');
      }
      navButton.addEventListener('click', () => setQuestionIndex(idx));
      navList.appendChild(navButton);
    });

    const addNav = document.createElement('button');
    addNav.type = 'button';
    addNav.className = 'exam-editor-nav-item exam-editor-nav-item--add';
    addNav.textContent = '+';
    addNav.title = 'Add question';
    addNav.setAttribute('aria-label', 'Add question');
    addNav.addEventListener('click', addNewQuestion);
    navList.appendChild(addNav);

    if (!exam.questions.length) {
      const empty = document.createElement('p');
      empty.className = 'exam-question-empty';
      empty.textContent = 'No questions yet. Use the + button to add your first question.';
      questionSection.appendChild(empty);
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    currentQuestionIndex = clampQuestionIndex(currentQuestionIndex);
    const question = exam.questions[currentQuestionIndex];
    const idx = currentQuestionIndex;

    const card = document.createElement('div');
    card.className = 'exam-question-editor';
    const questionId = question.id || `idx-${idx}`;
    card.id = `exam-question-${questionId}`;

    const localDisposers = new Set();
    const optionDisposers = new Set();

    function trackEditor(editor) {
      if (!editor || typeof editor.destroy !== 'function') {
        return () => {};
      }
      let disposed = false;
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        try {
          editor.destroy();
        } catch (err) {
          console.error('Failed to destroy exam editor instance', err);
        }
      };
      const unregister = registerCleanup(cleanup);
      const dispose = () => {
        if (disposed) return;
        unregister();
        cleanup();
        localDisposers.delete(dispose);
      };
      localDisposers.add(dispose);
      return dispose;
    }

    function cleanupOptionEditors() {
      for (const dispose of Array.from(optionDisposers)) {
        optionDisposers.delete(dispose);
        dispose();
      }
    }

    const header = document.createElement('div');
    header.className = 'exam-question-editor-header';
    const label = document.createElement('h3');
    label.textContent = `Question ${idx + 1}`;
    header.appendChild(label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost-btn';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      exam.questions.splice(idx, 1);
      markDirty();
      if (exam.questions.length) {
        currentQuestionIndex = Math.min(idx, exam.questions.length - 1);
      } else {
        currentQuestionIndex = 0;
      }
      scheduleRenderQuestions();
    });
    header.appendChild(remove);
    card.appendChild(header);

    const stemField = document.createElement('div');
    stemField.className = 'exam-field exam-field--rich';
    const stemLabel = document.createElement('span');
    stemLabel.className = 'exam-field-label';
    stemLabel.textContent = 'Prompt';
    stemField.appendChild(stemLabel);
    const stemEditor = createRichTextEditor({
      value: question.stem,
      ariaLabel: `Question ${idx + 1} prompt`,
      onChange: () => {
        question.stem = stemEditor.getValue();
        markDirty();
      }
    });
    trackEditor(stemEditor);
    stemEditor.element.classList.add('exam-rich-input');
    stemField.appendChild(stemEditor.element);
    card.appendChild(stemField);

    const mediaField = document.createElement('div');
    mediaField.className = 'exam-field exam-field--media';
    const mediaLabel = document.createElement('span');
    mediaLabel.className = 'exam-field-label';
    mediaLabel.textContent = 'Media (URL or upload)';
    mediaField.appendChild(mediaLabel);

    const mediaInput = document.createElement('input');
    mediaInput.className = 'input';
    mediaInput.placeholder = 'https://example.com/image.png';
    mediaInput.value = question.media || '';
    mediaInput.addEventListener('input', () => {
      question.media = mediaInput.value.trim();
      updatePreview();
      markDirty();
    });
    mediaInput.addEventListener('paste', event => { void handleMediaPaste(event); });
    mediaField.appendChild(mediaInput);

    const mediaUpload = document.createElement('input');
    mediaUpload.type = 'file';
    mediaUpload.accept = 'image/*,video/*,audio/*';
    mediaUpload.addEventListener('change', () => {
      const file = mediaUpload.files?.[0];
      if (!file) return;
      markDirty();
      const reader = new FileReader();
      reader.onload = () => {
        question.media = typeof reader.result === 'string' ? reader.result : '';
        mediaInput.value = question.media;
        updatePreview();
        markDirty();
      };
      reader.readAsDataURL(file);
    });
    mediaField.appendChild(mediaUpload);

    const clearMedia = document.createElement('button');
    clearMedia.type = 'button';
    clearMedia.className = 'ghost-btn';
    clearMedia.textContent = 'Remove media';
    clearMedia.addEventListener('click', () => {
      question.media = '';
      mediaInput.value = '';
      mediaUpload.value = '';
      updatePreview();
      markDirty();
    });
    mediaField.appendChild(clearMedia);

    card.appendChild(mediaField);

    const preview = document.createElement('div');
    preview.className = 'exam-media-preview';

    async function handleMediaPaste(event) {
      if (!event?.clipboardData) return;
      const files = Array.from(event.clipboardData.files || []);
      const file = files.find(f => f && typeof f.type === 'string' && (
        f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/')
      ));
      if (!file) return;
      event.preventDefault();
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (typeof dataUrl === 'string' && dataUrl) {
          question.media = dataUrl;
          mediaInput.value = question.media;
          updatePreview();
          markDirty();
        }
      } catch (err) {
        console.warn('Failed to read pasted media', err);
      }
    }

    function updatePreview() {
      preview.innerHTML = '';
      const el = mediaElement(question.media);
      if (el) preview.appendChild(el);
    }
    updatePreview();
    card.appendChild(preview);

    const tagsField = document.createElement('label');
    tagsField.className = 'exam-field';
    const tagsLabel = document.createElement('span');
    tagsLabel.className = 'exam-field-label';
    tagsLabel.textContent = 'Tags (comma or | separated)';
    const tagsInput = document.createElement('input');
    tagsInput.className = 'input';
    tagsInput.value = question.tags.join(', ');
    tagsInput.addEventListener('input', () => {
      question.tags = parseTagString(tagsInput.value);
      markDirty();
    });
    tagsField.append(tagsLabel, tagsInput);
    card.appendChild(tagsField);

    const lectureField = document.createElement('div');
    lectureField.className = 'exam-field exam-field--lectures';
    const lectureLabel = document.createElement('span');
    lectureLabel.className = 'exam-field-label';
    lectureLabel.textContent = 'Lecture tags';
    lectureField.appendChild(lectureLabel);

    const lectureSummary = document.createElement('div');
    lectureSummary.className = 'exam-lecture-summary';
    lectureField.appendChild(lectureSummary);

    const lectureControls = document.createElement('div');
    lectureControls.className = 'exam-lecture-controls';
    lectureField.appendChild(lectureControls);

    const lectureSelections = new Map();
    normalizeLectureRefs(question.lectures).forEach(ref => {
      lectureSelections.set(`${ref.blockId}|${ref.id}`, ref);
    });

    const blockMap = new Map(
      (lectureCatalog.blocks || []).map(block => [String(block.blockId ?? block.id ?? ''), block])
    );

    const blockSelect = document.createElement('select');
    blockSelect.className = 'input exam-lecture-select';
    blockSelect.setAttribute('aria-label', `Question ${idx + 1} block filter`);

    const weekSelect = document.createElement('select');
    weekSelect.className = 'input exam-lecture-select';
    weekSelect.setAttribute('aria-label', `Question ${idx + 1} week filter`);

    const filtersRow = document.createElement('div');
    filtersRow.className = 'exam-lecture-filters';
    filtersRow.append(blockSelect, weekSelect);
    lectureControls.appendChild(filtersRow);

    const lectureList = document.createElement('div');
    lectureList.className = 'exam-lecture-list';
    lectureControls.appendChild(lectureList);

    function syncLectures() {
      question.lectures = Array.from(lectureSelections.values());
      markDirty();
    }

    function renderLectureSummary() {
      lectureSummary.innerHTML = '';
      if (!lectureSelections.size) {
        const empty = document.createElement('div');
        empty.className = 'exam-lecture-empty';
        empty.textContent = 'No lectures tagged yet.';
        lectureSummary.appendChild(empty);
        return;
      }
      lectureSelections.forEach(ref => {
        const chip = document.createElement('div');
        chip.className = 'exam-lecture-chip';
        const label = document.createElement('span');
        const blockLabel = blockMap.get(ref.blockId)?.title || ref.blockId;
        const lectureName = ref.name || `Lecture ${ref.id}`;
        label.textContent = blockLabel ? `${blockLabel} • ${lectureName}` : lectureName;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'exam-lecture-chip-remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          lectureSelections.delete(`${ref.blockId}|${ref.id}`);
          syncLectures();
          renderLectureSummary();
          renderLectureList();
        });
        chip.append(label, removeBtn);
        lectureSummary.appendChild(chip);
      });
    }

    function resolveLectureEntries({ includeAllWeeks = false } = {}) {
      const blockId = blockSelect.value;
      const weekValue = includeAllWeeks ? '' : weekSelect.value;
      const entries = [];
      const blockIds = blockId
        ? [blockId]
        : Object.keys(lectureCatalog.lectureLists || {});
      blockIds.forEach(id => {
        const lectures = lectureCatalog.lectureLists?.[id] || [];
        lectures.forEach(lecture => {
          if (weekValue && String(lecture.week ?? '') !== weekValue) return;
          entries.push({ blockId: id, lecture });
        });
      });
      return entries;
    }

    function renderLectureList() {
      lectureList.innerHTML = '';
      if (!lectureCatalogReady || !Object.keys(lectureCatalog.lectureLists || {}).length) {
        const empty = document.createElement('div');
        empty.className = 'exam-lecture-empty';
        empty.textContent = lectureCatalogReady ? 'No lectures found.' : 'Loading lectures...';
        lectureList.appendChild(empty);
        return;
      }
      const entries = resolveLectureEntries();
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'exam-lecture-empty';
        empty.textContent = 'No lectures available for this filter.';
        lectureList.appendChild(empty);
        return;
      }
      entries.forEach(({ blockId, lecture }) => {
        const key = `${blockId}|${lecture.id}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'exam-lecture-button';
        const blockLabel = blockMap.get(blockId)?.title || blockId;
        const lectureName = lecture.name || `Lecture ${lecture.id}`;
        btn.textContent = blockSelect.value ? lectureName : `${blockLabel} • ${lectureName}`;
        setToggleState(btn, lectureSelections.has(key));
        btn.addEventListener('click', () => {
          if (lectureSelections.has(key)) {
            lectureSelections.delete(key);
          } else {
            lectureSelections.set(key, {
              blockId,
              id: lecture.id,
              name: lecture.name || '',
              week: lecture.week ?? null
            });
          }
          syncLectures();
          renderLectureSummary();
          renderLectureList();
        });
        lectureList.appendChild(btn);
      });
    }

    function renderBlockOptions() {
      blockSelect.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'All blocks';
      blockSelect.appendChild(allOption);
      (lectureCatalog.blocks || []).forEach(block => {
        const opt = document.createElement('option');
        opt.value = String(block.blockId ?? block.id ?? '');
        opt.textContent = block.title || String(block.blockId ?? block.id ?? '');
        blockSelect.appendChild(opt);
      });
      if (lectureSelections.size) {
        const firstSelection = lectureSelections.values().next().value;
        if (firstSelection?.blockId) {
          blockSelect.value = String(firstSelection.blockId);
        }
      } else {
        const defaultBlockId = resolveDefaultBlockId(lectureCatalog);
        if (defaultBlockId) {
          blockSelect.value = defaultBlockId;
        }
      }
    }

    function renderWeekOptions() {
      weekSelect.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'All weeks';
      weekSelect.appendChild(allOption);
      const entries = resolveLectureEntries({ includeAllWeeks: true });
      const weeks = new Set();
      entries.forEach(({ lecture }) => {
        if (lecture.week == null || lecture.week === '') return;
        weeks.add(String(lecture.week));
      });
      Array.from(weeks).sort((a, b) => Number(a) - Number(b)).forEach(week => {
        const opt = document.createElement('option');
        opt.value = week;
        opt.textContent = `Week ${week}`;
        weekSelect.appendChild(opt);
      });
    }

    blockSelect.addEventListener('change', () => {
      renderWeekOptions();
      renderLectureList();
    });
    weekSelect.addEventListener('change', renderLectureList);

    renderBlockOptions();
    renderWeekOptions();
    renderLectureSummary();
    renderLectureList();

    card.appendChild(lectureField);

    const explanationField = document.createElement('div');
    explanationField.className = 'exam-field exam-field--rich';
    const explanationLabel = document.createElement('span');
    explanationLabel.className = 'exam-field-label';
    explanationLabel.textContent = 'Explanation';
    explanationField.appendChild(explanationLabel);
    const explanationEditor = createRichTextEditor({
      value: question.explanation,
      ariaLabel: `Question ${idx + 1} explanation`,
      onChange: () => {
        question.explanation = explanationEditor.getValue();
        markDirty();
      }
    });
    trackEditor(explanationEditor);
    explanationEditor.element.classList.add('exam-rich-input');
    explanationField.appendChild(explanationEditor.element);
    card.appendChild(explanationField);

    const optionsSection = document.createElement('div');
    optionsSection.className = 'exam-option-section';

    const optionsHeader = document.createElement('div');
    optionsHeader.className = 'exam-option-header';
    const optionsTitle = document.createElement('span');
    optionsTitle.className = 'exam-field-label';
    optionsTitle.textContent = 'Answer options';
    const optionToolbarSlot = document.createElement('div');
    optionToolbarSlot.className = 'exam-option-toolbar';
    optionsHeader.append(optionsTitle, optionToolbarSlot);
    optionsSection.appendChild(optionsHeader);

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'exam-option-editor-list';
    optionsSection.appendChild(optionsWrap);

    let activeToolbarKey = null;
    const optionToolbars = new Map();

    function attachToolbar(key) {
      const toolbar = optionToolbars.get(key);
      if (!toolbar) return;
      if (activeToolbarKey === key && optionToolbarSlot.firstChild === toolbar) return;
      optionToolbarSlot.innerHTML = '';
      optionToolbarSlot.appendChild(toolbar);
      activeToolbarKey = key;
    }

    function renderOptions() {
      cleanupOptionEditors();
      optionsWrap.innerHTML = '';
      optionToolbars.clear();
      optionToolbarSlot.innerHTML = '';
      activeToolbarKey = null;
      question.options.forEach((opt, optIdx) => {
        const row = document.createElement('div');
        row.className = 'exam-option-editor';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `correct-${question.id}`;
        radio.checked = question.answer === opt.id;
        radio.addEventListener('change', () => {
          question.answer = opt.id;
          markDirty();
        });
        row.appendChild(radio);

        const editor = createRichTextEditor({
          value: opt.text,
          ariaLabel: `Option ${optIdx + 1}`,
          onChange: () => {
            opt.text = editor.getValue();
            markDirty();
          }
        });
        const disposeOptionEditor = trackEditor(editor);
        optionDisposers.add(disposeOptionEditor);
        editor.element.classList.add('exam-option-rich');
        const toolbar = editor.element.querySelector('.rich-editor-toolbar');
        if (toolbar) {
          toolbar.classList.add('exam-option-toolbar-inner');
          optionToolbars.set(opt.id, toolbar);
          toolbar.remove();
          if (!activeToolbarKey) {
            attachToolbar(opt.id);
          }
        }
        editor.element.addEventListener('focusin', () => attachToolbar(opt.id));
        row.appendChild(editor.element);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'ghost-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.disabled = question.options.length <= 2;
        removeBtn.addEventListener('click', () => {
          question.options.splice(optIdx, 1);
          if (question.answer === opt.id) {
            question.answer = question.options[0]?.id || '';
          }
          markDirty();
          renderOptions();
        });
        row.appendChild(removeBtn);

        optionsWrap.appendChild(row);
      });
    }

    renderOptions();

    const addOption = document.createElement('button');
    addOption.type = 'button';
    addOption.className = 'btn secondary';
    addOption.textContent = 'Add Option';
    addOption.addEventListener('click', () => {
      const opt = { id: uid(), text: '' };
      question.options.push(opt);
      markDirty();
      renderOptions();
    });

    optionsSection.appendChild(addOption);
    card.appendChild(optionsSection);

    questionSection.appendChild(card);

    const disposeLocal = () => {
      cleanupOptionEditors();
      for (const dispose of Array.from(localDisposers)) {
        localDisposers.delete(dispose);
        dispose();
      }
    };

    questionDisposers.push(disposeLocal);

    if (prevBtn) prevBtn.disabled = currentQuestionIndex <= 0;
    if (nextBtn) nextBtn.disabled = currentQuestionIndex >= exam.questions.length - 1;
  }

  const scheduleRenderQuestions = (() => {
    let scheduled = false;
    const schedule = (cb) => {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(cb, { timeout: 200 });
        return;
      }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(cb);
        return;
      }
      setTimeout(cb, 0);
    };
    return () => {
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        renderQuestions();
      });
    };
  })();

  scheduleRenderQuestions();

  loadBlockCatalog().then(catalog => {
    lectureCatalog = catalog || { blocks: [], lectureLists: {} };
    lectureCatalogReady = true;
    scheduleRenderQuestions();
  }).catch(err => {
    console.warn('Failed to load lecture catalog for exam editor', err);
  });

  const actions = document.createElement('div');
  actions.className = 'exam-editor-actions exam-editor-actions--sidebar exam-editor-actions--compact';

  prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'exam-editor-action-icon';
  prevBtn.setAttribute('aria-label', 'Previous question');
  prevBtn.title = 'Previous question';
  prevBtn.textContent = '←';
  prevBtn.addEventListener('click', () => setQuestionIndex(currentQuestionIndex - 1));
  actions.appendChild(prevBtn);

  nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'exam-editor-action-icon';
  nextBtn.setAttribute('aria-label', 'Next question');
  nextBtn.title = 'Next question';
  nextBtn.textContent = '→';
  nextBtn.addEventListener('click', () => setQuestionIndex(currentQuestionIndex + 1));
  actions.appendChild(nextBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'exam-editor-action-icon exam-editor-action-icon--save';
  saveBtn.setAttribute('aria-label', 'Save exam');
  saveBtn.title = 'Save exam';
  saveBtn.textContent = '✓';
  actions.appendChild(saveBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'exam-editor-action-icon';
  closeBtn.setAttribute('aria-label', 'Close editor');
  closeBtn.title = 'Close editor';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => { void floating.close('cancel'); });
  actions.appendChild(closeBtn);

  sidebar.appendChild(actions);
  scheduleRenderQuestions();

  let isSidebarCollapsed = false;
  const sidebarHandle = document.createElement('button');
  sidebarHandle.type = 'button';
  sidebarHandle.className = 'exam-editor-sidebar-handle';
  sidebarHandle.setAttribute('aria-controls', sidebar.id);
  floating.element.appendChild(sidebarHandle);
  const syncSidebarState = () => {
    sidebar.classList.toggle('is-collapsed', isSidebarCollapsed);
    bodySection.classList.toggle('is-sidebar-collapsed', isSidebarCollapsed);
    const label = isSidebarCollapsed ? 'Show jump list' : 'Hide jump list';
    sidebarHandle.textContent = isSidebarCollapsed ? '›' : '‹';
    sidebarHandle.setAttribute('aria-expanded', isSidebarCollapsed ? 'false' : 'true');
    sidebarHandle.setAttribute('aria-label', label);
  };

  const toggleSidebar = () => {
    isSidebarCollapsed = !isSidebarCollapsed;
    syncSidebarState();
  };

  sidebarHandle.addEventListener('click', toggleSidebar);
  syncSidebarState();

  async function persistExam() {
    error.textContent = '';

    const title = titleInput.value.trim();
    if (!title) {
      error.textContent = 'Exam title is required.';
      return false;
    }

    if (!exam.questions.length) {
      error.textContent = 'Add at least one question.';
      return false;
    }

    for (let i = 0; i < exam.questions.length; i += 1) {
      const question = exam.questions[i];
      question.stem = sanitizeRichText(question.stem);
      question.explanation = sanitizeRichText(question.explanation);
      question.media = question.media?.trim() || '';
      question.options = question.options.map(opt => ({
        id: opt.id || uid(),
        text: sanitizeRichText(opt.text)
      })).filter(opt => !isEmptyHtml(opt.text));
      question.tags = ensureArrayTags(question.tags);
      question.lectures = normalizeLectureRefs(question.lectures);

      if (isEmptyHtml(question.stem)) {
        error.textContent = `Question ${i + 1} needs a prompt.`;
        return false;
      }
      if (question.options.length < 2) {
        error.textContent = `Question ${i + 1} needs at least two answer options.`;
        return false;
      }
      if (!question.answer || !question.options.some(opt => opt.id === question.answer)) {
        question.answer = question.options[0].id;
      }
    }

    const payload = {
      ...exam,
      examTitle: title,
      updatedAt: Date.now()
    };

    await upsertExam(payload);
    return true;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const ok = await persistExam();
    if (!ok) return;
    dirty = false;
    await floating.close('saved');
    render();
  });

  function promptSaveChoice() {
    return new Promise(resolve => {
      const modal = document.createElement('div');
      modal.className = 'modal';

      const card = document.createElement('div');
      card.className = 'card';

      const message = document.createElement('p');
      message.textContent = 'Save changes before closing?';
      card.appendChild(message);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'modal-actions';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => { cleanup(); resolve('save'); });

      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'btn secondary';
      discardBtn.textContent = 'Discard';
      discardBtn.addEventListener('click', () => { cleanup(); resolve('discard'); });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ghost-btn';
      cancelBtn.textContent = 'Keep Editing';
      cancelBtn.addEventListener('click', () => { cleanup(); resolve('cancel'); });

      actionsRow.append(saveBtn, discardBtn, cancelBtn);
      card.appendChild(actionsRow);
      modal.appendChild(card);

      modal.addEventListener('click', e => {
        if (e.target === modal) {
          cleanup();
          resolve('cancel');
        }
      });

      document.body.appendChild(modal);
      saveBtn.focus();

      function cleanup() {
        if (modal.parentNode) document.body.removeChild(modal);
      }
    });
  }

  titleInput.focus();
}
