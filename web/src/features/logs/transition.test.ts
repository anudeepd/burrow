import { afterEach, describe, expect, it, vi } from "vitest";
import { parityStore } from "~/state/parity";
import { withLogPaneTransition } from "./transition";

afterEach(() => {
  Reflect.deleteProperty(document, "startViewTransition");
  document.documentElement.removeAttribute("data-motion");
  parityStore.setState(() => ({ enabled: false }));
  vi.restoreAllMocks();
});

function pane() {
  return document.createElement("div");
}

describe("withLogPaneTransition", () => {
  it("applies the update without a view transition when the pane is missing or motion is gated", () => {
    const update = vi.fn();
    expect(withLogPaneTransition(null, update)).toBe(false);
    expect(update).toHaveBeenCalledOnce();

    document.documentElement.dataset.motion = "reduced";
    const el = pane();
    const reduced = vi.fn();
    expect(withLogPaneTransition(el, reduced)).toBe(false);
    expect(reduced).toHaveBeenCalledOnce();
  });

  it("applies the update without a view transition when the API is missing", () => {
    const el = pane();
    const update = vi.fn();
    expect(withLogPaneTransition(el, update)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
  });

  it("crossfades the named pane and clears the name when the transition finishes", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const start = vi.fn((run: () => void) => {
      run();
      return { finished };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    const el = pane();
    const update = vi.fn();

    expect(withLogPaneTransition(el, update)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(el.style.viewTransitionName).toBe("burrow-log-pane");
    finish();
    await finished;
    expect(el.style.viewTransitionName).toBe("");
  });

  it("applies the update and clears the name when the transition throws before running it", () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: () => {
        throw new Error("busy");
      },
    });
    const el = pane();
    const update = vi.fn();
    expect(withLogPaneTransition(el, update)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
    expect(el.style.viewTransitionName).toBe("");
  });

  it("does not apply the update twice when the transition throws after running it", () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (run: () => void) => {
        run();
        throw new Error("late failure");
      },
    });
    const el = pane();
    const update = vi.fn();
    expect(withLogPaneTransition(el, update)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
    expect(el.style.viewTransitionName).toBe("");
  });
});
