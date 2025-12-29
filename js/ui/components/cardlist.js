import { upsertItem, deleteItem } from '../../storage/storage.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { state, setEntryLayout, setFilters } from '../../state.js';
import { resolveLatestBlockId, setToggleState } from '../../utils.js';
import { openEditor } from './editor.js';
import { confirmModal } from './confirm.js';
import { openLinker } from './linker.js';
import { renderRichText } from './rich-text.js';
import { reportListComplexity, getPerformanceMode } from '../performance.js';

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
  let bodyRendered = false;

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

  function ensureBodyRendered() {
    if (bodyRendered) return;
    renderBody();
    bodyRendered = true;
  }

  if (expanded.has(item.id)) {
    ensureBodyRendered();
    card.classList.add('expanded');
  }

  mainBtn.addEventListener('click', () => {
    const isExpanded = expanded.has(item.id);
    if (isExpanded) {
      expanded.delete(item.id);
    } else {
      expanded.add(item.id);
      ensureBodyRendered();
    }
    card.classList.toggle('expanded', !isExpanded);
    mainBtn.setAttribute('aria-expanded', String(!isExpanded));
  });
  return card;
}

export async function renderCardList(container, itemSource, kind, onChange){
  container.innerHTML = '';
  collapsedBlocks.clear();
  collapsedWeeks.clear();
  activeBlockKey = null;
  const { blocks } = await loadBlockCatalog();
  const normalizedBlocks = Array.isArray(blocks)
    ? blocks.filter(block => block && typeof block === 'object')
    : [];
  const blockIds = new Set(normalizedBlocks.map(block => block?.blockId).filter(Boolean));
  const latestBlockId = resolveLatestBlockId(normalizedBlocks);
  const blockTitleMap = new Map(
    normalizedBlocks.map(block => [block.blockId, block.title || block.blockId])
  );
  const blockTitle = id => blockTitleMap.get(id) || id;
  const orderMap = new Map(normalizedBlocks.map((b,i)=>[b.blockId,i]));
  const blockWeekMap = new Map();
  const allWeeks = new Set();
  normalizedBlocks.forEach(block => {
    if (!block) return;
    const weeks = new Set();
    if (Number.isFinite(block.weeks)) {
      for (let i = 1; i <= block.weeks; i++) weeks.add(i);
    }
    (block.lectures || []).forEach(lecture => {
      if (typeof lecture.week === 'number') weeks.add(lecture.week);
    });
    const sortedWeeks = Array.from(weeks).sort((a, b) => a - b);
    blockWeekMap.set(block.blockId, sortedWeeks);
    sortedWeeks.forEach(weekNumber => allWeeks.add(weekNumber));
  });
  const sortedAllWeeks = Array.from(allWeeks).sort((a, b) => a - b);
  const groups = new Map();
  const currentBlockFilter = typeof state.filters?.block === 'string' ? state.filters.block : '';
  const currentWeekFilter = state.filters?.week ?? '';
  const hasBlockFilter = Boolean(currentBlockFilter);
  const isBlockValid = !hasBlockFilter || currentBlockFilter === '__unlabeled' || blockIds.has(currentBlockFilter);
  let requestedWeek = null;
  if (currentWeekFilter !== '' && currentWeekFilter != null) {
    const parsed = Number(currentWeekFilter);
    if (!Number.isNaN(parsed)) requestedWeek = parsed;
  }
  let shouldResetFilters = false;
  const nextFilterPatch = {};
  if (!isBlockValid) {
    nextFilterPatch.block = '';
    nextFilterPatch.week = '';
    shouldResetFilters = true;
  } else if (requestedWeek != null) {
    const allowedWeeks = currentBlockFilter && currentBlockFilter !== '__unlabeled' && blockWeekMap.has(currentBlockFilter)
      ? blockWeekMap.get(currentBlockFilter)
      : sortedAllWeeks;
    if (!allowedWeeks.includes(requestedWeek)) {
      nextFilterPatch.week = '';
      shouldResetFilters = true;
    }
  }
  if (shouldResetFilters) {
    setFilters(nextFilterPatch);
    if (typeof onChange === 'function') {
      onChange();
      return;
    }
  }

  let totalItems = 0;

  function addItem(it) {
    if (!it) return;
    totalItems += 1;
    let block = '_';
    let week = '_';
    if (Array.isArray(it.lectures) && it.lectures.length) {
      let bestOrd = Infinity;
      let bestWeek = -Infinity;
      let bestLec = -Infinity;
      it.lectures.forEach(l => {
        if (!l) return;
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
      (Array.isArray(it.blocks) ? it.blocks : []).forEach(id => {
        const ord = orderMap.has(id) ? orderMap.get(id) : Infinity;
        if (ord < bestOrd) {
          block = id;
          bestOrd = ord;
        }
      });
      if (Array.isArray(it.weeks) && it.weeks.length) {
        week = Math.max(...it.weeks);
      }
    }
    if (!groups.has(block)) {
      groups.set(block, new Map());
    }
    const wkMap = groups.get(block);
    const current = wkMap.get(week) || [];
    current.push(it);
    wkMap.set(week, current);
  }

  if (itemSource) {
    if (typeof itemSource?.toArray === 'function') {
      const collected = await itemSource.toArray();
      collected.forEach(addItem);
    } else if (typeof itemSource?.[Symbol.asyncIterator] === 'function') {
      for await (const batch of itemSource) {
        if (Array.isArray(batch)) {
          batch.forEach(addItem);
        } else if (batch) {
          addItem(batch);
        }
      }
    } else if (Array.isArray(itemSource)) {
      itemSource.forEach(addItem);
    }
  }

  const sortedBlocks = Array.from(groups.keys()).sort((a,b)=>{
    const ao = orderMap.has(a) ? orderMap.get(a) : Infinity;
    const bo = orderMap.has(b) ? orderMap.get(b) : Infinity;
    return ao - bo;
  });
  reportListComplexity('cardlist', { items: totalItems, columns: state.entryLayout?.columns || 1 });
  const perfMode = getPerformanceMode();
  const LIST_CHUNK_SIZE = perfMode === 'conservative' ? 48 : perfMode === 'balanced' ? 120 : 200;
  const layoutState = state.entryLayout;
  const scheduleChunk = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
    ? (cb) => window.requestIdleCallback(() => cb(), { timeout: 120 })
    : (cb) => requestAnimationFrame(cb);

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

  const filterGroup = document.createElement('div');
  filterGroup.className = 'entry-toolbar-group entry-toolbar-filters';

  const filterControls = document.createElement('div');
  filterControls.className = 'entry-filter-controls';

  const blockFilterLabel = document.createElement('label');
  blockFilterLabel.className = 'entry-filter-select';
  blockFilterLabel.textContent = 'Block';
  const blockFilterSelect = document.createElement('select');
  blockFilterSelect.className = 'entry-filter-block';
  blockFilterSelect.setAttribute('aria-label', 'Filter entries by block');
  const blockOptions = [
    { value: '', label: 'All blocks' },
    { value: '__unlabeled', label: 'Unlabeled' }
  ];
  normalizedBlocks.forEach(block => {
    if (!block) return;
    blockOptions.push({ value: block.blockId, label: blockTitle(block.blockId) });
  });
  blockOptions.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    blockFilterSelect.appendChild(option);
  });
  if (blockOptions.some(opt => opt.value === currentBlockFilter)) {
    blockFilterSelect.value = currentBlockFilter;
  } else {
    blockFilterSelect.value = '';
  }
  blockFilterLabel.appendChild(blockFilterSelect);
  filterControls.appendChild(blockFilterLabel);

  const weekFilterLabel = document.createElement('label');
  weekFilterLabel.className = 'entry-filter-select';
  weekFilterLabel.textContent = 'Week';
  const weekFilterSelect = document.createElement('select');
  weekFilterSelect.className = 'entry-filter-week';
  weekFilterSelect.setAttribute('aria-label', 'Filter entries by week');
  weekFilterLabel.appendChild(weekFilterSelect);
  filterControls.appendChild(weekFilterLabel);

  function populateWeekFilter() {
    const selectedBlock = blockFilterSelect.value;
    weekFilterSelect.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'All weeks';
    weekFilterSelect.appendChild(defaultOption);
    if (selectedBlock === '__unlabeled') {
      weekFilterSelect.disabled = true;
      return;
    }
    weekFilterSelect.disabled = false;
    const weeks = selectedBlock && blockWeekMap.has(selectedBlock)
      ? blockWeekMap.get(selectedBlock)
      : sortedAllWeeks;
    if (!weeks.length) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = selectedBlock ? 'No weeks available' : 'No weeks defined';
      none.disabled = true;
      weekFilterSelect.appendChild(none);
      return;
    }
    weeks.forEach(weekNumber => {
      const option = document.createElement('option');
      option.value = String(weekNumber);
      option.textContent = `Week ${weekNumber}`;
      weekFilterSelect.appendChild(option);
    });
  }

  filterGroup.appendChild(filterControls);
  toolbar.appendChild(filterGroup);
  populateWeekFilter();
  const normalizedWeekFilter = currentWeekFilter === '' || currentWeekFilter == null
    ? ''
    : String(currentWeekFilter);
  if (normalizedWeekFilter && weekFilterSelect.querySelector(`option[value="${normalizedWeekFilter}"]`)) {
    weekFilterSelect.value = normalizedWeekFilter;
  } else {
    weekFilterSelect.value = '';
  }

  blockFilterSelect.addEventListener('change', () => {
    populateWeekFilter();
    weekFilterSelect.value = '';
    const nextBlock = blockFilterSelect.value || '';
    const patch = { block: nextBlock, week: '' };
    const currentBlockValue = state.filters.block || '';
    const currentWeekValue = state.filters.week || '';
    if (currentBlockValue !== patch.block || currentWeekValue !== patch.week) {
      setFilters(patch);
      onChange && onChange();
    }
  });

  weekFilterSelect.addEventListener('change', () => {
    if (weekFilterSelect.disabled) return;
    const raw = weekFilterSelect.value;
    const normalized = raw ? Number(raw) : '';
    if (normalized !== '' && !Number.isFinite(normalized)) return;
    const currentValue = state.filters.week ?? '';
    const normalizedCurrent = currentValue === '' ? '' : Number(currentValue);
    if (normalized === '' && currentValue === '') return;
    if (normalized !== '' && String(normalizedCurrent) === String(normalized)) return;
    setFilters({ week: normalized });
    onChange && onChange();
  });

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
  sortControls.classList.add('entry-toolbar-group');
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
  viewToggle.classList.add('entry-toolbar-group');
  toolbar.appendChild(viewToggle);

  const controlsToggle = document.createElement('button');
  controlsToggle.type = 'button';
  controlsToggle.className = 'layout-advanced-toggle';
  setToggleState(controlsToggle, layoutState.controlsVisible);
  controlsToggle.addEventListener('click', () => {
    setEntryLayout({ controlsVisible: !state.entryLayout.controlsVisible });
    updateToolbar();
  });
  controlsToggle.classList.add('entry-toolbar-group');
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

  if (!totalItems) {
    const empty = document.createElement('div');
    empty.className = 'cards-empty entry-empty';
    const title = document.createElement('h3');
    const hasFilters = Boolean(state.query || state.filters.block || state.filters.week || state.filters.onlyFav);
    title.textContent = hasFilters ? 'No entries match your filters' : 'No entries yet';
    empty.appendChild(title);
    const desc = document.createElement('p');
    desc.textContent = hasFilters
      ? 'Try clearing your filters or adjust them to see your entries.'
      : 'Add your first entry to start building your list.';
    empty.appendChild(desc);
    if (hasFilters) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn secondary';
      clear.textContent = 'Clear filters';
      clear.addEventListener('click', () => {
        setFilters({ block: '', week: '', onlyFav: false });
        onChange && onChange();
      });
      empty.appendChild(clear);
    }
    container.appendChild(empty);
    return;
  }

  const blockKeys = sortedBlocks.map(b => String(b));
  let showAllBlocks = false;
  function applyBlockActivation(nextKey, { mode = 'single' } = {}) {
    const candidate = nextKey && blockKeys.includes(nextKey) ? nextKey : null;
    activeBlockKey = mode === 'single' ? candidate : null;
    showAllBlocks = mode === 'all';
    collapsedBlocks.clear();
    if (showAllBlocks) {
      return;
    }
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
    const preferred = latestBlockId && blockKeys.includes(String(latestBlockId))
      ? String(latestBlockId)
      : null;
    const initial = preferred
      || (activeBlockKey && blockKeys.includes(activeBlockKey) ? activeBlockKey : null)
      || blockKeys[0];
    if (!currentBlockFilter && !currentWeekFilter) {
      applyBlockActivation(null, { mode: 'all' });
    } else {
      applyBlockActivation(initial);
    }
  } else {
    applyBlockActivation(null, { mode: 'all' });
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
    const bdef = normalizedBlocks.find(bl => bl.blockId === b);
    if (bdef?.color) blockHeader.style.background = bdef.color;
    const weekEntries = [];
    const ensureVisibleWeeks = () => {
      if (collapsedBlocks.has(blockKey)) return;
      weekEntries.forEach(entry => {
        if (!collapsedWeeks.has(entry.weekKey)) entry.ensureListRendered();
      });
    };
    function updateBlockState(){
      const isCollapsed = collapsedBlocks.has(blockKey);
      blockSec.classList.toggle('collapsed', isCollapsed);
      blockHeader.textContent = `${isCollapsed ? '▸' : '▾'} ${blockLabel}`;
      blockHeader.setAttribute('aria-expanded', String(!isCollapsed));
      if (!isCollapsed) {
        ensureVisibleWeeks();
      }
    }
    blockUpdaters.set(blockKey, updateBlockState);
    updateBlockState();
    blockHeader.addEventListener('click', () => {
      const isCollapsed = collapsedBlocks.has(blockKey);
      if (showAllBlocks) {
        if (isCollapsed) {
          collapsedBlocks.delete(blockKey);
        } else {
          collapsedBlocks.add(blockKey);
        }
      } else if (isCollapsed) {
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
    if (!wkMap) {
      return;
    }
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
      let listRendered = false;
      function updateWeekState(){
        const isCollapsed = collapsedWeeks.has(weekKey);
        weekSec.classList.toggle('collapsed', isCollapsed);
        weekHeader.textContent = `${isCollapsed ? '▸' : '▾'} ${weekLabel}`;
        weekHeader.setAttribute('aria-expanded', String(!isCollapsed));
        if (!isCollapsed && !collapsedBlocks.has(blockKey)) {
          ensureListRendered();
        }
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
      const rows = wkMap.get(w) || [];
      function renderChunk(start = 0) {
        if (!rows.length) return;
        const slice = rows.slice(start, start + LIST_CHUNK_SIZE);
        if (!slice.length) return;
        const fragment = document.createDocumentFragment();
        slice.forEach(it => {
          fragment.appendChild(createItemCard(it, onChange));
        });
        list.appendChild(fragment);
        if (start + LIST_CHUNK_SIZE < rows.length) {
          scheduleChunk(() => renderChunk(start + LIST_CHUNK_SIZE));
        }
      }
      function ensureListRendered() {
        if (listRendered) return;
        listRendered = true;
        renderChunk();
      }
      weekEntries.push({ weekKey, ensureListRendered });
      weekSec.appendChild(list);
      blockSec.appendChild(weekSec);
    });
    ensureVisibleWeeks();
    container.appendChild(blockSec);
  });

  applyLayout();
}
