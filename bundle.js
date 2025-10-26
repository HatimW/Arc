  // js/ui/components/review.js
  var blockTitleCache = null;
  function ensureBlockTitleMap(blocks) {
    if (blockTitleCache) return blockTitleCache;
    const map = /* @__PURE__ */ new Map();
    blocks.forEach((block) => {
      if (!block || !block.blockId) return;
      map.set(block.blockId, block.title || block.blockId);
    });
    blockTitleCache = map;
    return map;
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
  function entryKey(entry) {
    if (!entry) return null;
    const itemId = entry.itemId || entry.item?.id || entry.item?.slug || entry.item?.name || "item";
    return `${itemId}::${entry.sectionKey}`;
  function describePhase(phase) {
    switch (phase) {
      case "learning":
        return "Learning";
      case "relearning":
        return "Relearning";
      case "review":
        return "Review";
      case "new":
        return "New";
      default:
        return "";
  function buildSessionPayload(entries) {
    return entries.map((entry) => ({ item: entry.item, sections: [entry.sectionKey] }));
  function renderEmptyState2(container) {
    const empty = document.createElement("div");
    empty.className = "review-empty";
    empty.textContent = "No cards are due right now. Nice work!";
    container.appendChild(empty);
  var UNASSIGNED_BLOCK = "__unassigned";
  var UNASSIGNED_WEEK = "__unassigned";
  var UNASSIGNED_LECTURE = "__unassigned";
  function registerEntry(bucket, entry) {
    if (!bucket || !entry) return;
    if (!bucket.entryMap) bucket.entryMap = /* @__PURE__ */ new Map();
    const key = entryKey(entry);
    if (!key || bucket.entryMap.has(key)) return;
    bucket.entryMap.set(key, entry);
  function finalizeEntries(bucket) {
    if (!bucket) return;
    const entries = bucket.entryMap ? Array.from(bucket.entryMap.values()) : [];
    bucket.entries = entries;
    delete bucket.entryMap;
  }
  function createBlockOrder(blocks = []) {
    const order = /* @__PURE__ */ new Map();
    if (!Array.isArray(blocks)) return order;
    blocks.forEach((block, index) => {
      if (!block || !block.blockId) return;
      order.set(block.blockId, index);
    });
    return order;
  }
  function resolveEntryRefs(entry, blockTitles) {
    const item = entry?.item || {};
    const lectures = Array.isArray(item.lectures) ? item.lectures.filter(Boolean) : [];
    const blocks = Array.isArray(item.blocks) && item.blocks.length ? item.blocks : [];
    const weeks = Array.isArray(item.weeks) ? item.weeks : [];
    const results = [];
    if (lectures.length) {
      const seen = /* @__PURE__ */ new Set();
      lectures.forEach((lec) => {
        if (!lec) return;
        const blockId = lec.blockId || blocks[0] || UNASSIGNED_BLOCK;
        const lectureId = lec.id != null ? lec.id : UNASSIGNED_LECTURE;
        const rawWeek = lec.week;
        const weekNumber = Number.isFinite(Number(rawWeek)) ? Number(rawWeek) : null;
        const weekId = weekNumber != null ? String(weekNumber) : UNASSIGNED_WEEK;
        const blockTitle = blockTitles.get(blockId) || (blockId === UNASSIGNED_BLOCK ? "Unassigned block" : blockId || "Unassigned block");
        const lectureLabel = lec.name ? lec.name : lectureId !== UNASSIGNED_LECTURE ? `Lecture ${lectureId}` : "Unassigned lecture";
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
        });
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
  }
  function buildReviewHierarchy(entries, blocks, blockTitles) {
    const order = createBlockOrder(blocks);
    const root = {
      id: "all",
      title: "All cards",
      blocks: /* @__PURE__ */ new Map(),
      entryMap: /* @__PURE__ */ new Map()
    };
    const blockMap = root.blocks;
    const contexts = /* @__PURE__ */ new Map();
    const registerContext = (entry, context) => {
      const key = entryKey(entry);
      if (!key) return;
      if (!contexts.has(key)) {
        contexts.set(key, []);
      }
      const list = contexts.get(key);
      const exists = list.some((existing) => existing.blockId === context.blockId && existing.weekId === context.weekId && existing.lectureKey === context.lectureKey);
      if (!exists) {
        list.push(context);
    entries.forEach((entry) => {
      registerEntry(root, entry);
      const refs = resolveEntryRefs(entry, blockTitles);
      refs.forEach((ref) => {
        const blockId = ref.blockId || UNASSIGNED_BLOCK;
        let blockNode = blockMap.get(blockId);
        if (!blockNode) {
          blockNode = {
            id: blockId,
            title: ref.blockTitle,
            order: order.has(blockId) ? order.get(blockId) : Number.MAX_SAFE_INTEGER,
            weeks: /* @__PURE__ */ new Map(),
            entryMap: /* @__PURE__ */ new Map()
          };
          blockMap.set(blockId, blockNode);
        registerEntry(blockNode, entry);
        const weekKey = ref.weekId || UNASSIGNED_WEEK;
        let weekNode = blockNode.weeks.get(weekKey);
        if (!weekNode) {
          weekNode = {
            id: weekKey,
            blockId,
            label: ref.weekLabel,
            weekNumber: ref.weekNumber,
            lectures: /* @__PURE__ */ new Map(),
            entryMap: /* @__PURE__ */ new Map()
          };
          blockNode.weeks.set(weekKey, weekNode);
        registerEntry(weekNode, entry);
        const lectureKey2 = ref.lectureKey || `${blockId}::${UNASSIGNED_LECTURE}`;
        let lectureNode = weekNode.lectures.get(lectureKey2);
        if (!lectureNode) {
          lectureNode = {
            id: lectureKey2,
            blockId,
            weekId: weekKey,
            weekNumber: ref.weekNumber,
            title: ref.lectureLabel,
            lectureId: ref.lectureId,
            entryMap: /* @__PURE__ */ new Map()
          };
          weekNode.lectures.set(lectureKey2, lectureNode);
        registerEntry(lectureNode, entry);
        registerContext(entry, {
          blockId,
          blockTitle: blockNode.title,
          weekId: weekKey,
          weekLabel: weekNode.label,
          lectureKey: lectureKey2,
          lectureTitle: lectureNode.title
        });
    const blocksList = Array.from(blockMap.values());
    blocksList.forEach((blockNode) => {
      const weekList = Array.from(blockNode.weeks.values());
      weekList.forEach((weekNode) => {
        const lectureList = Array.from(weekNode.lectures.values());
        lectureList.forEach((lectureNode) => finalizeEntries(lectureNode));
        lectureList.sort((a, b) => a.title.localeCompare(b.title, void 0, { sensitivity: "base" }));
        weekNode.lectures = lectureList;
        finalizeEntries(weekNode);
      weekList.sort((a, b) => {
        const aNum = a.weekNumber;
        const bNum = b.weekNumber;
        if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
          if (aNum !== bNum) return aNum - bNum;
        } else if (Number.isFinite(aNum)) {
          return -1;
        } else if (Number.isFinite(bNum)) {
          return 1;
        return a.label.localeCompare(b.label, void 0, { sensitivity: "base" });
      blockNode.weeks = weekList;
      finalizeEntries(blockNode);
    blocksList.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.title.localeCompare(b.title, void 0, { sensitivity: "base" });
    finalizeEntries(root);
    return {
      root,
      blocks: blocksList,
      contexts
    };
  function createNodeActions({
    count = 0,
    reviewLabel = "Review",
    onReview,
    onMenu,
    preventToggle = false
  }) {
    const actions = document.createElement("div");
    actions.className = "review-node-actions";
    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "btn tertiary review-node-action";
    reviewBtn.textContent = `${reviewLabel}${count ? ` (${count})` : ""}`;
    reviewBtn.disabled = !count;
    reviewBtn.addEventListener("click", (event) => {
      if (preventToggle) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!count) return;
      if (typeof onReview === "function") onReview();
    });
    actions.appendChild(reviewBtn);
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "icon-button review-node-gear";
    menuBtn.innerHTML = "\u2699";
    menuBtn.title = "View entries";
    menuBtn.disabled = !count;
    menuBtn.addEventListener("click", (event) => {
      if (preventToggle) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (typeof onMenu === "function") onMenu();
    });
    actions.appendChild(menuBtn);
    return actions;
  function createCollapsibleNode({
    level = 0,
    title,
    count,
    reviewLabel,
    onReview,
    onMenu,
    defaultOpen = false
  }) {
    const details = document.createElement("details");
    details.className = `review-node review-node-level-${level}`;
    if (defaultOpen) details.open = true;
    const summary = document.createElement("summary");
    summary.className = "review-node-summary";
    const header = document.createElement("div");
    header.className = "review-node-header";
    const titleEl = document.createElement("div");
    titleEl.className = "review-node-title";
    titleEl.textContent = title;
    const countEl = document.createElement("span");
    countEl.className = "review-node-count";
    countEl.textContent = `${count} card${count === 1 ? "" : "s"}`;
    header.appendChild(titleEl);
    header.appendChild(countEl);
    summary.appendChild(header);
    const actions = createNodeActions({
      count,
      reviewLabel,
      onReview,
      onMenu,
      preventToggle: true
    });
    summary.appendChild(actions);
    details.appendChild(summary);
    const content = document.createElement("div");
    content.className = "review-node-content";
    details.appendChild(content);
    return { element: details, content, actions };
  function createUpcomingEntry(entry, now, startSession) {
    const item = document.createElement("li");
    item.className = "review-entry is-upcoming";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "review-entry-trigger";
    const title = document.createElement("div");
    title.className = "review-entry-title";
    title.textContent = titleOf2(entry.item);
    trigger.appendChild(title);
    const meta = document.createElement("div");
    meta.className = "review-entry-meta";
    meta.textContent = `${getSectionLabel(entry.item, entry.sectionKey)} \u2022 ${formatTimeUntil2(entry.due, now)}`;
    trigger.appendChild(meta);
    const phaseLabel = describePhase(entry.phase);
    const interval = entry?.state?.interval;
    if (phaseLabel || Number.isFinite(interval)) {
      const extra = document.createElement("div");
      extra.className = "review-entry-extra";
      if (phaseLabel) {
        const chip = document.createElement("span");
        chip.className = "review-entry-chip";
        chip.textContent = phaseLabel;
        extra.appendChild(chip);
      }
      if (Number.isFinite(interval) && interval > 0) {
        const chip = document.createElement("span");
        chip.className = "review-entry-chip";
        chip.textContent = `Last interval \u2022 ${formatIntervalMinutes(interval)}`;
        extra.appendChild(chip);
      }
      trigger.appendChild(extra);
    }
    trigger.addEventListener("click", () => {
      if (typeof startSession !== "function") return;
      startSession(buildSessionPayload([entry]), {
        scope: "single",
        label: `Focused review \u2013 ${titleOf2(entry.item)}`
      });
    });
    item.appendChild(trigger);
    return item;
  function renderUpcomingSection(container, upcomingEntries, now, startSession) {
    if (!Array.isArray(upcomingEntries) || !upcomingEntries.length) return;
    const section = document.createElement("div");
    section.className = "review-upcoming-section";
    const heading = document.createElement("div");
    heading.className = "review-upcoming-title";
    heading.textContent = "Upcoming cards";
    section.appendChild(heading);
    const note = document.createElement("div");
    note.className = "review-upcoming-note";
    note.textContent = `Next ${upcomingEntries.length} card${upcomingEntries.length === 1 ? "" : "s"} in the queue`;
    section.appendChild(note);
    const actions = document.createElement("div");
    actions.className = "review-upcoming-actions";
    const startUpcomingBtn = document.createElement("button");
    startUpcomingBtn.type = "button";
    startUpcomingBtn.className = "btn secondary";
    startUpcomingBtn.textContent = `Review upcoming (${upcomingEntries.length})`;
    startUpcomingBtn.addEventListener("click", () => {
      if (!upcomingEntries.length) return;
      if (typeof startSession === "function") {
        startSession(buildSessionPayload(upcomingEntries), { scope: "upcoming", label: "Upcoming cards" });
      }
    actions.appendChild(startUpcomingBtn);
    section.appendChild(actions);
    const list = document.createElement("ul");
    list.className = "review-entry-list";
    upcomingEntries.forEach((entry) => {
      list.appendChild(createUpcomingEntry(entry, now, startSession));
    });
    section.appendChild(list);
    container.appendChild(section);
  function openEntryManager(hierarchy, {
    title = "Entries",
    now = Date.now(),
    startSession,
    metadata = {},
    focus = {},
    highlightEntryKey = null,
    onChange
  } = {}) {
    const win = createFloatingWindow({ title, width: 920 });
    const body = win.querySelector(".floating-body");
    body.classList.add("review-popup");
    const contextsMap = hierarchy?.contexts instanceof Map ? hierarchy.contexts : /* @__PURE__ */ new Map();
    const allEntries = Array.isArray(hierarchy?.root?.entries) ? hierarchy.root.entries.slice() : [];
    const sorted = allEntries.slice().sort((a, b) => (a.due || 0) - (b.due || 0));
    const entriesByKey = /* @__PURE__ */ new Map();
    const remainingKeys = /* @__PURE__ */ new Set();
    sorted.forEach((entry) => {
      const key = entryKey(entry);
      if (!key) return;
      entriesByKey.set(key, entry);
      remainingKeys.add(key);
    });
    const status = document.createElement("div");
    status.className = "review-popup-status";
    const updateStatus = (message = "", variant = "") => {
      status.textContent = message;
      status.classList.remove("is-error", "is-success");
      if (variant) {
        status.classList.add(variant === "error" ? "is-error" : "is-success");
      }
    };
    const emptyState = document.createElement("div");
    emptyState.className = "review-popup-empty";
    emptyState.textContent = "No entries available.";
    emptyState.hidden = true;
    const layout = document.createElement("div");
    layout.className = "review-entry-layout";
    body.appendChild(layout);
    const nav = document.createElement("nav");
    nav.className = "review-entry-nav";
    layout.appendChild(nav);
    const navHeader = document.createElement("div");
    navHeader.className = "review-entry-nav-header";
    navHeader.textContent = "Quick nav";
    nav.appendChild(navHeader);
    const navList = document.createElement("div");
    navList.className = "review-entry-nav-list";
    nav.appendChild(navList);
    const content = document.createElement("div");
    content.className = "review-entry-content";
    layout.appendChild(content);
    const controls = document.createElement("div");
    controls.className = "review-popup-controls review-entry-controls";
    content.appendChild(controls);
    const filterLabel = document.createElement("div");
    filterLabel.className = "review-entry-filter-label";
    controls.appendChild(filterLabel);
    const reviewFilteredBtn = document.createElement("button");
    reviewFilteredBtn.type = "button";
    reviewFilteredBtn.className = "btn";
    controls.appendChild(reviewFilteredBtn);
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "btn tertiary";
    selectAllBtn.textContent = "Select all";
    controls.appendChild(selectAllBtn);
    const clearSelectionBtn = document.createElement("button");
    clearSelectionBtn.type = "button";
    clearSelectionBtn.className = "btn tertiary";
    clearSelectionBtn.textContent = "Clear selection";
    controls.appendChild(clearSelectionBtn);
    const table = document.createElement("table");
    table.className = "review-entry-table modern";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Select", "Card", "Part", "Block", "Week", "Lecture", "Stage", "Due", "Time", "Actions"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const bodyRows = document.createElement("tbody");
    table.appendChild(bodyRows);
    content.appendChild(table);
    content.appendChild(emptyState);
    content.appendChild(status);
    const selectionBar = document.createElement("div");
    selectionBar.className = "review-selection-bar";
    selectionBar.hidden = true;
    const selectionInfo = document.createElement("div");
    selectionInfo.className = "review-selection-info";
    selectionBar.appendChild(selectionInfo);
    const selectionControls = document.createElement("div");
    selectionControls.className = "review-selection-actions";
    const suspendSelectedBtn = document.createElement("button");
    suspendSelectedBtn.type = "button";
    suspendSelectedBtn.className = "btn secondary";
    suspendSelectedBtn.textContent = "Suspend selected";
    selectionControls.appendChild(suspendSelectedBtn);
    const retireSelectedBtn = document.createElement("button");
    retireSelectedBtn.type = "button";
    retireSelectedBtn.className = "btn danger";
    retireSelectedBtn.textContent = "Retire selected";
    selectionControls.appendChild(retireSelectedBtn);
    selectionBar.appendChild(selectionControls);
    const selectionStatus = document.createElement("div");
    selectionStatus.className = "review-selection-status";
    selectionBar.appendChild(selectionStatus);
    content.appendChild(selectionBar);
    const nodeCounts = /* @__PURE__ */ new Map();
    const navCountElements = /* @__PURE__ */ new Map();
    const navMetadata = /* @__PURE__ */ new Map();
    const rootNodeKey = "root";
    const blockNodeKey = (blockId) => `block:${blockId}`;
    const weekNodeKey = (blockId, weekId) => `week:${blockId}::${weekId}`;
    const lectureNodeKey = (lectureKey2) => `lecture:${lectureKey2}`;
    const adjustCount = (nodeKey, delta) => {
      const current = nodeCounts.get(nodeKey) || 0;
      const next = Math.max(0, current + delta);
      nodeCounts.set(nodeKey, next);
      const badge = navCountElements.get(nodeKey);
      if (badge) badge.textContent = String(next);
    };
    const getEntryContexts = (entry) => {
      const key = entryKey(entry);
      if (!key) return [];
      const ctx = contextsMap.get(key);
      if (Array.isArray(ctx) && ctx.length) return ctx;
      return [{
        blockId: UNASSIGNED_BLOCK,
        blockTitle: "Unassigned block",
        weekId: UNASSIGNED_WEEK,
        weekLabel: "Unassigned week",
        lectureKey: `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`,
        lectureTitle: "Unassigned lecture"
      }];
    };
    sorted.forEach((entry) => {
      const key = entryKey(entry);
      if (!key) return;
      adjustCount(rootNodeKey, 1);
      const contexts = getEntryContexts(entry);
      contexts.forEach((ctx) => {
        adjustCount(blockNodeKey(ctx.blockId), 1);
        adjustCount(weekNodeKey(ctx.blockId, ctx.weekId), 1);
        adjustCount(lectureNodeKey(ctx.lectureKey), 1);
      });
    });
    const rootMeta = { scope: "all", label: "All due cards" };
    navMetadata.set(rootNodeKey, rootMeta);
    const selectedKeys = /* @__PURE__ */ new Set();
    const rowsByKey = /* @__PURE__ */ new Map();
    let cachedDurations2 = null;
    const ensureDurations = async () => {
      if (cachedDurations2) return cachedDurations2;
      cachedDurations2 = await getReviewDurations();
      return cachedDurations2;
    };
    const handleEntryChange = async () => {
      if (typeof onChange === "function") {
        try {
          await onChange();
        } catch (err) {
          console.error(err);
        }
      }
    };
    const matchesFilter2 = (entry, filter) => {
      if (!filter || filter.scope === "all") return true;
      const contexts = getEntryContexts(entry);
      if (!contexts.length) return filter.scope === "all";
      return contexts.some((ctx) => {
        if (filter.scope === "block") {
          return ctx.blockId === filter.blockId;
        }
        if (filter.scope === "week") {
          return ctx.blockId === filter.blockId && ctx.weekId === filter.weekId;
        }
        if (filter.scope === "lecture") {
          return ctx.lectureKey === filter.lectureKey;
        }
        return true;
    };
    const listFilteredEntries = (filter) => sorted.filter((entry) => {
      const key = entryKey(entry);
      if (!key || !remainingKeys.has(key)) return false;
      return matchesFilter2(entry, filter);
    });
    const normalizeFilter2 = (input = {}) => {
      const scope = ["block", "week", "lecture"].includes(input.scope) ? input.scope : "all";
      if (scope === "block") {
        return { scope, blockId: input.blockId ?? UNASSIGNED_BLOCK };
      }
      if (scope === "week") {
        const blockId = input.blockId ?? UNASSIGNED_BLOCK;
        const weekId = input.weekId ?? (input.week != null ? String(input.week) : UNASSIGNED_WEEK);
        return { scope, blockId, weekId };
      }
      if (scope === "lecture") {
        const lectureKey2 = input.lectureKey || input.lectureId || input.lecture || `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`;
        return { scope, lectureKey: lectureKey2, blockId: input.blockId ?? UNASSIGNED_BLOCK, weekId: input.weekId ?? (input.week != null ? String(input.week) : UNASSIGNED_WEEK) };
      }
      return { scope: "all" };
    };
    const nodeKeyForFilter = (filter) => {
      if (!filter) return rootNodeKey;
      switch (filter.scope) {
        case "block":
          return blockNodeKey(filter.blockId ?? UNASSIGNED_BLOCK);
        case "week":
          return weekNodeKey(filter.blockId ?? UNASSIGNED_BLOCK, filter.weekId ?? UNASSIGNED_WEEK);
        case "lecture":
          return lectureNodeKey(filter.lectureKey ?? `${UNASSIGNED_BLOCK}::${UNASSIGNED_LECTURE}`);
        default:
          return rootNodeKey;
      }
    };
    const initialFilter = (() => {
      if (focus && focus.scope) {
        return normalizeFilter2(focus);
      }
      if (highlightEntryKey && entriesByKey.has(highlightEntryKey)) {
        const entry = entriesByKey.get(highlightEntryKey);
        const contexts = getEntryContexts(entry);
        if (contexts.length) {
          const ctx = contexts[0];
          return { scope: "lecture", lectureKey: ctx.lectureKey, blockId: ctx.blockId, weekId: ctx.weekId };
        }
      }
      return { scope: "all" };
    })();
    let currentFilter = initialFilter;
    let activeNodeKey = nodeKeyForFilter(currentFilter);
    let currentMetadata = navMetadata.get(activeNodeKey) || metadata || { scope: "all", label: "All due cards" };
    const setActiveNav = (nodeKey) => {
      const prev = navList.querySelector(".review-entry-nav-btn.is-active");
      if (prev) prev.classList.remove("is-active");
      const next = navList.querySelector(`.review-entry-nav-btn[data-node-key="${nodeKey}"]`);
      if (next) next.classList.add("is-active");
    };
    const updateFilterLabel = () => {
      filterLabel.textContent = currentMetadata?.label || "All due cards";
    };
    const updateReviewButton = () => {
      const filtered = listFilteredEntries(currentFilter);
      reviewFilteredBtn.textContent = filtered.length ? `Start review (${filtered.length})` : "Start review";
      reviewFilteredBtn.disabled = filtered.length === 0;
      selectAllBtn.disabled = filtered.length === 0;
    };
    const updateSelectionBar = () => {
      const count = selectedKeys.size;
      selectionBar.hidden = count === 0;
      selectionInfo.textContent = `${count} selected`;
      suspendSelectedBtn.disabled = count === 0;
      retireSelectedBtn.disabled = count === 0;
      if (count === 0) {
        selectionStatus.textContent = "";
        selectionStatus.classList.remove("is-error", "is-success");
      }
    };
    const setSelectionStatus = (message = "", variant = "") => {
      selectionStatus.textContent = message;
      selectionStatus.classList.remove("is-error", "is-success");
      if (variant) {
        selectionStatus.classList.add(variant === "error" ? "is-error" : "is-success");
      }
    };
    const clearSelection = () => {
      selectedKeys.clear();
      rowsByKey.forEach((row) => row.classList.remove("is-selected"));
      rowsByKey.forEach((row) => {
        const checkbox = row.querySelector(".review-entry-checkbox");
        if (checkbox) checkbox.checked = false;
      });
      updateSelectionBar();
    };
    const removeEntry = (entry) => {
      const key = entryKey(entry);
      if (!key || !remainingKeys.has(key)) return;
      remainingKeys.delete(key);
      if (selectedKeys.has(key)) selectedKeys.delete(key);
      adjustCount(rootNodeKey, -1);
      const contexts = getEntryContexts(entry);
      contexts.forEach((ctx) => {
        adjustCount(blockNodeKey(ctx.blockId), -1);
        adjustCount(weekNodeKey(ctx.blockId, ctx.weekId), -1);
        adjustCount(lectureNodeKey(ctx.lectureKey), -1);
      });
      rowsByKey.delete(key);
      updateSelectionBar();
    };
    let pendingHighlight = highlightEntryKey;
    const renderTable = () => {
      const filtered = listFilteredEntries(currentFilter);
      bodyRows.innerHTML = "";
      rowsByKey.clear();
      if (!filtered.length) {
        table.hidden = true;
        emptyState.hidden = false;
        return;
      }
      table.hidden = false;
      emptyState.hidden = true;
      filtered.forEach((entry) => {
        const key = entryKey(entry);
        if (!key) return;
        const row = document.createElement("tr");
        row.className = "review-entry-table-row";
        row.dataset.entryKey = key;
        const contexts = getEntryContexts(entry);
        const blockNames = Array.from(new Set(contexts.map((ctx) => ctx.blockTitle))).join(", ");
        const weekNames = Array.from(new Set(contexts.map((ctx) => ctx.weekLabel))).join(", ");
        const lectureNames = Array.from(new Set(contexts.map((ctx) => ctx.lectureTitle))).join(", ");
        const selectCell = document.createElement("td");
        selectCell.className = "review-entry-cell select";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "review-entry-checkbox";
        checkbox.checked = selectedKeys.has(key);
        checkbox.addEventListener("change", (event) => {
          if (event.target.checked) {
            selectedKeys.add(key);
            row.classList.add("is-selected");
          } else {
            selectedKeys.delete(key);
            row.classList.remove("is-selected");
          }
          updateSelectionBar();
        selectCell.appendChild(checkbox);
        row.appendChild(selectCell);
        const titleCell = document.createElement("td");
        titleCell.className = "review-entry-cell title";
        titleCell.textContent = titleOf2(entry.item);
        row.appendChild(titleCell);
        const partCell = document.createElement("td");
        partCell.className = "review-entry-cell part";
        partCell.textContent = getSectionLabel(entry.item, entry.sectionKey);
        row.appendChild(partCell);
        const blockCell = document.createElement("td");
        blockCell.className = "review-entry-cell block";
        blockCell.textContent = blockNames || "\u2014";
        row.appendChild(blockCell);
        const weekCell = document.createElement("td");
        weekCell.className = "review-entry-cell week";
        weekCell.textContent = weekNames || "\u2014";
        row.appendChild(weekCell);
        const lectureCell = document.createElement("td");
        lectureCell.className = "review-entry-cell lecture";
        lectureCell.textContent = lectureNames || "\u2014";
        row.appendChild(lectureCell);
        const phaseCell = document.createElement("td");
        phaseCell.className = "review-entry-cell phase";
        const phaseLabel = describePhase(entry.phase);
        const interval = entry?.state?.interval;
        const intervalText = Number.isFinite(interval) && interval > 0 ? `Last interval \u2022 ${formatIntervalMinutes(interval)}` : "";
        phaseCell.textContent = intervalText ? `${phaseLabel || "\u2014"} (${intervalText})` : phaseLabel || "\u2014";
        row.appendChild(phaseCell);
        const dueCell = document.createElement("td");
        dueCell.className = "review-entry-cell due";
        dueCell.textContent = formatOverdue2(entry.due, now);
        row.appendChild(dueCell);
        const timeCell = document.createElement("td");
        timeCell.className = "review-entry-cell timestamp";
        timeCell.textContent = entry.due ? new Date(entry.due).toLocaleString() : "\u2014";
        row.appendChild(timeCell);
        const actionsCell = document.createElement("td");
        actionsCell.className = "review-entry-cell actions";
        const actionGroup = document.createElement("div");
        actionGroup.className = "review-entry-actions";
        const reviewBtn = document.createElement("button");
        reviewBtn.type = "button";
        reviewBtn.className = "btn tertiary";
        reviewBtn.textContent = "Review";
        reviewBtn.addEventListener("click", () => {
          if (typeof startSession === "function") {
            startSession(buildSessionPayload([entry]), {
              scope: "single",
              label: `Focused review \u2013 ${titleOf2(entry.item)}`
            });
          }
        actionGroup.appendChild(reviewBtn);
        const suspendBtn = document.createElement("button");
        suspendBtn.type = "button";
        suspendBtn.className = "btn tertiary";
        suspendBtn.textContent = "Suspend";
        suspendBtn.addEventListener("click", async () => {
          if (suspendBtn.disabled) return;
          suspendBtn.disabled = true;
          retireBtn.disabled = true;
          updateStatus("Suspending\u2026");
          try {
            suspendSection(entry.item, entry.sectionKey, Date.now());
            await upsertItem(entry.item);
            updateStatus("Card suspended.", "success");
            removeEntry(entry);
            renderTable();
            updateReviewButton();
            await handleEntryChange();
          } catch (err) {
            console.error("Failed to suspend entry", err);
            updateStatus("Failed to suspend card.", "error");
            suspendBtn.disabled = false;
            retireBtn.disabled = false;
          }
        });
        actionGroup.appendChild(suspendBtn);
        const retireBtn = document.createElement("button");
        retireBtn.type = "button";
        retireBtn.className = "btn tertiary danger";
        retireBtn.textContent = "Retire";
        retireBtn.addEventListener("click", async () => {
          if (retireBtn.disabled) return;
          retireBtn.disabled = true;
          suspendBtn.disabled = true;
          updateStatus("Retiring\u2026");
          try {
            const steps = await ensureDurations();
            const nowTs = Date.now();
            rateSection(entry.item, entry.sectionKey, RETIRE_RATING, steps, nowTs);
            await upsertItem(entry.item);
            updateStatus("Card retired.", "success");
            removeEntry(entry);
            renderTable();
            updateReviewButton();
            await handleEntryChange();
          } catch (err) {
            console.error("Failed to retire entry", err);
            updateStatus("Failed to retire card.", "error");
            retireBtn.disabled = false;
            suspendBtn.disabled = false;
          }
        });
        actionGroup.appendChild(retireBtn);
        actionsCell.appendChild(actionGroup);
        row.appendChild(actionsCell);
        const toggleSelection = () => {
          if (selectedKeys.has(key)) {
            selectedKeys.delete(key);
            row.classList.remove("is-selected");
            checkbox.checked = false;
          } else {
            selectedKeys.add(key);
            row.classList.add("is-selected");
            checkbox.checked = true;
          }
          updateSelectionBar();
        };
        row.addEventListener("click", (event) => {
          if (event.target instanceof HTMLElement) {
            if (event.target.closest("button")) return;
            if (event.target.closest("input")) return;
          }
          toggleSelection();
        });
        let dragMode = null;
        const stopDrag = () => {
          dragMode = null;
          document.removeEventListener("pointerup", stopDrag);
        };
        row.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          if (event.target instanceof HTMLElement && event.target.closest("button")) return;
          if (event.target instanceof HTMLElement && event.target.closest("input")) return;
          dragMode = selectedKeys.has(key) ? "deselect" : "select";
          if (dragMode === "select") {
            selectedKeys.add(key);
            row.classList.add("is-selected");
            checkbox.checked = true;
          } else {
            selectedKeys.delete(key);
            row.classList.remove("is-selected");
            checkbox.checked = false;
          }
          updateSelectionBar();
          document.addEventListener("pointerup", stopDrag);
        });
        row.addEventListener("pointerenter", () => {
          if (!dragMode) return;
          if (dragMode === "select") {
            selectedKeys.add(key);
            row.classList.add("is-selected");
            checkbox.checked = true;
          } else {
            selectedKeys.delete(key);
            row.classList.remove("is-selected");
            checkbox.checked = false;
          }
          updateSelectionBar();
        });
        if (selectedKeys.has(key)) {
          row.classList.add("is-selected");
        }
        if (pendingHighlight && pendingHighlight === key) {
          row.classList.add("is-highlighted");
          queueMicrotask(() => {
            row.scrollIntoView({ block: "nearest" });
          });
          pendingHighlight = null;
        }
        rowsByKey.set(key, row);
        bodyRows.appendChild(row);
      });
      updateSelectionBar();
    const setFilter = (filter, nodeKey) => {
      currentFilter = filter;
      activeNodeKey = nodeKey;
      currentMetadata = navMetadata.get(nodeKey) || metadata || { scope: "all", label: "All due cards" };
      setActiveNav(nodeKey);
      updateFilterLabel();
      renderTable();
      updateReviewButton();
    };
    const createNavButton = ({ label, nodeKey, depth, filter, count, meta }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `review-entry-nav-btn depth-${depth}`;
      button.dataset.nodeKey = nodeKey;
      const text = document.createElement("span");
      text.className = "review-entry-nav-label";
      text.textContent = label;
      const badge = document.createElement("span");
      badge.className = "review-entry-nav-count";
      badge.textContent = String(count || 0);
      navCountElements.set(nodeKey, badge);
      navMetadata.set(nodeKey, meta);
      button.appendChild(text);
      button.appendChild(badge);
      button.addEventListener("click", () => setFilter(filter, nodeKey));
      return button;
    };
    navList.appendChild(createNavButton({
      label: "All cards",
      nodeKey: rootNodeKey,
      depth: 0,
      filter: { scope: "all" },
      count: nodeCounts.get(rootNodeKey) || 0,
      meta: navMetadata.get(rootNodeKey)
    }));
    hierarchy.blocks.forEach((blockNode) => {
      const blockKey = blockNodeKey(blockNode.id);
      const blockMeta = { scope: "block", label: `Block \u2013 ${blockNode.title}`, blockId: blockNode.id };
      navList.appendChild(createNavButton({
        label: blockNode.title,
        nodeKey: blockKey,
        depth: 1,
        filter: { scope: "block", blockId: blockNode.id },
        count: nodeCounts.get(blockKey) || 0,
        meta: blockMeta
      }));
      blockNode.weeks.forEach((weekNode) => {
        const weekKey = weekNodeKey(blockNode.id, weekNode.id);
        const weekLabel = weekNode.weekNumber != null ? `Week ${weekNode.weekNumber}` : weekNode.label;
        const weekMeta = {
          scope: "week",
          label: `${weekLabel} \u2013 ${blockNode.title}`,
          blockId: blockNode.id,
          weekId: weekNode.id
        };
        navList.appendChild(createNavButton({
          label: `\u21B3 ${weekLabel}`,
          nodeKey: weekKey,
          depth: 2,
          filter: { scope: "week", blockId: blockNode.id, weekId: weekNode.id },
          count: nodeCounts.get(weekKey) || 0,
          meta: weekMeta
        }));
        weekNode.lectures.forEach((lectureNode) => {
          const lectureKey2 = lectureNodeKey(lectureNode.id);
          const lectureMeta = {
            scope: "lecture",
            label: `${lectureNode.title} \u2013 ${blockNode.title}`,
            lectureKey: lectureNode.id,
            blockId: blockNode.id,
            weekId: weekNode.id
          navList.appendChild(createNavButton({
            label: `   \u2022 ${lectureNode.title}`,
            nodeKey: lectureKey2,
            depth: 3,
            filter: { scope: "lecture", lectureKey: lectureNode.id, blockId: blockNode.id, weekId: weekNode.id },
            count: nodeCounts.get(lectureKey2) || 0,
            meta: lectureMeta
          }));
        });
      });
    });
    setFilter(currentFilter, activeNodeKey);
    if (metadata && typeof metadata === "object") {
      currentMetadata = metadata;
      updateFilterLabel();
      updateReviewButton();
    }
    reviewFilteredBtn.addEventListener("click", () => {
      const filtered = listFilteredEntries(currentFilter);
      if (!filtered.length || typeof startSession !== "function") return;
      startSession(buildSessionPayload(filtered), currentMetadata || {});
    });
    selectAllBtn.addEventListener("click", () => {
      const filtered = listFilteredEntries(currentFilter);
      filtered.forEach((entry) => {
        const key = entryKey(entry);
        if (!key) return;
        selectedKeys.add(key);
        const row = rowsByKey.get(key);
        if (row) {
          row.classList.add("is-selected");
          const checkbox = row.querySelector(".review-entry-checkbox");
          if (checkbox) checkbox.checked = true;
      });
      updateSelectionBar();
    });
    clearSelectionBtn.addEventListener("click", () => {
      clearSelection();
    });
    const bulkSuspend = async (keys) => {
      if (!keys.length) return;
      selectionBar.classList.add("is-busy");
      setSelectionStatus("Suspending\u2026");
      try {
        for (const key of keys) {
          const entry = entriesByKey.get(key);
          if (!entry) continue;
          suspendSection(entry.item, entry.sectionKey, Date.now());
          await upsertItem(entry.item);
          removeEntry(entry);
        renderTable();
        updateReviewButton();
        clearSelection();
        setSelectionStatus("Cards suspended.", "success");
        await handleEntryChange();
      } catch (err) {
        console.error("Failed to suspend cards", err);
        setSelectionStatus("Failed to suspend cards.", "error");
      } finally {
        selectionBar.classList.remove("is-busy");
      }
    };
    const bulkRetire = async (keys) => {
      if (!keys.length) return;
      selectionBar.classList.add("is-busy");
      setSelectionStatus("Retiring\u2026");
      try {
        const steps = await ensureDurations();
        for (const key of keys) {
          const entry = entriesByKey.get(key);
          if (!entry) continue;
          rateSection(entry.item, entry.sectionKey, RETIRE_RATING, steps, Date.now());
          await upsertItem(entry.item);
          removeEntry(entry);
        }
        renderTable();
        updateReviewButton();
        clearSelection();
        setSelectionStatus("Cards retired.", "success");
        await handleEntryChange();
      } catch (err) {
        console.error("Failed to retire cards", err);
        setSelectionStatus("Failed to retire cards.", "error");
      } finally {
        selectionBar.classList.remove("is-busy");
      }
    };
    suspendSelectedBtn.addEventListener("click", () => {
      bulkSuspend(Array.from(selectedKeys));
    });
    retireSelectedBtn.addEventListener("click", () => {
      bulkRetire(Array.from(selectedKeys));
    });
    return win;
  }
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
    };
    const allMeta = { scope: "all", label: "All due cards" };
    const allNode = createCollapsibleNode({
      level: 0,
      title: "All cards",
      count: hierarchy.root.entries.length,
      reviewLabel: "Review all",
      onReview: () => startSession(buildSessionPayload(hierarchy.root.entries), allMeta),
      onMenu: () => openEntryManager(hierarchy, {
        title: "All due cards",
        now,
        startSession,
        metadata: allMeta,
        focus: { scope: "all" },
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
        onMenu: () => openEntryManager(hierarchy, {
          title: `${blockNode.title} \u2014 cards`,
          now,
          startSession,
          metadata: blockMeta,
          focus: { scope: "block", blockId: blockNode.id },
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
          week: weekNode.weekNumber,
          weekId: weekNode.id
        };
        const week = createCollapsibleNode({
          level: 2,
          title: weekTitle,
          count: weekNode.entries.length,
          reviewLabel: "Review week",
          onReview: () => startSession(buildSessionPayload(weekNode.entries), weekMeta),
          onMenu: () => openEntryManager(hierarchy, {
            title: `${blockNode.title} \u2022 ${weekTitle}`,
            now,
            startSession,
            metadata: weekMeta,
            focus: { scope: "week", blockId: blockNode.id, weekId: weekNode.id },
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
            lectureKey: lectureNode.id,
            blockId: blockNode.id,
            week: lectureNode.weekNumber,
            weekId: weekNode.id
          const actions = createNodeActions({
            count: lectureNode.entries.length,
            reviewLabel: "Review lecture",
            onReview: () => startSession(buildSessionPayload(lectureNode.entries), lectureMeta),
            onMenu: () => openEntryManager(hierarchy, {
              title: `${blockNode.title} \u2022 ${weekTitle} \u2022 ${lectureNode.title}`,
              now,
              startSession,
              metadata: lectureMeta,
              focus: { scope: "lecture", lectureKey: lectureNode.id, blockId: blockNode.id, weekId: weekNode.id },
              onChange: refresh
            })
          });
          actions.classList.add("review-lecture-actions");
          lectureRow.appendChild(actions);
          lectureList.appendChild(lectureRow);
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
        setFlashSession(savedEntry.session);
        redraw();
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
  function entryIdentifier(item = {}, fallbackId = "item") {
    return item.id || item.slug || item.name || fallbackId;
  }
  function reviewEntryKey(entry) {
    if (!entry) return null;
    const itemId = entry.itemId || entryIdentifier(entry.item);
    const section = entry.sectionKey || (Array.isArray(entry.sections) ? entry.sections[0] : null);
    if (!itemId || !section) return null;
    return `${itemId}::${section}`;
  function sessionEntryKey(entry) {
    if (!entry) return null;
    const section = Array.isArray(entry.sections) && entry.sections.length ? entry.sections[0] : entry.sectionKey;
    return reviewEntryKey({ item: entry.item, sectionKey: section });
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
  function renderFlashcards(root, redraw) {
    const fallbackPool = Array.isArray(state.cohort) ? state.cohort : [];
    let active = state.flashSession;
    if (active) {
      const normalized2 = normalizeFlashSession(active, fallbackPool, active.mode === "review" ? "review" : "study");
      if (normalized2 !== active) {
        setFlashSession(normalized2);
        active = normalized2;
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
      active = next2;
      setFlashSession(next2);
    const isReview = active.mode === "review";
    const syncReviewSession = async () => {
      if (!isReview) return;
      try {
        const nowTs = Date.now();
        const cohortItems = await loadReviewSourceItems();
        setCohort(cohortItems);
        const dueEntries = collectDueSections(cohortItems, { now: nowTs });
        const dueKeys = new Set(dueEntries.map(reviewEntryKey).filter(Boolean));
        const pool = resolvePool();
        const filtered = pool.filter((entry2) => {
          const key = sessionEntryKey(entry2);
          return !key || dueKeys.has(key);
        });
        if (filtered.length === pool.length) return;
        let idx = active.idx;
        if (idx >= filtered.length) idx = Math.max(filtered.length - 1, 0);
        commitSession({ pool: filtered, idx });
        redraw();
      } catch (err) {
        console.error("Failed to sync review session", err);
      }
    const openQueueManager = async (focusEntry = null, triggerBtn = null) => {
      if (!isReview) return;
      if (triggerBtn) triggerBtn.disabled = true;
      try {
        const nowTs = Date.now();
        const cohortItems = await loadReviewSourceItems();
        setCohort(cohortItems);
        const dueEntries = collectDueSections(cohortItems, { now: nowTs });
        const { blocks } = await loadBlockCatalog();
        const blockTitles = ensureBlockTitleMap(blocks);
        const hierarchy = buildReviewHierarchy(dueEntries, blocks, blockTitles);
        const highlightKey = focusEntry ? sessionEntryKey(focusEntry) : null;
        openEntryManager(hierarchy, {
          title: "Manage review queue",
          now: nowTs,
          startSession: async (pool, metadata = {}) => {
            await removeStudySession("review").catch((err) => console.warn("Failed to clear saved review entry", err));
            setFlashSession({ idx: 0, pool, ratings: {}, mode: "review", metadata });
            redraw();
          },
          metadata: { scope: "all", label: "All due cards" },
          highlightEntryKey: highlightKey,
          onChange: syncReviewSession
        });
      } catch (err) {
        console.error("Failed to open review manager", err);
      } finally {
        if (triggerBtn) triggerBtn.disabled = false;
    };
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
    const card = document.createElement("section");
    card.className = "card flashcard";
    card.tabIndex = 0;
    if (isReview) {
      card.classList.add("is-review");
    }
    const header = document.createElement("div");
    header.className = "flashcard-header";
    const title = document.createElement("h2");
    title.className = "flashcard-title";
    title.textContent = item.name || item.concept || "";
    header.appendChild(title);
    const headerActions = document.createElement("div");
    headerActions.className = "flashcard-header-actions";
    header.appendChild(headerActions);
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
    headerActions.appendChild(editBtn);
    if (isReview) {
      const manageBtn = document.createElement("button");
      manageBtn.type = "button";
      manageBtn.className = "icon-btn flashcard-manage-btn";
      manageBtn.innerHTML = "\u2699";
      manageBtn.title = "Manage review queue";
      manageBtn.setAttribute("aria-label", "Manage review queue");
      manageBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openQueueManager(entry, manageBtn);
      headerActions.appendChild(manageBtn);
    }
    card.appendChild(header);
    const durationsPromise = getReviewDurations().catch(() => ({ ...DEFAULT_REVIEW_STEPS }));
    const sectionBlocks = sections.length ? sections : [];
    const sectionRequirements = /* @__PURE__ */ new Map();
    if (!sectionBlocks.length) {
      const empty = document.createElement("div");
      empty.className = "flash-empty";
      empty.textContent = "No content available for this card.";
      card.appendChild(empty);
    }
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
      };
      const ratingPreviews = /* @__PURE__ */ new Map();
      const updatePreviews = (durations) => {
        if (!durations) return;
        const nowTs = Date.now();
        REVIEW_RATINGS.forEach((ratingValue) => {
          const target = ratingPreviews.get(ratingValue);
          if (!target) return;
          try {
            const projection = projectSectionRating(item, key, ratingValue, durations, nowTs);
            if (!projection || !Number.isFinite(projection.due)) {
              target.textContent = "";
              return;
            }
            const minutes = Math.max(0, Math.round((projection.due - nowTs) / (60 * 1e3)));
            target.textContent = formatReviewInterval(minutes);
          } catch (err) {
            target.textContent = "";
          }
        });
      };
      const renderPreviews = async () => {
          const durations = await durationsPromise;
          updatePreviews(durations);
        }
      };
      const handleRating = async (value) => {
        if (ratingLocked) return;
        const durations = await durationsPromise;
        setToggleState(sec, true, "revealed");
        ratingRow.classList.add("is-saving");
        status.textContent = "Saving\u2026";
        status.classList.remove("is-error");
          rateSection(item, key, value, durations, Date.now());
          await upsertItem(item);
          selectRating(value);
          status.textContent = "Saved";
          status.classList.remove("is-error");
          updatePreviews(durations);
          console.error("Failed to record rating", err);
          status.textContent = "Save failed";
          status.classList.add("is-error");
        } finally {
          ratingRow.classList.remove("is-saving");
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
    card.style.setProperty("--flash-accent-soft", `color-mix(in srgb, ${accent} 16%, transparent)`);
    card.style.setProperty("--flash-accent-strong", `color-mix(in srgb, ${accent} 32%, rgba(15, 23, 42, 0.08))`);
    card.style.setProperty("--flash-accent-border", `color-mix(in srgb, ${accent} 42%, transparent)`);
