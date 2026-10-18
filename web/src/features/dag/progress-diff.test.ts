/** The DAG-diff animation state machine: entering/exiting nodes, tween choice, jump detection, failure flashes. */
import { describe, expect, it } from "vitest";
import {
  FLASH_MS,
  JUMP_PP,
  JUMP_TWEEN_MS,
  TWEEN_MIN_PP,
  TWEEN_MS,
  accumulateTotals,
  diffProgress,
  stageVisual,
  weightedPercent,
} from "./progress-diff";
import type { StageVisual } from "./progress-diff";
import type { StageStatus } from "./metrics";

const v = (percent: number, status: StageStatus = "ACTIVE", failed = 0): StageVisual => ({ percent, status, failed });

describe("diffProgress", () => {
  it("reports unchanged nodes without scheduling any work", () => {
    const plan = diffProgress(["a", "b"], new Map([["a", v(10)]]), new Map([["a", v(10)]]));
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toEqual(["a"]);
  });

  it("ignores sub-threshold wobble but still counts it as changed when the status moves", () => {
    const tiny = diffProgress(["a"], new Map([["a", v(10)]]), new Map([["a", v(11)]]));
    expect(tiny.updates).toEqual([]);
    const statusOnly = diffProgress(["a"], new Map([["a", v(10, "ACTIVE")]]), new Map([["a", v(10, "COMPLETE")]]));
    expect(statusOnly.updates).toHaveLength(1);
    expect(statusOnly.updates[0]!.statusChanged).toBe(true);
    expect(statusOnly.updates[0]!.flash).toBe("ok");
  });

  it("tweens a normal delta and a jump with the longer duration", () => {
    const normal = diffProgress(["a"], new Map([["a", v(10)]]), new Map([["a", v(10 + TWEEN_MIN_PP + 1)]]));
    expect(normal.updates[0]!.tweenMs).toBe(TWEEN_MS);
    expect(normal.updates[0]!.jump).toBe(false);
    const jump = diffProgress(["a"], new Map([["a", v(10)]]), new Map([["a", v(10 + JUMP_PP + 1)]]));
    expect(jump.updates[0]!.tweenMs).toBe(JUMP_TWEEN_MS);
    expect(jump.updates[0]!.jump).toBe(true);
  });

  it("flashes a new node and reports its status as changed", () => {
    const plan = diffProgress(["a"], new Map(), new Map([["a", v(50)]]));
    expect(plan.updates[0]).toMatchObject({ id: "a", fromPercent: 0, toPercent: 50, jump: true, flash: "live" });
  });

  it("flags entering nodes that are not in the order list", () => {
    const plan = diffProgress(
      ["a"],
      new Map([["a", v(1)]]),
      new Map([
        ["a", v(1)],
        ["b", v(0)],
      ]),
    );
    expect(plan.entering).toEqual(["b"]);
  });

  it("flags exiting nodes", () => {
    const plan = diffProgress(
      ["a", "b"],
      new Map([
        ["a", v(1)],
        ["b", v(1)],
      ]),
      new Map([["a", v(1)]]),
    );
    expect(plan.exiting).toEqual(["b"]);
  });

  it("flashes fail when a task failure appears or a stage fails", () => {
    const failureAppears = diffProgress(["a"], new Map([["a", v(30, "ACTIVE", 0)]]), new Map([["a", v(30, "ACTIVE", 1)]]));
    expect(failureAppears.updates[0]!.flash).toBe("fail");
    const stageFails = diffProgress(["a"], new Map([["a", v(30, "ACTIVE")]]), new Map([["a", v(30, "FAILED", 1)]]));
    expect(stageFails.updates[0]!.flash).toBe("fail");
  });

  it("is deterministic in update order (graph order wins)", () => {
    const prev = new Map([
      ["b", v(0)],
      ["a", v(0)],
    ]);
    const next = new Map([
      ["b", v(50)],
      ["a", v(50)],
    ]);
    const plan = diffProgress(["a", "b"], prev, next);
    expect(plan.updates.map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("does not tween a pure status change at identical progress", () => {
    const plan = diffProgress(["a"], new Map([["a", v(100, "ACTIVE")]]), new Map([["a", v(100, "COMPLETE")]]));
    expect(plan.updates[0]!.tweenMs).toBe(0);
  });
});

describe("totals", () => {
  it("accumulates task counts and weights the percentage by tasks", () => {
    const totals = accumulateTotals([
      { numTasks: 10, numCompleteTasks: 5, numActiveTasks: 2, numFailedTasks: 1 },
      { numTasks: 30, numCompleteTasks: 30, numActiveTasks: 0, numFailedTasks: 0 },
    ]);
    expect(totals).toEqual({ done: 35, total: 40, active: 2, failed: 1 });
    expect(weightedPercent(totals)).toBeCloseTo(87.5, 6);
    expect(weightedPercent({ done: 0, total: 0, active: 0, failed: 0 })).toBe(0);
  });

  it("builds a StageVisual tuple from segments", () => {
    const [id, visual] = stageVisual("n1", { total: 4, done: 2, active: 1, failed: 1, killed: 0, pending: 0, percent: 50 }, "ACTIVE");
    expect(id).toBe("n1");
    expect(visual).toEqual({ percent: 50, status: "ACTIVE", failed: 1 });
  });

  it("exposes the token-matching constants the UI relies on", () => {
    expect(TWEEN_MS).toBe(420);
    expect(JUMP_TWEEN_MS).toBeGreaterThan(TWEEN_MS);
    expect(FLASH_MS).toBeGreaterThan(0);
    expect(JUMP_PP).toBeGreaterThan(TWEEN_MIN_PP);
  });
});
