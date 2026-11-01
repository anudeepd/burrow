import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { handleTreeNavigationEvent } from "./tree-navigation";

function keyboardEvent(key: string, targetMatches = true) {
  const target = {} as HTMLElement;
  return {
    key,
    target,
    currentTarget: targetMatches ? target : ({} as HTMLElement),
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLElement>;
}

describe("tree keyboard navigation", () => {
  it.each([
    ["ArrowDown", 5],
    ["j", 5],
    ["ArrowUp", 3],
    ["k", 3],
    ["PageDown", 12],
    ["PageUp", -4],
    ["Home", 0],
    ["End", 9],
  ])("handles %s on the tree itself", (key, expected) => {
    const event = keyboardEvent(key);
    const move = vi.fn();
    expect(handleTreeNavigationEvent(event, 200, 20, 4, 10, move)).toBe(true);
    expect(move).toHaveBeenCalledWith(expected);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores bubbled child keys and keys without a tree action", () => {
    const move = vi.fn();
    const childEvent = keyboardEvent("ArrowDown", false);
    expect(handleTreeNavigationEvent(childEvent, 500, 20, 4, 10, move)).toBe(false);
    const otherEvent = keyboardEvent("Escape");
    expect(handleTreeNavigationEvent(otherEvent, 500, 20, 4, 10, move)).toBe(false);
    expect(move).not.toHaveBeenCalled();
    expect(childEvent.preventDefault).not.toHaveBeenCalled();
    expect(otherEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps page navigation usable when the viewport is shorter than one row", () => {
    const event = keyboardEvent("PageDown");
    const move = vi.fn();
    handleTreeNavigationEvent(event, 1, 24, 2, 5, move);
    expect(move).toHaveBeenCalledWith(3);
  });
});
