import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useScrollRestore } from "~/lib/use-scroll-restore";

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
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

describe("useScrollRestore", () => {
  it("restores the saved position once ready and again after fonts settle", async () => {
    setFonts({ ready: Promise.resolve() });
    sessionStorage.setItem(KEY, "120");
    const element = scrollable();
    const ref = { current: element };

    renderHook(() => useScrollRestore(ref, KEY, true));

    expect(element.scrollTop).toBe(120);
    await waitFor(() => expect(element.scrollTop).toBe(120));
  });

  it("restores without a font set", () => {
    setFonts(undefined);
    sessionStorage.setItem(KEY, "30");
    const element = scrollable();

    renderHook(() => useScrollRestore({ current: element }, KEY, true));

    expect(element.scrollTop).toBe(30);
  });

  it("does nothing before ready or without an element", () => {
    sessionStorage.setItem(KEY, "120");
    const element = scrollable();
    const ref = { current: element };

    renderHook(() => useScrollRestore(ref, KEY, false));
    expect(element.scrollTop).toBe(0);

    const nullRef = { current: null };
    renderHook(() => useScrollRestore(nullRef, KEY, true));
    expect(nullRef.current).toBeNull();
  });

  it("saves scroll events on the next frame", async () => {
    const element = scrollable();
    const ref = { current: element };
    renderHook(() => useScrollRestore(ref, KEY, true));

    element.scrollTop = 42;
    element.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("42"));
  });
});
