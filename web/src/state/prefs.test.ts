import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

afterEach(() => {
  localStorage.removeItem("burrow.prefs.v1");
  if (typeof document !== "undefined") {
    Reflect.deleteProperty(document, "startViewTransition");
    document.documentElement.removeAttribute("data-switching");
    document.documentElement.removeAttribute("data-motion");
  }
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
  it("crossfades a theme change through a root view transition", async () => {
    const { applyPrefsToDom, PREF_DEFAULTS } = await import("./prefs");
    const el = document.documentElement;
    el.setAttribute("data-theme", "dark");
    el.removeAttribute("data-motion");
    const start = vi.fn((write: () => void) => {
      write();
      return { finished: Promise.resolve() };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });

    applyPrefsToDom({ ...PREF_DEFAULTS, theme: "light" });

    expect(start).toHaveBeenCalledOnce();
    expect(el.getAttribute("data-theme")).toBe("light");
    expect(el.getAttribute("data-switching")).toBe("1");
    await Promise.resolve();
    expect(el.hasAttribute("data-switching")).toBe(false);
  });

  it("snaps theme changes instead of crossfading under reduced motion", async () => {
    const { applyPrefsToDom, PREF_DEFAULTS } = await import("./prefs");
    const el = document.documentElement;
    el.setAttribute("data-theme", "dark");
    el.setAttribute("data-motion", "reduced");
    const start = vi.fn((write: () => void) => {
      write();
      return { finished: Promise.resolve() };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });

    applyPrefsToDom({ ...PREF_DEFAULTS, theme: "light" });

    expect(start).not.toHaveBeenCalled();
    expect(el.getAttribute("data-theme")).toBe("light");
  });

  it("falls back to a snap when the view transition API throws", async () => {
    const { applyPrefsToDom, PREF_DEFAULTS } = await import("./prefs");
    const el = document.documentElement;
    el.setAttribute("data-theme", "dark");
    el.removeAttribute("data-motion");
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: () => {
        throw new Error("transition busy");
      },
    });

    applyPrefsToDom({ ...PREF_DEFAULTS, theme: "light" });

    expect(el.getAttribute("data-theme")).toBe("light");
  });

  it("clears the switch lock when a view transition is skipped", async () => {
    const { applyPrefsToDom, PREF_DEFAULTS } = await import("./prefs");
    const el = document.documentElement;
    el.setAttribute("data-theme", "dark");
    el.removeAttribute("data-motion");
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (write: () => void) => {
        write();
        return { finished: Promise.reject(new Error("skipped")) };
      },
    });

    applyPrefsToDom({ ...PREF_DEFAULTS, theme: "light" });
    await Promise.resolve();

    expect(el.getAttribute("data-theme")).toBe("light");
    expect(el.hasAttribute("data-switching")).toBe(false);
  });

  it("updates theme-specific favicons and leaves missing URLs untouched", async () => {
    const { applyPrefsToDom, PREF_DEFAULTS } = await import("./prefs");
    const icon = document.createElement("link");
    icon.dataset.darkHref = "/dark.svg";
    icon.dataset.lightHref = "/light.svg";
    document.head.append(icon);
    const missing = document.createElement("link");
    missing.dataset.darkHref = "";
    missing.dataset.lightHref = "";
    document.head.append(missing);
    applyPrefsToDom({ ...PREF_DEFAULTS, theme: "dark" });
    expect(icon.getAttribute("href")).toBe("/dark.svg");
    expect(missing.hasAttribute("href")).toBe(false);
    applyPrefsToDom({ ...PREF_DEFAULTS, theme: "light" });
    expect(icon.getAttribute("href")).toBe("/light.svg");
    expect(missing.hasAttribute("href")).toBe(false);
  });
});
