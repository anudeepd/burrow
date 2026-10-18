/**
 * Spark-specific value helpers: timestamp parsing, durations, task/stage aggregates and quantile handling.
 *
 * Spark REST emits timestamps as `2026-10-03T06:49:08.233GMT` (Spark 3.x/4.x) and, on some builds, ISO-8601 with a
 * numeric offset. The Spark UI's own `Times.formatISO8601` produces GMT; `utils.formatDuration`/`formatBytes` produce
 * the visible strings. We re-implement the *semantics* on top of Burrow's shared formatters so units match
 * (`js.formatDuration → fmtDuration`, `js.formatBytes → fmtBytes`), and never round-trip through Date strings where a
 * numeric `*Epoch` field exists.
 */
import { fmtBytes, fmtDuration, fmtInt } from "~/lib/format";
import type { SparkJob, SparkSqlExecution, SparkStage, SparkStreamingBatch, SparkTask } from "./schemas";

const NA = "—";

/** Parse a Spark REST timestamp to epoch ms. Accepts `…GMT`, `…Z`, `…+0000`, `…+00:00`, and epoch-number strings. */
export function parseSparkTime(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // Spark's GMT suffix: `Date.parse` accepts it on V8/JSC but not per spec — normalise first.
  const normalised = s.endsWith("GMT") ? `${s.slice(0, -3)}Z` : s;
  const t = Date.parse(normalised);
  return Number.isFinite(t) ? t : null;
}

/** Spark `Times.formatISO8601`-style field: epoch-ms if the raw value is present, else null. */
export function epochOf(epoch: number | null | undefined, text: string | null | undefined): number | null {
  if (epoch != null && epoch > 0) return epoch;
  return parseSparkTime(text);
}

/* ── durations ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Job duration: completion − submission (running: now − submission). Null when submission is unknown. */
export function jobDurationMs(job: SparkJob, now: number = Date.now()): number | null {
  const from = parseSparkTime(job.submissionTime);
  if (from == null) return null;
  const to = parseSparkTime(job.completionTime);
  return Math.max(0, (to ?? now) - from);
}

/** Stage duration: completion − submission (running: now − submission), falling back to the first task launch. */
export function stageDurationMs(stage: SparkStage, now: number = Date.now()): number | null {
  const from = parseSparkTime(stage.submissionTime) ?? parseSparkTime(stage.firstTaskLaunchedTime);
  if (from == null) return null;
  const to = parseSparkTime(stage.completionTime);
  return Math.max(0, (to ?? now) - from);
}

export function sqlDurationMs(exec: SparkSqlExecution, now: number = Date.now()): number | null {
  if (exec.duration != null && exec.duration >= 0) return exec.duration;
  const from = parseSparkTime(exec.submissionTime);
  if (from == null) return null;
  const to = parseSparkTime(exec.completionTime);
  return Math.max(0, (to ?? now) - from);
}

export function batchDurationMs(batch: SparkStreamingBatch): number | null {
  const t = parseSparkTime(batch.batchTime);
  const dur = batch.processingTime;
  return t == null && dur == null ? null : (dur ?? null);
}

/* ── counts / shares ────────────────────────────────────────────────────────────────────────────────────────── */

/** 0..1 → "12.3%". Spark shows fractions with one decimal on storage pages. */
export function fmtFraction(part: number | null | undefined, whole: number | null | undefined, digits = 1): string {
  if (part == null || whole == null || whole <= 0) return NA;
  return `${((100 * part) / whole).toFixed(digits)}%`;
}

export const fraction = (part: number | null | undefined, whole: number | null | undefined): number | null =>
  part == null || whole == null || whole <= 0 ? null : part / whole;

/** Task status share for a stage's segmented progress bar (0..100 each). */
export function stageTaskShares(s: {
  numTasks?: number | null;
  numActiveTasks?: number | null;
  numCompleteTasks?: number | null;
  numCompletedIndices?: number | null;
  numFailedTasks?: number | null;
  numKilledTasks?: number | null;
}): { complete: number; active: number; failed: number; killed: number; pending: number } {
  const total = Math.max(0, s.numTasks ?? 0);
  const complete = Math.min(total, Math.max(0, s.numCompletedIndices ?? s.numCompleteTasks ?? 0));
  const active = Math.min(total - complete, Math.max(0, s.numActiveTasks ?? 0));
  // Failed/killed counters count attempts, including retries of the same partition. They cannot consume remaining
  // partition progress; their raw counts remain visible beside the progress bar.
  const pending = total - complete - active;
  const pct = (n: number) => (total > 0 ? (100 * n) / total : 0);
  return { complete: pct(complete), active: pct(active), failed: 0, killed: 0, pending: pct(pending) };
}

