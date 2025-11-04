import { sectionDefsForKind, noteSectionUsage } from './sections.js';
import { hasRichTextContent } from './rich-text.js';

export const EXTRA_SECTION_PREFIX = 'extra:';

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rawExtras(item) {
  if (Array.isArray(item?.extras) && item.extras.length) {
    return item.extras;
  }
  if (Array.isArray(item?.facts) && item.facts.length) {
    return [{
      id: 'legacy-facts',
      title: 'Highlights',
      body: `<ul>${item.facts.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
    }];
  }
  return [];
}

function normalizeExtras(item) {
  const extras = rawExtras(item);
  const seenKeys = new Set();
  return extras.map((extra, index) => {
    const source = extra && typeof extra === 'object' ? extra : {};
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    const body = typeof source.body === 'string' ? source.body : '';
    let keyId = source.id != null && `${source.id}`.trim() ? `${source.id}`.trim() : `idx-${index}`;
    let key = `${EXTRA_SECTION_PREFIX}${keyId}`;
    let attempt = 0;
    while (seenKeys.has(key)) {
      attempt += 1;
      key = `${EXTRA_SECTION_PREFIX}${keyId}-${attempt}`;
    }
    seenKeys.add(key);
    return {
      key,
      id: source.id ?? null,
      title,
      body,
      index,
      source
    };
  });
}

function findExtraByKey(item, key) {
  if (!key || !key.startsWith(EXTRA_SECTION_PREFIX)) return null;
  return normalizeExtras(item).find(entry => entry.key === key) || null;
}

function hasRichContent(value) {
  if (typeof document === 'undefined') {
    if (value == null) return false;
    const text = String(value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim();
    return text.length > 0;
  }
  return hasRichTextContent(value);
}

export function hasSectionContent(item, key) {
  if (!item || !key) return false;
  if (key.startsWith(EXTRA_SECTION_PREFIX)) {
    const extra = findExtraByKey(item, key);
    return extra ? hasRichContent(extra.body) : false;
  }
  const defs = sectionDefsForKind(item.kind);
  if (!defs.some(def => def.key === key)) return false;
  const raw = item[key];
  if (raw === null || raw === undefined) return false;
  return hasRichContent(raw);
}

export function sectionsForItem(item, allowedKeys = null) {
  const defs = sectionDefsForKind(item.kind);
  const allowSet = allowedKeys ? new Set(allowedKeys) : null;
  const sections = defs
    .filter(def => (!allowSet || allowSet.has(def.key)) && hasSectionContent(item, def.key))
    .map(def => {
      noteSectionUsage(item?.id ?? null, def.key);
      return { key: def.key, label: def.label, content: item?.[def.key] || '' };
    });

  normalizeExtras(item).forEach(extra => {
    if (!hasRichContent(extra.body)) return;
    noteSectionUsage(item?.id ?? null, extra.key);
    sections.push({
      key: extra.key,
      label: extra.title || 'Additional Notes',
      content: extra.body,
      extra: true,
      extraId: extra.id
    });
  });

  return sections;
}

export function getSectionLabel(item, key) {
  if (key && key.startsWith(EXTRA_SECTION_PREFIX)) {
    const extra = findExtraByKey(item, key);
    return extra ? (extra.title || 'Additional Notes') : key;
  }
  const defs = sectionDefsForKind(item.kind);
  const def = defs.find(entry => entry.key === key);
  return def ? def.label : key;
}

export function getSectionContent(item, key) {
  if (key && key.startsWith(EXTRA_SECTION_PREFIX)) {
    const extra = findExtraByKey(item, key);
    return extra ? extra.body || '' : '';
  }
  return item?.[key] || '';
}
