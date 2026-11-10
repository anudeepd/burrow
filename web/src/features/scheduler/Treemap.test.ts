// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isReadableTile, splitReadable, squarify, type TreemapItem } from "./Treemap";

function item(key: string, value: number): TreemapItem {
  return { key, value, field: "queue.used", raw: value, usedPct: 50, sub: "used" };
}

describe("queue treemap layout", () => {
  it("lays rows along the shorter side so a wide canvas produces columns", () => {
    const tiles = squarify([item("a", 100), item("b", 60), item("c", 20)], 0, 0, 900, 300);
    // Columns run the full height; the widths follow the values. Full-width bands (the old behaviour) would give
    // three 900px-wide tiles with heights of 50/30/10.
    expect(tiles.map((tile) => Math.round(tile.w))).toEqual([500, 300, 100]);
    for (const tile of tiles) expect(tile.h).toBeCloseTo(300, 6);
  });

  it("rejects empty, zero-value, and zero-sized layouts", () => {
    expect(squarify([], 0, 0, 900, 300)).toEqual([]);
    expect(squarify([item("zero", 0)], 0, 0, 900, 300)).toEqual([]);
    expect(squarify([item("a", 1)], 0, 0, 900, 0)).toEqual([]);
  });

  it("groups similarly sized queues into a squarified row", () => {
    const tiles = squarify(
      Array.from({ length: 10 }, (_, index) => item(`q${index}`, 10)),
      0,
      0,
      900,
      300,
    );
    expect(tiles).toHaveLength(10);
    // Equal values pair up inside one row/column; they are not ten single-item strips.
    expect(tiles.some((tile) => tile.w < 900)).toBe(true);
  });

  it("keeps only tiles that fit their name and value", () => {
    expect(isReadableTile({ w: 108, h: 54 })).toBe(true);
    expect(isReadableTile({ w: 200, h: 54 })).toBe(true);
    expect(isReadableTile({ w: 107, h: 200 })).toBe(false);
    expect(isReadableTile({ w: 200, h: 53 })).toBe(false);
    // The complete short label must fit; a truncated label would be ambiguous.
    expect(isReadableTile({ w: 108, h: 54, label: "eleven-char" })).toBe(true);
    expect(isReadableTile({ w: 108, h: 54, label: "twelve-chars" })).toBe(false);
    expect(isReadableTile({ w: 200, h: 60, key: "root.long", label: "a-label-that-fits" })).toBe(true);
  });

  it("moves a queue whose short label cannot fit into the tail", () => {
    const longLabeled = { ...item("root.prod.very-long-queue-name", 40), label: "prod.very-long-queue-name" };
    const { shown, tail } = splitReadable([item("a", 100), item("b", 60), longLabeled], 200, 900);
    expect(shown.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(tail.map((entry) => entry.key)).toEqual(["root.prod.very-long-queue-name"]);
  });

  it("moves unreadable queues into the tail and recomputes the remaining map", () => {
    const { shown, tail } = splitReadable([item("a", 100), item("b", 60), item("c", 20)], 900, 300);
    expect(shown.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(tail.map((entry) => entry.key)).toEqual(["c"]);
    // Removing the 20 makes the other two columns wider, so both are readable.
    expect(squarify(shown, 0, 0, 900, 300).every((tile) => isReadableTile(tile))).toBe(true);
  });

  it("leaves a readable map intact and handles zero-value queues", () => {
    expect(splitReadable([item("a", 100), item("b", 60)], 900, 300)).toEqual({
      shown: [item("a", 100), item("b", 60)],
      tail: [],
    });
    expect(splitReadable([item("a", 100), item("zero", 0), item("negative", -5)], 900, 300)).toEqual({
      shown: [item("a", 100)],
      tail: [],
    });
    expect(splitReadable([item("a", 100)], 900, 300)).toEqual({ shown: [item("a", 100)], tail: [] });
  });

  it("orders the tail by value, not by removal order", () => {
    const { shown, tail } = splitReadable([item("a", 100), item("b", 60), item("c", 20), item("d", 2)], 900, 300);
    expect(shown.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(tail.map((entry) => entry.key)).toEqual(["c", "d"]);
  });
});
