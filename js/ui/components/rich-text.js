import { readFileAsDataUrl, editImageSource } from './media-upload.js';

const allowedTags = new Set([
  'a','b','strong','i','em','u','s','strike','del','mark','span','font','p','div','br','ul','ol','li','img','sub','sup','blockquote','code','pre','hr','video','audio','source','iframe'
]);

const allowedAttributes = {
  'a': ['href', 'title', 'target', 'rel'],
  'img': ['src', 'alt', 'title', 'width', 'height', 'data-occlusions', 'data-highlights', 'data-textboxes'],
  'span': ['style', 'data-cloze'],
  'div': ['style'],
  'p': ['style'],
  'font': ['style', 'color', 'face', 'size'],
  'blockquote': ['style'],
  'code': ['style'],
  'pre': ['style'],
  'video': ['src', 'controls', 'width', 'height', 'poster', 'preload', 'loop', 'muted', 'playsinline'],
  'audio': ['src', 'controls', 'preload', 'loop', 'muted'],
  'source': ['src', 'type'],
  'iframe': ['src', 'title', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder']
};

const allowedStyles = new Set([
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-decoration-line',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-style',
  'text-align'
]);

const RICH_TEXT_CACHE_LIMIT = 400;
const richTextCache = new Map();
const richTextCacheKeys = [];

function escapeHtml(str = ''){
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const htmlEntityDecoder = typeof document !== 'undefined'
  ? document.createElement('textarea')
  : null;

function decodeHtmlEntities(str = ''){
  if (!str) return '';
  if (!htmlEntityDecoder) return String(str);
  htmlEntityDecoder.innerHTML = str;
  return htmlEntityDecoder.value;
}

const IMAGE_OCCLUSION_ATTR = 'data-occlusions';
const IMAGE_HIGHLIGHT_ATTR = 'data-highlights';
const IMAGE_TEXTBOX_ATTR = 'data-textboxes';
const IMAGE_OCCLUSION_EVENT = 'imageocclusionchange';

const WORKSPACE_HIGHLIGHT_COLORS = [
  '#facc15', // amber
  '#60a5fa', // blue
  '#f472b6', // pink
  '#34d399', // green
  '#f97316'  // orange
];

function clamp(value, min, max){
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function ensureOcclusionId(box){
  if (box && typeof box.id === 'string' && box.id) {
    return box.id;
  }
  const rand = Math.random().toString(36).slice(2, 8);
  const stamp = Date.now().toString(36);
  return `occ-${stamp}-${rand}`;
}

function ensureAnnotationId(prefix, annotation){
  if (annotation && typeof annotation.id === 'string' && annotation.id) {
    return annotation.id;
  }
  const rand = Math.random().toString(36).slice(2, 8);
  const stamp = Date.now().toString(36);
  return `${prefix}-${stamp}-${rand}`;
}

function normalizeOcclusionBox(box){
  if (!box || typeof box !== 'object') return null;
  const id = ensureOcclusionId(box);
  const x = clamp(box.x, 0, 1);
  const y = clamp(box.y, 0, 1);
  const width = clamp(box.width, 0, 1);
  const height = clamp(box.height, 0, 1);
  if (width <= 0 || height <= 0) return null;
  const maxWidth = Math.max(0, 1 - x);
  const maxHeight = Math.max(0, 1 - y);
  const normalizedWidth = Math.min(width, maxWidth);
  const normalizedHeight = Math.min(height, maxHeight);
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return null;
  return {
    id,
    x,
    y,
    width: normalizedWidth,
    height: normalizedHeight
  };
}

function parseImageOcclusions(image){
  if (!(image instanceof HTMLImageElement)) return [];
  const attr = image.getAttribute(IMAGE_OCCLUSION_ATTR);
  if (!attr) return [];
  try {
    const parsed = JSON.parse(attr);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeOcclusionBox)
      .filter(Boolean);
  } catch (err) {
    console.warn('Failed to parse image occlusions', err);
    return [];
  }
}

function writeImageOcclusions(image, boxes){
  if (!(image instanceof HTMLImageElement)) return [];
  const normalized = Array.isArray(boxes)
    ? boxes.map(normalizeOcclusionBox).filter(Boolean)
    : [];
  if (!normalized.length) {
    image.removeAttribute(IMAGE_OCCLUSION_ATTR);
    return [];
  }
  image.setAttribute(IMAGE_OCCLUSION_ATTR, JSON.stringify(normalized));
  return normalized;
}

function sanitizeHighlightColor(value){
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) {
    return trimmed.length === 4
      ? `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
      : trimmed.toLowerCase();
  }
  const lower = trimmed.toLowerCase();
  const allowed = new Set(WORKSPACE_HIGHLIGHT_COLORS.map(color => color.toLowerCase()));
  if (allowed.has(lower)) return lower;
  return null;
}

function highlightColorToRgba(color, alpha){
  if (typeof color !== 'string') return `rgba(250, 204, 21, ${alpha})`;
  const normalized = sanitizeHighlightColor(color) || WORKSPACE_HIGHLIGHT_COLORS[0];
  const hex = normalized.replace('#', '');
  const value = hex.length === 3
    ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : hex;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const safeAlpha = clamp(alpha, 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
}

function normalizeHighlightBox(box){
  if (!box || typeof box !== 'object') return null;
  const id = ensureAnnotationId('hlt', box);
  const x = clamp(box.x, 0, 1);
  const y = clamp(box.y, 0, 1);
  const width = clamp(box.width, 0, 1);
  const height = clamp(box.height, 0, 1);
  if (width <= 0 || height <= 0) return null;
  const maxWidth = Math.max(0, 1 - x);
  const maxHeight = Math.max(0, 1 - y);
  const normalizedWidth = Math.min(width, maxWidth);
  const normalizedHeight = Math.min(height, maxHeight);
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return null;
  const color = sanitizeHighlightColor(box.color) || WORKSPACE_HIGHLIGHT_COLORS[0];
  return {
    id,
    x,
    y,
    width: normalizedWidth,
    height: normalizedHeight,
    color
  };
}

function parseImageHighlights(image){
  if (!(image instanceof HTMLImageElement)) return [];
  const attr = image.getAttribute(IMAGE_HIGHLIGHT_ATTR);
  if (!attr) return [];
  try {
    const parsed = JSON.parse(attr);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeHighlightBox).filter(Boolean);
  } catch (err) {
    console.warn('Failed to parse image highlights', err);
    return [];
  }
}

function writeImageHighlights(image, boxes){
  if (!(image instanceof HTMLImageElement)) return [];
  const normalized = Array.isArray(boxes)
    ? boxes.map(normalizeHighlightBox).filter(Boolean)
    : [];
  if (!normalized.length) {
    image.removeAttribute(IMAGE_HIGHLIGHT_ATTR);
    return [];
  }
  image.setAttribute(IMAGE_HIGHLIGHT_ATTR, JSON.stringify(normalized));
  return normalized;
}

function sanitizeTextboxContent(value){
  const plain = sanitizeToPlainText(String(value || ''));
  if (!plain) return '';
  return plain.slice(0, 1000);
}

function normalizeTextbox(box){
  if (!box || typeof box !== 'object') return null;
  const id = ensureAnnotationId('txt', box);
  const x = clamp(box.x, 0, 1);
  const y = clamp(box.y, 0, 1);
  const width = clamp(box.width, 0, 1);
  const height = clamp(box.height, 0, 1);
  if (width <= 0 || height <= 0) return null;
  const maxWidth = Math.max(0, 1 - x);
  const maxHeight = Math.max(0, 1 - y);
  const normalizedWidth = Math.min(width, maxWidth);
  const normalizedHeight = Math.min(height, maxHeight);
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return null;
  const text = sanitizeTextboxContent(box.text || '');
  return {
    id,
    x,
    y,
    width: normalizedWidth,
    height: normalizedHeight,
    text
  };
}

function parseImageTextboxes(image){
  if (!(image instanceof HTMLImageElement)) return [];
  const attr = image.getAttribute(IMAGE_TEXTBOX_ATTR);
  if (!attr) return [];
  try {
    const parsed = JSON.parse(attr);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTextbox).filter(Boolean);
  } catch (err) {
    console.warn('Failed to parse image text boxes', err);
    return [];
  }
}

function writeImageTextboxes(image, boxes){
  if (!(image instanceof HTMLImageElement)) return [];
  const normalized = Array.isArray(boxes)
    ? boxes.map(normalizeTextbox).filter(Boolean)
    : [];
  if (!normalized.length) {
    image.removeAttribute(IMAGE_TEXTBOX_ATTR);
    return [];
  }
  image.setAttribute(IMAGE_TEXTBOX_ATTR, JSON.stringify(normalized));
  return normalized;
}

function notifyImageOcclusionChange(image){
  if (!(image instanceof HTMLImageElement)) return;
  try {
    image.dispatchEvent(new CustomEvent(IMAGE_OCCLUSION_EVENT, { bubbles: false }));
  } catch (err) {
    // ignore environments without CustomEvent
  }
}

function computeImageDisplayMetrics(image){
  if (!(image instanceof HTMLImageElement)) return null;
  const rect = image.getBoundingClientRect();
  const containerWidth = rect.width || image.clientWidth || image.offsetWidth || 0;
  const containerHeight = rect.height || image.clientHeight || image.offsetHeight || 0;
  const naturalWidth = image.naturalWidth || containerWidth;
  const naturalHeight = image.naturalHeight || containerHeight;
  if (containerWidth <= 0 || containerHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return {
      offsetX: 0,
      offsetY: 0,
      width: containerWidth,
      height: containerHeight
    };
  }
  const containerRatio = containerWidth / containerHeight;
  const imageRatio = naturalWidth / naturalHeight;
  let drawnWidth = containerWidth;
  let drawnHeight = containerHeight;
  let offsetX = 0;
  let offsetY = 0;
  if (Math.abs(containerRatio - imageRatio) > 0.0001) {
    if (containerRatio > imageRatio) {
      drawnHeight = containerHeight;
      drawnWidth = drawnHeight * imageRatio;
      offsetX = (containerWidth - drawnWidth) / 2;
    } else {
      drawnWidth = containerWidth;
      drawnHeight = drawnWidth / imageRatio;
      offsetY = (containerHeight - drawnHeight) / 2;
    }
  }
  return {
    offsetX,
    offsetY,
    width: drawnWidth,
    height: drawnHeight
  };
}

function resolveImageMetrics(target){
  if (!target) return null;
  if (target instanceof HTMLImageElement) {
    return computeImageDisplayMetrics(target);
  }
  if (typeof target === 'object' && target) {
    const width = Number(target.width);
    const height = Number(target.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      const offsetX = Number(target.offsetX) || 0;
      const offsetY = Number(target.offsetY) || 0;
      return { offsetX, offsetY, width, height };
    }
  }
  return null;
}

function applyOcclusionBoxGeometry(element, box, target){
  if (!element || !box) return;
  const metrics = resolveImageMetrics(target);
  if (metrics && metrics.width > 0 && metrics.height > 0) {
    const left = metrics.offsetX + clamp(box.x, 0, 1) * metrics.width;
    const top = metrics.offsetY + clamp(box.y, 0, 1) * metrics.height;
    const width = clamp(box.width, 0, 1) * metrics.width;
    const height = clamp(box.height, 0, 1) * metrics.height;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    return;
  }
  element.style.left = `${box.x * 100}%`;
  element.style.top = `${box.y * 100}%`;
  element.style.width = `${box.width * 100}%`;
  element.style.height = `${box.height * 100}%`;
}

function getImageContentRect(image){
  if (!(image instanceof HTMLImageElement)) return null;
  const rect = image.getBoundingClientRect();
  const metrics = computeImageDisplayMetrics(image);
  if (!metrics) return rect;
  const left = rect.left + metrics.offsetX;
  const top = rect.top + metrics.offsetY;
  return {
    left,
    top,
    width: metrics.width,
    height: metrics.height,
    right: left + metrics.width,
    bottom: top + metrics.height
  };
}

function setOcclusionRevealState(element, revealed){
  if (!element) return;
  const isRevealed = revealed === true;
  element.classList.toggle('is-revealed', isRevealed);
  element.setAttribute('aria-pressed', isRevealed ? 'true' : 'false');
}

const richContentManagers = new WeakMap();
let activeImageLightbox = null;

function isSafeUrl(value = '', { allowData = false, requireHttps = false } = {}){
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^javascript:/i.test(trimmed)) return false;
  if (!allowData && /^data:/i.test(trimmed)) return false;
  if (/^blob:/i.test(trimmed)) return true;
  if (requireHttps) {
    if (trimmed.startsWith('//')) return true;
    if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true;
    if (/^https:/i.test(trimmed)) return true;
    return false;
  }
  return true;
}

function cleanStyles(node){
  const style = node.getAttribute('style');
  if (!style) return;
  const cleaned = style
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [rawProp, ...valueParts] = part.split(':');
      if (!rawProp || !valueParts.length) return null;
      const prop = rawProp.trim().toLowerCase();
      if (!allowedStyles.has(prop)) return null;
      return `${prop}: ${valueParts.join(':').trim()}`;
    })
    .filter(Boolean)
    .join('; ');
  if (cleaned) node.setAttribute('style', cleaned);
  else node.removeAttribute('style');
}

function sanitizeNode(node){
  if (node.nodeType === Node.TEXT_NODE) return;
  if (node.nodeType === Node.COMMENT_NODE) {
    node.remove();
    return;
  }
  const tag = node.tagName?.toLowerCase();
  if (!tag) return;
  if (!allowedTags.has(tag)) {
    if (node.childNodes.length) {
      const parent = node.parentNode;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      node.remove();
    } else {
      node.remove();
    }
    return;
  }
  const attrs = Array.from(node.attributes || []);
  const allowList = allowedAttributes[tag] || [];
  attrs.forEach(attr => {
    const name = attr.name.toLowerCase();
    if (name === 'style') {
      cleanStyles(node);
      return;
    }
    if (!allowList.includes(name)) {
      node.removeAttribute(attr.name);
      return;
    }
    if (tag === 'a' && name === 'href') {
      const value = attr.value.trim();
      if (!value || value.startsWith('javascript:')) {
        node.removeAttribute(attr.name);
      } else {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (name === 'src' && ['img','video','audio','source','iframe'].includes(tag)) {
      const allowData = tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'source';
      const requireHttps = tag === 'iframe';
      if (!isSafeUrl(attr.value || '', { allowData, requireHttps })) {
        node.removeAttribute(attr.name);
      }
    }
  });
  Array.from(node.childNodes).forEach(sanitizeNode);
}

const CLOZE_ATTR = 'data-cloze';
const CLOZE_VALUE = 'true';
const CLOZE_SELECTOR = `[${CLOZE_ATTR}="${CLOZE_VALUE}"]`;

function createClozeSpan(content){
  const span = document.createElement('span');
  span.setAttribute(CLOZE_ATTR, CLOZE_VALUE);
  span.textContent = content;
  return span;
}

function upgradeClozeSyntax(root){
  if (!root) return;
  const braceRegex = /\{([^{}]+)\}/g;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!node?.nodeValue || node.nodeValue.indexOf('{') === -1) {
          return NodeFilter.FILTER_SKIP;
        }
        if (node.parentElement?.closest(CLOZE_SELECTOR)) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  targets.forEach(node => {
    const text = node.nodeValue || '';
    let match;
    braceRegex.lastIndex = 0;
    let lastIndex = 0;
    let replaced = false;
    const fragment = document.createDocumentFragment();
    while ((match = braceRegex.exec(text))) {
      const before = text.slice(lastIndex, match.index);
      if (before) fragment.appendChild(document.createTextNode(before));
      const inner = match[1];
      const trimmed = inner.trim();
      if (trimmed) {
        fragment.appendChild(createClozeSpan(trimmed));
        replaced = true;
      } else {
        fragment.appendChild(document.createTextNode(match[0]));
      }
      lastIndex = match.index + match[0].length;
    }
    if (!replaced) return;
    const after = text.slice(lastIndex);
    if (after) fragment.appendChild(document.createTextNode(after));
    const parent = node.parentNode;
    if (!parent) return;
    parent.insertBefore(fragment, node);
    parent.removeChild(node);
  });
}

export function sanitizeHtml(html = ''){
  const template = document.createElement('template');
  template.innerHTML = html;
  Array.from(template.content.childNodes).forEach(sanitizeNode);
  upgradeClozeSyntax(template.content);
  return template.innerHTML;
}

function sanitizeToPlainText(html = '') {
  if (!html) return '';
  const template = document.createElement('template');
  template.innerHTML = sanitizeHtml(html);
  const text = template.content.textContent || '';
  return text.replace(/\u00a0/g, ' ');
}

export function htmlToPlainText(html = '') {
  return sanitizeToPlainText(html);
}

function normalizeInput(value = ''){
  if (value == null) return '';
  const str = String(value);
  if (!str) return '';
  const looksHtml = /<([a-z][^>]*>)/i.test(str);
  if (looksHtml) return sanitizeHtml(str);
  const decoded = decodeHtmlEntities(str);
  return sanitizeHtml(escapeHtml(decoded).replace(/\r?\n/g, '<br>'));
}

const FONT_SIZE_VALUES = [10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48];

const FONT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: '"Inter", "Segoe UI", sans-serif', label: 'Modern Sans' },
  { value: '"Helvetica Neue", Arial, sans-serif', label: 'Classic Sans' },
  { value: '"Times New Roman", Times, serif', label: 'Serif' },
  { value: '"Source Code Pro", Menlo, monospace', label: 'Monospace' },
  { value: '"Comic Neue", "Comic Sans MS", cursive', label: 'Handwriting' }
];

export function isEmptyHtml(html = ''){
  if (!html) return true;
  const template = document.createElement('template');
  template.innerHTML = html;
  const hasMedia = template.content.querySelector('img,video,audio,iframe');
  const text = template.content.textContent?.replace(/\u00a0/g, ' ').trim();
  return !hasMedia && !text;
}

function createToolbarButton(label, title, onClick){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rich-editor-btn';
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.dataset.toggle = 'true';
  btn.dataset.active = 'false';
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', onClick);
  return btn;
}

export function createRichTextEditor({ value = '', onChange, ariaLabel, ariaLabelledBy } = {}){
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-editor';

  const toolbar = document.createElement('div');
  toolbar.className = 'rich-editor-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Text formatting toolbar');
  wrapper.appendChild(toolbar);

  const imageFileInput = document.createElement('input');
  imageFileInput.type = 'file';
  imageFileInput.accept = 'image/*';
  imageFileInput.style.display = 'none';
  wrapper.appendChild(imageFileInput);

  const mediaFileInput = document.createElement('input');
  mediaFileInput.type = 'file';
  mediaFileInput.accept = 'video/*,audio/*';
  mediaFileInput.style.display = 'none';
  wrapper.appendChild(mediaFileInput);

  let pendingImageTarget = null;
  let activeImageEditor = null;
  let occlusionDisplayManager = null;

  function loadImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        resolve({
          width: image.naturalWidth || image.width || 0,
          height: image.naturalHeight || image.height || 0
        });
      };
      image.onerror = () => reject(new Error('Failed to load image preview.'));
      image.src = dataUrl;
    });
  }

  function sanitizeImageDimension(value) {
    if (!Number.isFinite(value)) return null;
    const MIN_SIZE = 32;
    const MAX_SIZE = 4096;
    const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(value)));
    return clamped > 0 ? clamped : null;
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    const meta = parts[0];
    const base64 = parts.slice(1).join(',');
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    try {
      const binary = atob(base64);
      const len = binary.length;
      const buffer = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        buffer[i] = binary.charCodeAt(i);
      }
      return new Blob([buffer], { type: mime });
    } catch (err) {
      console.warn('Failed to convert image for clipboard', err);
      return null;
    }
  }

  async function resolveImageBlob(image) {
    if (!(image instanceof HTMLImageElement)) return null;
    const src = image.getAttribute('src') || '';
    if (!src) return null;
    if (src.startsWith('data:')) {
      return dataUrlToBlob(src);
    }
    try {
      const response = await fetch(src);
      if (!response.ok) return null;
      return await response.blob();
    } catch (err) {
      console.warn('Failed to read image for clipboard', err);
      return null;
    }
  }

  async function insertImageFile(file, targetImage = null) {
    if (!(file instanceof File)) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) return;

      let dimensions = { width: null, height: null };
      try {
        dimensions = await loadImageDimensions(dataUrl);
      } catch (err) {
        // Fallback to inserting without explicit dimensions if preview fails
        dimensions = { width: null, height: null };
      }

      const width = sanitizeImageDimension(dimensions.width);
      const height = sanitizeImageDimension(dimensions.height);
      const defaultAlt = (file.name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

      if (targetImage && wrapper.contains(targetImage)) {
        const existingAlt = targetImage.getAttribute('alt') || '';
        const altText = existingAlt.trim() || defaultAlt;
        targetImage.src = dataUrl;
        if (altText) {
          targetImage.setAttribute('alt', altText);
        } else {
          targetImage.removeAttribute('alt');
        }
        setImageSize(targetImage, width, height);
        writeImageOcclusions(targetImage, []);
        notifyImageOcclusionChange(targetImage);
        if (occlusionDisplayManager) occlusionDisplayManager.notifyChange(targetImage);
        triggerEditorChange();
        if (activeImageEditor && activeImageEditor.image === targetImage && typeof activeImageEditor.update === 'function') {
          requestAnimationFrame(() => activeImageEditor.update());
        }
      } else {
        const safeAlt = defaultAlt ? escapeHtml(defaultAlt) : '';
        const altAttr = safeAlt ? ` alt="${safeAlt}"` : '';
        const widthAttr = width ? ` width="${width}"` : '';
        const heightAttr = height ? ` height="${height}"` : '';
        const html = `<img src="${dataUrl}"${widthAttr}${heightAttr}${altAttr}>`;
        insertHtml(html);
      }
    } catch (err) {
      console.error('Failed to upload image', err);
    }
  }

  async function insertMediaFile(file) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) return;
      const isAudio = file.type?.startsWith('audio/');
      if (isAudio) {
        insertHtml(`<audio controls preload="metadata" src="${dataUrl}"></audio>`);
      } else {
        insertHtml(`<video controls preload="metadata" src="${dataUrl}" width="640"></video>`);
      }
    } catch (err) {
      console.error('Failed to add media file', err);
    }
  }

  imageFileInput.addEventListener('change', () => {
    const file = imageFileInput.files?.[0];
    const target = pendingImageTarget;
    pendingImageTarget = null;
    if (file) insertImageFile(file, target);
    imageFileInput.value = '';
  });

  mediaFileInput.addEventListener('change', () => {
    const file = mediaFileInput.files?.[0];
    if (file) insertMediaFile(file);
    mediaFileInput.value = '';
  });

  const editable = document.createElement('div');
  editable.className = 'rich-editor-area input';
  editable.contentEditable = 'true';
  editable.spellcheck = true;
  editable.innerHTML = normalizeInput(value);
  if (ariaLabel) editable.setAttribute('aria-label', ariaLabel);
  if (ariaLabelledBy) editable.setAttribute('aria-labelledby', ariaLabelledBy);
  wrapper.appendChild(editable);

  editable.addEventListener('paste', (event) => {
    if (!event.clipboardData) return;
    const files = Array.from(event.clipboardData.files || []);
    const imageFile = files.find(file => file && file.type && file.type.startsWith('image/')) || null;
    if (imageFile) {
      event.preventDefault();
      void insertImageFile(imageFile);
      return;
    }
    const mediaFile = files.find(file => file && file.type && (file.type.startsWith('video/') || file.type.startsWith('audio/')));
    if (mediaFile) {
      event.preventDefault();
      void insertMediaFile(mediaFile);
      return;
    }
    const html = event.clipboardData.getData('text/html');
    let text = event.clipboardData.getData('text/plain');
    if (!text && html) {
      text = sanitizeToPlainText(html);
    }
    event.preventDefault();
    insertPlainText(text || '');
  });

  editable.addEventListener('copy', async (event) => {
    try {
      if (!event.clipboardData) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!editable.contains(range.startContainer) || !editable.contains(range.endContainer)) {
        return;
      }
      const fragment = range.cloneContents();
      if (!fragment || fragment.childNodes.length === 0) return;
      const container = document.createElement('div');
      container.appendChild(fragment);
      const images = Array.from(container.querySelectorAll('img'));
      if (!images.length) return;
      event.preventDefault();
      const plain = selection.toString();
      event.clipboardData.setData('text/plain', plain || '');
      event.clipboardData.setData('text/html', container.innerHTML);
      if (navigator.clipboard?.write && typeof ClipboardItem === 'function') {
        const blob = await resolveImageBlob(images[0]);
        if (blob) {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type || 'image/png']: blob })
            ]);
          } catch (err) {
            console.warn('Failed to write image to clipboard', err);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to process copy event', err);
    }
  });

  occlusionDisplayManager = createEditorOcclusionDisplayManager(wrapper, editable, beginImageEditing);

  function triggerEditorChange(){
    editable.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setImageSize(image, width, height){
    if (!(image instanceof HTMLImageElement)) return;
    const MIN_SIZE = 32;
    const MAX_SIZE = 4096;
    const widthValue = Number.isFinite(width) ? Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(width))) : null;
    const heightValue = Number.isFinite(height) ? Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(height))) : null;
    if (widthValue) {
      image.style.width = `${widthValue}px`;
      image.setAttribute('width', String(widthValue));
    } else {
      image.style.removeProperty('width');
      image.removeAttribute('width');
    }
    if (heightValue) {
      image.style.height = `${heightValue}px`;
      image.setAttribute('height', String(heightValue));
    } else {
      image.style.removeProperty('height');
      image.removeAttribute('height');
    }
  }

  function destroyActiveImageEditor(){
    if (activeImageEditor && typeof activeImageEditor.destroy === 'function') {
      activeImageEditor.destroy();
    }
    activeImageEditor = null;
  }

  function beginImageEditing(image){
    if (!(image instanceof HTMLImageElement)) return;
    if (!wrapper.contains(image)) return;
    if (activeImageEditor && activeImageEditor.image === image) {
      if (typeof activeImageEditor.update === 'function') {
        requestAnimationFrame(() => activeImageEditor.update());
      }
      return;
    }
    destroyActiveImageEditor();
    activeImageEditor = createImageEditor(image);
    if (activeImageEditor && typeof activeImageEditor.update === 'function') {
      requestAnimationFrame(() => activeImageEditor.update());
    }
  }

  function createImageEditor(image){
    const overlay = document.createElement('div');
    overlay.className = 'rich-editor-image-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    const toolbar = document.createElement('div');
    toolbar.className = 'rich-editor-image-toolbar';

    const cropBtn = document.createElement('button');
    cropBtn.type = 'button';
    cropBtn.className = 'rich-editor-image-tool';
    cropBtn.textContent = 'Crop';

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.className = 'rich-editor-image-tool';
    replaceBtn.textContent = 'Replace';

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'rich-editor-image-tool rich-editor-image-tool--primary';
    doneBtn.textContent = 'Done';

    toolbar.append(cropBtn, replaceBtn, doneBtn);
    overlay.appendChild(toolbar);

    const occlusionToggle = document.createElement('button');
    occlusionToggle.type = 'button';
    occlusionToggle.className = 'rich-editor-image-occlude';
    occlusionToggle.setAttribute('aria-label', 'Edit image occlusions');
    occlusionToggle.setAttribute('aria-pressed', 'false');
    occlusionToggle.title = 'Edit image occlusions';
    occlusionToggle.innerHTML = '👁';
    occlusionToggle.dataset.active = 'false';
    overlay.appendChild(occlusionToggle);

    let resizeState = null;

    const handleOcclusionGeometryChange = () => {
      occlusionDisplayManager?.notifyChange(image);
      requestAnimationFrame(() => update());
    };

    const occlusionEditor = createImageOcclusionEditor(handleOcclusionGeometryChange);

    occlusionToggle.addEventListener('click', (event) => {
      event.preventDefault();
      occlusionEditor.activate();
    });

    const handleDefs = [
      { name: 'se', axis: 'both', label: 'Resize from corner' },
      { name: 'e', axis: 'x', label: 'Resize width' },
      { name: 's', axis: 'y', label: 'Resize height' }
    ];

    const onPointerMove = (event) => {
      if (!resizeState) return;
      event.preventDefault();
      const dx = event.clientX - resizeState.startX;
      const dy = event.clientY - resizeState.startY;
      let nextWidth = resizeState.startWidth;
      let nextHeight = resizeState.startHeight;
      if (resizeState.axis === 'both' || resizeState.axis === 'x') {
        nextWidth = resizeState.startWidth + dx;
      }
      if (resizeState.axis === 'both' || resizeState.axis === 'y') {
        nextHeight = resizeState.startHeight + dy;
      }
      if (resizeState.keepRatio && resizeState.ratio > 0) {
        if (resizeState.axis === 'x') {
          nextHeight = nextWidth / resizeState.ratio;
        } else if (resizeState.axis === 'y') {
          nextWidth = nextHeight * resizeState.ratio;
        } else {
          if (Math.abs(dx) >= Math.abs(dy)) {
            nextHeight = nextWidth / resizeState.ratio;
          } else {
            nextWidth = nextHeight * resizeState.ratio;
          }
        }
      }
      setImageSize(image, nextWidth, nextHeight);
      requestAnimationFrame(() => update());
    };

    const stopResize = () => {
      if (!resizeState) return;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      if (resizeState.handle && resizeState.pointerId != null) {
        try {
          resizeState.handle.releasePointerCapture(resizeState.pointerId);
        } catch (err) {
          // ignore
        }
      }
      overlay.classList.remove('is-resizing');
      resizeState = null;
      triggerEditorChange();
      requestAnimationFrame(() => update());
    };

    handleDefs.forEach(def => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = `rich-editor-image-handle rich-editor-image-handle--${def.name}`;
      handle.setAttribute('aria-label', def.label);
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = image.getBoundingClientRect();
        resizeState = {
          axis: def.axis,
          startX: event.clientX,
          startY: event.clientY,
          startWidth: rect.width,
          startHeight: rect.height,
          ratio: rect.height > 0 ? rect.width / rect.height : 1,
          keepRatio: event.shiftKey,
          pointerId: event.pointerId,
          handle
        };
        overlay.classList.add('is-resizing');
        try {
          handle.setPointerCapture(event.pointerId);
        } catch (err) {
          // ignore unsupported pointer capture
        }
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('pointercancel', stopResize);
      });
      overlay.appendChild(handle);
    });

    wrapper.appendChild(overlay);
    occlusionDisplayManager?.suppress(image, true);
    image.classList.add('rich-editor-image-active');

    const update = () => {
      if (!document.body.contains(image)) {
        destroy();
        return;
      }
      const rect = image.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.style.left = `${rect.left - wrapperRect.left}px`;
      overlay.style.top = `${rect.top - wrapperRect.top}px`;
      occlusionEditor.update();
    };

    const onScroll = () => update();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (occlusionEditor.isActive()) {
          event.preventDefault();
          occlusionToggle.focus();
          return;
        }
        event.preventDefault();
        destroy();
      }
    };

    const handleOutside = (event) => {
      const target = event.target;
      if (target === image) return;
      if (target instanceof Node && overlay.contains(target)) return;
      if (target instanceof Element && target.closest('.image-occlusion-modal')) return;
      destroy();
    };

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => update())
      : null;
    if (resizeObserver) {
      try {
        resizeObserver.observe(image);
      } catch (err) {
        // ignore
      }
    }

    function createImageOcclusionEditor(onGeometryChange){
      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'image-annotation-layer image-highlight-layer';
      highlightLayer.setAttribute('aria-hidden', 'true');
      overlay.appendChild(highlightLayer);

      const textLayer = document.createElement('div');
      textLayer.className = 'image-annotation-layer image-text-layer';
      textLayer.setAttribute('aria-hidden', 'true');
      overlay.appendChild(textLayer);

      const layer = document.createElement('div');
      layer.className = 'rich-editor-image-occlusion-layer';
      layer.setAttribute('aria-hidden', 'true');
      overlay.appendChild(layer);

      const boxElements = new Map();
      const highlightElements = new Map();
      const textboxElements = new Map();
      const revealStates = new Map();
      let active = false;
      let drawing = null;
      let highlightDrawing = null;
      let textboxDrawing = null;
      let textboxManipulation = null;
      let workspace = null;
      let activeWorkspaceTool = 'occlusion';
      let highlightColorIndex = 0;

      const MIN_PIXEL_SIZE = 8;

      const getCurrentHighlightColor = () => {
        const index = highlightColorIndex % WORKSPACE_HIGHLIGHT_COLORS.length;
        return WORKSPACE_HIGHLIGHT_COLORS[index];
      };

      const cycleHighlightColor = () => {
        highlightColorIndex = (highlightColorIndex + 1) % WORKSPACE_HIGHLIGHT_COLORS.length;
        if (workspace && typeof workspace.updateHighlightSwatch === 'function') {
          workspace.updateHighlightSwatch();
        }
      };

      const setWorkspaceTool = (tool) => {
        activeWorkspaceTool = tool;
        if (workspace && typeof workspace.setTool === 'function') {
          workspace.setTool(tool);
        }
      };

      function createWorkspace(){
        const workspaceOverlay = document.createElement('div');
        workspaceOverlay.className = 'image-occlusion-modal';
        workspaceOverlay.setAttribute('aria-hidden', 'true');
        workspaceOverlay.setAttribute('role', 'dialog');
        workspaceOverlay.setAttribute('aria-modal', 'true');
        workspaceOverlay.setAttribute('aria-label', 'Image occlusion editor');
        workspaceOverlay.tabIndex = -1;

        const backdrop = document.createElement('div');
        backdrop.className = 'image-occlusion-modal-backdrop';
        workspaceOverlay.appendChild(backdrop);

        const surface = document.createElement('div');
        surface.className = 'image-occlusion-modal-surface';
        workspaceOverlay.appendChild(surface);

        const toolbar = document.createElement('div');
        toolbar.className = 'image-occlusion-modal-toolbar';
        surface.appendChild(toolbar);

        const toolButtons = document.createElement('div');
        toolButtons.className = 'image-occlusion-toolbar-buttons';
        toolbar.appendChild(toolButtons);

        const canvas = document.createElement('div');
        canvas.className = 'image-occlusion-modal-canvas';
        surface.appendChild(canvas);

        const editingImage = image.cloneNode(true);
        editingImage.removeAttribute('width');
        editingImage.removeAttribute('height');
        editingImage.classList.add('image-occlusion-modal-img');
        canvas.appendChild(editingImage);

        const workspaceHighlightLayer = document.createElement('div');
        workspaceHighlightLayer.className = 'image-annotation-layer image-highlight-layer';
        workspaceHighlightLayer.setAttribute('aria-hidden', 'true');
        canvas.appendChild(workspaceHighlightLayer);

        const workspaceTextLayer = document.createElement('div');
        workspaceTextLayer.className = 'image-annotation-layer image-text-layer';
        workspaceTextLayer.setAttribute('aria-hidden', 'true');
        canvas.appendChild(workspaceTextLayer);

        const workspaceLayer = document.createElement('div');
        workspaceLayer.className = 'image-occlusion-layer';
        workspaceLayer.setAttribute('aria-hidden', 'true');
        canvas.appendChild(workspaceLayer);

        const occlusionToolBtn = document.createElement('button');
        occlusionToolBtn.type = 'button';
        occlusionToolBtn.className = 'image-workspace-tool';
        occlusionToolBtn.title = 'Draw a new occlusion';
        occlusionToolBtn.setAttribute('aria-label', 'Draw occlusion');
        occlusionToolBtn.setAttribute('aria-pressed', 'false');
        const occlusionIcon = document.createElement('span');
        occlusionIcon.className = 'image-workspace-tool-icon';
        occlusionIcon.textContent = '👁';
        occlusionToolBtn.appendChild(occlusionIcon);
        const occlusionLabel = document.createElement('span');
        occlusionLabel.className = 'image-workspace-tool-label';
        occlusionLabel.textContent = 'Occlusion';
        occlusionToolBtn.appendChild(occlusionLabel);
        toolButtons.appendChild(occlusionToolBtn);

        const highlightToolBtn = document.createElement('button');
        highlightToolBtn.type = 'button';
        highlightToolBtn.className = 'image-workspace-tool image-workspace-tool--highlight';
        highlightToolBtn.title = 'Highlight an area (double-click to cycle colors)';
        highlightToolBtn.setAttribute('aria-label', 'Highlight area');
        highlightToolBtn.setAttribute('aria-pressed', 'false');
        const highlightIcon = document.createElement('span');
        highlightIcon.className = 'image-workspace-tool-icon';
        highlightIcon.textContent = '🖍';
        highlightToolBtn.appendChild(highlightIcon);
        const highlightLabel = document.createElement('span');
        highlightLabel.className = 'image-workspace-tool-label';
        highlightLabel.textContent = 'Highlight';
        highlightToolBtn.appendChild(highlightLabel);
        const highlightSwatch = document.createElement('span');
        highlightSwatch.className = 'image-workspace-tool-swatch';
        highlightToolBtn.appendChild(highlightSwatch);
        toolButtons.appendChild(highlightToolBtn);

        const textToolBtn = document.createElement('button');
        textToolBtn.type = 'button';
        textToolBtn.className = 'image-workspace-tool image-workspace-tool--text';
        textToolBtn.title = 'Add a text note';
        textToolBtn.setAttribute('aria-label', 'Text note tool');
        textToolBtn.setAttribute('aria-pressed', 'false');
        const textIcon = document.createElement('span');
        textIcon.className = 'image-workspace-tool-icon';
        textIcon.textContent = '📝';
        textToolBtn.appendChild(textIcon);
        const textLabel = document.createElement('span');
        textLabel.className = 'image-workspace-tool-label';
        textLabel.textContent = 'Text';
        textToolBtn.appendChild(textLabel);
        toolButtons.appendChild(textToolBtn);

        const hint = document.createElement('p');
        hint.className = 'image-occlusion-modal-hint';
        hint.textContent = 'Use the tools to draw occlusions, highlights, or notes. Double-click the highlighter to cycle colors.';
        toolbar.appendChild(hint);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'image-occlusion-modal-close';
        closeBtn.setAttribute('aria-label', 'Close image editor');
        closeBtn.innerHTML = '✕';
        canvas.appendChild(closeBtn);

        const workspaceBoxes = new Map();
        const workspaceHighlights = new Map();
        const workspaceTextboxes = new Map();
        let previousFocus = null;

        function refreshHighlightSwatch(){
          const color = getCurrentHighlightColor();
          if (highlightSwatch) {
            highlightSwatch.style.setProperty('--swatch-color', color);
          }
        }

        function applyToolState(tool){
          const mapping = new Map([
            ['occlusion', occlusionToolBtn],
            ['highlight', highlightToolBtn],
            ['text', textToolBtn]
          ]);
          mapping.forEach((btn, key) => {
            if (!btn) return;
            const isActive = key === tool;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
          });
          workspaceOverlay.dataset.tool = tool;
          const isOcclusion = tool === 'occlusion';
          const isHighlight = tool === 'highlight';
          const isText = tool === 'text';
          workspaceLayer.classList.toggle('is-active', isOcclusion);
          workspaceLayer.setAttribute('aria-hidden', isOcclusion ? 'false' : 'true');
          workspaceHighlightLayer.classList.toggle('is-interactive', isHighlight);
          workspaceHighlightLayer.setAttribute('aria-hidden', isHighlight ? 'false' : 'true');
          workspaceHighlightLayer.dataset.active = isHighlight ? 'true' : 'false';
          workspaceTextLayer.classList.toggle('is-interactive', isText);
          workspaceTextLayer.setAttribute('aria-hidden', isText ? 'false' : 'true');
          workspaceTextLayer.dataset.active = isText ? 'true' : 'false';
        }

        function focusOverlay(){
          try {
            workspaceOverlay.focus({ preventScroll: true });
          } catch (err) {
            workspaceOverlay.focus();
          }
        }

        function syncCanvasDimensions(){
          const rect = editingImage.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
          }
        }

        occlusionToolBtn.addEventListener('click', () => setWorkspaceTool('occlusion'));
        highlightToolBtn.addEventListener('click', () => setWorkspaceTool('highlight'));
        highlightToolBtn.addEventListener('dblclick', (event) => {
          event.preventDefault();
          cycleHighlightColor();
          setWorkspaceTool('highlight');
        });
        textToolBtn.addEventListener('click', () => setWorkspaceTool('text'));

        refreshHighlightSwatch();

        const handleResize = () => {
          syncCanvasDimensions();
          refreshBoxes();
        };

        const handleClose = (event) => {
          event.preventDefault();
          deactivate();
        };

        closeBtn.addEventListener('click', handleClose);

        workspaceLayer.addEventListener('pointerdown', handlePointerDown);
        workspaceHighlightLayer.addEventListener('pointerdown', handleHighlightPointerDown);
        workspaceTextLayer.addEventListener('pointerdown', handleTextboxPointerDown);

        editingImage.addEventListener('load', () => {
          requestAnimationFrame(() => {
            syncCanvasDimensions();
            refreshBoxes();
          });
        });

        return {
          overlay: workspaceOverlay,
          layer: workspaceLayer,
          highlightLayer: workspaceHighlightLayer,
          textLayer: workspaceTextLayer,
          image: editingImage,
          boxElements: workspaceBoxes,
          highlightElements: workspaceHighlights,
          textboxElements: workspaceTextboxes,
          attach(){
            if (!document.body.contains(workspaceOverlay)) {
              previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              document.body.appendChild(workspaceOverlay);
            }
            workspaceOverlay.setAttribute('aria-hidden', 'false');
            workspaceOverlay.scrollTop = 0;
            document.body.classList.add('is-occlusion-workspace-open');
            syncCanvasDimensions();
            refreshBoxes();
            requestAnimationFrame(() => {
              workspaceOverlay.classList.add('is-visible');
              focusOverlay();
            });
            window.addEventListener('resize', handleResize);
          },
          detach(){
            workspaceOverlay.classList.remove('is-visible');
            workspaceOverlay.setAttribute('aria-hidden', 'true');
            if (workspaceOverlay.parentNode) {
              workspaceOverlay.parentNode.removeChild(workspaceOverlay);
            }
            document.body.classList.remove('is-occlusion-workspace-open');
            window.removeEventListener('resize', handleResize);
            if (previousFocus && typeof previousFocus.focus === 'function') {
              try {
                previousFocus.focus({ preventScroll: true });
              } catch (err) {
                previousFocus.focus();
              }
            }
            previousFocus = null;
          },
          destroy(){
            workspaceLayer.removeEventListener('pointerdown', handlePointerDown);
            workspaceHighlightLayer.removeEventListener('pointerdown', handleHighlightPointerDown);
            workspaceTextLayer.removeEventListener('pointerdown', handleTextboxPointerDown);
            closeBtn.removeEventListener('click', handleClose);
            workspaceBoxes.clear();
            workspaceHighlights.clear();
            workspaceTextboxes.clear();
            this.detach();
          },
          focus(){
            focusOverlay();
          },
          setTool(tool){
            applyToolState(tool);
          },
          updateHighlightSwatch(){
            refreshHighlightSwatch();
          }
        };
      }

      function getWorkspace(){
        if (!workspace) workspace = createWorkspace();
        return workspace;
      }

      function syncOcclusionLayer(targetLayer, targetBoxes, targetImage, metrics = null){
        if (!targetLayer) return;
        const occlusions = parseImageOcclusions(image);
        const seen = new Set();
        occlusions.forEach(box => {
          let element = targetBoxes.get(box.id);
          if (!element) {
            element = document.createElement('div');
            element.className = 'rich-editor-image-occlusion-box image-occlusion-box';
            element.dataset.id = box.id;
            element.tabIndex = 0;
            element.setAttribute('role', 'button');
            element.setAttribute('aria-pressed', 'false');
            element.setAttribute('aria-label', 'Toggle occlusion');
            element.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleReveal(element);
            });
            element.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleReveal(element);
              }
            });
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'rich-editor-image-occlusion-remove';
            removeBtn.setAttribute('aria-label', 'Remove occlusion');
            removeBtn.innerHTML = '✕';
            removeBtn.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              removeOcclusion(element.dataset.id || '');
            });
            element.appendChild(removeBtn);
            targetLayer.appendChild(element);
            targetBoxes.set(box.id, element);
          }
          const geometry = metrics || resolveImageMetrics(targetImage || image);
          applyOcclusionBoxGeometry(element, box, geometry || targetImage || image);
          const revealed = revealStates.get(box.id) === true;
          setOcclusionRevealState(element, revealed);
          seen.add(box.id);
        });
        targetBoxes.forEach((element, id) => {
          if (!seen.has(id)) {
            element.remove();
            targetBoxes.delete(id);
            revealStates.delete(id);
          }
        });
        targetLayer.classList.toggle('has-boxes', targetBoxes.size > 0);
      }

      function syncHighlightLayer(targetLayer, targetHighlights, targetImage, { interactive = false, metrics = null } = {}){
        if (!targetLayer) return;
        const highlights = parseImageHighlights(image);
        const seen = new Set();
        highlights.forEach(box => {
          let element = targetHighlights.get(box.id);
          if (!element) {
            element = document.createElement('div');
            element.className = 'image-highlight-box';
            element.dataset.id = box.id;
            if (interactive) {
              element.tabIndex = 0;
              element.setAttribute('role', 'button');
              element.setAttribute('aria-label', 'Edit highlight');
              const removeBtn = document.createElement('button');
              removeBtn.type = 'button';
              removeBtn.className = 'image-annotation-remove';
              removeBtn.setAttribute('aria-label', 'Remove highlight');
              removeBtn.textContent = '✕';
              removeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                removeHighlight(element.dataset.id || box.id);
              });
              element.appendChild(removeBtn);
              element.addEventListener('dblclick', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const id = element.dataset.id || box.id;
                const color = getCurrentHighlightColor();
                updateHighlightColor(id, color);
              });
            }
            targetLayer.appendChild(element);
            targetHighlights.set(box.id, element);
          }
          element.dataset.id = box.id;
          element.style.borderColor = box.color;
          element.style.backgroundColor = highlightColorToRgba(box.color, interactive ? 0.5 : 0.35);
          const geometry = metrics || resolveImageMetrics(targetImage || image);
          applyOcclusionBoxGeometry(element, box, geometry || targetImage || image);
          seen.add(box.id);
        });
        targetHighlights.forEach((element, id) => {
          if (!seen.has(id)) {
            element.remove();
            targetHighlights.delete(id);
          }
        });
        targetLayer.classList.toggle('has-annotations', targetHighlights.size > 0);
      }

      function syncTextboxLayer(targetLayer, targetTextboxes, targetImage, { interactive = false, metrics = null } = {}){
        if (!targetLayer) return;
        const textboxes = parseImageTextboxes(image);
        const seen = new Set();
        textboxes.forEach(box => {
          let element = targetTextboxes.get(box.id);
          if (!element) {
            element = document.createElement('div');
            element.className = 'image-textbox';
            element.dataset.id = box.id;
            const content = document.createElement('div');
            content.className = 'image-textbox-content';
            if (interactive) {
              content.contentEditable = 'true';
              content.setAttribute('role', 'textbox');
              content.setAttribute('aria-label', 'Edit text');
              content.addEventListener('input', () => {
                const id = element.dataset.id || box.id;
                updateTextboxText(id, content.textContent || '');
              });
              content.addEventListener('blur', () => {
                const id = element.dataset.id || box.id;
                updateTextboxText(id, content.textContent || '');
              });
              content.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  content.blur();
                }
              });
            } else {
              content.setAttribute('aria-hidden', 'true');
            }
            element.appendChild(content);
            if (interactive) {
              let dragHandle = element.querySelector('.image-textbox-handle--move');
              if (!dragHandle) {
                dragHandle = document.createElement('div');
                dragHandle.className = 'image-textbox-handle image-textbox-handle--move';
                dragHandle.setAttribute('aria-hidden', 'true');
                element.appendChild(dragHandle);
              }
              let resizeHandle = element.querySelector('.image-textbox-handle--resize');
              if (!resizeHandle) {
                resizeHandle = document.createElement('div');
                resizeHandle.className = 'image-textbox-handle image-textbox-handle--resize';
                resizeHandle.setAttribute('aria-hidden', 'true');
                element.appendChild(resizeHandle);
              }
            }
            if (interactive) {
              const removeBtn = document.createElement('button');
              removeBtn.type = 'button';
              removeBtn.className = 'image-annotation-remove';
              removeBtn.setAttribute('aria-label', 'Remove text');
              removeBtn.textContent = '✕';
              removeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                removeTextbox(element.dataset.id || box.id);
              });
              element.appendChild(removeBtn);
            }
            targetLayer.appendChild(element);
            targetTextboxes.set(box.id, element);
          }
          if (interactive) ensureTextboxHandleBindings(element);
          element.dataset.id = box.id;
          const contentEl = element.querySelector('.image-textbox-content');
          if (contentEl && (contentEl.textContent || '') !== (box.text || '')) {
            contentEl.textContent = box.text || '';
          }
          const geometry = metrics || resolveImageMetrics(targetImage || image);
          applyOcclusionBoxGeometry(element, box, geometry || targetImage || image);
          seen.add(box.id);
        });
        targetTextboxes.forEach((element, id) => {
          if (!seen.has(id)) {
            element.remove();
            targetTextboxes.delete(id);
          }
        });
        targetLayer.classList.toggle('has-annotations', targetTextboxes.size > 0);
      }

      function ensureTextboxHandleBindings(element){
        if (!(element instanceof HTMLElement)) return;
        if (element.__textboxHandleListeners) return;
        const dragHandle = element.querySelector('.image-textbox-handle--move');
        const resizeHandle = element.querySelector('.image-textbox-handle--resize');
        if (!dragHandle || !resizeHandle) return;
        const moveListener = (event) => startTextboxManipulation(event, element, 'move');
        const resizeListener = (event) => startTextboxManipulation(event, element, 'resize');
        dragHandle.addEventListener('pointerdown', moveListener);
        resizeHandle.addEventListener('pointerdown', resizeListener);
        element.__textboxHandleListeners = { moveListener, resizeListener };
      }

      function refreshBoxes(){
        const occlusions = parseImageOcclusions(image);
        const highlights = parseImageHighlights(image);
        const textboxes = parseImageTextboxes(image);
        overlay.classList.toggle('has-occlusions', occlusions.length > 0);
        occlusionToggle.classList.toggle('has-occlusions', occlusions.length > 0);
        const inlineMetrics = resolveImageMetrics(image);
        syncOcclusionLayer(layer, boxElements, image, inlineMetrics);
        syncHighlightLayer(highlightLayer, highlightElements, image, { interactive: false, metrics: inlineMetrics });
        syncTextboxLayer(textLayer, textboxElements, image, { interactive: false, metrics: inlineMetrics });
        if (workspace) {
          const workspaceImage = workspace.image instanceof HTMLImageElement ? workspace.image : null;
          const workspaceMetrics = workspaceImage ? resolveImageMetrics(workspaceImage) : inlineMetrics;
          if (workspace.image) {
            if (occlusions.length) {
              workspace.image.setAttribute(IMAGE_OCCLUSION_ATTR, JSON.stringify(occlusions));
            } else {
              workspace.image.removeAttribute(IMAGE_OCCLUSION_ATTR);
            }
            if (highlights.length) {
              workspace.image.setAttribute(IMAGE_HIGHLIGHT_ATTR, JSON.stringify(highlights));
            } else {
              workspace.image.removeAttribute(IMAGE_HIGHLIGHT_ATTR);
            }
            if (textboxes.length) {
              workspace.image.setAttribute(IMAGE_TEXTBOX_ATTR, JSON.stringify(textboxes));
            } else {
              workspace.image.removeAttribute(IMAGE_TEXTBOX_ATTR);
            }
          }
          syncOcclusionLayer(workspace.layer, workspace.boxElements, workspaceImage || image, workspaceMetrics);
          syncHighlightLayer(workspace.highlightLayer, workspace.highlightElements, workspaceImage || image, { interactive: true, metrics: workspaceMetrics });
          syncTextboxLayer(workspace.textLayer, workspace.textboxElements, workspaceImage || image, { interactive: true, metrics: workspaceMetrics });
        }
      }

      function toggleReveal(element){
        const id = element?.dataset?.id;
        if (!id) return;
        const next = !(revealStates.get(id) === true);
        revealStates.set(id, next);
        setOcclusionRevealState(element, next);
      }

      function removeOcclusion(id){
        if (!id) return;
        const next = parseImageOcclusions(image).filter(box => box.id !== id);
        const normalized = writeImageOcclusions(image, next);
        if (workspace?.image) {
          if (normalized.length) workspace.image.setAttribute(IMAGE_OCCLUSION_ATTR, JSON.stringify(normalized));
          else workspace.image.removeAttribute(IMAGE_OCCLUSION_ATTR);
        }
        notifyImageOcclusionChange(image);
        revealStates.delete(id);
        refreshBoxes();
        triggerEditorChange();
        if (typeof onGeometryChange === 'function') onGeometryChange();
      }

      function removeHighlight(id){
        if (!id) return;
        const next = parseImageHighlights(image).filter(box => box.id !== id);
        const normalized = writeImageHighlights(image, next);
        if (workspace?.image) {
          if (normalized.length) workspace.image.setAttribute(IMAGE_HIGHLIGHT_ATTR, JSON.stringify(normalized));
          else workspace.image.removeAttribute(IMAGE_HIGHLIGHT_ATTR);
        }
        notifyImageOcclusionChange(image);
        refreshBoxes();
        triggerEditorChange();
        if (typeof onGeometryChange === 'function') onGeometryChange();
      }

      function updateHighlightColor(id, color){
        if (!id) return;
        const highlights = parseImageHighlights(image);
        const next = highlights.map(box => {
          if (box.id !== id) return box;
          return normalizeHighlightBox({ ...box, color });
        }).filter(Boolean);
        const normalized = writeImageHighlights(image, next);
        if (workspace?.image) {
          if (normalized.length) workspace.image.setAttribute(IMAGE_HIGHLIGHT_ATTR, JSON.stringify(normalized));
          else workspace.image.removeAttribute(IMAGE_HIGHLIGHT_ATTR);
        }
        notifyImageOcclusionChange(image);
        refreshBoxes();
        triggerEditorChange();
        if (typeof onGeometryChange === 'function') onGeometryChange();
      }

      function removeTextbox(id){
        if (!id) return;
        const next = parseImageTextboxes(image).filter(box => box.id !== id);
        const normalized = writeImageTextboxes(image, next);
        if (workspace?.image) {
          if (normalized.length) workspace.image.setAttribute(IMAGE_TEXTBOX_ATTR, JSON.stringify(normalized));
          else workspace.image.removeAttribute(IMAGE_TEXTBOX_ATTR);
        }
        notifyImageOcclusionChange(image);
        refreshBoxes();
        triggerEditorChange();
        if (typeof onGeometryChange === 'function') onGeometryChange();
      }

      function updateTextboxText(id, text){
        if (!id) return;
        const safeText = sanitizeTextboxContent(text);
        const textboxes = parseImageTextboxes(image);
        const next = textboxes.map(box => {
          if (box.id !== id) return box;
          return normalizeTextbox({ ...box, text: safeText });
        }).filter(Boolean);
        const normalized = writeImageTextboxes(image, next);
        if (workspace?.image) {
          if (normalized.length) workspace.image.setAttribute(IMAGE_TEXTBOX_ATTR, JSON.stringify(normalized));
          else workspace.image.removeAttribute(IMAGE_TEXTBOX_ATTR);
        }
        notifyImageOcclusionChange(image);
        refreshBoxes();
        triggerEditorChange();
        if (typeof onGeometryChange === 'function') onGeometryChange();
      }

      function handlePointerDown(event){
        if (!active) return;
        if (activeWorkspaceTool !== 'occlusion') return;
        if (event.button !== 0) return;
        const surface = event.currentTarget;
        if (!(surface instanceof HTMLElement)) return;
        if (event.target !== surface) return;
        event.preventDefault();
        const targetImage = workspace?.image instanceof HTMLImageElement ? workspace.image : image;
        const rect = getImageContentRect(targetImage) || surface.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        const startX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const startY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const element = document.createElement('div');
        element.className = 'rich-editor-image-occlusion-box image-occlusion-box is-drawing';
        surface.appendChild(element);
        drawing = {
          surface,
          rect,
          image: targetImage,
          metrics: resolveImageMetrics(targetImage),
          element,
          startX,
          startY,
          box: {
            id: ensureOcclusionId({}),
            x: startX,
            y: startY,
            width: 0,
            height: 0
          }
        };
        updateDrawing(event);
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerCancel);
      }

      function updateDrawing(event){
        if (!drawing) return;
        const { rect, startX, startY, box, element, image: targetImage, metrics } = drawing;
        const currentX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const currentY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const minX = Math.min(startX, currentX);
        const minY = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        box.x = minX;
        box.y = minY;
        box.width = width;
        box.height = height;
        applyOcclusionBoxGeometry(element, box, metrics || targetImage);
      }

      function finishDrawing(cancelled){
        if (!drawing) return;
        const { element, box, rect, image: targetImage } = drawing;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerCancel);
        element.remove();
        if (!cancelled) {
          const normalized = normalizeOcclusionBox(box);
          if (normalized) {
            const widthPx = normalized.width * rect.width;
            const heightPx = normalized.height * rect.height;
            if (widthPx >= MIN_PIXEL_SIZE && heightPx >= MIN_PIXEL_SIZE) {
              const next = parseImageOcclusions(image).concat([normalized]);
              const applied = writeImageOcclusions(image, next);
              if (workspace?.image) {
                if (applied.length) workspace.image.setAttribute(IMAGE_OCCLUSION_ATTR, JSON.stringify(applied));
                else workspace.image.removeAttribute(IMAGE_OCCLUSION_ATTR);
              }
              notifyImageOcclusionChange(image);
              refreshBoxes();
              triggerEditorChange();
              if (typeof onGeometryChange === 'function') onGeometryChange();
            }
          }
        }
        drawing = null;
      }

      function handlePointerMove(event){
        if (!drawing) return;
        event.preventDefault();
        updateDrawing(event);
      }

      function handlePointerUp(event){
        if (!drawing) return;
        event.preventDefault();
        updateDrawing(event);
        finishDrawing(false);
      }

      function handlePointerCancel(){
        finishDrawing(true);
      }

      layer.addEventListener('pointerdown', handlePointerDown);

      function handleHighlightPointerDown(event){
        if (!active || activeWorkspaceTool !== 'highlight') return;
        if (event.button !== 0) return;
        const surface = event.currentTarget;
        if (!(surface instanceof HTMLElement)) return;
        if (event.target !== surface) return;
        event.preventDefault();
        const targetImage = workspace?.image instanceof HTMLImageElement ? workspace.image : image;
        const rect = getImageContentRect(targetImage) || surface.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        const startX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const startY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const color = getCurrentHighlightColor();
        const element = document.createElement('div');
        element.className = 'image-highlight-box is-drawing';
        element.style.borderColor = color;
        element.style.backgroundColor = highlightColorToRgba(color, 0.45);
        surface.appendChild(element);
        highlightDrawing = {
          surface,
          rect,
          image: targetImage,
          metrics: resolveImageMetrics(targetImage),
          element,
          color,
          startX,
          startY,
          box: {
            id: ensureAnnotationId('hlt', {}),
            x: startX,
            y: startY,
            width: 0,
            height: 0,
            color
          }
        };
        updateHighlightDrawing(event);
        window.addEventListener('pointermove', handleHighlightPointerMove);
        window.addEventListener('pointerup', handleHighlightPointerUp);
        window.addEventListener('pointercancel', handleHighlightPointerCancel);
      }

      function updateHighlightDrawing(event){
        if (!highlightDrawing) return;
        const { rect, startX, startY, box, element, image: targetImage, metrics } = highlightDrawing;
        const currentX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const currentY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const minX = Math.min(startX, currentX);
        const minY = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        box.x = minX;
        box.y = minY;
        box.width = width;
        box.height = height;
        applyOcclusionBoxGeometry(element, box, metrics || targetImage);
      }

      function finishHighlightDrawing(cancelled){
        if (!highlightDrawing) return;
        const { element, box, rect } = highlightDrawing;
        window.removeEventListener('pointermove', handleHighlightPointerMove);
        window.removeEventListener('pointerup', handleHighlightPointerUp);
        window.removeEventListener('pointercancel', handleHighlightPointerCancel);
        element.remove();
        if (!cancelled) {
          const normalized = normalizeHighlightBox(box);
          if (normalized) {
            const widthPx = normalized.width * rect.width;
            const heightPx = normalized.height * rect.height;
            if (widthPx >= MIN_PIXEL_SIZE && heightPx >= MIN_PIXEL_SIZE) {
              const next = parseImageHighlights(image).concat([normalized]);
              const applied = writeImageHighlights(image, next);
              if (workspace?.image) {
                if (applied.length) workspace.image.setAttribute(IMAGE_HIGHLIGHT_ATTR, JSON.stringify(applied));
                else workspace.image.removeAttribute(IMAGE_HIGHLIGHT_ATTR);
              }
              notifyImageOcclusionChange(image);
              refreshBoxes();
              triggerEditorChange();
              if (typeof onGeometryChange === 'function') onGeometryChange();
            }
          }
        }
        highlightDrawing = null;
      }

      function handleHighlightPointerMove(event){
        if (!highlightDrawing) return;
        event.preventDefault();
        updateHighlightDrawing(event);
      }

      function handleHighlightPointerUp(event){
        if (!highlightDrawing) return;
        event.preventDefault();
        updateHighlightDrawing(event);
        finishHighlightDrawing(false);
      }

      function handleHighlightPointerCancel(){
        finishHighlightDrawing(true);
      }

      function handleTextboxPointerDown(event){
        if (!active || activeWorkspaceTool !== 'text') return;
        if (event.button !== 0) return;
        const surface = event.currentTarget;
        if (!(surface instanceof HTMLElement)) return;
        if (event.target !== surface) return;
        event.preventDefault();
        const targetImage = workspace?.image instanceof HTMLImageElement ? workspace.image : image;
        const rect = getImageContentRect(targetImage) || surface.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        const startX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const startY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const element = document.createElement('div');
        element.className = 'image-textbox is-drawing';
        surface.appendChild(element);
        textboxDrawing = {
          surface,
          rect,
          image: targetImage,
          metrics: resolveImageMetrics(targetImage),
          element,
          startX,
          startY,
          box: {
            id: ensureAnnotationId('txt', {}),
            x: startX,
            y: startY,
            width: 0,
            height: 0,
            text: ''
          }
        };
        updateTextboxDrawing(event);
        window.addEventListener('pointermove', handleTextboxPointerMove);
        window.addEventListener('pointerup', handleTextboxPointerUp);
        window.addEventListener('pointercancel', handleTextboxPointerCancel);
      }

      function updateTextboxDrawing(event){
        if (!textboxDrawing) return;
        const { rect, startX, startY, box, element, image: targetImage, metrics } = textboxDrawing;
        const currentX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const currentY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const minX = Math.min(startX, currentX);
        const minY = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        box.x = minX;
        box.y = minY;
        box.width = width;
        box.height = height;
        applyOcclusionBoxGeometry(element, box, metrics || targetImage);
      }

      function finishTextboxDrawing(cancelled){
        if (!textboxDrawing) return;
        const { element, box, rect } = textboxDrawing;
        window.removeEventListener('pointermove', handleTextboxPointerMove);
        window.removeEventListener('pointerup', handleTextboxPointerUp);
        window.removeEventListener('pointercancel', handleTextboxPointerCancel);
        element.remove();
        let createdId = null;
        if (!cancelled) {
          const normalized = normalizeTextbox(box);
          if (normalized) {
            const widthPx = normalized.width * rect.width;
            const heightPx = normalized.height * rect.height;
            if (widthPx >= MIN_PIXEL_SIZE && heightPx >= MIN_PIXEL_SIZE) {
              const next = parseImageTextboxes(image).concat([normalized]);
              const applied = writeImageTextboxes(image, next);
              createdId = normalized.id;
              if (workspace?.image) {
                if (applied.length) workspace.image.setAttribute(IMAGE_TEXTBOX_ATTR, JSON.stringify(applied));
                else workspace.image.removeAttribute(IMAGE_TEXTBOX_ATTR);
              }
              notifyImageOcclusionChange(image);
              refreshBoxes();
              triggerEditorChange();
              if (typeof onGeometryChange === 'function') onGeometryChange();
            }
          }
        }
        const focusId = createdId;
        if (focusId) {
          requestAnimationFrame(() => focusWorkspaceTextbox(focusId));
        }
        textboxDrawing = null;
      }

      function handleTextboxPointerMove(event){
        if (!textboxDrawing) return;
        event.preventDefault();
        updateTextboxDrawing(event);
      }

      function handleTextboxPointerUp(event){
        if (!textboxDrawing) return;
        event.preventDefault();
        updateTextboxDrawing(event);
        finishTextboxDrawing(false);
      }

      function handleTextboxPointerCancel(){
        finishTextboxDrawing(true);
      }

      function startTextboxManipulation(event, element, mode){
        if (!(element instanceof HTMLElement)) return;
        if (mode !== 'move' && mode !== 'resize') return;
        const id = element.dataset.id;
        if (!id) return;
        if (textboxManipulation) finishTextboxManipulation(true);
        const targetImage = workspace?.image instanceof HTMLImageElement ? workspace.image : image;
        const rect = getImageContentRect(targetImage) || targetImage?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        const textboxes = parseImageTextboxes(image);
        const source = textboxes.find(box => box.id === id);
        if (!source) return;
        event.preventDefault();
        event.stopPropagation();
        const pointerTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : element;
        const metrics = resolveImageMetrics(targetImage);
        const minWidthNorm = rect.width > 0 ? Math.min(1, MIN_PIXEL_SIZE / rect.width) : 0;
        const minHeightNorm = rect.height > 0 ? Math.min(1, MIN_PIXEL_SIZE / rect.height) : 0;
        const state = {
          type: mode,
          id,
          pointerId: event.pointerId,
          pointerTarget,
          element,
          rect,
          metrics,
          targetImage,
          original: { ...source },
          current: { ...source },
          minWidthNorm,
          minHeightNorm
        };
        if (mode === 'move') {
          const leftPx = rect.left + clamp(source.x, 0, 1) * rect.width;
          const topPx = rect.top + clamp(source.y, 0, 1) * rect.height;
          state.offsetX = event.clientX - leftPx;
          state.offsetY = event.clientY - topPx;
        }
        textboxManipulation = state;
        if (pointerTarget?.setPointerCapture && Number.isFinite(event.pointerId)) {
          try { pointerTarget.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
        }
        window.addEventListener('pointermove', handleTextboxManipulationMove);
        window.addEventListener('pointerup', handleTextboxManipulationUp);
        window.addEventListener('pointercancel', handleTextboxManipulationCancel);
      }

      function updateTextboxManipulation(event){
        if (!textboxManipulation || event.pointerId !== textboxManipulation.pointerId) return;
        const state = textboxManipulation;
        if (!state.rect || state.rect.width <= 0 || state.rect.height <= 0) return;
        const next = { ...state.original };
        if (state.type === 'move') {
          const rawX = (event.clientX - state.rect.left - (state.offsetX || 0)) / state.rect.width;
          const rawY = (event.clientY - state.rect.top - (state.offsetY || 0)) / state.rect.height;
          const maxX = Math.max(0, 1 - state.original.width);
          const maxY = Math.max(0, 1 - state.original.height);
          next.x = clamp(rawX, 0, maxX);
          next.y = clamp(rawY, 0, maxY);
        } else {
          const cursorX = (event.clientX - state.rect.left) / state.rect.width;
          const cursorY = (event.clientY - state.rect.top) / state.rect.height;
          const width = clamp(cursorX - state.original.x, state.minWidthNorm, 1 - state.original.x);
          const height = clamp(cursorY - state.original.y, state.minHeightNorm, 1 - state.original.y);
          next.width = width;
          next.height = height;
        }
        textboxManipulation.current = next;
        applyOcclusionBoxGeometry(state.element, next, state.metrics || state.targetImage);
      }

      function finishTextboxManipulation(cancelled){
        if (!textboxManipulation) return;
        const state = textboxManipulation;
        textboxManipulation = null;
        window.removeEventListener('pointermove', handleTextboxManipulationMove);
        window.removeEventListener('pointerup', handleTextboxManipulationUp);
        window.removeEventListener('pointercancel', handleTextboxManipulationCancel);
        if (state.pointerTarget?.releasePointerCapture && Number.isFinite(state.pointerId)) {
          try { state.pointerTarget.releasePointerCapture(state.pointerId); } catch (err) { /* ignore */ }
        }
        if (cancelled || !state.current) {
          applyOcclusionBoxGeometry(state.element, state.original, state.metrics || state.targetImage);
          return;
        }
        const widthPx = state.current.width * state.rect.width;
        const heightPx = state.current.height * state.rect.height;
        if (widthPx < MIN_PIXEL_SIZE || heightPx < MIN_PIXEL_SIZE) {
          applyOcclusionBoxGeometry(state.element, state.original, state.metrics || state.targetImage);
          return;
        }
        const next = parseImageTextboxes(image)
          .map(box => {
            if (box.id !== state.id) return box;
            const normalizedBox = normalizeTextbox({ ...box, ...state.current });
            return normalizedBox || box;
          })
          .filter(Boolean);
        const normalized = writeImageTextboxes(image, next);
        if (workspace?.image) {
          if (normalized.length) workspace.image.setAttribute(IMAGE_TEXTBOX_ATTR, JSON.stringify(normalized));
          else workspace.image.removeAttribute(IMAGE_TEXTBOX_ATTR);
        }
        notifyImageOcclusionChange(image);
        refreshBoxes();
        triggerEditorChange();
        if (typeof onGeometryChange === 'function') onGeometryChange();
      }

      function handleTextboxManipulationMove(event){
        if (!textboxManipulation || event.pointerId !== textboxManipulation.pointerId) return;
        event.preventDefault();
        updateTextboxManipulation(event);
      }

      function handleTextboxManipulationUp(event){
        if (!textboxManipulation || event.pointerId !== textboxManipulation.pointerId) return;
        event.preventDefault();
        updateTextboxManipulation(event);
        finishTextboxManipulation(false);
      }

      function handleTextboxManipulationCancel(){
        finishTextboxManipulation(true);
      }

      function focusWorkspaceTextbox(id){
        if (!workspace) return;
        const element = workspace.textboxElements?.get(id);
        if (!element) return;
        const content = element.querySelector('.image-textbox-content');
        if (!(content instanceof HTMLElement)) return;
        content.focus();
        placeCaretAtEnd(content);
      }

      function placeCaretAtEnd(node){
        if (!node) return;
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      function activate(){
        const workspaceInstance = getWorkspace();
        if (active) {
          if (workspaceInstance && typeof workspaceInstance.focus === 'function') {
            workspaceInstance.focus();
          }
          if (workspaceInstance && typeof workspaceInstance.updateHighlightSwatch === 'function') {
            workspaceInstance.updateHighlightSwatch();
          }
          if (workspaceInstance && typeof workspaceInstance.setTool === 'function') {
            workspaceInstance.setTool(activeWorkspaceTool);
          }
          return;
        }
        active = true;
        revealStates.clear();
        overlay.classList.add('is-occluding');
        occlusionToggle.dataset.active = 'true';
        occlusionToggle.setAttribute('aria-pressed', 'true');
        if (workspaceInstance) {
          workspaceInstance.attach();
          if (typeof workspaceInstance.setTool === 'function') {
            workspaceInstance.setTool(activeWorkspaceTool);
          }
          if (typeof workspaceInstance.updateHighlightSwatch === 'function') {
            workspaceInstance.updateHighlightSwatch();
          }
        }
        refreshBoxes();
      }

      function deactivate(){
        if (!active) return;
        active = false;
        overlay.classList.remove('is-occluding');
        occlusionToggle.dataset.active = 'false';
        occlusionToggle.setAttribute('aria-pressed', 'false');
        layer.classList.remove('is-active');
        layer.setAttribute('aria-hidden', 'true');
        if (workspace) {
          workspace.layer.classList.remove('is-active');
          workspace.layer.setAttribute('aria-hidden', 'true');
          workspace.highlightLayer.classList.remove('is-interactive');
          workspace.highlightLayer.setAttribute('aria-hidden', 'true');
          workspace.highlightLayer.dataset.active = 'false';
          workspace.textLayer.classList.remove('is-interactive');
          workspace.textLayer.setAttribute('aria-hidden', 'true');
          workspace.textLayer.dataset.active = 'false';
          workspace.detach();
        }
        revealStates.clear();
        refreshBoxes();
        if (drawing) finishDrawing(true);
        if (highlightDrawing) finishHighlightDrawing(true);
        if (textboxDrawing) finishTextboxDrawing(true);
        if (textboxManipulation) finishTextboxManipulation(true);
      }

      function update(){
        refreshBoxes();
      }

      function destroy(){
        deactivate();
        layer.removeEventListener('pointerdown', handlePointerDown);
        if (drawing) finishDrawing(true);
        boxElements.clear();
        revealStates.clear();
        if (workspace) {
          workspace.destroy();
          workspace = null;
        }
        layer.remove();
      }

      refreshBoxes();

      return {
        activate,
        deactivate,
        isActive: () => active,
        update,
        destroy
      };
    }

    const destroy = () => {
      if (resizeObserver) resizeObserver.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      editable.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', update);
      document.removeEventListener('mousedown', handleOutside, true);
      document.removeEventListener('keydown', onKeyDown, true);
      stopResize();
      occlusionEditor.destroy();
      overlay.remove();
      image.classList.remove('rich-editor-image-active');
      occlusionDisplayManager?.suppress(image, false);
      occlusionDisplayManager?.notifyChange(image);
      if (pendingImageTarget === image) pendingImageTarget = null;
    };

    cropBtn.addEventListener('click', async () => {
      occlusionEditor.deactivate();
      try {
        const currentWidth = Number(image.getAttribute('width')) || Math.round(image.getBoundingClientRect().width);
        const currentHeight = Number(image.getAttribute('height')) || Math.round(image.getBoundingClientRect().height);
        const alt = image.getAttribute('alt') || '';
        const result = await editImageSource(image.src, { altText: alt, width: currentWidth, height: currentHeight });
        if (!result) return;
        image.src = result.dataUrl;
        if (result.altText) {
          image.setAttribute('alt', result.altText);
        } else {
          image.removeAttribute('alt');
        }
        setImageSize(image, result.width, result.height);
        triggerEditorChange();
        requestAnimationFrame(() => update());
        occlusionDisplayManager?.notifyChange(image);
      } catch (err) {
        console.error('Failed to edit image', err);
      }
    });

    replaceBtn.addEventListener('click', () => {
      occlusionEditor.deactivate();
      pendingImageTarget = image;
      imageFileInput.click();
    });

    doneBtn.addEventListener('click', () => {
      destroyActiveImageEditor();
    });

    document.addEventListener('scroll', onScroll, true);
    editable.addEventListener('scroll', onScroll);
    window.addEventListener('resize', update);
    document.addEventListener('mousedown', handleOutside, true);
    document.addEventListener('keydown', onKeyDown, true);

    requestAnimationFrame(() => update());

    return {
      image,
      update,
      destroy,
      openWorkspace(){
        occlusionEditor.activate();
      }
    };
  }

  function createEditorOcclusionDisplayManager(wrapper, editable, beginImageEditing){
    const overlays = new Map();
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(entries => {
        for (const entry of entries) {
          const image = entry.target;
          const overlay = overlays.get(image);
          if (overlay) overlay.update();
        }
      })
      : null;

    function createOverlay(image){
      const overlayEl = document.createElement('div');
      overlayEl.className = 'rich-editor-occlusion-display';
      overlayEl.setAttribute('aria-hidden', 'true');

      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'image-annotation-layer image-highlight-layer';
      overlayEl.appendChild(highlightLayer);

      const textLayer = document.createElement('div');
      textLayer.className = 'image-annotation-layer image-text-layer';
      overlayEl.appendChild(textLayer);

      const layer = document.createElement('div');
      layer.className = 'image-occlusion-layer';
      overlayEl.appendChild(layer);

      wrapper.appendChild(overlayEl);

      const boxElements = new Map();
      const highlightElements = new Map();
      const textboxElements = new Map();
      const revealStates = new Map();
      let suppressed = false;

      function updatePosition(){
        if (!wrapper.contains(image)) {
          removeOverlay(image);
          return;
        }
        const rect = image.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        overlayEl.style.width = `${rect.width}px`;
        overlayEl.style.height = `${rect.height}px`;
        overlayEl.style.left = `${rect.left - wrapperRect.left}px`;
        overlayEl.style.top = `${rect.top - wrapperRect.top}px`;
      }

      function toggleReveal(element){
        const id = element?.dataset?.id;
        if (!id) return;
        const next = !(revealStates.get(id) === true);
        revealStates.set(id, next);
        setOcclusionRevealState(element, next);
      }

      function updateOcclusions(){
        if (suppressed) return;
        const metrics = resolveImageMetrics(image);
        const occlusions = parseImageOcclusions(image);
        const seen = new Set();
        occlusions.forEach(box => {
          let element = boxElements.get(box.id);
          if (!element) {
            element = document.createElement('div');
            element.className = 'image-occlusion-box';
            element.dataset.id = box.id;
            element.tabIndex = 0;
            element.setAttribute('role', 'button');
            element.setAttribute('aria-pressed', 'false');
            element.setAttribute('aria-label', 'Toggle occlusion');
            element.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleReveal(element);
            });
            element.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleReveal(element);
              }
            });
            element.addEventListener('dblclick', (event) => {
              event.preventDefault();
              event.stopPropagation();
              beginImageEditing(image);
            });
            layer.appendChild(element);
            boxElements.set(box.id, element);
          }
          applyOcclusionBoxGeometry(element, box, metrics || image);
          const revealed = revealStates.get(box.id) === true;
          setOcclusionRevealState(element, revealed);
          seen.add(box.id);
        });
        boxElements.forEach((element, id) => {
          if (!seen.has(id)) {
            element.remove();
            boxElements.delete(id);
            revealStates.delete(id);
          }
        });
      }

      function updateHighlights(){
        if (suppressed) return;
        const metrics = resolveImageMetrics(image);
        const highlights = parseImageHighlights(image);
        const seen = new Set();
        highlights.forEach(box => {
          let element = highlightElements.get(box.id);
          if (!element) {
            element = document.createElement('div');
            element.className = 'image-highlight-box';
            element.dataset.id = box.id;
            highlightLayer.appendChild(element);
            highlightElements.set(box.id, element);
          }
          element.style.borderColor = box.color;
          element.style.backgroundColor = highlightColorToRgba(box.color, 0.35);
          applyOcclusionBoxGeometry(element, box, metrics || image);
          seen.add(box.id);
        });
        highlightElements.forEach((element, id) => {
          if (!seen.has(id)) {
            element.remove();
            highlightElements.delete(id);
          }
        });
        highlightLayer.classList.toggle('is-hidden', highlightElements.size === 0);
      }

      function updateTextboxes(){
        if (suppressed) return;
        const metrics = resolveImageMetrics(image);
        const textboxes = parseImageTextboxes(image);
        const seen = new Set();
        textboxes.forEach(box => {
          let element = textboxElements.get(box.id);
          if (!element) {
            element = document.createElement('div');
            element.className = 'image-textbox';
            element.dataset.id = box.id;
            const content = document.createElement('div');
            content.className = 'image-textbox-content';
            content.setAttribute('aria-hidden', 'true');
            element.appendChild(content);
            textLayer.appendChild(element);
            textboxElements.set(box.id, element);
          }
          const content = element.querySelector('.image-textbox-content');
          if (content && (content.textContent || '') !== (box.text || '')) {
            content.textContent = box.text || '';
          }
          applyOcclusionBoxGeometry(element, box, metrics || image);
          seen.add(box.id);
        });
        textboxElements.forEach((element, id) => {
          if (!seen.has(id)) {
            element.remove();
            textboxElements.delete(id);
          }
        });
        textLayer.classList.toggle('is-hidden', textboxElements.size === 0);
      }

      function updateVisibility(){
        const hasOcclusions = boxElements.size > 0;
        const hasHighlights = highlightElements.size > 0;
        const hasTextboxes = textboxElements.size > 0;
        overlayEl.classList.toggle('is-hidden', !hasOcclusions && !hasHighlights && !hasTextboxes);
      }

      function update(){
        updatePosition();
        updateOcclusions();
        updateHighlights();
        updateTextboxes();
        updateVisibility();
      }

      function refresh(){
        revealStates.clear();
        updateOcclusions();
        updateHighlights();
        updateTextboxes();
        updateVisibility();
      }

      function setSuppressed(value){
        suppressed = Boolean(value);
        overlayEl.classList.toggle('is-suppressed', suppressed);
        if (!suppressed) {
          refresh();
          updatePosition();
        }
      }

      function handleImageChange(){
        refresh();
        updatePosition();
      }

      overlayEl.addEventListener('dblclick', (event) => {
        event.preventDefault();
        beginImageEditing(image);
      });

      image.addEventListener('load', handleImageChange);
      image.addEventListener(IMAGE_OCCLUSION_EVENT, handleImageChange);

      update();

      return {
        update,
        refresh,
        setSuppressed,
        destroy(){
          boxElements.clear();
          highlightElements.clear();
          textboxElements.clear();
          revealStates.clear();
          overlayEl.remove();
          image.removeEventListener('load', handleImageChange);
          image.removeEventListener(IMAGE_OCCLUSION_EVENT, handleImageChange);
        }
      };
    }

    function ensureOverlay(image){
      if (!(image instanceof HTMLImageElement)) return null;
      const hasOcclusions = parseImageOcclusions(image).length > 0;
      const hasHighlights = parseImageHighlights(image).length > 0;
      const hasTextboxes = parseImageTextboxes(image).length > 0;
      if (!hasOcclusions && !hasHighlights && !hasTextboxes) {
        removeOverlay(image);
        return null;
      }
      let overlay = overlays.get(image);
      if (!overlay) {
        overlay = createOverlay(image);
        overlays.set(image, overlay);
        if (resizeObserver) {
          try {
            resizeObserver.observe(image);
          } catch (err) {
            // ignore observers that cannot attach
          }
        }
      } else {
        overlay.refresh();
        overlay.update();
      }
      return overlay;
    }

    function removeOverlay(image){
      const existing = overlays.get(image);
      if (!existing) return;
      existing.destroy();
      overlays.delete(image);
      if (resizeObserver) {
        try {
          resizeObserver.unobserve(image);
        } catch (err) {
          // ignore
        }
      }
    }

    function sync(){
      const images = Array.from(editable.querySelectorAll('img'));
      const valid = new Set();
      images.forEach(image => {
        const hasOcclusions = parseImageOcclusions(image).length > 0;
        const hasHighlights = parseImageHighlights(image).length > 0;
        const hasTextboxes = parseImageTextboxes(image).length > 0;
        if (hasOcclusions || hasHighlights || hasTextboxes) {
          valid.add(image);
          ensureOverlay(image);
        }
      });
      overlays.forEach((overlay, image) => {
        if (!valid.has(image)) removeOverlay(image);
      });
    }

    const mutationObserver = new MutationObserver(mutations => {
      let needsSync = false;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && (
          mutation.attributeName === IMAGE_OCCLUSION_ATTR ||
          mutation.attributeName === IMAGE_HIGHLIGHT_ATTR ||
          mutation.attributeName === IMAGE_TEXTBOX_ATTR
        )) {
          const target = mutation.target;
          if (target instanceof HTMLImageElement) {
            const hasOcclusions = parseImageOcclusions(target).length > 0;
            const hasHighlights = parseImageHighlights(target).length > 0;
            const hasTextboxes = parseImageTextboxes(target).length > 0;
            if (hasOcclusions || hasHighlights || hasTextboxes) {
              ensureOverlay(target);
            } else {
              removeOverlay(target);
            }
          }
        } else {
          needsSync = true;
        }
      }
      if (needsSync) sync();
    });

      mutationObserver.observe(editable, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [IMAGE_OCCLUSION_ATTR, IMAGE_HIGHLIGHT_ATTR, IMAGE_TEXTBOX_ATTR]
      });

    const onScroll = () => {
      overlays.forEach(overlay => overlay.update());
    };

    document.addEventListener('scroll', onScroll, true);
    editable.addEventListener('scroll', onScroll);
    window.addEventListener('resize', onScroll);

    sync();

    return {
      sync,
      notifyChange(image){
        const overlay = ensureOverlay(image);
        if (overlay) overlay.refresh();
      },
      suppress(image, suppressed){
        const overlay = overlays.get(image);
        if (overlay) overlay.setSuppressed(suppressed);
      },
      destroy(){
        try {
          mutationObserver.disconnect();
        } catch (err) {
          // ignore observer teardown issues
        }
        document.removeEventListener('scroll', onScroll, true);
        editable.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        overlays.forEach((overlay, image) => {
          try {
            overlay.destroy();
          } catch (err) {
            console.warn('Failed to destroy occlusion overlay', err);
          }
          if (resizeObserver) {
            try {
              resizeObserver.unobserve(image);
            } catch (err) {
              // ignore
            }
          }
        });
        overlays.clear();
        if (resizeObserver) {
          try {
            resizeObserver.disconnect();
          } catch (err) {
            // ignore
          }
        }
      }
    };
  }

  const commandButtons = [];
  let sizeSelect = null;
  let fontSelect = null;
  let fontNameLabel = null;
  let fontSizeLabel = null;
  let clozeButton = null;

  function focusEditor(){
    editable.focus({ preventScroll: false });
  }

  let savedRange = null;
  let suppressSelectionCapture = false;

  function rangeWithinEditor(range, { allowCollapsed = true } = {}){
    if (!range) return false;
    if (!allowCollapsed && range.collapsed) return false;
    const { startContainer, endContainer } = range;
    if (!startContainer || !endContainer) return false;
    return editable.contains(startContainer) && editable.contains(endContainer);
  }

  function captureSelectionRange(){
    if (suppressSelectionCapture) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!rangeWithinEditor(range)) return;
    savedRange = range.cloneRange();
  }

  function getSavedRange({ requireSelection = false } = {}){
    if (!savedRange) return null;
    return rangeWithinEditor(savedRange, { allowCollapsed: !requireSelection }) ? savedRange : null;
  }

  function restoreSavedRange({ requireSelection = false } = {}){
    const range = getSavedRange({ requireSelection });
    if (!range) return false;
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    const clone = range.cloneRange();
    selection.addRange(clone);
    savedRange = clone.cloneRange();
    return true;
  }

  function runCommand(action, { requireSelection = false } = {}){
    const existing = getSavedRange({ requireSelection });
    if (!existing) return false;

    const preservedRange = existing.cloneRange();
    let restored = false;

    suppressSelectionCapture = true;
    try {
      focusEditor();
      savedRange = preservedRange.cloneRange();
      restored = restoreSavedRange({ requireSelection });
    } finally {
      suppressSelectionCapture = false;
    }

    if (!restored) return false;

    let inputFired = false;
    const handleInput = () => {
      inputFired = true;
    };
    editable.addEventListener('input', handleInput, { once: true });

    const result = action();

    editable.removeEventListener('input', handleInput);
    captureSelectionRange();
    if (!inputFired) {
      editable.dispatchEvent(new Event('input', { bubbles: true }));
    }
    updateInlineState();
    return result;
  }

  function exec(command, arg = null, { requireSelection = false, styleWithCss = true } = {}){
    return runCommand(() => {
      let previousStyleWithCss = null;
      try {
        previousStyleWithCss = document.queryCommandState('styleWithCSS');
      } catch (err) {
        previousStyleWithCss = null;
      }
      try {
        document.execCommand('styleWithCSS', false, styleWithCss);
        return document.execCommand(command, false, arg);
      } finally {
        if (previousStyleWithCss !== null) {
          document.execCommand('styleWithCSS', false, previousStyleWithCss);
        }
      }
    }, { requireSelection });
  }

  function insertPlainText(text) {
    if (text == null) return;
    const normalized = String(text).replace(/\r\n/g, '\n');
    runCommand(() => {
      const ok = document.execCommand('insertText', false, normalized);
      if (ok === false) {
        const html = escapeHtml(normalized).replace(/\n/g, '<br>');
        document.execCommand('insertHTML', false, html);
      }
    });
  }

  function insertHtml(html) {
    if (!html) return;
    runCommand(() => document.execCommand('insertHTML', false, html));
  }

  function selectionWithinEditor({ allowCollapsed = true } = {}){
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    if (!allowCollapsed && selection.isCollapsed) return false;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor || !focus) return false;
    return editable.contains(anchor) && editable.contains(focus);
  }

  function hasActiveSelection(){
    return Boolean(getSavedRange({ requireSelection: true }));
  }

  function collapsedInlineState(){
    const selection = window.getSelection();
    if (!selection?.anchorNode) return null;
    let node = selection.anchorNode;
    const state = { bold: false, italic: false, underline: false, strike: false };

    const applyFromElement = (el) => {
      const tag = el.tagName?.toLowerCase();
      if (tag === 'b' || tag === 'strong') state.bold = true;
      if (tag === 'i' || tag === 'em') state.italic = true;
      if (tag === 'u') state.underline = true;
      if (tag === 's' || tag === 'strike' || tag === 'del') state.strike = true;
      if (el instanceof Element) {
        const inlineStyle = el.style;
        if (inlineStyle) {
          if (!state.bold) {
            const weightRaw = inlineStyle.fontWeight || '';
            const weightText = typeof weightRaw === 'string' ? weightRaw.toLowerCase() : `${weightRaw}`.toLowerCase();
            const weightValue = Number.parseInt(weightText, 10);
            if (weightText === 'bold' || weightText === 'bolder' || Number.isFinite(weightValue) && weightValue >= 600) {
              state.bold = true;
            }
          }
          if (!state.italic && inlineStyle.fontStyle === 'italic') state.italic = true;
          const deco = `${inlineStyle.textDecorationLine || inlineStyle.textDecoration || ''}`.toLowerCase();
          if (!state.underline && deco.includes('underline')) state.underline = true;
          if (!state.strike && (deco.includes('line-through') || deco.includes('strikethrough'))) state.strike = true;
        }
      }
    };

    while (node && node !== editable) {
      if (node.nodeType === Node.TEXT_NODE) {
        node = node.parentNode;
        continue;
      }
      if (!(node instanceof Element)) {
        node = node.parentNode;
        continue;
      }
      applyFromElement(node);
      node = node.parentNode;
    }

    return state;
  }

  function updateInlineState(){
    const inEditor = selectionWithinEditor();
    const selection = window.getSelection();
    const collapsed = Boolean(selection?.isCollapsed);
    const collapsedState = inEditor && collapsed ? collapsedInlineState() : null;

    commandButtons.forEach(({ btn, command, stateKey }) => {
      let active = false;
      if (inEditor) {
        if (collapsed && collapsedState && stateKey) {
          active = collapsedState[stateKey];
        } else {
          try {
            active = document.queryCommandState(command);
          } catch (err) {
            active = false;
          }
        }
      }
      const isActive = Boolean(active);
      btn.classList.toggle('is-active', isActive);
      btn.dataset.active = isActive ? 'true' : 'false';
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    const style = inEditor ? computeSelectionStyle() : null;
    updateTypographyState(style);

    if (clozeButton) {
      const saved = getSavedRange({ requireSelection: false });
      const startNode = saved?.startContainer || null;
      const endNode = saved?.endContainer || null;
      const startCloze = startNode ? findClozeAncestor(startNode) : null;
      const endCloze = endNode ? findClozeAncestor(endNode) : null;
      const active = Boolean(startCloze && startCloze === endCloze);
      clozeButton.classList.toggle('is-active', active);
      clozeButton.dataset.active = active ? 'true' : 'false';
      clozeButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function styleForNode(node) {
    let current = node;
    while (current && current !== editable) {
      if (current instanceof Element) {
        return window.getComputedStyle(current);
      }
      current = current.parentNode;
    }
    if (editable instanceof Element) {
      return window.getComputedStyle(editable);
    }
    return null;
  }

  function computeSelectionStyle() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    if (selection.isCollapsed) {
      return styleForNode(selection.anchorNode);
    }
    const range = selection.getRangeAt(0);
    const startStyle = styleForNode(range.startContainer);
    if (startStyle) return startStyle;
    const endStyle = styleForNode(range.endContainer);
    if (endStyle) return endStyle;
    return styleForNode(range.commonAncestorContainer);
  }

  function findClozeAncestor(node) {
    let current = node;
    while (current && current !== editable) {
      if (current instanceof HTMLElement && current.getAttribute?.(CLOZE_ATTR) === CLOZE_VALUE) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  function unwrapClozeElement(element) {
    const parent = element.parentNode;
    if (!parent) return;
    const selection = window.getSelection();
    const range = document.createRange();
    let firstChild = null;
    let lastChild = null;
    while (element.firstChild) {
      const child = element.firstChild;
      parent.insertBefore(child, element);
      if (!firstChild) firstChild = child;
      lastChild = child;
    }
    const nextSibling = element.nextSibling;
    parent.removeChild(element);
    if (firstChild && lastChild) {
      range.setStartBefore(firstChild);
      range.setEndAfter(lastChild);
    } else {
      const index = Array.prototype.indexOf.call(parent.childNodes, nextSibling);
      range.setStart(parent, index >= 0 ? index : parent.childNodes.length);
      range.collapse(true);
    }
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function toggleClozeFormatting() {
    const range = getSavedRange({ requireSelection: false });
    if (!range) return;
    const startCloze = findClozeAncestor(range.startContainer);
    const endCloze = findClozeAncestor(range.endContainer);
    if (startCloze && startCloze === endCloze) {
      runCommand(() => {
        unwrapClozeElement(startCloze);
      });
      return;
    }
    if (range.collapsed) return;
    runCommand(() => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const activeRange = selection.getRangeAt(0);
      const fragment = activeRange.extractContents();
      const span = document.createElement('span');
      span.setAttribute(CLOZE_ATTR, CLOZE_VALUE);
      span.appendChild(fragment);
      activeRange.insertNode(span);
      selection.removeAllRanges();
      const newRange = document.createRange();
      newRange.selectNode(span);
      selection.addRange(newRange);
    }, { requireSelection: true });
  }

  function formatFontFamily(value = '') {
    if (!value) return 'Default';
    const primary = value.split(',')[0] || value;
    return primary.replace(/^['"]+|['"]+$/g, '').trim() || 'Default';
  }

  function updateTypographyState(style) {
    if (!fontNameLabel || !fontSizeLabel || !sizeSelect) return;
    const editingSize = document.activeElement === sizeSelect;
    const editingFont = document.activeElement === fontSelect;
    if (!style) {
      fontNameLabel.textContent = 'Font: Default';
      fontSizeLabel.textContent = 'Size: —';
      if (!editingFont && fontSelect) {
        fontSelect.value = '';
      }
      if (!editingSize) {
        sizeSelect.value = '';
        if (sizeSelect) delete sizeSelect.dataset.customValue;
      }
      return;
    }
    const family = formatFontFamily(style.fontFamily || '');
    const sizeText = style.fontSize || '';
    fontNameLabel.textContent = `Font: ${family}`;
    fontSizeLabel.textContent = `Size: ${sizeText || '—'}`;
    if (!editingFont && fontSelect) {
      const normalized = (style.fontFamily || '').trim().toLowerCase();
      const match = FONT_OPTIONS.find(option => option.value.trim().toLowerCase() === normalized);
      if (match) {
        fontSelect.value = match.value;
      } else if (normalized) {
        fontSelect.value = 'custom';
        fontSelect.dataset.customValue = style.fontFamily || '';
      } else {
        fontSelect.value = '';
      }
    }
    if (!editingSize) {
      const numeric = Number.parseFloat(sizeText);
      if (Number.isFinite(numeric)) {
        const rounded = Math.round(numeric);
        const optionMatch = FONT_SIZE_VALUES.find(val => val === rounded);
        if (optionMatch) {
          sizeSelect.value = String(optionMatch);
        } else {
          sizeSelect.value = 'custom';
          sizeSelect.dataset.customValue = String(rounded);
        }
      } else {
        sizeSelect.value = '';
        delete sizeSelect.dataset.customValue;
      }
    }
  }

  function collectElementsInRange(range) {
    const elements = [];
    if (!range) return elements;
    const walker = document.createTreeWalker(
      editable,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          try {
            return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          } catch (err) {
            return NodeFilter.FILTER_SKIP;
          }
        }
      }
    );
    while (walker.nextNode()) {
      elements.push(walker.currentNode);
    }
    return elements;
  }

  function removeFontSizeFromRange(range) {
    const elements = collectElementsInRange(range);
    elements.forEach(node => {
      if (!(node instanceof HTMLElement)) return;
      if (node.style && node.style.fontSize) {
        node.style.removeProperty('font-size');
        if (!node.style.length) node.removeAttribute('style');
      }
      if (node.tagName?.toLowerCase() === 'font') {
        const parent = node.parentNode;
        if (!parent) return;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
      }
    });
  }

  function removeFontFamilyFromRange(range) {
    const elements = collectElementsInRange(range);
    elements.forEach(node => {
      if (!(node instanceof HTMLElement)) return;
      if (node.style && node.style.fontFamily) {
        node.style.removeProperty('font-family');
        if (!node.style.length) node.removeAttribute('style');
      }
      if (node.tagName?.toLowerCase() === 'font') {
        const parent = node.parentNode;
        if (!parent) return;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
      }
    });
  }

  function applyFontSizeValue(value) {
    runCommand(() => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      removeFontSizeFromRange(range);
      const numeric = Number.parseFloat(value);
      const hasSize = Number.isFinite(numeric) && numeric > 0;
      if (!hasSize) {
        return;
      }
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('fontSize', false, 4);
      const fonts = editable.querySelectorAll('font');
      fonts.forEach(node => {
        const parent = node.parentNode;
        if (!parent) return;
        const span = document.createElement('span');
        span.style.fontSize = `${numeric}px`;
        while (node.firstChild) span.appendChild(node.firstChild);
        parent.replaceChild(span, node);
      });
    }, { requireSelection: true });
  }

  function applyFontFamilyValue(value) {
    runCommand(() => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      removeFontFamilyFromRange(range);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) {
        return;
      }
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('fontName', false, trimmed);
      const fonts = editable.querySelectorAll('font');
      fonts.forEach(node => {
        const parent = node.parentNode;
        if (!parent) return;
        const span = document.createElement('span');
        span.style.fontFamily = trimmed;
        while (node.firstChild) span.appendChild(node.firstChild);
        parent.replaceChild(span, node);
      });
    }, { requireSelection: true });
  }

  function createGroup(extraClass){
    const group = document.createElement('div');
    group.className = 'rich-editor-group';
    if (extraClass) group.classList.add(extraClass);
    toolbar.appendChild(group);
    return group;
  }
  const inlineGroup = createGroup();
  [
    ['B', 'Bold', 'bold', 'bold'],
    ['I', 'Italic', 'italic', 'italic'],
    ['U', 'Underline', 'underline', 'underline'],
    ['S', 'Strikethrough', 'strikeThrough', 'strike']
  ].forEach(([label, title, command, stateKey]) => {
    const btn = createToolbarButton(label, title, () => exec(command));
    btn.dataset.command = command;
    commandButtons.push({ btn, command, stateKey });
    inlineGroup.appendChild(btn);
  });

  const colorWrap = document.createElement('label');
  colorWrap.className = 'rich-editor-color';
  colorWrap.title = 'Text color';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = '#ffffff';
  colorInput.dataset.lastColor = '#ffffff';
  colorInput.addEventListener('input', () => {
    if (!getSavedRange({ requireSelection: true })) {
      const previous = colorInput.dataset.lastColor || '#ffffff';
      colorInput.value = previous;
      return;
    }
    exec('foreColor', colorInput.value, { requireSelection: true });
    colorInput.dataset.lastColor = colorInput.value;
  });
  colorWrap.appendChild(colorInput);
  const colorGroup = createGroup('rich-editor-color-group');
  colorGroup.appendChild(colorWrap);

  const highlightRow = document.createElement('div');
  highlightRow.className = 'rich-editor-highlight-row';
  colorGroup.appendChild(highlightRow);

  const highlightColors = [
    ['#facc15', 'Yellow'],
    ['#f472b6', 'Pink'],
    ['#f87171', 'Red'],
    ['#4ade80', 'Green'],
    ['#38bdf8', 'Blue']
  ];

  function applyHighlight(color) {
    if (!getSavedRange({ requireSelection: true })) return;
    exec('hiliteColor', color, { requireSelection: true });
  }

  const clearSwatch = document.createElement('button');
  clearSwatch.type = 'button';
  clearSwatch.className = 'rich-editor-swatch rich-editor-swatch--clear';
  clearSwatch.title = 'Remove highlight';
  clearSwatch.setAttribute('aria-label', 'Remove highlight');
  clearSwatch.textContent = '×';
  clearSwatch.addEventListener('mousedown', e => e.preventDefault());
  clearSwatch.addEventListener('click', () => {
    exec('hiliteColor', 'transparent', { requireSelection: true });
  });
  highlightRow.appendChild(clearSwatch);

  highlightColors.forEach(([color, label]) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'rich-editor-swatch';
    swatch.style.setProperty('--swatch-color', color);
    swatch.title = `${label} highlight`;
    swatch.setAttribute('aria-label', `${label} highlight`);
    swatch.addEventListener('mousedown', e => e.preventDefault());
    swatch.addEventListener('click', () => applyHighlight(color));
    highlightRow.appendChild(swatch);
  });

  const listGroup = createGroup('rich-editor-list-group');

  function applyOrderedStyle(style){
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    let node = selection.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    while (node && node !== editable) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName?.toLowerCase() === 'ol') {
        if (style) node.style.listStyleType = style;
        else node.style.removeProperty('list-style-type');
        break;
      }
      node = node.parentNode;
    }
  }

  function insertOrdered(style){
    runCommand(() => {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('insertOrderedList', false, null);
      if (style) applyOrderedStyle(style);
    });
  }

  const listButtons = [
    ['•', 'Bulleted list', () => exec('insertUnorderedList', null, { styleWithCss: false })],
    ['1.', 'Numbered list', () => insertOrdered('')],
    ['a.', 'Lettered list', () => insertOrdered('lower-alpha')],
    ['i.', 'Roman numeral list', () => insertOrdered('lower-roman')]
  ];
  listButtons.forEach(([label, title, handler]) => {
    const btn = createToolbarButton(label, title, handler);
    listGroup.appendChild(btn);
  });

  const typographyGroup = createGroup('rich-editor-typography-group');

  const fontInfo = document.createElement('div');
  fontInfo.className = 'rich-editor-font-info';
  fontNameLabel = document.createElement('span');
  fontNameLabel.className = 'rich-editor-font-name';
  fontNameLabel.textContent = 'Font: Default';
  fontInfo.appendChild(fontNameLabel);
  fontSizeLabel = document.createElement('span');
  fontSizeLabel.className = 'rich-editor-font-size';
  fontSizeLabel.textContent = 'Size: —';
  fontInfo.appendChild(fontSizeLabel);
  typographyGroup.appendChild(fontInfo);

  fontSelect = document.createElement('select');
  fontSelect.className = 'rich-editor-select rich-editor-font-select';
  fontSelect.setAttribute('aria-label', 'Font family');
  FONT_OPTIONS.forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    fontSelect.appendChild(opt);
  });
  const customFontOption = document.createElement('option');
  customFontOption.value = 'custom';
  customFontOption.textContent = 'Custom…';
  fontSelect.appendChild(customFontOption);
  ['mousedown', 'focus', 'keydown'].forEach(evt => {
    fontSelect.addEventListener(evt, () => captureSelectionRange());
  });
  fontSelect.addEventListener('change', () => {
    if (!hasActiveSelection()) {
      updateInlineState();
      return;
    }
    let selected = fontSelect.value;
    if (selected === 'custom') {
      const current = fontSelect.dataset.customValue || '';
      const custom = prompt('Enter font family (CSS value)', current || '');
      if (!custom) {
        updateInlineState();
        return;
      }
      fontSelect.dataset.customValue = custom;
      selected = custom;
    } else if (!selected) {
      delete fontSelect.dataset.customValue;
    }
    applyFontFamilyValue(selected);
    focusEditor();
  });
  typographyGroup.appendChild(fontSelect);

  sizeSelect = document.createElement('select');
  sizeSelect.className = 'rich-editor-select rich-editor-size';
  sizeSelect.setAttribute('aria-label', 'Font size');
  const defaultSizeOption = document.createElement('option');
  defaultSizeOption.value = '';
  defaultSizeOption.textContent = 'Size';
  sizeSelect.appendChild(defaultSizeOption);
  FONT_SIZE_VALUES.forEach(val => {
    const opt = document.createElement('option');
    opt.value = String(val);
    opt.textContent = `${val}px`;
    sizeSelect.appendChild(opt);
  });
  const customSizeOption = document.createElement('option');
  customSizeOption.value = 'custom';
  customSizeOption.textContent = 'Custom…';
  sizeSelect.appendChild(customSizeOption);
  ['mousedown', 'focus', 'keydown'].forEach(evt => {
    sizeSelect.addEventListener(evt, () => captureSelectionRange());
  });
  sizeSelect.addEventListener('change', () => {
    if (!hasActiveSelection()) {
      updateInlineState();
      return;
    }
    let selected = sizeSelect.value;
    if (selected === 'custom') {
      const current = sizeSelect.dataset.customValue || '';
      const custom = prompt('Enter font size in pixels', current || '16');
      const numeric = Number.parseFloat(custom || '');
      if (!custom || !Number.isFinite(numeric) || numeric <= 0) {
        updateInlineState();
        return;
      }
      const rounded = Math.round(numeric);
      sizeSelect.dataset.customValue = String(rounded);
      selected = String(rounded);
    } else if (!selected) {
      delete sizeSelect.dataset.customValue;
    }
    applyFontSizeValue(selected || null);
    focusEditor();
  });
  typographyGroup.appendChild(sizeSelect);

  const resetSizeBtn = createToolbarButton('↺', 'Reset font size', () => {
    if (!hasActiveSelection()) return;
    sizeSelect.value = '';
    delete sizeSelect.dataset.customValue;
    applyFontSizeValue(null);
    focusEditor();
  });
  typographyGroup.appendChild(resetSizeBtn);

  const mediaGroup = createGroup('rich-editor-media-group');

  const linkBtn = createToolbarButton('🔗', 'Insert link', () => {
    if (!hasActiveSelection()) return;
    const url = prompt('Enter URL');
    if (!url) return;
    exec('createLink', url, { requireSelection: true });
  });
  mediaGroup.appendChild(linkBtn);

  const imageBtn = createToolbarButton('🖼', 'Upload image (Shift+Click for URL)', (event) => {
    if (event.shiftKey) {
      const url = prompt('Enter image URL');
      if (!url) return;
      exec('insertImage', url, { styleWithCss: false });
      return;
    }
    imageFileInput.click();
  });
  mediaGroup.appendChild(imageBtn);

  const mediaBtn = createToolbarButton('🎬', 'Upload media (Shift+Click for URL)', (event) => {
    if (event.shiftKey) {
      const url = prompt('Enter media URL');
      if (!url) return;
      const typePrompt = prompt('Media type (video/audio/embed)', 'video');
      const kind = (typePrompt || 'video').toLowerCase();
      const safeUrl = escapeHtml(url);
      let html = '';
      if (kind.startsWith('a')) {
        html = `<audio controls src="${safeUrl}"></audio>`;
      } else if (kind.startsWith('e') || kind.startsWith('i')) {
        html = `<iframe src="${safeUrl}" title="Embedded media" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
      } else {
        html = `<video controls src="${safeUrl}"></video>`;
      }
      insertHtml(html);
      return;
    }
    mediaFileInput.click();
  });
  mediaGroup.appendChild(mediaBtn);

  const clozeTool = createToolbarButton('⧉', 'Toggle cloze (hide selected text until clicked)', () => {
    toggleClozeFormatting();
    focusEditor();
  });
  clozeButton = clozeTool;
  const clearBtn = createToolbarButton('⌫', 'Clear formatting', () => exec('removeFormat', null, { requireSelection: true, styleWithCss: false }));
  const utilityGroup = createGroup('rich-editor-utility-group');
  utilityGroup.appendChild(clozeTool);
  utilityGroup.appendChild(clearBtn);

  let settingValue = false;
  editable.addEventListener('input', () => {
    if (settingValue) return;
    if (typeof onChange === 'function') onChange();
    updateInlineState();
  });

  editable.addEventListener('dblclick', (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path.find(node => node instanceof HTMLImageElement) || event.target;
    if (target instanceof HTMLImageElement) {
      event.preventDefault();
      event.stopPropagation();
      beginImageEditing(target);
    }
  });

  ['keyup','mouseup','focus'].forEach(event => {
    editable.addEventListener(event, () => updateInlineState());
  });

  editable.addEventListener('blur', () => {
    setTimeout(() => updateInlineState(), 0);
  });

  const selectionHandler = () => {
    if (!document.body.contains(wrapper)) {
      document.removeEventListener('selectionchange', selectionHandler);
      destroyActiveImageEditor();
      return;
    }
    captureSelectionRange();
    updateInlineState();
  };
  document.addEventListener('selectionchange', selectionHandler);

  updateInlineState();

  return {
    element: wrapper,
    getValue(){
      const sanitized = sanitizeHtml(editable.innerHTML);
      return isEmptyHtml(sanitized) ? '' : sanitized;
    },
    setValue(val){
      settingValue = true;
      destroyActiveImageEditor();
      editable.innerHTML = normalizeInput(val);
      settingValue = false;
      if (occlusionDisplayManager) occlusionDisplayManager.sync();
      updateInlineState();
    },
    focus(){
      focusEditor();
    },
    destroy(){
      document.removeEventListener('selectionchange', selectionHandler);
      destroyActiveImageEditor();
      if (occlusionDisplayManager && typeof occlusionDisplayManager.destroy === 'function') {
        occlusionDisplayManager.destroy();
      }
      occlusionDisplayManager = null;
    }
  };
}

