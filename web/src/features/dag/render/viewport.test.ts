/**
 * Viewport math: pan, zoom, fit, readable-fit, centre-on, minimap projection, semantic level thresholds.
 * Pure functions, so these assert exact numbers rather than pixels.
 */
import { describe, expect, it } from "vitest";
import {
  IDENTITY_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  INITIAL_MAX_SCALE,
  INITIAL_FIT_MIN_SCALE,
  LEGIBLE_MIN_SCALE,
  boundsOf,
  centerOn,
  clampScale,
  fitViewport,
  focusScale,
  isTooWideToFit,
  minimapProjection,
  panBy,
  initialViewport,
  rectContains,
  screenToWorld,
  semanticLevel,
  viewportTransform,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  zoomTo,
} from "./viewport";

const SIZE = { width: 1000, height: 500 };

describe("scale limits and levels", () => {
  it("clamps zoom to the supported range", () => {
    expect(clampScale(0)).toBe(1);
    expect(clampScale(-2)).toBe(1);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it("maps scale to a semantic level with stable thresholds", () => {
    expect(semanticLevel(0.2)).toBe("overview");
    expect(semanticLevel(0.54)).toBe("overview");
    expect(semanticLevel(0.55)).toBe("normal");
    expect(semanticLevel(1.24)).toBe("normal");
    expect(semanticLevel(1.25)).toBe("detail");
  });
});

describe("world/screen transforms", () => {
  it("round-trips a point", () => {
    const v = { x: 120, y: -40, scale: 1.7 };
    const screen = worldToScreen(v, 200, 300);
    const world = screenToWorld(v, screen.x, screen.y);
    expect(world.x).toBeCloseTo(200, 6);
    expect(world.y).toBeCloseTo(300, 6);
  });

  it("emits a translate-then-scale SVG transform", () => {
    expect(viewportTransform({ x: 10, y: 20, scale: 2 })).toBe("translate(-20.000 -40.000) scale(2.00000)");
  });

  it("reports the visible world rectangle", () => {
    const rect = visibleWorldRect({ x: 100, y: 50, scale: 2 }, SIZE);
    expect(rect).toEqual({ x: 100, y: 50, width: 500, height: 250 });
  });
});

describe("pan and zoom", () => {
  it("pans by screen pixels, scaled into world units", () => {
    const panned = panBy({ x: 0, y: 0, scale: 2 }, 40, -20);
    expect(panned.x).toBe(-20);
    expect(panned.y).toBe(10);
  });

  it("keeps the anchor point pinned while zooming", () => {
    const before = { x: 10, y: 10, scale: 1 };
    const anchor = { x: 400, y: 300 };
    const worldBefore = screenToWorld(before, anchor.x, anchor.y);
    const after = zoomAt(before, 2, anchor.x, anchor.y);
    const worldAfter = screenToWorld(after, anchor.x, anchor.y);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
    expect(after.scale).toBe(2);
  });

  it("does not move when the zoom limit is hit", () => {
    const v = { x: 5, y: 5, scale: MAX_SCALE };
    expect(zoomAt(v, 2, 100, 100)).toBe(v);
  });

  it("zooms about the pane centre", () => {
    const v = zoomTo({ x: 0, y: 0, scale: 1 }, 2, SIZE);
    const centre = screenToWorld(v, 500, 250);
    expect(centre.x).toBeCloseTo(500, 6);
    expect(centre.y).toBeCloseTo(250, 6);
  });
});

describe("fit and focus", () => {
  it("fits the content with padding", () => {
    const fitted = fitViewport({ width: 2000, height: 1000 }, SIZE, 20);
    // min(960/2000, 460/1000) — the height is the binding constraint
    expect(fitted.scale).toBeCloseTo(460 / 1000, 6);
    const visible = visibleWorldRect(fitted, SIZE);
    expect(visible.x).toBeLessThanOrEqual(0.001);
    expect(visible.width).toBeGreaterThanOrEqual(1999);
  });

  it("survives a zero-sized pane or empty content", () => {
    expect(fitViewport({ width: 0, height: 0 }, SIZE)).toBe(IDENTITY_VIEWPORT);
    expect(fitViewport({ width: 10, height: 10 }, { width: 0, height: 0 })).toBe(IDENTITY_VIEWPORT);
  });

  it("opens a wide chain at a legible zoom on the focus node, not at fit", () => {
    const content = { width: 6716, height: 178 };
    expect(isTooWideToFit(content, SIZE)).toBe(true);
    const v = initialViewport(content, SIZE, { x: 0, y: 0, width: 208, height: 84 });
    // height fit would be 3.1x; the policy caps the opening zoom at 1:1 so nodes are exactly as designed
    expect(v.scale).toBe(INITIAL_MAX_SCALE);
    const centre = screenToWorld(v, SIZE.width / 2, SIZE.height / 2);
    expect(centre.x).toBeCloseTo(104, 3); // centred on the focus node
    expect(centre.y).toBeCloseTo(89, 3); // vertically centred on the graph
  });

  it("floors the opening zoom at a legible scale when even height-fit is below it", () => {
    const content = { width: 20_000, height: 12_000 };
    const v = initialViewport(content, SIZE);
    expect(v.scale).toBe(LEGIBLE_MIN_SCALE);
    expect(isTooWideToFit(content, SIZE)).toBe(true);
  });

  it("caps the initial zoom for a wide graph on a phone while keeping the focused node visible", () => {
    const phone = { width: 327, height: 460 };
    const content = { width: 12_000, height: 300 };
    const focus = { x: 0, y: 108, width: 208, height: 84 };
    const viewport = initialViewport(content, phone, focus);
    const visible = visibleWorldRect(viewport, phone);

    expect(viewport.scale).toBeLessThanOrEqual(0.75);
    expect(viewport.scale).toBeGreaterThanOrEqual(LEGIBLE_MIN_SCALE);
    expect(visible.x).toBeLessThanOrEqual(focus.x);
    expect(visible.x + visible.width).toBeGreaterThanOrEqual(focus.x + focus.width);
  });

  it("still fits a graph that is readable at fit", () => {
    const content = { width: 900, height: 420 };
    expect(isTooWideToFit(content, SIZE)).toBe(false);
    const v = initialViewport(content, SIZE);
    expect(v.scale).toBeCloseTo(Math.min(INITIAL_MAX_SCALE, fitViewport(content, SIZE).scale), 6);
    const centre = screenToWorld(v, SIZE.width / 2, SIZE.height / 2);
    expect(centre.x).toBeCloseTo(content.width / 2, 6);
    expect(centre.y).toBeCloseTo(content.height / 2, 6);
  });

  it("centres the whole graph when its fit is legible", () => {
    const content = { width: 1400, height: 420 };
    const focus = { x: 0, y: 120, width: 208, height: 84 };
    const v = initialViewport(content, SIZE, focus);
    const visible = visibleWorldRect(v, SIZE);

    expect(v.scale).toBeCloseTo(fitViewport(content, SIZE).scale, 6);
    expect(visible.x).toBeLessThanOrEqual(0.001);
    expect(visible.x + visible.width).toBeGreaterThanOrEqual(content.width - 0.001);
  });

  it("fits a medium-wide graph in the initial viewport when the scale remains useful", () => {
    const content = { width: 2214, height: 1000 };
    const focus = { x: 0, y: 100, width: 208, height: 84 };
    const v = initialViewport(content, SIZE, focus);
    const visible = visibleWorldRect(v, SIZE);

    expect(v.scale).toBeCloseTo(fitViewport(content, SIZE).scale, 6);
    expect(v.scale).toBeGreaterThanOrEqual(INITIAL_FIT_MIN_SCALE);
    expect(visible.x).toBeLessThanOrEqual(0.001);
    expect(visible.x + visible.width).toBeGreaterThanOrEqual(content.width - 0.001);
    expect(visible.y).toBeLessThanOrEqual(0.001);
    expect(visible.y + visible.height).toBeGreaterThanOrEqual(content.height - 0.001);
  });

  it("does not zoom small graphs above 1:1", () => {
    const content = { width: 120, height: 84 };
    const v = initialViewport(content, SIZE, { x: 0, y: 0, width: 40, height: 40 });
    const centre = screenToWorld(v, SIZE.width / 2, SIZE.height / 2);

    expect(v.scale).toBe(INITIAL_MAX_SCALE);
    expect(centre.x).toBeCloseTo(content.width / 2, 6);
  });

  it("centres a rect at a chosen scale and can compute a focus scale", () => {
    const rect = { x: 1000, y: 0, width: 200, height: 100 };
    const v = centerOn(rect, SIZE, 1);
    const centre = screenToWorld(v, SIZE.width / 2, SIZE.height / 2);
    expect(centre.x).toBeCloseTo(1100, 6);
    expect(centre.y).toBeCloseTo(50, 6);
    // clamped to MAX_SCALE: the raw value would be 3.5
    expect(focusScale(rect, SIZE)).toBe(MAX_SCALE);
    expect(focusScale({ x: 0, y: 0, width: 0, height: 0 }, SIZE)).toBe(1);
  });
});

describe("minimap and bounds", () => {
  it("projects the content box preserving aspect ratio", () => {
    const proj = minimapProjection({ width: 4000, height: 1000 }, { width: 160, height: 100 });
    expect(proj.scale).toBeCloseTo(0.04, 6);
    expect(proj.offsetY).toBeCloseTo(30, 6);
    expect(proj.offsetX).toBeCloseTo(0, 6);
  });

  it("handles empty content", () => {
    expect(minimapProjection({ width: 0, height: 0 }, { width: 10, height: 10 })).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it("computes bounds of a rect list", () => {
    const b = boundsOf([
      { x: 10, y: 10, width: 10, height: 10 },
      { x: 40, y: 5, width: 4, height: 100 },
    ]);
    expect(b).toEqual({ x: 10, y: 5, width: 34, height: 100 });
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("tests containment", () => {
    const r = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectContains(r, 5, 5)).toBe(true);
    expect(rectContains(r, 10, 10)).toBe(true);
    expect(rectContains(r, 10.5, 5)).toBe(false);
  });
});
