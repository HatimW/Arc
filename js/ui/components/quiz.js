import { state, setQuizSession, setSubtab, setStudySelectedMode } from '../../state.js';
import { renderRichText } from './rich-text.js';
import { persistStudySession, removeStudySession } from '../../study/study-sessions.js';
import { sectionsForItem } from './section-utils.js';
import { REVIEW_RATINGS, DEFAULT_REVIEW_STEPS } from '../../review/constants.js';
import {
  getReviewDurations,
  rateSection,
  getSectionStateSnapshot,
  projectSectionRating,
  ensureItemSr
} from '../../review/scheduler.js';
import { upsertItem } from '../../storage/storage.js';
import { openEditor } from './editor.js';


const RATING_LABELS = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy'
};

const RATING_CLASS = {
  again: 'danger',
  hard: 'secondary',
  good: '',
  easy: ''
};

function formatReviewInterval(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Now';
  if (minutes < 60) return `${minutes} min`;
  const asHours = minutes / 60;
  if (asHours < 24) {
    const roundedHours = Number.isInteger(asHours) ? asHours : Math.round(asHours * 10) / 10;
    return `${roundedHours} hr`;
  }
  const asDays = minutes / 1440;
  if (asDays < 30) {
    const roundedDays = Number.isInteger(asDays) ? asDays : Math.round(asDays * 10) / 10;
    return `${roundedDays} day${roundedDays === 1 ? '' : 's'}`;
  }
  const asMonths = minutes / 43200;
  if (asMonths < 12) {
    const roundedMonths = Number.isInteger(asMonths) ? asMonths : Math.round(asMonths * 10) / 10;
    return `${roundedMonths} mo`;
  }
  const asYears = minutes / 525600;
  const roundedYears = Number.isInteger(asYears) ? asYears : Math.round(asYears * 10) / 10;
  return `${roundedYears} yr`;
}

function cloneSectionState(state) {
  if (!state || typeof state !== 'object') return null;
  return JSON.parse(JSON.stringify(state));
}

function titleOf(item) {
  return item?.name || item?.concept || '';
}

function ratingKey(item, sectionKey) {
  const id = item?.id || 'item';
  return `${id}::${sectionKey}`;
}

function ensureSessionDefaults(session) {
  if (!session) return;
  if (!Array.isArray(session.pool)) session.pool = [];
  session.dict = session.pool.map(it => ({
    id: it.id,
    title: titleOf(it),
    lower: titleOf(it).toLowerCase()
  }));
  if (!session.answers || typeof session.answers !== 'object') {
    session.answers = {};
  }
  if (!session.ratings || typeof session.ratings !== 'object') {
    session.ratings = {};
  }
  if (!session.ratingBaselines || typeof session.ratingBaselines !== 'object') {
    session.ratingBaselines = {};
  }
  if (typeof session.idx !== 'number' || Number.isNaN(session.idx)) {
    session.idx = 0;
  }
  session.idx = Math.max(0, Math.min(Math.floor(session.idx), session.pool.length ? session.pool.length - 1 : 0));
  if (typeof session.score !== 'number' || Number.isNaN(session.score)) {
    session.score = computeScore(session.answers);
  }
}

function computeScore(answers) {
  if (!answers) return 0;
  return Object.values(answers).filter(entry => entry && entry.isCorrect).length;
}

function renderCompletion(root, session, redraw) {
  removeStudySession('quiz').catch(err => console.warn('Failed to clear quiz session', err));
  const wrap = document.createElement('section');
  wrap.className = 'card quiz-summary';

  const heading = document.createElement('h2');
  heading.textContent = 'Quiz complete';
  wrap.appendChild(heading);

  const score = document.createElement('p');
  const total = Array.isArray(session.pool) ? session.pool.length : 0;
  score.textContent = `Score ${session.score}/${total}`;
  wrap.appendChild(score);

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'Back to builder';
  btn.addEventListener('click', () => {
    setQuizSession(null);
    setStudySelectedMode('Quiz');
    setSubtab('Study', 'Builder');
    redraw();
  });
  wrap.appendChild(btn);

  root.appendChild(wrap);
}

