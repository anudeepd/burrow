import { afterEach, describe, expect, it, vi } from "vitest";
import { EASE_OUT, fadeIn, flash, motionAllowed, prefersReducedMotion, tokenMs } from "~/lib/motion";
import { parityStore } from "~/state/parity";

/**
 * CSS fades follow duration tokens; imperative motion goes through motionAllowed() so parity and reduced motion cannot
 * be bypassed by WAAPI. `fadeIn()` is the narrow exception: Tier-3 opacity remains under reduced motion, while parity
 * still disables it.
 */
function clearDom() {
  document.documentElement.removeAttribute("data-motion");
  document.documentElement.removeAttribute("data-parity");
}

afterEach(() => {
  parityStore.setState(() => ({ enabled: false }));
  clearDom();
  vi.restoreAllMocks();
});

describe("motion policy", () => {
  it("allows motion by default", () => {
    expect(motionAllowed()).toBe(true);
  });

  it("forbids motion in parity mode (the screenshot contract)", () => {
    parityStore.setState(() => ({ enabled: true }));
    expect(motionAllowed()).toBe(false);
  });

  it("forbids motion when the in-app reduce toggle is on", () => {
    document.documentElement.dataset.motion = "reduced";
    expect(motionAllowed()).toBe(false);
  });

  it("forbids motion when the OS asks for reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    expect(prefersReducedMotion()).toBe(true);
    expect(motionAllowed()).toBe(false);
  });
});

describe("flash()", () => {
  it("animates the overlay over the --dur-flash token when motion is allowed", () => {
    const el = document.createElement("span");
    const animate = vi.fn(() => ({ cancel: () => {} }) as unknown as Animation);
    Object.defineProperty(el, "animate", { value: animate, configurable: true });
    document.body.append(el);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: () => "900ms" } as unknown as CSSStyleDeclaration);

    const animation = flash(el);
    expect(animation).toBeDefined();
    expect(animate).toHaveBeenCalledWith([{ opacity: 0.5 }, { opacity: 0 }], { duration: 900, easing: EASE_OUT });
  });

  it("does nothing in parity mode", () => {
    const el = document.createElement("span");
    const animate = vi.fn();
    Object.defineProperty(el, "animate", { value: animate, configurable: true });
    parityStore.setState(() => ({ enabled: true }));
    expect(flash(el)).toBeUndefined();
    expect(animate).not.toHaveBeenCalled();
  });

  it("does nothing under reduced motion, and nothing without WAAPI", () => {
    const el = document.createElement("span");
    const animate = vi.fn();
    Object.defineProperty(el, "animate", { value: animate, configurable: true });
    document.documentElement.dataset.motion = "reduced";
    expect(flash(el)).toBeUndefined();
    clearDom();
    const noWaapi = document.createElement("div");
    Object.defineProperty(noWaapi, "animate", { value: undefined, configurable: true });
    expect(flash(noWaapi)).toBeUndefined();
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("fadeIn()", () => {
  it("keeps the content opacity fade at its reduced-motion token duration", () => {
    const el = document.createElement("div");
    const animate = vi.fn(() => ({ cancel: () => {} }) as unknown as Animation);
    Object.defineProperty(el, "animate", { value: animate, configurable: true });
    document.documentElement.dataset.motion = "reduced";
    const getPropertyValue = vi.fn((token: string) => (token === "--dur-content" ? "120ms" : ""));
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue } as unknown as CSSStyleDeclaration);

    expect(fadeIn(el)).toBeDefined();
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: EASE_OUT });
    expect(getPropertyValue).toHaveBeenCalledWith("--dur-content");
    fadeIn(el, 0.4);
    expect(animate).toHaveBeenLastCalledWith([{ opacity: 0.4 }, { opacity: 1 }], { duration: 120, easing: EASE_OUT });
  });

  it("disables tab fades in parity mode and without WAAPI", () => {
    const el = document.createElement("div");
    const animate = vi.fn();
    Object.defineProperty(el, "animate", { value: animate, configurable: true });
    parityStore.setState(() => ({ enabled: true }));
    expect(fadeIn(el)).toBeUndefined();
    expect(animate).not.toHaveBeenCalled();

    parityStore.setState(() => ({ enabled: false }));
    const noWaapi = document.createElement("div");
    Object.defineProperty(noWaapi, "animate", { value: undefined, configurable: true });
    expect(fadeIn(noWaapi)).toBeUndefined();
  });
});

describe("tokenMs()", () => {
  it("converts CSS seconds and milliseconds to milliseconds and falls back when missing", () => {
    const el = document.createElement("span");
    const getPropertyValue = vi.fn((): string => "0.26s");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue } as unknown as CSSStyleDeclaration);
    expect(tokenMs(el, "--dur-slow", 180)).toBe(260);

    getPropertyValue.mockReturnValue("260ms");
    expect(tokenMs(el, "--dur-slow", 180)).toBe(260);
    getPropertyValue.mockReturnValue("");
    expect(tokenMs(el, "--dur-slow", 180)).toBe(180);
    expect(tokenMs(null, "--dur-slow", 180)).toBe(180);
  });
});