function closeImageLightbox(){
  if (!activeImageLightbox) return;
  window.removeEventListener('keydown', activeImageLightbox.onKeyDown);
  window.removeEventListener('resize', activeImageLightbox.onResize);
  if (activeImageLightbox.element && activeImageLightbox.element.parentNode) {
    activeImageLightbox.element.parentNode.removeChild(activeImageLightbox.element);
  }
  activeImageLightbox = null;
}

function openImageLightbox(image){
  if (!(image instanceof HTMLImageElement)) return;
  closeImageLightbox();

  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const backdrop = document.createElement('div');
  backdrop.className = 'image-lightbox-backdrop';
  overlay.appendChild(backdrop);

  const frame = document.createElement('div');
  frame.className = 'image-lightbox-frame';
  overlay.appendChild(frame);

  const dragHandle = document.createElement('div');
  dragHandle.className = 'image-lightbox-drag-handle';
  dragHandle.setAttribute('aria-hidden', 'true');
  frame.appendChild(dragHandle);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-lightbox-close';
  closeBtn.setAttribute('aria-label', 'Close image');
  closeBtn.innerHTML = '✕';
  frame.appendChild(closeBtn);

  const surface = document.createElement('div');
  surface.className = 'image-lightbox-surface';
  frame.appendChild(surface);

  const cloned = image.cloneNode(true);
  cloned.removeAttribute('width');
  cloned.removeAttribute('height');
  cloned.classList.add('image-lightbox-img');
  cloned.style.width = '100%';
  cloned.style.height = '100%';
  cloned.style.objectFit = 'contain';
  surface.appendChild(cloned);
  cloned.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeImageLightbox();
  });

  const highlightLayer = document.createElement('div');
  highlightLayer.className = 'image-annotation-layer image-highlight-layer';
  highlightLayer.hidden = true;
  surface.appendChild(highlightLayer);

  const textLayer = document.createElement('div');
  textLayer.className = 'image-annotation-layer image-text-layer';
  textLayer.hidden = true;
  surface.appendChild(textLayer);

  const layer = document.createElement('div');
  layer.className = 'image-lightbox-occlusions image-occlusion-layer';
  layer.hidden = true;
  surface.appendChild(layer);

  const boxElements = new Map();
  const highlightElements = new Map();
  const textboxElements = new Map();
  const revealStates = new Map();

  let framePosition = { left: null, top: null };
  let dragPointerId = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  function setFramePosition(left, top){
    const width = frame.offsetWidth || 0;
    const height = frame.offsetHeight || 0;
    const margin = 24;
    const minLeft = margin;
    const minTop = margin;
    const maxLeft = Math.max(minLeft, window.innerWidth - width - margin);
    const maxTop = Math.max(minTop, window.innerHeight - height - margin);
    const boundedLeft = Math.min(Math.max(left, minLeft), maxLeft);
    const boundedTop = Math.min(Math.max(top, minTop), maxTop);
    frame.style.left = `${Math.round(boundedLeft)}px`;
    frame.style.top = `${Math.round(boundedTop)}px`;
    framePosition = {
      left: Math.round(boundedLeft),
      top: Math.round(boundedTop)
    };
  }

  function centerFrame(){
    const width = frame.offsetWidth || 0;
    const height = frame.offsetHeight || 0;
    const left = (window.innerWidth - width) / 2;
    const top = (window.innerHeight - height) / 2;
    setFramePosition(left, top);
  }

  function applyFrameLayout(){
    const viewportWidth = window.innerWidth || 1280;
    const viewportHeight = window.innerHeight || 720;
    const margin = 48;
    const maxWidth = Math.max(360, viewportWidth - margin);
    const maxHeight = Math.max(280, viewportHeight - margin);
    const targetWidth = Math.min(
      Math.max(560, viewportWidth * 0.82),
      maxWidth,
      1280
    );
    const targetHeight = Math.min(
      Math.max(420, viewportHeight * 0.82),
      maxHeight,
      900
    );
    frame.style.width = `${Math.round(targetWidth)}px`;
    frame.style.height = `${Math.round(targetHeight)}px`;
    surface.style.width = '100%';
    surface.style.height = '100%';
  }

  function refreshLayout({ forceCenter = false } = {}){
    applyFrameLayout();
    if (forceCenter || framePosition.left == null || framePosition.top == null) {
      centerFrame();
    } else {
      setFramePosition(framePosition.left, framePosition.top);
    }
  }

  function startDrag(event){
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = frame.getBoundingClientRect();
    dragPointerId = event.pointerId;
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    frame.setPointerCapture(dragPointerId);
  }

  function handleDrag(event){
    if (dragPointerId == null || event.pointerId !== dragPointerId) return;
    event.preventDefault();
    setFramePosition(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
  }

  function stopDrag(event){
    if (dragPointerId == null || event.pointerId !== dragPointerId) return;
    event.preventDefault();
    frame.releasePointerCapture(dragPointerId);
    dragPointerId = null;
    if (framePosition.left == null || framePosition.top == null) {
      centerFrame();
    } else {
      setFramePosition(framePosition.left, framePosition.top);
    }
  }

  dragHandle.addEventListener('pointerdown', startDrag);
  frame.addEventListener('pointermove', handleDrag);
  frame.addEventListener('pointerup', stopDrag);
  frame.addEventListener('pointercancel', stopDrag);

  function toggleReveal(element){
    const id = element?.dataset?.id;
    if (!id) return;
    const next = !(revealStates.get(id) === true);
    revealStates.set(id, next);
    setOcclusionRevealState(element, next);
  }

  function updateBoxes(){
    const metrics = resolveImageMetrics(cloned);
    const occlusions = parseImageOcclusions(cloned);
    const seen = new Set();
    occlusions.forEach(box => {
      let element = boxElements.get(box.id);
      if (!element) {
        element = document.createElement('div');
        element.className = 'image-occlusion-box';
        element.dataset.id = box.id;
        element.tabIndex = 0;
        element.setAttribute('role', 'button');
        element.setAttribute('aria-pressed', 'false');
        element.setAttribute('aria-label', 'Toggle occlusion');
        element.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleReveal(element);
        });
        element.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleReveal(element);
          }
        });
        layer.appendChild(element);
        boxElements.set(box.id, element);
      }
      applyOcclusionBoxGeometry(element, box, metrics || cloned);
      const revealed = revealStates.get(box.id) === true;
      setOcclusionRevealState(element, revealed);
      seen.add(box.id);
    });
    boxElements.forEach((element, id) => {
      if (!seen.has(id)) {
        element.remove();
        boxElements.delete(id);
        revealStates.delete(id);
      }
    });
    layer.hidden = boxElements.size === 0;
    layer.classList.toggle('is-active', boxElements.size > 0);
  }

  function updateHighlights(){
    const metrics = resolveImageMetrics(cloned);
    const highlights = parseImageHighlights(cloned);
    const seen = new Set();
    highlights.forEach(box => {
      let element = highlightElements.get(box.id);
      if (!element) {
        element = document.createElement('div');
        element.className = 'image-highlight-box';
        element.dataset.id = box.id;
        highlightLayer.appendChild(element);
        highlightElements.set(box.id, element);
      }
      element.style.borderColor = box.color;
      element.style.backgroundColor = highlightColorToRgba(box.color, 0.35);
      applyOcclusionBoxGeometry(element, box, metrics || cloned);
      seen.add(box.id);
    });
    highlightElements.forEach((element, id) => {
      if (!seen.has(id)) {
        element.remove();
        highlightElements.delete(id);
      }
    });
    highlightLayer.hidden = highlightElements.size === 0;
  }

  function updateTextboxes(){
    const metrics = resolveImageMetrics(cloned);
    const textboxes = parseImageTextboxes(cloned);
    const seen = new Set();
    textboxes.forEach(box => {
      let element = textboxElements.get(box.id);
      if (!element) {
        element = document.createElement('div');
        element.className = 'image-textbox';
        element.dataset.id = box.id;
        const content = document.createElement('div');
        content.className = 'image-textbox-content';
        content.setAttribute('aria-hidden', 'true');
        element.appendChild(content);
        textLayer.appendChild(element);
        textboxElements.set(box.id, element);
      }
      const content = element.querySelector('.image-textbox-content');
      if (content && (content.textContent || '') !== (box.text || '')) {
        content.textContent = box.text || '';
      }
      applyOcclusionBoxGeometry(element, box, metrics || cloned);
      seen.add(box.id);
    });
    textboxElements.forEach((element, id) => {
      if (!seen.has(id)) {
        element.remove();
        textboxElements.delete(id);
      }
    });
    textLayer.hidden = textboxElements.size === 0;
  }

  function updateAll(){
    updateBoxes();
    updateHighlights();
    updateTextboxes();
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeImageLightbox();
    }
  };

  const onResize = () => {
    refreshLayout();
    updateAll();
  };

  closeBtn.addEventListener('click', () => closeImageLightbox());
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target === backdrop) {
      closeImageLightbox();
    }
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);

  cloned.addEventListener('load', () => updateAll());

  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    refreshLayout({ forceCenter: true });
    updateAll();
  });

  activeImageLightbox = {
    element: overlay,
    onKeyDown,
    onResize
  };
}

