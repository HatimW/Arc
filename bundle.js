  function canUseWindowScroll() {
    if (typeof window === "undefined" || typeof window.scrollTo !== "function") {
      return false;
    }
    if (typeof globalThis !== "undefined" && globalThis.__SEVENN_TEST__) {
      return false;
    }
    try {
      const nav = typeof navigator !== "undefined" ? navigator : typeof window.navigator !== "undefined" ? window.navigator : null;
      const ua = nav && typeof nav.userAgent === "string" ? nav.userAgent.toLowerCase() : "";
      if (ua.includes("jsdom")) return false;
    } catch (err) {
    }
    try {
      const scrollToSource = Function.prototype.toString.call(window.scrollTo);
      if (scrollToSource.includes("notImplemented")) {
        return false;
      }
    } catch (err) {
      return false;
    }
    if (window._virtualConsole && typeof window._virtualConsole.emit === "function") {
      return false;
    }
    return true;
  }
          regex.lastIndex = 0;
        } else if (canUseWindowScroll()) {
        if (hasWindow && canUseWindowScroll()) {
      if (snapshot.windowX != null && snapshot.windowY != null && typeof window !== "undefined" && canUseWindowScroll()) {
        try {
          window.scrollTo(snapshot.windowX, snapshot.windowY);
        } catch (err) {
      if (canUseWindowScroll()) {
//# sourceMappingURL=bundle.js.map
