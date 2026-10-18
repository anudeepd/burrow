/**
 * Edge geometry: SVG path strings, arrows, flow dashes, label anchors.
 *
 * ELK gives orthogonal polylines. Drawn raw they look mechanical; drawn with a small corner radius they read as
 * "wiring". When ELK returns no section for an edge (merged edges, or a payload we synthesised) we fall back to a
 * straight line between the two node boxes, so an edge is never silently dropped.
 */
import type { Rect } from "../types";

export interface Point {
  x: number;
  y: number;
}

/** Corner radius for orthogonal polylines: big enough to soften, small enough to stay crisp at 1× zoom. */
export const CORNER_RADIUS = 9;

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * Path through `points` with quadratic corners. Collinear/duplicate points are dropped first, which also means a
 * two-point line becomes one `L` (no spurious corner).
 */
export function pathFromPoints(points: readonly Point[], radius = CORNER_RADIUS): string {
  const pts: Point[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) pts.push(p);
  }
  if (pts.length === 0) return "";
  const first = pts[0]!;
  if (pts.length === 1) return `M ${f(first.x)} ${f(first.y)}`;
  if (pts.length === 2) {
    const last = pts[1]!;
    return `M ${f(first.x)} ${f(first.y)} L ${f(last.x)} ${f(last.y)}`;
  }
  let d = `M ${f(first.x)} ${f(first.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const r = Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2);
    const inDir = norm(sub(cur, prev));
    const outDir = norm(sub(next, cur));
    const before = { x: cur.x - inDir.x * r, y: cur.y - inDir.y * r };
    const after = { x: cur.x + outDir.x * r, y: cur.y + outDir.y * r };
    d += ` L ${f(before.x)} ${f(before.y)} Q ${f(cur.x)} ${f(cur.y)} ${f(after.x)} ${f(after.y)}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L ${f(last.x)} ${f(last.y)}`;
  return d;
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}
function norm(a: Point): Point {
  const len = Math.hypot(a.x, a.y);
  return len < 1e-6 ? { x: 1, y: 0 } : { x: a.x / len, y: a.y / len };
}
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Straight two-point fallback: leave the source box on the facing side, arrive on the facing side of the target. */
export function straightEdge(from: Rect, to: Rect): Point[] {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  const start =
    Math.abs(dx) >= Math.abs(dy)
      ? { x: dx >= 0 ? from.x + from.width : from.x, y: clamp(fromCy, from.y, from.y + from.height) }
      : { x: clamp(fromCx, from.x, from.x + from.width), y: dy >= 0 ? from.y + from.height : from.y };
  const end =
    Math.abs(dx) >= Math.abs(dy)
      ? { x: dx >= 0 ? to.x : to.x + to.width, y: clamp(toCy, to.y, to.y + to.height) }
      : { x: clamp(toCx, to.x, to.x + to.width), y: dy >= 0 ? to.y : to.y + to.height };
  return [start, end];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface ArrowGeometry {
  /** triangle path */
  d: string;
  /** direction in radians, for `transform` misuse-free rotation */
  angleDeg: number;
}

/** Arrow head at the *end* of a polyline, pointing along the final segment. */
export function arrowAt(points: readonly Point[], size = 7): ArrowGeometry | null {
  const n = points.length;
  if (n < 2) return null;
  const end = points[n - 1]!;
  let i = n - 2;
  while (i > 0 && dist(points[i]!, end) < 0.5) i--;
  const prev = points[i]!;
  const angle = Math.atan2(end.y - prev.y, end.x - prev.x);
  const tip = { x: end.x - Math.cos(angle) * 1.5, y: end.y - Math.sin(angle) * 1.5 };
  const back = { x: tip.x - Math.cos(angle) * size, y: tip.y - Math.sin(angle) * size };
  const half = size * 0.52;
  const left = { x: back.x - Math.sin(angle) * half, y: back.y + Math.cos(angle) * half };
  const right = { x: back.x + Math.sin(angle) * half, y: back.y - Math.cos(angle) * half };
  return {
    d: `M ${f(tip.x)} ${f(tip.y)} L ${f(left.x)} ${f(left.y)} L ${f(right.x)} ${f(right.y)} Z`,
    angleDeg: (angle * 180) / Math.PI,
  };
}

export interface FlowDash {
  /** `stroke-dasharray` — always set so idle edges still read as "wire" */
  dashArray: string;
  /** `stroke-dashoffset` animation duration; 0 = static (reduced motion) */
  animationSeconds: number;
  /** negative distance per animation cycle; the keyframe writes exactly this value */
  travel: number;
  opacity: number;
}

/**
 * Flow styling for an edge. `intensity` (0..1) sets both density and speed: a busy stage gets shorter dashes moving
 * faster. Reduced motion keeps the busy look with a *static* short-dash texture, so liveness is never motion-only.
 */
export function flowDash(intensity: number, reducedMotion: boolean): FlowDash {
  const busy = Math.max(0, Math.min(1, intensity));
  const dash = Math.round(12 - busy * 6);
  const gap = Math.round(10 - busy * 4);
  if (reducedMotion || busy <= 0) {
    return { dashArray: `${dash} ${gap}`, animationSeconds: 0, travel: dash + gap, opacity: busy > 0 ? 0.95 : 0.8 };
  }
  const cycle = dash + gap;
  const speed = 26 + busy * 90; // px/s
  const seconds = cycle / speed;
  return { dashArray: `${dash} ${gap}`, animationSeconds: Number(seconds.toFixed(3)), travel: cycle, opacity: 0.95 };
}

/** Point at `t` (0..1) along a polyline, for edge labels and the hover target's anchor. */
export function pointAlong(points: readonly Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const len = dist(points[i - 1]!, points[i]!);
    segs.push(len);
    total += len;
  }
  let target = total * Math.max(0, Math.min(1, t));
  for (let i = 0; i < segs.length; i++) {
    const len = segs[i]!;
    if (target <= len) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const k = len < 1e-6 ? 0 : target / len;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    target -= len;
  }
  return points[points.length - 1]!;
}
