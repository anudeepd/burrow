import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInView } from "./in-view";

let notify: IntersectionObserverCallback | undefined;
class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    notify = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function Observed() {
  const [ref, visible] = useInView<HTMLDivElement>();
  return <div ref={ref} data-testid="observed" data-visible={visible} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  notify = undefined;
});

describe("useInView", () => {
  it("publishes visibility updates from the shared observer", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    render(<Observed />);
    const target = screen.getByTestId("observed");
    act(() => notify?.([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(target.getAttribute("data-visible")).toBe("true");
  });
});
