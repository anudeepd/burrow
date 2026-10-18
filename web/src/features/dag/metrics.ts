/**
 * Stage metrics: the REST half of the DAG picture.
 *
 * The DOT-derived `Dag` carries structure only (nodes, edges, clusters, cached/barrier flags). Everything live —
 * task counts, shuffle bytes, durations — comes from `/api/spark/{appId}/stages` and is joined onto the graph here.
 * Nothing in this module touches the DOM or the network, so it is unit-testable and reusable by the timeline slice.
 */
import type { Tone } from "~/design/status";

/** One row of Spark's `/stages[?details&withSummaries]` response (trimmed to what a DAG needs). */
export interface StageMetricInput {
  status?: string | null;
  stageId?: number | null;
  attemptId?: number | null;
  name?: string | null;
  numTasks?: number | null;
  numActiveTasks?: number | null;
  numCompleteTasks?: number | null;
  numFailedTasks?: number | null;
  numKilledTasks?: number | null;
  numCompletedIndices?: number | null;
  submissionTime?: string | number | null;
  firstTaskLaunchedTime?: string | number | null;
  completionTime?: string | number | null;
  inputBytes?: number | null;
  inputRecords?: number | null;
  outputBytes?: number | null;
  outputRecords?: number | null;
  shuffleReadBytes?: number | null;
  shuffleWriteBytes?: number | null;
  shuffleReadRecords?: number | null;
  shuffleWriteRecords?: number | null;
  shuffleFetchWaitTime?: number | null;
  memoryBytesSpilled?: number | null;
  diskBytesSpilled?: number | null;
  executorRunTime?: number | null;
  executorDeserializeTime?: number | null;
  resultSerializationTime?: number | null;
  resultSize?: number | null;
  jvmGcTime?: number | null;
  peakExecutionMemory?: number | null;
  [k: string]: unknown;
}

/** Normalised, total metric row. `null` means "upstream did not report it" — never rendered as 0. */
export interface StageMetric {
  stageId: number;
  attemptId: number;
  status: StageStatus;
  numTasks: number;
  numActiveTasks: number;
  numCompleteTasks: number;
  /** Distinct completed partitions; successful speculative/retried attempts can inflate numCompleteTasks. */
  numCompletedIndices?: number | null;
  numFailedTasks: number;
  numKilledTasks: number;
  /** epoch ms, null when not started/finished */
  submissionTime: number | null;
  firstTaskLaunchedTime: number | null;
  completionTime: number | null;
  inputBytes: number | null;
  inputRecords: number | null;
  outputBytes: number | null;
  outputRecords: number | null;
  shuffleReadBytes: number | null;
  shuffleWriteBytes: number | null;
  shuffleReadRecords: number | null;
  shuffleWriteRecords: number | null;
  shuffleFetchWaitTime: number | null;
  memoryBytesSpilled: number | null;
  diskBytesSpilled: number | null;
  executorRunTime: number | null;
  executorDeserializeTime: number | null;
  resultSerializationTime: number | null;
  resultSize: number | null;
  jvmGcTime: number | null;
  peakExecutionMemory: number | null;
  /** every upstream field, for the drawer's "all fields" table */
  raw: Record<string, unknown>;
}

export type StageStatus = "ACTIVE" | "COMPLETE" | "FAILED" | "PENDING" | "SKIPPED" | "UNKNOWN";

/** Static string-keyed lookup: an unknown upstream status degrades to UNKNOWN rather than throwing. */
const STAGE_STATUS_BY_KEY: Record<string, StageStatus> = {
  ACTIVE: "ACTIVE",
  COMPLETE: "COMPLETE",
  FAILED: "FAILED",
  PENDING: "PENDING",
  SKIPPED: "SKIPPED",
  UNKNOWN: "UNKNOWN",
};

export function normalizeStageStatus(raw: string | null | undefined): StageStatus {
  if (!raw) return "UNKNOWN";
  return STAGE_STATUS_BY_KEY[raw.toUpperCase()] ?? "UNKNOWN";
}

/**
 * Spark timestamps are `2026-10-03T06:50:15.695GMT` (its own `SparkUIUtils.formatDate` shape) or, in some
 * versions/endpoints, epoch millis. Both are accepted; anything unparseable is `null`, never `NaN`.
 */
export function parseSparkTime(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v;
  }
  const s = v.trim();
  if (s === "" || s === "-") return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null;
  }
  // Spark prints `…GMT`; `Date.parse` only understands the ISO `Z` spelling.
  const ms = Date.parse(s.replace(/(GMT|UTC)$/i, "Z"));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

