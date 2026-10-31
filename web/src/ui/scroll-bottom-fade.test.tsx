import { afterEach, describe, expect, it, vi } from "vitest";

const { act, cleanup, render, renderHook } = await import("@testing-library/react");
const { ScrollBottomFade, useHasMoreBelow } = await import("./scroll-bottom-fade");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("scroll overflow cues", () => {
  it("updates the bottom fade from the measured remaining content", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const viewport = document.createElement("div");
    const content = document.createElement("div");
    Object.defineProperties(viewport, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      clientHeight: { configurable: true, value: 100 },
    });
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 200 });
    const viewportRef = { current: viewport };
    const contentRef = { current: content };
    const { result, rerender } = renderHook(({ enabled }) => useHasMoreBelow(viewportRef, enabled, contentRef), {
      initialProps: { enabled: true },
    });
    const view = render(<ScrollBottomFade visible={result.current.visible} />);

    expect(result.current.visible).toBe(true);
    expect(view.container.firstElementChild?.getAttribute("data-visible")).toBe("true");

    act(() => {
      viewport.scrollTop = 99;
      result.current.sync();
    });
    expect(result.current.visible).toBe(false);
    view.rerender(<ScrollBottomFade visible={result.current.visible} />);
    expect(view.container.firstElementChild?.getAttribute("data-visible")).toBe("false");

    act(() => {
      viewport.scrollTop = 0;
      result.current.sync();
    });
    expect(result.current.visible).toBe(true);
    rerender({ enabled: false });
    expect(result.current.visible).toBe(false);
  });
});
