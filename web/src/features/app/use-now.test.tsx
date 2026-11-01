import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow as useAppNow } from "./use-now";
import { useNow as useSparkNow, nowStore } from "~/features/spark/ui/use-now";
import { parityStore } from "~/state/parity";
import { prefsStore, setPrefs } from "~/state/prefs";

function AppClock() {
  return <output>{useAppNow(true, 250)}</output>;
}
function SparkClock() {
  return <output>{useSparkNow()}</output>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  parityStore.setState(() => ({ enabled: false }));
  setPrefs({ ...prefsStore.get(), livePaused: false });
});

describe("live clocks", () => {
  it("ticks and cleans up an active application clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    parityStore.setState(() => ({ enabled: false }));
    const view = render(<AppClock />);
    expect(screen.getByText("1000")).toBeTruthy();
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByText("1250")).toBeTruthy();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ticks a shared Spark clock and stops when its subscriber unmounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    parityStore.setState(() => ({ enabled: false }));
    setPrefs({ livePaused: false });
    nowStore.setState(() => ({ now: 5000 }));
    const view = render(<SparkClock />);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("6000")).toBeTruthy();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
