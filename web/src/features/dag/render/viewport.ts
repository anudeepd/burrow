/**
 * Viewport math: pan, zoom, fit, centre-on, minimap projection. Pure functions only, so the interaction tests can
 * assert exact transforms instead of pixels.
 *
 * World space is the layout's coordinate system (origin at the graph's top-left). Screen space is the SVG viewport.
 * `x`/`y` are the world coordinates of the viewport's top-left corner; `scale` is world→screen.
 */
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

/** Zoom limits: 0.02 lets a 57 000 px-wide job DAG fit a 1 200 px pane; 3 is enough for a callsite in full. */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 3;

/** Semantic zoom thresholds. `overview` strips node text, `detail` adds the secondary line and badges' labels. */
export const LEVEL_OVERVIEW_MAX = 0.55;
export const LEVEL_DETAIL_MIN = 1.25;

export type SemanticLevel = "overview" | "normal" | "detail";

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function semanticLevel(scale: number): SemanticLevel {
  if (scale < LEVEL_OVERVIEW_MAX) return "overview";
  if (scale >= LEVEL_DETAIL_MIN) return "detail";
  return "normal";
}

export function worldToScreen(v: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - v.x) * v.scale, y: (y - v.y) * v.scale };
}

export function screenToWorld(v: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / v.scale + v.x, y: sy / v.scale + v.y };
}

/** The world rectangle currently visible in a `size`-pixel pane. */
export function visibleWorldRect(v: Viewport, size: Size): WorldRect {
  return { x: v.x, y: v.y, width: size.width / v.scale, height: size.height / v.scale };
}

export function panBy(v: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { ...v, x: v.x - dxScreen / v.scale, y: v.y - dyScreen / v.scale };
}

/** Zoom keeping the world point under (anchorX, anchorY) pinned. */
export function zoomAt(v: Viewport, factor: number, anchorX: number, anchorY: number): Viewport {
  const scale = clampScale(v.scale * factor);
  if (scale === v.scale) return v;
  const world = screenToWorld(v, anchorX, anchorY);
  return { scale, x: world.x - anchorX / scale, y: world.y - anchorY / scale };
}

/** Zoom to a scale keeping the pane centre pinned (keyboard +/-). */
export function zoomTo(v: Viewport, scale: number, size: Size): Viewport {
  return zoomAtCenter(v, clampScale(scale), size);
}

function zoomAtCenter(v: Viewport, scale: number, size: Size): Viewport {
  if (scale === v.scale) return v;
  const world = screenToWorld(v, size.width / 2, size.height / 2);
  return { scale, x: world.x - size.width / 2 / scale, y: world.y - size.height / 2 / scale };
}

/** Fit the whole graph into the pane, with `padding` screen pixels of breathing room. */
export function fitViewport(content: Size, size: Size, padding = 40): Viewport {
  if (content.width <= 0 || content.height <= 0 || size.width <= 0 || size.height <= 0) {
    return IDENTITY_VIEWPORT;
  }
  const usableW = Math.max(1, size.width - padding * 2);
  const usableH = Math.max(1, size.height - padding * 2);
  const scale = clampScale(Math.min(usableW / content.width, usableH / content.height));
  const x = content.width / 2 - size.width / 2 / scale;
  const y = content.height / 2 - size.height / 2 / scale;
  return { scale, x, y };
}

/**
 * What "a stage is legible" means in world px: at this scale a 208 px stage card is ~115 screen px, which is the point
 * where its title, status glyph and progress bar are all readable. The initial view never opens below it — a Spark job
 * DAG is 6 000-67 000 px wide, so a fit-everything open would be a 0.02-0.16 hairline nobody can read.
 */
export const LEGIBLE_MIN_SCALE = 0.55;

/** Moderate DAGs can show their full shape in overview mode without making a 300+ node graph a hairline. */
export const INITIAL_FIT_MIN_SCALE = 0.4;

