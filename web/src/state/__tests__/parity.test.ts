import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isParity, parityStore, prefsMotionProbe, useAnimationsEnabled, useParity } from "~/state/parity";
import { LIVE_INTERVALS, prefsStore, resolvedTheme, setPrefs } from "~/state/prefs";

afterEach(() => {
  cleanup();
  act(() => {
    parityStore.setState(() => ({ enabled: false }));
    prefsMotionProbe.setState(() => ({ reduced: false }));
  });
});

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

  it("sets the parity document marker when enabled before module initialization", async () => {
    const original = window.__BURROW_PARITY__;
    vi.resetModules();
    window.__BURROW_PARITY__ = true;
    try {
      const freshParity = await import("~/state/parity");
      expect(freshParity.isParity()).toBe(true);
      expect(document.documentElement.getAttribute("data-parity")).toBe("1");
    } finally {
      window.__BURROW_PARITY__ = original;
      document.documentElement.removeAttribute("data-parity");
    }
  });

  it("exports the hook and store used by consumers", () => {
    expect(typeof useParity).toBe("function");
    expect(parityStore.get().enabled).toBe(false);
  });

  it("disables JavaScript animation for parity mode and reduced motion", () => {
    const { result } = renderHook(() => useAnimationsEnabled());
    expect(result.current).toBe(true);

    act(() => prefsMotionProbe.setState(() => ({ reduced: true })));
    expect(result.current).toBe(false);

    act(() => {
      prefsMotionProbe.setState(() => ({ reduced: false }));
      parityStore.setState(() => ({ enabled: true }));
    });
    expect(result.current).toBe(false);
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

  it("marks reduced motion on <html> when the user asks for it", async () => {
    await act(async () => setPrefs({ motion: "reduced" }));
    expect(document.documentElement.getAttribute("data-motion")).toBe("reduced");
    await act(async () => setPrefs({ motion: "system" }));
    expect(document.documentElement.getAttribute("data-motion")).toBeNull();
  });

  it("keeps livePaused in the store (the top bar reads it)", () => {
    setPrefs({ livePaused: true });
    expect(prefsStore.get().livePaused).toBe(true);
    setPrefs({ livePaused: false });
  });
});