/** JSON number → number, else null. Used by every field below; `null` and non-numbers never become 0. */
function finiteNumber(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return v;
}

/** Counts are totals, so an absent value is 0 — but a negative one is upstream nonsense and also becomes 0. */
function count(v: unknown): number {
  const n = finiteNumber(v);
  if (n == null || n < 0) return 0;
  return Math.trunc(n);
}

/** Byte/time metrics stay `null` when absent or negative: the drawer must print "—", not a fabricated 0. */
function measure(v: unknown): number | null {
  const n = finiteNumber(v);
  if (n == null || n < 0) return null;
  return n;
}

export function toStageMetric(row: StageMetricInput | null | undefined): StageMetric | null {
  if (!row || typeof row !== "object") return null;
  const stageId = finiteNumber(row.stageId);
  if (stageId == null) return null;
  return {
    stageId,
    attemptId: count(row.attemptId),
    status: normalizeStageStatus(row.status),
    numTasks: count(row.numTasks),
    numActiveTasks: count(row.numActiveTasks),
    numCompleteTasks: count(row.numCompleteTasks),
    numCompletedIndices: row.numCompletedIndices == null ? null : count(row.numCompletedIndices),
    numFailedTasks: count(row.numFailedTasks),
    numKilledTasks: count(row.numKilledTasks),
    submissionTime: parseSparkTime(row.submissionTime),
    firstTaskLaunchedTime: parseSparkTime(row.firstTaskLaunchedTime),
    completionTime: parseSparkTime(row.completionTime),
    inputBytes: measure(row.inputBytes),
    inputRecords: measure(row.inputRecords),
    outputBytes: measure(row.outputBytes),
    outputRecords: measure(row.outputRecords),
    shuffleReadBytes: measure(row.shuffleReadBytes),
    shuffleWriteBytes: measure(row.shuffleWriteBytes),
    shuffleReadRecords: measure(row.shuffleReadRecords),
    shuffleWriteRecords: measure(row.shuffleWriteRecords),
    shuffleFetchWaitTime: measure(row.shuffleFetchWaitTime),
    memoryBytesSpilled: measure(row.memoryBytesSpilled),
    diskBytesSpilled: measure(row.diskBytesSpilled),
    executorRunTime: measure(row.executorRunTime),
    executorDeserializeTime: measure(row.executorDeserializeTime),
    resultSerializationTime: measure(row.resultSerializationTime),
    resultSize: measure(row.resultSize),
    jvmGcTime: measure(row.jvmGcTime),
    peakExecutionMemory: measure(row.peakExecutionMemory),
    raw: row as Record<string, unknown>,
  };
}

/** Rows out of a REST body of any of Spark's shapes (array, `{stages:[…]}`, single object). */
function stageRowsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    if ("stages" in body && Array.isArray(body.stages)) return body.stages;
    if ("stageId" in body) return [body];
  }
  return [];
}

export function stageMetricsFromRest(body: unknown): StageMetric[] {
  const out: StageMetric[] = [];
  for (const r of stageRowsOf(body)) {
    if (!r || typeof r !== "object") continue;
    const m = toStageMetric(r as StageMetricInput);
    if (m) out.push(m);
  }
  return out;
}

