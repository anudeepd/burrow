import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useNow } from "./use-now";

function ClockProbe() {
  return <output>{useNow()}</output>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useNow", () => {
  it("uses the default one-second update interval", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<ClockProbe />);
    expect(screen.getByText(/\d{13}/)).toBeTruthy();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    const tick = setIntervalSpy.mock.calls.find(([, interval]) => interval === 1000)?.[0];
    expect(tick).toBeTypeOf("function");
    act(() => (tick as () => void)());
  });
});
