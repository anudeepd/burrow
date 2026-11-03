import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailTableScroller } from "./detail-table-scroller";

const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DetailTableScroller", () => {
  it("shows and clears the edge fade as horizontal overflow changes", () => {
    class TestResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const { container } = render(
      <DetailTableScroller ariaLabel="Detail values">
        <div>Wide content</div>
      </DetailTableScroller>,
    );
    const scroller = screen.getByRole("region", { name: "Detail values" });
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(scroller);
    expect(container.querySelector(".burrow-table-edge-fade")?.className).toContain("opacity-100");

    (scroller as HTMLElement).scrollLeft = 240;
    fireEvent.scroll(scroller);
    expect(container.querySelector(".burrow-table-edge-fade")?.className).toContain("opacity-0");
  });

  it("observes a bare region and ignores a queued resize after unmount", () => {
    let notify: ResizeObserverCallback | undefined;
    const observed: Element[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const view = render(<DetailTableScroller ariaLabel="Empty detail">{null}</DetailTableScroller>);
    expect(observed).toEqual([screen.getByRole("region", { name: "Empty detail" })]);
    view.unmount();
    act(() => notify?.([], {} as ResizeObserver));
  });
});
