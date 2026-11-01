import { afterEach, describe, expect, it, vi } from "vitest";
import { LineBuffer, type Match } from "./model";

const virtualizer = vi.hoisted(() => ({ scrollToIndex: vi.fn(), measureElement: vi.fn() }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    estimateSize: () => number;
    getItemKey: (index: number) => string | number;
    measureElement?: (element: Element) => number;
  }) => {
    const items = Array.from({ length: options.count }, (_, index) => {
      options.getItemKey(index);
      return { index, start: index * options.estimateSize() };
    });
    if (options.measureElement) {
      options.measureElement({ getBoundingClientRect: () => ({ height: 44 }) } as Element);
    }
    return {
      getVirtualItems: () => items,
      getTotalSize: () => options.count * options.estimateSize(),
      measureElement: virtualizer.measureElement,
      scrollToIndex: virtualizer.scrollToIndex,
    };
  },
}));

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { LineViewer } = await import("./LineViewer");
const { parityStore } = await import("~/state/parity");

function makeBuffer(text: string): LineBuffer {
  const buffer = new LineBuffer();
  buffer.setWindow(text, 0);
  return buffer;
}

const base = {
  version: 0,
  matches: [] as Match[],
  activeMatch: 0,
  visibleIdx: null as number[] | null,
  jumpLine: null as { line: number; n: number } | null,
  search: { query: "", regex: false, caseSensitive: false },
  wrap: false,
  timestamp: "absolute" as const,
  follow: false,
  paused: false,
  parity: false,
};

afterEach(() => {
  cleanup();
  parityStore.setState(() => ({ enabled: true }));
  window.__BURROW_PARITY__ = true;
  virtualizer.scrollToIndex.mockClear();
  virtualizer.measureElement.mockClear();
});

describe("LineViewer", () => {
  it("maps filtered matches and jump anchors, measures wrapped rows, and returns to the tail", () => {
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    const buffer = makeBuffer("10:00:00.000 INFO ready\nstack frame\n10:00:01.000 WARN slow\n");
    const { container } = render(
      <LineViewer
        {...base}
        buffer={buffer}
        matches={[{ line: 2, start: 13, end: 17 }]}
        activeMatch={0}
        visibleIdx={[0, 2]}
        jumpLine={{ line: 1, n: 1 }}
        search={{ query: "WARN", regex: false, caseSensitive: false }}
        wrap
        timestamp="relative"
        follow
      />,
    );

    const log = screen.getByRole("log", { name: "Container log" });
    expect(container.querySelector(".whitespace-pre-wrap")).toBeTruthy();
    expect(screen.getByText("+1,000 ms")).toBeTruthy();
    expect(container.querySelector("mark")?.textContent).toBe("WARN");
    expect(virtualizer.measureElement).toHaveBeenCalled();

    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 50 },
      scrollTop: { configurable: true, value: 0 },
    });
    fireEvent.scroll(log);
    fireEvent.click(screen.getByRole("button", { name: "Jump to tail" }));
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(1, { align: "end" });
  });

  it("pins to the last row while following and at the bottom", () => {
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    render(<LineViewer {...base} buffer={makeBuffer("INFO one\nINFO two\n")} follow />);
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(1, { align: "end" });
  });
});
