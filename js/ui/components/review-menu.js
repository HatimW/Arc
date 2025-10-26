import { getReviewDurations, rateSection, suspendSection } from '../../review/scheduler.js';
import { RETIRE_RATING } from '../../review/constants.js';
import { upsertItem } from '../../storage/storage.js';
import { createFloatingWindow } from './window-manager.js';
import { getSectionLabel } from './section-utils.js';

function entryKey(entry) {
  if (!entry) return null;
  const itemId = entry.itemId || entry.item?.id || entry.item?.slug || entry.item?.name || 'item';
  return `${itemId}::${entry.sectionKey}`;
}

function titleOf(item) {
  return item?.name || item?.concept || 'Untitled';
}

function formatOverdue(due, now) {
  const diffMs = Math.max(0, now - due);
  if (diffMs < 60 * 1000) return 'due now';
  const minutes = Math.round(diffMs / (60 * 1000));
  if (minutes < 60) return `${minutes} min overdue`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr overdue`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} overdue`;
}

function formatTimeUntil(due, now) {
  const diffMs = Math.max(0, due - now);
  if (diffMs < 60 * 1000) return 'due in under a minute';
  const minutes = Math.round(diffMs / (60 * 1000));
  if (minutes < 60) return `due in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `due in ${hours} hr`;
  const days = Math.round(hours / 24);
  return `due in ${days} day${days === 1 ? '' : 's'}`;
}

function formatIntervalMinutes(minutes) {
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

function formatLastReviewed(last, now) {
  if (!Number.isFinite(last) || last <= 0) return 'Never reviewed';
  const diffMs = Math.max(0, now - last);
  if (diffMs < 60 * 1000) return 'Reviewed just now';
  const minutes = Math.round(diffMs / (60 * 1000));
  if (minutes < 60) return `Reviewed ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Reviewed ${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Reviewed ${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `Reviewed ${months} mo ago`;
  const years = Math.round(months / 12);
  return `Reviewed ${years} yr ago`;
}

function masteryStage(entry) {
  const phase = entry?.state?.phase || entry.phase;
  switch (phase) {
    case 'review':
      return { label: 'Mature', variant: 'mature' };
    case 'new':
      return { label: 'Naive', variant: 'naive' };
    case 'learning':
    case 'relearning':
    default:
      return { label: 'Learning', variant: 'learning' };
  }
}

function resolveContextsForNode(entry, node) {
  const contexts = Array.isArray(entry?.contexts) ? entry.contexts : [];
  if (!contexts.length || !node) return contexts;
  if (node.type === 'lecture') {
    return contexts.filter(ctx => ctx.lectureKey === node.id);
  }
  if (node.type === 'week') {
    return contexts.filter(ctx => ctx.blockId === node.blockId && ctx.weekId === node.id);
  }
  if (node.type === 'block') {
    return contexts.filter(ctx => ctx.blockId === node.blockId);
  }
  return contexts;
}

function metadataForNode(node) {
  if (!node || node.type === 'root') {
    return { scope: 'all', label: 'All due cards' };
  }
  if (node.type === 'block') {
    return { scope: 'block', label: `Block – ${node.title}`, blockId: node.blockId };
  }
  if (node.type === 'week') {
    const base = node.title || node.label || 'Week';
    return {
      scope: 'week',
      label: `${base} – ${node.blockTitle || ''}`.trim(),
      blockId: node.blockId,
      week: Number.isFinite(node.weekNumber) ? node.weekNumber : undefined
    };
  }
  if (node.type === 'lecture') {
    return {
      scope: 'lecture',
      label: `${node.title} – ${node.blockTitle || ''}`.trim(),
      blockId: node.blockId,
      lectureId: node.lectureId,
      week: Number.isFinite(node.weekNumber) ? node.weekNumber : undefined
    };
  }
  return { scope: 'custom', label: 'Selected cards' };
}

function findNodeIdForFocus(focus, nodesById) {
  if (!focus) return null;
  if (focus.nodeId && nodesById.has(focus.nodeId)) {
    return focus.nodeId;
  }
  for (const [id, meta] of nodesById) {
    const node = meta.node;
    if (focus.type === 'lecture') {
      if (node.type === 'lecture') {
        const matchesKey = focus.lectureKey ? node.id === focus.lectureKey : true;
        if (node.blockId === focus.blockId && node.weekId === focus.weekId && (node.lectureId === focus.lectureId || matchesKey)) {
          return id;
        }
      }
    } else if (focus.type === 'week') {
      if (node.type === 'week' && node.blockId === focus.blockId && node.id === focus.weekId) {
        return id;
      }
    } else if (focus.type === 'block') {
      if (node.type === 'block' && node.id === focus.blockId) {
        return id;
      }
    } else if (focus.type === 'root' && node.type === 'root') {
      return id;
    }
  }
  return null;
}

function buildSessionPayload(entries) {
  return entries.map(entry => ({ item: entry.item, sections: [entry.sectionKey] }));
}

function collectNodes(root) {
  const nodesById = new Map();
  if (!root) return nodesById;
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || !node.nodeId) continue;
    nodesById.set(node.nodeId, { node });
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach(child => {
      if (child && !child.parent) child.parent = node;
      queue.push(child);
    });
  }
  return nodesById;
}

