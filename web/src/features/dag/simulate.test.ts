import { describe, expect, it } from "vitest";
import { createSimulator, pendingMetrics, simulatedCompletion, syntheticDag } from "./simulate";

describe("synthetic DAGs", () => {
  it("keeps generation deterministic and applies stage flags and minimum node counts", () => {
    const options = { stages: 12, nodesPerStage: 0, skipEvery: 3, seed: 19 };
    const first = syntheticDag(options);
    const second = syntheticDag(options);

    expect(first).toEqual(second);
    expect(first.stages.every((stage) => stage.nodes.length >= 2)).toBe(true);
    expect(first.stages.some((stage) => stage.skipped && stage.status === "SKIPPED")).toBe(true);
    expect(first.stages.some((stage) => stage.nodes.some((node) => node.cached))).toBe(true);
    expect(first.stages.some((stage) => stage.nodes.some((node) => node.barrier))).toBe(true);
    expect(first.stages.some((stage) => stage.nodes.some((node) => node.determinism === "determinate"))).toBe(true);
    expect(first.stages.some((stage) => stage.nodes.some((node) => node.determinism === "unordered"))).toBe(true);
    expect(first.edges).toHaveLength(first.stages.length - 1);
  });

  it("handles an empty graph without inventing progress", () => {
    const dag = syntheticDag({ stages: 0, nodesPerStage: 0 });
    const sim = createSimulator(dag);

    expect(dag.stages).toEqual([]);
    expect(dag.edges).toEqual([]);
    expect(sim.totalMs).toBe(1500);
    expect(pendingMetrics(sim)).toEqual([]);
    expect(simulatedCompletion(sim, 10_000)).toBe(0);
  });
});

describe("progress simulation", () => {
  it("reports pending, active, skipped, completed, and failed stages with task metrics", () => {
    const dag = syntheticDag({ stages: 3, nodesPerStage: 3, skipEvery: 2, seed: 8 });
    const sim = createSimulator(dag, {
      failStage: 1,
      parallelism: 2,
      msPerTask: 100,
      staggerMs: 25,
      totalMs: 1,
      seed: 31,
    });
    const stage0 = sim.plans.get(0)!;
    const stage1 = sim.plans.get(1)!;

    expect(sim.totalMs).toBeGreaterThanOrEqual(1000);
    expect(pendingMetrics(sim).map((metric) => metric.status)).toEqual(["ACTIVE", "PENDING", "SKIPPED"]);

    const inProgress = sim.at(stage1.startMs + 10);
    expect(inProgress[1]).toMatchObject({ stageId: 1, status: "ACTIVE" });
    expect(inProgress[2]).toMatchObject({ stageId: 2, status: "SKIPPED", numTasks: 0 });

    const complete = sim.at(stage0.endMs)[0]!;
    expect(complete.status).toBe("COMPLETE");
    expect(complete.numCompleteTasks).toBe(complete.numTasks);
    expect(complete.inputBytes).toBeGreaterThan(0);
    expect(complete.shuffleReadBytes).toBeGreaterThan(0);
    expect(complete.memoryBytesSpilled).not.toBeNull();
    expect(sim.at(stage1.endMs)[1]).toMatchObject({ status: "FAILED", numFailedTasks: 1 });
    expect(simulatedCompletion(sim, sim.totalMs)).toBeGreaterThan(0);
  });

  it("clamps negative elapsed time and handles a job containing only skipped stages", () => {
    const dag = syntheticDag({ stages: 2, nodesPerStage: 2, skipEvery: 1 });
    const sim = createSimulator(dag, { staggerMs: 0 });
    expect(sim.at(-500).map((metric) => metric.status)).toEqual(["ACTIVE", "SKIPPED"]);

    const base = syntheticDag({ stages: 3, nodesPerStage: 2 });
    const onlySkipped = createSimulator({ ...base, stages: base.stages.map((stage) => ({ ...stage, skipped: true })) });
    expect(simulatedCompletion(onlySkipped, onlySkipped.totalMs)).toBe(0);
  });
});
