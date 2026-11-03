import { describe, expect, it, vi } from "vitest";
import { addSort, resolveUpdater } from "./updater";

describe("resolveUpdater", () => {
  it("accepts a value or computes the next value from the previous one", () => {
    expect(resolveUpdater(5, 2)).toBe(5);
    expect(resolveUpdater((previous: number) => previous + 1, 2)).toBe(3);
  });
});

describe("addSort", () => {
  it("ignores an empty choice, replaces a default, and appends to an active sort", () => {
    const onChange = vi.fn();
    const current = [{ id: "name", desc: true }];
    addSort(null, true, current, onChange);
    expect(onChange).not.toHaveBeenCalled();
    addSort("count", true, current, onChange);
    expect(onChange).toHaveBeenLastCalledWith([{ id: "count", desc: false }]);
    addSort("count", false, current, onChange);
    expect(onChange).toHaveBeenLastCalledWith([...current, { id: "count", desc: false }]);
  });
});
