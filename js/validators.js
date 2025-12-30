import { normalizeSrRecord } from './review/sr-data.js';

const randomId = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function legacyFactsToHtml(facts = []) {
  return facts
    .map(f => `<p>${escapeHtml(f)}</p>`)
    .join('');
}

function normalizeKindValue(value) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'diseases') return 'disease';
  if (normalized === 'drugs') return 'drug';
  if (normalized === 'concepts') return 'concept';
  return normalized;
}

export function cleanItem(item) {
  const rawKind = item?.kind || item?.type || item?.category;
  const extras = Array.isArray(item.extras) ? item.extras : [];
  const normalizedExtras = extras
    .map(ex => {
      if (!ex || typeof ex !== 'object') return null;
      const id = typeof ex.id === 'string' && ex.id ? ex.id : randomId();
      const title = typeof ex.title === 'string' ? ex.title : '';
      const body = typeof ex.body === 'string' ? ex.body : '';
      if (!title.trim() && !body.trim()) return null;
      return { id, title: title.trim(), body };
    })
    .filter(Boolean);
  if (!normalizedExtras.length && Array.isArray(item.facts) && item.facts.length) {
    normalizedExtras.push({
      id: randomId(),
      title: 'Highlights',
      body: legacyFactsToHtml(item.facts)
    });
  }
  return {
    ...item,
    kind: normalizeKindValue(rawKind),
    favorite: !!item.favorite,
    color: item.color || null,
    extras: normalizedExtras,
    facts: normalizedExtras.length ? [] : (Array.isArray(item.facts) ? item.facts : []),
    tags: item.tags || [],
    links: item.links || [],
    blocks: item.blocks || [],
    weeks: item.weeks || [],
    lectures: item.lectures || [],
    sr: normalizeSrRecord(item.sr)
  };
}