function createRichContentImageManager(container, options = {}){
  const { enableLightbox = true } = options;
  const overlays = new Map();
  const clickHandlers = new Map();
  const images = Array.from(container.querySelectorAll('img'));
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => {
        for (const entry of entries) {
          const image = entry.target;
          const overlay = overlays.get(image);
          if (overlay) overlay.update();
        }
      })
    : null;

  function createDisplayOverlay(image){
    const overlayEl = document.createElement('div');
    overlayEl.className = 'rich-content-occlusion-overlay';
    overlayEl.setAttribute('aria-hidden', 'true');
    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'image-annotation-layer image-highlight-layer';
    overlayEl.appendChild(highlightLayer);
    const textLayer = document.createElement('div');
    textLayer.className = 'image-annotation-layer image-text-layer';
    overlayEl.appendChild(textLayer);
    const layer = document.createElement('div');
    layer.className = 'image-occlusion-layer';
    overlayEl.appendChild(layer);
    container.appendChild(overlayEl);

    const boxElements = new Map();
    const highlightElements = new Map();
    const textboxElements = new Map();
    const revealStates = new Map();

    function toggleReveal(element){
      const id = element?.dataset?.id;
      if (!id) return;
      const next = !(revealStates.get(id) === true);
      revealStates.set(id, next);
      setOcclusionRevealState(element, next);
    }

    function updatePosition(){
      if (!container.contains(image)) {
        destroy();
        return;
      }
      const rect = image.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      overlayEl.style.width = `${rect.width}px`;
      overlayEl.style.height = `${rect.height}px`;
      overlayEl.style.left = `${rect.left - containerRect.left}px`;
      overlayEl.style.top = `${rect.top - containerRect.top}px`;
    }

    function updateOcclusions(){
      const metrics = resolveImageMetrics(image);
      const occlusions = parseImageOcclusions(image);
      const seen = new Set();
      occlusions.forEach(box => {
        let element = boxElements.get(box.id);
        if (!element) {
          element = document.createElement('div');
          element.className = 'image-occlusion-box';
          element.dataset.id = box.id;
          element.tabIndex = 0;
          element.setAttribute('role', 'button');
          element.setAttribute('aria-pressed', 'false');
          element.setAttribute('aria-label', 'Toggle occlusion');
          element.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleReveal(element);
          });
          element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleReveal(element);
            }
          });
          layer.appendChild(element);
          boxElements.set(box.id, element);
        }
        applyOcclusionBoxGeometry(element, box, metrics || image);
        const revealed = revealStates.get(box.id) === true;
        setOcclusionRevealState(element, revealed);
        seen.add(box.id);
      });
      boxElements.forEach((element, id) => {
        if (!seen.has(id)) {
          element.remove();
          boxElements.delete(id);
          revealStates.delete(id);
        }
      });
    }

    function updateHighlights(){
      const metrics = resolveImageMetrics(image);
      const highlights = parseImageHighlights(image);
      const seen = new Set();
      highlights.forEach(box => {
        let element = highlightElements.get(box.id);
        if (!element) {
          element = document.createElement('div');
          element.className = 'image-highlight-box';
          element.dataset.id = box.id;
          highlightLayer.appendChild(element);
          highlightElements.set(box.id, element);
        }
        element.style.borderColor = box.color;
        element.style.backgroundColor = highlightColorToRgba(box.color, 0.35);
        applyOcclusionBoxGeometry(element, box, metrics || image);
        seen.add(box.id);
      });
      highlightElements.forEach((element, id) => {
        if (!seen.has(id)) {
          element.remove();
          highlightElements.delete(id);
        }
      });
      highlightLayer.classList.toggle('is-hidden', highlightElements.size === 0);
    }

    function updateTextboxes(){
      const metrics = resolveImageMetrics(image);
      const textboxes = parseImageTextboxes(image);
      const seen = new Set();
      textboxes.forEach(box => {
        let element = textboxElements.get(box.id);
        if (!element) {
          element = document.createElement('div');
          element.className = 'image-textbox';
          element.dataset.id = box.id;
          const content = document.createElement('div');
          content.className = 'image-textbox-content';
          content.setAttribute('aria-hidden', 'true');
          element.appendChild(content);
          textLayer.appendChild(element);
          textboxElements.set(box.id, element);
        }
        const content = element.querySelector('.image-textbox-content');
        if (content && (content.textContent || '') !== (box.text || '')) {
          content.textContent = box.text || '';
        }
        applyOcclusionBoxGeometry(element, box, metrics || image);
        seen.add(box.id);
      });
      textboxElements.forEach((element, id) => {
        if (!seen.has(id)) {
          element.remove();
          textboxElements.delete(id);
        }
      });
      textLayer.classList.toggle('is-hidden', textboxElements.size === 0);
    }

    function updateVisibility(){
      const hasOcclusions = boxElements.size > 0;
      const hasHighlights = highlightElements.size > 0;
      const hasTextboxes = textboxElements.size > 0;
      overlayEl.classList.toggle('is-hidden', !hasOcclusions && !hasHighlights && !hasTextboxes);
    }

    function update(){
      updatePosition();
      updateOcclusions();
      updateHighlights();
      updateTextboxes();
      updateVisibility();
    }

    const handleChange = () => {
      revealStates.clear();
      updateOcclusions();
      updateHighlights();
      updateTextboxes();
      updateVisibility();
      updatePosition();
    };

    function destroy(){
      boxElements.clear();
      highlightElements.clear();
      textboxElements.clear();
      revealStates.clear();
      overlayEl.remove();
      image.removeEventListener('load', update);
      image.removeEventListener(IMAGE_OCCLUSION_EVENT, handleChange);
    }

    image.addEventListener('load', update);
    image.addEventListener(IMAGE_OCCLUSION_EVENT, handleChange);

    update();

    return { update, destroy };
  }

  function setupImage(image){
    if (!(image instanceof HTMLImageElement)) return;
    if (enableLightbox) {
      const handler = (event) => {
        event.preventDefault();
        openImageLightbox(image);
      };
      image.addEventListener('dblclick', handler);
      clickHandlers.set(image, handler);
      image.classList.add('rich-content-image-interactive');
    }
    const hasOcclusions = parseImageOcclusions(image).length > 0;
    const hasHighlights = parseImageHighlights(image).length > 0;
    const hasTextboxes = parseImageTextboxes(image).length > 0;
    if (hasOcclusions || hasHighlights || hasTextboxes) {
      const overlay = createDisplayOverlay(image);
      overlays.set(image, overlay);
      if (resizeObserver) {
        try {
          resizeObserver.observe(image);
        } catch (err) {
          // ignore observer attachment issues
        }
      }
    }
  }

  images.forEach(setupImage);

  function updateAll(){
    overlays.forEach(overlay => overlay.update());
  }

  const onScroll = () => updateAll();

  document.addEventListener('scroll', onScroll, true);
  container.addEventListener('scroll', onScroll);
  window.addEventListener('resize', updateAll);

  return {
    destroy(){
      document.removeEventListener('scroll', onScroll, true);
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', updateAll);
      if (resizeObserver) resizeObserver.disconnect();
      overlays.forEach((overlay, image) => {
        overlay.destroy();
        if (resizeObserver) {
          try {
            resizeObserver.unobserve(image);
          } catch (err) {
            // ignore
          }
        }
      });
      overlays.clear();
      clickHandlers.forEach((handler, image) => {
        image.removeEventListener('dblclick', handler);
        image.classList.remove('rich-content-image-interactive');
      });
      clickHandlers.clear();
    }
  };
}

