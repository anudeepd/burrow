/**
 * Card row geometry for the spacious DAG card treatment.
 */
import { describe, expect, it } from "vitest";
import { badgeWidth, fittedBadges, nodeRowGeometry, textColumnStart, titleUsableWidth } from "./scene";
import type { NodeBadge } from "./scene";

const badge = (text: string): NodeBadge => ({ key: text, text, tone: "idle" });

const KINDS = ["stage", "rdd", "sql", "fallback"] as const;
/** Every card height the layout can hand the renderer, not just the four the design doc lists. */
const HEIGHTS = Array.from({ length: 121 }, (_, i) => 40 + i);

/** The rows the renderer draws, as vertical bands. Text boxes are ~13 px around their baseline. */
function bands(height: number, kind: (typeof KINDS)[number]) {
  const g = nodeRowGeometry(height, kind);
  return {
    g,
    sub: [g.subY - 11, g.subY + 3] as const,
    meta: g.metaY > 0 ? ([g.metaY - 10, g.metaY + 3] as const) : null,
    progress: [g.progressY, g.progressY + 6] as const,
  };
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] < b[1] && b[0] < a[1];

describe("nodeRowGeometry", () => {
  it("keeps the second metadata row clear of the secondary line", () => {
    for (const kind of KINDS) {
      for (const height of HEIGHTS) {
        const b = bands(height, kind);
        if (b.meta) expect(overlaps(b.meta, b.sub), `${kind} card ${height}px: metadata ${b.meta} vs sub ${b.sub}`).toBe(false);
      }
    }
  });

  it("keeps metadata clear of the progress strip", () => {
    for (const kind of KINDS) {
      for (const height of HEIGHTS) {
        const b = bands(height, kind);
        if (b.meta)
          expect(overlaps(b.meta, b.progress), `${kind} card ${height}px: metadata ${b.meta} vs progress ${b.progress}`).toBe(false);
      }
    }
  });

  it("uses the reference card baselines for roomy nodes", () => {
    expect(nodeRowGeometry(158, "rdd")).toEqual({ titleY: 47, subY: 81, metaY: 111, progressY: 133 });
  });
});

describe("badge row width", () => {
  it("stops at the first badge that does not fit", () => {
    const wide = [badge("a".repeat(10)), badge("b".repeat(10)), badge("c".repeat(10))];
    expect(badgeWidth("a".repeat(10))).toBeCloseTo(68);
    expect(fittedBadges(wide, 150)).toEqual({ count: 2, width: 140 });
    expect(fittedBadges(wide, 10)).toEqual({ count: 0, width: 0 });
    expect(fittedBadges([], 100)).toEqual({ count: 0, width: 0 });
  });

  it("caps a single badge so it cannot eat the row", () => {
    expect(badgeWidth("x".repeat(40))).toBe(96);
  });

  it("keeps the full title column when metadata moves below the title", () => {
    const badges = [badge("1 metrics")];
    const usable = titleUsableWidth(268, 52, "sql", badges);
    expect(usable).toBe(268 - textColumnStart("sql") - 12);
  });

  it("leaves the whole text column to the title when the badges have their own row", () => {
    expect(titleUsableWidth(268, 84, "stage", [badge("1 metrics")])).toBe(268 - textColumnStart("stage") - 12);
  });
});