/** Latest attempt wins; `stageId` keyed. */
export function indexStageMetrics(metrics: readonly StageMetric[]): Map<number, StageMetric> {
  const m = new Map<number, StageMetric>();
  for (const s of metrics) {
    const prev = m.get(s.stageId);
    if (!prev || s.attemptId >= prev.attemptId) m.set(s.stageId, s);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------------

export interface ProgressSegments {
  total: number;
  done: number;
  active: number;
  failed: number;
  killed: number;
  pending: number;
  /** done/total*100, clamped 0..100 */
  percent: number;
}

export function stageProgress(m: StageMetric): ProgressSegments {
  const total = Math.max(0, m.numTasks);
  const done = Math.min(total, count(m.numCompletedIndices ?? m.numCompleteTasks));
  const active = Math.min(total - done, count(m.numActiveTasks));
  const failed = Math.max(0, m.numFailedTasks);
  const killed = Math.max(0, m.numKilledTasks);
  // Failed/killed attempts may retry the same partition; they do not occupy completed progress.
  const pending = Math.max(0, total - done - active);
  let percent = 0;
  if (total > 0) percent = Math.max(0, Math.min(100, (done / total) * 100));
  else if (m.status === "COMPLETE") percent = 100;
  return { total, done, active, failed, killed, pending, percent };
}

/** Progress-bar segments, in the order the bar stacks them. Zero-width segments are dropped. */
export function progressSegments(p: ProgressSegments): { percent: number; tone: Tone; label: string }[] {
  const total = p.total > 0 ? p.total : 1;
  const share = (n: number) => (n / total) * 100;
  const segs: { percent: number; tone: Tone; label: string }[] = [];
  if (p.done > 0) segs.push({ percent: share(p.done), tone: "ok", label: `${p.done} completed` });
  if (p.active > 0) segs.push({ percent: share(p.active), tone: "live", label: `${p.active} active` });
  if (p.pending > 0) segs.push({ percent: share(p.pending), tone: "wait", label: `${p.pending} pending` });
  return segs;
}

/**
 * Status used by the node's tone/shape. A stage with failed tasks but still running stays ACTIVE (its failed count
 * is shown as a badge) — only a terminal FAILED status gets the fail treatment.
 */
export function stageTone(m: StageMetric | undefined, skipped: boolean): Tone {
  if (skipped) return "idle";
  if (!m) return "idle";
  switch (m.status) {
    case "ACTIVE":
      return m.numFailedTasks > 0 ? "warn" : "live";
    case "COMPLETE":
      return m.numFailedTasks > 0 ? "warn" : "ok";
    case "FAILED":
      return "fail";
    case "PENDING":
      return "wait";
    default:
      return "idle";
  }
}

/** The state key `src/design/status.ts` looks up in the `spark.stage` domain for this row. */
export function stageStatusKey(m: StageMetric | undefined, skipped: boolean): string {
  if (skipped) return "SKIPPED";
  if (!m || m.status === "UNKNOWN") return "PENDING";
  return m.status;
}

/** Wall-clock duration of a stage: completed stages use completion−submission, active use now−submission. */
export function stageDuration(m: StageMetric | undefined, now: number): number | null {
  if (!m) return null;
  const start = m.submissionTime ?? m.firstTaskLaunchedTime;
  if (start == null) return null;
  const end = m.completionTime ?? now;
  return Math.max(0, end - start);
}

// ---------------------------------------------------------------------------------------------------
// Flow (which producers are emitting right now, and how hard)
// ---------------------------------------------------------------------------------------------------

export interface FlowReading {
  active: boolean;
  /** 0..1 — drives dash speed *and* opacity; 0 = idle */
  intensity: number;
  /** completed-task delta per second, the raw evidence behind `intensity` */
  ratePerSecond: number;
}

/**
 * A producer flows when it is *currently producing*: ACTIVE with active-or-just-completed tasks. Intensity is squashed
 * from completed-task delta/second so a wide fan-out does not all glow at full brightness.
 */
export function flowReading(prev: StageMetric | undefined, next: StageMetric | undefined, skipped: boolean, windowMs: number): FlowReading {
  if (skipped || !next || windowMs <= 0) return { active: false, intensity: 0, ratePerSecond: 0 };
  if (next.status !== "ACTIVE") return { active: false, intensity: 0, ratePerSecond: 0 };
  const prevDone = prev?.numCompletedIndices ?? prev?.numCompleteTasks ?? 0;
  const delta = Math.max(0, (next.numCompletedIndices ?? next.numCompleteTasks) - prevDone);
  const rate = (delta / windowMs) * 1000;
  const live = next.numActiveTasks > 0 || delta > 0;
  if (!live) return { active: false, intensity: 0, ratePerSecond: rate };
  // 1 completed task/s already reads as "clearly flowing"; 8/s saturates.
  const intensity = Math.max(0.25, Math.min(1, 0.25 + rate / 8));
  return { active: true, intensity, ratePerSecond: rate };
}

/** Keyed by producer node id: stage nodes' own id, which is what the edges reference. */
export function flowByProducer(
  producers: readonly { id: string; stageId?: number; skipped?: boolean }[],
  metrics: Map<number, StageMetric>,
  prevMetrics: Map<number, StageMetric>,
  windowMs: number,
): Map<string, FlowReading> {
  const out = new Map<string, FlowReading>();
  const readingsByStage = new Map<number, Map<boolean, FlowReading>>();
  for (const p of producers) {
    if (p.stageId == null) continue;
    const skipped = p.skipped === true;
    let bySkipped = readingsByStage.get(p.stageId);
    let reading = bySkipped?.get(skipped);
    if (!reading) {
      reading = flowReading(prevMetrics.get(p.stageId), metrics.get(p.stageId), skipped, windowMs);
      if (!bySkipped) {
        bySkipped = new Map();
        readingsByStage.set(p.stageId, bySkipped);
      }
      bySkipped.set(skipped, reading);
    }
    out.set(p.id, reading);
  }
  return out;
}