function enhanceRichContentImages(target, options = {}){
  if (!target) return;
  closeImageLightbox();
  const existing = richContentManagers.get(target);
  if (existing && typeof existing.destroy === 'function') {
    existing.destroy();
    richContentManagers.delete(target);
  }
  if (!target.querySelector('img')) {
    return;
  }
  const manager = createRichContentImageManager(target, options);
  richContentManagers.set(target, manager);
}

const CLOZE_STATE_HIDDEN = 'hidden';
const CLOZE_STATE_REVEALED = 'revealed';

function setClozeState(node, state){
  if (!(node instanceof HTMLElement)) return;
  const next = state === CLOZE_STATE_REVEALED ? CLOZE_STATE_REVEALED : CLOZE_STATE_HIDDEN;
  node.setAttribute('data-cloze-state', next);
  if (next === CLOZE_STATE_REVEALED) {
    node.classList.add('is-cloze-revealed');
    node.classList.remove('is-cloze-hidden');
  } else {
    node.classList.add('is-cloze-hidden');
    node.classList.remove('is-cloze-revealed');
  }
  if (node.classList.contains('cloze-text-interactive')) {
    node.setAttribute('aria-pressed', next === CLOZE_STATE_REVEALED ? 'true' : 'false');
  } else if (node.hasAttribute('aria-pressed')) {
    node.removeAttribute('aria-pressed');
  }
}

