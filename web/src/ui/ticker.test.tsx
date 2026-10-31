import { afterEach, describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = false;

const { act, cleanup, render } = await import("@testing-library/react");
const { parityStore, prefsMotionProbe } = await import("~/state/parity");
const { Ticker } = await import("./ticker");

parityStore.setState(() => ({ enabled: false }));
prefsMotionProbe.setState(() => ({ reduced: false }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.__BURROW_PARITY__ = false;
  parityStore.setState(() => ({ enabled: false }));
  prefsMotionProbe.setState(() => ({ reduced: false }));
});

describe("Ticker", () => {
  it("renders missing values, stamps raw values, and completes a number tween", async () => {
    let clock = 1_000;
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("IntersectionObserver", undefined);

    const format = (value: number) => `v${value}`;
    const view = render(<Ticker value={null} field="spark.metric.value" fmt="int" format={format} durationMs={100} />);
    const value = view.container.querySelector("span")!;
    expect(value.textContent).toBe("—");

    view.rerender(<Ticker value={2} field="spark.metric.value" fmt="int" format={format} durationMs={100} />);
    expect(value.textContent).toBe("v2");
    expect(value.getAttribute("data-yf")).toBe("spark.metric.value");
    expect(value.getAttribute("data-yv")).toBe("2");

    view.rerender(<Ticker value={4} field="spark.metric.value" fmt="int" format={format} durationMs={100} />);
    await vi.waitFor(() => expect(frame).toBeTypeOf("function"));
    const firstFrame = frame!;
    frame = null;
    clock = 1_050;
    act(() => firstFrame(clock));
    expect(frame).toBeTypeOf("function");

    const lastFrame = frame!;
    frame = null;
    clock = 1_100;
    act(() => lastFrame(clock));
    expect(value.textContent).toBe("v4");
    expect(value.getAttribute("data-yv")).toBe("4");
  });
});
