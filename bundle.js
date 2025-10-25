      const panelHeight = menuPanel.offsetHeight;
      const calculatedSpace = Number.isFinite(panelHeight) ? panelHeight + 32 : 0;
      if (calculatedSpace > 0) {
        menuWrap.style.setProperty("--menu-panel-measured-space", `${calculatedSpace}px`);
      } else {
        menuWrap.style.removeProperty("--menu-panel-measured-space");
      }
      menuWrap.style.removeProperty("--menu-panel-measured-space");
      const label = document.createElement("span");
      label.className = "question-map__label";
      label.textContent = String(idx + 1);
      item.appendChild(label);
      const flagIndicator = document.createElement("span");
      flagIndicator.className = "question-map__flag";
      flagIndicator.setAttribute("aria-hidden", "true");
      flagIndicator.textContent = "\u{1F6A9}";
      item.appendChild(flagIndicator);
      const isFlagged = flaggedSet.has(idx);
      if (isFlagged) {
        tooltipParts.push("Flagged");
      item.dataset.flagged = isFlagged ? "true" : "false";
      flagIndicator.classList.toggle("is-visible", isFlagged);
      const ariaDescription = tooltipParts.length ? tooltipParts.join(", ") : "Not answered";
      item.setAttribute("aria-label", `Question ${idx + 1}${ariaDescription ? ` \u2013 ${ariaDescription}` : ""}`);
