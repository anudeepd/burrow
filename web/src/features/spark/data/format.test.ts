/**
 * Pure unit tests for the Spark value helpers (`data/format.ts`).
 *
 * No DOM: these are the semantics Spark's own UI computes client-side (durations from REST timestamps, task-status
 * shares, quantile series). The exact visible strings matter — they are the `fmt` output of `Datum`, while `data-yv`
 * always keeps the raw upstream value (see docs/contracts/parity-dom.md).
 */
import { describe, expect, it } from "vitest";
import {
  batchDurationMs,
  epochOf,
  fmtFraction,
  fmtMetric,
  fraction,
  jobDurationMs,
  parseSparkTime,
  quantileMax,
  seriesOf,
  sizeRecords,
  sqlDurationMs,
  stageDurationMs,
  stageProgress,
  stageRowKey,
  stageTaskShares,
  taskInput,
  taskOutput,
  taskRowKey,
  taskShuffleRead,
  taskShuffleWrite,
  totalShuffleReadBytes,
} from "~/features/spark/data/format";
import type { SparkJob, SparkSqlExecution, SparkStage, SparkStreamingBatch, SparkTask } from "~/features/spark/data/schemas";

const job = (over: Partial<SparkJob>): SparkJob => ({ jobId: 0, stageIds: [], jobTags: [], ...over });
// The zod output marks `listOf` fields as always-present arrays; the fixture factory keeps the call sites short.
const stage = (over: Partial<SparkStage>): SparkStage => ({ stageId: 0, rddIds: [], accumulatorUpdates: [], ...over });
const sql = (over: Partial<SparkSqlExecution>): SparkSqlExecution => ({ id: 0, ...over });
const batch = (over: Partial<SparkStreamingBatch>): SparkStreamingBatch => ({ batchId: 0, ...over });
const task = (over: Partial<SparkTask>): SparkTask => ({ taskId: 0, accumulatorUpdates: [], ...over });

describe("parseSparkTime", () => {
  it("parses Spark's GMT-suffixed timestamps to the same epoch as the Z form", () => {
    const gmt = parseSparkTime("2026-10-03T06:49:08.233GMT");
    expect(gmt).toBe(Date.parse("2026-10-03T06:49:08.233Z"));
    expect(gmt).not.toBeNull();
  });

  it("parses the Z form and epoch-number strings", () => {
    expect(parseSparkTime("2026-10-03T06:49:08.233Z")).toBe(Date.parse("2026-10-03T06:49:08.233Z"));
    expect(parseSparkTime("1791010148233")).toBe(1791010148233);
    expect(parseSparkTime("0")).toBe(0);
  });

  it("returns null for null, empty and unparseable input", () => {
    expect(parseSparkTime(null)).toBeNull();
    expect(parseSparkTime(undefined)).toBeNull();
    expect(parseSparkTime("")).toBeNull();
    expect(parseSparkTime("not-a-date")).toBeNull();
  });
});

describe("epochOf", () => {
  it("prefers a positive numeric epoch over the text", () => {
    expect(epochOf(1234, "2026-10-03T06:49:08.233GMT")).toBe(1234);
  });

  it("falls back to parsing the text when the epoch is missing, zero or negative", () => {
    const t = Date.parse("2026-10-03T06:49:08.233Z");
    expect(epochOf(null, "2026-10-03T06:49:08.233GMT")).toBe(t);
    expect(epochOf(0, "2026-10-03T06:49:08.233GMT")).toBe(t);
    expect(epochOf(-5, "2026-10-03T06:49:08.233GMT")).toBe(t);
  });

  it("returns null when neither source is usable", () => {
    expect(epochOf(null, null)).toBeNull();
    expect(epochOf(undefined, "")).toBeNull();
  });
});

