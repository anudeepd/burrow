import { afterEach, describe, expect, it, vi } from "vitest";
import { onUserScrollIntent, revealDetail } from "./reveal";

const { cleanup, fireEvent } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("onUserScrollIntent", () => {
  it("distinguishes real scroll input from typing and clicks inside the scrollport", () => {
    const scrollport = document.createElement("div");
    const input = document.createElement("input");
    scrollport.append(input);
    document.body.append(scrollport);
    const onIntent = vi.fn();
    const stop = onUserScrollIntent(scrollport, onIntent);

    fireEvent.wheel(scrollport, { deltaY: 0, deltaX: 0 });
    fireEvent.pointerDown(input);
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onIntent).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.pointerDown(scrollport);
    fireEvent.wheel(scrollport, { deltaY: 5 });
    fireEvent.touchMove(scrollport);
    fireEvent.keyDown(scrollport, { key: "PageDown" });
    expect(onIntent).toHaveBeenCalledTimes(5);

    stop();
    fireEvent.keyDown(scrollport, { key: "End" });
    expect(onIntent).toHaveBeenCalledTimes(5);
  });
});

describe("revealDetail", () => {
  it("skips server, wide-screen, and missing-detail cases", () => {
    vi.stubGlobal("window", undefined);
    expect(() => revealDetail(document)).not.toThrow();
    expect(() => revealDetail()).not.toThrow();
    vi.unstubAllGlobals();

    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    revealDetail(document);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList),
    );
    revealDetail(document);
  });

  it("scrolls the detail pane into view on narrow screens", () => {
    const detail = document.createElement("div");
    detail.dataset.burrowDetail = "";
    detail.scrollIntoView = vi.fn();
    const root = document.createElement("div");
    root.append(detail);
    const frame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList),
    );
    vi.stubGlobal("requestAnimationFrame", frame);

    revealDetail(root);

    expect(frame).toHaveBeenCalledOnce();
    expect(detail.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });

  it("jumps instead of animating when motion is disabled", () => {
    const detail = document.createElement("div");
    detail.dataset.burrowDetail = "";
    detail.scrollIntoView = vi.fn();
    const root = document.createElement("div");
    root.append(detail);
    const frame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", frame);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList),
    );
    document.documentElement.dataset.motion = "reduced";

    try {
      revealDetail(root);
      expect(detail.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });
});