export function renderQuiz(root, redraw) {
  const session = state.quizSession;
  if (!session) {
    if (root?.dataset) delete root.dataset.questionIdx;
    return;
  }
  ensureSessionDefaults(session);

  const hasWindow = typeof window !== 'undefined';
  const docScroller = typeof document !== 'undefined' ? (document.scrollingElement || document.documentElement) : null;
  const previousIdxRaw = root?.dataset?.questionIdx;
  const previousIdx = previousIdxRaw !== undefined && previousIdxRaw !== '' && !Number.isNaN(Number(previousIdxRaw))
    ? Number(previousIdxRaw)
    : null;
  const prevScrollY = hasWindow ? window.scrollY : docScroller ? docScroller.scrollTop : 0;

  const pool = Array.isArray(session.pool) ? session.pool : [];
  root.innerHTML = '';
  if (root?.dataset) delete root.dataset.questionIdx;

  if (!pool.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No questions available. Select study cards to begin.';
    root.appendChild(empty);
    return;
  }


  if (session.idx >= pool.length) {
    renderCompletion(root, session, redraw);

    return;
  }

  const item = pool[session.idx];
  if (!item) {
    renderCompletion(root, session, redraw);
    return;
  }

  const answer = session.answers[session.idx] || { value: '', isCorrect: false, checked: false, revealed: false };
  const hasResult = Boolean(answer.checked);
  const wasCorrect = hasResult && answer.isCorrect;
  const wasRevealed = hasResult && answer.revealed;
  const isSolved = wasCorrect || wasRevealed;

  const card = document.createElement('section');
  card.className = 'card quiz-card';
  root.appendChild(card);

  const header = document.createElement('div');
  header.className = 'quiz-header';

  const headerInfo = document.createElement('div');
  headerInfo.className = 'quiz-header-info';

  const progress = document.createElement('div');
  progress.className = 'quiz-progress';
  progress.textContent = `Question ${session.idx + 1} of ${pool.length}`;
  headerInfo.appendChild(progress);

  const tally = document.createElement('div');
  tally.className = 'quiz-score';
  tally.textContent = `Score: ${session.score}`;
  headerInfo.appendChild(tally);

  header.appendChild(headerInfo);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'icon-btn quiz-edit-btn';
  editBtn.innerHTML = '✏️';
  editBtn.title = 'Edit card';
  editBtn.setAttribute('aria-label', 'Edit card');
  editBtn.addEventListener('click', event => {
    event.stopPropagation();
    const onSave = typeof redraw === 'function' ? () => redraw() : undefined;
    openEditor(item.kind, onSave, item);
  });
  header.appendChild(editBtn);

  card.appendChild(header);

  const prompt = document.createElement('p');
  prompt.className = 'quiz-prompt';
  prompt.textContent = 'Identify the term based on the details below.';
  card.appendChild(prompt);

  const details = document.createElement('div');
  details.className = 'quiz-details';

  const sections = sectionsForItem(item);
  const sectionSnapshots = new Map();
  const baselineStore = session.ratingBaselines;
  sections.forEach(({ key }) => {
    const snapshot = getSectionStateSnapshot(item, key);
    if (snapshot) {
      sectionSnapshots.set(key, snapshot);
      const baseKey = ratingKey(item, key);
      if (!baselineStore[baseKey]) {
        baselineStore[baseKey] = cloneSectionState(snapshot);
      }
    }
  });
  if (!sections.length) {
    const emptySection = document.createElement('div');
    emptySection.className = 'quiz-empty';
    emptySection.textContent = 'No card content available for this entry.';
    details.appendChild(emptySection);
  } else {
    sections.forEach(({ key, label, content, extra }) => {
      const block = document.createElement('div');
      block.className = 'quiz-section';
      if (extra) block.classList.add('quiz-section-extra');

      const head = document.createElement('div');
      head.className = 'quiz-section-title';
      head.textContent = label;
      block.appendChild(head);

      const body = document.createElement('div');
      body.className = 'quiz-section-body';
      renderRichText(body, content || '', { clozeMode: 'interactive', resetClozeState: true });
      block.appendChild(body);

      details.appendChild(block);
    });
  }

  card.appendChild(details);

  const form = document.createElement('form');
  form.className = 'quiz-answer';

  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Type your answer';
  input.value = answer.value || '';
  form.appendChild(input);

  const suggestions = document.createElement('ul');
  suggestions.className = 'quiz-suggestions';
  const suggestionId = `quiz-suggestions-${session.idx}`;
  suggestions.id = suggestionId;
  suggestions.setAttribute('role', 'listbox');
  form.appendChild(suggestions);
  input.setAttribute('aria-controls', suggestionId);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  const actions = document.createElement('div');
  actions.className = 'quiz-answer-actions';

  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'btn quiz-check-btn';
  checkBtn.textContent = 'Check';
  checkBtn.disabled = !input.value.trim();
  checkBtn.addEventListener('click', () => gradeAnswer());
  actions.appendChild(checkBtn);

  const revealBtn = document.createElement('button');
  revealBtn.type = 'button';
  revealBtn.className = 'btn secondary quiz-reveal-btn';
  revealBtn.textContent = 'Show answer';
  revealBtn.hidden = !(hasResult && !wasCorrect && !wasRevealed);
  actions.appendChild(revealBtn);

  form.appendChild(actions);

  const feedback = document.createElement('div');
  feedback.className = 'quiz-feedback';
  if (wasCorrect) {
    feedback.textContent = 'Correct!';
    feedback.classList.add('is-correct');
  } else if (wasRevealed) {
    feedback.textContent = `Answer: ${titleOf(item)}`;
    feedback.classList.add('is-incorrect');
  } else if (hasResult) {
    feedback.textContent = 'Incorrect. Try again or reveal the answer.';
    feedback.classList.add('is-incorrect');
  }
  form.appendChild(feedback);

  card.appendChild(form);

  const suggestionButtons = [];

  const setActiveSuggestion = (target = null) => {
    suggestionButtons.forEach(btn => {
      btn.setAttribute('aria-selected', btn === target ? 'true' : 'false');
    });
  };

  const clearSuggestions = () => {
    suggestionButtons.splice(0, suggestionButtons.length);
    suggestions.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    setActiveSuggestion(null);
  };

  const commitSuggestion = (value) => {
    input.value = value;
    clearSuggestions();
    checkBtn.disabled = !input.value.trim();
    input.focus();
  };

  const focusSuggestion = (index) => {
    const target = suggestionButtons[index];
    if (target) {
      target.focus();
      setActiveSuggestion(target);
    }
  };

  const renderSuggestions = (matches) => {
    clearSuggestions();
    if (!matches.length) return;
    const fragment = document.createDocumentFragment();
    matches.forEach((entry, idx) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'presentation');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiz-suggestion-btn';
      btn.textContent = entry.title;
      btn.dataset.index = String(idx);
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        commitSuggestion(entry.title);
      });
      btn.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          focusSuggestion(Math.min(suggestionButtons.length - 1, idx + 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (idx === 0) {
            input.focus();
          } else {
            focusSuggestion(Math.max(0, idx - 1));
          }
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          commitSuggestion(entry.title);
        }
      });
      btn.addEventListener('focus', () => {
        setActiveSuggestion(btn);
      });
      btn.addEventListener('blur', () => {
        if (typeof document !== 'undefined') {
          const active = document.activeElement;
          if (active instanceof HTMLElement && suggestionButtons.includes(active) && active.closest(`#${suggestionId}`)) {
            return;
          }
        }
        setActiveSuggestion(null);
      });
      li.appendChild(btn);
      fragment.appendChild(li);
      suggestionButtons.push(btn);
    });
    suggestions.appendChild(fragment);
    input.setAttribute('aria-expanded', 'true');
  };

  const updateSuggestions = () => {
    checkBtn.disabled = !input.value.trim();
    const v = input.value.toLowerCase();
    const existing = session.answers[session.idx];
    if (existing && existing.checked) {
      const answers = { ...session.answers };
      delete answers[session.idx];
      session.answers = answers;
      session.score = computeScore(answers);
      setQuizSession({ ...session });
      feedback.textContent = '';
      feedback.classList.remove('is-correct', 'is-incorrect');
      revealBtn.hidden = true;
      revealBtn.disabled = false;
      tally.textContent = `Score: ${session.score}`;
      updateNavState();
    }
    if (!v) {
      clearSuggestions();
      return;
    }
    const seen = new Set();
    const orderedMatches = [];
    const consider = (entry) => {
      if (!entry || seen.has(entry.id || entry.title)) return;
      seen.add(entry.id || entry.title);
      orderedMatches.push(entry);
    };
    session.dict.filter(d => d.lower.startsWith(v)).forEach(consider);
    session.dict.filter(d => !d.lower.startsWith(v) && d.lower.includes(v)).forEach(consider);
    renderSuggestions(orderedMatches.slice(0, 5));
  };

  input.addEventListener('input', updateSuggestions);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && suggestionButtons.length) {
      event.preventDefault();
      focusSuggestion(0);
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (typeof document !== 'undefined') {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(`#${suggestionId}`)) return;
      }
      clearSuggestions();
    }, 0);
  });

  revealBtn.addEventListener('click', () => {
    const revealValue = titleOf(item);
    const answers = { ...session.answers, [session.idx]: { value: revealValue, isCorrect: false, checked: true, revealed: true } };
    session.answers = answers;
    session.score = computeScore(answers);
    setQuizSession({ ...session });
    input.value = revealValue;
    feedback.textContent = `Answer: ${titleOf(item)}`;
    feedback.classList.remove('is-correct');
    feedback.classList.add('is-incorrect');
    revealBtn.hidden = true;
    clearSuggestions();
    tally.textContent = `Score: ${session.score}`;
    updateNavState();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    gradeAnswer();
  });

  const durationsPromise = getReviewDurations().catch(() => ({ ...DEFAULT_REVIEW_STEPS }));
  const ratingPanel = document.createElement('div');
  ratingPanel.className = 'quiz-rating-panel';
  card.appendChild(ratingPanel);

  const ratingRow = document.createElement('div');
  ratingRow.className = 'quiz-rating-row';
  ratingPanel.appendChild(ratingRow);

  const options = document.createElement('div');
  options.className = 'quiz-rating-options';
  ratingRow.appendChild(options);

  const status = document.createElement('span');
  status.className = 'quiz-rating-status';
  status.textContent = 'Optional: set a rating to queue this card.';

  const ratingId = ratingKey(item, '__overall__');
  let selectedRating = session.ratings[ratingId] || null;
  let ratingLocked = Boolean(selectedRating);
  let adjustBtn = null;
  const ratingPreviews = new Map();

  const updatePreviews = (durations) => {
    if (!durations) return;
    const nowTs = Date.now();
    const projectionSources = new Map();
    const resolveSource = (sectionKey) => {
      if (projectionSources.has(sectionKey)) return projectionSources.get(sectionKey);
      const baseKey = ratingKey(item, sectionKey);
      const baselineState = session.ratingBaselines[baseKey];
      if (!baselineState) {
        projectionSources.set(sectionKey, null);
        return null;
      }
      const clone = JSON.parse(JSON.stringify(item));
      if (!clone.sr || typeof clone.sr !== 'object') clone.sr = {};
      clone.sr.version = clone.sr.version || (item.sr && item.sr.version) || 1;
      clone.sr.sections = clone.sr.sections && typeof clone.sr.sections === 'object'
        ? { ...clone.sr.sections }
        : {};
      clone.sr.sections[sectionKey] = cloneSectionState(baselineState);
      projectionSources.set(sectionKey, clone);
      return clone;
    };
    REVIEW_RATINGS.forEach(ratingValue => {
      const target = ratingPreviews.get(ratingValue);
      if (!target) return;
      try {
        let soonestDue = null;
        sections.forEach(({ key }) => {
          const source = resolveSource(key);
          const projection = projectSectionRating(source || item, key, ratingValue, durations, nowTs);
          if (!projection || !Number.isFinite(projection.due)) return;
          if (soonestDue == null || projection.due < soonestDue) {
            soonestDue = projection.due;
          }
        });
        if (soonestDue == null) {
          target.textContent = '';
          return;
        }
        const minutes = Math.max(0, Math.round((soonestDue - nowTs) / (60 * 1000)));
        target.textContent = formatReviewInterval(minutes);
      } catch (err) {
        target.textContent = '';
      }
    });
  };

  const renderPreviews = async () => {
    try {
      const durations = await durationsPromise;
      updatePreviews(durations);
    } catch (err) {
      // ignore preview failures
    }
  };

  const clearStatusInteraction = () => {
    status.classList.remove('quiz-rating-status-action');
    status.removeAttribute('role');
    status.removeAttribute('tabindex');
    status.removeAttribute('aria-label');
  };

  const makeStatusInteractive = (ariaLabel = '') => {
    status.classList.add('quiz-rating-status-action');
    status.setAttribute('role', 'button');
    status.setAttribute('tabindex', '0');
    if (ariaLabel) {
      status.setAttribute('aria-label', ariaLabel);
    }
  };

  const unlockRating = () => {
    if (!ratingLocked) return;
    ratingLocked = false;
    delete options.dataset.lock;
    clearStatusInteraction();
    if (adjustBtn) adjustBtn.hidden = true;
    delete ratingRow.dataset.state;
    Array.from(options.querySelectorAll('button')).forEach(btn => {
      btn.disabled = !isSolved;
      btn.classList.remove('is-locked-choice');
    });
    status.classList.remove('is-error');
    status.textContent = selectedRating
      ? 'Update rating (updates queue)'
      : 'Optional: set a rating to queue this card.';
    renderPreviews();
  };

  const applySessionLock = () => {
    ratingLocked = true;
    options.dataset.lock = 'session';
    Array.from(options.querySelectorAll('button')).forEach(btn => {
      const isSelected = btn.dataset.value === selectedRating;
      btn.disabled = !isSelected;
      btn.classList.toggle('is-locked-choice', !isSelected);
    });
    status.classList.remove('is-error');
    ratingRow.dataset.state = 'queued';
    status.textContent = 'Queued for review — click to adjust';
    makeStatusInteractive('Adjust saved rating');
    if (adjustBtn) adjustBtn.hidden = false;
  };

  const activateStatus = event => {
    if (!ratingLocked) return;
    event.preventDefault();
    event.stopPropagation();
    unlockRating();
  };

  status.addEventListener('click', activateStatus);
  status.addEventListener('keydown', event => {
    if (!ratingLocked) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateStatus(event);
    }
  });

  const updateSelection = (value) => {
    selectedRating = value;
    session.ratings[ratingId] = value;
    setQuizSession({ ...session });
    Array.from(options.querySelectorAll('button')).forEach(btn => {
      const btnValue = btn.dataset.value;
      const isSelected = btnValue === value;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
    status.classList.remove('is-error');
    updateNavState();
    renderPreviews();
  };

  const handleRating = async (value) => {
    const current = session.answers[session.idx];
    if (!(current && current.checked && (current.isCorrect || current.revealed))) return;
    if (ratingLocked) return;
    status.textContent = 'Saving…';
    status.classList.remove('is-error');
    try {
      const durations = await durationsPromise;
      const timestamp = Date.now();
      if (sections.length) {
        const sr = ensureItemSr(item);
        sr.sections = sr.sections || {};
        sections.forEach(({ key }) => {
          const baseKey = ratingKey(item, key);
          const snapshot = sectionSnapshots.get(key);
          if (!session.ratingBaselines[baseKey] && snapshot) {
            session.ratingBaselines[baseKey] = cloneSectionState(snapshot);
          }
          const stored = session.ratingBaselines[baseKey];
          if (stored) {
            sr.sections[key] = cloneSectionState(stored);
          }
        });
        sections.forEach(({ key }) => rateSection(item, key, value, durations, timestamp));
        await upsertItem(item);
      }
      updateSelection(value);
      applySessionLock();
      updatePreviews(durations);
    } catch (err) {
      console.error('Failed to record quiz rating', err);
      status.textContent = 'Save failed';
      status.classList.add('is-error');
    }
  };

  REVIEW_RATINGS.forEach(value => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.className = 'btn quiz-rating-btn';
    const variant = RATING_CLASS[value];
    if (variant) btn.classList.add(variant);
    const labelEl = document.createElement('span');
    labelEl.className = 'quiz-rating-btn-label';
    labelEl.textContent = RATING_LABELS[value];
    const previewEl = document.createElement('span');
    previewEl.className = 'quiz-rating-preview';
    btn.appendChild(labelEl);
    btn.appendChild(previewEl);
    ratingPreviews.set(value, previewEl);
    btn.disabled = !isSolved;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => handleRating(value));
    options.appendChild(btn);
  });

  renderPreviews();

  adjustBtn = document.createElement('button');
  adjustBtn.type = 'button';
  adjustBtn.className = 'quiz-rating-adjust';
  adjustBtn.textContent = 'Adjust';
  adjustBtn.hidden = true;
  adjustBtn.setAttribute('aria-label', 'Adjust rating');
  adjustBtn.addEventListener('click', event => {
    event.stopPropagation();
    unlockRating();
  });
  adjustBtn.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      unlockRating();
    }
  });

  if (selectedRating) {
    updateSelection(selectedRating);
    applySessionLock();
  } else {
    ratingLocked = false;
    delete options.dataset.lock;
    clearStatusInteraction();
    delete ratingRow.dataset.state;
  }

  if (!sections.length) {
    const note = document.createElement('div');
    note.className = 'quiz-rating-note';
    note.textContent = 'This card has no reviewable sections.';
    ratingPanel.appendChild(note);
  }

  ratingRow.appendChild(status);
  ratingRow.appendChild(adjustBtn);

  const controls = document.createElement('div');
  controls.className = 'quiz-controls';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn secondary';
  backBtn.textContent = 'Back';
  backBtn.disabled = pool.length === 0;
  backBtn.addEventListener('click', () => {
    const prevIdx = session.idx === 0 ? pool.length - 1 : session.idx - 1;
    setQuizSession({ ...session, idx: prevIdx });
    redraw();
  });
  controls.appendChild(backBtn);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn';
  nextBtn.textContent = 'Next';
  nextBtn.disabled = true;
  nextBtn.addEventListener('click', () => {
    const nextIdx = (session.idx + 1) % pool.length;
    setQuizSession({ ...session, idx: nextIdx });
    redraw();
  });
  controls.appendChild(nextBtn);

  card.appendChild(controls);

  const footer = document.createElement('div');
  footer.className = 'quiz-footer';


  const saveExit = document.createElement('button');
  saveExit.type = 'button';
  saveExit.className = 'btn secondary';
  saveExit.textContent = 'Save & close';
  saveExit.addEventListener('click', async () => {
    const original = saveExit.textContent;
    saveExit.disabled = true;
    saveExit.textContent = 'Saving…';
    try {
      await persistStudySession('quiz', {

        session: {
          ...session,
          idx: session.idx,
          pool,
          answers: session.answers,
          ratings: session.ratings
        },
        cohort: pool

      });
      setQuizSession(null);
      setStudySelectedMode('Quiz');
      setSubtab('Study', 'Builder');
      redraw();
    } catch (err) {
      console.error('Failed to save quiz progress', err);
      saveExit.textContent = 'Save failed';
      setTimeout(() => { saveExit.textContent = original; }, 2000);
    } finally {
      saveExit.disabled = false;
    }
  });

  footer.appendChild(saveExit);

  card.appendChild(footer);

  updateNavState();

  if (root?.dataset) root.dataset.questionIdx = String(session.idx);
  const shouldRestore = previousIdx === session.idx;
  const targetY = shouldRestore ? prevScrollY : 0;
  const canRestore = hasWindow || docScroller;
  if (canRestore) {
    const applyScroll = () => {
      if (hasWindow && typeof window.scrollTo === 'function') {
        window.scrollTo({ left: 0, top: targetY, behavior: 'auto' });
      } else if (docScroller) {
        docScroller.scrollTop = targetY;
      }
    };
    if (hasWindow && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(applyScroll);
    } else if (typeof setTimeout === 'function') {
      setTimeout(applyScroll, 0);
    } else {
      applyScroll();
    }
  }

  function gradeAnswer() {
    const guess = input.value.trim();
    if (!guess) return;
    const normalized = guess.toLowerCase();
    const correct = titleOf(item).toLowerCase();
    const isCorrect = normalized === correct;
    const answers = {
      ...session.answers,
      [session.idx]: { value: guess, isCorrect, checked: true, revealed: false }
    };
    const nextScore = computeScore(answers);
    session.answers = answers;
    session.score = nextScore;
    setQuizSession({ ...session });
    tally.textContent = `Score: ${session.score}`;
    feedback.textContent = isCorrect ? 'Correct!' : 'Incorrect. Try again or reveal the answer.';
    feedback.classList.remove('is-correct', 'is-incorrect');
    feedback.classList.add(isCorrect ? 'is-correct' : 'is-incorrect');
    clearSuggestions();
    revealBtn.hidden = isCorrect;
    if (!isCorrect) {
      revealBtn.disabled = false;
      revealBtn.focus();
    }
    updateNavState();
  }

  function updateNavState() {
    const currentAnswer = session.answers[session.idx];
    const solved = Boolean(currentAnswer && currentAnswer.checked && (currentAnswer.isCorrect || currentAnswer.revealed));
    nextBtn.disabled = !solved;
    Array.from(options.querySelectorAll('button')).forEach(btn => {
      btn.disabled = !solved;
    });
    if (!solved) {
      status.classList.remove('is-error');
      status.textContent = 'Optional: rate your confidence after answering.';
    } else {
      revealBtn.hidden = true;
    }
  }
}
