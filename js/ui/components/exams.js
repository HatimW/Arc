import { listExams, upsertExam, deleteExam, listExamSessions, loadExamSession, saveExamSessionProgress, deleteExamSessionProgress } from '../../storage/storage.js';
import { state, setExamSession, setExamAttemptExpanded, setExamLayout } from '../../state.js';
import { uid, setToggleState, deepClone } from '../../utils.js';
import { confirmModal } from './confirm.js';
import { createRichTextEditor, sanitizeHtml, htmlToPlainText, isEmptyHtml } from './rich-text.js';
import { createFloatingWindow } from './window-manager.js';

const DEFAULT_SECONDS = 60;
const CSV_MAX_OPTIONS = 8;
const CSV_HEADERS = (() => {
  const base = ['type', 'examTitle', 'timerMode', 'secondsPerQuestion', 'stem'];
  for (let i = 1; i <= CSV_MAX_OPTIONS; i += 1) {
    base.push(`option${i}`);
    base.push(`option${i}Correct`);
  }
  base.push('explanation', 'tags', 'media');
  return base;
})();
const CSV_ROW_META = 'meta';
const CSV_ROW_QUESTION = 'question';
const CSV_EXPLANATION_INDEX = CSV_HEADERS.indexOf('explanation');
const CSV_TAGS_INDEX = CSV_HEADERS.indexOf('tags');
const CSV_MEDIA_INDEX = CSV_HEADERS.indexOf('media');

function csvOptionIndex(optionNumber) {
  return 5 + (optionNumber - 1) * 2;
}

function csvOptionCorrectIndex(optionNumber) {
  return csvOptionIndex(optionNumber) + 1;
}

const timerHandles = new WeakMap();
let keyHandler = null;
let keyHandlerSession = null;
let lastExamStatusMessage = '';

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

