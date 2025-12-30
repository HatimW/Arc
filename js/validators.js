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

function inferKindFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.concept === 'string' && item.concept.trim()) return 'concept';
  const drugSignals = ['moa', 'uses', 'sideEffects', 'contraindications', 'source', 'class'];
  if (drugSignals.some(key => typeof item[key] === 'string' && item[key].trim())) {
    return 'drug';
  }
  const conceptSignals = ['definition', 'mechanism', 'clinicalRelevance', 'example', 'type'];
  if (conceptSignals.some(key => typeof item[key] === 'string' && item[key].trim())) {
    return 'concept';
  }
  const diseaseSignals = ['etiology', 'pathophys', 'clinical', 'diagnosis', 'treatment', 'complications', 'mnemonic'];
  if (diseaseSignals.some(key => typeof item[key] === 'string' && item[key].trim())) {
    return 'disease';
  }
  return 'disease';
}

export function cleanItem(item) {
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
  const normalizedKind = normalizeKindValue(item.kind);
  const inferredKind = normalizedKind || inferKindFromItem(item);
  return {
    ...item,
    kind: inferredKind,
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
