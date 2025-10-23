    let menuGapRaf = null;
    const updateMenuGap = () => {
      if (!menuOpen) return;
      const panelRect = menuPanel.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const overflow = Math.max(0, Math.ceil(panelRect.bottom - cardRect.bottom));
      const gap = overflow + 16;
      card.style.setProperty("--exam-card-menu-gap", `${gap}px`);
    };
    const clearMenuGap = () => {
      if (menuGapRaf != null) {
        cancelAnimationFrame(menuGapRaf);
        menuGapRaf = null;
      }
      card.style.removeProperty("--exam-card-menu-gap");
    };
      card.classList.add("exam-card--menu-open");
      updateMenuGap();
      menuGapRaf = requestAnimationFrame(() => {
        menuGapRaf = null;
        updateMenuGap();
      });
      window.addEventListener("resize", updateMenuGap);
      card.classList.remove("exam-card--menu-open");
      window.removeEventListener("resize", updateMenuGap);
      clearMenuGap();
//# sourceMappingURL=bundle.js.map