function parseTagString(tags) {
  if (!tags) return [];
  return String(tags).split(/[|,]/).map(tag => tag.trim()).filter(Boolean);
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

function resolveScrollContainer(root) {
  const hasDocument = typeof document !== 'undefined';
  if (root && typeof root.closest === 'function') {
    const scoped = root.closest('main');
    if (scoped) return scoped;
  }
  if (hasDocument) {
    const main = document.querySelector('main');
    if (main) return main;
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
  rows.push(CSV_HEADERS);

  const metaRow = new Array(CSV_HEADERS.length).fill('');
  metaRow[0] = CSV_ROW_META;
  metaRow[1] = exam.examTitle || '';
  metaRow[2] = exam.timerMode === 'timed' ? 'timed' : 'untimed';
  metaRow[3] = Number.isFinite(exam.secondsPerQuestion) ? String(exam.secondsPerQuestion) : String(DEFAULT_SECONDS);
  rows.push(metaRow);

  (exam.questions || []).forEach(question => {
    const row = new Array(CSV_HEADERS.length).fill('');
    row[0] = CSV_ROW_QUESTION;
    row[4] = question.stem || '';
    const options = Array.isArray(question.options) ? question.options : [];
    options.slice(0, CSV_MAX_OPTIONS).forEach((opt, idx) => {
      const optionCol = csvOptionIndex(idx + 1);
      const correctCol = csvOptionCorrectIndex(idx + 1);
      row[optionCol] = opt.text || '';
      row[correctCol] = opt.id === question.answer ? 'TRUE' : '';
    });
    if (CSV_EXPLANATION_INDEX >= 0) row[CSV_EXPLANATION_INDEX] = question.explanation || '';
    if (CSV_TAGS_INDEX >= 0) row[CSV_TAGS_INDEX] = Array.isArray(question.tags) ? question.tags.join(' | ') : '';
    if (CSV_MEDIA_INDEX >= 0) row[CSV_MEDIA_INDEX] = question.media || '';
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

    for (let i = 1; i <= CSV_MAX_OPTIONS; i += 1) {
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

export async function renderExams(root, render) {
  root.innerHTML = '';
  root.className = 'exam-view';

  const controls = document.createElement('div');
  controls.className = 'exam-controls';

  const heading = document.createElement('div');
  heading.className = 'exam-heading';
  heading.innerHTML = '<h1>Exams</h1><p>Import exams, take them, and review your attempts.</p>';
  controls.appendChild(heading);

  const actions = document.createElement('div');
  actions.className = 'exam-control-actions';

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

  controls.appendChild(actions);

  const layout = state.examLayout || { mode: 'grid', detailsVisible: true };
  const viewMode = layout.mode === 'row' ? 'row' : 'grid';
  const detailsVisible = layout.detailsVisible !== false;

  const layoutControls = document.createElement('div');
  layoutControls.className = 'exam-layout-controls';

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

  layoutControls.appendChild(layoutToggle);

  controls.appendChild(layoutControls);
  controls.appendChild(status);

  root.appendChild(controls);
  root.appendChild(fileInput);

  if (lastExamStatusMessage) {
    status.textContent = lastExamStatusMessage;
    lastExamStatusMessage = '';
  } else {
    status.textContent = '';
  }

  const stored = await listExams();
  const exams = [];
  for (const raw of stored) {
    const { exam, changed } = ensureExamShape(raw);
    exams.push(exam);
    if (changed) await upsertExam(exam);
  }
  exams.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const savedSessions = await listExamSessions();
  const sessionMap = new Map();
  for (const sess of savedSessions) {
    if (sess?.examId) sessionMap.set(sess.examId, sess);
  }

  // Clean up orphaned sessions for removed exams
  for (const sess of savedSessions) {
    if (!exams.find(ex => ex.id === sess.examId)) {
      await deleteExamSessionProgress(sess.examId);
    }
  }

  if (!exams.length) {
    const empty = document.createElement('div');
    empty.className = 'exam-empty';
    empty.innerHTML = '<p>No exams yet. Import a JSON or CSV exam, download the template, or create one from scratch.</p>';
    root.appendChild(empty);
    return;
  }

  const layoutSnapshot = { mode: viewMode, detailsVisible };

  const grid = document.createElement('div');
  grid.className = 'exam-grid';
  if (viewMode === 'row') {
    grid.classList.add('exam-grid--row');
  }
  exams.forEach(exam => {
    grid.appendChild(buildExamCard(exam, render, sessionMap.get(exam.id), status, layoutSnapshot));
  });
  root.appendChild(grid);
}

function buildExamCard(exam, render, savedSession, statusEl, layout) {
  const layoutMode = layout?.mode === 'row' ? 'row' : 'grid';
  const defaultExpanded = layout?.detailsVisible !== false;
  const expandedState = state.examAttemptExpanded[exam.id];
  const isExpanded = expandedState != null ? expandedState : defaultExpanded;
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

  const summaryButton = document.createElement('button');
  summaryButton.type = 'button';
  summaryButton.className = 'exam-card-summary';
  summaryButton.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
  summaryButton.addEventListener('click', () => {
    setExamAttemptExpanded(exam.id, !isExpanded);
    render();
  });
  header.appendChild(summaryButton);

  const summaryContent = document.createElement('div');
  summaryContent.className = 'exam-card-summary-content';
  summaryButton.appendChild(summaryContent);

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

  const caret = document.createElement('span');
  caret.className = 'exam-card-caret';
  summaryButton.appendChild(caret);

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
      setExamSession({ mode: 'review', exam: clone(exam), result: clone(last), idx: 0 });
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
    menuOpen = true;
    menuWrap.classList.add('exam-card-menu--open');
    card.classList.add('exam-card--menu-open');
    menuToggle.setAttribute('aria-expanded', 'true');
    menuPanel.setAttribute('aria-hidden', 'false');
    document.addEventListener('click', handleOutside, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('focusin', handleFocus, true);
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuWrap.classList.remove('exam-card-menu--open');
    card.classList.remove('exam-card--menu-open');
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
      setExamSession({ mode: 'review', exam: clone(exam), result: clone(last), idx: 0 });
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
  if (!isExpanded) {
    details.setAttribute('hidden', 'true');
  }
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

  return card;
}

function buildAttemptRow(exam, result, render) {
  const row = document.createElement('div');
  row.className = 'exam-attempt-row';

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
  review.textContent = 'Review';
  review.addEventListener('click', () => {
    setExamSession({ mode: 'review', exam: clone(exam), result: clone(result), idx: 0 });
    render();
  });
  actions.appendChild(review);

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
    wrap.appendChild(img);
  }
  return wrap;
}

function answerClass(question, selectedId, optionId) {
  const isCorrect = optionId === question.answer;
  if (selectedId == null) return isCorrect ? 'correct-answer' : '';
  if (selectedId === optionId) {
    return selectedId === question.answer ? 'correct-answer' : 'incorrect-answer';
  }
  return isCorrect ? 'correct-answer' : '';
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
    if (answer == null) return count;
    const matched = question.options.some(opt => opt.id === answer);
    return matched ? count + 1 : count;
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
    number.className = 'question-map__number';
    number.textContent = String(idx + 1);
    item.appendChild(number);

    const flagIcon = document.createElement('span');
    flagIcon.className = 'question-map__flag';
    flagIcon.setAttribute('aria-hidden', 'true');
    flagIcon.textContent = '🚩';
    item.appendChild(flagIcon);

    const isCurrent = sess.idx === idx;
    item.classList.toggle('is-current', isCurrent);
    item.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
    if (isCurrent) {
      item.setAttribute('aria-current', 'true');
    } else {
      item.removeAttribute('aria-current');
    }

    const answer = answers[idx];
    const answered = answer != null && question.options.some(opt => opt.id === answer);
    const tooltipParts = [];
    const ariaParts = [`Question ${idx + 1}`];
    let status = 'unanswered';
    const wasChecked = !isReview && Boolean(sess.checked?.[idx]);

    if (isReview) {
      if (answered) {
        const isCorrect = answer === question.answer;
        status = isCorrect ? 'correct' : 'incorrect';
        const label = isCorrect ? 'Answered correctly' : 'Answered incorrectly';
        tooltipParts.push(label);
        ariaParts.push(label);
      } else {
        status = 'review-unanswered';
        tooltipParts.push('Not answered');
        ariaParts.push('Not answered');
      }

      const stat = statsList[idx];
      const changeDetails = analyzeAnswerChange(stat, question, answer);
      delete item.dataset.changeDirection;
      if (changeDetails.changed) {
        if (changeDetails.direction === 'right-to-wrong') {
          item.dataset.changeDirection = 'right-to-wrong';
          tooltipParts.push('Changed from correct to incorrect');
          ariaParts.push('Changed from correct to incorrect');
        } else if (changeDetails.direction === 'wrong-to-right') {
          item.dataset.changeDirection = 'wrong-to-right';
          tooltipParts.push('Changed from incorrect to correct');
          ariaParts.push('Changed from incorrect to correct');
        } else {
          item.dataset.changeDirection = 'changed';
          tooltipParts.push('Changed answer');
          ariaParts.push('Changed answer');
        }
      } else if (changeDetails.switched) {
        item.dataset.changeDirection = 'returned';
        tooltipParts.push('Changed answers but returned to start');
        ariaParts.push('Changed answers but returned to start');
      }
    } else {
      if (wasChecked && answered) {
        const isCorrect = answer === question.answer;
        status = isCorrect ? 'correct' : 'incorrect';
        tooltipParts.push(isCorrect ? 'Checked correct' : 'Checked incorrect');
        ariaParts.push(isCorrect ? 'Checked correct' : 'Checked incorrect');
      } else if (answered) {
        status = 'answered';
        tooltipParts.push('Answered');
        ariaParts.push('Answered');
      } else {
        const label = wasChecked ? 'Checked without answer' : 'Not answered';
        tooltipParts.push(label);
        ariaParts.push(label);
      }
    }

    item.dataset.status = status;
    if (status === 'correct' || status === 'incorrect') {
      item.classList.add('is-graded');
    } else if (status === 'answered') {
      item.classList.add('is-answered');
    } else {
      item.classList.add('is-unanswered');
    }
    if (status === 'review-unanswered') {
      item.classList.add('is-review-unanswered');
    }

    const flagged = flaggedSet.has(idx);
    item.dataset.flagged = flagged ? 'true' : 'false';
    if (flagged) {
      tooltipParts.push('Flagged');
      ariaParts.push('Flagged');
    }

    if (isCurrent) {
      const label = 'Current question';
      tooltipParts.push(label);
      ariaParts.push(label);
    }

    if (tooltipParts.length) {
      item.title = tooltipParts.join(' · ');
    } else {
      item.removeAttribute('title');
    }

    item.setAttribute('aria-label', ariaParts.join('. '));

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
  const hasWindow = typeof window !== 'undefined';
  const prevIdx = sess.__lastRenderedIdx;
  const prevMode = sess.__lastRenderedMode;
  const scroller = resolveScrollContainer(root);
  const prevScrollY = readScrollPosition(scroller);
  if (scroller) {
    if (typeof prevIdx === 'number') {
      storeScrollPosition(sess, prevIdx, prevScrollY);
    } else if (typeof sess.idx === 'number') {
      storeScrollPosition(sess, sess.idx, prevScrollY);
    }
  }
  root.innerHTML = '';
  root.className = 'exam-session';

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
  main.appendChild(top);

  const stem = document.createElement('div');
  stem.className = 'exam-stem';
  const stemHtml = question.stem && !isEmptyHtml(question.stem) ? question.stem : '';
  stem.innerHTML = stemHtml || '<p class="exam-stem-empty">(No prompt)</p>';
  main.appendChild(stem);

  const media = mediaElement(question.media);
  if (media) main.appendChild(media);

  if (question.tags?.length) {
    const tagWrap = document.createElement('div');
    tagWrap.className = 'exam-tags';
    question.tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'exam-tag';
      chip.textContent = tag;
      tagWrap.appendChild(chip);
    });
    main.appendChild(tagWrap);
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

  main.appendChild(optionsWrap);

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
    main.appendChild(verdict);

    const answerSummary = document.createElement('div');
    answerSummary.className = 'exam-answer-summary';
    const your = optionText(question, selected);
    const correct = optionText(question, question.answer);
    answerSummary.innerHTML = `<div><strong>Your answer:</strong> ${your || '—'}</div><div><strong>Correct answer:</strong> ${correct || '—'}</div>`;
    main.appendChild(answerSummary);

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
        main.appendChild(insights);
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
      main.appendChild(explain);
    }
  }

  const paletteSummary = renderQuestionMap(sidebar, sess, render);
  renderSidebarMeta(sidebar, sess, paletteSummary);

  const nav = document.createElement('div');
  nav.className = 'exam-nav';

  const prev = document.createElement('button');
  prev.className = 'btn secondary';
  prev.textContent = 'Previous';
  prev.disabled = sess.idx === 0;
  prev.addEventListener('click', () => {
    if (sess.idx > 0) {
      navigateToQuestion(sess, sess.idx - 1, render);
    }
  });
  nav.appendChild(prev);

  if (sess.mode === 'taking') {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn secondary';
    saveBtn.textContent = 'Save & Exit';
    saveBtn.addEventListener('click', async () => {
      await saveProgressAndExit(sess, render);
    });
    nav.appendChild(saveBtn);

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
        render();
      });
      nav.appendChild(checkBtn);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn secondary';
    nextBtn.textContent = 'Next Question';
    nextBtn.disabled = sess.idx >= questionCount - 1;
    nextBtn.addEventListener('click', () => {
      if (sess.idx < questionCount - 1) {
        navigateToQuestion(sess, sess.idx + 1, render);
      }
    });
    nav.appendChild(nextBtn);

    const submit = document.createElement('button');
    submit.className = 'btn';
    submit.textContent = 'Submit Exam';
    submit.addEventListener('click', async () => {
      await finalizeExam(sess, render);
    });
    nav.appendChild(submit);
  } else {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn secondary';
    nextBtn.textContent = 'Next';
    nextBtn.disabled = sess.idx >= questionCount - 1;
    nextBtn.addEventListener('click', () => {
      if (sess.idx < questionCount - 1) {
        navigateToQuestion(sess, sess.idx + 1, render);
      }
    });
    nav.appendChild(nextBtn);

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
    nav.appendChild(exit);
  }

  root.appendChild(nav);

  const sameQuestion = prevIdx === sess.idx && prevMode === sess.mode;
  sess.__lastRenderedIdx = sess.idx;
  sess.__lastRenderedMode = sess.mode;
  const queueFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? cb => window.requestAnimationFrame(cb)
    : cb => setTimeout(cb, 0);
  if (scroller) {
    if (sameQuestion) {
      const targetY = typeof sess.idx === 'number'
        ? (getStoredScroll(sess, sess.idx) ?? prevScrollY)
        : prevScrollY;
      if (typeof sess.idx === 'number') {
        storeScrollPosition(sess, sess.idx, targetY);

      }
      const restore = () => {
        if (Math.abs(readScrollPosition(scroller) - targetY) > 1) {
          applyScrollPosition(scroller, targetY);
        }
      };
      queueFrame(restore);
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
  sess.exam.questions.forEach((question, idx) => {
    const ans = sess.answers[idx];
    if (ans != null) {
      answers[idx] = ans;
      answeredCount += 1;
      if (ans === question.answer) correct += 1;
    }
  });

  const flagged = Object.entries(sess.flagged || {})
    .filter(([_, val]) => Boolean(val))
    .map(([idx]) => Number(idx));

  const questionStats = snapshotQuestionStats(sess);
  const changeSummary = summarizeAnswerChanges(questionStats, sess.exam, answers);

  const result = {
    id: uid(),
    when: Date.now(),
    correct,
    total: sess.exam.questions.length,
    answers,
    flagged,
    durationMs: sess.elapsedMs || 0,
    answered: answeredCount,
    questionStats,
    changeSummary
  };

  const updatedExam = clone(sess.exam);
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

  const reviewBtn = document.createElement('button');
  reviewBtn.className = 'btn';
  reviewBtn.textContent = 'Review Attempt';
  reviewBtn.addEventListener('click', () => {
    setExamSession({
      mode: 'review',
      exam: clone(sess.exam),
      result: clone(sess.latestResult),
      idx: 0,
      fromSummary: clone(sess.latestResult)
    });
    render();
  });
  actions.appendChild(reviewBtn);

  const retake = document.createElement('button');
  retake.className = 'btn secondary';
  retake.textContent = 'Retake Exam';
  retake.addEventListener('click', () => {
    setExamSession(createTakingSession(sess.exam));
    render();
  });
  actions.appendChild(retake);

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

  const floating = createFloatingWindow({
    title: existing ? 'Edit Exam' : 'Create Exam',
    width: 980,
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

  const form = document.createElement('form');
  form.className = 'exam-editor';
  floating.body.appendChild(form);

  const error = document.createElement('div');
  error.className = 'exam-error';
  form.appendChild(error);

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
  form.appendChild(titleField);

  const timerRow = document.createElement('div');
  timerRow.className = 'exam-timer-row';
  form.appendChild(timerRow);

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

  const questionsHeader = document.createElement('div');
  questionsHeader.className = 'exam-question-header';
  const qTitle = document.createElement('h3');
  qTitle.textContent = 'Questions';
  const addQuestion = document.createElement('button');
  addQuestion.type = 'button';
  addQuestion.className = 'btn secondary';
  addQuestion.textContent = 'Add Question';
  addQuestion.addEventListener('click', () => {
    exam.questions.push(createBlankQuestion());
    markDirty();
    scheduleRenderQuestions();
  });
  questionsHeader.append(qTitle, addQuestion);
  form.appendChild(questionsHeader);

  const questionSection = document.createElement('div');
  questionSection.className = 'exam-question-section';
  form.appendChild(questionSection);

  function renderQuestions() {
    questionSection.innerHTML = '';
    if (!exam.questions.length) {
      const empty = document.createElement('p');
      empty.className = 'exam-question-empty';
      empty.textContent = 'No questions yet. Add your first question to get started.';
      questionSection.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    exam.questions.forEach((question, idx) => {
      const card = document.createElement('div');
      card.className = 'exam-question-editor';

      const header = document.createElement('div');
      header.className = 'exam-question-editor-header';
      const label = document.createElement('h4');
      label.textContent = `Question ${idx + 1}`;
      header.appendChild(label);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost-btn';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        exam.questions.splice(idx, 1);
        markDirty();
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
      explanationEditor.element.classList.add('exam-rich-input');
      explanationField.appendChild(explanationEditor.element);
      card.appendChild(explanationField);

      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'exam-option-editor-list';

      function renderOptions() {
        optionsWrap.innerHTML = '';
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
          editor.element.classList.add('exam-option-rich');
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

      card.appendChild(optionsWrap);
      card.appendChild(addOption);

      fragment.appendChild(card);
    });

    questionSection.appendChild(fragment);
  }

  const scheduleRenderQuestions = (() => {
    let scheduled = false;
    const schedule = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (cb) => setTimeout(cb, 0);
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

  const actions = document.createElement('div');
  actions.className = 'exam-editor-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save Exam';
  actions.appendChild(saveBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn secondary';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => { void floating.close('cancel'); });
  actions.appendChild(closeBtn);

  form.appendChild(actions);

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
