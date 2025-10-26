import { state, setFlashSession, setSubtab, setStudySelectedMode } from '../../state.js';
import { setToggleState } from '../../utils.js';
import { renderRichText } from './rich-text.js';
import { sectionsForItem } from './section-utils.js';
import { openEditor } from './editor.js';
import { REVIEW_RATINGS, DEFAULT_REVIEW_STEPS, RETIRE_RATING } from '../../review/constants.js';
import { getReviewDurations, rateSection, suspendSection, getSectionStateSnapshot, projectSectionRating, collectDueSections } from '../../review/scheduler.js';
import { upsertItem } from '../../storage/storage.js';
import { persistStudySession, removeStudySession } from '../../study/study-sessions.js';
import { openReviewMenu } from './review-menu.js';
import { buildReviewHierarchy } from './review.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { createBlockTitleMap, resolveSectionContexts, UNASSIGNED_BLOCK, UNASSIGNED_WEEK, UNASSIGNED_LECTURE } from '../../review/context.js';


const KIND_ACCENTS = {
  disease: 'var(--pink)',
  drug: 'var(--blue)',
  concept: 'var(--green)'
};


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


function describeDue(due, now) {
  if (!Number.isFinite(due)) return 'No due date';
  if (due <= now) {
    const diff = Math.max(0, now - due);
    const minutes = Math.round(diff / (60 * 1000));
    if (minutes < 1) return 'Due now';
    if (minutes < 60) return `${minutes} min overdue`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hr overdue`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} overdue`;
  }
  const diff = due - now;
  const minutes = Math.round(diff / (60 * 1000));
  if (minutes < 1) return 'Due soon';
  if (minutes < 60) return `Due in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Due in ${hours} hr`;
  const days = Math.round(hours / 24);
  return `Due in ${days} day${days === 1 ? '' : 's'}`;
}

function describeLastReviewed(last, now) {
  if (!Number.isFinite(last) || last <= 0) return 'Never reviewed';
  const diff = Math.max(0, now - last);
  const minutes = Math.round(diff / (60 * 1000));
  if (minutes < 1) return 'Reviewed just now';
  if (minutes < 60) return `Reviewed ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Reviewed ${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Reviewed ${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `Reviewed ${months} mo ago`;
  const years = Math.round(months / 12);
  return `Reviewed ${years} yr ago`;
}

function determineStage(snapshot) {
  if (!snapshot) return { label: 'New', variant: 'naive' };
  switch (snapshot.phase) {
    case 'review':
      return { label: 'Mature', variant: 'mature' };
    case 'learning':
    case 'relearning':
      return { label: 'Learning', variant: 'learning' };
    case 'new':
    default:
      return { label: 'Naive', variant: 'naive' };
  }
}

function formatReviewInterval(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo`;
  const years = Math.round(months / 12);
  return `${years} yr`;
}


let cachedBlockTitles = null;
let blockTitlePromise = null;

async function ensureBlockTitles() {
  if (cachedBlockTitles) return cachedBlockTitles;
  if (!blockTitlePromise) {
    blockTitlePromise = loadBlockCatalog()
      .then(({ blocks }) => {
        cachedBlockTitles = createBlockTitleMap(blocks);
        return cachedBlockTitles;
      })
      .catch(() => {
        cachedBlockTitles = createBlockTitleMap([]);
        return cachedBlockTitles;
      });
  }
  return blockTitlePromise;
}

function getFlashcardAccent(item) {
  if (item?.color) return item.color;
  if (item?.kind && KIND_ACCENTS[item.kind]) return KIND_ACCENTS[item.kind];
  return 'var(--accent)';
}


function queueStatusLabel(snapshot) {
  if (!snapshot || snapshot.retired) return 'Already in review queue';
  const rating = snapshot.lastRating;
  if (rating && RATING_LABELS[rating]) {
    return `In review (${RATING_LABELS[rating]})`;
  }
  return 'Already in review queue';
}

