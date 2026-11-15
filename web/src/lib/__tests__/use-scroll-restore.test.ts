import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollRestore, USER_SCROLL_WINDOW_MS } from "~/lib/use-scroll-restore";

const KEY = "burrow.test.scroll";
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

function scrollable() {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return element;
}

function setFonts(value: unknown) {
  Object.defineProperty(document, "fonts", { configurable: true, value });
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

describe("useScrollRestore", () => {
  it("restores the saved position once ready and again after fonts settle", async () => {
    setFonts({ ready: Promise.resolve() });
    sessionStorage.setItem(KEY, "120");
    const element = scrollable();
    const ref = { current: element };

    renderHook(() => useScrollRestore(ref, KEY, true, 0));

    expect(element.scrollTop).toBe(120);
    await waitFor(() => expect(element.scrollTop).toBe(120));
  });

  it("restores without a font set", () => {
    setFonts(undefined);
    sessionStorage.setItem(KEY, "30");
    const element = scrollable();

    renderHook(() => useScrollRestore({ current: element }, KEY, true, 0));

    expect(element.scrollTop).toBe(30);
  });

  it("does nothing before ready or without an element", () => {
    sessionStorage.setItem(KEY, "120");
    const element = scrollable();
    const ref = { current: element };

    renderHook(() => useScrollRestore(ref, KEY, false, 0));
    expect(element.scrollTop).toBe(0);

    const nullRef = { current: null };
    renderHook(() => useScrollRestore(nullRef, KEY, true, 0));
    expect(nullRef.current).toBeNull();
  });

  it("saves user scroll events on the next frame", async () => {
    const element = scrollable();
    const ref = { current: element };
    renderHook(() => useScrollRestore(ref, KEY, true, 0));

    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 42;
    element.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("42"));
  });

  it("rolls back a scroll that happens without user input", async () => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
    const element = scrollable();
    const ref = { current: element };
    renderHook(() => useScrollRestore(ref, KEY, true, 0));

    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 240;
    element.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(USER_SCROLL_WINDOW_MS + 100);
    expect(sessionStorage.getItem(KEY)).toBe("240");

    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll"));

    expect(element.scrollTop).toBe(240);
    expect(sessionStorage.getItem(KEY)).toBe("240");
  });

  it("treats pointer and touch scrolls as user scrolling", async () => {
    const element = scrollable();
    renderHook(() => useScrollRestore({ current: element }, KEY, true, 0));

    element.dispatchEvent(new Event("pointerdown"));
    element.scrollTop = 70;
    element.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("70"));

    element.dispatchEvent(new Event("pointercancel"));
    element.dispatchEvent(new Event("touchend"));
    element.dispatchEvent(new Event("touchcancel"));
    element.dispatchEvent(new Event("pointerup"));
    element.dispatchEvent(new Event("touchmove"));
    element.scrollTop = 90;
    element.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("90"));
  });

  it("keeps the user's scroll when fonts settle", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setFonts({ ready: promise });
    sessionStorage.setItem(KEY, "120");
    const element = scrollable();
    renderHook(() => useScrollRestore({ current: element }, KEY, true, 0));

    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 240;
    element.dispatchEvent(new Event("scroll"));
    resolve();

    await waitFor(() => expect(element.scrollTop).toBe(240));
    expect(sessionStorage.getItem(KEY)).toBe("240");
  });

  it("keeps a scroll made before fonts settle", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setFonts({ ready: promise });
    sessionStorage.setItem(KEY, "120");
    const element = scrollable();
    renderHook(() => useScrollRestore({ current: element }, KEY, true, 0));

    element.scrollTop = 240;
    resolve();

    await waitFor(() => expect(element.scrollTop).toBe(240));
  });

  it("ignores an unchanged scroll without user input", () => {
    const element = scrollable();
    renderHook(() => useScrollRestore({ current: element }, KEY, true, 0));

    element.dispatchEvent(new Event("scroll"));

    expect(element.scrollTop).toBe(0);
  });

  it("locks the restored position until the user scrolls", async () => {
    sessionStorage.setItem(KEY, "100");
    const element = scrollable();
    const ref = { current: element };
    renderHook(() => useScrollRestore(ref, KEY, true, 100));

    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
    expect(element.scrollTop).toBe(100);

    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll"));
    expect(element.scrollTop).toBe(100);

    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 40;
    element.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("40"));
  });
});
