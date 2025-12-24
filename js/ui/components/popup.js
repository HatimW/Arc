import { renderRichText } from './rich-text.js';
import { createFloatingWindow } from './window-manager.js';

const fieldDefs = {
  disease: [
    ['etiology','Etiology'],
    ['pathophys','Pathophys'],
    ['clinical','Clinical'],
    ['diagnosis','Diagnosis'],
    ['treatment','Treatment'],
    ['complications','Complications'],
    ['mnemonic','Mnemonic']
  ],
  drug: [
    ['class','Class'],
    ['source','Source'],
    ['moa','MOA'],
    ['uses','Uses'],
    ['sideEffects','Side Effects'],
    ['contraindications','Contraindications'],
    ['mnemonic','Mnemonic']
  ],
  concept: [
    ['type','Type'],
    ['definition','Definition'],
    ['mechanism','Mechanism'],
    ['clinicalRelevance','Clinical Relevance'],
    ['example','Example'],
    ['mnemonic','Mnemonic']
  ]
};

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectExtras(item) {
  if (Array.isArray(item.extras) && item.extras.length) return item.extras;
  if (item.facts && item.facts.length) {
    return [{
      id: 'legacy-facts',
      title: 'Highlights',
      body: `<ul>${item.facts.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
    }];
  }
  return [];
}

const FALLBACK_ACCENTS = {
  disease: '#c084fc',
  drug: '#60a5fa',
  concept: '#4ade80'
};

const DEFAULT_ACCENT = '#38bdf8';
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function resolveAccentColor(item) {
  if (item && typeof item.color === 'string' && HEX_COLOR.test(item.color.trim())) {
    return normalizeHex(item.color.trim());
  }
  const fallback = FALLBACK_ACCENTS[item?.kind];
  if (typeof fallback === 'string') {
    return normalizeHex(fallback);
  }
  return DEFAULT_ACCENT;
}

function normalizeHex(value) {
  if (typeof value !== 'string') return DEFAULT_ACCENT;
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed)) return DEFAULT_ACCENT;
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return trimmed.toUpperCase();
}

export function showPopup(item, options = {}) {
  const { onEdit, onColorChange, onLink } = options;
  const titleText = item?.name || item?.concept || 'Item';
  const accent = resolveAccentColor(item);
  const win = createFloatingWindow({ title: titleText, width: 560 });

  const card = document.createElement('div');
  card.className = 'card popup-card';
  card.style.borderTop = `4px solid ${accent}`;

  const header = document.createElement('div');
  header.className = 'popup-card-header';
  const title = document.createElement('h2');
  title.textContent = titleText;
  header.appendChild(title);
  card.appendChild(header);

  if (typeof onColorChange === 'function') {
    const meta = document.createElement('div');
    meta.className = 'popup-meta';
    const colorLabel = document.createElement('label');
    colorLabel.className = 'popup-color-control';
    const labelText = document.createElement('span');
    labelText.textContent = 'Accent';
    colorLabel.appendChild(labelText);
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = accent;
    colorLabel.appendChild(colorInput);
    const colorValue = document.createElement('span');
    colorValue.className = 'popup-color-value';
    colorValue.textContent = accent;
    colorLabel.appendChild(colorValue);
    meta.appendChild(colorLabel);
    card.appendChild(meta);

    let currentAccent = accent;

    const updateAccentPreview = (value, commit = false) => {
      const normalized = normalizeHex(value);
      card.style.borderTop = `4px solid ${normalized}`;
      colorValue.textContent = normalized;
      if (commit) {
        currentAccent = normalized;
      }
    };

    colorInput.addEventListener('input', () => {
      updateAccentPreview(colorInput.value);
    });

    colorInput.addEventListener('change', async () => {
      if (typeof onColorChange === 'function') {
        const next = normalizeHex(colorInput.value);
        updateAccentPreview(next);
        try {
          await onColorChange(next);
          updateAccentPreview(next, true);
        } catch (err) {
          console.error(err);
          updateAccentPreview(currentAccent, true);
          colorInput.value = currentAccent;
        }
      } else {
        updateAccentPreview(colorInput.value, true);
      }
    });
  }

  const defs = fieldDefs[item.kind] || [];
  defs.forEach(([field, label]) => {
    const val = item[field];
    if (!val) return;
    const sec = document.createElement('div');
    sec.className = 'section';
    const tl = document.createElement('div');
    tl.className = 'section-title';
    tl.textContent = label;
    sec.appendChild(tl);
    const txt = document.createElement('div');
    renderRichText(txt, val);
    sec.appendChild(txt);
    card.appendChild(sec);
  });

  const extras = collectExtras(item);
  extras.forEach(extra => {
    if (!extra || !extra.body) return;
    const sec = document.createElement('div');
    sec.className = 'section section--extra';
    const tl = document.createElement('div');
    tl.className = 'section-title';
    tl.textContent = extra.title || 'Additional Section';
    sec.appendChild(tl);
    const txt = document.createElement('div');
    renderRichText(txt, extra.body);
    sec.appendChild(txt);
    card.appendChild(sec);
  });

  const actions = document.createElement('div');
  actions.className = 'popup-actions';

  if (typeof onEdit === 'function') {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn secondary';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      void win.close('edit');
      onEdit();
    });
    actions.appendChild(editBtn);
  }

  if (typeof onLink === 'function') {
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'btn secondary';
    linkBtn.textContent = 'Link';
    linkBtn.addEventListener('click', () => {
      void win.close('link');
      onLink();
    });
    actions.appendChild(linkBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => {
    void win.close('close');
  });
  actions.appendChild(closeBtn);

  card.appendChild(actions);

  win.setContent(card);
  win.setTitle(titleText);
  return win;
}
