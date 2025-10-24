    easy: 2160,
    learningSteps: [10, 60],
    relearningSteps: [10],
    graduatingGood: 1440,
    graduatingEasy: 2880,
    startingEase: 2.5,
    minimumEase: 1.3,
    easeBonus: 0.15,
    easePenalty: 0.2,
    hardEasePenalty: 0.05,
    hardIntervalMultiplier: 1.2,
    easyIntervalBonus: 1.5,
    intervalModifier: 1,
    lapseIntervalMultiplier: 0.5
  var NUMERIC_KEYS = [
    "graduatingGood",
    "graduatingEasy",
    "startingEase",
    "minimumEase",
    "easeBonus",
    "easePenalty",
    "hardEasePenalty",
    "hardIntervalMultiplier",
    "easyIntervalBonus",
    "intervalModifier",
    "lapseIntervalMultiplier"
  ];
  var STEP_ARRAY_KEYS = ["learningSteps", "relearningSteps"];
  function toNumber2(value, { min = 0, fallback = 0, allowZero = false } = {}) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    if (num < min) return allowZero && num === 0 ? 0 : fallback;
    return num;
  }
  function parseStepList(raw, fallback = []) {
    const ensurePositive = (value) => {
      const minutes = Math.round(Number(value));
      return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
    };
    if (Array.isArray(raw)) {
      const parsed = raw.map(ensurePositive).filter((v) => v != null);
      return parsed.length ? parsed : fallback;
    }
    if (typeof raw === "string") {
      const parsed = raw.split(/[,\s]+/).map(ensurePositive).filter((v) => v != null);
      return parsed.length ? parsed : fallback;
    }
    return fallback;
  }
        normalized2[key] = Math.round(num);
      }
    }
    for (const key of STEP_ARRAY_KEYS) {
      const list = parseStepList(raw[key], normalized2[key]);
      normalized2[key] = list.length ? list : normalized2[key];
    }
    for (const key of NUMERIC_KEYS) {
      const defaults = DEFAULT_REVIEW_STEPS[key];
      const fallback = typeof defaults === "number" ? defaults : 0;
      const min = key.endsWith("Ease") ? 0 : 1e-4;
      const allowZero = key === "intervalModifier";
      const value = toNumber2(raw[key], { min, fallback, allowZero });
      if (key === "minimumEase") {
        normalized2[key] = Math.max(0.5, value);
      } else if (key === "startingEase") {
        normalized2[key] = Math.max(normalized2.minimumEase || 1.3, value);
      } else if (key === "intervalModifier" && value <= 0) {
        normalized2[key] = fallback || 1;
      } else {
        normalized2[key] = value;
    if (normalized2.startingEase < normalized2.minimumEase) {
      normalized2.startingEase = normalized2.minimumEase;
    }
      suspended: false,
      lectureScope: [],
      interval: 0,
      ease: DEFAULT_REVIEW_STEPS.startingEase,
      lapses: 0,
      learningStepIndex: 0,
      phase: "new",
      pendingInterval: 0
    if (typeof record.suspended === "boolean") {
      base.suspended = record.suspended;
    }
    if (typeof record.interval === "number" && Number.isFinite(record.interval) && record.interval >= 0) {
      base.interval = Math.max(0, record.interval);
    }
    if (typeof record.ease === "number" && Number.isFinite(record.ease) && record.ease > 0) {
      base.ease = record.ease;
    }
    if (typeof record.lapses === "number" && Number.isFinite(record.lapses) && record.lapses >= 0) {
      base.lapses = Math.max(0, Math.round(record.lapses));
    }
    if (typeof record.learningStepIndex === "number" && Number.isFinite(record.learningStepIndex) && record.learningStepIndex >= 0) {
      base.learningStepIndex = Math.max(0, Math.round(record.learningStepIndex));
    }
    if (typeof record.phase === "string") {
      const phase = record.phase.trim();
      const allowed = ["new", "learning", "review", "relearning", "suspended"];
      if (allowed.includes(phase)) {
        base.phase = phase;
      }
    }
    if (typeof record.pendingInterval === "number" && Number.isFinite(record.pendingInterval) && record.pendingInterval >= 0) {
      base.pendingInterval = Math.max(0, record.pendingInterval);
    }
    const advancedHeading = document.createElement("h3");
    advancedHeading.className = "settings-subheading";
    advancedHeading.textContent = "Advanced spacing controls";
    reviewForm.appendChild(advancedHeading);
    const advancedGrid = document.createElement("div");
    advancedGrid.className = "settings-review-grid";
    reviewForm.appendChild(advancedGrid);
    const advancedInputs = /* @__PURE__ */ new Map();
    const advancedFields = [
      { key: "learningSteps", label: "Learning steps (minutes, comma separated)", type: "text", placeholder: "10, 60" },
      { key: "relearningSteps", label: "Relearning steps (minutes)", type: "text", placeholder: "10" },
      { key: "graduatingGood", label: "Graduating interval \u2013 Good (minutes)", type: "number", min: 1 },
      { key: "graduatingEasy", label: "Graduating interval \u2013 Easy (minutes)", type: "number", min: 1 },
      { key: "startingEase", label: "Starting ease factor", type: "number", min: 0.5, step: 0.01 },
      { key: "minimumEase", label: "Minimum ease factor", type: "number", min: 0.5, step: 0.01 },
      { key: "easeBonus", label: "Easy bonus", type: "number", min: 0, step: 0.01 },
      { key: "easePenalty", label: "Again penalty", type: "number", min: 0, step: 0.01 },
      { key: "hardEasePenalty", label: "Hard penalty", type: "number", min: 0, step: 0.01 },
      { key: "hardIntervalMultiplier", label: "Hard interval multiplier", type: "number", min: 0.1, step: 0.01 },
      { key: "easyIntervalBonus", label: "Easy interval bonus", type: "number", min: 0.1, step: 0.01 },
      { key: "intervalModifier", label: "Interval modifier", type: "number", min: 0.1, step: 0.01 },
      { key: "lapseIntervalMultiplier", label: "Lapse interval multiplier", type: "number", min: 0.1, step: 0.01 }
    ];
    advancedFields.forEach((field) => {
      const row = document.createElement("label");
      row.className = "settings-review-row";
      const label = document.createElement("span");
      label.textContent = field.label;
      row.appendChild(label);
      const input = document.createElement("input");
      input.className = "input settings-review-input";
      if (field.type === "number") {
        input.type = "number";
        if (field.min != null) input.min = String(field.min);
        if (field.step != null) input.step = String(field.step);
      } else {
        input.type = "text";
      }
      if (field.placeholder) input.placeholder = field.placeholder;
      const currentValue = reviewSteps[field.key];
      if (Array.isArray(currentValue)) {
        input.value = currentValue.join(", ");
      } else if (currentValue != null) {
        input.value = String(currentValue);
      }
      row.appendChild(input);
      advancedInputs.set(field.key, input);
      advancedGrid.appendChild(row);
    });
      const advancedPatch = {};
      const failField = (message, input) => {
        reviewStatus.textContent = message;
        reviewStatus.classList.add("is-error");
        reviewStatus.hidden = false;
        if (input) input.focus();
        return false;
      };
      const parseListField = (key, label) => {
        const input = advancedInputs.get(key);
        if (!input) return true;
        const raw = (input.value || "").trim();
        if (!raw) return true;
        const values = raw.split(/[,\s]+/).map((entry) => Math.round(Number(entry))).filter((entry) => Number.isFinite(entry) && entry > 0);
        if (!values.length) {
          return failField(`Enter positive minutes for ${label}.`, input);
        }
        advancedPatch[key] = values;
        return true;
      };
      const parseNumberField = (key, label, { min = 0, allowZero = false } = {}) => {
        const input = advancedInputs.get(key);
        if (!input) return true;
        const raw = input.value;
        if (raw == null || raw === "") return true;
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          return failField(`Enter a numeric value for ${label}.`, input);
        }
        if (value < min) {
          return failField(`Value for ${label} must be at least ${min}.`, input);
        }
        if (!allowZero && value === 0) {
          return failField(`Value for ${label} must be greater than zero.`, input);
        }
        advancedPatch[key] = value;
        return true;
      };
      if (!parseListField("learningSteps", "learning steps")) return;
      if (!parseListField("relearningSteps", "relearning steps")) return;
      if (!parseNumberField("graduatingGood", "graduating good interval", { min: 0 })) return;
      if (!parseNumberField("graduatingEasy", "graduating easy interval", { min: 0 })) return;
      if (!parseNumberField("startingEase", "starting ease", { min: 0.5, allowZero: false })) return;
      if (!parseNumberField("minimumEase", "minimum ease", { min: 0.5, allowZero: false })) return;
      if (!parseNumberField("easeBonus", "easy bonus", { min: 0, allowZero: true })) return;
      if (!parseNumberField("easePenalty", "again penalty", { min: 0, allowZero: true })) return;
      if (!parseNumberField("hardEasePenalty", "hard penalty", { min: 0, allowZero: true })) return;
      if (!parseNumberField("hardIntervalMultiplier", "hard interval multiplier", { min: 0.1, allowZero: false })) return;
      if (!parseNumberField("easyIntervalBonus", "easy interval bonus", { min: 0.1, allowZero: false })) return;
      if (!parseNumberField("intervalModifier", "interval modifier", { min: 0.01, allowZero: false })) return;
      if (!parseNumberField("lapseIntervalMultiplier", "lapse interval multiplier", { min: 0.01, allowZero: false })) return;
      Object.assign(nextSteps, advancedPatch);
        for (const [key, input] of advancedInputs) {
          if (!input) continue;
          const value = normalized2[key];
          if (Array.isArray(value)) {
            input.value = value.join(", ");
          } else if (value != null) {
            input.value = String(value);
          } else {
            input.value = "";
          }
        }
      normalized2.suspended = false;
      normalized2.phase = "new";
      normalized2.learningStepIndex = 0;
      normalized2.interval = 0;
      normalized2.pendingInterval = 0;
      normalized2.ease = DEFAULT_REVIEW_STEPS.startingEase;
      normalized2.lapses = 0;
  function asMinutes(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return Math.max(1, Math.round(num));
  }
  function normalizeStepList(list, fallback) {
    if (Array.isArray(list) && list.length) {
      const parsed = list.map((value) => asMinutes(value, 0)).filter((value) => value > 0);
      if (parsed.length) return parsed;
    }
    return fallback;
  }
  function ensurePhase(section) {
    if (!section.phase) {
      section.phase = section.interval > 0 ? "review" : "new";
    }
    if (section.phase === "suspended") {
      section.phase = section.interval > 0 ? "review" : "learning";
    }
    return section.phase;
  }
  function minutesToMs(minutes) {
    return Math.max(0, Math.round(minutes * 60 * 1e3));
  }
  function scheduleDue(section, minutes, now) {
    const clamped = Math.max(1, Math.round(minutes));
    section.due = now + minutesToMs(clamped);
    return clamped;
  }
  function applyRatingState(section, rating, config, now) {
      section.streak = 0;
      section.lastRating = RETIRE_RATING;
      section.last = now;
      section.interval = Number.MAX_SAFE_INTEGER;
      section.pendingInterval = 0;
      section.phase = "review";
      section.due = Number.MAX_SAFE_INTEGER;
      section.retired = true;
      section.suspended = false;
      return section;
    const baseAgain = asMinutes(config.again ?? DEFAULT_REVIEW_STEPS.again, DEFAULT_REVIEW_STEPS.again);
    const baseHard = asMinutes(config.hard ?? DEFAULT_REVIEW_STEPS.hard, baseAgain);
    const baseGood = asMinutes(config.good ?? DEFAULT_REVIEW_STEPS.good, baseHard);
    const baseEasy = asMinutes(config.easy ?? DEFAULT_REVIEW_STEPS.easy, baseGood);
    const learningSteps = normalizeStepList(config.learningSteps, [baseAgain]);
    const relearningSteps = normalizeStepList(config.relearningSteps, [baseAgain]);
    const intervalModifier = Number.isFinite(config.intervalModifier) && config.intervalModifier > 0 ? config.intervalModifier : 1;
    const lapseIntervalMultiplier = Number.isFinite(config.lapseIntervalMultiplier) && config.lapseIntervalMultiplier > 0 ? config.lapseIntervalMultiplier : 0.5;
    const easyIntervalBonus = Number.isFinite(config.easyIntervalBonus) && config.easyIntervalBonus > 0 ? config.easyIntervalBonus : 1.5;
    const hardIntervalMultiplier = Number.isFinite(config.hardIntervalMultiplier) && config.hardIntervalMultiplier > 0 ? config.hardIntervalMultiplier : 1.2;
    const startingEase = Number.isFinite(config.startingEase) && config.startingEase > 0 ? config.startingEase : DEFAULT_REVIEW_STEPS.startingEase;
    const minimumEase = Number.isFinite(config.minimumEase) && config.minimumEase > 0 ? config.minimumEase : DEFAULT_REVIEW_STEPS.minimumEase;
    const easeBonus = Number.isFinite(config.easeBonus) ? config.easeBonus : DEFAULT_REVIEW_STEPS.easeBonus;
    const easePenalty = Number.isFinite(config.easePenalty) ? config.easePenalty : DEFAULT_REVIEW_STEPS.easePenalty;
    const hardEasePenalty = Number.isFinite(config.hardEasePenalty) ? config.hardEasePenalty : DEFAULT_REVIEW_STEPS.hardEasePenalty;
    ensurePhase(section);
    section.suspended = false;
    if (!Number.isFinite(section.ease) || section.ease <= 0) {
      section.ease = startingEase;
    }
    section.ease = Math.max(minimumEase, section.ease);
    section.retired = false;
    const applyReviewInterval = (minutes, { easeDelta = 0 } = {}) => {
      const finalMinutes = scheduleDue(section, minutes, now);
      section.interval = finalMinutes;
      section.pendingInterval = 0;
      section.learningStepIndex = 0;
      section.phase = "review";
      section.ease = Math.max(minimumEase, section.ease + easeDelta);
      section.streak = Math.max(1, (section.streak || 0) + 1);
    };
    const scheduleLearning = (minutes, nextIndex = 0) => {
      section.phase = "learning";
      section.learningStepIndex = nextIndex;
      section.streak = 0;
      scheduleDue(section, minutes, now);
    };
    const scheduleRelearning = (minutes, nextIndex = 0) => {
      section.phase = "relearning";
      section.learningStepIndex = nextIndex;
      section.streak = 0;
      scheduleDue(section, minutes, now);
    };
    const currentInterval = section.interval && Number.isFinite(section.interval) ? Math.max(1, Math.round(section.interval)) : 0;
    if (section.phase === "new" || section.phase === "learning") {
      const index = Math.max(0, section.learningStepIndex || 0);
      if (normalizedRating === "again") {
        scheduleLearning(learningSteps[0] ?? baseAgain, 0);
      } else if (normalizedRating === "hard") {
        const step = learningSteps[Math.min(index, learningSteps.length - 1)] ?? baseHard;
        const extended = Math.max(step, Math.round(step * hardIntervalMultiplier));
        scheduleLearning(extended, index);
      } else if (normalizedRating === "good") {
        const nextIndex = index + 1;
        if (nextIndex < learningSteps.length) {
          scheduleLearning(learningSteps[nextIndex] ?? baseGood, nextIndex);
        } else {
          const graduateInterval = asMinutes(config.graduatingGood ?? baseGood, baseGood) * intervalModifier;
          section.ease = Math.max(minimumEase, startingEase);
          applyReviewInterval(graduateInterval);
        }
      } else if (normalizedRating === "easy") {
        const graduateInterval = asMinutes(config.graduatingEasy ?? baseEasy, baseEasy) * intervalModifier;
        section.ease = Math.max(minimumEase, startingEase + easeBonus);
        applyReviewInterval(graduateInterval);
      }
    } else if (section.phase === "relearning") {
      const index = Math.max(0, section.learningStepIndex || 0);
      if (normalizedRating === "again") {
        scheduleRelearning(relearningSteps[0] ?? baseAgain, 0);
      } else if (normalizedRating === "hard") {
        const step = relearningSteps[Math.min(index, relearningSteps.length - 1)] ?? baseHard;
        const extended = Math.max(step, Math.round(step * hardIntervalMultiplier));
        scheduleRelearning(extended, index);
      } else {
        const nextIndex = index + 1;
        if (nextIndex < relearningSteps.length && normalizedRating !== "easy") {
          scheduleRelearning(relearningSteps[nextIndex] ?? baseGood, nextIndex);
        } else {
          const pending2 = section.pendingInterval && section.pendingInterval > 0 ? section.pendingInterval : Math.max(1, Math.round((currentInterval || baseGood) * lapseIntervalMultiplier));
          const intervalBase = normalizedRating === "easy" ? Math.max(pending2, Math.round(pending2 * easyIntervalBonus)) : pending2;
          const finalInterval = Math.max(1, Math.round(intervalBase * intervalModifier));
          const easeDelta = normalizedRating === "easy" ? easeBonus : 0;
          section.ease = Math.max(minimumEase, section.ease + easeDelta);
          applyReviewInterval(finalInterval, { easeDelta: 0 });
          section.pendingInterval = 0;
        }
      }
    } else {
      if (normalizedRating === "again") {
        section.ease = Math.max(minimumEase, section.ease - easePenalty);
        section.lapses = Math.max(0, (section.lapses || 0) + 1);
        section.pendingInterval = Math.max(1, Math.round((currentInterval || baseGood) * lapseIntervalMultiplier));
        scheduleRelearning(relearningSteps[0] ?? baseAgain, 0);
      } else if (normalizedRating === "hard") {
        section.ease = Math.max(minimumEase, section.ease - hardEasePenalty);
        const nextInterval = Math.max(1, Math.round((currentInterval || baseGood) * hardIntervalMultiplier * intervalModifier));
        applyReviewInterval(nextInterval);
      } else if (normalizedRating === "good") {
        const base = currentInterval || baseGood;
        const rawInterval = Math.max(base, Math.round(base * section.ease));
        const nextInterval = Math.max(1, Math.round(rawInterval * intervalModifier));
        applyReviewInterval(nextInterval);
      } else if (normalizedRating === "easy") {
        const base = currentInterval || baseEasy;
        section.ease = Math.max(minimumEase, section.ease + easeBonus);
        const rawInterval = Math.max(base, Math.round(base * section.ease * easyIntervalBonus));
        const nextInterval = Math.max(1, Math.round(rawInterval * intervalModifier));
        applyReviewInterval(nextInterval);
      }
    }
    section.lastRating = normalizedRating;
    section.last = now;
    return section;
  }
  function rateSection(item, key, rating, durations, now = Date.now()) {
    if (!item || !key) return null;
    const config = normalizeReviewSteps(durations);
    applyRatingState(section, rating, config, now);
    return section;
  }
  function projectSectionRating(item, key, rating, durations, now = Date.now()) {
    if (!item || !key) return null;
    const snapshot = getSectionStateSnapshot(item, key);
    if (!snapshot) return null;
    const config = normalizeReviewSteps(durations);
    const copy = JSON.parse(JSON.stringify(snapshot));
    applyRatingState(copy, rating, config, now);
    return copy;
  }
  function suspendSection(item, key, now = Date.now()) {
    if (!item || !key) return null;
    const section = ensureSectionState(item, key);
    section.suspended = true;
    section.phase = "suspended";
    section.due = Number.MAX_SAFE_INTEGER;
        if (!snapshot || snapshot.retired || snapshot.suspended) continue;
          due: snapshot.due,
          phase: snapshot.phase,
          state: snapshot
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
        try {
          const durations = await durationsPromise;
          updatePreviews(durations);
        } catch (err) {
        }
      };
          updatePreviews(durations);
        const label2 = document.createElement("span");
        label2.className = "flash-rating-label";
        label2.textContent = RATING_LABELS[value];
        const preview = document.createElement("span");
        preview.className = "flash-rating-preview";
        btn.appendChild(label2);
        btn.appendChild(preview);
        ratingPreviews.set(value, preview);
      renderPreviews();
  function formatIntervalMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return "\u2014";
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
  function entryKey(entry) {
    if (!entry) return null;
    const itemId = entry.itemId || entry.item?.id || entry.item?.slug || entry.item?.name || "item";
    return `${itemId}::${entry.sectionKey}`;
  }
  function createSelectionModel(onChange) {
    const selected = /* @__PURE__ */ new Map();
    const api = {
      keyOf: entryKey,
      toggle(entry, active = true) {
        const key = entryKey(entry);
        if (!key) return;
        if (active) {
          selected.set(key, entry);
        } else {
          selected.delete(key);
        }
        if (typeof onChange === "function") onChange(api);
      },
      clear() {
        if (!selected.size) return;
        selected.clear();
        if (typeof onChange === "function") onChange(api);
      },
      selectAll(entries = []) {
        let changed = false;
        entries.forEach((entry) => {
          const key = entryKey(entry);
          if (!key) return;
          if (!selected.has(key)) {
            selected.set(key, entry);
            changed = true;
          }
        });
        if (changed && typeof onChange === "function") onChange(api);
      },
      entries() {
        return Array.from(selected.values());
      },
      has(entry) {
        return selected.has(entryKey(entry));
      },
      hasKey(key) {
        return selected.has(key);
      },
      size() {
        return selected.size;
      },
      keys() {
        return Array.from(selected.keys());
      }
    };
    return api;
  }
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
    }
  }
  function renderAllView(container, dueEntries, upcomingEntries, now, start, blocks, redraw) {
    const allEntries = [...dueEntries, ...upcomingEntries];
    const entryRefs = /* @__PURE__ */ new Map();
    let busy = false;
    const normalizedBlocks = Array.isArray(blocks) ? blocks : [];
    let updateSelectionUI = () => {
    };
    const selectionModel = createSelectionModel(() => updateSelectionUI());
    const selectionBar = document.createElement("div");
    selectionBar.className = "review-selection-bar";
    const selectionInfo = document.createElement("div");
    selectionInfo.className = "review-selection-info";
    selectionInfo.textContent = "Select cards to manage them.";
    selectionBar.appendChild(selectionInfo);
    const selectionControls = document.createElement("div");
    selectionControls.className = "review-selection-controls";
    selectionBar.appendChild(selectionControls);
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "btn tertiary";
    selectAllBtn.textContent = "Select all";
    selectAllBtn.addEventListener("click", () => {
      selectionModel.selectAll(allEntries);
    });
    selectionControls.appendChild(selectAllBtn);
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn tertiary";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => selectionModel.clear());
    selectionControls.appendChild(clearBtn);
    const selectionActions = document.createElement("div");
    selectionActions.className = "review-selection-actions";
    selectionBar.appendChild(selectionActions);
    const startSelectedBtn = document.createElement("button");
    startSelectedBtn.type = "button";
    startSelectedBtn.className = "btn secondary";
    startSelectedBtn.textContent = "Start selected";
    startSelectedBtn.addEventListener("click", () => {
      const entries = selectionModel.entries();
      if (!entries.length) return;
      start(buildSessionPayload(entries), {
        scope: "selection",
        label: `Custom review (${entries.length})`
      });
    });
    selectionActions.appendChild(startSelectedBtn);
    const suspendBtn = document.createElement("button");
    suspendBtn.type = "button";
    suspendBtn.className = "btn secondary";
    suspendBtn.textContent = "Suspend";
    selectionActions.appendChild(suspendBtn);
    const retireBtn = document.createElement("button");
    retireBtn.type = "button";
    retireBtn.className = "btn secondary danger";
    retireBtn.textContent = "Retire";
    selectionActions.appendChild(retireBtn);
    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "btn secondary";
    moveBtn.textContent = "Move";
    selectionActions.appendChild(moveBtn);
    const selectionStatus = document.createElement("div");
    selectionStatus.className = "review-selection-status";
    selectionBar.appendChild(selectionStatus);
    const movePanel = document.createElement("div");
    movePanel.className = "review-move-panel";
    movePanel.hidden = true;
    const moveLabel = document.createElement("label");
    moveLabel.className = "review-move-label";
    moveLabel.textContent = "Move to block";
    const moveSelect = document.createElement("select");
    moveSelect.className = "input review-move-select";
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = "Choose\u2026";
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    moveSelect.appendChild(placeholderOption);
    normalizedBlocks.forEach((block) => {
      if (!block) return;
      const option = document.createElement("option");
      option.value = block.blockId;
      option.textContent = block.title || block.blockId || "Untitled block";
      moveSelect.appendChild(option);
    });
    const unassignOption = document.createElement("option");
    unassignOption.value = "__unassigned";
    unassignOption.textContent = "Unassign from blocks";
    moveSelect.appendChild(unassignOption);
    moveLabel.appendChild(moveSelect);
    movePanel.appendChild(moveLabel);
    const replaceWrap = document.createElement("label");
    replaceWrap.className = "review-move-replace";
    const replaceCheckbox = document.createElement("input");
    replaceCheckbox.type = "checkbox";
    replaceWrap.appendChild(replaceCheckbox);
    const replaceText = document.createElement("span");
    replaceText.textContent = "Replace existing blocks";
    replaceWrap.appendChild(replaceText);
    movePanel.appendChild(replaceWrap);
    const moveActions = document.createElement("div");
    moveActions.className = "review-move-actions";
    const applyMoveBtn = document.createElement("button");
    applyMoveBtn.type = "button";
    applyMoveBtn.className = "btn";
    applyMoveBtn.textContent = "Apply move";
    const cancelMoveBtn = document.createElement("button");
    cancelMoveBtn.type = "button";
    cancelMoveBtn.className = "btn tertiary";
    cancelMoveBtn.textContent = "Cancel";
    moveActions.appendChild(applyMoveBtn);
    moveActions.appendChild(cancelMoveBtn);
    movePanel.appendChild(moveActions);
    selectionBar.appendChild(movePanel);
    container.appendChild(selectionBar);
    const setBusy = (value) => {
      busy = value;
      selectionBar.classList.toggle("is-busy", value);
      moveSelect.disabled = value;
      replaceCheckbox.disabled = value;
      applyMoveBtn.disabled = value;
      cancelMoveBtn.disabled = value;
      updateSelectionUI();
    };
    updateSelectionUI = () => {
      const selectedKeys = selectionModel.keys();
      const count = selectionModel.size();
      selectionInfo.textContent = count ? `${count} card${count === 1 ? "" : "s"} selected` : "Select cards to manage them.";
      const disableActions = busy || count === 0;
      startSelectedBtn.disabled = disableActions;
      suspendBtn.disabled = disableActions;
      retireBtn.disabled = disableActions;
      moveBtn.disabled = disableActions;
      clearBtn.disabled = busy || count === 0;
      selectAllBtn.disabled = busy || !allEntries.length || count === allEntries.length;
      const selectedSet = new Set(selectedKeys);
      entryRefs.forEach((refs, key) => {
        const selected = selectedSet.has(key);
        if (refs.checkbox) refs.checkbox.checked = selected;
        if (refs.element) refs.element.classList.toggle("is-selected", selected);
      });
    };
    const runBulkAction = async (handler, { successMessage, failureMessage }) => {
      const entries = selectionModel.entries();
      if (!entries.length) return false;
      let succeeded = false;
      setBusy(true);
      selectionStatus.textContent = "Working\u2026";
      selectionStatus.classList.remove("is-error", "is-success");
      try {
        await handler(entries);
        selectionStatus.textContent = successMessage || "Done.";
        selectionStatus.classList.add("is-success");
        selectionModel.clear();
        succeeded = true;
      } catch (err) {
        console.error("Bulk review action failed", err);
        selectionStatus.textContent = failureMessage || "Action failed.";
        selectionStatus.classList.add("is-error");
      } finally {
        setBusy(false);
        setTimeout(() => {
          selectionStatus.textContent = "";
          selectionStatus.classList.remove("is-error", "is-success");
        }, 2400);
      }
      return succeeded;
    };
    suspendBtn.addEventListener("click", async () => {
      const success = await runBulkAction(async (entries) => {
        const nowTs = Date.now();
        for (const entry of entries) {
          suspendSection(entry.item, entry.sectionKey, nowTs);
          await upsertItem(entry.item);
        }
      }, { successMessage: "Suspended selected cards." });
      if (success && typeof redraw === "function") redraw();
    });
    retireBtn.addEventListener("click", async () => {
      const success = await runBulkAction(async (entries) => {
        const steps = await getReviewDurations();
        const nowTs = Date.now();
        for (const entry of entries) {
          rateSection(entry.item, entry.sectionKey, RETIRE_RATING, steps, nowTs);
          await upsertItem(entry.item);
        }
      }, { successMessage: "Retired selected cards." });
      if (success && typeof redraw === "function") redraw();
    });
    moveBtn.addEventListener("click", () => {
      if (movePanel.hidden) {
        movePanel.hidden = false;
        moveBtn.classList.add("is-active");
        moveSelect.focus();
      } else {
        movePanel.hidden = true;
        moveBtn.classList.remove("is-active");
      }
    });
    cancelMoveBtn.addEventListener("click", () => {
      movePanel.hidden = true;
      moveBtn.classList.remove("is-active");
    });
    applyMoveBtn.addEventListener("click", async () => {
      const target = moveSelect.value;
      if (!target) {
        moveSelect.focus();
        return;
      }
      const replace = replaceCheckbox.checked;
      const success = await runBulkAction(async (entries) => {
        for (const entry of entries) {
          const item = entry.item;
          const currentBlocks = Array.isArray(item.blocks) ? [...item.blocks] : [];
          if (target === "__unassigned") {
            item.blocks = [];
          } else if (replace) {
            item.blocks = [target];
          } else {
            const next = new Set(currentBlocks);
            next.add(target);
            item.blocks = Array.from(next);
          }
          await upsertItem(item);
        }
      }, {
        successMessage: target === "__unassigned" ? "Unassigned selected cards." : "Updated block assignments."
      });
      movePanel.hidden = true;
      moveBtn.classList.remove("is-active");
      if (success && typeof redraw === "function") redraw();
    });
    const registerEntry = (entry, checkbox, element) => {
      const key = selectionModel.keyOf(entry);
      if (!key) return;
      entryRefs.set(key, { checkbox, element });
    };
      updateSelectionUI();
    const buildEntryElement = (entry, { upcoming = false } = {}) => {
      const item = document.createElement("li");
      item.className = "review-entry";
      if (upcoming) item.classList.add("is-upcoming");
      const row = document.createElement("div");
      row.className = "review-entry-row";
      const checkboxLabel = document.createElement("label");
      checkboxLabel.className = "review-entry-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "review-entry-check";
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", (event) => {
        event.stopPropagation();
        selectionModel.toggle(entry, checkbox.checked);
      });
      checkboxLabel.appendChild(checkbox);
      row.appendChild(checkboxLabel);
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "review-entry-trigger";
      trigger.setAttribute("aria-label", upcoming ? `Review ${titleOf2(entry.item)} early` : `Review ${titleOf2(entry.item)} immediately`);
      const title = document.createElement("div");
      title.className = "review-entry-title";
      title.textContent = titleOf2(entry.item);
      trigger.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "review-entry-meta";
      meta.textContent = `${getSectionLabel(entry.item, entry.sectionKey)} \u2022 ${upcoming ? formatTimeUntil2(entry.due, now) : formatOverdue2(entry.due, now)}`;
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
      const launch = () => {
        start(buildSessionPayload([entry]), { scope: "single", label: `Focused review \u2013 ${titleOf2(entry.item)}` });
      };
      trigger.addEventListener("click", launch);
      row.appendChild(trigger);
      item.appendChild(row);
      registerEntry(entry, checkbox, item);
      return item;
    };
        list.appendChild(buildEntryElement(entry));
        list.appendChild(buildEntryElement(entry, { upcoming: true }));
    updateSelectionUI();
      renderAllView(body, dueEntries, upcomingEntries, now, startSession, blocks, redraw);
        const hasNativeScrollTo = typeof window.scrollTo === "function" && !String(window.scrollTo).includes("notImplemented");
        const shouldRestoreWindow = !ua.includes("jsdom") && hasNativeScrollTo;
