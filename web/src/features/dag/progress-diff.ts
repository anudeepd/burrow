/**
 * The DAG diff / animation state machine.
 *
 * Progress arrives as a stream of `StageMetric` snapshots. Re-rendering from scratch would make numbers teleport; this
 * module turns (previous, next) into an explicit *plan*: which nodes are entering/leaving, how far each bar has to
 * tween, whether the change is big enough to read as a jump, and whether a task failure should flash. Keeping it pure
 * means the rules (tween duration, jump threshold, flash tone) are unit-testable without a browser.
 *
 * `TWEEN_MS`/`JUMP_PP` mirror the motion tokens in `src/styles/tokens.css`: tween = `--dur-tween` (420 ms), and a
 * change ≤ 3 percentage points is not worth animating at all.
 */
import type { Tone } from "~/design/status";
import type { ProgressSegments } from "./metrics";
import type { StageStatus } from "./metrics";

/** >= this many percentage points in one tick reads as a "jump" and gets the long tween. */
export const JUMP_PP = 25;
/** Below this, the change is applied instantly: motion on every 1% tick would be noise. */
export const TWEEN_MIN_PP = 3;
export const TWEEN_MS = 420;
export const JUMP_TWEEN_MS = 620;
/** How long a failure flash stays on screen. */
export const FLASH_MS = 900;

export interface StageVisual {
  percent: number;
  status: StageStatus;
  failed: number;
}

export interface NodeUpdate {
  id: string;
  fromPercent: number;
  toPercent: number;
  /** signed percentage-point delta */
  deltaPp: number;
  /** 0 = apply instantly, otherwise the CSS transition duration in ms */
  tweenMs: number;
  jump: boolean;
  statusChanged: boolean;
  /** one-shot highlight, cleared by the caller after `FLASH_MS` */
  flash: Tone | null;
}

export interface DiffPlan {
  updates: NodeUpdate[];
  entering: string[];
  exiting: string[];
  /** nodes whose progress did not change: no DOM writes */
  unchanged: string[];
  /** total completed tasks across the graph, for the toolbar's live readout */
  totals: { done: number; total: number; active: number; failed: number };
}

const EMPTY_TOTALS = { done: 0, total: 0, active: 0, failed: 0 };

export function stageVisual(id: string, segments: ProgressSegments, status: StageStatus): [string, StageVisual] {
  return [id, { percent: segments.percent, status, failed: segments.failed }];
}

function flashFor(prev: StageVisual | undefined, next: StageVisual): Tone | null {
  if (!prev) return null;
  if (next.failed > prev.failed) return "fail";
  if (prev.status !== "COMPLETE" && next.status === "COMPLETE") return "ok";
  if (prev.status !== "FAILED" && next.status === "FAILED") return "fail";
  return null;
}

/**
 * Plan the transition. `order` is the graph's node order, which fixes update order and therefore the order of DOM
 * mutations (stable, minimal reflow — React keys do the rest).
 */
export function diffProgress(
  order: readonly string[],
  prev: ReadonlyMap<string, StageVisual>,
  next: ReadonlyMap<string, StageVisual>,
): DiffPlan {
  const updates: NodeUpdate[] = [];
  const unchanged: string[] = [];
  const totals = { ...EMPTY_TOTALS };
  const seen = new Set<string>();
  for (const id of order) {
    seen.add(id);
    const n = next.get(id);
    if (!n) continue;
    const p = prev.get(id);
    if (!p) {
      updates.push({
        id,
        fromPercent: 0,
        toPercent: n.percent,
        deltaPp: n.percent,
        tweenMs: TWEEN_MS,
        jump: true,
        statusChanged: true,
        flash: "live",
      });
      continue;
    }
    const delta = n.percent - p.percent;
    const statusChanged = p.status !== n.status;
    const flash = flashFor(p, n);
    if (!statusChanged && Math.abs(delta) < TWEEN_MIN_PP && flash === null && n.failed === p.failed) {
      unchanged.push(id);
      continue;
    }
    const jump = Math.abs(delta) >= JUMP_PP;
    // A status change with no movement needs no width tween: the colour change is a CSS transition on the segment.
    const moves = Math.abs(delta) >= TWEEN_MIN_PP;
    updates.push({
      id,
      fromPercent: p.percent,
      toPercent: n.percent,
      deltaPp: delta,
      tweenMs: moves ? (jump ? JUMP_TWEEN_MS : TWEEN_MS) : 0,
      jump,
      statusChanged,
      flash,
    });
  }
  const entering: string[] = [];
  for (const [id] of next) if (!seen.has(id)) entering.push(id);
  const exiting: string[] = [];
  for (const [id] of prev) if (!next.has(id)) exiting.push(id);
  return { updates, entering, exiting, unchanged, totals };
}

/** Populate the toolbar totals straight from the metric stream (independent of the diff). */
export function accumulateTotals(
  entries: Iterable<{ numCompleteTasks: number; numTasks: number; numActiveTasks: number; numFailedTasks: number }>,
): DiffPlan["totals"] {
  const totals = { ...EMPTY_TOTALS };
  for (const m of entries) {
    totals.done += m.numCompleteTasks;
    totals.total += m.numTasks;
    totals.active += m.numActiveTasks;
    totals.failed += m.numFailedTasks;
  }
  return totals;
}

/** Percentage of the whole job that is complete, weighted by task count (the toolbar readout). */
export function weightedPercent(totals: DiffPlan["totals"]): number {
  if (totals.total <= 0) return 0;
  return Math.max(0, Math.min(100, (totals.done / totals.total) * 100));
}
