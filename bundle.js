      card.classList.add("exam-card--menu-open");
      card.classList.remove("exam-card--menu-open");
      const number = document.createElement("span");
      number.className = "question-map__number";
      number.textContent = String(idx + 1);
      item.appendChild(number);
      const flagIcon = document.createElement("span");
      flagIcon.className = "question-map__flag";
      flagIcon.setAttribute("aria-hidden", "true");
      flagIcon.textContent = "\u{1F6A9}";
      item.appendChild(flagIcon);
      const ariaParts = [`Question ${idx + 1}`];
          const label = isCorrect ? "Answered correctly" : "Answered incorrectly";
          tooltipParts.push(label);
          ariaParts.push(label);
          ariaParts.push("Not answered");
            ariaParts.push("Changed from correct to incorrect");
            ariaParts.push("Changed from incorrect to correct");
            ariaParts.push("Changed answer");
          ariaParts.push("Changed answers but returned to start");
          ariaParts.push(isCorrect ? "Checked correct" : "Checked incorrect");
          ariaParts.push("Answered");
          const label = wasChecked ? "Checked without answer" : "Not answered";
          tooltipParts.push(label);
          ariaParts.push(label);
      const flagged = flaggedSet.has(idx);
      item.dataset.flagged = flagged ? "true" : "false";
      if (flagged) {
        tooltipParts.push("Flagged");
        ariaParts.push("Flagged");
      }
      if (isCurrent) {
        const label = "Current question";
        tooltipParts.push(label);
        ariaParts.push(label);
      } else {
        item.removeAttribute("title");
      item.setAttribute("aria-label", ariaParts.join(". "));
//# sourceMappingURL=bundle.js.map
