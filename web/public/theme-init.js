/* Pre-paint theme bootstrap. External file (not inline) so the strict CSP `script-src 'self'` holds. */
// Zod checks `new Function` during module evaluation. Seed its public global config before app bundles load.
globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };

(() => {
  try {
    const p = JSON.parse(localStorage.getItem("burrow.prefs.v1") || "{}");
    const el = document.documentElement;
    let theme = p.theme || "system";
    if (theme === "system") theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    el.setAttribute("data-theme", theme);
    if (p.motion === "reduced") el.setAttribute("data-motion", "reduced");
    // RootDocument mirrors pre-paint attributes during hydration; prefs.ts keeps them in sync with storage afterward.
    if (p.railCollapsed === true) el.setAttribute("data-rail-collapsed", "true");
    const q = new URLSearchParams(location.search).get("parity");
    if (q === "1" || q === "true" || window.__BURROW_PARITY__ === true) el.setAttribute("data-parity", "1");
  } catch {
    /* localStorage/matchMedia unavailable: the app applies defaults on hydration */
  }
})();
