/** Edge geometry: path construction, arrow heads, flow dashes, label anchors. */
import { describe, expect, it } from "vitest";
import { arrowAt, flowDash, pathFromPoints, pointAlong, straightEdge } from "./paths";

describe("pathFromPoints", () => {
  it("emits a straight line for two points", () => {
    expect(
      pathFromPoints([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe("M 0 0 L 10 0");
  });

  it("drops duplicate and collinear-adjacent points", () => {
    expect(
      pathFromPoints([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ]),
    ).toBe("M 0 0 L 5 5");
  });

  it("rounds corners with quadratics", () => {
    const d = pathFromPoints([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ]);
    expect(d).toContain("Q 100 0");
    expect(d.startsWith("M 0 0 L")).toBe(true);
    expect(d.endsWith("L 100 80")).toBe(true);
  });

  it("limits the corner radius to half the shorter segment", () => {
    const d = pathFromPoints([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 40 },
    ]);
    // radius can at most be 2 on the first segment
    expect(d).toContain("L 2 0");
  });

  it("returns an empty string for no points and a move for one", () => {
    expect(pathFromPoints([])).toBe("");
    expect(pathFromPoints([{ x: 3, y: 4 }])).toBe("M 3 4");
  });
});

describe("straightEdge", () => {
  it("leaves the facing side and arrives on the facing side", () => {
    const pts = straightEdge({ x: 0, y: 0, width: 100, height: 40 }, { x: 300, y: 0, width: 100, height: 40 });
    expect(pts[0]).toEqual({ x: 100, y: 20 });
    expect(pts[1]).toEqual({ x: 300, y: 20 });
  });

  it("uses vertical sides for a mostly vertical relationship", () => {
    const pts = straightEdge({ x: 0, y: 0, width: 100, height: 40 }, { x: 0, y: 200, width: 100, height: 40 });
    expect(pts[0]).toEqual({ x: 50, y: 40 });
    expect(pts[1]).toEqual({ x: 50, y: 200 });
  });
});

describe("arrowAt", () => {
  it("points along the last segment", () => {
    const arrow = arrowAt([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])!;
    expect(arrow.angleDeg).toBeCloseTo(0, 6);
    expect(arrow.d.startsWith("M ")).toBe(true);
  });

  it("rotates for a vertical edge", () => {
    const arrow = arrowAt([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ])!;
    expect(arrow.angleDeg).toBeCloseTo(90, 6);
  });

  it("is null without two distinct points", () => {
    expect(arrowAt([{ x: 0, y: 0 }])).toBeNull();
    expect(arrowAt([])).toBeNull();
  });
});

describe("flowDash", () => {
  it("animates faster as intensity rises", () => {
    const slow = flowDash(0.1, false);
    const fast = flowDash(1, false);
    expect(fast.animationSeconds).toBeLessThan(slow.animationSeconds);
    expect(fast.travel).toBeGreaterThan(0);
  });

  it("freezes the animation but keeps a dash texture under reduced motion", () => {
    const reduced = flowDash(1, true);
    expect(reduced.animationSeconds).toBe(0);
    expect(reduced.dashArray.split(" ")).toHaveLength(2);
    expect(reduced.opacity).toBeGreaterThan(0.5);
  });

  it("is idle-friendly at zero intensity", () => {
    const idle = flowDash(0, false);
    expect(idle.animationSeconds).toBe(0);
    expect(idle.opacity).toBeCloseTo(0.8, 5);
  });

  it("clamps out-of-range intensity", () => {
    expect(flowDash(-5, false).animationSeconds).toBe(0);
    expect(flowDash(50, false).animationSeconds).toBeLessThanOrEqual(flowDash(1, false).animationSeconds);
  });
});

describe("pointAlong", () => {
  it("walks the polyline by arc length", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(pointAlong(pts, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAlong(pts, 0.25).x).toBeCloseTo(50, 6);
    const mid = pointAlong(pts, 0.5);
    expect(mid.x).toBeCloseTo(100, 6);
    expect(mid.y).toBeCloseTo(0, 6);
    expect(pointAlong(pts, 1)).toEqual({ x: 100, y: 100 });
  });

  it("handles degenerate input", () => {
    expect(pointAlong([], 0.5)).toEqual({ x: 0, y: 0 });
    expect(pointAlong([{ x: 7, y: 8 }], 0.5)).toEqual({ x: 7, y: 8 });
  });
});