/** Spark's own progress rule for a stage row: complete / numTasks, capped, `-1` while unknown. */
export function stageProgress(stage: SparkStage): number {
  const complete = Math.max(0, stage.numCompletedIndices ?? stage.numCompleteTasks ?? 0);
  const total = stage.numTasks ?? 0;
  if (stage.status === "COMPLETE" || stage.status === "SKIPPED") return 100;
  return total > 0 ? Math.min(100, (100 * complete) / total) : 0;
}

/* ── byte/record cells ─────────────────────────────────────────────────────────────────────────────────────── */

/** "1.2 MiB / 3,456" — size + record count, the pattern Spark uses in input/output/shuffle cells. */
export function sizeRecords(bytes: number | null | undefined, records: number | null | undefined): string {
  if (bytes == null && records == null) return NA;
  return `${bytes == null ? NA : fmtBytes(bytes)} / ${records == null ? NA : fmtInt(records)}`;
}

/* ── quantiles ─────────────────────────────────────────────────────────────────────────────────────────────── */

export interface QuantileSeries {
  /** requested quantiles, e.g. [0.05, 0.25, 0.5, 0.75, 0.95] */
  quantiles: number[];
  /** one value per quantile (may be shorter than `quantiles` if the metric was not reported) */
  values: number[];
}

/** Build a series from a `taskSummary`/`taskMetricsDistributions` metric array + its `quantiles` array. */
export function seriesOf(quantiles: number[] | null | undefined, values: number[] | null | undefined): QuantileSeries | null {
  if (!quantiles || !values || values.length === 0) return null;
  const n = Math.min(quantiles.length, values.length);
  return { quantiles: quantiles.slice(0, n), values: values.slice(0, n) };
}

export function quantileMax(values: number[] | null | undefined): number | null {
  if (!values || values.length === 0) return null;
  return values.reduce((a, v) => (Number.isFinite(v) && v > a ? v : a), Number.NEGATIVE_INFINITY);
}

/** Metric formatter used by distribution charts: durations vs bytes vs raw counts. */
export type MetricUnit = "ms" | "bytes" | "count";

export function fmtMetric(v: number | null | undefined, unit: MetricUnit): string {
  if (v == null) return NA;
  switch (unit) {
    case "ms":
      return fmtDuration(v);
    case "bytes":
      return fmtBytes(v);
    default:
      return fmtInt(v);
  }
}

/* ── task helpers ───────────────────────────────────────────────────────────────────────────────────────────── */

export interface TaskInputLike {
  bytes: number | null;
  records: number | null;
}

/** Task input: InputMetrics when present, else ShuffleRead metrics (Spark UI shows "Input Size / Records" only when the
 * task read input; shuffle-only tasks show the shuffle columns instead). */
export function taskInput(task: SparkTask): TaskInputLike {
  const m = task.taskMetrics;
  const im = m?.inputMetrics;
  return { bytes: im?.bytesRead ?? null, records: im?.recordsRead ?? null };
}

export function taskShuffleRead(task: SparkTask): TaskInputLike {
  const sr = task.taskMetrics?.shuffleReadMetrics;
  return {
    bytes: sr?.localBytesRead != null || sr?.remoteBytesRead != null ? (sr.localBytesRead ?? 0) + (sr.remoteBytesRead ?? 0) : null,
    records: sr?.recordsRead ?? null,
  };
}

export function taskShuffleWrite(task: SparkTask): TaskInputLike {
  const sw = task.taskMetrics?.shuffleWriteMetrics;
  return { bytes: sw?.bytesWritten ?? null, records: sw?.recordsWritten ?? null };
}

export function taskOutput(task: SparkTask): TaskInputLike {
  const om = task.taskMetrics?.outputMetrics;
  return { bytes: om?.bytesWritten ?? null, records: om?.recordsWritten ?? null };
}

export function totalShuffleReadBytes(task: SparkTask): number | null {
  const sr = task.taskMetrics?.shuffleReadMetrics;
  if (!sr) return null;
  if (sr.localBytesRead == null && sr.remoteBytesRead == null) return null;
  return (sr.localBytesRead ?? 0) + (sr.remoteBytesRead ?? 0);
}

/** Stable row key for the task table: Spark reuses `taskId` across attempts only via `attempt`, so key on both. */
export const taskRowKey = (t: SparkTask): string => `${t.taskId}-${t.attempt ?? 0}`;

/** Stage row key for retried attempts. */
export const stageRowKey = (s: SparkStage): string => `${s.stageId}/${s.attemptId ?? 0}`;
