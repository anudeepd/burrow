import { describe, expect, it, vi } from "vitest";
import { isParity, parityStore, useParity } from "~/state/parity";
import { LIVE_INTERVALS, prefsStore, resolvedTheme, setPrefs } from "~/state/prefs";

describe("parity mode", () => {
  it("is off by default in a plain page load", () => {
    expect(isParity()).toBe(false);
  });

  it("can be forced on (harness sets window.__BURROW_PARITY__ or ?parity=1 before load)", () => {
    parityStore.setState(() => ({ enabled: true }));
    expect(isParity()).toBe(true);
    expect(document.documentElement.getAttribute("data-parity")).toBeNull(); // attribute is set at module load, not on state change
    parityStore.setState(() => ({ enabled: false }));
    expect(isParity()).toBe(false);
  });

  it("exports the hook and store used by consumers", () => {
    expect(typeof useParity).toBe("function");
    expect(parityStore.get().enabled).toBe(false);
  });
});

describe("preferences", () => {
  it("offers the documented live intervals", () => {
    expect(LIVE_INTERVALS).toContain(1000);
    expect(LIVE_INTERVALS).toContain(3000);
    expect(LIVE_INTERVALS).toContain(30000);
  });

  it("resolves the system theme to dark when there is no light preference", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    expect(resolvedTheme("system")).toBe("dark");
    expect(resolvedTheme("light")).toBe("light");
    expect(resolvedTheme("dark")).toBe("dark");
  });

  it("applies prefs to <html> and persists them", () => {
    setPrefs({ theme: "light", tz: "utc" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-density")).toBeNull();
    expect(document.documentElement.getAttribute("data-tz")).toBe("utc");
    const stored = JSON.parse(window.localStorage.getItem("burrow.prefs.v1") ?? "{}");
    expect(stored).toMatchObject({ theme: "light", tz: "utc" });
    expect(stored).not.toHaveProperty("density");
    setPrefs({ theme: "system", tz: "local" });
  });

  it("marks reduced motion on <html> when the user asks for it", () => {
    setPrefs({ motion: "reduced" });
    expect(document.documentElement.getAttribute("data-motion")).toBe("reduced");
    setPrefs({ motion: "system" });
    expect(document.documentElement.getAttribute("data-motion")).toBeNull();
  });

  it("keeps livePaused in the store (the top bar reads it)", () => {
    setPrefs({ livePaused: true });
    expect(prefsStore.get().livePaused).toBe(true);
    setPrefs({ livePaused: false });
  });
});
