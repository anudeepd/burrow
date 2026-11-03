import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HorizontalScrollCues, useHorizontalScrollCues } from "./horizontal-scroll-cues";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ScrollProbe({ enabled }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cues = useHorizontalScrollCues(ref, enabled);
  return (
    <div>
      <div ref={ref} role="region" aria-label="Scrollable tabs" onScroll={cues.onScroll}>
        <span>wide tab strip</span>
      </div>
      <HorizontalScrollCues left={cues.left} right={cues.right} />
    </div>
  );
}

describe("horizontal scroll cues", () => {
  it("updates both edge fades and avoids redundant state changes", () => {
    render(<ScrollProbe />);
    const region = document.querySelector<HTMLElement>('[aria-label="Scrollable tabs"]')!;
    Object.defineProperties(region, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 250 },
      scrollLeft: { configurable: true, writable: true, value: 10 },
    });

    act(() => fireEvent.scroll(region));
    expect(document.querySelector('[data-scroll-cue="left"]')?.className).toContain("opacity-100");
    expect(document.querySelector('[data-scroll-cue="right"]')?.className).toContain("opacity-100");

    act(() => {
      region.scrollLeft = 149;
      fireEvent.scroll(region);
    });
    expect(document.querySelector('[data-scroll-cue="left"]')?.className).toContain("opacity-100");
    expect(document.querySelector('[data-scroll-cue="right"]')?.className).toContain("opacity-0");

    act(() => fireEvent.scroll(region));
  });

  it("does not observe or expose a scroll handler when disabled or before a ref exists", () => {
    const emptyRef = { current: null };
    const disabled = renderHook(() => useHorizontalScrollCues(emptyRef, false));
    expect(disabled.result.current.onScroll).toBeUndefined();
    disabled.unmount();

    const beforeMount = renderHook(() => useHorizontalScrollCues(emptyRef));
    expect(beforeMount.result.current.onScroll).toBeTypeOf("function");
  });
});