export function openReviewMenu(hierarchy, {
  title = 'Review entries',
  now = Date.now(),
  startSession,
  focus = null,
  focusEntryKey = null,
  onChange
} = {}) {
  const rootNode = hierarchy?.root;
  const allEntries = Array.isArray(rootNode?.entries) ? rootNode.entries : [];
  if (!rootNode) {
    const win = createFloatingWindow({ title, width: 720 });
    const body = win.querySelector('.floating-body');
    const empty = document.createElement('div');
    empty.className = 'review-menu-empty';
    empty.textContent = 'No review entries available.';
    body.appendChild(empty);
    return win;
  }

  const nodesById = collectNodes(rootNode);
  const entriesByKey = new Map();
  allEntries.forEach(entry => {
    const key = entryKey(entry);
    if (key) entriesByKey.set(key, entry);
  });

  const win = createFloatingWindow({ title, width: 920 });
  const body = win.querySelector('.floating-body');
  body.classList.add('review-menu');

  const layout = document.createElement('div');
  layout.className = 'review-menu-layout';
  body.appendChild(layout);

  const nav = document.createElement('nav');
  nav.className = 'review-menu-nav';
  layout.appendChild(nav);

  const navTree = document.createElement('div');
  navTree.className = 'review-menu-tree';
  nav.appendChild(navTree);

  const content = document.createElement('div');
  content.className = 'review-menu-content';
  layout.appendChild(content);

  const header = document.createElement('div');
  header.className = 'review-menu-header';
  content.appendChild(header);

  const headerTitle = document.createElement('h3');
  headerTitle.className = 'review-menu-title';
  header.appendChild(headerTitle);

  const headerCount = document.createElement('span');
  headerCount.className = 'review-menu-count';
  header.appendChild(headerCount);

  const headerActions = document.createElement('div');
  headerActions.className = 'review-menu-header-actions';
  header.appendChild(headerActions);

  const reviewAllBtn = document.createElement('button');
  reviewAllBtn.type = 'button';
  reviewAllBtn.className = 'btn';
  reviewAllBtn.textContent = 'Review all';
  headerActions.appendChild(reviewAllBtn);

  const selectionBar = document.createElement('div');
  selectionBar.className = 'review-menu-selection';
  content.appendChild(selectionBar);

  const selectionControls = document.createElement('div');
  selectionControls.className = 'review-selection-controls';
  selectionBar.appendChild(selectionControls);

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'btn tertiary';
  selectAllBtn.textContent = 'Select all';
  selectionControls.appendChild(selectAllBtn);

  const clearSelectionBtn = document.createElement('button');
  clearSelectionBtn.type = 'button';
  clearSelectionBtn.className = 'btn tertiary';
  clearSelectionBtn.textContent = 'Clear selection';
  selectionControls.appendChild(clearSelectionBtn);

  const selectionInfo = document.createElement('div');
  selectionInfo.className = 'review-selection-info';
  selectionBar.appendChild(selectionInfo);

  const selectionActions = document.createElement('div');
  selectionActions.className = 'review-selection-actions';
  selectionBar.appendChild(selectionActions);

  const reviewSelectedBtn = document.createElement('button');
  reviewSelectedBtn.type = 'button';
  reviewSelectedBtn.className = 'btn';
  reviewSelectedBtn.textContent = 'Review selected';
  selectionActions.appendChild(reviewSelectedBtn);

  const suspendSelectedBtn = document.createElement('button');
  suspendSelectedBtn.type = 'button';
  suspendSelectedBtn.className = 'btn tertiary';
  suspendSelectedBtn.textContent = 'Suspend selected';
  selectionActions.appendChild(suspendSelectedBtn);

  const retireSelectedBtn = document.createElement('button');
  retireSelectedBtn.type = 'button';
  retireSelectedBtn.className = 'btn tertiary danger';
  retireSelectedBtn.textContent = 'Retire selected';
  selectionActions.appendChild(retireSelectedBtn);

  const gridWrap = document.createElement('div');
  gridWrap.className = 'review-menu-grid-wrap';
  content.appendChild(gridWrap);

  const grid = document.createElement('div');
  grid.className = 'review-entry-grid';
  gridWrap.appendChild(grid);

  const status = document.createElement('div');
  status.className = 'review-menu-status';
  content.appendChild(status);

  const navButtons = new Map();
  let activeNodeId = null;
  let busy = false;
  const selection = new Set();
  const tilesByKey = new Map();

  function setStatus(message = '', variant = '') {
    status.textContent = message;
    status.classList.remove('is-error', 'is-success', 'is-pending');
    if (variant === 'error') status.classList.add('is-error');
    else if (variant === 'success') status.classList.add('is-success');
    else if (variant === 'pending') status.classList.add('is-pending');
  }

  function updateNavCount(nodeId) {
    const buttonMeta = navButtons.get(nodeId);
    const meta = nodesById.get(nodeId);
    if (!buttonMeta || !meta) return;
    const count = Array.isArray(meta.node.entries) ? meta.node.entries.length : 0;
    buttonMeta.count.textContent = String(count);
    if (meta.node.type !== 'root') {
      buttonMeta.button.disabled = count === 0;
    }
  }

  function clearSelection() {
    selection.clear();
    updateSelectionUI();
  }

  function updateSelectionUI() {
    tilesByKey.forEach((tile, key) => {
      tile.classList.toggle('is-selected', selection.has(key));
    });
    const count = selection.size;
    if (count === 0) {
      selectionInfo.textContent = 'No cards selected';
      selectionBar.classList.remove('has-selection');
    } else {
      selectionInfo.textContent = `${count} card${count === 1 ? '' : 's'} selected`;
      selectionBar.classList.add('has-selection');
    }
    const disableActions = busy || count === 0;
    reviewSelectedBtn.disabled = disableActions || typeof startSession !== 'function';
    suspendSelectedBtn.disabled = disableActions;
    retireSelectedBtn.disabled = disableActions;
  }

  function renderNav() {
    navTree.innerHTML = '';
    const queue = [{ node: rootNode, depth: 0 }];
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (!node || !node.nodeId) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'review-menu-node';
      button.dataset.nodeId = node.nodeId;
      button.style.setProperty('--depth', String(depth));
      const titleSpan = document.createElement('span');
      titleSpan.className = 'review-menu-node-title';
      titleSpan.textContent = node.title || node.label || 'Untitled';
      button.appendChild(titleSpan);
      const countSpan = document.createElement('span');
      countSpan.className = 'review-menu-node-count';
      countSpan.textContent = String(Array.isArray(node.entries) ? node.entries.length : 0);
      button.appendChild(countSpan);
      button.disabled = node.type !== 'root' && (!node.entries || node.entries.length === 0);
      button.addEventListener('click', () => {
        if (busy) return;
        setActiveNode(node.nodeId, { preserveSelection: false });
      });
      navTree.appendChild(button);
      navButtons.set(node.nodeId, { button, count: countSpan });
      const children = Array.isArray(node.children) ? node.children : [];
      children.forEach(child => queue.push({ node: child, depth: depth + 1 }));
    }
  }

  function renderTiles(node, focusKey = null) {
    tilesByKey.clear();
    grid.innerHTML = '';
    const entries = Array.isArray(node?.entries) ? node.entries : [];
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'review-menu-empty';
      empty.textContent = 'No cards in this section.';
      grid.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    entries.forEach(entry => {
      const key = entryKey(entry);
      const tile = document.createElement('article');
      tile.className = 'review-entry-tile';
      tile.dataset.key = key;
      tile.tabIndex = 0;
      const selectMark = document.createElement('div');
      selectMark.className = 'review-tile-select';
      tile.appendChild(selectMark);
      const titleRow = document.createElement('div');
      titleRow.className = 'review-tile-header';
      const titleEl = document.createElement('h4');
      titleEl.className = 'review-tile-title';
      titleEl.textContent = titleOf(entry.item);
      titleRow.appendChild(titleEl);
      const partEl = document.createElement('div');
      partEl.className = 'review-tile-part';
      partEl.textContent = getSectionLabel(entry.item, entry.sectionKey);
      titleRow.appendChild(partEl);
      tile.appendChild(titleRow);

      const contexts = resolveContextsForNode(entry, node);
      if (contexts.length) {
        const pathRow = document.createElement('div');
        pathRow.className = 'review-tile-path';
        contexts.forEach(ctx => {
          const chip = document.createElement('span');
          chip.className = 'review-tile-chip';
          const parts = [];
          if (ctx.blockTitle) parts.push(ctx.blockTitle);
          if (ctx.weekLabel) parts.push(ctx.weekLabel);
          if (ctx.lectureLabel) parts.push(ctx.lectureLabel);
          chip.textContent = parts.join(' • ');
          pathRow.appendChild(chip);
        });
        tile.appendChild(pathRow);
      }

      const stage = masteryStage(entry);
      const infoRow = document.createElement('div');
      infoRow.className = 'review-tile-info';
      const due = Number(entry.due);
      const dueText = Number.isFinite(due) ? (due <= now ? formatOverdue(due, now) : formatTimeUntil(due, now)) : '—';
      const dueEl = document.createElement('span');
      dueEl.className = 'review-tile-meta';
      dueEl.textContent = `Due: ${dueText}`;
      infoRow.appendChild(dueEl);
      const lastEl = document.createElement('span');
      lastEl.className = 'review-tile-meta';
      lastEl.textContent = formatLastReviewed(entry?.state?.last, now);
      infoRow.appendChild(lastEl);
      const intervalEl = document.createElement('span');
      intervalEl.className = 'review-tile-meta';
      intervalEl.textContent = `Interval: ${formatIntervalMinutes(entry?.state?.interval)}`;
      infoRow.appendChild(intervalEl);
      tile.appendChild(infoRow);

      const stageEl = document.createElement('div');
      stageEl.className = `review-tile-stage review-stage-${stage.variant}`;
      stageEl.textContent = stage.label;
      tile.appendChild(stageEl);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'review-tile-actions';
      tile.appendChild(actionsRow);

      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'btn tertiary';
      reviewBtn.textContent = 'Review';
      reviewBtn.disabled = typeof startSession !== 'function';
      reviewBtn.addEventListener('click', () => {
        if (busy || typeof startSession !== 'function') return;
        startSession(buildSessionPayload([entry]), {
          scope: 'single',
          label: `Focused review – ${titleOf(entry.item)}`
        });
      });
      actionsRow.appendChild(reviewBtn);

      const suspendBtn = document.createElement('button');
      suspendBtn.type = 'button';
      suspendBtn.className = 'btn tertiary';
      suspendBtn.textContent = 'Suspend';
      suspendBtn.addEventListener('click', async () => {
        if (busy) return;
        await performAction('suspend', [entry]);
      });
      actionsRow.appendChild(suspendBtn);

      const retireBtn = document.createElement('button');
      retireBtn.type = 'button';
      retireBtn.className = 'btn tertiary danger';
      retireBtn.textContent = 'Retire';
      retireBtn.addEventListener('click', async () => {
        if (busy) return;
        await performAction('retire', [entry]);
      });
      actionsRow.appendChild(retireBtn);

      tile.addEventListener('click', event => {
        if (busy) return;
        if (event.target instanceof HTMLElement && event.target.closest('.btn')) return;
        const key = entryKey(entry);
        if (!key) return;
        if (selection.has(key)) {
          selection.delete(key);
        } else {
          selection.add(key);
        }
        updateSelectionUI();
      });

      tile.addEventListener('keydown', event => {
        if (busy) return;
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          const key = entryKey(entry);
          if (!key) return;
          if (selection.has(key)) selection.delete(key);
          else selection.add(key);
          updateSelectionUI();
        }
      });

      fragment.appendChild(tile);
      if (key) tilesByKey.set(key, tile);
    });
    grid.appendChild(fragment);
    updateSelectionUI();
    if (focusKey && tilesByKey.has(focusKey)) {
      const focusedTile = tilesByKey.get(focusKey);
      focusedTile.classList.add('is-focused');
      focusedTile.scrollIntoView({ block: 'nearest' });
      setTimeout(() => focusedTile.classList.remove('is-focused'), 1200);
    }
  }

  function updateHeader() {
    const activeMeta = nodesById.get(activeNodeId);
    const activeNode = activeMeta?.node;
    const count = Array.isArray(activeNode?.entries) ? activeNode.entries.length : 0;
    headerTitle.textContent = activeNode?.title || activeNode?.label || 'Cards';
    headerCount.textContent = `${count} card${count === 1 ? '' : 's'}`;
    reviewAllBtn.disabled = busy || typeof startSession !== 'function' || count === 0;
  }

  function setActiveNode(nodeId, { preserveSelection = false, focusKey = null } = {}) {
    if (!nodesById.has(nodeId)) return;
    activeNodeId = nodeId;
    navButtons.forEach(({ button }) => {
      button.classList.toggle('is-active', button.dataset.nodeId === nodeId);
    });
    if (!preserveSelection) clearSelection();
    const activeNode = nodesById.get(nodeId)?.node;
    renderTiles(activeNode, focusKey);
    updateHeader();
  }

  async function handleEntryChange() {
    if (typeof onChange === 'function') {
      try {
        await onChange();
      } catch (err) {
        console.error(err);
      }
    }
  }

  function removeEntryByKey(key) {
    let activeAffected = false;
    nodesById.forEach(({ node }) => {
      if (!Array.isArray(node.entries) || !node.entries.length) return;
      const next = node.entries.filter(entry => entryKey(entry) !== key);
      if (next.length !== node.entries.length) {
        node.entries = next;
        updateNavCount(node.nodeId);
        if (node.nodeId === activeNodeId) activeAffected = true;
      }
    });
    entriesByKey.delete(key);
    selection.delete(key);
    if (activeAffected) {
      const activeNode = nodesById.get(activeNodeId)?.node;
      renderTiles(activeNode);
      updateHeader();
    } else {
      updateSelectionUI();
    }
  }

  async function performAction(action, entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    busy = true;
    updateSelectionUI();
    const actionLabel = action === 'suspend' ? 'Suspending' : action === 'retire' ? 'Retiring' : 'Updating';
    setStatus(`${actionLabel} ${entries.length} card${entries.length === 1 ? '' : 's'}…`, 'pending');
    try {
      if (action === 'suspend') {
        const nowTs = Date.now();
        const touched = new Set();
        entries.forEach(entry => {
          suspendSection(entry.item, entry.sectionKey, nowTs);
          touched.add(entry.item);
        });
        for (const item of touched) {
          await upsertItem(item);
        }
      } else if (action === 'retire') {
        const durations = await getReviewDurations();
        const nowTs = Date.now();
        const touched = new Set();
        entries.forEach(entry => {
          rateSection(entry.item, entry.sectionKey, RETIRE_RATING, durations, nowTs);
          touched.add(entry.item);
        });
        for (const item of touched) {
          await upsertItem(item);
        }
      }
      entries.forEach(entry => {
        const key = entryKey(entry);
        if (key) removeEntryByKey(key);
      });
      setStatus(`${action === 'suspend' ? 'Suspended' : 'Retired'} ${entries.length} card${entries.length === 1 ? '' : 's'}.`, 'success');
      await handleEntryChange();
      setActiveNode(activeNodeId, { preserveSelection: false });
    } catch (err) {
      console.error('Failed to update review entries', err);
      setStatus(`Failed to ${action === 'suspend' ? 'suspend' : 'retire'} cards.`, 'error');
    } finally {
      busy = false;
      updateSelectionUI();
    }
  }

  reviewAllBtn.addEventListener('click', () => {
    if (busy || typeof startSession !== 'function') return;
    const activeNode = nodesById.get(activeNodeId)?.node;
    const entries = Array.isArray(activeNode?.entries) ? activeNode.entries : [];
    if (!entries.length) return;
    const metadata = metadataForNode(activeNode);
    startSession(buildSessionPayload(entries), metadata);
  });

  selectAllBtn.addEventListener('click', () => {
    if (busy) return;
    const activeNode = nodesById.get(activeNodeId)?.node;
    const entries = Array.isArray(activeNode?.entries) ? activeNode.entries : [];
    selection.clear();
    entries.forEach(entry => {
      const key = entryKey(entry);
      if (key) selection.add(key);
    });
    updateSelectionUI();
  });

  clearSelectionBtn.addEventListener('click', () => {
    if (busy) return;
    clearSelection();
  });

  reviewSelectedBtn.addEventListener('click', () => {
    if (busy || typeof startSession !== 'function' || selection.size === 0) return;
    const entries = Array.from(selection).map(key => entriesByKey.get(key)).filter(Boolean);
    if (!entries.length) return;
    const activeNode = nodesById.get(activeNodeId)?.node;
    const metadata = metadataForNode(activeNode);
    startSession(buildSessionPayload(entries), metadata);
  });

  suspendSelectedBtn.addEventListener('click', async () => {
    if (busy || selection.size === 0) return;
    const entries = Array.from(selection).map(key => entriesByKey.get(key)).filter(Boolean);
    await performAction('suspend', entries);
  });

  retireSelectedBtn.addEventListener('click', async () => {
    if (busy || selection.size === 0) return;
    const entries = Array.from(selection).map(key => entriesByKey.get(key)).filter(Boolean);
    await performAction('retire', entries);
  });

  const marquee = document.createElement('div');
  marquee.className = 'review-selection-rect';
  let dragState = null;

  function commitDragSelection(rect) {
    if (!rect) return;
    selection.clear();
    tilesByKey.forEach((tile, key) => {
      const bounds = tile.getBoundingClientRect();
      const intersects = bounds.right >= rect.left && bounds.left <= rect.right && bounds.bottom >= rect.top && bounds.top <= rect.bottom;
      if (intersects) selection.add(key);
    });
    updateSelectionUI();
  }

  grid.addEventListener('pointerdown', event => {
    if (busy || event.button !== 0) return;
    if (event.target instanceof HTMLElement && event.target.closest('.btn')) return;
    const gridBounds = grid.getBoundingClientRect();
    dragState = {
      id: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      gridBounds,
      active: false
    };
    grid.setPointerCapture(event.pointerId);
    marquee.style.display = 'none';
    gridWrap.appendChild(marquee);
  });

  grid.addEventListener('pointermove', event => {
    if (!dragState || event.pointerId !== dragState.id) return;
    const deltaX = event.clientX - dragState.originX;
    const deltaY = event.clientY - dragState.originY;
    if (!dragState.active && Math.hypot(deltaX, deltaY) > 6) {
      dragState.active = true;
      marquee.style.display = '';
      selection.clear();
    }
    if (!dragState.active) return;
    const minX = Math.min(event.clientX, dragState.originX);
    const maxX = Math.max(event.clientX, dragState.originX);
    const minY = Math.min(event.clientY, dragState.originY);
    const maxY = Math.max(event.clientY, dragState.originY);
    marquee.style.left = `${minX - dragState.gridBounds.left + gridWrap.scrollLeft}px`;
    marquee.style.top = `${minY - dragState.gridBounds.top + gridWrap.scrollTop}px`;
    marquee.style.width = `${Math.max(0, maxX - minX)}px`;
    marquee.style.height = `${Math.max(0, maxY - minY)}px`;
    commitDragSelection({ left: minX, top: minY, right: maxX, bottom: maxY });
  });

  function endDrag(event) {
    if (!dragState || (event && event.pointerId !== dragState.id)) return;
    if (dragState.active) {
      marquee.style.display = 'none';
    } else {
      marquee.remove();
    }
    dragState = null;
    grid.releasePointerCapture(event?.pointerId ?? 0);
    updateSelectionUI();
  }

  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);
  grid.addEventListener('pointerleave', event => {
    if (dragState) endDrag(event);
  });

  renderNav();
  const initialNodeId = findNodeIdForFocus(focus, nodesById) || rootNode.nodeId;
  setActiveNode(initialNodeId, { preserveSelection: true, focusKey: focusEntryKey });
  updateSelectionUI();
  updateNavCount(initialNodeId);
  return win;
}

export { buildSessionPayload };