function toggleCloze(node){
  if (!(node instanceof HTMLElement)) return;
  const current = node.getAttribute('data-cloze-state');
  const next = current === CLOZE_STATE_REVEALED ? CLOZE_STATE_HIDDEN : CLOZE_STATE_REVEALED;
  setClozeState(node, next);
}

function handleClozeClick(event){
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const cloze = target.closest(CLOZE_SELECTOR);
  if (!cloze) return;
  event.stopPropagation();
  toggleCloze(cloze);
}

function handleClozeKey(event){
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const cloze = target.closest(CLOZE_SELECTOR);
  if (!cloze) return;
  event.preventDefault();
  event.stopPropagation();
  toggleCloze(cloze);
}

function detachClozeHandlers(container){
  const handlers = container.__clozeHandlers;
  if (!handlers) return;
  container.removeEventListener('click', handlers.click);
  container.removeEventListener('keydown', handlers.key);
  delete container.__clozeHandlers;
}

function resetClozeStates(target){
  if (!target) return;
  const nodes = target.querySelectorAll(CLOZE_SELECTOR);
  if (!nodes.length) return;
  nodes.forEach(node => setClozeState(node, CLOZE_STATE_HIDDEN));
}

function enhanceClozeContent(target, { clozeMode = 'static', resetClozeState = false } = {}){
  const nodes = target.querySelectorAll(CLOZE_SELECTOR);
  if (!nodes.length) {
    target.classList.remove('rich-content-with-cloze');
    detachClozeHandlers(target);
    return;
  }
  target.classList.add('rich-content-with-cloze');
  const interactive = clozeMode === 'interactive';
  nodes.forEach(node => {
    node.classList.add('cloze-text');
    if (interactive) {
      node.classList.add('cloze-text-interactive');
      if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      const current = node.getAttribute('data-cloze-state');
      if (resetClozeState) {
        setClozeState(node, CLOZE_STATE_HIDDEN);
      } else if (current !== CLOZE_STATE_REVEALED && current !== CLOZE_STATE_HIDDEN) {
        setClozeState(node, CLOZE_STATE_HIDDEN);
      } else {
        setClozeState(node, current);
      }
    } else {
      node.classList.remove('cloze-text-interactive');
      if (node.getAttribute('tabindex') === '0') node.removeAttribute('tabindex');
      if (node.getAttribute('role') === 'button') node.removeAttribute('role');
      setClozeState(node, CLOZE_STATE_REVEALED);
    }
  });
  if (interactive) {
    if (!target.__clozeHandlers) {
      const handlers = {
        click: handleClozeClick,
        key: handleClozeKey
      };
      target.addEventListener('click', handlers.click);
      target.addEventListener('keydown', handlers.key);
      target.__clozeHandlers = handlers;
    }
  } else {
    detachClozeHandlers(target);
  }
}