function ratingKey(item, sectionKey) {
  const id = item?.id || 'item';
  return `${id}::${sectionKey}`;
}

function sessionEntryAt(session, idx) {
  const pool = Array.isArray(session.pool) ? session.pool : [];
  return pool[idx] || null;
}

function normalizeFlashSession(session, fallbackPool, defaultMode = 'study') {
  const source = session && typeof session === 'object' ? session : {};
  const next = { ...source };
  let changed = !session || typeof session !== 'object';
  const fallback = Array.isArray(fallbackPool) ? fallbackPool : [];
  const pool = Array.isArray(source.pool) && source.pool.length ? source.pool : fallback;
  if (source.pool !== pool) {
    next.pool = pool;
    changed = true;
  }
  const ratings = source.ratings && typeof source.ratings === 'object' ? source.ratings : {};
  if (source.ratings !== ratings) {
    next.ratings = ratings;
    changed = true;
  }
  let idx = typeof source.idx === 'number' && Number.isFinite(source.idx) ? Math.floor(source.idx) : 0;
  if (idx < 0) idx = 0;
  const maxIdx = pool.length ? pool.length - 1 : 0;
  if (idx > maxIdx) idx = maxIdx;
  if (idx !== source.idx) {
    next.idx = idx;
    changed = true;
  }
  const mode = source.mode === 'review' ? 'review' : defaultMode;
  if (source.mode !== mode) {
    next.mode = mode;
    changed = true;
  }
  return changed ? next : session;
}

