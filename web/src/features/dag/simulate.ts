/**
 * Deterministic synthetic DAG + progress simulation.
 *
 * Two jobs:
 *  1. the review route needs *realistic* live behaviour (stages starting in dependency order, tasks completing at a
 *     plausible rate, shuffle bytes growing, one stage failing) without a cluster;
 *  2. the perf test needs a 300+ node graph and an active progress stream that is reproducible frame to frame.
 *
 * Therefore everything here is a pure function of (graph, elapsed milliseconds, config) — no timers, no randomness at
 * call time. `syntheticDag` is generated, not captured, and never pretends to be a fixture.
 */
import type { Dag, DagEdge, DagNode, DagStage } from "./types";
import type { StageMetric } from "./metrics";

export interface SyntheticOptions {
  /** number of stages */
  stages: number;
  /** RDDs per stage (a stage's operator chain) */
  nodesPerStage: number;
  /** every Nth stage is skipped (Spark's "no shuffle needed" stage) */
  skipEvery?: number;
  /** stage index that ends FAILED, or null for an all-green run */
  failStage?: number | null;
  /** deterministic seed for per-stage task counts */
  seed?: number;
}

/** Small deterministic PRNG (mulberry32) — stable across engines, unlike Math.random. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A job DAG shaped like a real multi-stage pipeline: chains inside stages, one shuffle edge between neighbours. */
export function syntheticDag(opts: SyntheticOptions): Dag {
  const { stages, nodesPerStage, skipEvery = 7, failStage = null, seed = 20261003 } = opts;
  const rand = rng(seed);
  const outStages: DagStage[] = [];
  const crossEdges: DagEdge[] = [];
  let rddId = 100;
  for (let s = 0; s < stages; s++) {
    const nodes: DagNode[] = [];
    const edges: DagEdge[] = [];
    const clusters = [
      { id: `cluster_${s}_a`, name: `scope ${s} · read`, parentId: null },
      { id: `cluster_${s}_b`, name: `scope ${s} · codegen`, parentId: null },
    ];
    const perStage = Math.max(2, Math.round(nodesPerStage * (0.6 + rand() * 0.8)));
    for (let n = 0; n < perStage; n++) {
      const id = rddId++;
      const inSecondScope = n > Math.floor(perStage / 2);
      const names = ["ParallelCollectionRDD", "MapPartitionsRDD", "PythonRDD", "PairwiseRDD", "ShuffledRDD"];
      nodes.push({
        id,
        name: names[(s + n) % names.length]!,
        callsite: `synthetic workload at stage_${s}.py:${10 + n}`,
        cached: n === 1 && s % 4 === 0,
        clusterId: inSecondScope ? `cluster_${s}_b` : `cluster_${s}_a`,
        barrier: s % 11 === 3 && n === perStage - 1,
        determinism: n % 3 === 0 ? "determinate" : "unordered",
      });
      if (n > 0) edges.push({ from: id - 1, to: id });
    }
    const skipped = skipEvery > 0 && s > 0 && s % skipEvery === 0;
    outStages.push({
      stageId: s,
      attempt: 0,
      skipped,
      label: `Stage ${s}`,
      status: skipped ? "SKIPPED" : undefined,
      clusters,
      nodes,
      edges,
    });
  }
  // Chain the stages: the last RDD of stage s feeds the first RDD of stage s+1.
  for (let s = 1; s < stages; s++) {
    const prev = outStages[s - 1];
    const cur = outStages[s];
    const from = prev?.nodes[prev.nodes.length - 1]?.id;
    const to = cur?.nodes[0]?.id;
    if (from == null || to == null) continue;
    crossEdges.push({ from, to, fromStage: prev?.stageId, toStage: cur?.stageId });
  }
  void failStage;
  return { kind: "job", granularity: "rdd", jobId: 0, stages: outStages, edges: crossEdges };
}

export interface ProgressConfig {
  /** ms one task takes (each stage parallelises `parallelism` tasks) */
  msPerTask: number;
  /** concurrent tasks per stage */
  parallelism: number;
  /** how long after a stage's first task starts its *next* stage may begin (0 = strict dependency) */
  staggerMs: number;
  failStage: number | null;
  seed: number;
  /** total wall-clock length of the simulated job */
  totalMs: number;
}

export const DEFAULT_PROGRESS: ProgressConfig = {
  msPerTask: 90,
  parallelism: 4,
  staggerMs: 0,
  failStage: null,
  seed: 20261003,
  totalMs: 22_000,
};

/** Per-stage plan derived once: task count, start offset, failure point. */
interface StagePlan {
  stageId: number;
  attempt: number;
  numTasks: number;
  startMs: number;
  endMs: number;
  skipped: boolean;
  failed: boolean;
  failTaskIndex: number;
  shuffleWriteBytes: number;
  shuffleReadBytes: number;
  inputBytes: number;
}

export interface Simulator {
  dag: Dag;
  config: ProgressConfig;
  plans: Map<number, StagePlan>;
  /** total simulated length in ms */
  totalMs: number;
  /** metrics at a given elapsed time (pure) */
  at(elapsedMs: number): StageMetric[];
}

const ISO = (ms: number) => new Date(ms).toISOString().replace("Z", "GMT");

