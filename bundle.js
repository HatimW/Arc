  function setStudySelectedMode(mode2) {
    if (mode2 === "Flashcards" || mode2 === "Quiz" || mode2 === "Blocks") {
      state.study.selectedMode = mode2;
  function setStudySessionEntry(mode2, entry) {
    if (!mode2) return;
      next[mode2] = entry;
      delete next[mode2];
    constructor(db, names, mode2) {
      this.mode = mode2;
    transaction(names, mode2 = "readonly") {
      return new MemoryTransaction(this, names, mode2);
  async function lectureStore(mode2 = "readonly") {
    return db.transaction("lectures", mode2).objectStore("lectures");
    const mode2 = typeof record.mode === "string" && record.mode.trim() ? record.mode.trim() : null;
    if (!mode2) return null;
    if (mode2 === "review") {
      mode: mode2,
  async function store(name, mode2 = "readonly") {
    return db.transaction(name, mode2).objectStore(name);
  async function deleteStudySessionRecord(mode2) {
    if (!mode2) return;
    await prom3(s.delete(mode2));
  // js/ui/performance.js
  var subscribers = /* @__PURE__ */ new Set();
  var listComplexity = /* @__PURE__ */ new Map();
  var windowCount = 0;
  var mode = "";
  function detectBaseMode() {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      try {
        if (window.matchMedia("(prefers-reduced-transparency: reduce)").matches) {
          return "conservative";
        }
      } catch (err) {
        console.warn("Failed to evaluate transparency preference", err);
      }
    }
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent || "";
      if (/Electron/i.test(ua)) {
        return "balanced";
      }
      const memory = Number(navigator.deviceMemory);
      if (Number.isFinite(memory) && memory > 0 && memory <= 4) {
        return "balanced";
      }
    }
    return "standard";
  }
  var baseMode = detectBaseMode();
  function withDocumentBody(fn) {
    if (typeof document === "undefined") return;
    if (document.body) {
      fn(document.body);
      return;
    }
    const handler = () => {
      if (!document.body) return;
      fn(document.body);
      document.removeEventListener("DOMContentLoaded", handler);
    };
    document.addEventListener("DOMContentLoaded", handler);
  }
  function applyMode(nextMode) {
    if (!nextMode) nextMode = "standard";
    if (mode === nextMode) return;
    mode = nextMode;
    withDocumentBody((body) => {
      body.dataset.performanceMode = nextMode;
      body.style.setProperty("--performance-mode", nextMode);
    });
    subscribers.forEach((listener) => {
      try {
        listener(nextMode);
      } catch (err) {
        console.error("Performance listener failed", err);
      }
    });
  }
  function computeComplexityScore(options) {
    if (options == null) return 0;
    if (typeof options === "number") {
      return Number.isFinite(options) ? Math.max(0, Math.round(options)) : 0;
    }
    const items = Number.isFinite(options.items) ? Math.max(0, options.items) : 0;
    const columns = Number.isFinite(options.columns) ? Math.max(1, options.columns) : 1;
    const extras = Number.isFinite(options.extras) ? Math.max(0, options.extras) : 0;
    const weight = Number.isFinite(options.weight) ? Math.max(0.1, options.weight) : 1;
    return Math.round(items * columns * weight + extras);
  }
  function recomputeMode() {
    const heaviestList = listComplexity.size ? Math.max(...listComplexity.values()) : 0;
    let nextMode = baseMode;
    if (baseMode === "conservative") {
      nextMode = "conservative";
    } else if (windowCount >= 3 || heaviestList >= 240) {
      nextMode = "conservative";
    } else if (windowCount >= 2 || heaviestList >= 140) {
      nextMode = baseMode === "standard" ? "balanced" : baseMode;
    }
    applyMode(nextMode);
  }
  applyMode(baseMode);
  function getPerformanceMode() {
    return mode || "standard";
  }
  function reportListComplexity(key, options) {
    if (!key) return getPerformanceMode();
    const score = computeComplexityScore(options);
    if (score > 0) {
      listComplexity.set(key, score);
    } else {
      listComplexity.delete(key);
    }
    recomputeMode();
    return getPerformanceMode();
  }
  function registerWindowPresence() {
    windowCount += 1;
    recomputeMode();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      windowCount = Math.max(0, windowCount - 1);
      recomputeMode();
    };
  }

    const releaseWindow = registerWindowPresence();
    let releasedWindow = false;
    function finalizeRelease() {
      if (releasedWindow) return;
      releasedWindow = true;
      releaseWindow();
    }
      finalizeRelease();
        },
        destroy() {
          try {
            mutationObserver.disconnect();
          } catch (err) {
          }
          document.removeEventListener("scroll", onScroll, true);
          editable2.removeEventListener("scroll", onScroll);
          window.removeEventListener("resize", onScroll);
          overlays.forEach((overlay, image) => {
            try {
              overlay.destroy();
            } catch (err) {
              console.warn("Failed to destroy occlusion overlay", err);
            }
            if (resizeObserver) {
              try {
                resizeObserver.unobserve(image);
              } catch (err) {
              }
            }
          });
          overlays.clear();
          if (resizeObserver) {
            try {
              resizeObserver.disconnect();
            } catch (err) {
            }
          }
      },
      destroy() {
        document.removeEventListener("selectionchange", selectionHandler);
        destroyActiveImageEditor();
        if (occlusionDisplayManager && typeof occlusionDisplayManager.destroy === "function") {
          occlusionDisplayManager.destroy();
        }
        occlusionDisplayManager = null;
    const editorCleanups = /* @__PURE__ */ new Set();
    function registerCleanup(fn) {
      if (typeof fn !== "function") {
        return () => {
        };
      }
      editorCleanups.add(fn);
      return () => {
        editorCleanups.delete(fn);
      };
    }
    function runEditorCleanups() {
      editorCleanups.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error("Failed to cleanup editor resources", err);
        }
      });
      editorCleanups.clear();
    }
    function trackEditorInstance(editor) {
      if (!editor || typeof editor.destroy !== "function") {
        return () => {
        };
      }
      let disposed = false;
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        try {
          editor.destroy();
        } catch (err) {
          console.error("Failed to destroy rich text editor", err);
        }
      };
      const unregister = registerCleanup(cleanup);
      return () => {
        if (disposed) return;
        unregister();
        cleanup();
      };
    }
      onClose: () => {
        cancelAutoSave();
        if (statusFadeTimer) {
          clearTimeout(statusFadeTimer);
          statusFadeTimer = null;
        }
        runEditorCleanups();
      },
      trackEditorInstance(editor);
      const disposeEditor = trackEditorInstance(editor);
      extraControls.set(id, { id, titleInput, editor, dispose: disposeEditor });
      removeBtn.addEventListener("click", () => {
        extraControls.delete(id);
        disposeEditor();
        row.remove();
        markDirty();
      });
    let totalItems = 0;
      totalItems += 1;
    reportListComplexity("cardlist", { items: totalItems, columns: state.entryLayout?.columns || 1 });
    const perfMode = getPerformanceMode();
    const LIST_CHUNK_SIZE = perfMode === "conservative" ? 48 : perfMode === "balanced" ? 120 : 200;
      const mode2 = rawSort.mode;
      if (typeof mode2 === "string" && sortOptions.includes(mode2)) {
        currentSortField = mode2;
      const { mode: mode2, controlsVisible } = state.entryLayout;
      setToggleState(listBtn, mode2 === "list");
      setToggleState(gridBtn, mode2 === "grid");
      columnWrap.style.display = mode2 === "grid" ? "" : "none";
          const slice = rows.slice(start, start + LIST_CHUNK_SIZE);
          if (start + LIST_CHUNK_SIZE < rows.length) requestAnimationFrame(() => renderChunk(start + LIST_CHUNK_SIZE));
    reportListComplexity("cards", { items: sortedItems.length, weight: 1.1 });
    const perfMode = getPerformanceMode();
    const MAX_EAGER_QUEUE = perfMode === "conservative" ? 2 : perfMode === "balanced" ? 4 : 6;
    const GRID_CHUNK_BUDGET = perfMode === "conservative" ? 3 : perfMode === "balanced" ? 5 : 6;
    const GRID_FRAME_BUDGET = perfMode === "conservative" ? 9 : perfMode === "balanced" ? 12 : 14;
    const OBSERVER_ROOT_MARGIN = perfMode === "conservative" ? "120px 0px" : perfMode === "balanced" ? "160px 0px" : "200px 0px";
      if (eagerGridQueue.length >= MAX_EAGER_QUEUE) return;
    }, { rootMargin: OBSERVER_ROOT_MARGIN }) : null;
      while (index < entries.length && elapsed < GRID_CHUNK_BUDGET) {
        if (getTime() - frameStart > GRID_FRAME_BUDGET) break;
  function sanitizeSession(mode2, session) {
    if (mode2 === "review") {
  function getStudySessionEntry(mode2) {
    return state.studySessions && state.studySessions[mode2] || null;
  async function persistStudySession(mode2, payload) {
    if (!mode2) throw new Error("Mode is required to save study session");
      mode: mode2,
      session: sanitizeSession(mode2, payload?.session ?? {}),
    setStudySessionEntry(mode2, entry);
  async function removeStudySession(mode2) {
    if (!mode2) return;
    await deleteStudySessionRecord(mode2);
    setStudySessionEntry(mode2, null);
    modes.forEach((mode2) => {
      btn.dataset.mode = mode2.toLowerCase();
      const isActive = mode2 === selected;
      btn.textContent = mode2;
        setStudySelectedMode(mode2);
  function readLegacyField(source, key) {
    if (!source || typeof source !== "object") return void 0;
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
    if (source.data && typeof source.data === "object" && Object.prototype.hasOwnProperty.call(source.data, key)) {
      return source.data[key];
    }
    if (source.payload && typeof source.payload === "object" && Object.prototype.hasOwnProperty.call(source.payload, key)) {
      return source.payload[key];
    }
    return void 0;
  }
  function normalizeScopeValue(rawScope, lectures) {
    if (typeof rawScope === "string") {
      const normalized2 = rawScope.trim().toLowerCase();
      if (normalized2 === "block" || normalized2 === "blocks") {
        return "block";
      }
      if (normalized2 === "week" || normalized2 === "weeks") {
        return "week";
      }
      if (normalized2 === "lecture" || normalized2 === "lectures") {
        return "lecture";
      }
      if ((normalized2 === "all" || normalized2 === "full") && Array.isArray(lectures) && lectures.length > 1) {
        return "block";
      }
    }
    return "lecture";
  }
  function normalizeTransferMap(rawMap) {
    if (!rawMap || typeof rawMap !== "object" || !Array.isArray(rawMap.tabs)) {
      return { tabs: [] };
    }
    return {
      tabs: rawMap.tabs.map((tab) => ({
        name: tab?.name || "Imported map",
        includeLinked: tab?.includeLinked !== false,
        manualMode: Boolean(tab?.manualMode),
        manualIds: Array.isArray(tab?.manualIds) ? tab.manualIds.filter(Boolean) : [],
        layout: tab?.layout && typeof tab.layout === "object" ? { ...tab.layout } : {},
        layoutSeeded: tab?.layoutSeeded === true,
        filter: tab?.filter && typeof tab.filter === "object" ? { ...tab.filter } : { blockId: "", week: "", lectureKey: "" }
      }))
    };
  }
    const version = Number(bundle.version);
    if (Number.isFinite(version) && version > TRANSFER_VERSION) {
    const rawLectures = readLegacyField(bundle, "lectures");
    const lectureList = Array.isArray(rawLectures) ? rawLectures : [];
    const lectures = lectureList.map(ensureLectureDefaults).filter(Boolean);
    const rawScope = readLegacyField(bundle, "scope");
    const scope = normalizeScopeValue(rawScope, lectureList);
    const rawBlock = readLegacyField(bundle, "block") ?? readLegacyField(bundle, "blockInfo") ?? {};
    let block = sanitizeBlock(rawBlock) || null;
    if (!block) {
      block = { blockId: null, title: "", color: null, weeks: null, startDate: null, endDate: null };
    }
    if (!block.blockId) {
      const fallbackLecture = lectures.find((lecture) => lecture?.blockId != null) || null;
      if (fallbackLecture && fallbackLecture.blockId != null) {
        block.blockId = fallbackLecture.blockId;
      }
    }
    lectures.forEach((lecture) => {
      if (!lecture.blockId && block.blockId != null) {
        lecture.blockId = block.blockId;
      }
    });
    if (!block.blockId) {
      throw new Error("Transfer missing block information");
    }
    const rawItems = readLegacyField(bundle, "items");
    const items = Array.isArray(rawItems) ? rawItems.map((item) => {
    const rawMap = readLegacyField(bundle, "map");
    const map = normalizeTransferMap(rawMap);
  function isElementLike(node) {
    if (!node || typeof node !== "object") return false;
    if (typeof Element !== "undefined" && node instanceof Element) {
      return true;
    }
    return node.nodeType === 1;
  }
    toggleButton.addEventListener("click", async (event) => {
      if (event && typeof event.stopPropagation === "function") {
        event.stopPropagation();
      }
      const target = event?.target || null;
      const toggleTarget = (isElementLike(target) && typeof target.closest === "function" ? target.closest(".lecture-pass-chip-toggle") : null) || (isElementLike(target?.parentElement) && typeof target.parentElement.closest === "function" ? target.parentElement.closest(".lecture-pass-chip-toggle") : null);
      if (toggleTarget) {
    const { mode: mode2, blocks, defaults = {}, lectureLists = {}, onSubmit } = options;
    title.textContent = mode2 === "edit" ? "Edit lecture" : "Add lecture";
    if (mode2 === "edit") {
    if (mode2 === "edit") {
    if (mode2 !== "edit") {
    submitBtn.textContent = mode2 === "edit" ? "Save changes" : "Add lecture";
      if (mode2 === "edit") {
  function passScopeModal(mode2) {
      title.textContent = mode2 === "push" ? "Push pass timing" : "Pull pass timing";
      message.textContent = mode2 === "push" ? "Choose how far the push should ripple." : "Choose how far the pull should ripple.";
      cascade.textContent = mode2 === "push" ? "This & following" : "This & preceding";
        cleanup(mode2 === "push" ? "chain-after" : "chain-before");
    async function handleShift(mode2) {
      const scope = await passScopeModal(mode2);
      const delta = mode2 === "push" ? minutes : -minutes;
    const totalPasses = filtered.reduce((sum, lecture) => {
      const passes = Array.isArray(lecture?.passPlan?.passes) ? lecture.passPlan.passes.length : Array.isArray(lecture?.passes) ? lecture.passes.length : 0;
      return sum + passes;
    }, 0);
    reportListComplexity("lectures", { items: filtered.length, extras: Math.round(totalPasses * 0.75) });
    const mode2 = source.mode === "review" ? "review" : defaultMode;
    if (source.mode !== mode2) {
      next.mode = mode2;
  function buildScopeOptions(mode2) {
    if (mode2 === "pull") {
  function openShiftDialog(mode2, { title, description, defaultValue = 1, defaultUnit = "days" } = {}) {
      heading.textContent = title || (mode2 === "push" ? "Push later" : "Pull earlier");
      buildScopeOptions(mode2).forEach((option, index) => {
      confirm2.textContent = mode2 === "push" ? "Push later" : "Pull earlier";
      onShift: async (entry, mode2) => {
        const result = await openShiftDialog(mode2, {
        const delta = mode2 === "push" ? result.minutes : -result.minutes;
        const mode2 = String(getCell(row, "timerMode") || "").trim().toLowerCase();
        if (mode2 === "timed" || mode2 === "untimed") base.timerMode = mode2;
    const cleanupTasks = /* @__PURE__ */ new Set();
    function registerCleanup(fn) {
      if (typeof fn !== "function") {
        return () => {
        };
      }
      cleanupTasks.add(fn);
      return () => {
        cleanupTasks.delete(fn);
      };
    }
    function runAllCleanups() {
      cleanupTasks.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error("Failed to cleanup exam editor resources", err);
        }
      });
      cleanupTasks.clear();
    }
    let questionDisposers = [];
    function disposeQuestions() {
      questionDisposers.forEach((dispose) => {
        try {
          dispose();
        } catch (err) {
          console.error("Failed to dispose exam question editors", err);
        }
      });
      questionDisposers = [];
    }
      onClose: () => {
        disposeQuestions();
        runAllCleanups();
      },
    ["untimed", "timed"].forEach((mode2) => {
      opt.value = mode2;
      opt.textContent = mode2 === "timed" ? "Timed" : "Untimed";
      disposeQuestions();
        const localDisposers = /* @__PURE__ */ new Set();
        const optionDisposers = /* @__PURE__ */ new Set();
        function trackEditor(editor) {
          if (!editor || typeof editor.destroy !== "function") {
            return () => {
            };
          }
          let disposed = false;
          const cleanup = () => {
            if (disposed) return;
            disposed = true;
            try {
              editor.destroy();
            } catch (err) {
              console.error("Failed to destroy exam editor instance", err);
            }
          };
          const unregister = registerCleanup(cleanup);
          const dispose = () => {
            if (disposed) return;
            unregister();
            cleanup();
            localDisposers.delete(dispose);
          };
          localDisposers.add(dispose);
          return dispose;
        }
        function cleanupOptionEditors() {
          for (const dispose of Array.from(optionDisposers)) {
            optionDisposers.delete(dispose);
            dispose();
          }
        }
        trackEditor(stemEditor);
        trackEditor(explanationEditor);
          cleanupOptionEditors();
            const disposeOptionEditor = trackEditor(editor);
            optionDisposers.add(disposeOptionEditor);
        const disposeLocal = () => {
          cleanupOptionEditors();
          for (const dispose of Array.from(localDisposers)) {
            localDisposers.delete(dispose);
            dispose();
          }
        };
        questionDisposers.push(disposeLocal);
