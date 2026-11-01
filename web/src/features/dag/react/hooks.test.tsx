/**
 * `useRafValue` feeds the DAG pane its render value, so a hook that stops settling freezes the whole graph: it opens at
 * 1:1 from the world origin and pan, zoom and "fit" all change state without moving anything on screen.
 *
 * The failure only shows up when the hook's effects remount — React StrictMode's mount/unmount/mount, or a Suspense
 * retry — because that cancels the scheduled frame without running its callback. Production has no StrictMode and the
 * Playwright DAG snapshots run against the built app, so this test is the only place the wedge is observable.
 */
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useElementSize, useMediaQuery, useRafValue, useSampleClock } from "./hooks";

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
});

/** One animation frame, plus the commit it schedules. */
function frame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => {
    setTimeout(resolve, 0);
  });
  return promise;
}

function Probe({ value }: { value: number }) {
  const settled = useRafValue(value);
  return <span data-testid="settled">{settled}</span>;
}

function SizeProbe() {
  const [ref, size] = useElementSize<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="size">
      {size.width}x{size.height}
    </div>
  );
}

function ClockProbe({ interval }: { interval: number }) {
  return <span data-testid="clock">{useSampleClock(interval)}</span>;
}

function MediaProbe({ query, fallback = false }: { query: string; fallback?: boolean }) {
  return <span data-testid="media">{useMediaQuery(query, fallback) ? "matches" : "no match"}</span>;
}

describe("useRafValue", () => {
  it("keeps settling new values after a StrictMode effect remount", async () => {
    const { getByTestId, rerender } = render(
      <StrictMode>
        <Probe value={1} />
      </StrictMode>,
    );
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("1");

    rerender(
      <StrictMode>
        <Probe value={2} />
      </StrictMode>,
    );
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("2");

    rerender(
      <StrictMode>
        <Probe value={3} />
      </StrictMode>,
    );
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("3");
  });

  it("settles without StrictMode too", async () => {
    const { getByTestId, rerender } = render(<Probe value={1} />);
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("1");

    rerender(<Probe value={2} />);
    await act(frame);
    expect(getByTestId("settled").textContent).toBe("2");
  });
});

describe("DAG utility hooks", () => {
  it("tracks element size through ResizeObserver and the window-resize fallback", () => {
    let width = 120;
    let height = 80;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }) as DOMRect,
    );
    let notifyResize: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const observed = render(<SizeProbe />);
    expect(observed.getByTestId("size").textContent).toBe("120x80");
    expect(observe).toHaveBeenCalledOnce();
    width = 200;
    height = 100;
    act(() => notifyResize?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    expect(observed.getByTestId("size").textContent).toBe("200x100");
    observed.unmount();
    expect(disconnect).toHaveBeenCalledOnce();

    vi.stubGlobal("ResizeObserver", undefined);
    const fallback = render(<SizeProbe />);
    expect(fallback.getByTestId("size").textContent).toBe("200x100");
    width = 320;
    fireEvent(window, new Event("resize"));
    expect(fallback.getByTestId("size").textContent).toBe("320x100");
  });

  it("pauses its sample clock in hidden tabs and supports a disabled interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const view = render(<ClockProbe interval={100} />);
    expect(view.getByTestId("clock").textContent).toBe("1000");

    vi.setSystemTime(1_100);
    act(() => vi.advanceTimersByTime(100));
    expect(view.getByTestId("clock").textContent).toBe("1200");

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    vi.setSystemTime(1_200);
    act(() => vi.advanceTimersByTime(200));
    expect(view.getByTestId("clock").textContent).toBe("1200");

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(view.getByTestId("clock").textContent).toBe("1400");
    view.rerender(<ClockProbe interval={0} />);
    vi.setSystemTime(1_300);
    act(() => vi.advanceTimersByTime(200));
    expect(view.getByTestId("clock").textContent).toBe("1400");
  });

  it("uses the media-query fallback when unavailable and responds to changes when supported", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    const fallback = render(<MediaProbe query="(min-width: 900px)" fallback />);
    expect(fallback.getByTestId("media").textContent).toBe("matches");
    fallback.unmount();

    let matches = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const addEventListener = vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener));
    const removeEventListener = vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((media: string) => ({
        media,
        get matches() {
          return matches;
        },
        addEventListener,
        removeEventListener,
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    });
    const supported = render(<MediaProbe query="(prefers-reduced-motion: reduce)" />);
    expect(supported.getByTestId("media").textContent).toBe("no match");
    matches = true;
    act(() =>
      listeners.forEach((listener) => {
        listener(new Event("change") as MediaQueryListEvent);
      }),
    );
    expect(supported.getByTestId("media").textContent).toBe("matches");
    supported.unmount();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });
});
