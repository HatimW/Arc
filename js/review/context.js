export const UNASSIGNED_BLOCK = '__unassigned';
export const UNASSIGNED_WEEK = '__unassigned';
export const UNASSIGNED_LECTURE = '__unassigned';

function internalNormalizeLectureScope(scope) {
  if (!Array.isArray(scope) || !scope.length) return [];
  const normalized = scope
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}

export function createBlockTitleMap(blocks = []) {
  const map = new Map();
  if (!Array.isArray(blocks)) return map;
  blocks.forEach(block => {
    if (!block || !block.blockId) return;
    map.set(block.blockId, block.title || block.blockId);
  });
  return map;
}

export function resolveSectionContexts(item, blockTitles = new Map()) {
  const results = [];
  if (!item || typeof item !== 'object') return results;

  const lectures = Array.isArray(item.lectures) ? item.lectures.filter(Boolean) : [];
  const blocks = Array.isArray(item.blocks) && item.blocks.length ? item.blocks : [];
  const weeks = Array.isArray(item.weeks) ? item.weeks : [];

  if (lectures.length) {
    const seen = new Set();
    lectures.forEach(lecture => {
      if (!lecture) return;
      const blockId = lecture.blockId || blocks[0] || UNASSIGNED_BLOCK;
      const lectureId = lecture.id != null ? lecture.id : UNASSIGNED_LECTURE;
      const rawWeek = lecture.week;
      const weekNumber = Number.isFinite(Number(rawWeek)) ? Number(rawWeek) : null;
      const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
      const blockTitle = blockTitles.get(blockId) || (blockId === UNASSIGNED_BLOCK ? 'Unassigned block' : blockId || 'Unassigned block');
      const lectureLabel = lecture.name ? lecture.name : (lectureId !== UNASSIGNED_LECTURE ? `Lecture ${lectureId}` : 'Unassigned lecture');
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
      const blockTitle = blockTitles.get(blockId) || (blockId === UNASSIGNED_BLOCK ? 'Unassigned block' : blockId || 'Unassigned block');
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

export function normalizeLectureScope(scope) {
  return internalNormalizeLectureScope(scope);
}
