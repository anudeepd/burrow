import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResponsePulse } from "./use-response-pulse";

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

function PulseProbe({ lastOkAt, interval }: { lastOkAt: number | null; interval: number }) {
  const dot = useRef<HTMLSpanElement>(null);
  useResponsePulse(dot, lastOkAt, interval);
  return <span ref={dot} />;
}

describe("useResponsePulse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    document.documentElement.removeAttribute("data-motion");
    document.documentElement.removeAttribute("data-parity");
  });

  it("keeps a pulse alive through throttled responses and cancels only on a new pulse or unmount", () => {
    const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
    const animate = vi.fn(() => {
      const next = { cancel: vi.fn() };
      animations.push(next);
      return next as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });

    const view = render(<PulseProbe lastOkAt={1000} interval={3000} />);
    expect(animate).toHaveBeenCalledTimes(1);
    const first = animations[0];
    if (!first) throw new Error("First pulse animation was not created");

    act(() => view.rerender(<PulseProbe lastOkAt={1500} interval={3000} />));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(first.cancel).not.toHaveBeenCalled();

    act(() => view.rerender(<PulseProbe lastOkAt={4000} interval={3000} />));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    const second = animations[1];
    if (!second) throw new Error("Second pulse animation was not created");
    expect(second.cancel).not.toHaveBeenCalled();

    view.unmount();
    expect(second.cancel).toHaveBeenCalledTimes(1);
  });
});
