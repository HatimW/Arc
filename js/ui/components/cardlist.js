import { upsertItem, deleteItem } from '../../storage/storage.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { state, setEntryLayout, setFilters } from '../../state.js';
import { setToggleState } from '../../utils.js';
import { openEditor } from './editor.js';
import { confirmModal } from './confirm.js';
import { openLinker } from './linker.js';
import { renderRichText } from './rich-text.js';

const kindColors = { disease: 'var(--purple)', drug: 'var(--green)', concept: 'var(--blue)' };
const fieldDefs = {
  disease: [
    ['etiology','Etiology','🧬'],
    ['pathophys','Pathophys','⚙️'],
    ['clinical','Clinical','🩺'],
    ['diagnosis','Diagnosis','🔎'],
    ['treatment','Treatment','💊'],
    ['complications','Complications','⚠️'],
    ['mnemonic','Mnemonic','🧠']
  ],
  drug: [
    ['class','Class','🏷️'],
    ['source','Source','🌱'],
    ['moa','MOA','⚙️'],
    ['uses','Uses','💊'],
    ['sideEffects','Side Effects','⚠️'],
    ['contraindications','Contraindications','🚫'],
    ['mnemonic','Mnemonic','🧠']
  ],
  concept: [
    ['type','Type','🏷️'],
    ['definition','Definition','📖'],
    ['mechanism','Mechanism','⚙️'],
    ['clinicalRelevance','Clinical Relevance','🩺'],
    ['example','Example','📝'],
    ['mnemonic','Mnemonic','🧠']
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

function ensureExtras(item) {
  if (Array.isArray(item.extras) && item.extras.length) {
    return item.extras;
  }
  if (item.facts && item.facts.length) {
    return [{
      id: 'legacy-facts',
      title: 'Highlights',
      body: `<ul>${item.facts.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
    }];
  }
  return [];
}

const expanded = new Set();
const collapsedBlocks = new Set();
const collapsedWeeks = new Set();
let activeBlockKey = null;

export function createItemCard(item, onChange){
  const card = document.createElement('div');
  card.className = `item-card card--${item.kind}`;
  const color = item.color || kindColors[item.kind] || 'var(--gray)';
  card.style.borderTop = `3px solid ${color}`;

  const header = document.createElement('div');
  header.className = 'card-header';

  const mainBtn = document.createElement('button');
  mainBtn.className = 'card-title-btn';
  mainBtn.textContent = item.name || item.concept || 'Untitled';
  mainBtn.setAttribute('aria-expanded', expanded.has(item.id));
  mainBtn.addEventListener('click', () => {
    if (expanded.has(item.id)) expanded.delete(item.id); else expanded.add(item.id);
    card.classList.toggle('expanded');
    mainBtn.setAttribute('aria-expanded', expanded.has(item.id));
  });
  header.appendChild(mainBtn);

  const settings = document.createElement('div');
  settings.className = 'card-settings';
  const menu = document.createElement('div');
  menu.className = 'card-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-hidden', 'true');
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'icon-btn card-settings-toggle';
  gear.title = 'Entry options';
  gear.setAttribute('aria-haspopup', 'true');
  gear.setAttribute('aria-expanded', 'false');
  gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.6"/></svg>';
  settings.append(gear, menu);
  header.appendChild(settings);

  function closeMenu() {
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    settings.classList.remove('open');
    gear.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', handleOutside);
  }

  function openMenu() {
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    settings.classList.add('open');
    gear.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', handleOutside);
  }

  function handleOutside(e) {
    if (!settings.contains(e.target)) {
      closeMenu();
    }
  }

  gear.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu(); else closeMenu();
  });

  menu.addEventListener('click', e => e.stopPropagation());

  const fav = document.createElement('button');
  fav.className = 'icon-btn';
  fav.textContent = item.favorite ? '★' : '☆';
  fav.title = 'Toggle Favorite';
  fav.setAttribute('aria-label','Toggle Favorite');
  fav.addEventListener('click', async e => {
    e.stopPropagation();
    closeMenu();
    item.favorite = !item.favorite;
    await upsertItem(item);
    fav.textContent = item.favorite ? '★' : '☆';
    onChange && onChange();
  });
  menu.appendChild(fav);

  const link = document.createElement('button');
  link.className = 'icon-btn';
  link.textContent = '🪢';
  link.title = 'Links';
  link.setAttribute('aria-label','Manage links');
  link.addEventListener('click', e => {
    e.stopPropagation();
    closeMenu();
    openLinker(item, onChange);
  });
  menu.appendChild(link);

  const edit = document.createElement('button');
  edit.className = 'icon-btn';
  edit.textContent = '✏️';
  edit.title = 'Edit';
  edit.setAttribute('aria-label','Edit');
  edit.addEventListener('click', e => {
    e.stopPropagation();
    closeMenu();
    openEditor(item.kind, onChange, item);
  });
  menu.appendChild(edit);

  const copy = document.createElement('button');
  copy.className = 'icon-btn';
  copy.textContent = '📋';
  copy.title = 'Copy Title';
  copy.setAttribute('aria-label','Copy Title');
  copy.addEventListener('click', e => {
    e.stopPropagation();
    closeMenu();
    navigator.clipboard && navigator.clipboard.writeText(item.name || item.concept || '');
  });
  menu.appendChild(copy);

  const del = document.createElement('button');
  del.className = 'icon-btn danger';
  del.textContent = '🗑️';
  del.title = 'Delete';
  del.setAttribute('aria-label','Delete');
  del.addEventListener('click', async e => {
    e.stopPropagation();
    closeMenu();
    if (await confirmModal('Delete this item?')) {
      await deleteItem(item.id);
      onChange && onChange();
    }
  });
  menu.appendChild(del);

  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'card-body';
  card.appendChild(body);

  function renderBody(){
    body.innerHTML = '';
    const identifiers = document.createElement('div');
    identifiers.className = 'identifiers';
    (item.blocks || []).forEach(b => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = b;
      identifiers.appendChild(chip);
    });
    (item.weeks || []).forEach(w => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = 'W' + w;
      identifiers.appendChild(chip);
    });
    if (item.lectures) {
      item.lectures.forEach(l => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = '📚 ' + (l.name || l.id);
        identifiers.appendChild(chip);
      });
    }
    body.appendChild(identifiers);

    const defs = fieldDefs[item.kind] || [];
    defs.forEach(([f,label,icon]) => {
      if (!item[f]) return;
      const sec = document.createElement('div');
      sec.className = 'section';
      sec.style.borderLeftColor = color;
      const tl = document.createElement('div');
      tl.className = 'section-title';
      tl.textContent = label;
      if (icon) tl.prepend(icon + ' ');
      sec.appendChild(tl);
      const txt = document.createElement('div');
      txt.className = 'section-content';
      renderRichText(txt, item[f]);
      sec.appendChild(txt);
      body.appendChild(sec);
    });
    const extras = ensureExtras(item);
    extras.forEach(extra => {
      if (!extra || !extra.body) return;
      const sec = document.createElement('div');
      sec.className = 'section section--extra';
      const tl = document.createElement('div');
      tl.className = 'section-title';
      tl.textContent = extra.title || 'Additional Section';
      sec.appendChild(tl);
      const txt = document.createElement('div');
      txt.className = 'section-content';
      renderRichText(txt, extra.body);
      sec.appendChild(txt);
      body.appendChild(sec);
    });

    if (item.links && item.links.length) {
      const lc = document.createElement('span');
      lc.className = 'chip link-chip';
      lc.textContent = `🪢 ${item.links.length}`;
      body.appendChild(lc);
    }
  }

  renderBody();
  if (expanded.has(item.id)) card.classList.add('expanded');

  function fit(){
    const headerH = header.offsetHeight;
    const maxH = card.clientHeight - headerH - 4;
    let size = parseFloat(getComputedStyle(body).fontSize);
    while(body.scrollHeight > maxH && size > 12){
      size -= 1;
      body.style.fontSize = size + 'px';
    }
  }
  requestAnimationFrame(fit);
  return card;
}

export async function renderCardList(container, itemSource, kind, onChange){
  container.innerHTML = '';
  const items = [];
  if (itemSource) {
    if (typeof itemSource?.[Symbol.asyncIterator] === 'function') {
      for await (const batch of itemSource) {
        if (Array.isArray(batch)) {
          items.push(...batch);
        } else if (batch) {
          items.push(batch);
        }
      }
    } else if (typeof itemSource?.toArray === 'function') {
      const collected = await itemSource.toArray();
      items.push(...collected);
    } else if (Array.isArray(itemSource)) {
      items.push(...itemSource);
    }
  }
  const { blocks } = await loadBlockCatalog();
  const blockTitle = id => blocks.find(b => b.blockId === id)?.title || id;
  const orderMap = new Map(blocks.map((b,i)=>[b.blockId,i]));
  const groups = new Map();
  items.forEach(it => {
    let block = '_';
    let week = '_';
    if (it.lectures && it.lectures.length) {
      let bestOrd = Infinity, bestWeek = -Infinity, bestLec = -Infinity;
      it.lectures.forEach(l => {
        const ord = orderMap.has(l.blockId) ? orderMap.get(l.blockId) : Infinity;
        if (
          ord < bestOrd ||
          (ord === bestOrd && (l.week > bestWeek || (l.week === bestWeek && l.id > bestLec)))
        ) {
          block = l.blockId;
          week = l.week;
          bestOrd = ord;
          bestWeek = l.week;
          bestLec = l.id;
        }
      });
    } else {
      let bestOrd = Infinity;
      (it.blocks || []).forEach(id => {
        const ord = orderMap.has(id) ? orderMap.get(id) : Infinity;
        if (ord < bestOrd) { block = id; bestOrd = ord; }
      });
      if (it.weeks && it.weeks.length) week = Math.max(...it.weeks);
    }
    if (!groups.has(block)) groups.set(block, new Map());
    const wkMap = groups.get(block);
    const arr = wkMap.get(week) || [];
    arr.push(it);
    wkMap.set(week, arr);
  });
  const sortedBlocks = Array.from(groups.keys()).sort((a,b)=>{
    const ao = orderMap.has(a) ? orderMap.get(a) : Infinity;
    const bo = orderMap.has(b) ? orderMap.get(b) : Infinity;
    return ao - bo;
  });
  const layoutState = state.entryLayout;

  const toolbar = document.createElement('div');
  toolbar.className = 'entry-layout-toolbar';

  const rawSort = state.filters?.sort;
  const sortOptions = ['updated', 'created', 'lecture', 'name'];
  let currentSortField = 'updated';
  let currentSortDirection = 'desc';
  if (typeof rawSort === 'string' && rawSort) {
    const parts = rawSort.split('-');
    if (parts.length === 1) {
      currentSortField = sortOptions.includes(parts[0]) ? parts[0] : 'updated';
    } else {
      const [fieldPart, dirPart] = parts;
      currentSortField = sortOptions.includes(fieldPart) ? fieldPart : 'updated';
      currentSortDirection = dirPart === 'asc' ? 'asc' : 'desc';
    }
  } else if (rawSort && typeof rawSort === 'object') {
    const mode = rawSort.mode;
    const dir = rawSort.direction;
    if (typeof mode === 'string' && sortOptions.includes(mode)) {
      currentSortField = mode;
    }
    if (dir === 'asc' || dir === 'desc') {
      currentSortDirection = dir;
    }
  }

  const sortControls = document.createElement('div');
  sortControls.className = 'sort-controls';

  const sortLabel = document.createElement('label');
  sortLabel.className = 'sort-select';
  sortLabel.textContent = 'Sort by';

  const sortSelect = document.createElement('select');
  sortSelect.className = 'sort-field';
  sortSelect.setAttribute('aria-label', 'Sort entries');
  [
    { value: 'updated', label: 'Date Modified' },
    { value: 'created', label: 'Date Added' },
    { value: 'lecture', label: 'Lecture Added' },
    { value: 'name', label: 'Alphabetical' }
  ].forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    sortSelect.appendChild(option);
  });
  sortSelect.value = currentSortField;
  sortLabel.appendChild(sortSelect);
  sortControls.appendChild(sortLabel);

  const directionBtn = document.createElement('button');
  directionBtn.type = 'button';
  directionBtn.className = 'sort-direction-btn';
  directionBtn.setAttribute('aria-label', 'Toggle sort direction');
  directionBtn.setAttribute('title', 'Toggle sort direction');

  function updateDirectionButton() {
    directionBtn.dataset.direction = currentSortDirection;
    directionBtn.textContent = currentSortDirection === 'asc' ? '↑ Asc' : '↓ Desc';
  }

  function applySortChange() {
    const nextValue = `${currentSortField}-${currentSortDirection}`;
    if (state.filters.sort === nextValue) return;
    setFilters({ sort: nextValue });
    onChange && onChange();
  }

  updateDirectionButton();

  sortSelect.addEventListener('change', () => {
    const selected = sortSelect.value;
    currentSortField = sortOptions.includes(selected) ? selected : 'updated';
    applySortChange();
  });

  directionBtn.addEventListener('click', () => {
    currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    updateDirectionButton();
    applySortChange();
  });

  sortControls.appendChild(directionBtn);
  toolbar.appendChild(sortControls);

  const viewToggle = document.createElement('div');
  viewToggle.className = 'layout-toggle';

  const listBtn = document.createElement('button');
  listBtn.type = 'button';
  listBtn.className = 'layout-btn';
  setToggleState(listBtn, layoutState.mode === 'list');
  listBtn.textContent = 'List';
  listBtn.addEventListener('click', () => {
    if (layoutState.mode === 'list') return;
    setEntryLayout({ mode: 'list' });
    updateToolbar();
    applyLayout();
  });

  const gridBtn = document.createElement('button');
  gridBtn.type = 'button';
  gridBtn.className = 'layout-btn';
  setToggleState(gridBtn, layoutState.mode === 'grid');
  gridBtn.textContent = 'Grid';
  gridBtn.addEventListener('click', () => {
    if (layoutState.mode === 'grid') return;
    setEntryLayout({ mode: 'grid' });
    updateToolbar();
    applyLayout();
  });

  viewToggle.appendChild(listBtn);
  viewToggle.appendChild(gridBtn);
  toolbar.appendChild(viewToggle);

  const controlsToggle = document.createElement('button');
  controlsToggle.type = 'button';
  controlsToggle.className = 'layout-advanced-toggle';
  setToggleState(controlsToggle, layoutState.controlsVisible);
  controlsToggle.addEventListener('click', () => {
    setEntryLayout({ controlsVisible: !state.entryLayout.controlsVisible });
    updateToolbar();
  });
  toolbar.appendChild(controlsToggle);

  const controlsWrap = document.createElement('div');
  controlsWrap.className = 'layout-controls';
  const controlsId = `layout-controls-${Math.random().toString(36).slice(2, 8)}`;
  controlsWrap.id = controlsId;
  controlsToggle.setAttribute('aria-controls', controlsId);
  toolbar.appendChild(controlsWrap);

  const columnWrap = document.createElement('label');
  columnWrap.className = 'layout-control';
  columnWrap.textContent = 'Columns';
  const columnInput = document.createElement('input');
  columnInput.type = 'range';
  columnInput.min = '1';
  columnInput.max = '6';
  columnInput.step = '1';
  columnInput.value = String(layoutState.columns);
  const columnValue = document.createElement('span');
  columnValue.className = 'layout-value';
  columnValue.textContent = String(layoutState.columns);
  columnInput.addEventListener('input', () => {
    setEntryLayout({ columns: Number(columnInput.value) });
    columnValue.textContent = String(state.entryLayout.columns);
    applyLayout();
  });
  columnWrap.appendChild(columnInput);
  columnWrap.appendChild(columnValue);
  controlsWrap.appendChild(columnWrap);

  const scaleWrap = document.createElement('label');
  scaleWrap.className = 'layout-control';
  scaleWrap.textContent = 'Scale';
  const scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = '0.6';
  scaleInput.max = '1.4';
  scaleInput.step = '0.05';
  scaleInput.value = String(layoutState.scale);
  const scaleValue = document.createElement('span');
  scaleValue.className = 'layout-value';
  scaleValue.textContent = `${layoutState.scale.toFixed(2)}x`;
  scaleInput.addEventListener('input', () => {
    setEntryLayout({ scale: Number(scaleInput.value) });
    scaleValue.textContent = `${state.entryLayout.scale.toFixed(2)}x`;
    applyLayout();
  });
  scaleWrap.appendChild(scaleInput);
  scaleWrap.appendChild(scaleValue);
  controlsWrap.appendChild(scaleWrap);

  container.appendChild(toolbar);

  function updateToolbar(){
    const { mode, controlsVisible } = state.entryLayout;
    setToggleState(listBtn, mode === 'list');
    setToggleState(gridBtn, mode === 'grid');
    columnWrap.style.display = mode === 'grid' ? '' : 'none';
    controlsWrap.style.display = controlsVisible ? '' : 'none';
    controlsWrap.setAttribute('aria-hidden', controlsVisible ? 'false' : 'true');
    controlsToggle.textContent = controlsVisible ? 'Hide layout tools' : 'Show layout tools';
    controlsToggle.setAttribute('aria-expanded', controlsVisible ? 'true' : 'false');
    setToggleState(controlsToggle, controlsVisible);
  }

  function applyLayout(){
    const lists = container.querySelectorAll('.card-list');
    lists.forEach(list => {
      list.classList.toggle('grid-layout', state.entryLayout.mode === 'grid');
      list.style.setProperty('--entry-scale', state.entryLayout.scale);
      list.style.setProperty('--entry-columns', state.entryLayout.columns);
    });
  }

  updateToolbar();

  const blockKeys = sortedBlocks.map(b => String(b));
  function applyBlockActivation(nextKey) {
    const candidate = nextKey && blockKeys.includes(nextKey) ? nextKey : null;
    activeBlockKey = candidate;
    collapsedBlocks.clear();
    if (!activeBlockKey) {
      blockKeys.forEach(key => collapsedBlocks.add(key));
    } else {
      blockKeys.forEach(key => {
        if (key !== activeBlockKey) {
          collapsedBlocks.add(key);
        }
      });
    }
  }

  if (blockKeys.length) {
    const initial = activeBlockKey && blockKeys.includes(activeBlockKey) ? activeBlockKey : blockKeys[0];
    applyBlockActivation(initial);
  } else {
    applyBlockActivation(null);
  }

  const blockUpdaters = new Map();
  const refreshBlocks = () => {
    blockUpdaters.forEach(fn => fn());
  };

  sortedBlocks.forEach(b => {
    const blockSec = document.createElement('section');
    blockSec.className = 'block-section';
    const blockHeader = document.createElement('button');
    blockHeader.type = 'button';
    blockHeader.className = 'block-header';
    const blockLabel = b === '_' ? 'Unassigned' : blockTitle(b);
    const blockKey = String(b);
    const bdef = blocks.find(bl => bl.blockId === b);
    if (bdef?.color) blockHeader.style.background = bdef.color;
    function updateBlockState(){
      const isCollapsed = collapsedBlocks.has(blockKey);
      blockSec.classList.toggle('collapsed', isCollapsed);
      blockHeader.textContent = `${isCollapsed ? '▸' : '▾'} ${blockLabel}`;
      blockHeader.setAttribute('aria-expanded', String(!isCollapsed));
    }
    blockUpdaters.set(blockKey, updateBlockState);
    updateBlockState();
    blockHeader.addEventListener('click', () => {
      const isCollapsed = collapsedBlocks.has(blockKey);
      if (isCollapsed) {
        applyBlockActivation(blockKey);
      } else if (activeBlockKey === blockKey) {
        applyBlockActivation(null);
      } else {
        collapsedBlocks.add(blockKey);
      }
      refreshBlocks();
    });
    blockSec.appendChild(blockHeader);
    const wkMap = groups.get(b);
    const sortedWeeks = Array.from(wkMap.keys()).sort((a,b)=>{
      if (a === '_' && b !== '_') return 1;
      if (b === '_' && a !== '_') return -1;
      return Number(b) - Number(a);
    });
    sortedWeeks.forEach(w => {
      const weekSec = document.createElement('div');
      weekSec.className = 'week-section';
      const weekHeader = document.createElement('button');
      weekHeader.type = 'button';
      weekHeader.className = 'week-header';
      const weekLabel = w === '_' ? 'Unassigned' : `Week ${w}`;
      const weekKey = `${blockKey}__${w}`;
      function updateWeekState(){
        const isCollapsed = collapsedWeeks.has(weekKey);
        weekSec.classList.toggle('collapsed', isCollapsed);
        weekHeader.textContent = `${isCollapsed ? '▸' : '▾'} ${weekLabel}`;
        weekHeader.setAttribute('aria-expanded', String(!isCollapsed));
      }
      updateWeekState();
      weekHeader.addEventListener('click', () => {
        if (collapsedWeeks.has(weekKey)) collapsedWeeks.delete(weekKey); else collapsedWeeks.add(weekKey);
        updateWeekState();
      });
      weekSec.appendChild(weekHeader);
      const list = document.createElement('div');
      list.className = 'card-list';
      list.style.setProperty('--entry-scale', state.entryLayout.scale);
      list.style.setProperty('--entry-columns', state.entryLayout.columns);
      list.classList.toggle('grid-layout', state.entryLayout.mode === 'grid');
      const rows = wkMap.get(w);
      function renderChunk(start=0){
        const slice = rows.slice(start,start+200);
        slice.forEach(it=>{ list.appendChild(createItemCard(it,onChange)); });
        if (start+200 < rows.length) requestAnimationFrame(()=>renderChunk(start+200));
      }
      renderChunk();
      weekSec.appendChild(list);
      blockSec.appendChild(weekSec);
    });
    container.appendChild(blockSec);
  });

  applyLayout();
}