function normalizedFromCache(value){
  if (!value) return '';
  const key = typeof value === 'string' ? value : null;
  if (key !== null && richTextCache.has(key)) {
    return richTextCache.get(key);
  }
  const normalized = normalizeInput(value);
  if (key !== null && key.length <= 20000) {
    if (!richTextCache.has(key)) {
      richTextCacheKeys.push(key);
      if (richTextCacheKeys.length > RICH_TEXT_CACHE_LIMIT) {
        const oldest = richTextCacheKeys.shift();
        if (oldest != null) richTextCache.delete(oldest);
      }
    }
    richTextCache.set(key, normalized);
  }
  return normalized;
}

export function renderRichText(target, value, options = {}){
  const normalized = normalizedFromCache(value);
  if (!normalized) {
    const existing = richContentManagers.get(target);
    if (existing && typeof existing.destroy === 'function') {
      existing.destroy();
      richContentManagers.delete(target);
    }
    target.textContent = '';
    target.classList.remove('rich-content');
    detachClozeHandlers(target);
    return;
  }
  target.classList.add('rich-content');
  target.innerHTML = normalized;
  enhanceClozeContent(target, options);
  enhanceRichContentImages(target, options);
}

export { resetClozeStates };

export function hasRichTextContent(value){
  return !isEmptyHtml(normalizeInput(value));
}
