/**
 * Stage metrics + status mapping. Uses the *captured* REST stage rows (`rest/final.stages.details.json`) so the field
 * names and value ranges are real, never invented.
 */
import { describe, expect, it } from "vitest";
import {
  flowByProducer,
  flowReading,
  indexStageMetrics,
  normalizeStageStatus,
  parseSparkTime,
  progressSegments,
  stageDuration,
  stageMetricsFromRest,
  stageProgress,
  stageStatusKey,
  stageTone,
  toStageMetric,
} from "./metrics";
import type { StageMetric } from "./metrics";
import { readCapturedStages } from "./testing/fixtures.node";

const captured = readCapturedStages("4.2.0", "big-dag");
const metrics = stageMetricsFromRest(captured);

describe("stageMetricsFromRest", () => {
  it("parses the captured 4.2.0 payload into normalised rows", () => {
    expect(metrics.length).toBeGreaterThan(5);
    for (const m of metrics) {
      expect(Number.isFinite(m.stageId)).toBe(true);
      expect(m.status).not.toBe("UNKNOWN");
      expect(m.raw).toBeTypeOf("object");
    }
  });

  it("accepts an array, a {stages:[]} wrapper and a single row", () => {
    const row = { stageId: 3, status: "COMPLETE", numTasks: 2, numCompleteTasks: 2 };
    expect(stageMetricsFromRest([row])).toHaveLength(1);
    expect(stageMetricsFromRest({ stages: [row] })).toHaveLength(1);
    expect(stageMetricsFromRest(row)).toHaveLength(1);
    expect(stageMetricsFromRest(null)).toEqual([]);
    expect(stageMetricsFromRest("nonsense")).toEqual([]);
    expect(stageMetricsFromRest({})).toEqual([]);
  });

  it("drops rows without a stage id instead of inventing one", () => {
    expect(stageMetricsFromRest([{ status: "COMPLETE" }])).toEqual([]);
  });

  it("keeps 'not reported' distinct from zero", () => {
    const m = toStageMetric({ stageId: 1, inputBytes: -1, outputBytes: 0, resultSize: null })!;
    expect(m.inputBytes).toBeNull();
    expect(m.outputBytes).toBe(0);
    expect(m.resultSize).toBeNull();
  });

  it("indexes by stage id, latest attempt winning", () => {
    const index = indexStageMetrics([
      { ...mk(1, 0), numCompleteTasks: 1 },
      { ...mk(1, 1), numCompleteTasks: 2 },
      { ...mk(2, 0), numCompleteTasks: 0 },
    ]);
    expect(index.get(1)?.numCompleteTasks).toBe(2);
    expect(index.get(2)?.numCompleteTasks).toBe(0);
  });
});

function mk(stageId: number, attemptId: number): StageMetric {
  return {
    stageId,
    attemptId,
    status: "ACTIVE",
    numTasks: 4,
    numActiveTasks: 1,
    numCompleteTasks: 1,
    numFailedTasks: 0,
    numKilledTasks: 0,
    submissionTime: 1000,
    firstTaskLaunchedTime: 1000,
    completionTime: null,
    inputBytes: null,
    inputRecords: null,
    outputBytes: null,
    outputRecords: null,
    shuffleReadBytes: null,
    shuffleWriteBytes: null,
    shuffleReadRecords: null,
    shuffleWriteRecords: null,
    shuffleFetchWaitTime: null,
    memoryBytesSpilled: null,
    diskBytesSpilled: null,
    executorRunTime: null,
    executorDeserializeTime: null,
    resultSerializationTime: null,
    resultSize: null,
    jvmGcTime: null,
    peakExecutionMemory: null,
    raw: {},
  };
}

describe("status normalisation", () => {
  it("maps known statuses case-insensitively and degrades the rest", () => {
    expect(normalizeStageStatus("complete")).toBe("COMPLETE");
    expect(normalizeStageStatus("Skipped")).toBe("SKIPPED");
    expect(normalizeStageStatus("WEIRD")).toBe("UNKNOWN");
    expect(normalizeStageStatus(null)).toBe("UNKNOWN");
  });

  it("prefers the payload's own status when REST has none", () => {
    expect(stageStatusKey(undefined, true)).toBe("SKIPPED");
    expect(stageStatusKey(undefined, false)).toBe("PENDING");
    expect(stageStatusKey(mk(1, 0), false)).toBe("ACTIVE");
  });

  it("maps status to a tone, keeping failed counts visible on running stages", () => {
    expect(stageTone(undefined, true)).toBe("idle");
    expect(stageTone(mk(1, 0), false)).toBe("live");
    expect(stageTone({ ...mk(1, 0), numFailedTasks: 1 }, false)).toBe("warn");
    expect(stageTone({ ...mk(1, 0), status: "COMPLETE" }, false)).toBe("ok");
    expect(stageTone({ ...mk(1, 0), status: "FAILED" }, false)).toBe("fail");
    expect(stageTone({ ...mk(1, 0), status: "PENDING" }, false)).toBe("wait");
  });
});

