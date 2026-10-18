/**
 * Label measurement and collision resolution.
 *
 * Semantic zoom decides *what* text a node wants at a given scale; collision resolution decides what actually fits.
 * Both are pure and deterministic, which is what the "labels appear/disappear by zoom and node size" acceptance
 * criterion needs: the same viewport always yields the same visible set, and no two labels ever overlap.
 */

export interface LabelCandidate {
  id: string;
  text: string;
  /** top-left in world space */
  x: number;
  y: number;
  width: number;
  height: number;
  /** higher wins; ties break on id, so the result is stable */
  priority: number;
}

export interface LabelPlacement extends LabelCandidate {
  /** the text as drawn (may be truncated to fit the node) */
  text: string;
}

export interface CollisionResult {
  placed: LabelPlacement[];
  hidden: string[];
}

/** Rough advance width for the bundled fonts; deliberately generous so labels never spill outside a node box. */
export function measureText(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    if (code >= 0x3000) units += 1;
    else if ("iljtfr.,:;'|!".includes(ch)) units += 0.34;
    else if ("mwMW@".includes(ch)) units += 1.02;
    else if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) units += 0.68;
    else units += 0.56;
  }
  return units * fontSize;
}

/** Advance width for the DAG title face, which is monospace rather than proportional. */
export function measureMonospaceText(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    units += code >= 0x3000 ? 1 : 0.62;
  }
  return units * fontSize;
}

/** Truncate to `maxWidth` world px with an ellipsis; never returns more than the original. */
export function ellipsize(text: string, fontSize: number, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (measureText(text, fontSize) <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisWidth = measureText(ellipsis, fontSize);
  if (ellipsisWidth > maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(text.slice(0, mid), fontSize) + ellipsisWidth <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}${ellipsis}`;
}

/** Truncate text drawn in the DAG's monospace title face, keeping a small width safety margin. */
export function ellipsizeMonospace(text: string, fontSize: number, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (measureMonospaceText(text, fontSize) <= maxWidth) return text;
  const chars = Array.from(text);
  const ellipsis = "…";
  const available = maxWidth - measureMonospaceText(ellipsis, fontSize);
  if (available < 0) return "";
  const count = Math.max(0, Math.floor(available / (fontSize * 0.62)));
  return `${chars.slice(0, count).join("").trimEnd()}${ellipsis}`;
}

/** Grid index over placed labels: 32 px cells keep the pairwise check off the O(n²) path for 300+ labels. */
const CELL = 32;

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/**
 * Greedy placement in priority order. A candidate is dropped when it overlaps an already-placed label — dropping is
 * the honest behaviour: a squeezed label is unreadable, and the node still carries tone/shape/aria.
 */
export function resolveLabelCollisions(candidates: readonly LabelCandidate[], maxLabels = 400): CollisionResult {
  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed: LabelPlacement[] = [];
  const hidden: string[] = [];
  const grid = new Map<string, LabelPlacement[]>();
  for (const c of ordered) {
    if (placed.length >= maxLabels) {
      hidden.push(c.id);
      continue;
    }
    const x0 = Math.floor(c.x / CELL);
    const y0 = Math.floor(c.y / CELL);
    const x1 = Math.floor((c.x + c.width) / CELL);
    const y1 = Math.floor((c.y + c.height) / CELL);
    let clash = false;
    for (let cx = x0; cx <= x1 && !clash; cx++) {
      for (let cy = y0; cy <= y1 && !clash; cy++) {
        for (const p of grid.get(cellKey(cx, cy)) ?? []) {
          if (overlaps(c, p)) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash) {
      hidden.push(c.id);
      continue;
    }
    const entry: LabelPlacement = { ...c, text: c.text };
    placed.push(entry);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        const bucket = grid.get(key);
        if (bucket) bucket.push(entry);
        else grid.set(key, [entry]);
      }
    }
  }
  return { placed, hidden };
}

function overlaps(a: LabelCandidate, b: LabelCandidate): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Assertion helper: used by tests (programmatic "no overlapping labels") and by the renderer's dev HUD. */
export function findOverlaps(labels: readonly LabelCandidate[]): [string, string][] {
  const bad: [string, string][] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!;
      const b = labels[j]!;
      if (overlaps(a, b)) bad.push([a.id, b.id]);
    }
  }
  return bad;
}
