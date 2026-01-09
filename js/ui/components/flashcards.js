import { state, setFlashSession, setSubtab, setStudySelectedMode, setCohort } from '../../state.js';
import { setToggleState } from '../../utils.js';
import { renderRichText } from './rich-text.js';
import { sectionsForItem } from './section-utils.js';
import { openEditor } from './editor.js';
import { REVIEW_RATINGS, DEFAULT_REVIEW_STEPS } from '../../review/constants.js';
import {
  collectDueSections,
  getReviewDurations,
  rateSection,
  getSectionStateSnapshot,
  projectSectionRating,
  ensureItemSr
} from '../../review/scheduler.js';
import { upsertItem } from '../../storage/storage.js';
import { persistStudySession, removeStudySession } from '../../study/study-sessions.js';
import { loadReviewSourceItems } from '../../review/pool.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { ensureBlockTitleMap, ensureBlockAccentMap, buildReviewHierarchy, openEntryManager } from './review.js';
import {
  DEFAULT_REVIEW_ORDERING,
  ensureReviewOrdering,
  normalizeReviewCategory,
  orderReviewEntries
} from '../../review/order.js';


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


const REVIEW_CATEGORY_COLORS = {
  new: '#38bdf8',
  learning: '#f59e0b',
  review: '#34d399'
};

const REVIEW_CATEGORY_LABELS = {
  new: 'New',
  learning: 'Learning',
  review: 'Review'
};

const ORDER_PRESETS = [
  { id: 'mixed', label: 'Mixed (random)', ordering: { mode: 'mixed', priorities: [] } },
  { id: 'review-learning-new', label: 'Review → Learning → New', ordering: { mode: 'prioritized', priorities: ['review', 'learning', 'new'] } },
  { id: 'review-new-learning', label: 'Review → New → Learning', ordering: { mode: 'prioritized', priorities: ['review', 'new', 'learning'] } },
  { id: 'learning-review-new', label: 'Learning → Review → New', ordering: { mode: 'prioritized', priorities: ['learning', 'review', 'new'] } },
  { id: 'learning-new-review', label: 'Learning → New → Review', ordering: { mode: 'prioritized', priorities: ['learning', 'new', 'review'] } },
  { id: 'new-review-learning', label: 'New → Review → Learning', ordering: { mode: 'prioritized', priorities: ['new', 'review', 'learning'] } },
  { id: 'new-learning-review', label: 'New → Learning → Review', ordering: { mode: 'prioritized', priorities: ['new', 'learning', 'review'] } }
];

function orderingsEqual(a, b) {
  if (!a || !b) return false;
  if (a.mode !== b.mode) return false;
  const aList = Array.isArray(a.priorities) ? a.priorities : [];
  const bList = Array.isArray(b.priorities) ? b.priorities : [];
  if (aList.length !== bList.length) return false;
  for (let i = 0; i < aList.length; i += 1) {
    if (aList[i] !== bList[i]) return false;
  }
  return true;
}

function findPresetId(ordering) {
  const normalized = ensureReviewOrdering(ordering);
  const match = ORDER_PRESETS.find(preset => orderingsEqual(ensureReviewOrdering(preset.ordering), normalized));
  return match ? match.id : 'review-learning-new';
}

function deriveReviewCategory(entry, snapshot) {
  if (entry && typeof entry.category === 'string') {
    return normalizeReviewCategory(entry.category);
  }
  const state = snapshot || null;
  if (!state || typeof state !== 'object') return 'new';
  const { phase, lastRating } = state;
  if (phase === 'review') return 'review';
  if (phase === 'relearning') return 'learning';
  if (phase === 'learning') {
    if (!lastRating || lastRating === 'again') return 'new';
    return 'learning';
  }
  if (lastRating === 'again') return 'new';
  if (lastRating === 'easy' || lastRating === 'good' || lastRating === 'hard') return 'learning';
  return 'new';
}


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


