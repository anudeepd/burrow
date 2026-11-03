import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

afterEach(() => {
  localStorage.removeItem("burrow.prefs.v1");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("preference loading", () => {
  it("falls back to server defaults when persisted JSON is malformed", async () => {
    localStorage.setItem("burrow.prefs.v1", "{");
    vi.resetModules();
    const { prefsStore, PREF_DEFAULTS } = await import("./prefs");
    expect(prefsStore.get()).toEqual(PREF_DEFAULTS);
  });

  it("uses server fallbacks when window and document are unavailable", async () => {
    const { applyPrefsToDom, PREF_DEFAULTS, resolvedTheme } = await import("./prefs");
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    try {
      expect(resolvedTheme("system")).toBe("dark");
      expect(() => applyPrefsToDom(PREF_DEFAULTS)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads defaults during server module initialization", async () => {
    vi.stubGlobal("window", undefined);
    vi.resetModules();
    try {
      const { prefsStore, PREF_DEFAULTS } = await import("./prefs");
      expect(prefsStore.get()).toEqual(PREF_DEFAULTS);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("sets and removes the collapsed rail marker", async () => {
    const { applyPrefsToDom, PREF_DEFAULTS } = await import("./prefs");
    const el = document.documentElement;
    applyPrefsToDom({ ...PREF_DEFAULTS, railCollapsed: true });
    expect(el.getAttribute("data-rail-collapsed")).toBe("true");
    applyPrefsToDom(PREF_DEFAULTS);
    expect(el.hasAttribute("data-rail-collapsed")).toBe(false);
  });

  it("exposes preference updates and handles browser preference changes", async () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn(
        () =>
          ({
            matches: false,
            addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
          }) as unknown as MediaQueryList,
      ),
    );
    vi.resetModules();
    const storage = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage is unavailable");
    });
    const { setPrefs, usePref } = await import("./prefs");
    const { result } = renderHook(() => usePref("tz"));

    act(() => setPrefs({ tz: "utc" }));
    expect(result.current).toBe("utc");
    expect(storage).toHaveBeenCalledWith("burrow.prefs.v1", expect.stringContaining('"tz":"utc"'));
    expect(listeners).toHaveLength(2);
    act(() => {
      for (const listener of listeners) listener();
    });
  });
});
