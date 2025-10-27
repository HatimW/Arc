import { readFileAsDataUrl, editImageSource } from './media-upload.js';

const allowedTags = new Set([
  'a','b','strong','i','em','u','s','strike','del','mark','span','font','p','div','br','ul','ol','li','img','sub','sup','blockquote','code','pre','hr','video','audio','source','iframe'
]);

const allowedAttributes = {
  'a': ['href', 'title', 'target', 'rel'],
  'img': ['src', 'alt', 'title', 'width', 'height', 'data-occlusion'],
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
      const allowData = tag === 'img';
      const requireHttps = tag === 'iframe';
      if (!isSafeUrl(attr.value || '', { allowData, requireHttps })) {
        node.removeAttribute(attr.name);
      }
    }
  });
  Array.from(node.childNodes).forEach(sanitizeNode);
}

const OCCLUSION_ATTR = 'data-occlusion';
const OCCLUSION_WRAPPER_CLASS = 'image-occlusion-wrapper';
const OCCLUSION_LAYER_CLASS = 'image-occlusion-layer';
const OCCLUSION_RECT_CLASS = 'image-occlusion-rect';
const OCCLUSION_STATE_HIDDEN = 'hidden';
const OCCLUSION_STATE_REVEALED = 'revealed';
const occlusionControllers = new WeakMap();
let occlusionIdCounter = 0;

