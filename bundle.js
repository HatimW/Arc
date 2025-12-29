    const normalizedBlocks = Array.isArray(blocks) ? blocks.filter((block) => block && typeof block === "object") : [];
    const blockIds = new Set(normalizedBlocks.map((block) => block?.blockId).filter(Boolean));
    const latestBlockId = resolveLatestBlockId(normalizedBlocks);
    const blockTitleMap = new Map(
      normalizedBlocks.map((block) => [block.blockId, block.title || block.blockId])
    );
    const orderMap = new Map(normalizedBlocks.map((b, i) => [b.blockId, i]));
    normalizedBlocks.forEach((block) => {
      if (typeof itemSource?.toArray === "function") {
        const collected = await itemSource.toArray();
        collected.forEach(addItem);
      } else if (typeof itemSource?.[Symbol.asyncIterator] === "function") {
    normalizedBlocks.forEach((block) => {
    if (!totalItems) {
      const empty = document.createElement("div");
      empty.className = "cards-empty entry-empty";
      const title = document.createElement("h3");
      const hasFilters = Boolean(state.query || state.filters.block || state.filters.week || state.filters.onlyFav);
      title.textContent = hasFilters ? "No entries match your filters" : "No entries yet";
      empty.appendChild(title);
      const desc = document.createElement("p");
      desc.textContent = hasFilters ? "Try clearing your filters or adjust them to see your entries." : "Add your first entry to start building your list.";
      empty.appendChild(desc);
      if (hasFilters) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "btn secondary";
        clear.textContent = "Clear filters";
        clear.addEventListener("click", () => {
          setFilters({ block: "", week: "", onlyFav: false });
          onChange && onChange();
        });
        empty.appendChild(clear);
      }
      container.appendChild(empty);
      return;
    }
      const bdef = normalizedBlocks.find((bl) => bl.blockId === b);
    let explanationPanel = null;
        explanationPanel = explain;
    if (explanationPanel) {
      main.appendChild(explanationPanel);
    }
