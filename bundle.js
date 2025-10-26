      const panelHeight = menuPanel.scrollHeight || menuPanel.offsetHeight || 0;
      menuWrap.style.setProperty("--menu-panel-gap", `${Math.round(panelHeight + 24)}px`);
      menuWrap.style.setProperty("--menu-panel-gap", "0px");
      const number = document.createElement("span");
      number.className = "question-map__item-label";
      number.textContent = String(idx + 1);
      item.appendChild(number);
      const flagIndicator = document.createElement("span");
      flagIndicator.className = "question-map__item-flag";
      flagIndicator.setAttribute("aria-hidden", "true");
      flagIndicator.textContent = "\u{1F6A9}";
      item.appendChild(flagIndicator);
      const labelParts = [`Question ${idx + 1}`];
      if (tooltipParts.length) {
        labelParts.push(...tooltipParts);
      }
      const flagged = flaggedSet.has(idx);
      if (flagged) {
        flagIndicator.hidden = false;
        labelParts.push("Flagged");
        delete item.dataset.flagged;
        flagIndicator.hidden = true;
      }
      if (isCurrent) {
        labelParts.push("Current question");
      item.setAttribute("aria-label", labelParts.join(", "));
