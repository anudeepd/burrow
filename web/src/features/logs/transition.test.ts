import { EASE_OUT } from "~/lib/motion";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parityStore } from "~/state/parity";
import { LOG_PANE_GHOST, withLogPaneTransition } from "./transition";

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
  document.documentElement.removeAttribute("data-motion");
  for (const ghost of document.querySelectorAll(`[${LOG_PANE_GHOST}]`)) ghost.remove();
  parityStore.setState(() => ({ enabled: false }));
  vi.restoreAllMocks();
});

function pane(text = "old"): HTMLElement {
  const el = document.createElement("div");
  const content = document.createElement("div");
  content.textContent = text;
  el.append(content);
  document.body.append(el);
  return el;
}

function stubAnimate() {
  const animations: (Animation & { finish: () => void })[] = [];
  const animate = vi.fn(function (this: Element) {
    const { promise, resolve } = Promise.withResolvers<Animation>();
    const animation = {
      finished: promise,
      cancel: vi.fn(),
      finish: () => resolve(animation as Animation),
    } as unknown as Animation & { finish: () => void };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  return { animate, animations };
}

describe("withLogPaneTransition", () => {
  it("applies the update without a transition when the pane is missing, detached, or motion is gated", () => {
    const update = vi.fn();
    expect(withLogPaneTransition(null, update)).toBe(false);
    expect(update).toHaveBeenCalledOnce();

    const detached = document.createElement("div");
    const detachedUpdate = vi.fn();
    expect(withLogPaneTransition(detached, detachedUpdate)).toBe(false);
    expect(detachedUpdate).toHaveBeenCalledOnce();

    document.documentElement.dataset.motion = "reduced";
    const el = pane();
    const reduced = vi.fn();
    expect(withLogPaneTransition(el, reduced)).toBe(false);
    expect(reduced).toHaveBeenCalledOnce();
  });

  it("applies the update directly when WAAPI is unavailable", () => {
    const el = pane();
    const update = vi.fn();
    expect(withLogPaneTransition(el, update)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
  });

  it("dissolves old rows over new rows on a constant surface", async () => {
    const { animate, animations } = stubAnimate();
    const el = pane("old log");
    el.setAttribute("role", "log");
    el.setAttribute("aria-label", "Container log");
    el.setAttribute("tabindex", "0");
    const update = vi.fn(() => {
      el.firstElementChild!.textContent = "new log";
    });

    expect(withLogPaneTransition(el, update, { rise: 4 })).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    const host = document.querySelector(`[${LOG_PANE_GHOST}]`) as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.inert).toBe(true);
    const ghost = host.firstElementChild as HTMLElement;
    expect(ghost.hasAttribute("role")).toBe(false);
    expect(ghost.hasAttribute("aria-label")).toBe(false);
    expect(ghost.hasAttribute("tabindex")).toBe(false);
    expect(host.textContent).toBe("old log");
    expect(el.textContent).toBe("new log");
    expect(ghost.style.backgroundColor).toBe("transparent");
    expect(animate.mock.contexts[0]).toBe(ghost.firstElementChild);
    expect(animate.mock.contexts[1]).toBe(el.firstElementChild);

    expect(animate).toHaveBeenNthCalledWith(1, [{ opacity: 1 }, { opacity: 0 }], {
      duration: 220,
      easing: EASE_OUT,
      fill: "both",
    });
    expect(animate).toHaveBeenNthCalledWith(
      2,
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 220, easing: EASE_OUT, fill: "both" },
    );

    for (const animation of animations) animation.finish();
    await vi.waitFor(() => expect(host.isConnected).toBe(false));
    for (const animation of animations) expect(animation.cancel).toHaveBeenCalled();
  });

  it("leaves a wrap reflow stationary", () => {
    const { animate } = stubAnimate();
    const el = pane();

    expect(withLogPaneTransition(el, vi.fn(), { rise: 0 })).toBe(true);
    expect(animate).toHaveBeenNthCalledWith(2, [{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 220 }));
  });

  it("applies the update directly when the content duration is zero", () => {
    const { animate } = stubAnimate();
    const el = pane();
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: () => "0ms" } as unknown as CSSStyleDeclaration);
    const update = vi.fn();

    expect(withLogPaneTransition(el, update)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector(`[${LOG_PANE_GHOST}]`)).toBeNull();
  });

  it("removes the ghost without animating when the update unmounts the pane", () => {
    const { animate } = stubAnimate();
    const el = pane("old log");
    const update = vi.fn(() => {
      el.remove();
    });

    expect(withLogPaneTransition(el, update, { rise: 4 })).toBe(true);
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector(`[${LOG_PANE_GHOST}]`)).toBeNull();
  });

  it("removes the ghost and rethrows when the row animation throws", () => {
    const first = { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation;
    const animate = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => {
        throw new Error("row animation failed");
      });
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    const el = pane("old log");

    expect(() => withLogPaneTransition(el, vi.fn(), { rise: 4 })).toThrow("row animation failed");
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(document.querySelector(`[${LOG_PANE_GHOST}]`)).toBeNull();
  });

  it("animates the pane and ghost themselves when there is no content child", async () => {
    const { animate, animations } = stubAnimate();
    const el = document.createElement("div");
    el.textContent = "bare pane";
    document.body.append(el);

    expect(withLogPaneTransition(el, vi.fn())).toBe(true);
    const host = document.querySelector(`[${LOG_PANE_GHOST}]`) as HTMLElement;
    expect(animate.mock.contexts[0]).toBe(host.firstElementChild);
    expect(animate.mock.contexts[1]).toBe(el);

    for (const animation of animations) animation.finish();
    await vi.waitFor(() => expect(host.isConnected).toBe(false));
  });

  it("ignores an older transition that settles after a retarget", async () => {
    const { animations } = stubAnimate();
    const el = pane();

    withLogPaneTransition(el, vi.fn(), { rise: 4 });
    const first = animations.slice();
    withLogPaneTransition(el, vi.fn(), { rise: 0 });
    const second = animations.slice(2);

    for (const animation of first) animation.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelectorAll(`[${LOG_PANE_GHOST}]`)).toHaveLength(1);

    for (const animation of second) animation.finish();
    await vi.waitFor(() => expect(document.querySelectorAll(`[${LOG_PANE_GHOST}]`)).toHaveLength(0));
  });

  it("removes the previous ghost and cancels its animations when a transition retargets", () => {
    stubAnimate();
    const el = pane();

    withLogPaneTransition(el, vi.fn(), { rise: 4 });
    const first = document.querySelector(`[${LOG_PANE_GHOST}]`) as HTMLElement;
    const firstAnimations = vi.mocked(Element.prototype.animate).mock.results.map((result) => result.value as Animation);
    withLogPaneTransition(el, vi.fn(), { rise: 0 });

    expect(first.isConnected).toBe(false);
    expect(document.querySelectorAll(`[${LOG_PANE_GHOST}]`)).toHaveLength(1);
    for (const animation of firstAnimations) expect(animation.cancel).toHaveBeenCalled();
  });
});