describe("durations", () => {
  it("jobDurationMs: completion − submission for finished jobs", () => {
    expect(jobDurationMs(job({ submissionTime: "1000", completionTime: "6000" }))).toBe(5000);
  });

  it("jobDurationMs: now − submission for running jobs", () => {
    expect(jobDurationMs(job({ submissionTime: "1000", completionTime: null }), 10_000)).toBe(9000);
  });

  it("jobDurationMs: null without a submission time, clamped at zero", () => {
    expect(jobDurationMs(job({ submissionTime: null }))).toBeNull();
    expect(jobDurationMs(job({ submissionTime: "6000", completionTime: "1000" }))).toBe(0);
  });

  it("stageDurationMs: falls back to firstTaskLaunchedTime", () => {
    expect(stageDurationMs(stage({ submissionTime: "1000", completionTime: "3000" }))).toBe(2000);
    expect(stageDurationMs(stage({ submissionTime: null, firstTaskLaunchedTime: "2000", completionTime: "5000" }))).toBe(3000);
    expect(stageDurationMs(stage({ submissionTime: null, completionTime: "5000" }))).toBeNull();
  });

  it("sqlDurationMs: the REST duration field wins when non-negative", () => {
    expect(sqlDurationMs(sql({ duration: 42, submissionTime: "1000", completionTime: "9999" }))).toBe(42);
  });

  it("sqlDurationMs: computes from timestamps when duration is absent or negative, else null", () => {
    expect(sqlDurationMs(sql({ duration: null, submissionTime: "1000", completionTime: "4000" }))).toBe(3000);
    expect(sqlDurationMs(sql({ duration: -1, submissionTime: "1000", completionTime: "4000" }))).toBe(3000);
    expect(sqlDurationMs(sql({ duration: null, submissionTime: null, completionTime: "4000" }))).toBeNull();
  });

  it("batchDurationMs: returns processingTime, null without timing information", () => {
    expect(batchDurationMs(batch({ batchTime: "1000", processingTime: 250 }))).toBe(250);
    expect(batchDurationMs(batch({ batchTime: null, processingTime: null }))).toBeNull();
    expect(batchDurationMs(batch({ batchTime: "1000", processingTime: null }))).toBeNull();
  });
});

describe("stageTaskShares", () => {
  it("yields percentages that sum to 100 with pending absorbing the remainder", () => {
    const shares = stageTaskShares({ numTasks: 10, numCompleteTasks: 4, numActiveTasks: 2, numFailedTasks: 1, numKilledTasks: 1 });
    expect(shares).toEqual({ complete: 40, active: 20, failed: 0, killed: 0, pending: 40 });
    expect(shares.complete + shares.active + shares.failed + shares.killed + shares.pending).toBe(100);
  });

  it("never exceeds 100 and returns zeros for an unknown task total", () => {
    const over = stageTaskShares({ numTasks: 4, numCompleteTasks: 5, numActiveTasks: 5, numFailedTasks: 0, numKilledTasks: 0 });
    expect(over.pending).toBe(0);
    expect(over.complete).toBe(100);
    expect(over.active).toBe(0);
    const zero = stageTaskShares({ numTasks: 0 });
    expect(zero).toEqual({ complete: 0, active: 0, failed: 0, killed: 0, pending: 0 });
  });

  it("treats missing counters as zero", () => {
    expect(stageTaskShares({ numTasks: 8, numCompleteTasks: 2 }).pending).toBeCloseTo(75);
  });
});

describe("stageProgress", () => {
  it("is 100 for COMPLETE and SKIPPED regardless of counters", () => {
    expect(stageProgress(stage({ status: "COMPLETE", numTasks: 4, numCompleteTasks: 0 }))).toBe(100);
    expect(stageProgress(stage({ status: "SKIPPED", numTasks: 4 }))).toBe(100);
  });

  it("counts completed partitions without advancing for retry failures", () => {
    expect(stageProgress(stage({ status: "ACTIVE", numTasks: 10, numCompleteTasks: 2, numFailedTasks: 1, numKilledTasks: 1 }))).toBe(20);
  });

  it("prefers distinct completed indices over task attempts", () => {
    expect(stageProgress(stage({ status: "ACTIVE", numTasks: 10, numCompleteTasks: 8, numCompletedIndices: 3, numFailedTasks: 7 }))).toBe(
      30,
    );
    expect(stageTaskShares({ numTasks: 4, numCompleteTasks: 5, numCompletedIndices: 2, numActiveTasks: 4, numFailedTasks: 9 })).toEqual({
      complete: 50,
      active: 50,
      failed: 0,
      killed: 0,
      pending: 0,
    });
  });

  it("is 0 while the task total is unknown", () => {
    expect(stageProgress(stage({ status: "PENDING", numTasks: 0, numCompleteTasks: 3 }))).toBe(0);
  });
});

describe("fraction / fmtFraction", () => {
  it("formats a 0..1 fraction as a one-decimal percentage", () => {
    expect(fmtFraction(1, 4)).toBe("25.0%");
    expect(fmtFraction(1, 3, 2)).toBe("33.33%");
  });

  it("returns the dash when the whole is missing, zero or negative", () => {
    expect(fmtFraction(1, 0)).toBe("—");
    expect(fmtFraction(1, -2)).toBe("—");
    expect(fmtFraction(null, 4)).toBe("—");
    expect(fmtFraction(undefined, undefined)).toBe("—");
  });

  it("fraction returns the raw ratio or null", () => {
    expect(fraction(1, 4)).toBe(0.25);
    expect(fraction(1, 0)).toBeNull();
    expect(fraction(null, 4)).toBeNull();
  });
});

