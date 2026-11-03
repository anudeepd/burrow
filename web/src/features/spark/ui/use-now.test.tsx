import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parityStore } from "~/state/parity";
import { prefsStore, setPrefs } from "~/state/prefs";
import { nowStore, useNow } from "./use-now";

const originalPrefs = prefsStore.get();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  prefsStore.setState(() => originalPrefs);
  parityStore.setState(() => ({ enabled: false }));
});

describe("Spark live clock", () => {
  it("ticks once per second and clears its interval on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    nowStore.setState(() => ({ now: 0 }));

    const { result, unmount } = renderHook(() => useNow());
    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(nowStore.get().now).toBe(Date.now());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a clock while paused or in parity mode", () => {
    vi.useFakeTimers();
    parityStore.setState(() => ({ enabled: false }));
    setPrefs({ livePaused: true });
    const paused = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(0);
    paused.unmount();

    setPrefs({ livePaused: false });
    parityStore.setState(() => ({ enabled: true }));
    const parity = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(0);
    parity.unmount();
  });
});
