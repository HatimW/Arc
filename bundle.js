  // js/ui/components/review-menu.js
  function entryKey(entry) {
    if (!entry) return null;
    const itemId = entry.itemId || entry.item?.id || entry.item?.slug || entry.item?.name || "item";
    return `${itemId}::${entry.sectionKey}`;
  }
  function titleOf2(item) {
    return item?.name || item?.concept || "Untitled";
  }
  function formatOverdue2(due, now) {
    const diffMs = Math.max(0, now - due);
    if (diffMs < 60 * 1e3) return "due now";
    const minutes = Math.round(diffMs / (60 * 1e3));
    if (minutes < 60) return `${minutes} min overdue`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hr overdue`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} overdue`;
  }
  function formatTimeUntil2(due, now) {
    const diffMs = Math.max(0, due - now);
    if (diffMs < 60 * 1e3) return "due in under a minute";
    const minutes = Math.round(diffMs / (60 * 1e3));
    if (minutes < 60) return `due in ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `due in ${hours} hr`;
    const days = Math.round(hours / 24);
    return `due in ${days} day${days === 1 ? "" : "s"}`;
  }
  function formatIntervalMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return "\u2014";
  function formatLastReviewed(last, now) {
    if (!Number.isFinite(last) || last <= 0) return "Never reviewed";
    const diffMs = Math.max(0, now - last);
    if (diffMs < 60 * 1e3) return "Reviewed just now";
    const minutes = Math.round(diffMs / (60 * 1e3));
    if (minutes < 60) return `Reviewed ${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Reviewed ${hours} hr ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `Reviewed ${days} day${days === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `Reviewed ${months} mo ago`;
    const years = Math.round(months / 12);
    return `Reviewed ${years} yr ago`;
  function masteryStage(entry) {
    const phase = entry?.state?.phase || entry.phase;
    switch (phase) {
      case "review":
        return { label: "Mature", variant: "mature" };
      case "new":
        return { label: "Naive", variant: "naive" };
      case "learning":
      case "relearning":
      default:
        return { label: "Learning", variant: "learning" };
  function resolveContextsForNode(entry, node) {
    const contexts = Array.isArray(entry?.contexts) ? entry.contexts : [];
    if (!contexts.length || !node) return contexts;
    if (node.type === "lecture") {
      return contexts.filter((ctx) => ctx.lectureKey === node.id);
    }
    if (node.type === "week") {
      return contexts.filter((ctx) => ctx.blockId === node.blockId && ctx.weekId === node.id);
    }
    if (node.type === "block") {
      return contexts.filter((ctx) => ctx.blockId === node.blockId);
    }
    return contexts;
  function metadataForNode(node) {
    if (!node || node.type === "root") {
      return { scope: "all", label: "All due cards" };
    if (node.type === "block") {
      return { scope: "block", label: `Block \u2013 ${node.title}`, blockId: node.blockId };
    if (node.type === "week") {
      const base = node.title || node.label || "Week";
      return {
        scope: "week",
        label: `${base} \u2013 ${node.blockTitle || ""}`.trim(),
        blockId: node.blockId,
        week: Number.isFinite(node.weekNumber) ? node.weekNumber : void 0
      };
    if (node.type === "lecture") {
      return {
        scope: "lecture",
        label: `${node.title} \u2013 ${node.blockTitle || ""}`.trim(),
        blockId: node.blockId,
        lectureId: node.lectureId,
        week: Number.isFinite(node.weekNumber) ? node.weekNumber : void 0
      };
    return { scope: "custom", label: "Selected cards" };
  function findNodeIdForFocus(focus, nodesById) {
    if (!focus) return null;
    if (focus.nodeId && nodesById.has(focus.nodeId)) {
      return focus.nodeId;
    }
    for (const [id, meta] of nodesById) {
      const node = meta.node;
      if (focus.type === "lecture") {
        if (node.type === "lecture") {
          const matchesKey = focus.lectureKey ? node.id === focus.lectureKey : true;
          if (node.blockId === focus.blockId && node.weekId === focus.weekId && (node.lectureId === focus.lectureId || matchesKey)) {
            return id;
          }
        }
      } else if (focus.type === "week") {
        if (node.type === "week" && node.blockId === focus.blockId && node.id === focus.weekId) {
          return id;
        }
      } else if (focus.type === "block") {
        if (node.type === "block" && node.id === focus.blockId) {
          return id;
        }
      } else if (focus.type === "root" && node.type === "root") {
        return id;
    return null;
  }
  function buildSessionPayload(entries) {
    return entries.map((entry) => ({ item: entry.item, sections: [entry.sectionKey] }));
  }
  function collectNodes(root) {
    const nodesById = /* @__PURE__ */ new Map();
    if (!root) return nodesById;
    const queue = [root];
    while (queue.length) {
      const node = queue.shift();
      if (!node || !node.nodeId) continue;
      nodesById.set(node.nodeId, { node });
      const children = Array.isArray(node.children) ? node.children : [];
      children.forEach((child) => {
        if (child && !child.parent) child.parent = node;
        queue.push(child);
      });
    }
    return nodesById;
  }
  function openReviewMenu(hierarchy, {
    title = "Review entries",
    now = Date.now(),
    startSession,
    focus = null,
    focusEntryKey = null,
    onChange
  } = {}) {
    const rootNode = hierarchy?.root;
    const allEntries = Array.isArray(rootNode?.entries) ? rootNode.entries : [];
    if (!rootNode) {
      const win2 = createFloatingWindow({ title, width: 720 });
      const body2 = win2.querySelector(".floating-body");
      const empty = document.createElement("div");
      empty.className = "review-menu-empty";
      empty.textContent = "No review entries available.";
      body2.appendChild(empty);
      return win2;
    }
    const nodesById = collectNodes(rootNode);
    const entriesByKey = /* @__PURE__ */ new Map();
    allEntries.forEach((entry) => {
      const key = entryKey(entry);
      if (key) entriesByKey.set(key, entry);
    });
    const win = createFloatingWindow({ title, width: 920 });
    const body = win.querySelector(".floating-body");
    body.classList.add("review-menu");
    const layout = document.createElement("div");
    layout.className = "review-menu-layout";
    body.appendChild(layout);
    const nav = document.createElement("nav");
    nav.className = "review-menu-nav";
    layout.appendChild(nav);
    const navTree = document.createElement("div");
    navTree.className = "review-menu-tree";
    nav.appendChild(navTree);
    const content = document.createElement("div");
    content.className = "review-menu-content";
    layout.appendChild(content);
    const header = document.createElement("div");
    header.className = "review-menu-header";
    content.appendChild(header);
    const headerTitle = document.createElement("h3");
    headerTitle.className = "review-menu-title";
    header.appendChild(headerTitle);
    const headerCount = document.createElement("span");
    headerCount.className = "review-menu-count";
    header.appendChild(headerCount);
    const headerActions = document.createElement("div");
    headerActions.className = "review-menu-header-actions";
    header.appendChild(headerActions);
    const reviewAllBtn = document.createElement("button");
    reviewAllBtn.type = "button";
    reviewAllBtn.className = "btn";
    reviewAllBtn.textContent = "Review all";
    headerActions.appendChild(reviewAllBtn);
    const selectionBar = document.createElement("div");
    selectionBar.className = "review-menu-selection";
    content.appendChild(selectionBar);
    const selectionControls = document.createElement("div");
    selectionControls.className = "review-selection-controls";
    selectionBar.appendChild(selectionControls);
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "btn tertiary";
    selectAllBtn.textContent = "Select all";
    selectionControls.appendChild(selectAllBtn);
    const clearSelectionBtn = document.createElement("button");
    clearSelectionBtn.type = "button";
    clearSelectionBtn.className = "btn tertiary";
    clearSelectionBtn.textContent = "Clear selection";
    selectionControls.appendChild(clearSelectionBtn);
    const selectionInfo = document.createElement("div");
    selectionInfo.className = "review-selection-info";
    selectionBar.appendChild(selectionInfo);
    const selectionActions = document.createElement("div");
    selectionActions.className = "review-selection-actions";
    selectionBar.appendChild(selectionActions);
    const reviewSelectedBtn = document.createElement("button");
    reviewSelectedBtn.type = "button";
    reviewSelectedBtn.className = "btn";
    reviewSelectedBtn.textContent = "Review selected";
    selectionActions.appendChild(reviewSelectedBtn);
    const suspendSelectedBtn = document.createElement("button");
    suspendSelectedBtn.type = "button";
    suspendSelectedBtn.className = "btn tertiary";
    suspendSelectedBtn.textContent = "Suspend selected";
    selectionActions.appendChild(suspendSelectedBtn);
    const retireSelectedBtn = document.createElement("button");
    retireSelectedBtn.type = "button";
    retireSelectedBtn.className = "btn tertiary danger";
    retireSelectedBtn.textContent = "Retire selected";
    selectionActions.appendChild(retireSelectedBtn);
    const gridWrap = document.createElement("div");
    gridWrap.className = "review-menu-grid-wrap";
    content.appendChild(gridWrap);
    const grid = document.createElement("div");
    grid.className = "review-entry-grid";
    gridWrap.appendChild(grid);
    const status = document.createElement("div");
    status.className = "review-menu-status";
    content.appendChild(status);
    const navButtons = /* @__PURE__ */ new Map();
    let activeNodeId = null;
    let busy = false;
    const selection = /* @__PURE__ */ new Set();
    const tilesByKey = /* @__PURE__ */ new Map();
    function setStatus(message = "", variant = "") {
      status.textContent = message;
      status.classList.remove("is-error", "is-success", "is-pending");
      if (variant === "error") status.classList.add("is-error");
      else if (variant === "success") status.classList.add("is-success");
      else if (variant === "pending") status.classList.add("is-pending");
    }
    function updateNavCount(nodeId) {
      const buttonMeta = navButtons.get(nodeId);
      const meta = nodesById.get(nodeId);
      if (!buttonMeta || !meta) return;
      const count = Array.isArray(meta.node.entries) ? meta.node.entries.length : 0;
      buttonMeta.count.textContent = String(count);
      if (meta.node.type !== "root") {
        buttonMeta.button.disabled = count === 0;
      }
    }
    function clearSelection() {
      selection.clear();
      updateSelectionUI();
    }
    function updateSelectionUI() {
      tilesByKey.forEach((tile, key) => {
        tile.classList.toggle("is-selected", selection.has(key));
      });
      const count = selection.size;
      if (count === 0) {
        selectionInfo.textContent = "No cards selected";
        selectionBar.classList.remove("has-selection");
        selectionInfo.textContent = `${count} card${count === 1 ? "" : "s"} selected`;
        selectionBar.classList.add("has-selection");
      const disableActions = busy || count === 0;
      reviewSelectedBtn.disabled = disableActions || typeof startSession !== "function";
      suspendSelectedBtn.disabled = disableActions;
      retireSelectedBtn.disabled = disableActions;
    function renderNav() {
      navTree.innerHTML = "";
      const queue = [{ node: rootNode, depth: 0 }];
      while (queue.length) {
        const { node, depth } = queue.shift();
        if (!node || !node.nodeId) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "review-menu-node";
        button.dataset.nodeId = node.nodeId;
        button.style.setProperty("--depth", String(depth));
        const titleSpan = document.createElement("span");
        titleSpan.className = "review-menu-node-title";
        titleSpan.textContent = node.title || node.label || "Untitled";
        button.appendChild(titleSpan);
        const countSpan = document.createElement("span");
        countSpan.className = "review-menu-node-count";
        countSpan.textContent = String(Array.isArray(node.entries) ? node.entries.length : 0);
        button.appendChild(countSpan);
        button.disabled = node.type !== "root" && (!node.entries || node.entries.length === 0);
        button.addEventListener("click", () => {
          if (busy) return;
          setActiveNode(node.nodeId, { preserveSelection: false });
        });
        navTree.appendChild(button);
        navButtons.set(node.nodeId, { button, count: countSpan });
        const children = Array.isArray(node.children) ? node.children : [];
        children.forEach((child) => queue.push({ node: child, depth: depth + 1 }));
    function renderTiles(node, focusKey = null) {
      tilesByKey.clear();
      grid.innerHTML = "";
      const entries = Array.isArray(node?.entries) ? node.entries : [];
      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "review-menu-empty";
        empty.textContent = "No cards in this section.";
        grid.appendChild(empty);
        return;
      }
      const fragment = document.createDocumentFragment();
      entries.forEach((entry) => {
        const key = entryKey(entry);
        const tile = document.createElement("article");
        tile.className = "review-entry-tile";
        tile.dataset.key = key;
        tile.tabIndex = 0;
        const selectMark = document.createElement("div");
        selectMark.className = "review-tile-select";
        tile.appendChild(selectMark);
        const titleRow = document.createElement("div");
        titleRow.className = "review-tile-header";
        const titleEl = document.createElement("h4");
        titleEl.className = "review-tile-title";
        titleEl.textContent = titleOf2(entry.item);
        titleRow.appendChild(titleEl);
        const partEl = document.createElement("div");
        partEl.className = "review-tile-part";
        partEl.textContent = getSectionLabel(entry.item, entry.sectionKey);
        titleRow.appendChild(partEl);
        tile.appendChild(titleRow);
        const contexts = resolveContextsForNode(entry, node);
        if (contexts.length) {
          const pathRow = document.createElement("div");
          pathRow.className = "review-tile-path";
          contexts.forEach((ctx) => {
            const chip = document.createElement("span");
            chip.className = "review-tile-chip";
            const parts = [];
            if (ctx.blockTitle) parts.push(ctx.blockTitle);
            if (ctx.weekLabel) parts.push(ctx.weekLabel);
            if (ctx.lectureLabel) parts.push(ctx.lectureLabel);
            chip.textContent = parts.join(" \u2022 ");
            pathRow.appendChild(chip);
          });
          tile.appendChild(pathRow);
        }
        const stage = masteryStage(entry);
        const infoRow = document.createElement("div");
        infoRow.className = "review-tile-info";
        const due = Number(entry.due);
        const dueText = Number.isFinite(due) ? due <= now ? formatOverdue2(due, now) : formatTimeUntil2(due, now) : "\u2014";
        const dueEl = document.createElement("span");
        dueEl.className = "review-tile-meta";
        dueEl.textContent = `Due: ${dueText}`;
        infoRow.appendChild(dueEl);
        const lastEl = document.createElement("span");
        lastEl.className = "review-tile-meta";
        lastEl.textContent = formatLastReviewed(entry?.state?.last, now);
        infoRow.appendChild(lastEl);
        const intervalEl = document.createElement("span");
        intervalEl.className = "review-tile-meta";
        intervalEl.textContent = `Interval: ${formatIntervalMinutes(entry?.state?.interval)}`;
        infoRow.appendChild(intervalEl);
        tile.appendChild(infoRow);
        const stageEl = document.createElement("div");
        stageEl.className = `review-tile-stage review-stage-${stage.variant}`;
        stageEl.textContent = stage.label;
        tile.appendChild(stageEl);
        const actionsRow = document.createElement("div");
        actionsRow.className = "review-tile-actions";
        tile.appendChild(actionsRow);
        const reviewBtn = document.createElement("button");
        reviewBtn.type = "button";
        reviewBtn.className = "btn tertiary";
        reviewBtn.textContent = "Review";
        reviewBtn.disabled = typeof startSession !== "function";
        reviewBtn.addEventListener("click", () => {
          if (busy || typeof startSession !== "function") return;
          startSession(buildSessionPayload([entry]), {
            scope: "single",
            label: `Focused review \u2013 ${titleOf2(entry.item)}`
          });
        });
        actionsRow.appendChild(reviewBtn);
        const suspendBtn = document.createElement("button");
        suspendBtn.type = "button";
        suspendBtn.className = "btn tertiary";
        suspendBtn.textContent = "Suspend";
        suspendBtn.addEventListener("click", async () => {
          if (busy) return;
          await performAction("suspend", [entry]);
        });
        actionsRow.appendChild(suspendBtn);
        const retireBtn = document.createElement("button");
        retireBtn.type = "button";
        retireBtn.className = "btn tertiary danger";
        retireBtn.textContent = "Retire";
        retireBtn.addEventListener("click", async () => {
          if (busy) return;
          await performAction("retire", [entry]);
        });
        actionsRow.appendChild(retireBtn);
        tile.addEventListener("click", (event) => {
          if (busy) return;
          if (event.target instanceof HTMLElement && event.target.closest(".btn")) return;
          const key2 = entryKey(entry);
          if (!key2) return;
          if (selection.has(key2)) {
            selection.delete(key2);
          } else {
            selection.add(key2);
          }
          updateSelectionUI();
        });
        tile.addEventListener("keydown", (event) => {
          if (busy) return;
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            const key2 = entryKey(entry);
            if (!key2) return;
            if (selection.has(key2)) selection.delete(key2);
            else selection.add(key2);
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
        focusedTile.classList.add("is-focused");
        focusedTile.scrollIntoView({ block: "nearest" });
        setTimeout(() => focusedTile.classList.remove("is-focused"), 1200);
      }
    }
    function updateHeader() {
      const activeMeta = nodesById.get(activeNodeId);
      const activeNode = activeMeta?.node;
      const count = Array.isArray(activeNode?.entries) ? activeNode.entries.length : 0;
      headerTitle.textContent = activeNode?.title || activeNode?.label || "Cards";
      headerCount.textContent = `${count} card${count === 1 ? "" : "s"}`;
      reviewAllBtn.disabled = busy || typeof startSession !== "function" || count === 0;
    }
    function setActiveNode(nodeId, { preserveSelection = false, focusKey = null } = {}) {
      if (!nodesById.has(nodeId)) return;
      activeNodeId = nodeId;
      navButtons.forEach(({ button }) => {
        button.classList.toggle("is-active", button.dataset.nodeId === nodeId);
      });
      if (!preserveSelection) clearSelection();
      const activeNode = nodesById.get(nodeId)?.node;
      renderTiles(activeNode, focusKey);
      updateHeader();
    }
    async function handleEntryChange() {
      if (typeof onChange === "function") {
        try {
          await onChange();
        } catch (err) {
          console.error(err);
        }
      }
    function removeEntryByKey(key) {
      let activeAffected = false;
      nodesById.forEach(({ node }) => {
        if (!Array.isArray(node.entries) || !node.entries.length) return;
        const next = node.entries.filter((entry) => entryKey(entry) !== key);
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
    async function performAction(action, entries) {
      if (!Array.isArray(entries) || !entries.length) return;
      busy = true;
      updateSelectionUI();
      const actionLabel = action === "suspend" ? "Suspending" : action === "retire" ? "Retiring" : "Updating";
      setStatus(`${actionLabel} ${entries.length} card${entries.length === 1 ? "" : "s"}\u2026`, "pending");
      try {
        if (action === "suspend") {
          const nowTs = Date.now();
          const touched = /* @__PURE__ */ new Set();
          entries.forEach((entry) => {
            suspendSection(entry.item, entry.sectionKey, nowTs);
            touched.add(entry.item);
          });
          for (const item of touched) {
            await upsertItem(item);
        } else if (action === "retire") {
          const durations = await getReviewDurations();
          const nowTs = Date.now();
          const touched = /* @__PURE__ */ new Set();
          entries.forEach((entry) => {
            rateSection(entry.item, entry.sectionKey, RETIRE_RATING, durations, nowTs);
            touched.add(entry.item);
          });
          for (const item of touched) {
            await upsertItem(item);
        entries.forEach((entry) => {
          const key = entryKey(entry);
          if (key) removeEntryByKey(key);
        setStatus(`${action === "suspend" ? "Suspended" : "Retired"} ${entries.length} card${entries.length === 1 ? "" : "s"}.`, "success");
        await handleEntryChange();
        setActiveNode(activeNodeId, { preserveSelection: false });
      } catch (err) {
        console.error("Failed to update review entries", err);
        setStatus(`Failed to ${action === "suspend" ? "suspend" : "retire"} cards.`, "error");
      } finally {
        busy = false;
        updateSelectionUI();
    }
    reviewAllBtn.addEventListener("click", () => {
      if (busy || typeof startSession !== "function") return;
      const activeNode = nodesById.get(activeNodeId)?.node;
      const entries = Array.isArray(activeNode?.entries) ? activeNode.entries : [];
      if (!entries.length) return;
      const metadata = metadataForNode(activeNode);
      startSession(buildSessionPayload(entries), metadata);
    });
    selectAllBtn.addEventListener("click", () => {
      if (busy) return;
      const activeNode = nodesById.get(activeNodeId)?.node;
      const entries = Array.isArray(activeNode?.entries) ? activeNode.entries : [];
      selection.clear();
      entries.forEach((entry) => {
        const key = entryKey(entry);
        if (key) selection.add(key);
      updateSelectionUI();
    clearSelectionBtn.addEventListener("click", () => {
      if (busy) return;
      clearSelection();
    });
    reviewSelectedBtn.addEventListener("click", () => {
      if (busy || typeof startSession !== "function" || selection.size === 0) return;
      const entries = Array.from(selection).map((key) => entriesByKey.get(key)).filter(Boolean);
      if (!entries.length) return;
      const activeNode = nodesById.get(activeNodeId)?.node;
      const metadata = metadataForNode(activeNode);
      startSession(buildSessionPayload(entries), metadata);
    });
    suspendSelectedBtn.addEventListener("click", async () => {
      if (busy || selection.size === 0) return;
      const entries = Array.from(selection).map((key) => entriesByKey.get(key)).filter(Boolean);
      await performAction("suspend", entries);
    });
    retireSelectedBtn.addEventListener("click", async () => {
      if (busy || selection.size === 0) return;
      const entries = Array.from(selection).map((key) => entriesByKey.get(key)).filter(Boolean);
      await performAction("retire", entries);
    });
    const marquee = document.createElement("div");
    marquee.className = "review-selection-rect";
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
    grid.addEventListener("pointerdown", (event) => {
      if (busy || event.button !== 0) return;
      if (event.target instanceof HTMLElement && event.target.closest(".btn")) return;
      const gridBounds = grid.getBoundingClientRect();
      dragState = {
        id: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        gridBounds,
        active: false
      };
      grid.setPointerCapture(event.pointerId);
      marquee.style.display = "none";
      gridWrap.appendChild(marquee);
    });
    grid.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.id) return;
      const deltaX = event.clientX - dragState.originX;
      const deltaY = event.clientY - dragState.originY;
      if (!dragState.active && Math.hypot(deltaX, deltaY) > 6) {
        dragState.active = true;
        marquee.style.display = "";
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
      if (!dragState || event && event.pointerId !== dragState.id) return;
      if (dragState.active) {
        marquee.style.display = "none";
        marquee.remove();
      }
      dragState = null;
      grid.releasePointerCapture(event?.pointerId ?? 0);
      updateSelectionUI();
    }
    grid.addEventListener("pointerup", endDrag);
    grid.addEventListener("pointercancel", endDrag);
    grid.addEventListener("pointerleave", (event) => {
      if (dragState) endDrag(event);
    });
    renderNav();
    const initialNodeId = findNodeIdForFocus(focus, nodesById) || rootNode.nodeId;
    setActiveNode(initialNodeId, { preserveSelection: true, focusKey: focusEntryKey });
    updateSelectionUI();
    updateNavCount(initialNodeId);
    return win;
  }

  // js/review/context.js
  var UNASSIGNED_BLOCK = "__unassigned";
  var UNASSIGNED_WEEK = "__unassigned";
  var UNASSIGNED_LECTURE = "__unassigned";
  function createBlockTitleMap(blocks = []) {
    const map = /* @__PURE__ */ new Map();
    if (!Array.isArray(blocks)) return map;
    blocks.forEach((block) => {
      if (!block || !block.blockId) return;
      map.set(block.blockId, block.title || block.blockId);
    return map;
  }
  function resolveSectionContexts(item, blockTitles = /* @__PURE__ */ new Map()) {
    const results = [];
    if (!item || typeof item !== "object") return results;
    const lectures = Array.isArray(item.lectures) ? item.lectures.filter(Boolean) : [];
    const blocks = Array.isArray(item.blocks) && item.blocks.length ? item.blocks : [];
    const weeks = Array.isArray(item.weeks) ? item.weeks : [];
    if (lectures.length) {
      const seen = /* @__PURE__ */ new Set();
      lectures.forEach((lecture) => {
        if (!lecture) return;
        const blockId = lecture.blockId || blocks[0] || UNASSIGNED_BLOCK;
        const lectureId = lecture.id != null ? lecture.id : UNASSIGNED_LECTURE;
        const rawWeek = lecture.week;
        const weekNumber = Number.isFinite(Number(rawWeek)) ? Number(rawWeek) : null;
        const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
        const blockTitle = blockTitles.get(blockId) || (blockId === UNASSIGNED_BLOCK ? "Unassigned block" : blockId || "Unassigned block");
        const lectureLabel = lecture.name ? lecture.name : lectureId !== UNASSIGNED_LECTURE ? `Lecture ${lectureId}` : "Unassigned lecture";
        const weekLabel = weekNumber != null ? `Week ${weekNumber}` : "Unassigned week";
        const lectureKey2 = `${blockId || UNASSIGNED_BLOCK}::${lectureId}`;
        const dedupKey = `${blockId || UNASSIGNED_BLOCK}::${weekId}::${lectureKey2}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        results.push({
          blockId: blockId || UNASSIGNED_BLOCK,
          blockTitle,
          weekId,
          weekNumber,
          weekLabel,
          lectureKey: lectureKey2,
          lectureId,
          lectureLabel
        });
      const blockIds = blocks.length ? blocks : [UNASSIGNED_BLOCK];
      const weekValues = weeks.length ? weeks : [null];
      const seen = /* @__PURE__ */ new Set();
      blockIds.forEach((blockRaw) => {
        const blockId = blockRaw || UNASSIGNED_BLOCK;
        const blockTitle = blockTitles.get(blockId) || (blockId === UNASSIGNED_BLOCK ? "Unassigned block" : blockId || "Unassigned block");
        weekValues.forEach((weekValue) => {
          const weekNumber = Number.isFinite(Number(weekValue)) ? Number(weekValue) : null;
          const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
          const weekLabel = weekNumber != null ? `Week ${weekNumber}` : "Unassigned week";
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
            lectureLabel: "Unassigned lecture"
        });
      if (!results.length) {
        results.push({
          blockId: UNASSIGNED_BLOCK,
          blockTitle: "Unassigned block",
          weekId: UNASSIGNED_WEEK,
          weekNumber: null,
          weekLabel: "Unassigned week",
          lectureKey: `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`,
          lectureId: UNASSIGNED_LECTURE,
          lectureLabel: "Unassigned lecture"
        });
    }
    return results;
    blockTitleCache = createBlockTitleMap(blocks);
    return blockTitleCache;
  function titleOf3(item) {
  function formatTimeUntil3(due, now) {
  function formatIntervalMinutes2(minutes) {
  function entryKey2(entry) {
    const key = entryKey2(entry);
      entryMap: /* @__PURE__ */ new Map(),
      nodeId: "root",
      type: "root",
      parent: null,
      children: []
      const contexts = resolveSectionContexts(entry.item, blockTitles);
      entry.contexts = contexts;
      entry.primaryContext = contexts && contexts.length ? contexts[0] : null;
      contexts.forEach((ref) => {
            entryMap: /* @__PURE__ */ new Map(),
            blockId,
            blockTitle: ref.blockTitle,
            nodeId: `block:${blockId}`,
            type: "block",
            parent: root
            title: ref.weekLabel,
            entryMap: /* @__PURE__ */ new Map(),
            blockTitle: ref.blockTitle,
            nodeId: `${blockNode.nodeId}|week:${weekKey}`,
            type: "week",
            parent: blockNode
            entryMap: /* @__PURE__ */ new Map(),
            blockTitle: ref.blockTitle,
            weekLabel: ref.weekLabel,
            nodeId: `${weekNode.nodeId}|lecture:${lectureKey2}`,
            type: "lecture",
            parent: weekNode
      blockNode.children = [];
        weekNode.children = [];
        lectureList.forEach((lectureNode) => {
          lectureNode.children = [];
        });
        weekNode.children = lectureList;
      blockNode.children = weekList;
    root.children = blocksList;
      blocks: blocksList,
      blockTitles
    title.textContent = titleOf3(entry.item);
    meta.textContent = `${getSectionLabel(entry.item, entry.sectionKey)} \u2022 ${formatTimeUntil3(entry.due, now)}`;
        chip.textContent = `Last interval \u2022 ${formatIntervalMinutes2(interval)}`;
        label: `Focused review \u2013 ${titleOf3(entry.item)}`
  function renderHierarchy(container, hierarchy, { startSession, now, redraw }) {
    if (!hierarchy.root.entries.length) {
      renderEmptyState2(container);
      return;
    }
    const tree = document.createElement("div");
    tree.className = "review-tree";
    container.appendChild(tree);
    const refresh = () => {
      if (typeof redraw === "function") redraw();
    const allMeta = { scope: "all", label: "All due cards" };
    const allNode = createCollapsibleNode({
      level: 0,
      title: "All cards",
      count: hierarchy.root.entries.length,
      reviewLabel: "Review all",
      onReview: () => startSession(buildSessionPayload(hierarchy.root.entries), allMeta),
      onMenu: () => openReviewMenu(hierarchy, {
        title: "All due cards",
        now,
        startSession,
        focus: { type: "root" },
        onChange: refresh
      }),
      defaultOpen: true
    });
    tree.appendChild(allNode.element);
    const blockList = document.createElement("div");
    blockList.className = "review-tree-children";
    allNode.content.appendChild(blockList);
    hierarchy.blocks.forEach((blockNode) => {
      const blockMeta = {
        scope: "block",
        label: `Block \u2013 ${blockNode.title}`,
        blockId: blockNode.id
      };
      const block = createCollapsibleNode({
        level: 1,
        title: blockNode.title,
        count: blockNode.entries.length,
        reviewLabel: "Review block",
        onReview: () => startSession(buildSessionPayload(blockNode.entries), blockMeta),
        onMenu: () => openReviewMenu(hierarchy, {
          title: `${blockNode.title} \u2014 cards`,
          now,
          startSession,
          focus: { type: "block", blockId: blockNode.id },
          onChange: refresh
        })
      });
      blockList.appendChild(block.element);
      const weekList = document.createElement("div");
      weekList.className = "review-tree-children";
      block.content.appendChild(weekList);
      blockNode.weeks.forEach((weekNode) => {
        const weekTitle = weekNode.weekNumber != null ? `Week ${weekNode.weekNumber}` : "Unassigned week";
        const weekMeta = {
          scope: "week",
          label: `${weekTitle} \u2013 ${blockNode.title}`,
          blockId: blockNode.id,
          week: weekNode.weekNumber
        };
        const week = createCollapsibleNode({
          level: 2,
          title: weekTitle,
          count: weekNode.entries.length,
          reviewLabel: "Review week",
          onReview: () => startSession(buildSessionPayload(weekNode.entries), weekMeta),
          onMenu: () => openReviewMenu(hierarchy, {
            title: `${blockNode.title} \u2022 ${weekTitle}`,
            now,
            startSession,
            focus: { type: "week", blockId: blockNode.id, weekId: weekNode.id },
            onChange: refresh
          })
        });
        weekList.appendChild(week.element);
        const lectureList = document.createElement("div");
        lectureList.className = "review-lecture-list";
        week.content.appendChild(lectureList);
        weekNode.lectures.forEach((lectureNode) => {
          const lectureRow = document.createElement("div");
          lectureRow.className = "review-lecture-row";
          const info = document.createElement("div");
          info.className = "review-lecture-info";
          const titleEl = document.createElement("div");
          titleEl.className = "review-lecture-title";
          titleEl.textContent = lectureNode.title;
          info.appendChild(titleEl);
          const countEl = document.createElement("div");
          countEl.className = "review-lecture-count";
          countEl.textContent = `${lectureNode.entries.length} card${lectureNode.entries.length === 1 ? "" : "s"}`;
          info.appendChild(countEl);
          lectureRow.appendChild(info);
          const lectureMeta = {
            scope: "lecture",
            label: `${lectureNode.title} \u2013 ${blockNode.title}`,
            lectureId: lectureNode.id,
            blockId: blockNode.id,
            week: lectureNode.weekNumber
          };
          const actions = createNodeActions({
            count: lectureNode.entries.length,
            reviewLabel: "Review lecture",
            onReview: () => startSession(buildSessionPayload(lectureNode.entries), lectureMeta),
            onMenu: () => openReviewMenu(hierarchy, {
              title: `${blockNode.title} \u2022 ${weekTitle} \u2022 ${lectureNode.title}`,
              now,
              startSession,
              focus: {
                type: "lecture",
                blockId: blockNode.id,
                weekId: weekNode.id,
                lectureId: lectureNode.lectureId,
                lectureKey: lectureNode.id
              },
              onChange: refresh
            })
          });
          actions.classList.add("review-lecture-actions");
          lectureRow.appendChild(actions);
          lectureList.appendChild(lectureRow);
        });
      });
    });
  }
  async function renderReview(root, redraw) {
    root.innerHTML = "";
    await hydrateStudySessions().catch((err) => console.error("Failed to load saved sessions", err));
    const cohort = await loadReviewSourceItems();
    if (!Array.isArray(cohort) || !cohort.length) {
      const empty = document.createElement("div");
      empty.className = "review-empty";
      empty.textContent = "Add study cards to start building a review queue.";
      root.appendChild(empty);
      return;
    }
    setCohort(cohort);
    const now = Date.now();
    const dueEntries = collectDueSections(cohort, { now });
    const upcomingEntries = collectUpcomingSections(cohort, { now, limit: 50 });
    const { blocks } = await loadBlockCatalog();
    const blockTitles = ensureBlockTitleMap(blocks);
    const savedEntry = getStudySessionEntry("review");
    const wrapper = document.createElement("section");
    wrapper.className = "card review-panel";
    const backRow = document.createElement("div");
    backRow.className = "review-back-row";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "btn secondary";
    backBtn.textContent = "Back to study";
    backBtn.addEventListener("click", () => {
      setSubtab("Study", "Builder");
      redraw();
    });
    backRow.appendChild(backBtn);
    wrapper.appendChild(backRow);
    const heading = document.createElement("h2");
    heading.textContent = "Review queue";
    wrapper.appendChild(heading);
    const summary = document.createElement("div");
    summary.className = "review-summary";
    summary.textContent = `Cards due: ${dueEntries.length} \u2022 Upcoming: ${upcomingEntries.length}`;
    wrapper.appendChild(summary);
    if (savedEntry?.session) {
      const resumeRow = document.createElement("div");
      resumeRow.className = "review-resume-row";
      const resumeLabel = document.createElement("div");
      resumeLabel.className = "review-resume-label";
      resumeLabel.textContent = savedEntry.metadata?.label || "Saved review session available";
      resumeRow.appendChild(resumeLabel);
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "btn";
      resumeBtn.textContent = "Resume";
      resumeBtn.addEventListener("click", async () => {
        await removeStudySession("review").catch((err) => console.warn("Failed to clear saved review entry", err));
        const restored = Array.isArray(savedEntry.cohort) ? savedEntry.cohort : null;
        if (restored) {
          setCohort(restored);
        }
        setFlashSession(savedEntry.session);
        redraw();
      });
      resumeRow.appendChild(resumeBtn);
      wrapper.appendChild(resumeRow);
    }
    const body = document.createElement("div");
    body.className = "review-body";
    wrapper.appendChild(body);
    const startSession = async (pool, metadata = {}) => {
      if (!pool.length) return;
      await removeStudySession("review").catch((err) => console.warn("Failed to discard existing review save", err));
      setFlashSession({ idx: 0, pool, ratings: {}, mode: "review", metadata });
      redraw();
    };
    if (dueEntries.length) {
      const hierarchy = buildReviewHierarchy(dueEntries, blocks, blockTitles);
      renderHierarchy(body, hierarchy, { startSession, now, redraw });
    } else {
      renderEmptyState2(body);
    }
    if (upcomingEntries.length) {
      renderUpcomingSection(body, upcomingEntries, now, startSession);
    }
    root.appendChild(wrapper);
  }

  // js/ui/components/flashcards.js
  var KIND_ACCENTS = {
    disease: "var(--pink)",
    drug: "var(--blue)",
    concept: "var(--green)"
  };
  var RATING_LABELS = {
    again: "Again",
    hard: "Hard",
    good: "Good",
    easy: "Easy"
  };
  var RATING_CLASS = {
    again: "danger",
    hard: "secondary",
    good: "",
    easy: ""
  };
  function describeDue(due, now) {
    if (!Number.isFinite(due)) return "No due date";
    if (due <= now) {
      const diff2 = Math.max(0, now - due);
      const minutes2 = Math.round(diff2 / (60 * 1e3));
      if (minutes2 < 1) return "Due now";
      if (minutes2 < 60) return `${minutes2} min overdue`;
      const hours2 = Math.round(minutes2 / 60);
      if (hours2 < 24) return `${hours2} hr overdue`;
      const days2 = Math.round(hours2 / 24);
      return `${days2} day${days2 === 1 ? "" : "s"} overdue`;
    }
    const diff = due - now;
    const minutes = Math.round(diff / (60 * 1e3));
    if (minutes < 1) return "Due soon";
    if (minutes < 60) return `Due in ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Due in ${hours} hr`;
    const days = Math.round(hours / 24);
    return `Due in ${days} day${days === 1 ? "" : "s"}`;
  }
  function describeLastReviewed(last, now) {
    if (!Number.isFinite(last) || last <= 0) return "Never reviewed";
    const diff = Math.max(0, now - last);
    const minutes = Math.round(diff / (60 * 1e3));
    if (minutes < 1) return "Reviewed just now";
    if (minutes < 60) return `Reviewed ${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Reviewed ${hours} hr ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `Reviewed ${days} day${days === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `Reviewed ${months} mo ago`;
    const years = Math.round(months / 12);
    return `Reviewed ${years} yr ago`;
  }
  function determineStage(snapshot) {
    if (!snapshot) return { label: "New", variant: "naive" };
    switch (snapshot.phase) {
      case "review":
        return { label: "Mature", variant: "mature" };
      case "learning":
      case "relearning":
        return { label: "Learning", variant: "learning" };
      case "new":
      default:
        return { label: "Naive", variant: "naive" };
    }
  }
  function formatReviewInterval(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return "Now";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hr`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} mo`;
    const years = Math.round(months / 12);
    return `${years} yr`;
  }
  var cachedBlockTitles = null;
  var blockTitlePromise = null;
  async function ensureBlockTitles() {
    if (cachedBlockTitles) return cachedBlockTitles;
    if (!blockTitlePromise) {
      blockTitlePromise = loadBlockCatalog().then(({ blocks }) => {
        cachedBlockTitles = createBlockTitleMap(blocks);
        return cachedBlockTitles;
      }).catch(() => {
        cachedBlockTitles = createBlockTitleMap([]);
        return cachedBlockTitles;
      });
    }
    return blockTitlePromise;
  }
  function getFlashcardAccent(item) {
    if (item?.color) return item.color;
    if (item?.kind && KIND_ACCENTS[item.kind]) return KIND_ACCENTS[item.kind];
    return "var(--accent)";
  }
  function queueStatusLabel(snapshot) {
    if (!snapshot || snapshot.retired) return "Already in review queue";
    const rating = snapshot.lastRating;
    if (rating && RATING_LABELS[rating]) {
      return `In review (${RATING_LABELS[rating]})`;
    }
    return "Already in review queue";
  }
  function ratingKey(item, sectionKey) {
    const id = item?.id || "item";
    return `${id}::${sectionKey}`;
  }
  function sessionEntryAt(session, idx) {
    const pool = Array.isArray(session.pool) ? session.pool : [];
    return pool[idx] || null;
  }
  function normalizeFlashSession(session, fallbackPool, defaultMode = "study") {
    const source = session && typeof session === "object" ? session : {};
    const next = { ...source };
    let changed = !session || typeof session !== "object";
    const fallback = Array.isArray(fallbackPool) ? fallbackPool : [];
    const pool = Array.isArray(source.pool) && source.pool.length ? source.pool : fallback;
    if (source.pool !== pool) {
      next.pool = pool;
      changed = true;
    }
    const ratings = source.ratings && typeof source.ratings === "object" ? source.ratings : {};
    if (source.ratings !== ratings) {
      next.ratings = ratings;
      changed = true;
    }
    let idx = typeof source.idx === "number" && Number.isFinite(source.idx) ? Math.floor(source.idx) : 0;
    if (idx < 0) idx = 0;
    const maxIdx = pool.length ? pool.length - 1 : 0;
    if (idx > maxIdx) idx = maxIdx;
    if (idx !== source.idx) {
      next.idx = idx;
      changed = true;
    }
    const mode = source.mode === "review" ? "review" : defaultMode;
    if (source.mode !== mode) {
      next.mode = mode;
      changed = true;
    }
    return changed ? next : session;
  }
  function renderFlashcards(root, redraw) {
    const fallbackPool = Array.isArray(state.cohort) ? state.cohort : [];
    let active = state.flashSession;
    if (active) {
      const normalized2 = normalizeFlashSession(active, fallbackPool, active.mode === "review" ? "review" : "study");
      if (normalized2 !== active) {
        setFlashSession(normalized2);
        active = normalized2;
      }
    } else {
      active = normalizeFlashSession({ idx: 0, pool: fallbackPool, ratings: {}, mode: "study" }, fallbackPool, "study");
    }
    active.ratings = active.ratings || {};
    const items = Array.isArray(active.pool) && active.pool.length ? active.pool : fallbackPool;
    const resolvePool = () => Array.isArray(active.pool) && active.pool.length ? active.pool : items;
    const commitSession = (patch = {}) => {
      const pool = resolvePool();
      const next2 = { ...active, pool, ...patch };
      if (patch.ratings) {
        next2.ratings = { ...patch.ratings };
      } else {
        next2.ratings = { ...active.ratings };
      }
      active = next2;
      setFlashSession(next2);
    };
    const isReview = active.mode === "review";
    root.innerHTML = "";
    if (!items.length) {
      const msg = document.createElement("div");
      msg.textContent = "No cards selected. Adjust the filters above to add cards.";
      root.appendChild(msg);
      return;
    }
    if (active.idx >= items.length) {
      setFlashSession(null);
      setStudySelectedMode("Flashcards");
      setSubtab("Study", isReview ? "Review" : "Builder");
      if (isReview) {
        removeStudySession("review").catch((err) => console.warn("Failed to clear review session", err));
      } else {
        removeStudySession("flashcards").catch((err) => console.warn("Failed to clear flashcard session", err));
      }
      redraw();
      return;
    }
    const entry = sessionEntryAt(active, active.idx);
    const item = entry && entry.item ? entry.item : entry;
    if (!item) {
      setFlashSession(null);
      redraw();
      return;
    }
    const allowedSections = entry && entry.sections ? entry.sections : null;
    const sections = sectionsForItem(item, allowedSections);
    const primarySectionKey = Array.isArray(entry?.sections) && entry.sections.length ? entry.sections[0] : sections[0]?.key ?? null;
    const primarySnapshot = primarySectionKey ? getSectionStateSnapshot(item, primarySectionKey) : null;
    const nowTs = Date.now();
    const card = document.createElement("section");
    card.className = "card flashcard";
    card.tabIndex = 0;
    const header = document.createElement("div");
    header.className = "flashcard-header";
    const titleGroup = document.createElement("div");
    titleGroup.className = "flashcard-title-group";
    const title = document.createElement("h2");
    title.className = "flashcard-title";
    title.textContent = item.name || item.concept || "";
    titleGroup.appendChild(title);
    header.appendChild(titleGroup);
    const headerActions = document.createElement("div");
    headerActions.className = "flashcard-header-actions";
    if (isReview) {
      const queueBtn = document.createElement("button");
      queueBtn.type = "button";
      queueBtn.className = "btn tertiary flashcard-queue-btn";
      queueBtn.textContent = "Manage queue";
      queueBtn.title = "Open review queue";
      queueBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          const cohort = Array.isArray(state.cohort) ? state.cohort : [];
          const now = Date.now();
          const dueEntries = collectDueSections(cohort, { now });
          const { blocks } = await loadBlockCatalog();
          const blockTitles = createBlockTitleMap(blocks);
          const hierarchy = buildReviewHierarchy(dueEntries, blocks, blockTitles);
          const contexts = resolveSectionContexts(item, blockTitles);
          const preferredContext = contexts.find((ctx) => ctx.lectureId && ctx.lectureId !== UNASSIGNED_LECTURE) || contexts[0] || null;
          let focus = { type: "root" };
          if (preferredContext) {
            if (preferredContext.lectureId && preferredContext.lectureId !== UNASSIGNED_LECTURE) {
              focus = {
                type: "lecture",
                blockId: preferredContext.blockId,
                weekId: preferredContext.weekId,
                lectureId: preferredContext.lectureId,
                lectureKey: preferredContext.lectureKey
              };
            } else if (preferredContext.weekId && preferredContext.weekId !== UNASSIGNED_WEEK) {
              focus = { type: "week", blockId: preferredContext.blockId, weekId: preferredContext.weekId };
            } else if (preferredContext.blockId && preferredContext.blockId !== UNASSIGNED_BLOCK) {
              focus = { type: "block", blockId: preferredContext.blockId };
            }
          }
          const focusEntryKey = primarySectionKey ? ratingKey(item, primarySectionKey) : null;
          openReviewMenu(hierarchy, {
            title: "Review queue",
            now,
            startSession: (pool, metadata = {}) => {
              if (!Array.isArray(pool) || !pool.length) return;
              setFlashSession({ idx: 0, pool, ratings: {}, mode: "review", metadata });
              redraw();
            },
            focus,
            focusEntryKey,
            onChange: () => redraw()
          });
        } catch (err) {
          console.error("Failed to open review menu", err);
        }
      });
      headerActions.appendChild(queueBtn);
    }
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn flashcard-edit-btn";
    editBtn.innerHTML = "\u270F\uFE0F";
    editBtn.title = "Edit card";
    editBtn.setAttribute("aria-label", "Edit card");
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const onSave = typeof redraw === "function" ? () => redraw() : void 0;
      openEditor(item.kind, onSave, item);
    });
    headerActions.appendChild(editBtn);
    header.appendChild(headerActions);
    card.appendChild(header);
    const metaRow = document.createElement("div");
    metaRow.className = "flashcard-meta-row";
    const stageInfo = determineStage(primarySnapshot);
    const stageChip = document.createElement("span");
    stageChip.className = `flashcard-stage-chip stage-${stageInfo.variant}`;
    stageChip.textContent = stageInfo.label;
    metaRow.appendChild(stageChip);
    const dueChip = document.createElement("span");
    dueChip.className = "flashcard-meta-chip";
    dueChip.textContent = describeDue(primarySnapshot?.due, nowTs);
    metaRow.appendChild(dueChip);
    const lastChip = document.createElement("span");
    lastChip.className = "flashcard-meta-chip";
    lastChip.textContent = describeLastReviewed(primarySnapshot?.last, nowTs);
    metaRow.appendChild(lastChip);
    const intervalValue = Number.isFinite(primarySnapshot?.interval) ? primarySnapshot.interval : null;
    const intervalChip = document.createElement("span");
    intervalChip.className = "flashcard-meta-chip";
    intervalChip.textContent = `Interval: ${intervalValue != null ? formatReviewInterval(intervalValue) : "\u2014"}`;
    metaRow.appendChild(intervalChip);
    const contextRow = document.createElement("div");
    contextRow.className = "flashcard-context-row";
    contextRow.textContent = "";
    metaRow.appendChild(contextRow);
    card.appendChild(metaRow);
    const reviewActionButtons = [];
    let reviewActionStatus = null;
    let reviewActionBusy = false;
    const sectionKeysForEntry = () => {
      if (Array.isArray(entry?.sections) && entry.sections.length) {
        return entry.sections.filter(Boolean);
      }
      return sections.map((section) => section.key).filter(Boolean);
    };
    const setReviewStatus = (message, variant = "") => {
      if (!reviewActionStatus) return;
      reviewActionStatus.textContent = message;
      reviewActionStatus.classList.remove("is-error", "is-success", "is-pending");
      if (!variant) return;
      if (variant === "error") {
        reviewActionStatus.classList.add("is-error");
      } else if (variant === "pending") {
        reviewActionStatus.classList.add("is-pending");
      } else if (variant === "success") {
        reviewActionStatus.classList.add("is-success");
    const setReviewBusy = (busy) => {
      reviewActionBusy = busy;
      reviewActionButtons.forEach((btn) => {
        btn.disabled = busy;
      });
    const performInlineReviewAction = async (action) => {
      if (!isReview || reviewActionBusy) return;
      const sectionKeys = sectionKeysForEntry();
      if (!sectionKeys.length) return;
      setReviewBusy(true);
      setReviewStatus(action === "retire" ? "Retiring card\u2026" : "Suspending card\u2026", "pending");
      let sessionCleared = false;
      try {
        const now = Date.now();
        if (action === "retire") {
          const durations = await getReviewDurations();
          sectionKeys.forEach((key) => rateSection(item, key, RETIRE_RATING, durations, now));
        } else {
          sectionKeys.forEach((key) => suspendSection(item, key, now));
        }
        const nextRatings = { ...active.ratings };
        sectionKeys.forEach((key) => {
          delete nextRatings[ratingKey(item, key)];
        });
        await upsertItem(item);
        const nextPool = Array.isArray(active.pool) ? active.pool.slice() : [];
        if (active.idx >= 0 && active.idx < nextPool.length) {
          nextPool.splice(active.idx, 1);
        }
        if (!nextPool.length) {
          sessionCleared = true;
          setReviewStatus("", "");
          setFlashSession(null);
          setSubtab("Study", "Review");
          redraw();
          return;
        }
        const nextIdx = Math.min(active.idx, nextPool.length - 1);
        commitSession({ pool: nextPool, idx: nextIdx, ratings: nextRatings });
        setReviewStatus("", "");
        redraw();
      } catch (err) {
        console.error("Failed to update review card", err);
        const failure = action === "retire" ? "Failed to retire card." : "Failed to suspend card.";
        setReviewStatus(failure, "error");
      } finally {
        if (!sessionCleared) {
          setReviewBusy(false);
    if (isReview) {
      const actionRow = document.createElement("div");
      actionRow.className = "flashcard-review-actions";
      suspendBtn.className = "btn secondary";
      suspendBtn.textContent = "Suspend card";
      suspendBtn.addEventListener("click", () => performInlineReviewAction("suspend"));
      actionRow.appendChild(suspendBtn);
      reviewActionButtons.push(suspendBtn);
      retireBtn.textContent = "Retire card";
      retireBtn.addEventListener("click", () => performInlineReviewAction("retire"));
      actionRow.appendChild(retireBtn);
      reviewActionButtons.push(retireBtn);
      reviewActionStatus = document.createElement("span");
      reviewActionStatus.className = "flashcard-review-status";
      actionRow.appendChild(reviewActionStatus);
      card.appendChild(actionRow);
    }
    ensureBlockTitles().then((blockTitles) => {
      const contexts = resolveSectionContexts(item, blockTitles);
      contextRow.innerHTML = "";
      if (!contexts.length) {
        const chip = document.createElement("span");
        chip.className = "flashcard-context-chip";
        chip.textContent = "Unassigned";
        contextRow.appendChild(chip);
        return;
      }
      contexts.slice(0, 4).forEach((ctx) => {
        const chip = document.createElement("span");
        chip.className = "flashcard-context-chip";
        const labelParts = [];
        if (ctx.blockTitle && ctx.blockId !== UNASSIGNED_BLOCK) labelParts.push(ctx.blockTitle);
        if (ctx.weekLabel && ctx.weekId !== UNASSIGNED_WEEK) labelParts.push(ctx.weekLabel);
        if (ctx.lectureLabel && ctx.lectureId !== UNASSIGNED_LECTURE) labelParts.push(ctx.lectureLabel);
        chip.textContent = labelParts.length ? labelParts.join(" \u2022 ") : ctx.blockTitle || "Unassigned";
        contextRow.appendChild(chip);
      });
      if (contexts.length > 4) {
        const more = document.createElement("span");
        more.className = "flashcard-context-chip is-muted";
        more.textContent = `+${contexts.length - 4} more`;
        contextRow.appendChild(more);
      }
    }).catch(() => {
      contextRow.innerHTML = "";
      const chip = document.createElement("span");
      chip.className = "flashcard-context-chip is-muted";
      chip.textContent = "Context unavailable";
      contextRow.appendChild(chip);
    const durationsPromise = getReviewDurations().catch(() => ({ ...DEFAULT_REVIEW_STEPS }));
    const sectionBlocks = sections.length ? sections : [];
    const sectionRequirements = /* @__PURE__ */ new Map();
    if (!sectionBlocks.length) {
      empty.className = "flash-empty";
      empty.textContent = "No content available for this card.";
      card.appendChild(empty);
    sectionBlocks.forEach(({ key, label, content, extra }) => {
      const ratingId = ratingKey(item, key);
      const previousRating = active.ratings[ratingId] || null;
      const snapshot = getSectionStateSnapshot(item, key);
      const lockedByQueue = !isReview && Boolean(snapshot && snapshot.last && !snapshot.retired);
      const alreadyQueued = !isReview && Boolean(snapshot && snapshot.last && !snapshot.retired);
      const requiresRating = isReview || !alreadyQueued;
      sectionRequirements.set(key, requiresRating);
      const sec = document.createElement("div");
      sec.className = "flash-section";
      if (extra) sec.classList.add("flash-section-extra");
      sec.setAttribute("role", "button");
      sec.tabIndex = 0;
      const head = document.createElement("div");
      head.className = "flash-heading";
      head.textContent = label;
      const body = document.createElement("div");
      body.className = "flash-body";
      renderRichText(body, content || "", { clozeMode: "interactive" });
      const ratingRow = document.createElement("div");
      ratingRow.className = "flash-rating";
      const ratingButtons = document.createElement("div");
      ratingButtons.className = "flash-rating-options";
      const status = document.createElement("span");
      status.className = "flash-rating-status";
      let ratingLocked = lockedByQueue;
      const selectRating = (value) => {
        active.ratings[ratingId] = value;
        Array.from(ratingButtons.querySelectorAll("button")).forEach((btn) => {
          const btnValue = btn.dataset.value;
          const isSelected = btnValue === value;
          btn.classList.toggle("is-selected", isSelected);
          if (isSelected) {
            ratingButtons.dataset.selected = value;
          } else if (ratingButtons.dataset.selected === btnValue) {
            delete ratingButtons.dataset.selected;
          }
          btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
        });
        status.classList.remove("is-error");
        commitSession({ ratings: { ...active.ratings } });
      const ratingPreviews = /* @__PURE__ */ new Map();
      const updatePreviews = (durations) => {
        if (!durations) return;
        const nowTs2 = Date.now();
        REVIEW_RATINGS.forEach((ratingValue) => {
          const target = ratingPreviews.get(ratingValue);
          if (!target) return;
          try {
            const projection = projectSectionRating(item, key, ratingValue, durations, nowTs2);
            if (!projection || !Number.isFinite(projection.due)) {
              target.textContent = "";
              return;
            }
            const minutes = Math.max(0, Math.round((projection.due - nowTs2) / (60 * 1e3)));
            target.textContent = formatReviewInterval(minutes);
          } catch (err) {
            target.textContent = "";
          }
        });
      };
      const renderPreviews = async () => {
        try {
          const durations = await durationsPromise;
          updatePreviews(durations);
        } catch (err) {
        }
      };
      const handleRating = async (value) => {
        if (ratingLocked) return;
        const durations = await durationsPromise;
        setToggleState(sec, true, "revealed");
        ratingRow.classList.add("is-saving");
        status.textContent = "Saving\u2026";
        status.classList.remove("is-error");
        try {
          rateSection(item, key, value, durations, Date.now());
          await upsertItem(item);
          selectRating(value);
          status.textContent = "Saved";
          status.classList.remove("is-error");
          updatePreviews(durations);
        } catch (err) {
          console.error("Failed to record rating", err);
          status.textContent = "Save failed";
          status.classList.add("is-error");
        } finally {
          ratingRow.classList.remove("is-saving");
        }
      };
      REVIEW_RATINGS.forEach((value) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.value = value;
        btn.dataset.rating = value;
        btn.className = "flash-rating-btn";
        const variant = RATING_CLASS[value];
        if (variant) btn.classList.add(variant);
        btn.setAttribute("aria-pressed", "false");
        const label2 = document.createElement("span");
        label2.className = "flash-rating-label";
        label2.textContent = RATING_LABELS[value];
        const preview = document.createElement("span");
        preview.className = "flash-rating-preview";
        btn.appendChild(label2);
        btn.appendChild(preview);
        ratingPreviews.set(value, preview);
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          handleRating(value);
        });
        btn.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleRating(value);
          }
        });
        ratingButtons.appendChild(btn);
      renderPreviews();
      const unlockRating = () => {
        if (!ratingLocked) return;
        ratingLocked = false;
        ratingRow.classList.remove("is-locked");
        ratingButtons.hidden = false;
        status.classList.remove("flash-rating-status-action");
        status.removeAttribute("role");
        status.removeAttribute("tabindex");
        status.textContent = previousRating ? "Update rating" : "Select a rating (optional)";
      };
      if (lockedByQueue) {
        ratingLocked = true;
        ratingRow.classList.add("is-locked");
        ratingButtons.hidden = true;
        const label2 = queueStatusLabel(snapshot);
        status.textContent = `${label2} \u2014 click to adjust`;
        status.classList.add("flash-rating-status-action");
        status.setAttribute("role", "button");
        status.setAttribute("tabindex", "0");
        status.setAttribute("aria-label", "Update review rating");
        status.addEventListener("click", (event) => {
          event.stopPropagation();
          unlockRating();
        status.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            unlockRating();
          }
      } else if (previousRating) {
        status.textContent = "Saved";
      } else {
        status.textContent = "Select a rating (optional)";
      }
      if (previousRating) {
        selectRating(previousRating);
      }
      ratingRow.appendChild(ratingButtons);
      ratingRow.appendChild(status);
      setToggleState(sec, false, "revealed");
      const toggleReveal = () => {
        if (sec.classList.contains("flash-section-disabled")) return;
        if (sec.contains(document.activeElement) && document.activeElement?.tagName === "BUTTON") return;
        const next2 = sec.dataset.active !== "true";
        setToggleState(sec, next2, "revealed");
      };
      sec.addEventListener("click", (event) => {
        if (event.target instanceof HTMLElement) {
          if (event.target.closest(".flash-rating")) return;
          if (event.target.closest("[data-cloze]")) return;
        }
        toggleReveal();
      });
      sec.addEventListener("keydown", (e) => {
        if (e.target instanceof HTMLElement && e.target.closest(".flash-rating")) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleReveal();
        }
      sec.appendChild(head);
      sec.appendChild(body);
      sec.appendChild(ratingRow);
      card.appendChild(sec);
    const controls = document.createElement("div");
    controls.className = "row flash-controls";
    const prev = document.createElement("button");
    prev.className = "btn";
    prev.textContent = "Prev";
    prev.disabled = active.idx === 0;
    prev.addEventListener("click", () => {
      if (active.idx > 0) {
        commitSession({ idx: active.idx - 1 });
        redraw();
      }
    });
    controls.appendChild(prev);
    const next = document.createElement("button");
    next.className = "btn";
    const isLast = active.idx >= items.length - 1;
    next.textContent = isLast ? isReview ? "Finish review" : "Finish" : "Next";
    next.addEventListener("click", () => {
      const pool = Array.isArray(active.pool) ? active.pool : items;
      const idx = active.idx + 1;
      if (idx >= items.length) {
        setFlashSession(null);
      } else {
        commitSession({ idx });
      }
    controls.appendChild(next);
    if (!isReview) {
      const saveExit = document.createElement("button");
      saveExit.className = "btn secondary";
      saveExit.textContent = "Save & close";
      saveExit.addEventListener("click", async () => {
        const original = saveExit.textContent;
        saveExit.disabled = true;
        saveExit.textContent = "Saving\u2026";
        try {
          const pool = resolvePool();
          await persistStudySession("flashcards", {
            session: { ...active, idx: active.idx, pool, ratings: { ...active.ratings || {} } },
            cohort: pool
          });
          setFlashSession(null);
          setStudySelectedMode("Flashcards");
          setSubtab("Study", "Builder");
          redraw();
        } catch (err) {
          console.error("Failed to save flashcard progress", err);
          saveExit.textContent = "Save failed";
          setTimeout(() => {
            saveExit.textContent = original;
          }, 2e3);
        } finally {
          saveExit.disabled = false;
      controls.appendChild(saveExit);
      const saveExit = document.createElement("button");
      saveExit.className = "btn secondary";
      saveExit.textContent = "Pause & save";
      saveExit.addEventListener("click", async () => {
        const original = saveExit.textContent;
        saveExit.disabled = true;
        saveExit.textContent = "Saving\u2026";
        try {
          const pool = resolvePool();
          await persistStudySession("review", {
            session: { ...active, idx: active.idx, pool, ratings: { ...active.ratings || {} } },
            cohort: state.cohort,
            metadata: active.metadata || { label: "Review session" }
          });
          setFlashSession(null);
          setSubtab("Study", "Review");
          redraw();
        } catch (err) {
          console.error("Failed to save review session", err);
          saveExit.textContent = "Save failed";
          setTimeout(() => {
            saveExit.textContent = original;
          }, 2e3);
        } finally {
          saveExit.disabled = false;
        }
      });
      controls.appendChild(saveExit);
    card.appendChild(controls);
    root.appendChild(card);
    card.focus();
    card.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") {
        next.click();
      } else if (e.key === "ArrowLeft") {
        prev.click();
      }
    });
    const accent = getFlashcardAccent(item);
    card.style.setProperty("--flash-accent", accent);
    card.style.setProperty("--flash-accent-soft", `color-mix(in srgb, ${accent} 22%, rgba(148, 163, 184, 0.18))`);
    card.style.setProperty("--flash-accent-strong", `color-mix(in srgb, ${accent} 34%, rgba(15, 23, 42, 0.1))`);
    card.style.setProperty("--flash-accent-border", `color-mix(in srgb, ${accent} 28%, rgba(148, 163, 184, 0.42))`);
  function titleOf4(item) {
      title: titleOf4(it),
      lower: titleOf4(it).toLowerCase()
      feedback.textContent = `Answer: ${titleOf4(item)}`;
      const revealValue = titleOf4(item);
      feedback.textContent = `Answer: ${titleOf4(item)}`;
      const correct = titleOf4(item).toLowerCase();
    const items = (mapState.visibleItems || []).map((item) => ({ id: item.id, label: titleOf5(item) || "" })).filter((entry) => entry.label && entry.label.toLowerCase().includes(lower));
      const available = items.filter((it) => !manualSet.has(it.id)).filter((it) => !query || titleOf5(it).toLowerCase().includes(query)).sort((a, b) => titleOf5(a).localeCompare(titleOf5(b)));
        btn.textContent = titleOf5(it) || it.id;
        label.textContent = titleOf5(item) || id;
        removeBtn.setAttribute("aria-label", `Remove ${titleOf5(item) || "item"} from this map`);
    let match = items.find((it) => (titleOf5(it) || "").toLowerCase() === lower);
      match = items.find((it) => (titleOf5(it) || "").toLowerCase().includes(lower));
      updateSearchFeedback(`Centered on ${titleOf5(match)}.`, "success");
          if (confirm(`Remove ${titleOf5(it)} from the map?`)) {
          if (confirm(`Remove ${titleOf5(it)} from the map?`)) {
        hiddenNodes.slice().sort((a, b) => titleOf5(a).localeCompare(titleOf5(b))).forEach((it) => {
          item.textContent = titleOf5(it) || it.id;
          label.textContent = `${titleOf5(link.a)} \u2194 ${titleOf5(link.b)}`;
    ghost.textContent = titleOf5(item) || item.id;
    if (!confirm(`Create a link between ${titleOf5(from)} and ${titleOf5(to)}?`)) {
      title: `Link ${titleOf5(source) || "concept"}`,
        const label = (titleOf5(item) || "").toLowerCase();
      }).sort((a, b) => (titleOf5(a) || "").localeCompare(titleOf5(b) || "")).slice(0, 15);
        name.textContent = titleOf5(target) || target.id;
  function titleOf5(item) {
