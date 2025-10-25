    let menuOffsetApplied = false;
      const offset = Math.max(menuPanel.scrollHeight + 24, 64);
      card.classList.add("exam-card--menu-open");
      card.style.marginBottom = `${offset}px`;
      menuOffsetApplied = true;
      if (menuOffsetApplied) {
        card.classList.remove("exam-card--menu-open");
        card.style.marginBottom = "";
        menuOffsetApplied = false;
      }
      const label = document.createElement("span");
      label.className = "question-map__item-label";
      label.textContent = String(idx + 1);
      item.appendChild(label);
      const flagIcon = document.createElement("span");
      flagIcon.className = "question-map__item-flag";
      flagIcon.setAttribute("aria-hidden", "true");
      flagIcon.textContent = "🚩";
      item.appendChild(flagIcon);
      const isFlagged = flaggedSet.has(idx);
      item.dataset.flagged = isFlagged ? "true" : "false";
      item.classList.toggle("is-flagged", isFlagged);
      flagIcon.hidden = !isFlagged;
