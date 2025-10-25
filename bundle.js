    const adjustMenuSpace = () => {
      const panelHeight = menuPanel.getBoundingClientRect().height;
      if (!panelHeight) return;
      const gap = Math.ceil(panelHeight + 24);
      menuWrap.style.setProperty("--menu-open-gap", `${gap}px`);
    };
    const handleResize = () => {
      if (!menuOpen) return;
      adjustMenuSpace();
    };
      adjustMenuSpace();
      if (typeof window !== "undefined") {
        window.requestAnimationFrame?.(adjustMenuSpace);
        window.addEventListener("resize", handleResize);
      }
      menuWrap.style.removeProperty("--menu-open-gap");
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", handleResize);
      }
      const number = document.createElement("span");
      number.className = "question-map__number";
      number.textContent = String(idx + 1);
      item.appendChild(number);
      const flagIcon = document.createElement("span");
      flagIcon.className = "question-map__flag";
      flagIcon.setAttribute("aria-hidden", "true");
      flagIcon.textContent = "\uD83D\uDEA9";
      flagIcon.hidden = true;
      item.appendChild(flagIcon);
        flagIcon.hidden = false;
        tooltipParts.push("Flagged");
        flagIcon.hidden = true;