function getFlashcardAccent(item) {
  if (item?.color) return item.color;
  if (item?.kind && KIND_ACCENTS[item.kind]) return KIND_ACCENTS[item.kind];
  return 'var(--accent)';
}


function cloneSectionState(state) {
  if (!state || typeof state !== 'object') return null;
  return JSON.parse(JSON.stringify(state));
}


function queueStatusLabel(snapshot) {
  if (!snapshot || snapshot.retired) return 'Already in review queue';
  const rating = snapshot.lastRating;
  if (rating && RATING_LABELS[rating]) {
    return `In review (${RATING_LABELS[rating]})`;
  }
  return 'Already in review queue';
}

function entryIdentifier(item = {}, fallbackId = 'item') {
  return item.id || item.slug || item.name || fallbackId;
}

function reviewEntryKey(entry) {
  if (!entry) return null;
  const itemId = entry.itemId || entryIdentifier(entry.item);
  const section = entry.sectionKey || (Array.isArray(entry.sections) ? entry.sections[0] : null);
  if (!itemId || !section) return null;
  return `${itemId}::${section}`;
}

function sessionEntryKey(entry) {
  if (!entry) return null;
  const section = Array.isArray(entry.sections) && entry.sections.length ? entry.sections[0] : entry.sectionKey;
  return reviewEntryKey({ item: entry.item, sectionKey: section });
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
  const baselines = source.ratingBaselines && typeof source.ratingBaselines === 'object'
    ? source.ratingBaselines
    : {};
  if (source.ratingBaselines !== baselines) {
    next.ratingBaselines = baselines;
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
  const ordering = ensureReviewOrdering(source.reviewOrdering);
  if (!orderingsEqual(source.reviewOrdering, ordering)) {
    next.reviewOrdering = ordering;
    changed = true;
  } else if (source.reviewOrdering !== ordering) {
    next.reviewOrdering = ordering;
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
  active.ratingBaselines = active.ratingBaselines && typeof active.ratingBaselines === 'object'
    ? active.ratingBaselines
    : {};
  const items = Array.isArray(active.pool) && active.pool.length ? active.pool : fallbackPool;


  const resolvePool = () => (Array.isArray(active.pool) && active.pool.length ? active.pool : items);
  const commitSession = (patch = {}) => {
    const pool = resolvePool();
    const next = { ...active, pool, ...patch };
    next.ratings = patch.ratings ? { ...patch.ratings } : { ...active.ratings };
    next.ratingBaselines = patch.ratingBaselines
      ? { ...patch.ratingBaselines }
      : { ...active.ratingBaselines };
    next.reviewOrdering = ensureReviewOrdering(patch.reviewOrdering ? patch.reviewOrdering : active.reviewOrdering);
    active = next;
    setFlashSession(next);
  };

  const isReview = active.mode === 'review';

  const syncReviewSession = async () => {
    if (!isReview) return;
    try {
      const nowTs = Date.now();
      const cohortItems = await loadReviewSourceItems();
      setCohort(cohortItems);
      const dueEntries = collectDueSections(cohortItems, { now: nowTs });
      const dueKeys = new Set(dueEntries.map(reviewEntryKey).filter(Boolean));
      const pool = resolvePool();
      const filtered = pool.filter(entry => {
        const key = sessionEntryKey(entry);
        return !key || dueKeys.has(key);
      });
      if (filtered.length === pool.length) return;
      let idx = active.idx;
      if (idx >= filtered.length) idx = Math.max(filtered.length - 1, 0);
      commitSession({ pool: filtered, idx });
      redraw();
    } catch (err) {
      console.error('Failed to sync review session', err);
    }
  };

  const openQueueManager = async (focusEntry = null, triggerBtn = null) => {
    if (!isReview) return;
    if (triggerBtn) triggerBtn.disabled = true;
    try {
      const nowTs = Date.now();
      const cohortItems = await loadReviewSourceItems();
      setCohort(cohortItems);
      const dueEntries = collectDueSections(cohortItems, { now: nowTs });
      const { blocks } = await loadBlockCatalog();
      const blockTitles = ensureBlockTitleMap(blocks);
      const blockAccents = ensureBlockAccentMap(blocks);
      const hierarchy = buildReviewHierarchy(dueEntries, blocks, blockTitles, blockAccents);
      const highlightKey = focusEntry ? sessionEntryKey(focusEntry) : null;
      let focusFilter = null;
      if (highlightKey && hierarchy?.contexts instanceof Map) {
        const contexts = hierarchy.contexts.get(highlightKey);
        if (Array.isArray(contexts) && contexts.length) {
          const ctx = contexts[0];
          focusFilter = {
            scope: 'lecture',
            lectureKey: ctx.lectureKey,
            blockId: ctx.blockId,
            weekId: ctx.weekId
          };
        }
      }
      openEntryManager(hierarchy, {
        title: 'Manage review queue',
        now: nowTs,
        startSession: async (pool, metadata = {}) => {
          await removeStudySession('review').catch(err => console.warn('Failed to clear saved review entry', err));
          setFlashSession({ idx: 0, pool, ratings: {}, mode: 'review', metadata });
          redraw();
        },
        metadata: { scope: 'all', label: 'All due cards' },
        focus: focusFilter || undefined,
        highlightEntryKey: highlightKey,
        onChange: syncReviewSession
      });
    } catch (err) {
      console.error('Failed to open review manager', err);
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  };

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

  const allowedSections = entry && entry.sections ? entry.sections : (entry && entry.sectionKey ? [entry.sectionKey] : null);
  const sections = sectionsForItem(item, allowedSections);

  const card = document.createElement('section');
  card.className = 'card flashcard';
  card.tabIndex = 0;
  if (isReview) {
    card.classList.add('is-review');
  }

  const totalCount = items.length;

  const header = document.createElement('div');
  header.className = 'flashcard-header';

  const headerInfo = document.createElement('div');
  headerInfo.className = 'flashcard-header-info';
  header.appendChild(headerInfo);

  const title = document.createElement('h2');
  title.className = 'flashcard-title';
  title.textContent = item.name || item.concept || '';
  headerInfo.appendChild(title);

  const progress = document.createElement('div');
  progress.className = 'flashcard-progress';
  progress.textContent = totalCount ? `Card ${active.idx + 1} of ${totalCount}` : 'Card 0 of 0';
  headerInfo.appendChild(progress);

  let categoryBadge = null;
  if (isReview) {
    categoryBadge = document.createElement('span');
    categoryBadge.className = 'flashcard-category';
    categoryBadge.hidden = true;
    headerInfo.appendChild(categoryBadge);
  }

  const headerActions = document.createElement('div');
  headerActions.className = 'flashcard-header-actions';
  header.appendChild(headerActions);

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

  if (isReview) {
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'icon-btn flashcard-manage-btn';
    manageBtn.innerHTML = '⚙';
    manageBtn.title = 'Manage review queue';
    manageBtn.setAttribute('aria-label', 'Manage review queue');
    manageBtn.addEventListener('click', event => {
      event.stopPropagation();
      openQueueManager(entry, manageBtn);
    });
    headerActions.appendChild(manageBtn);
  }

  card.appendChild(header);

  let orderSelect = null;
  const applyReviewOrdering = (ordering) => {
    const normalizedOrdering = ensureReviewOrdering(ordering);
    const pool = resolvePool();
    if (!Array.isArray(pool) || !pool.length) {
      commitSession({ reviewOrdering: normalizedOrdering });
      redraw();
      return;
    }
    const currentIdx = active.idx;
    const leading = pool.slice(0, currentIdx);
    const currentEntry = pool[currentIdx];
    const remainder = pool.slice(currentIdx + 1);
    const reorderedTail = orderReviewEntries(remainder, normalizedOrdering);
    const nextPool = currentEntry
      ? [...leading, currentEntry, ...reorderedTail]
      : [...leading, ...reorderedTail];
    commitSession({ pool: nextPool, reviewOrdering: normalizedOrdering });
    redraw();
  };

  if (isReview) {
    const orderingControls = document.createElement('div');
    orderingControls.className = 'flashcard-ordering';
    const controlId = `flashcard-ordering-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const orderLabel = document.createElement('label');
    orderLabel.className = 'flashcard-ordering-label';
    orderLabel.setAttribute('for', controlId);
    orderLabel.textContent = 'Order cards';
    orderingControls.appendChild(orderLabel);

    orderSelect = document.createElement('select');
    orderSelect.className = 'input flashcard-ordering-select';
    orderSelect.id = controlId;
    ORDER_PRESETS.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      orderSelect.appendChild(option);
    });
    const presetId = findPresetId(active.reviewOrdering);
    const initialPreset = ORDER_PRESETS.find(preset => preset.id === presetId) || ORDER_PRESETS[1];
    orderSelect.value = initialPreset.id;
    orderSelect.addEventListener('change', () => {
      const preset = ORDER_PRESETS.find(entryPreset => entryPreset.id === orderSelect.value) || initialPreset;
      applyReviewOrdering(preset.ordering);
    });
    orderingControls.appendChild(orderSelect);

    card.appendChild(orderingControls);
  }

  const durationsPromise = getReviewDurations().catch(() => ({ ...DEFAULT_REVIEW_STEPS }));
  const sectionBlocks = sections.length ? sections : [];
  const sectionRequirements = new Map();
  let reviewCategory = isReview && typeof entry?.category === 'string'
    ? normalizeReviewCategory(entry.category)
    : null;
  if (!sectionBlocks.length) {
    const empty = document.createElement('div');
    empty.className = 'flash-empty';
    empty.textContent = 'No content available for this card.';
    card.appendChild(empty);
  }

  sectionBlocks.forEach(({ key, label, content, extra }) => {
    const ratingId = ratingKey(item, key);
    let currentRating = active.ratings[ratingId] || null;
    const snapshot = getSectionStateSnapshot(item, key);
    if (isReview && !reviewCategory && snapshot) {
      reviewCategory = deriveReviewCategory(entry, snapshot);
    }
    if (snapshot && !active.ratingBaselines[ratingId]) {
      active.ratingBaselines[ratingId] = cloneSectionState(snapshot);
    }
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
    renderRichText(body, content || '', { clozeMode: 'interactive', resetClozeState: true });

    const ratingRow = document.createElement('div');
    ratingRow.className = 'flash-rating';

    const ratingButtons = document.createElement('div');
    ratingButtons.className = 'flash-rating-options';

    const status = document.createElement('span');
    status.className = 'flash-rating-status';

    let ratingLocked = lockedByQueue;
    let adjustBtn = null;

    const clearStatusInteraction = () => {
      status.classList.remove('flash-rating-status-action');
      status.removeAttribute('role');
      status.removeAttribute('tabindex');
      status.removeAttribute('aria-label');
    };

    const makeStatusInteractive = (ariaLabel = '') => {
      status.classList.add('flash-rating-status-action');
      status.setAttribute('role', 'button');
      status.setAttribute('tabindex', '0');
      if (ariaLabel) {
        status.setAttribute('aria-label', ariaLabel);
      }
    };

    const setLockState = reason => {
      ratingLocked = true;
      ratingRow.classList.add('is-locked');
      if (reason) {
        ratingRow.dataset.lock = reason;
      } else {
        delete ratingRow.dataset.lock;
      }
      if (adjustBtn) adjustBtn.hidden = false;
    };

    const releaseLock = () => {
      ratingLocked = false;
      ratingRow.classList.remove('is-locked');
      delete ratingRow.dataset.lock;
      delete ratingRow.dataset.state;
      clearStatusInteraction();
      if (adjustBtn) adjustBtn.hidden = true;
      ratingButtons.hidden = false;
    };

    const unlockRating = () => {
      if (!ratingLocked) return;
      releaseLock();
      ratingButtons.hidden = false;
      Array.from(ratingButtons.querySelectorAll('button')).forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('is-locked-choice');
      });
      status.classList.remove('is-error');
      status.textContent = currentRating ? 'Update rating (updates queue)' : 'Select a rating to queue for review';
      renderPreviews();
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

    const selectRating = (value) => {
      currentRating = value;
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
      const baselineState = active.ratingBaselines[ratingId] || null;
      const projectionSource = baselineState ? (() => {
        const clone = JSON.parse(JSON.stringify(item));
        if (!clone.sr || typeof clone.sr !== 'object') clone.sr = {};
        clone.sr.version = clone.sr.version || (item.sr && item.sr.version) || 1;
        clone.sr.sections = clone.sr.sections && typeof clone.sr.sections === 'object'
          ? { ...clone.sr.sections }
          : {};
        clone.sr.sections[key] = cloneSectionState(baselineState);
        return clone;
      })() : null;
      REVIEW_RATINGS.forEach(ratingValue => {
        const target = ratingPreviews.get(ratingValue);
        if (!target) return;
        try {
          const projection = projectSectionRating(projectionSource ? projectionSource : item, key, ratingValue, durations, nowTs);
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

    const applyQueueLock = () => {
      const label = queueStatusLabel(snapshot);
      setLockState('queue');
      ratingButtons.hidden = true;
      ratingRow.dataset.state = 'queued';
      status.textContent = `${label} — click to adjust`;
      makeStatusInteractive('Update review rating');
    };

    const applySessionLock = () => {
      setLockState('session');
      ratingButtons.hidden = false;
      Array.from(ratingButtons.querySelectorAll('button')).forEach(btn => {
        const isSelected = btn.dataset.value === currentRating;
        btn.disabled = !isSelected;
        btn.classList.toggle('is-locked-choice', !isSelected);
      });
      status.classList.remove('is-error');
      ratingRow.dataset.state = 'queued';
      status.textContent = 'Queued for review — click to adjust';
      makeStatusInteractive('Adjust saved rating');
    };

    const handleRating = async (value) => {
      if (ratingLocked) return;

      const durations = await durationsPromise;
      setToggleState(sec, true, 'revealed');
      ratingRow.classList.add('is-saving');
      status.textContent = 'Saving…';
      status.classList.remove('is-error');
      try {
        if (!active.ratingBaselines[ratingId] && snapshot) {
          active.ratingBaselines[ratingId] = cloneSectionState(snapshot);
        }
        const baselineState = active.ratingBaselines[ratingId];
        if (baselineState) {
          const sr = ensureItemSr(item);
          sr.sections = sr.sections || {};
          sr.sections[key] = cloneSectionState(baselineState);
        }
        rateSection(item, key, value, durations, Date.now());
        await upsertItem(item);
        selectRating(value);
        applySessionLock();
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

    adjustBtn = document.createElement('button');
    adjustBtn.type = 'button';
    adjustBtn.className = 'flash-rating-adjust';
    adjustBtn.textContent = 'Adjust';
    adjustBtn.setAttribute('aria-label', 'Adjust rating');
    adjustBtn.hidden = true;
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

    if (lockedByQueue) {
      applyQueueLock();
    } else if (currentRating) {
      selectRating(currentRating);
      applySessionLock();
    } else {
      releaseLock();
      status.textContent = 'Select a rating to queue for review';
    }

    ratingRow.appendChild(ratingButtons);
    ratingRow.appendChild(status);
    ratingRow.appendChild(adjustBtn);

    setToggleState(sec, false, 'revealed');
    const toggleReveal = () => {
      if (sec.classList.contains('flash-section-disabled')) return;
      if (sec.contains(document.activeElement) && document.activeElement?.tagName === 'BUTTON') return;
      const next = sec.dataset.active !== 'true';
      setToggleState(sec, next, 'revealed');
    };
    sec.addEventListener('click', (event) => {
      if (event.detail > 1) return;
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

  if (isReview) {
    const normalizedCategory = reviewCategory ? normalizeReviewCategory(reviewCategory) : 'new';
    card.dataset.reviewCategory = normalizedCategory;
    const categoryColor = REVIEW_CATEGORY_COLORS[normalizedCategory];
    if (categoryColor) {
      card.style.setProperty('--review-category-color', categoryColor);
    } else {
      card.style.removeProperty('--review-category-color');
    }
    if (categoryBadge) {
      categoryBadge.textContent = `${REVIEW_CATEGORY_LABELS[normalizedCategory]} card`;
      categoryBadge.dataset.category = normalizedCategory;
      categoryBadge.hidden = false;
    }
  } else {
    card.style.removeProperty('--review-category-color');
  }

  const controls = document.createElement('div');
  controls.className = 'row flash-controls';

  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = 'Prev';
  prev.disabled = isReview ? active.idx === 0 : totalCount === 0;
  prev.addEventListener('click', () => {
    if (isReview) {
      if (active.idx > 0) {
        commitSession({ idx: active.idx - 1 });
        redraw();
      }
    } else if (totalCount > 0) {
      const prevIdx = totalCount > 1
        ? (active.idx === 0 ? totalCount - 1 : active.idx - 1)
        : 0;
      commitSession({ idx: prevIdx });
      redraw();
    }
  });
  controls.appendChild(prev);

  const next = document.createElement('button');
  next.className = 'btn';
  next.textContent = 'Next';
  const isLast = active.idx >= totalCount - 1;
  next.disabled = isReview ? isLast : totalCount === 0;
  next.addEventListener('click', () => {
    if (isReview) {
      if (active.idx < totalCount - 1) {
        commitSession({ idx: active.idx + 1 });
        redraw();
      }
      return;
    }
    if (!totalCount) return;
    const nextIdx = totalCount > 1 ? (active.idx + 1) % totalCount : active.idx;
    commitSession({ idx: nextIdx });
    redraw();
  });
  controls.appendChild(next);

  let finishBtn = null;
  if (isReview) {
    finishBtn = document.createElement('button');
    finishBtn.type = 'button';
    finishBtn.className = 'btn flash-finish-btn';
    finishBtn.textContent = 'Finish review';
    finishBtn.addEventListener('click', async () => {
      finishBtn.disabled = true;
      setFlashSession(null);
      setStudySelectedMode('Flashcards');
      setSubtab('Study', 'Review');
      try {
        await removeStudySession('review').catch(err => console.warn('Failed to clear saved review entry', err));
      } finally {
        redraw();
      }
    });
    controls.appendChild(finishBtn);
  }

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
          session: {
            ...active,
            idx: active.idx,
            pool,
            ratings: { ...(active.ratings || {}) },
            reviewOrdering: ensureReviewOrdering(active.reviewOrdering)
          },

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

  const sessionWrap = document.createElement('div');
  sessionWrap.className = 'flashcard-session';
  if (isReview) sessionWrap.classList.add('is-review');
  sessionWrap.appendChild(card);
  root.appendChild(sessionWrap);

  card.focus();
  card.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      if (!next.disabled) {
        next.click();
      } else if (isReview && finishBtn) {
        finishBtn.focus();
      }
    } else if (e.key === 'ArrowLeft') {
      if (!prev.disabled) {
        prev.click();
      } else if (!isReview && totalCount > 1) {
        prev.click();
      }
    }
  });


  const accent = getFlashcardAccent(item);
  card.style.setProperty('--flash-accent', accent);
  card.style.setProperty('--flash-accent-soft', `color-mix(in srgb, ${accent} 16%, transparent)`);
  card.style.setProperty('--flash-accent-strong', `color-mix(in srgb, ${accent} 32%, rgba(15, 23, 42, 0.08))`);
  card.style.setProperty('--flash-accent-border', `color-mix(in srgb, ${accent} 42%, transparent)`);

}