/** Build the plan: stage lengths follow their task counts so the cascade looks uneven, like a real job. */
export function createSimulator(dag: Dag, config: Partial<ProgressConfig> = {}): Simulator {
  const cfg: ProgressConfig = { ...DEFAULT_PROGRESS, ...config };
  const rand = rng(cfg.seed);
  const plans = new Map<number, StagePlan>();
  const ordered = [...dag.stages].sort((a, b) => a.stageId - b.stageId);
  const budget = Math.max(1000, cfg.totalMs);
  const perStage = budget / Math.max(1, ordered.length);
  let start = 0;
  for (const s of ordered) {
    const numTasks = s.skipped ? 0 : Math.max(2, Math.round(2 + rand() * 6));
    const waves = Math.ceil(numTasks / Math.max(1, cfg.parallelism));
    const span = s.skipped ? perStage * 0.15 : Math.max(cfg.msPerTask, waves * cfg.msPerTask);
    const failed = cfg.failStage === s.stageId;
    const end = start + span;
    plans.set(s.stageId, {
      stageId: s.stageId,
      attempt: s.attempt ?? 0,
      numTasks,
      startMs: start,
      endMs: failed ? start + span * 0.6 : end,
      skipped: s.skipped,
      failed,
      failTaskIndex: failed ? Math.max(1, Math.floor(numTasks / 2)) : -1,
      shuffleWriteBytes: Math.round(rand() * 40_000_000),
      shuffleReadBytes: Math.round(rand() * 12_000_000),
      inputBytes: Math.round(rand() * 120_000_000),
    });
    // Skipped stages are instant, so they must not consume a slot in the cascade.
    start = s.skipped ? end : end + cfg.staggerMs;
  }
  const totalMs = Math.max(1000, start + 1500);
  const at = (elapsedMs: number): StageMetric[] => {
    const out: StageMetric[] = [];
    for (const s of ordered) {
      const p = plans.get(s.stageId);
      if (!p) continue;
      const t = Math.max(0, elapsedMs);
      let status: StageMetric["status"];
      let done = 0;
      let active = 0;
      let failed = 0;
      if (p.skipped) {
        status = "SKIPPED";
      } else if (t < p.startMs) {
        status = "PENDING";
      } else if (t >= p.endMs) {
        status = p.failed ? "FAILED" : "COMPLETE";
        done = p.failed ? p.failTaskIndex - 1 : p.numTasks;
        failed = p.failed ? 1 : 0;
      } else {
        status = "ACTIVE";
        const steps = Math.floor((t - p.startMs) / cfg.msPerTask);
        done = Math.min(p.numTasks, steps * cfg.parallelism);
        active = Math.min(cfg.parallelism, p.numTasks - done);
        if (p.failed && done + active >= p.failTaskIndex) {
          done = p.failTaskIndex - 1;
          active = 0;
          failed = 1;
        }
      }
      const progress = p.numTasks > 0 ? done / p.numTasks : 0;
      out.push({
        stageId: p.stageId,
        attemptId: p.attempt,
        status,
        numTasks: p.numTasks,
        numActiveTasks: active,
        numCompleteTasks: done,
        numFailedTasks: failed,
        numKilledTasks: 0,
        submissionTime: status === "PENDING" ? null : Date.parse(ISO(0)) + p.startMs,
        firstTaskLaunchedTime: status === "PENDING" ? null : Date.parse(ISO(0)) + p.startMs,
        completionTime: status === "COMPLETE" || status === "FAILED" ? Date.parse(ISO(0)) + p.endMs : null,
        inputBytes: progress > 0 ? p.inputBytes : null,
        inputRecords: progress > 0 ? Math.round(p.inputBytes / 64) : null,
        outputBytes: progress > 0 ? Math.round(p.inputBytes * 0.6) : null,
        outputRecords: progress > 0 ? Math.round(p.inputBytes / 128) : null,
        shuffleReadBytes: progress > 0 ? p.shuffleReadBytes : null,
        shuffleWriteBytes: progress > 0 ? p.shuffleWriteBytes : null,
        shuffleReadRecords: progress > 0 ? Math.round(p.shuffleReadBytes / 220) : null,
        shuffleWriteRecords: progress > 0 ? Math.round(p.shuffleWriteBytes / 220) : null,
        shuffleFetchWaitTime: progress > 0 ? Math.round(progress * 320) : null,
        memoryBytesSpilled: p.stageId % 5 === 0 && progress > 0.3 ? Math.round(progress * 1_500_000) : null,
        diskBytesSpilled: p.stageId % 9 === 0 && progress > 0.5 ? Math.round(progress * 400_000) : null,
        executorRunTime: progress > 0 ? Math.round(progress * p.numTasks * cfg.msPerTask * 0.8) : null,
        executorDeserializeTime: progress > 0 ? Math.round(progress * 12) : null,
        resultSerializationTime: progress > 0 ? Math.round(progress * 8) : null,
        resultSize: progress > 0 ? Math.round(progress * 4_000) : null,
        jvmGcTime: progress > 0 ? Math.round(progress * 30) : null,
        peakExecutionMemory: progress > 0 ? Math.round(progress * 2_000_000) : null,
        raw: { synthetic: true, stageId: p.stageId, status },
      });
    }
    return out;
  };
  return { dag, config: cfg, plans, totalMs, at };
}

/** Metrics as if the job had just been submitted: every stage PENDING, nothing produced yet. */
export function pendingMetrics(sim: Simulator): StageMetric[] {
  return sim.at(0);
}

/** Fraction of the simulated job that is done at `elapsedMs` (drives the preview progress scrubber). */
export function simulatedCompletion(sim: Simulator, elapsedMs: number): number {
  let total = 0;
  let done = 0;
  for (const m of sim.at(elapsedMs)) {
    if (m.status === "SKIPPED") continue;
    total += m.numTasks;
    done += m.numCompleteTasks;
  }
  return total > 0 ? done / total : 0;
}