describe("timestamps", () => {
  it("parses Spark's GMT spelling, epoch millis and numeric strings", () => {
    expect(parseSparkTime("2026-10-03T06:50:15.695GMT")).toBe(Date.parse("2026-10-03T06:50:15.695Z"));
    expect(parseSparkTime(1_767_225_600_000)).toBe(1_767_225_600_000);
    expect(parseSparkTime("1767225600000")).toBe(1_767_225_600_000);
  });

  it("returns null for absent or nonsensical values", () => {
    expect(parseSparkTime(null)).toBeNull();
    expect(parseSparkTime("")).toBeNull();
    expect(parseSparkTime("-")).toBeNull();
    expect(parseSparkTime(0)).toBeNull();
    expect(parseSparkTime(-5)).toBeNull();
    expect(parseSparkTime("not a date")).toBeNull();
  });
});

describe("progress", () => {
  it("computes counts, pending remainder and percent", () => {
    const p = stageProgress({ ...mk(1, 0), numTasks: 10, numCompleteTasks: 4, numActiveTasks: 2, numFailedTasks: 1, numKilledTasks: 1 });
    expect(p).toEqual({ total: 10, done: 4, active: 2, failed: 1, killed: 1, pending: 4, percent: 40 });
  });

  it("clamps nonsense counts to zero rather than producing a negative bar", () => {
    const p = stageProgress({ ...mk(1, 0), numTasks: 4, numCompleteTasks: 9, numActiveTasks: 2 });
    expect(p.pending).toBe(0);
    expect(p.percent).toBe(100);
  });

  it("treats a completed zero-task stage as 100%", () => {
    expect(stageProgress({ ...mk(1, 0), status: "COMPLETE", numTasks: 0, numCompleteTasks: 0 }).percent).toBe(100);
  });

  it("builds bar segments in a stable order and drops empty ones", () => {
    const segs = progressSegments(stageProgress({ ...mk(1, 0), numTasks: 8, numCompleteTasks: 4, numActiveTasks: 2, numFailedTasks: 1 }));
    expect(segs.map((s) => s.tone)).toEqual(["ok", "live", "wait"]);
    expect(segs.map((s) => s.percent).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(segs[0]?.label).toBe("4 completed");
  });

  it("summarises duration from submission to completion or now", () => {
    const active = mk(1, 0);
    active.submissionTime = 1000;
    expect(stageDuration(active, 3500)).toBe(2500);
    expect(stageDuration({ ...active, completionTime: 2000 }, 9000)).toBe(1000);
    expect(stageDuration({ ...active, submissionTime: null, firstTaskLaunchedTime: null }, 9000)).toBeNull();
    expect(stageDuration(undefined, 9000)).toBeNull();
  });

  it("sizes the captured goldens' bars against their own task counts", () => {
    const index = indexStageMetrics(metrics);
    for (const m of index.values()) {
      const p = stageProgress(m);
      expect(p.done + p.active + p.pending).toBe(p.total);
      expect(p.percent).toBeGreaterThanOrEqual(0);
      expect(p.percent).toBeLessThanOrEqual(100);
    }
  });

  it("counts distinct completed partitions and keeps retry failures out of the progress track", () => {
    const metric = toStageMetric({
      stageId: 1,
      status: "ACTIVE",
      numTasks: 10,
      numCompletedIndices: 4,
      numCompleteTasks: 8,
      numActiveTasks: 3,
      numFailedTasks: 14,
      numKilledTasks: 2,
    })!;
    const progress = stageProgress(metric);
    expect(progress).toEqual({ total: 10, done: 4, active: 3, failed: 14, killed: 2, pending: 3, percent: 40 });
    expect(progressSegments(progress).map((segment) => segment.percent)).toEqual([40, 30, 30]);
  });
});

describe("flow", () => {
  const before = mk(1, 0);
  const after = { ...mk(1, 0), numCompleteTasks: 3, numActiveTasks: 1 };

  it("only flows while the producer is active", () => {
    expect(flowReading(before, { ...after, status: "COMPLETE" }, false, 1000).active).toBe(false);
    expect(flowReading(before, { ...after, status: "PENDING" }, false, 1000).active).toBe(false);
    expect(flowReading(before, after, false, 1000).active).toBe(true);
    expect(flowReading(before, after, true, 1000).active).toBe(false);
    expect(flowReading(before, after, false, 0).active).toBe(false);
  });

  it("scales intensity with the completed-task rate, saturating", () => {
    const slow = flowReading(before, { ...after, numCompleteTasks: 2 }, false, 4000);
    const fast = flowReading(before, { ...after, numCompleteTasks: 40 }, false, 1000);
    expect(slow.intensity).toBeGreaterThan(0);
    expect(fast.intensity).toBeGreaterThan(slow.intensity);
    expect(fast.intensity).toBeLessThanOrEqual(1);
  });

  it("never flows for a stage with no active tasks and no progress", () => {
    const stalled = { ...mk(1, 0), numActiveTasks: 0, numCompleteTasks: 0 };
    expect(flowReading(before, stalled, false, 1000).active).toBe(false);
  });

  it("keys readings by producer node id", () => {
    const map = flowByProducer(
      [
        { id: "st.1.0", stageId: 1 },
        { id: "st.2.0", stageId: 2 },
        { id: "st.3.0", stageId: 3, skipped: true },
      ],
      new Map([
        [1, after],
        [2, { ...after, status: "COMPLETE" }],
        [3, after],
      ]),
      new Map([[1, before]]),
      1000,
    );
    expect(map.get("st.1.0")?.active).toBe(true);
    expect(map.get("st.2.0")?.active).toBe(false);
    expect(map.get("st.3.0")?.active).toBe(false);
  });
});
