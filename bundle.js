        detailsVisible: false
        const allowData = tag === "img" || tag === "video" || tag === "audio" || tag === "source";
    __setCardsDeps: () => __setCardsDeps,
  function __setCardsDeps(overrides = {}) {
    deps.loadBlockCatalog = typeof overrides.loadBlockCatalog === "function" ? overrides.loadBlockCatalog : loadBlockCatalog;
  }
    let blockDefs = [];
    try {
      const catalog2 = await deps.loadBlockCatalog();
      blockDefs = Array.isArray(catalog2?.blocks) ? catalog2.blocks : [];
    } catch (err) {
      console.warn("[cards] Unable to load block catalog, continuing with card data only", err);
      blockDefs = [];
    }
    const heroStats = { blocks: blockSections.length, lectures: totalLectures };
    heroSubtitle.textContent = "Browse lecture-aligned decks with smoother spacing and quick controls for expanding everything or focusing on your most recent content.";
    const createStatPill = (label, initialValue = "0") => {
      const pill = document.createElement("span");
      pill.className = "cards-hero__pill";
      const labelEl = document.createElement("small");
      labelEl.textContent = label;
      const valueEl = document.createElement("strong");
      valueEl.textContent = initialValue;
      pill.append(labelEl, valueEl);
      return { pill, valueEl };
    };
    const { pill: statBlocks, valueEl: statBlocksValue } = createStatPill("Blocks");
    const { pill: statLectures, valueEl: statLecturesValue } = createStatPill("Lectures");
    const { pill: statCards, valueEl: statCardsValue } = createStatPill("Cards", String(sortedItems.length));
    refreshHeroStats(heroStats);
  var UNASSIGNED_BLOCK_KEY, MISC_LECTURE_KEY, deps, KIND_COLORS, KIND_FIELDS, TITLE_CACHE;
      deps = {
        loadBlockCatalog
      };
    if (root && typeof root.closest === "function") {
      const scopedSession = root.closest(".exam-session");
      if (scopedSession) return scopedSession;
    }
        const optionHtml2 = sanitizeRichText(getCell(row, `option${i}`));
        if (!optionHtml2) continue;
        const option = { id: uid(), text: optionHtml2 };
    const layout = state.examLayout || { mode: "grid", detailsVisible: false };
      const nextExpanded = !isExpanded;
      if (nextExpanded) {
        state.examAttemptExpanded = {};
      }
      setExamAttemptExpanded(exam.id, nextExpanded);
  function optionHtml(question, id) {
    const html = question.options.find((opt) => opt.id === id)?.text || "";
    return sanitizeRichText(html);
  }
  function makeZoomableImage(img) {
    if (!img || typeof img.addEventListener !== "function") return;
    img.classList.add("zoomable-media");
    img.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      img.classList.toggle("is-expanded");
    });
  }
  function markInlineMedia(container) {
    if (!container || typeof container.querySelectorAll !== "function") return;
    const selectors = [
      ".exam-media img",
      ".exam-stem img",
      ".exam-option .option-text img",
      ".exam-explanation-body img",
      ".exam-answer-html img"
    ];
    selectors.forEach((selector) => {
      container.querySelectorAll(selector).forEach((el) => {
        makeZoomableImage(el);
      });
    });
  }
      makeZoomableImage(img);
  function incorrectQuestionIndices(exam, result) {
    if (!exam || !result) return [];
    const questions = Array.isArray(exam.questions) ? exam.questions : [];
    return questions.reduce((list, question, idx) => {
      const ans = result.answers?.[idx];
      if (ans == null || ans !== question?.answer) {
        list.push(idx);
      }
      return list;
    }, []);
  }
  function subsetExamForIndices(exam, result, indices) {
    const valid = Array.isArray(indices) ? indices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < (exam?.questions?.length || 0)) : [];
    if (!exam || !valid.length) return null;
    const baseQuestions = Array.isArray(exam.questions) ? exam.questions : [];
    const nextExam = clone5(exam);
    nextExam.questions = valid.map((idx) => ({ ...clone5(baseQuestions[idx]), originalIndex: idx }));
    if (!result) return { exam: nextExam };
    const nextResult = clone5(result) || {};
    nextResult.answers = {};
    nextResult.flagged = [];
    nextResult.questionStats = [];
    let answered = 0;
    let correct = 0;
    valid.forEach((origIdx, newIdx) => {
      const answer = result.answers?.[origIdx];
      if (answer != null) {
        nextResult.answers[newIdx] = answer;
        answered += 1;
        if (answer === baseQuestions[origIdx]?.answer) {
          correct += 1;
        }
      }
      if (Array.isArray(result.flagged) && result.flagged.includes(origIdx)) {
        nextResult.flagged.push(newIdx);
      }
      const stat = Array.isArray(result.questionStats) ? clone5(result.questionStats[origIdx]) : null;
      nextResult.questionStats[newIdx] = stat || {
        timeMs: 0,
        changes: [],
        enteredAt: null,
        initialAnswer: null,
        initialAnswerAt: null
      };
    });
    nextResult.total = nextExam.questions.length;
    nextResult.correct = correct;
    nextResult.answered = answered;
    nextResult.changeSummary = summarizeAnswerChanges(nextResult.questionStats, nextExam, nextResult.answers);
    return { exam: nextExam, result: nextResult };
  }
      const answerSummaryList = document.createElement("div");
      answerSummaryList.className = "exam-answer-summary-list";
      const renderAnswerRow = (labelText, html) => {
        const row = document.createElement("div");
        row.className = "exam-answer-row";
        const label = document.createElement("strong");
        label.textContent = `${labelText}:`;
        row.appendChild(label);
        const body = document.createElement("div");
        body.className = "exam-answer-html";
        const safeHtml = html && !isEmptyHtml(html) ? html : "<em>\u2014</em>";
        body.innerHTML = safeHtml;
        row.appendChild(body);
        return row;
      };
      answerSummaryList.appendChild(renderAnswerRow("Your answer", optionHtml(question, selected)));
      answerSummaryList.appendChild(renderAnswerRow("Correct answer", optionHtml(question, question.answer)));
      answerSummary.appendChild(answerSummaryList);
    markInlineMedia(main);
    const wrongIndices = incorrectQuestionIndices(sess.exam, sess.latestResult);
    const reviewWrongBtn = document.createElement("button");
    reviewWrongBtn.className = "btn secondary";
    reviewWrongBtn.textContent = "Review Incorrect";
    reviewWrongBtn.disabled = wrongIndices.length === 0;
    reviewWrongBtn.addEventListener("click", () => {
      const subset = subsetExamForIndices(sess.exam, sess.latestResult, wrongIndices);
      if (!subset) return;
      setExamSession({
        mode: "review",
        exam: subset.exam,
        result: subset.result,
        idx: 0,
        fromSummary: clone5(sess.latestResult)
      });
      render();
    });
    actions.appendChild(reviewWrongBtn);
    const retakeWrong = document.createElement("button");
    retakeWrong.className = "btn secondary";
    retakeWrong.textContent = "Retake Incorrect";
    retakeWrong.disabled = wrongIndices.length === 0;
    retakeWrong.addEventListener("click", () => {
      const subset = subsetExamForIndices(sess.exam, null, wrongIndices);
      if (!subset) return;
      setExamSession(createTakingSession(subset.exam));
      render();
    });
    actions.appendChild(retakeWrong);
        mediaInput.addEventListener("paste", (event) => {
          void handleMediaPaste(event);
        });
        async function handleMediaPaste(event) {
          if (!event?.clipboardData) return;
          const files = Array.from(event.clipboardData.files || []);
          const file = files.find((f) => f && typeof f.type === "string" && (f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/")));
          if (!file) return;
          event.preventDefault();
          try {
            const dataUrl = await readFileAsDataUrl(file);
            if (typeof dataUrl === "string" && dataUrl) {
              question.media = dataUrl;
              mediaInput.value = question.media;
              updatePreview();
              markDirty();
            }
          } catch (err) {
            console.warn("Failed to read pasted media", err);
          }
        }
      init_media_upload();
