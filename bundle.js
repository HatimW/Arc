  function normalizeOptionId(value) {
    if (value == null) return null;
    return String(value);
  }
  function optionIdsEqual(a, b) {
    const normA = normalizeOptionId(a);
    const normB = normalizeOptionId(b);
    if (normA == null || normB == null) return normA === normB;
    return normA === normB;
  }
  function findOptionById(question, answerId) {
    if (!question?.options?.length) return null;
    const normalized2 = normalizeOptionId(answerId);
    if (normalized2 == null) return null;
    return question.options.find((opt) => normalizeOptionId(opt.id) === normalized2) || null;
  }
  function optionMatches(question, answerId) {
    if (!question) return false;
    return Boolean(findOptionById(question, answerId));
  }
  function isCorrectAnswer(question, answerId) {
    if (!question) return false;
    return optionIdsEqual(question.answer, answerId);
  }
    if (optionIdsEqual(prev, nextAnswer)) return;
    const normalizedPrev = prev != null ? normalizeOptionId(prev) : null;
    const normalizedNext = nextAnswer != null ? normalizeOptionId(nextAnswer) : null;
    if (normalizedPrev == null) {
      if (normalizedNext != null && stat.initialAnswer == null) {
        stat.initialAnswer = normalizedNext;
      from: normalizedPrev,
      to: normalizedNext
    if (normalizedPrev != null) change.fromCorrect = isCorrectAnswer(question, normalizedPrev);
    if (normalizedNext != null) change.toCorrect = isCorrectAnswer(question, normalizedNext);
      changes: Array.isArray(stat?.changes) ? stat.changes.map((change) => ({
        ...change,
        from: change?.from != null ? normalizeOptionId(change.from) : null,
        to: change?.to != null ? normalizeOptionId(change.to) : null
      })) : [],
      initialAnswer: stat?.initialAnswer != null ? normalizeOptionId(stat.initialAnswer) : null,
      const normalized2 = normalizeOptionId(value);
      if (normalized2 == null) return;
      if (sequence[sequence.length - 1] === normalized2) return;
      sequence.push(normalized2);
    const answerId = normalizeOptionId(question.answer);
    const fallbackInitial = stat?.initialAnswer != null ? normalizeOptionId(stat.initialAnswer) : null;
    const fallbackFinal = finalAnswer != null ? normalizeOptionId(finalAnswer) : null;
    const initialAnswer = sequence.length ? sequence[0] : fallbackInitial;
    const resolvedFinalAnswer = sequence.length ? sequence[sequence.length - 1] : fallbackFinal;
    const initialCorrect = initialAnswer != null && answerId != null ? initialAnswer === answerId : null;
    const finalCorrect = resolvedFinalAnswer != null && answerId != null ? resolvedFinalAnswer === answerId : null;
        row[correctCol] = isCorrectAnswer(question, opt.id) ? "TRUE" : "";
      if (!optionMatches(question, question.answer)) {
        question.answer = question.options[0]?.id || "";
      if (!optionMatches(question, question.answer)) {
      const panelHeight = menuPanel.scrollHeight || 0;
      card.style.setProperty("--card-menu-extra-space", `${Math.max(0, panelHeight + 32)}px`);
      card.style.removeProperty("--card-menu-extra-space");
    const option = findOptionById(question, id);
    const html = option?.text || "";
    const optionValue = normalizeOptionId(optionId);
    const correctValue = normalizeOptionId(question.answer);
    const selectedValue = selectedId != null ? normalizeOptionId(selectedId) : null;
    const optionIsCorrect = optionValue != null && correctValue != null && optionValue === correctValue;
    if (selectedValue == null) return optionIsCorrect ? "correct-answer" : "";
    if (optionValue != null && selectedValue === optionValue) {
      return optionIsCorrect ? "correct-answer" : "incorrect-answer";
    return optionIsCorrect ? "correct-answer" : "";
      return optionMatches(question, answer) ? count + 1 : count;
    const flaggedValues = sess.mode === "review" ? Array.isArray(sess.result?.flagged) ? sess.result.flagged : [] : Object.entries(sess.flagged || {}).filter(([_, v]) => Boolean(v)).map(([idx]) => idx);
    const flaggedSet = new Set(flaggedValues.map((value) => Number(value)).filter(Number.isFinite));
      const label = document.createElement("span");
      label.className = "question-map__label";
      label.textContent = String(idx + 1);
      item.appendChild(label);
      const flagIndicator = document.createElement("span");
      flagIndicator.className = "question-map__flag";
      flagIndicator.setAttribute("aria-hidden", "true");
      flagIndicator.textContent = "\u{1F6A9}";
      item.appendChild(flagIndicator);
      const answered = answer != null && optionMatches(question, answer);
          const isCorrect = isCorrectAnswer(question, answer);
          const isCorrect = isCorrectAnswer(question, answer);
      const isFlagged = flaggedSet.has(idx);
      item.dataset.flagged = isFlagged ? "true" : "false";
      flagIndicator.hidden = !isFlagged;
      if (isFlagged) {
        tooltipParts.push("Flagged");
      const isSelected = optionIdsEqual(selected, opt.id);
      if (selected != null && optionMatches(question, selected)) {
        if (isCorrectAnswer(question, selected)) {
      } else if (selected != null) {
        verdictText = "Incorrect";
        verdictClass = "incorrect";
      if (ans == null) return;
      if (!optionMatches(question, ans)) return;
      answers[idx] = ans;
      answeredCount += 1;
      if (isCorrectAnswer(question, ans)) correct += 1;
            radio.checked = optionIdsEqual(question.answer, opt.id);
              if (optionIdsEqual(question.answer, opt.id)) {
        if (!optionMatches(question, question.answer)) {
