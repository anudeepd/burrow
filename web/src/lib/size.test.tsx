import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useElementWidth } from "~/lib/size";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function WidthProbe({ fallback = 0 }: { fallback?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(fallback);
  return <div ref={ref} data-testid="width" data-width={width} />;
}

describe("useElementWidth", () => {
  it("keeps its fallback if ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<WidthProbe fallback={24} />);
    expect(screen.getByTestId("width").getAttribute("data-width")).toBe("24");
  });

  it("updates only for positive observed widths and disconnects on unmount", () => {
    type TestObserver = ResizeObserver & { flushEmpty(): void; flush(width: number): void };
    let observer: TestObserver | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {
        observer = this as unknown as TestObserver;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      flushEmpty() {
        this.callback([], this as unknown as ResizeObserver);
      }
      flush(width: number) {
        this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const view = render(<WidthProbe fallback={24} />);
    expect(observe).toHaveBeenCalledOnce();
    act(() => observer!.flushEmpty());
    expect(screen.getByTestId("width").getAttribute("data-width")).toBe("24");
    act(() => observer!.flush(0));
    expect(screen.getByTestId("width").getAttribute("data-width")).toBe("24");
    act(() => observer!.flush(82.6));
    expect(screen.getByTestId("width").getAttribute("data-width")).toBe("83");

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
