export const UNASSIGNED_BLOCK = '__unassigned';
export const UNASSIGNED_WEEK = '__unassigned';
export const UNASSIGNED_LECTURE = '__unassigned';

let blockTitleCache = null;

export function ensureBlockTitleMap(blocks = []) {
  if (blockTitleCache) return blockTitleCache;
  const map = new Map();
  if (Array.isArray(blocks)) {
    blocks.forEach(block => {
      if (!block || !block.blockId) return;
      map.set(block.blockId, block.title || block.blockId);
    });
  }
  blockTitleCache = map;
  return map;
}

export function clearBlockTitleCache() {
  blockTitleCache = null;
}

export function titleOf(item) {
  return item?.name || item?.concept || 'Untitled';
}

export function formatOverdue(due, now) {
  const diffMs = Math.max(0, now - due);
  if (diffMs < 60 * 1000) return 'due now';
  const minutes = Math.round(diffMs / (60 * 1000));
  if (minutes < 60) return `${minutes} min overdue`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr overdue`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} overdue`;
}

export function formatTimeUntil(due, now) {
  const diffMs = Math.max(0, due - now);
  if (diffMs < 60 * 1000) return 'due in under a minute';
  const minutes = Math.round(diffMs / (60 * 1000));
  if (minutes < 60) return `due in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `due in ${hours} hr`;
  const days = Math.round(hours / 24);
  return `due in ${days} day${days === 1 ? '' : 's'}`;
}

export function formatIntervalMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
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

export function entryKey(entry) {
  if (!entry) return null;
  const itemId = entry.itemId || entry.item?.id || entry.item?.slug || entry.item?.name || 'item';
  return `${itemId}::${entry.sectionKey}`;
}

export function describePhase(phase) {
  switch (phase) {
    case 'learning':
      return 'Learning';
    case 'relearning':
      return 'Relearning';
    case 'review':
      return 'Review';
    case 'new':
      return 'New';
    default:
      return '';
  }
}

export function computeMasteryStage(state) {
  if (!state || typeof state !== 'object') return 'Unknown';
  if (state.retired) return 'Retired';
  const phase = state.phase || 'new';
  if (phase === 'new') return 'Naive';
  if (phase === 'learning') return 'Learning';
  if (phase === 'relearning') return 'Relearning';
  return 'Mature';
}

export function formatRelativePast(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Never reviewed';
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(months / 12);
  return `${years} yr ago`;
}

function registerEntry(bucket, entry) {
  if (!bucket || !entry) return;
  if (!bucket.entryMap) bucket.entryMap = new Map();
  const key = entryKey(entry);
  if (!key || bucket.entryMap.has(key)) return;
  bucket.entryMap.set(key, entry);
}

function finalizeEntries(bucket) {
  if (!bucket) return;
  const entries = bucket.entryMap ? Array.from(bucket.entryMap.values()) : [];
  bucket.entries = entries;
  delete bucket.entryMap;
}

function createBlockOrder(blocks = []) {
  const order = new Map();
  if (!Array.isArray(blocks)) return order;
  blocks.forEach((block, index) => {
    if (!block || !block.blockId) return;
    order.set(block.blockId, index);
  });
  return order;
}

export function resolveEntryRefs(entry, blockTitles = new Map()) {
  const item = entry?.item || {};
  const lectures = Array.isArray(item.lectures) ? item.lectures.filter(Boolean) : [];
  const blocks = Array.isArray(item.blocks) && item.blocks.length
    ? item.blocks
    : [];
  const weeks = Array.isArray(item.weeks) ? item.weeks : [];
  const results = [];

  if (lectures.length) {
    const seen = new Set();
    lectures.forEach(lec => {
      if (!lec) return;
      const blockId = lec.blockId || blocks[0] || UNASSIGNED_BLOCK;
      const lectureId = lec.id != null ? lec.id : UNASSIGNED_LECTURE;
      const rawWeek = lec.week;
      const weekNumber = Number.isFinite(Number(rawWeek)) ? Number(rawWeek) : null;
      const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
      const blockTitle = blockTitles.get(blockId)
        || (blockId === UNASSIGNED_BLOCK ? 'Unassigned block' : blockId || 'Unassigned block');
      const lectureLabel = lec.name ? lec.name : (lectureId !== UNASSIGNED_LECTURE ? `Lecture ${lectureId}` : 'Unassigned lecture');
      const weekLabel = weekNumber != null ? `Week ${weekNumber}` : 'Unassigned week';
      const lectureKey = `${blockId || UNASSIGNED_BLOCK}::${lectureId}`;
      const dedupKey = `${blockId || UNASSIGNED_BLOCK}::${weekId}::${lectureKey}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      results.push({
        blockId: blockId || UNASSIGNED_BLOCK,
        blockTitle,
        weekId,
        weekNumber,
        weekLabel,
        lectureKey,
        lectureId,
        lectureLabel
      });
    });
  } else {
    const blockIds = blocks.length ? blocks : [UNASSIGNED_BLOCK];
    const weekValues = weeks.length ? weeks : [null];
    const seen = new Set();
    blockIds.forEach(blockRaw => {
      const blockId = blockRaw || UNASSIGNED_BLOCK;
      const blockTitle = blockTitles.get(blockId)
        || (blockId === UNASSIGNED_BLOCK ? 'Unassigned block' : blockId || 'Unassigned block');
      weekValues.forEach(weekValue => {
        const weekNumber = Number.isFinite(Number(weekValue)) ? Number(weekValue) : null;
        const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
        const weekLabel = weekNumber != null ? `Week ${weekNumber}` : 'Unassigned week';
        const dedupKey = `${blockId}::${weekId}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        results.push({
          blockId,
          blockTitle,
          weekId,
          weekNumber,
          weekLabel,
          lectureKey: `${blockId}::${UNASSIGNED_LECTURE}`,
          lectureId: UNASSIGNED_LECTURE,
          lectureLabel: 'Unassigned lecture'
        });
      });
    });
    if (!results.length) {
      results.push({
        blockId: UNASSIGNED_BLOCK,
        blockTitle: 'Unassigned block',
        weekId: UNASSIGNED_WEEK,
        weekNumber: null,
        weekLabel: 'Unassigned week',
        lectureKey: `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`,
        lectureId: UNASSIGNED_LECTURE,
        lectureLabel: 'Unassigned lecture'
      });
    }
  }

  return results;
}

export function buildReviewHierarchy(entries, blocks, blockTitles) {
  const order = createBlockOrder(blocks);
  const root = {
    id: 'all',
    title: 'All cards',
    blocks: new Map(),
    entryMap: new Map()
  };

  const blockMap = root.blocks;
  entries.forEach(entry => {
    registerEntry(root, entry);
    const refs = resolveEntryRefs(entry, blockTitles);
    refs.forEach(ref => {
      const blockId = ref.blockId || UNASSIGNED_BLOCK;
      let blockNode = blockMap.get(blockId);
      if (!blockNode) {
        blockNode = {
          id: blockId,
          title: ref.blockTitle,
          order: order.has(blockId) ? order.get(blockId) : Number.MAX_SAFE_INTEGER,
          weeks: new Map(),
          entryMap: new Map()
        };
        blockMap.set(blockId, blockNode);
      }
      registerEntry(blockNode, entry);

      const weekKey = ref.weekId || UNASSIGNED_WEEK;
      let weekNode = blockNode.weeks.get(weekKey);
      if (!weekNode) {
        weekNode = {
          id: weekKey,
          blockId,
          label: ref.weekLabel,
          weekNumber: ref.weekNumber,
          lectures: new Map(),
          entryMap: new Map()
        };
        blockNode.weeks.set(weekKey, weekNode);
      }
      registerEntry(weekNode, entry);

      const lectureKey = ref.lectureKey || `${blockId}::${UNASSIGNED_LECTURE}`;
      let lectureNode = weekNode.lectures.get(lectureKey);
      if (!lectureNode) {
        lectureNode = {
          id: lectureKey,
          blockId,
          weekId: weekKey,
          weekNumber: ref.weekNumber,
          title: ref.lectureLabel,
          lectureId: ref.lectureId,
          entryMap: new Map()
        };
        weekNode.lectures.set(lectureKey, lectureNode);
      }
      registerEntry(lectureNode, entry);
    });
  });

  const blocksList = Array.from(blockMap.values());
  blocksList.forEach(blockNode => {
    const weekList = Array.from(blockNode.weeks.values());
    weekList.forEach(weekNode => {
      const lectureList = Array.from(weekNode.lectures.values());
      lectureList.forEach(lectureNode => finalizeEntries(lectureNode));
      lectureList.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      weekNode.lectures = lectureList;
      finalizeEntries(weekNode);
    });
    weekList.sort((a, b) => {
      const aNum = a.weekNumber;
      const bNum = b.weekNumber;
      if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
        if (aNum !== bNum) return aNum - bNum;
      } else if (Number.isFinite(aNum)) {
        return -1;
      } else if (Number.isFinite(bNum)) {
        return 1;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
    blockNode.weeks = weekList;
    finalizeEntries(blockNode);
  });

  blocksList.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });

  finalizeEntries(root);

  return {
    root,
    blocks: blocksList
  };
}

export function buildSessionPayload(entries) {
  return entries.map(entry => ({ item: entry.item, sections: [entry.sectionKey] }));
}

export function summarizeEntry(entry, blockTitles, now = Date.now()) {
  const refs = resolveEntryRefs(entry, blockTitles);
  const primary = refs[0] || {
    blockTitle: 'Unassigned block',
    weekLabel: 'Unassigned week',
    lectureLabel: 'Unassigned lecture'
  };
  const phaseLabel = describePhase(entry?.phase);
  const interval = entry?.state?.interval;
  const intervalText = Number.isFinite(interval) && interval > 0 ? formatIntervalMinutes(interval) : null;
  const stage = computeMasteryStage(entry?.state);
  const lastReviewed = formatRelativePast(entry?.state?.last, now);
  return {
    key: entryKey(entry),
    title: titleOf(entry?.item),
    sectionLabel: entry?.sectionLabel,
    phaseLabel,
    intervalText,
    stage,
    lastReviewed,
    dueText: formatOverdue(entry?.due ?? now, now),
    refs,
    primary
  };
}
