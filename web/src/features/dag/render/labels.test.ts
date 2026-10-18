/** Label measurement and collision resolution — the "labels appear/disappear by zoom and node size" contract. */
import { describe, expect, it } from "vitest";
import { ellipsize, findOverlaps, measureText, resolveLabelCollisions } from "./labels";
import type { LabelCandidate } from "./labels";

const label = (id: string, x: number, y: number, priority = 0, text = id, fontSize = 12): LabelCandidate => ({
  id,
  text,
  x,
  y,
  width: measureText(text, fontSize),
  height: fontSize + 3,
  priority,
});

describe("measureText and ellipsize", () => {
  it("grows with length and font size", () => {
    expect(measureText("aaaa", 12)).toBeGreaterThan(measureText("aa", 12));
    expect(measureText("aaaa", 24)).toBeCloseTo(measureText("aaaa", 12) * 2, 5);
  });

  it("treats narrow glyphs as narrow", () => {
    expect(measureText("iiii", 12)).toBeLessThan(measureText("mmmm", 12));
  });

  it("returns the text unchanged when it fits", () => {
    expect(ellipsize("Stage 1", 12, 500)).toBe("Stage 1");
  });

  it("truncates with an ellipsis to the available width", () => {
    const out = ellipsize("ShuffledRowRDD with a very long name", 10, 60);
    expect(out.endsWith("…")).toBe(true);
    expect(measureText(out, 10)).toBeLessThanOrEqual(60);
  });

  it("degrades to an empty string when nothing fits", () => {
    expect(ellipsize("Stage 1", 12, 0)).toBe("");
    expect(ellipsize("Stage 1", 12, 1)).toBe("");
  });
});

describe("resolveLabelCollisions", () => {
  it("never returns two overlapping labels", () => {
    const many: LabelCandidate[] = [];
    // deliberately tight: 12px apart horizontally and 10px vertically for ~20×15 labels
    for (let i = 0; i < 60; i++) many.push(label(`n${i}`, (i % 10) * 12, Math.floor(i / 10) * 10));
    const { placed } = resolveLabelCollisions(many);
    expect(findOverlaps(placed)).toEqual([]);
    expect(placed.length).toBeLessThan(many.length);
    expect(placed.length).toBeGreaterThan(0);
  });

  it("keeps the higher-priority label and reports the loser as hidden", () => {
    const a = label("low", 0, 0, 1);
    const b = label("high", 5, 5, 100);
    const { placed, hidden } = resolveLabelCollisions([a, b]);
    expect(placed.map((p) => p.id)).toEqual(["high"]);
    expect(hidden).toEqual(["low"]);
  });

  it("breaks priority ties deterministically by id", () => {
    const candidates = [label("b", 0, 0, 5), label("a", 2, 2, 5)];
    expect(resolveLabelCollisions(candidates).placed.map((p) => p.id)).toEqual(["a"]);
    expect(resolveLabelCollisions([...candidates].reverse()).placed.map((p) => p.id)).toEqual(["a"]);
  });

  it("places everything when nothing overlaps", () => {
    const spread = [label("a", 0, 0), label("b", 500, 0), label("c", 0, 400)];
    expect(resolveLabelCollisions(spread).placed).toHaveLength(3);
  });

  it("honours the maxLabels cap", () => {
    const spread = Array.from({ length: 20 }, (_, i) => label(`n${i}`, i * 200, 0));
    const { placed, hidden } = resolveLabelCollisions(spread, 5);
    expect(placed).toHaveLength(5);
    expect(hidden).toHaveLength(15);
  });

  it("is stable across runs (same input, same output)", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => label(`n${i}`, (i % 7) * 24, Math.floor(i / 7) * 18, i % 3));
    const first = resolveLabelCollisions(candidates).placed.map((p) => p.id);
    const second = resolveLabelCollisions([...candidates]).placed.map((p) => p.id);
    expect(second).toEqual(first);
  });
});

describe("findOverlaps", () => {
  it("finds overlapping rectangles", () => {
    expect(findOverlaps([label("a", 0, 0), label("b", 2, 2)])).toEqual([["a", "b"]]);
    expect(findOverlaps([label("a", 0, 0), label("b", 900, 0)])).toEqual([]);
  });
});