function generateOcclusionId(){
  occlusionIdCounter = (occlusionIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `occ-${Date.now().toString(36)}-${occlusionIdCounter.toString(36)}`;
}

function decodeOcclusionValue(value = ''){
  if (!value) return [];
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch (err) {
    decoded = value;
  }
  try {
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(entry => ({
      id: typeof entry?.id === 'string' && entry.id ? entry.id : generateOcclusionId(),
      x: Number.isFinite(entry?.x) ? entry.x : 0,
      y: Number.isFinite(entry?.y) ? entry.y : 0,
      width: Number.isFinite(entry?.width) ? entry.width : 0,
      height: Number.isFinite(entry?.height) ? entry.height : 0
    })).filter(entry => entry.width > 0 && entry.height > 0);
  } catch (err) {
    return [];
  }
}

function normalizeOcclusionValue(entry){
  if (!entry) return null;
  const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
  const width = clamp01(entry.width);
  const height = clamp01(entry.height);
  if (width <= 0 || height <= 0) return null;
  const x = clamp01(entry.x);
  const y = clamp01(entry.y);
  const id = typeof entry.id === 'string' && entry.id ? entry.id : generateOcclusionId();
  return { id, x, y, width, height };
}

function encodeOcclusionValue(list){
  if (!Array.isArray(list) || !list.length) return '';
  const normalized = list.map(normalizeOcclusionValue).filter(Boolean);
  if (!normalized.length) return '';
  try {
    const json = JSON.stringify(normalized);
    return encodeURIComponent(json);
  } catch (err) {
    return '';
  }
}

function getImageOcclusionData(image){
  if (!(image instanceof HTMLImageElement)) return [];
  const attr = image.getAttribute(OCCLUSION_ATTR);
  return decodeOcclusionValue(attr);
}

function setImageOcclusionData(image, occlusions){
  if (!(image instanceof HTMLImageElement)) return;
  const encoded = encodeOcclusionValue(occlusions);
  if (encoded) image.setAttribute(OCCLUSION_ATTR, encoded);
  else image.removeAttribute(OCCLUSION_ATTR);
}

function ensureImageOcclusionWrapper(image){
  if (!(image instanceof HTMLImageElement)) return null;
  const parent = image.parentElement;
  if (!parent) return null;
  if (parent.classList?.contains(OCCLUSION_WRAPPER_CLASS)) {
    return parent;
  }
  const wrapper = document.createElement('span');
  wrapper.className = OCCLUSION_WRAPPER_CLASS;
  parent.insertBefore(wrapper, image);
  wrapper.appendChild(image);
  return wrapper;
}

function updateOcclusionRectPosition(rectEl, entry){
  if (!rectEl || !entry) return;
  const left = Math.min(1, Math.max(0, entry.x));
  const top = Math.min(1, Math.max(0, entry.y));
  const width = Math.min(1, Math.max(0, entry.width));
  const height = Math.min(1, Math.max(0, entry.height));
  rectEl.style.left = `${left * 100}%`;
  rectEl.style.top = `${top * 100}%`;
  rectEl.style.width = `${width * 100}%`;
  rectEl.style.height = `${height * 100}%`;
}

function teardownImageOcclusions(root){
  if (!root) return;
  const images = root instanceof HTMLImageElement ? [root] : root.querySelectorAll('img');
  images.forEach(image => {
    const controller = occlusionControllers.get(image);
    if (controller && typeof controller.destroy === 'function') {
      controller.destroy();
    }
    occlusionControllers.delete(image);
  });
}

function openImagePreview(image){
  if (!(image instanceof HTMLImageElement)) return;
  const src = image.currentSrc || image.src;
  if (!src) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'image-preview-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'image-preview-dialog';
  const preview = document.createElement('img');
  preview.src = src;
  preview.alt = image.getAttribute('alt') || '';
  dialog.appendChild(preview);
  backdrop.appendChild(dialog);
  const close = () => {
    teardownImageOcclusions(dialog);
    backdrop.classList.remove('is-visible');
    backdrop.addEventListener('transitionend', () => backdrop.remove(), { once: true });
    document.removeEventListener('keydown', onKeyDown, true);
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('is-visible'));
  enhanceImageOcclusions(dialog, { interactive: true, enableLightbox: false });
}

function createOcclusionController(image, options = {}){
  const wrapper = ensureImageOcclusionWrapper(image);
  if (!wrapper) return null;
  let currentOptions = {
    interactive: options.interactive !== false,
    enableLightbox: options.enableLightbox !== false,
    editing: options.editing === true
  };
  wrapper.classList.toggle('image-occlusion-wrapper--editing', currentOptions.editing);
  const layer = document.createElement('div');
  layer.className = OCCLUSION_LAYER_CLASS;
  wrapper.appendChild(layer);
  const state = new Map();
  const rectLookup = new Map();
  let disposed = false;
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => refresh())
    : null;
  if (resizeObserver) resizeObserver.observe(image);
  const mutationObserver = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(mutations => {
        if (!image.isConnected) {
          destroy();
          return;
        }
        for (const mut of mutations) {
          if (mut.type === 'attributes' && (mut.attributeName === OCCLUSION_ATTR || mut.attributeName === 'width' || mut.attributeName === 'height' || mut.attributeName === 'style' || mut.attributeName === 'src')) {
            refresh();
            break;
          }
        }
      })
    : null;
  if (mutationObserver) {
    mutationObserver.observe(image, { attributes: true });
  }

  const onRectClick = (event) => {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleRectState(event.currentTarget);
  };

  const onRectKey = (event) => {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleRectState(event.currentTarget);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const onRectDblClick = (event) => {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const dbl = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    image.dispatchEvent(dbl);
  };

  const onImageClick = (event) => {
    if (!currentOptions.enableLightbox) return;
    if (event.defaultPrevented) return;
    event.preventDefault();
    openImagePreview(image);
  };

  if (currentOptions.enableLightbox) {
    image.addEventListener('click', onImageClick);
  }

  function updateRectState(rect, stateValue){
    const id = rect.dataset.occlusionId;
    const next = stateValue === OCCLUSION_STATE_REVEALED ? OCCLUSION_STATE_REVEALED : OCCLUSION_STATE_HIDDEN;
    rect.dataset.state = next;
    rect.setAttribute('data-state', next);
    rect.setAttribute('aria-pressed', next === OCCLUSION_STATE_HIDDEN ? 'true' : 'false');
    rect.classList.toggle('is-hidden', next === OCCLUSION_STATE_HIDDEN);
    rect.classList.toggle('is-revealed', next === OCCLUSION_STATE_REVEALED);
    rect.setAttribute('title', next === OCCLUSION_STATE_HIDDEN ? 'Click to reveal' : 'Click to hide');
    if (id) state.set(id, next);
  }

  function toggleRectState(rect){
    const current = rect.dataset.state === OCCLUSION_STATE_REVEALED ? OCCLUSION_STATE_REVEALED : OCCLUSION_STATE_HIDDEN;
    const next = current === OCCLUSION_STATE_HIDDEN ? OCCLUSION_STATE_REVEALED : OCCLUSION_STATE_HIDDEN;
    updateRectState(rect, next);
  }

  function refresh(){
    if (disposed) return;
    if (!wrapper.isConnected || !image.isConnected) {
      destroy();
      return;
    }
    const occlusions = getImageOcclusionData(image);
    rectLookup.forEach((rect, id) => {
      if (!occlusions.find(entry => entry.id === id)) {
        rect.remove();
        rectLookup.delete(id);
      }
    });
    occlusions.forEach(entry => {
      let rect = rectLookup.get(entry.id);
      if (!rect) {
        rect = document.createElement('button');
        rect.type = 'button';
        rect.className = OCCLUSION_RECT_CLASS;
        rect.dataset.occlusionId = entry.id;
        rect.addEventListener('click', onRectClick);
        rect.addEventListener('keydown', onRectKey);
        rect.addEventListener('dblclick', onRectDblClick);
        layer.appendChild(rect);
        rectLookup.set(entry.id, rect);
      }
      updateOcclusionRectPosition(rect, entry);
      const savedState = state.get(entry.id) || OCCLUSION_STATE_HIDDEN;
      updateRectState(rect, savedState);
      rect.tabIndex = currentOptions.interactive ? 0 : -1;
      rect.setAttribute('aria-label', 'Image occlusion toggle');
    });
    layer.classList.toggle('is-empty', occlusions.length === 0);
    wrapper.classList.toggle('image-occlusion-wrapper--active', occlusions.length > 0);
  }

  function setOptions(nextOptions = {}){
    const prevLightbox = currentOptions.enableLightbox;
    currentOptions = {
      interactive: nextOptions.interactive !== false,
      enableLightbox: nextOptions.enableLightbox !== false,
      editing: nextOptions.editing === true
    };
    wrapper.classList.toggle('image-occlusion-wrapper--editing', currentOptions.editing);
    rectLookup.forEach(rect => {
      rect.tabIndex = currentOptions.interactive ? 0 : -1;
    });
    if (currentOptions.enableLightbox && !prevLightbox) {
      image.addEventListener('click', onImageClick);
    } else if (!currentOptions.enableLightbox && prevLightbox) {
      image.removeEventListener('click', onImageClick);
    }
  }

  function destroy(){
    if (disposed) return;
    disposed = true;
    rectLookup.forEach(rect => rect.remove());
    rectLookup.clear();
    if (layer.parentNode === wrapper) layer.remove();
    if (wrapper.parentNode) {
      wrapper.classList.remove('image-occlusion-wrapper--active', 'image-occlusion-wrapper--editing');
      wrapper.classList.remove(OCCLUSION_WRAPPER_CLASS);
      const parent = wrapper.parentNode;
      parent.insertBefore(image, wrapper);
      wrapper.remove();
    }
    image.removeEventListener('click', onImageClick);
    if (resizeObserver) resizeObserver.disconnect();
    if (mutationObserver) mutationObserver.disconnect();
  }

  refresh();

  return {
    refresh,
    setOptions,
    destroy,
    getOptions(){
      return { ...currentOptions };
    },
    layer,
    wrapper
  };
}

function ensureOcclusionController(image, options){
  if (!(image instanceof HTMLImageElement)) return null;
  let controller = occlusionControllers.get(image);
  if (!controller) {
    controller = createOcclusionController(image, options);
    if (controller) occlusionControllers.set(image, controller);
  } else {
    controller.setOptions(options);
    controller.refresh();
  }
  return controller;
}

function enhanceImageOcclusions(root, options = {}){
  if (!root) return;
  const images = root instanceof HTMLImageElement ? [root] : root.querySelectorAll('img');
  images.forEach(image => {
    ensureOcclusionController(image, options);
  });
}

function refreshImageOcclusion(image, options){
  const controller = ensureOcclusionController(image, options);
  if (controller) controller.refresh();
}

function createOcclusionEditorOverlay(image, { onChange, onClose } = {}){
  if (!(image instanceof HTMLImageElement)) return null;
  const editor = document.createElement('div');
  editor.className = 'image-occlusion-editor';
  const hint = document.createElement('div');
  hint.className = 'image-occlusion-editor__hint';
  hint.textContent = 'Drag to draw boxes. Click × to remove.';
  const canvas = document.createElement('div');
  canvas.className = 'image-occlusion-editor__canvas';
  const actions = document.createElement('div');
  actions.className = 'image-occlusion-editor__actions';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'image-occlusion-editor__clear';
  clearBtn.textContent = 'Clear all';
  actions.appendChild(clearBtn);
  editor.append(hint, canvas, actions);

  const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
  let occlusionDraft = [];
  let drawingState = null;

  function syncFromImage(){
    occlusionDraft = getImageOcclusionData(image).map(entry => ({ ...entry }));
    renderBoxes();
  }

  function renderBoxes(){
    canvas.innerHTML = '';
    occlusionDraft.forEach(entry => {
      const box = document.createElement('div');
      box.className = 'image-occlusion-editor__box';
      box.dataset.occlusionId = entry.id;
      updateOcclusionRectPosition(box, entry);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'image-occlusion-editor__remove';
      removeBtn.setAttribute('aria-label', 'Remove occlusion');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeEntry(entry.id);
      });
      box.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeEntry(entry.id);
      });
      box.appendChild(removeBtn);
      canvas.appendChild(box);
    });
  }

  function commit(){
    const normalized = occlusionDraft.map(normalizeOcclusionValue).filter(Boolean);
    occlusionDraft = normalized.map(entry => ({ ...entry }));
    if (typeof onChange === 'function') onChange(normalized);
    renderBoxes();
  }

  function removeEntry(id){
    const next = occlusionDraft.filter(entry => entry.id !== id);
    if (next.length === occlusionDraft.length) return;
    occlusionDraft = next;
    commit();
  }

  const MIN_DRAW_SIZE = 0.01;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const startX = clamp01((event.clientX - rect.left) / rect.width);
    const startY = clamp01((event.clientY - rect.top) / rect.height);
    const box = document.createElement('div');
    box.className = 'image-occlusion-editor__box is-creating';
    canvas.appendChild(box);
    drawingState = {
      id: generateOcclusionId(),
      pointerId: event.pointerId,
      startX,
      startY,
      currentX: startX,
      currentY: startY,
      box
    };
    updateOcclusionRectPosition(box, { x: startX, y: startY, width: 0, height: 0 });
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      // ignore if not supported
    }
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drawingState) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const currentX = clamp01((event.clientX - rect.left) / rect.width);
    const currentY = clamp01((event.clientY - rect.top) / rect.height);
    drawingState.currentX = currentX;
    drawingState.currentY = currentY;
    const x = Math.min(drawingState.startX, currentX);
    const y = Math.min(drawingState.startY, currentY);
    const width = Math.abs(currentX - drawingState.startX);
    const height = Math.abs(currentY - drawingState.startY);
    drawingState.entry = { id: drawingState.id, x, y, width, height };
    updateOcclusionRectPosition(drawingState.box, drawingState.entry);
    event.preventDefault();
  });

  const finishDrawing = () => {
    if (!drawingState) return;
    const { entry, box, pointerId } = drawingState;
    if (pointerId != null) {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch (err) {
        // ignore
      }
    }
    box.remove();
    if (entry && entry.width >= MIN_DRAW_SIZE && entry.height >= MIN_DRAW_SIZE) {
      const normalized = normalizeOcclusionValue(entry);
      if (normalized) {
        occlusionDraft = occlusionDraft.filter(item => item.id !== normalized.id);
        occlusionDraft.push(normalized);
        commit();
      }
    } else {
      renderBoxes();
    }
    drawingState = null;
  };

  canvas.addEventListener('pointerup', (event) => {
    if (event.button !== 0) return;
    finishDrawing();
    event.preventDefault();
  });

  canvas.addEventListener('pointercancel', () => {
    drawingState?.box?.remove();
    drawingState = null;
  });

  clearBtn.addEventListener('click', () => {
    if (!occlusionDraft.length) return;
    occlusionDraft = [];
    commit();
  });

  function open(){
    editor.classList.add('is-active');
    syncFromImage();
  }

  function close(){
    editor.classList.remove('is-active');
    if (typeof onClose === 'function') onClose();
  }

  function destroy(){
    close();
    editor.remove();
  }

  return {
    element: editor,
    open,
    close,
    destroy,
    sync: syncFromImage
  };
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
        setImageOcclusionData(targetImage, []);
        if (altText) {
          targetImage.setAttribute('alt', altText);
        } else {
          targetImage.removeAttribute('alt');
        }
        setImageSize(targetImage, width, height);
        refreshImageOcclusion(targetImage, editorOcclusionOptions);
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

  const editorOcclusionOptions = { interactive: true, enableLightbox: false, editing: true };
  enhanceImageOcclusions(editable, editorOcclusionOptions);
  const occlusionObserver = typeof MutationObserver !== 'undefined'
    ? new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const addedHasImage = Array.from(mutation.addedNodes || []).some(node => node instanceof HTMLImageElement || (node instanceof Element && node.querySelector && node.querySelector('img')));
          const removedHasImage = Array.from(mutation.removedNodes || []).some(node => node instanceof HTMLImageElement || (node instanceof Element && node.querySelector && node.querySelector('img')));
          if (addedHasImage || removedHasImage) {
            enhanceImageOcclusions(editable, editorOcclusionOptions);
            break;
          }
        }
      })
    : null;
  if (occlusionObserver) {
    occlusionObserver.observe(editable, { childList: true, subtree: true });
  }

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
    occlusionToggle.className = 'rich-editor-image-occlusion-toggle';
    occlusionToggle.setAttribute('aria-label', 'Edit image occlusion');
    occlusionToggle.textContent = '👁';
    occlusionToggle.dataset.active = 'false';
    occlusionToggle.setAttribute('aria-pressed', 'false');
    overlay.appendChild(occlusionToggle);

    let occlusionEditorInstance = null;
    let occlusionEditing = false;

    const ensureOcclusionEditorInstance = () => {
      if (!occlusionEditorInstance) {
        occlusionEditorInstance = createOcclusionEditorOverlay(image, {
          onChange: (occlusions) => {
            setImageOcclusionData(image, occlusions);
            triggerEditorChange();
            refreshImageOcclusion(image, { interactive: true, enableLightbox: false, editing: true });
          },
          onClose: () => {
            overlay.classList.remove('is-occlusion-editing');
            occlusionToggle.dataset.active = 'false';
            occlusionToggle.setAttribute('aria-pressed', 'false');
            occlusionEditing = false;
          }
        });
        if (occlusionEditorInstance?.element) {
          overlay.appendChild(occlusionEditorInstance.element);
        }
      }
      occlusionEditorInstance?.sync();
      return occlusionEditorInstance;
    };

    const openOcclusionEditor = () => {
      const instance = ensureOcclusionEditorInstance();
      if (!instance) return;
      overlay.classList.add('is-occlusion-editing');
      occlusionToggle.dataset.active = 'true';
      occlusionToggle.setAttribute('aria-pressed', 'true');
      occlusionEditing = true;
      instance.open();
    };

    const closeOcclusionEditor = () => {
      if (!occlusionEditorInstance) return;
      occlusionEditorInstance.close();
      overlay.classList.remove('is-occlusion-editing');
      occlusionToggle.dataset.active = 'false';
      occlusionToggle.setAttribute('aria-pressed', 'false');
      occlusionEditing = false;
    };

    occlusionToggle.addEventListener('click', () => {
      if (occlusionEditing) {
        closeOcclusionEditor();
      } else {
        openOcclusionEditor();
      }
    });

    const handleDefs = [
      { name: 'se', axis: 'both', label: 'Resize from corner' },
      { name: 'e', axis: 'x', label: 'Resize width' },
      { name: 's', axis: 'y', label: 'Resize height' }
    ];

    let resizeState = null;

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
    image.classList.add('rich-editor-image-active');
    refreshImageOcclusion(image, { interactive: true, enableLightbox: false, editing: true });

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
      refreshImageOcclusion(image, { interactive: true, enableLightbox: false, editing: true });
    };

    const onScroll = () => update();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        destroy();
      }
    };

    const handleOutside = (event) => {
      if (event.target === image) return;
      if (overlay.contains(event.target)) return;
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

    const destroy = () => {
      if (resizeObserver) resizeObserver.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      editable.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', update);
      document.removeEventListener('mousedown', handleOutside, true);
      document.removeEventListener('keydown', onKeyDown, true);
      stopResize();
      overlay.remove();
      image.classList.remove('rich-editor-image-active');
      if (pendingImageTarget === image) pendingImageTarget = null;
      if (occlusionEditorInstance) {
        occlusionEditorInstance.destroy();
        occlusionEditorInstance = null;
      }
      occlusionToggle.dataset.active = 'false';
      occlusionEditing = false;
    };

    cropBtn.addEventListener('click', async () => {
      try {
        if (occlusionEditing) closeOcclusionEditor();
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
      } catch (err) {
        console.error('Failed to edit image', err);
      }
    });

    replaceBtn.addEventListener('click', () => {
      if (occlusionEditing) closeOcclusionEditor();
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

    return {
      image,
      update,
      destroy
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
      teardownImageOcclusions(editable);
      editable.innerHTML = normalizeInput(val);
      enhanceImageOcclusions(editable, editorOcclusionOptions);
      settingValue = false;
      updateInlineState();
    },
    focus(){
      focusEditor();
    }
  };
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

function enhanceClozeContent(target, { clozeMode = 'static' } = {}){
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
      if (current !== CLOZE_STATE_REVEALED && current !== CLOZE_STATE_HIDDEN) {
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
    teardownImageOcclusions(target);
    target.textContent = '';
    target.classList.remove('rich-content');
    detachClozeHandlers(target);
    return;
  }
  target.classList.add('rich-content');
  teardownImageOcclusions(target);
  target.innerHTML = normalized;
  enhanceClozeContent(target, options);
  const occlusionInteractive = options?.occlusionInteractive !== false;
  const enableImagePreview = options?.enableImagePreview !== false;
  enhanceImageOcclusions(target, { interactive: occlusionInteractive, enableLightbox: enableImagePreview });
}

export function hasRichTextContent(value){
  return !isEmptyHtml(normalizeInput(value));
}