/** Opening a graph never zooms *in* past 1 either: at 1:1 every node is exactly as designed. */
export const INITIAL_MAX_SCALE = 1;

/**
 * Initial viewport for a freshly laid-out graph (documented policy, `docs/design-dag.md` §3):
 *  1. if the whole graph fits at a useful overview scale, fit it — moderate graphs look finished on open;
 *  2. otherwise fit the **height** (so the DAG's rows are all visible and the vertical extent is used), clamped to
 *     [LEGIBLE_MIN_SCALE, INITIAL_MAX_SCALE];
 *  3. on a phone, cap the initial zoom at 75% for wide graphs so more of the flow is visible without dropping below
 *     the legible node scale;
 *  4. horizontal position starts on `focus` — the running stage when there is one, else the first node — because the
 *     data flow starts there and "center on running stage" takes over from the first tick.
 * The minimap carries the overview, and the "wider than the pane" hint says so.
 */
export function initialViewport(content: Size, size: Size, focus?: WorldRect | null): Viewport {
  if (content.width <= 0 || content.height <= 0 || size.width <= 0 || size.height <= 0) return IDENTITY_VIEWPORT;
  const fitted = fitViewport(content, size);
  const wholeGraphFitsUsefully = fitted.scale >= INITIAL_FIT_MIN_SCALE;
  const heightFit = (size.height - 48) / content.height;
  const openingMaxScale = size.width < 480 ? 0.75 : INITIAL_MAX_SCALE;
  const scale = wholeGraphFitsUsefully
    ? Math.min(INITIAL_MAX_SCALE, fitted.scale)
    : clampScale(Math.min(openingMaxScale, Math.max(LEGIBLE_MIN_SCALE, heightFit)));
  const centreY = content.height / 2;
  // When the whole graph fits, centring on the focus node defeats the fit: later stages can fall outside the pane even
  // though the selected scale was calculated from the graph bounds. Reserve focus framing for genuinely wide DAGs.
  const centreX = wholeGraphFitsUsefully ? content.width / 2 : focus ? focus.x + focus.width / 2 : content.width / 2;
  return { scale, x: centreX - size.width / 2 / scale, y: centreY - size.height / 2 / scale };
}

/** True when the whole graph cannot be shown at a legible scale (drives the "very wide" hint). */
export function isTooWideToFit(content: Size, size: Size): boolean {
  return fitViewport(content, size).scale < LEGIBLE_MIN_SCALE;
}

/** Keep `rect` centred without changing the zoom (the "center on running stage" action). */
export function centerOn(rect: WorldRect, size: Size, scale: number): Viewport {
  const s = clampScale(scale);
  return {
    scale: s,
    x: rect.x + rect.width / 2 - size.width / 2 / s,
    y: rect.y + rect.height / 2 - size.height / 2 / s,
  };
}

/** Scale needed to make `rect` fill ~70% of the pane, bounded; used before centring a stage. */
export function focusScale(rect: WorldRect, size: Size, target = 0.7): number {
  if (rect.width <= 0 || rect.height <= 0) return 1;
  const sx = (size.width * target) / rect.width;
  const sy = (size.height * target) / rect.height;
  return clampScale(Math.min(sx, sy));
}

/** World → minimap transform. */
export interface MinimapProjection {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Minimap projection: whole graph → minimap box, preserving aspect ratio. */
export function minimapProjection(content: Size, box: Size): MinimapProjection {
  if (content.width <= 0 || content.height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min(box.width / content.width, box.height / content.height);
  return {
    scale,
    offsetX: (box.width - content.width * scale) / 2,
    offsetY: (box.height - content.height * scale) / 2,
  };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(rects: Iterable<WorldRect>): WorldRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

export function rectContains(r: WorldRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height;
}

/** Viewport for the SVG transform attribute: translate then scale (world→screen). */
export function viewportTransform(v: Viewport): string {
  return `translate(${(-v.x * v.scale).toFixed(3)} ${(-v.y * v.scale).toFixed(3)}) scale(${v.scale.toFixed(5)})`;
}