export function renderFlashcards(root, redraw) {
  const fallbackPool = Array.isArray(state.cohort) ? state.cohort : [];
  let active = state.flashSession;
  if (active) {
    const normalized = normalizeFlashSession(active, fallbackPool, active.mode === 'review' ? 'review' : 'study');
    if (normalized !== active) {
      setFlashSession(normalized);
      active = normalized;
    }
  } else {
    active = normalizeFlashSession({ idx: 0, pool: fallbackPool, ratings: {}, mode: 'study' }, fallbackPool, 'study');
  }
  active.ratings = active.ratings || {};
  const items = Array.isArray(active.pool) && active.pool.length ? active.pool : fallbackPool;


  const resolvePool = () => (Array.isArray(active.pool) && active.pool.length ? active.pool : items);
  const commitSession = (patch = {}) => {
    const pool = resolvePool();
    const next = { ...active, pool, ...patch };
    if (patch.ratings) {
      next.ratings = { ...patch.ratings };
    } else {
      next.ratings = { ...active.ratings };
    }
    active = next;
    setFlashSession(next);
  };

  const isReview = active.mode === 'review';

  root.innerHTML = '';

  if (!items.length) {
    const msg = document.createElement('div');
    msg.textContent = 'No cards selected. Adjust the filters above to add cards.';
    root.appendChild(msg);
    return;
  }

  if (active.idx >= items.length) {

    setFlashSession(null);
    setStudySelectedMode('Flashcards');
    setSubtab('Study', isReview ? 'Review' : 'Builder');
    if (isReview) {
      removeStudySession('review').catch(err => console.warn('Failed to clear review session', err));
    } else {
      removeStudySession('flashcards').catch(err => console.warn('Failed to clear flashcard session', err));
    }
    redraw();
    return;
  }

  const entry = sessionEntryAt(active, active.idx);
  const item = entry && entry.item ? entry.item : entry;
  if (!item) {
    setFlashSession(null);
    redraw();
    return;
  }

  const allowedSections = entry && entry.sections ? entry.sections : null;
  const sections = sectionsForItem(item, allowedSections);
  const primarySectionKey = Array.isArray(entry?.sections) && entry.sections.length
    ? entry.sections[0]
    : (sections[0]?.key ?? null);
  const primarySnapshot = primarySectionKey ? getSectionStateSnapshot(item, primarySectionKey) : null;
  const nowTs = Date.now();

  const card = document.createElement('section');
  card.className = 'card flashcard';
  card.tabIndex = 0;

  const header = document.createElement('div');
  header.className = 'flashcard-header';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'flashcard-title-group';

  const title = document.createElement('h2');
  title.className = 'flashcard-title';
  title.textContent = item.name || item.concept || '';
  titleGroup.appendChild(title);

  header.appendChild(titleGroup);

  const headerActions = document.createElement('div');
  headerActions.className = 'flashcard-header-actions';

  if (isReview) {
    const queueBtn = document.createElement('button');
    queueBtn.type = 'button';
    queueBtn.className = 'btn tertiary flashcard-queue-btn';
    queueBtn.textContent = 'Manage queue';
    queueBtn.title = 'Open review queue';
    queueBtn.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        const cohort = Array.isArray(state.cohort) ? state.cohort : [];
        const now = Date.now();
        const dueEntries = collectDueSections(cohort, { now });
        const { blocks } = await loadBlockCatalog();
        const blockTitles = createBlockTitleMap(blocks);
        const hierarchy = buildReviewHierarchy(dueEntries, blocks, blockTitles);
        const contexts = resolveSectionContexts(item, blockTitles);
        const preferredContext = contexts.find(ctx => ctx.lectureId && ctx.lectureId !== UNASSIGNED_LECTURE) || contexts[0] || null;
        let focus = { type: 'root' };
        if (preferredContext) {
          if (preferredContext.lectureId && preferredContext.lectureId !== UNASSIGNED_LECTURE) {
            focus = {
              type: 'lecture',
              blockId: preferredContext.blockId,
              weekId: preferredContext.weekId,
              lectureId: preferredContext.lectureId,
              lectureKey: preferredContext.lectureKey
            };
          } else if (preferredContext.weekId && preferredContext.weekId !== UNASSIGNED_WEEK) {
            focus = { type: 'week', blockId: preferredContext.blockId, weekId: preferredContext.weekId };
          } else if (preferredContext.blockId && preferredContext.blockId !== UNASSIGNED_BLOCK) {
            focus = { type: 'block', blockId: preferredContext.blockId };
          }
        }
        const focusEntryKey = primarySectionKey ? ratingKey(item, primarySectionKey) : null;
        openReviewMenu(hierarchy, {
          title: 'Review queue',
          now,
          startSession: (pool, metadata = {}) => {
            if (!Array.isArray(pool) || !pool.length) return;
            setFlashSession({ idx: 0, pool, ratings: {}, mode: 'review', metadata });
            redraw();
          },
          focus,
          focusEntryKey,
          onChange: () => redraw()
        });
      } catch (err) {
        console.error('Failed to open review menu', err);
      }
    });
    headerActions.appendChild(queueBtn);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'icon-btn flashcard-edit-btn';
  editBtn.innerHTML = '✏️';
  editBtn.title = 'Edit card';
  editBtn.setAttribute('aria-label', 'Edit card');
  editBtn.addEventListener('click', event => {
    event.stopPropagation();
    const onSave = typeof redraw === 'function' ? () => redraw() : undefined;
    openEditor(item.kind, onSave, item);
  });
  headerActions.appendChild(editBtn);

  header.appendChild(headerActions);
  card.appendChild(header);

  const metaRow = document.createElement('div');
  metaRow.className = 'flashcard-meta-row';

  const stageInfo = determineStage(primarySnapshot);
  const stageChip = document.createElement('span');
  stageChip.className = `flashcard-stage-chip stage-${stageInfo.variant}`;
  stageChip.textContent = stageInfo.label;
  metaRow.appendChild(stageChip);

  const dueChip = document.createElement('span');
  dueChip.className = 'flashcard-meta-chip';
  dueChip.textContent = describeDue(primarySnapshot?.due, nowTs);
  metaRow.appendChild(dueChip);

  const lastChip = document.createElement('span');
  lastChip.className = 'flashcard-meta-chip';
  lastChip.textContent = describeLastReviewed(primarySnapshot?.last, nowTs);
  metaRow.appendChild(lastChip);

  const intervalValue = Number.isFinite(primarySnapshot?.interval) ? primarySnapshot.interval : null;
  const intervalChip = document.createElement('span');
  intervalChip.className = 'flashcard-meta-chip';
  intervalChip.textContent = `Interval: ${intervalValue != null ? formatReviewInterval(intervalValue) : '—'}`;
  metaRow.appendChild(intervalChip);

  const contextRow = document.createElement('div');
  contextRow.className = 'flashcard-context-row';
  contextRow.textContent = '';

  metaRow.appendChild(contextRow);

  card.appendChild(metaRow);

  const reviewActionButtons = [];
  let reviewActionStatus = null;
  let reviewActionBusy = false;

  const sectionKeysForEntry = () => {
    if (Array.isArray(entry?.sections) && entry.sections.length) {
      return entry.sections.filter(Boolean);
    }
    return sections.map(section => section.key).filter(Boolean);
  };

  const setReviewStatus = (message, variant = '') => {
    if (!reviewActionStatus) return;
    reviewActionStatus.textContent = message;
    reviewActionStatus.classList.remove('is-error', 'is-success', 'is-pending');
    if (!variant) return;
    if (variant === 'error') {
      reviewActionStatus.classList.add('is-error');
    } else if (variant === 'pending') {
      reviewActionStatus.classList.add('is-pending');
    } else if (variant === 'success') {
      reviewActionStatus.classList.add('is-success');
    }
  };

  const setReviewBusy = (busy) => {
    reviewActionBusy = busy;
    reviewActionButtons.forEach(btn => { btn.disabled = busy; });
  };

  const performInlineReviewAction = async (action) => {
    if (!isReview || reviewActionBusy) return;
    const sectionKeys = sectionKeysForEntry();
    if (!sectionKeys.length) return;
    setReviewBusy(true);
    setReviewStatus(action === 'retire' ? 'Retiring card…' : 'Suspending card…', 'pending');
    let sessionCleared = false;
    try {
      const now = Date.now();
      if (action === 'retire') {
        const durations = await getReviewDurations();
        sectionKeys.forEach(key => rateSection(item, key, RETIRE_RATING, durations, now));
      } else {
        sectionKeys.forEach(key => suspendSection(item, key, now));
      }
      const nextRatings = { ...active.ratings };
      sectionKeys.forEach(key => { delete nextRatings[ratingKey(item, key)]; });
      await upsertItem(item);

      const nextPool = Array.isArray(active.pool) ? active.pool.slice() : [];
      if (active.idx >= 0 && active.idx < nextPool.length) {
        nextPool.splice(active.idx, 1);
      }

      if (!nextPool.length) {
        sessionCleared = true;
        setReviewStatus('', '');
        setFlashSession(null);
        setSubtab('Study', 'Review');
        redraw();
        return;
      }

      const nextIdx = Math.min(active.idx, nextPool.length - 1);
      commitSession({ pool: nextPool, idx: nextIdx, ratings: nextRatings });
      setReviewStatus('', '');
      redraw();
    } catch (err) {
      console.error('Failed to update review card', err);
      const failure = action === 'retire' ? 'Failed to retire card.' : 'Failed to suspend card.';
      setReviewStatus(failure, 'error');
    } finally {
      if (!sessionCleared) {
        setReviewBusy(false);
      }
    }
  };

  if (isReview) {
    const actionRow = document.createElement('div');
    actionRow.className = 'flashcard-review-actions';

    const suspendBtn = document.createElement('button');
    suspendBtn.type = 'button';
    suspendBtn.className = 'btn secondary';
    suspendBtn.textContent = 'Suspend card';
    suspendBtn.addEventListener('click', () => performInlineReviewAction('suspend'));
    actionRow.appendChild(suspendBtn);
    reviewActionButtons.push(suspendBtn);

    const retireBtn = document.createElement('button');
    retireBtn.type = 'button';
    retireBtn.className = 'btn tertiary danger';
    retireBtn.textContent = 'Retire card';
    retireBtn.addEventListener('click', () => performInlineReviewAction('retire'));
    actionRow.appendChild(retireBtn);
    reviewActionButtons.push(retireBtn);

    reviewActionStatus = document.createElement('span');
    reviewActionStatus.className = 'flashcard-review-status';
    actionRow.appendChild(reviewActionStatus);

    card.appendChild(actionRow);
  }

  ensureBlockTitles().then(blockTitles => {
    const contexts = resolveSectionContexts(item, blockTitles);
    contextRow.innerHTML = '';
    if (!contexts.length) {
      const chip = document.createElement('span');
      chip.className = 'flashcard-context-chip';
      chip.textContent = 'Unassigned';
      contextRow.appendChild(chip);
      return;
    }
    contexts.slice(0, 4).forEach(ctx => {
      const chip = document.createElement('span');
      chip.className = 'flashcard-context-chip';
      const labelParts = [];
      if (ctx.blockTitle && ctx.blockId !== UNASSIGNED_BLOCK) labelParts.push(ctx.blockTitle);
      if (ctx.weekLabel && ctx.weekId !== UNASSIGNED_WEEK) labelParts.push(ctx.weekLabel);
      if (ctx.lectureLabel && ctx.lectureId !== UNASSIGNED_LECTURE) labelParts.push(ctx.lectureLabel);
      chip.textContent = labelParts.length ? labelParts.join(' • ') : (ctx.blockTitle || 'Unassigned');
      contextRow.appendChild(chip);
    });
    if (contexts.length > 4) {
      const more = document.createElement('span');
      more.className = 'flashcard-context-chip is-muted';
      more.textContent = `+${contexts.length - 4} more`;
      contextRow.appendChild(more);
    }
  }).catch(() => {
    contextRow.innerHTML = '';
    const chip = document.createElement('span');
    chip.className = 'flashcard-context-chip is-muted';
    chip.textContent = 'Context unavailable';
    contextRow.appendChild(chip);
  });

  const durationsPromise = getReviewDurations().catch(() => ({ ...DEFAULT_REVIEW_STEPS }));
  const sectionBlocks = sections.length ? sections : [];
  const sectionRequirements = new Map();
  if (!sectionBlocks.length) {
    const empty = document.createElement('div');
    empty.className = 'flash-empty';
    empty.textContent = 'No content available for this card.';
    card.appendChild(empty);
  }

  sectionBlocks.forEach(({ key, label, content, extra }) => {
    const ratingId = ratingKey(item, key);
    const previousRating = active.ratings[ratingId] || null;
    const snapshot = getSectionStateSnapshot(item, key);
    const lockedByQueue = !isReview && Boolean(snapshot && snapshot.last && !snapshot.retired);
    const alreadyQueued = !isReview && Boolean(snapshot && snapshot.last && !snapshot.retired);
    const requiresRating = isReview || !alreadyQueued;
    sectionRequirements.set(key, requiresRating);
    const sec = document.createElement('div');
    sec.className = 'flash-section';
    if (extra) sec.classList.add('flash-section-extra');
    sec.setAttribute('role', 'button');
    sec.tabIndex = 0;

    const head = document.createElement('div');
    head.className = 'flash-heading';
    head.textContent = label;

    const body = document.createElement('div');
    body.className = 'flash-body';
    renderRichText(body, content || '', { clozeMode: 'interactive' });

    const ratingRow = document.createElement('div');
    ratingRow.className = 'flash-rating';

    const ratingButtons = document.createElement('div');
    ratingButtons.className = 'flash-rating-options';

    const status = document.createElement('span');
    status.className = 'flash-rating-status';

    let ratingLocked = lockedByQueue;

    const selectRating = (value) => {
      active.ratings[ratingId] = value;
      Array.from(ratingButtons.querySelectorAll('button')).forEach(btn => {
        const btnValue = btn.dataset.value;
        const isSelected = btnValue === value;
        btn.classList.toggle('is-selected', isSelected);

        if (isSelected) {
          ratingButtons.dataset.selected = value;
        } else if (ratingButtons.dataset.selected === btnValue) {
          delete ratingButtons.dataset.selected;
        }

        btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      });
      status.classList.remove('is-error');
      commitSession({ ratings: { ...active.ratings } });

    };

    const ratingPreviews = new Map();

    const updatePreviews = (durations) => {
      if (!durations) return;
      const nowTs = Date.now();
      REVIEW_RATINGS.forEach(ratingValue => {
        const target = ratingPreviews.get(ratingValue);
        if (!target) return;
        try {
          const projection = projectSectionRating(item, key, ratingValue, durations, nowTs);
          if (!projection || !Number.isFinite(projection.due)) {
            target.textContent = '';
            return;
          }
          const minutes = Math.max(0, Math.round((projection.due - nowTs) / (60 * 1000)));
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

    const handleRating = async (value) => {
      if (ratingLocked) return;

      const durations = await durationsPromise;
      setToggleState(sec, true, 'revealed');
      ratingRow.classList.add('is-saving');
      status.textContent = 'Saving…';
      status.classList.remove('is-error');
      try {
        rateSection(item, key, value, durations, Date.now());
        await upsertItem(item);
        selectRating(value);
        status.textContent = 'Saved';
        status.classList.remove('is-error');
        updatePreviews(durations);
      } catch (err) {
        console.error('Failed to record rating', err);
        status.textContent = 'Save failed';
        status.classList.add('is-error');
      } finally {
        ratingRow.classList.remove('is-saving');
      }
    };

    REVIEW_RATINGS.forEach(value => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.value = value;
      btn.dataset.rating = value;
      btn.className = 'flash-rating-btn';
      const variant = RATING_CLASS[value];
      if (variant) btn.classList.add(variant);
      btn.setAttribute('aria-pressed', 'false');
      const label = document.createElement('span');
      label.className = 'flash-rating-label';
      label.textContent = RATING_LABELS[value];
      const preview = document.createElement('span');
      preview.className = 'flash-rating-preview';
      btn.appendChild(label);
      btn.appendChild(preview);
      ratingPreviews.set(value, preview);
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        handleRating(value);
      });
      btn.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleRating(value);
        }
      });
      ratingButtons.appendChild(btn);
    });

    renderPreviews();

    const unlockRating = () => {
      if (!ratingLocked) return;
      ratingLocked = false;
      ratingRow.classList.remove('is-locked');
      ratingButtons.hidden = false;
      status.classList.remove('flash-rating-status-action');
      status.removeAttribute('role');
      status.removeAttribute('tabindex');
      status.textContent = previousRating ? 'Update rating' : 'Select a rating (optional)';
    };

    if (lockedByQueue) {
      ratingLocked = true;
      ratingRow.classList.add('is-locked');
      ratingButtons.hidden = true;
      const label = queueStatusLabel(snapshot);
      status.textContent = `${label} — click to adjust`;
      status.classList.add('flash-rating-status-action');
      status.setAttribute('role', 'button');
      status.setAttribute('tabindex', '0');
      status.setAttribute('aria-label', 'Update review rating');
      status.addEventListener('click', (event) => {
        event.stopPropagation();
        unlockRating();
      });
      status.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          unlockRating();
        }
      });
    } else if (previousRating) {
      status.textContent = 'Saved';
    } else {
      status.textContent = 'Select a rating (optional)';
    }

    if (previousRating) {
      selectRating(previousRating);

    }

    ratingRow.appendChild(ratingButtons);
    ratingRow.appendChild(status);

    setToggleState(sec, false, 'revealed');
    const toggleReveal = () => {
      if (sec.classList.contains('flash-section-disabled')) return;
      if (sec.contains(document.activeElement) && document.activeElement?.tagName === 'BUTTON') return;
      const next = sec.dataset.active !== 'true';
      setToggleState(sec, next, 'revealed');
    };
    sec.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement) {
        if (event.target.closest('.flash-rating')) return;
        if (event.target.closest('[data-cloze]')) return;
      }
      toggleReveal();
    });
    sec.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('.flash-rating')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleReveal();
      }
    });

    sec.appendChild(head);
    sec.appendChild(body);
    sec.appendChild(ratingRow);
    card.appendChild(sec);
  });

  const controls = document.createElement('div');
  controls.className = 'row flash-controls';

  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = 'Prev';
  prev.disabled = active.idx === 0;
  prev.addEventListener('click', () => {
    if (active.idx > 0) {

      commitSession({ idx: active.idx - 1 });

      redraw();
    }
  });
  controls.appendChild(prev);

  const next = document.createElement('button');
  next.className = 'btn';
  const isLast = active.idx >= items.length - 1;

  next.textContent = isLast ? (isReview ? 'Finish review' : 'Finish') : 'Next';

  next.addEventListener('click', () => {
    const pool = Array.isArray(active.pool) ? active.pool : items;
    const idx = active.idx + 1;
    if (idx >= items.length) {
      setFlashSession(null);
    } else {

      commitSession({ idx });

    }
    redraw();
  });
  controls.appendChild(next);

  if (!isReview) {
    const saveExit = document.createElement('button');
    saveExit.className = 'btn secondary';
    saveExit.textContent = 'Save & close';
    saveExit.addEventListener('click', async () => {
      const original = saveExit.textContent;
      saveExit.disabled = true;
      saveExit.textContent = 'Saving…';
      try {
        const pool = resolvePool();
        await persistStudySession('flashcards', {
          session: { ...active, idx: active.idx, pool, ratings: { ...(active.ratings || {}) } },

          cohort: pool
        });
        setFlashSession(null);
        setStudySelectedMode('Flashcards');
        setSubtab('Study', 'Builder');
        redraw();
      } catch (err) {
        console.error('Failed to save flashcard progress', err);
        saveExit.textContent = 'Save failed';
        setTimeout(() => { saveExit.textContent = original; }, 2000);
      } finally {
        saveExit.disabled = false;
      }
    });
    controls.appendChild(saveExit);
  } else {

    const saveExit = document.createElement('button');
    saveExit.className = 'btn secondary';
    saveExit.textContent = 'Pause & save';
    saveExit.addEventListener('click', async () => {
      const original = saveExit.textContent;
      saveExit.disabled = true;
      saveExit.textContent = 'Saving…';
      try {

        const pool = resolvePool();
        await persistStudySession('review', {
          session: { ...active, idx: active.idx, pool, ratings: { ...(active.ratings || {}) } },

          cohort: state.cohort,
          metadata: active.metadata || { label: 'Review session' }
        });
        setFlashSession(null);
        setSubtab('Study', 'Review');
        redraw();
      } catch (err) {
        console.error('Failed to save review session', err);
        saveExit.textContent = 'Save failed';
        setTimeout(() => { saveExit.textContent = original; }, 2000);
      } finally {
        saveExit.disabled = false;
      }
    });
    controls.appendChild(saveExit);
  }


  card.appendChild(controls);
  root.appendChild(card);

  card.focus();
  card.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      next.click();
    } else if (e.key === 'ArrowLeft') {
      prev.click();
    }
  });


  const accent = getFlashcardAccent(item);
  card.style.setProperty('--flash-accent', accent);
  card.style.setProperty('--flash-accent-soft', `color-mix(in srgb, ${accent} 22%, rgba(148, 163, 184, 0.18))`);
  card.style.setProperty('--flash-accent-strong', `color-mix(in srgb, ${accent} 34%, rgba(15, 23, 42, 0.1))`);
  card.style.setProperty('--flash-accent-border', `color-mix(in srgb, ${accent} 28%, rgba(148, 163, 184, 0.42))`);

}