describe("sizeRecords", () => {
  it("formats bytes and records with the shared units", () => {
    expect(sizeRecords(1024, 3)).toBe("1 KiB / 3");
    expect(sizeRecords(2048, 3456)).toBe("2 KiB / 3,456");
  });

  it("uses the dash for a missing half and when both are missing", () => {
    expect(sizeRecords(2048, null)).toBe("2 KiB / —");
    expect(sizeRecords(null, 12)).toBe("— / 12");
    expect(sizeRecords(null, null)).toBe("—");
  });
});

describe("quantiles", () => {
  it("seriesOf pairs the shortest of the two arrays", () => {
    expect(seriesOf([0.05, 0.5, 0.95], [1, 2, 3])).toEqual({ quantiles: [0.05, 0.5, 0.95], values: [1, 2, 3] });
    expect(seriesOf([0.05, 0.5, 0.95], [1, 2])).toEqual({ quantiles: [0.05, 0.5], values: [1, 2] });
  });

  it("seriesOf is null without quantiles or without values", () => {
    expect(seriesOf(null, [1, 2])).toBeNull();
    expect(seriesOf([0.5], [])).toBeNull();
    expect(seriesOf([0.5], null)).toBeNull();
  });

  it("quantileMax returns the largest finite value, ignoring NaN", () => {
    expect(quantileMax([1, 5, 3])).toBe(5);
    expect(quantileMax([1, Number.NaN, 3])).toBe(3);
    expect(quantileMax([])).toBeNull();
    expect(quantileMax(null)).toBeNull();
  });
});

describe("fmtMetric", () => {
  it("dispatches on the unit", () => {
    expect(fmtMetric(1500, "ms")).toBe("1s");
    expect(fmtMetric(2048, "bytes")).toBe("2 KiB");
    expect(fmtMetric(1234, "count")).toBe("1,234");
  });

  it("returns the dash for a missing value", () => {
    expect(fmtMetric(null, "ms")).toBe("—");
    expect(fmtMetric(undefined, "bytes")).toBe("—");
  });
});

describe("task metric accessors", () => {
  it("taskInput reads InputMetrics only", () => {
    expect(taskInput(task({ taskMetrics: { inputMetrics: { bytesRead: 100, recordsRead: 5 } } }))).toEqual({ bytes: 100, records: 5 });
    expect(taskInput(task({ taskMetrics: null }))).toEqual({ bytes: null, records: null });
    expect(taskInput(task({}))).toEqual({ bytes: null, records: null });
  });

  it("taskShuffleRead sums local + remote, null when neither is reported", () => {
    expect(
      taskShuffleRead(task({ taskMetrics: { shuffleReadMetrics: { localBytesRead: 10, remoteBytesRead: 20, recordsRead: 3 } } })),
    ).toEqual({
      bytes: 30,
      records: 3,
    });
    expect(taskShuffleRead(task({ taskMetrics: { shuffleReadMetrics: { localBytesRead: null, remoteBytesRead: 5 } } }))).toEqual({
      bytes: 5,
      records: null,
    });
    expect(taskShuffleRead(task({ taskMetrics: { shuffleReadMetrics: {} } }))).toEqual({ bytes: null, records: null });
  });

  it("totalShuffleReadBytes matches taskShuffleRead bytes", () => {
    const t = task({ taskMetrics: { shuffleReadMetrics: { localBytesRead: 10, remoteBytesRead: 20 } } });
    expect(totalShuffleReadBytes(t)).toBe(30);
    expect(totalShuffleReadBytes(task({ taskMetrics: null }))).toBeNull();
  });

  it("taskShuffleWrite and taskOutput read their metric blocks", () => {
    expect(taskShuffleWrite(task({ taskMetrics: { shuffleWriteMetrics: { bytesWritten: 7, recordsWritten: 2 } } }))).toEqual({
      bytes: 7,
      records: 2,
    });
    expect(taskOutput(task({ taskMetrics: { outputMetrics: { bytesWritten: 9, recordsWritten: 4 } } }))).toEqual({ bytes: 9, records: 4 });
    expect(taskShuffleWrite(task({}))).toEqual({ bytes: null, records: null });
    expect(taskOutput(task({}))).toEqual({ bytes: null, records: null });
  });
});

describe("row keys", () => {
  it("taskRowKey keys on taskId + attempt (attempt defaults to 0)", () => {
    expect(taskRowKey(task({ taskId: 3 }))).toBe("3-0");
    expect(taskRowKey(task({ taskId: 3, attempt: 2 }))).toBe("3-2");
  });

  it("stageRowKey keys on stageId + attemptId (attempt defaults to 0)", () => {
    expect(stageRowKey(stage({ stageId: 5 }))).toBe("5/0");
    expect(stageRowKey(stage({ stageId: 5, attemptId: 1 }))).toBe("5/1");
  });
});
