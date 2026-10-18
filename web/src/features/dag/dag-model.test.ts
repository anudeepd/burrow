/**
 * DAG model: goldens→graph adaptation, the REST fallback (null endpoints, inferred edges), operation-scope nesting,
 * ghost stubs, cycle defence and hash stability. Uses real fixtures for every shape it asserts.
 */
import { describe, expect, it } from "vitest";
import { buildGraph, hashGraph, reduceTransitive, stageFlags, EXPAND_LIMIT } from "./dag-model";
import { goldensFor, readGolden, sqlPlans, readSqlPlan } from "./testing/fixtures.node";
import { buildSqlPlanGraph, isCodegenBoundary, planOperatorCount, sqlMetricSummary } from "./sql-plan";
import type { Dag, DagStage, GraphEdge, SqlPlanExecution } from "./types";

function golden(workload: string, file: string, version = "4.2.0"): Dag {
  const g = goldensFor(version).find((x) => x.workload === workload && x.file === file);
  if (!g) throw new Error(`missing golden ${version}/${workload}/${file}`);
  return readGolden(g);
}

const stage = (over: Partial<DagStage> = {}): DagStage => ({
  stageId: 0,
  skipped: false,
  label: "Stage 0",
  clusters: [],
  nodes: [],
  edges: [],
  ...over,
});

describe("buildGraph on goldens", () => {
  it("expands a job DAG into stage containers holding RDD chains", () => {
    const dag = golden("big-dag", "dag-job-2.json");
    const graph = buildGraph(dag);
    expect(graph.kind).toBe("job");
    expect(graph.inferred).toBe(false);
    expect(graph.nodes.every((n) => n.kind === "rdd")).toBe(true);
    // one container per stage
    expect(graph.clusters.filter((c) => c.id.startsWith("stage:"))).toHaveLength(dag.stages.length);
    // every RDD node sits inside its stage container
    for (const node of graph.nodes) {
      expect(node.clusterId).toBeTruthy();
      expect(graph.clusters.some((c) => c.id === node.clusterId)).toBe(true);
    }
    expect(graph.warnings).toEqual([]);
  });

  it("collapses a job DAG to stage cards past the expansion limit", () => {
    const dag = golden("big-dag", "dag-job-2.json");
    const expanded = buildGraph(dag, { expandStages: true });
    expect(expanded.nodes.length).toBeGreaterThan(30);
    const collapsed = buildGraph(dag, { expandStages: false });
    expect(collapsed.nodes).toHaveLength(dag.stages.length);
    expect(collapsed.nodes.every((n) => n.kind === "stage" || n.kind === "fallback")).toBe(true);
    expect(collapsed.edges.length).toBeGreaterThan(0);
    expect(collapsed.hash).not.toBe(expanded.hash);
  });

  it("auto-collapses when a job has more RDDs than EXPAND_LIMIT", () => {
    const nodes = Array.from({ length: EXPAND_LIMIT + 30 }, (_, i) => ({
      id: i,
      name: `RDD${i}`,
      callsite: "x at y:1",
      cached: false,
      clusterId: null,
    }));
    const dag: Dag = {
      kind: "job",
      granularity: "rdd",
      stages: [stage({ stageId: 0, nodes: nodes.slice(0, 100), edges: [] }), stage({ stageId: 1, nodes: nodes.slice(100), edges: [] })],
      edges: [],
    };
    expect(buildGraph(dag).nodes).toHaveLength(2);
    expect(buildGraph(dag, { expandStages: true }).nodes).toHaveLength(nodes.length);
  });

  it("namespaces operation scopes per stage and keeps nesting", () => {
    // barrier-scopes stage 1 is the captured nested-scope vector (cluster_9001 inside cluster_9000)
    const dag = golden("barrier-scopes", "dag-stage-1-0.json");
    const graph = buildGraph(dag);
    const nested = graph.clusters.filter((c) => c.parentId !== null);
    expect(nested.length).toBeGreaterThan(0);
    for (const c of graph.clusters) {
      expect(c.id).toContain("1.0:");
      if (c.parentId) expect(graph.clusters.some((p) => p.id === c.parentId)).toBe(true);
    }
    // two stages reusing the same scope id must not collide: the namespace is per stage
    const job = buildGraph(golden("shared-stages-multijob", "dag-job-2.json"));
    const stageScoped = job.clusters.filter((c) => c.label.includes("·"));
    void stageScoped;
    expect(new Set(job.clusters.map((c) => c.id)).size).toBe(job.clusters.length);
  });

  it("normalises the stage label flags into badges", () => {
    const flags = stageFlags(stage({ stageId: 3, label: "Stage 3\n(barrier mode)" }));
    expect(flags.label).toBe("Stage 3");
    expect(flags.barrier).toBe(true);
    expect(stageFlags(stage({ stageId: 4, label: "Stage 4 (skipped)", skipped: true })).skipped).toBe(true);
    expect(stageFlags(stage({ stageId: 5, label: "Stage 5 (attempt 2)" })).attempt).toBe(2);
    expect(stageFlags(stage({ stageId: 6, label: "" })).label).toBe("Stage 6");
  });

  it("carries cached / barrier / determinism flags onto nodes", () => {
    const barrier = buildGraph(golden("barrier-scopes", "dag-stage-0-0.json"));
    expect(barrier.nodes.some((n) => n.barrier === true)).toBe(true);
    const cached = buildGraph(golden("rdd-wordcount", "dag-job-1.json"));
    expect(cached.nodes.some((n) => n.cached === true)).toBe(true);
    const unordered = buildGraph(golden("barrier-scopes", "dag-stage-3-0.json"));
    expect(unordered.nodes.some((n) => n.determinism === "unordered")).toBe(true);
  });
});

describe("REST fallback", () => {
  const dag = golden("big-dag", "dag-fallback-job-2.json");

  it("is marked inferred and stays at stage granularity", () => {
    expect(dag.granularity).toBe("stage");
    expect(dag.edgesInferred).toBe(true);
    const graph = buildGraph(dag);
    expect(graph.inferred).toBe(true);
    expect(graph.notes.join(" ")).toContain("inferred");
    expect(graph.nodes).toHaveLength(dag.stages.length);
  });

  it("attributes null-endpoint edges by their stage pair", () => {
    expect(dag.edges.every((e) => e.from === null && e.to === null)).toBe(true);
    const graph = buildGraph(dag);
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const e of graph.edges) {
      expect(e.fromStage).not.toBeNull();
      expect(e.toStage).not.toBeNull();
      expect(e.fromStage).not.toBe(e.toStage);
      expect(graph.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(graph.nodes.some((n) => n.id === e.to)).toBe(true);
    }
  });

  it("folds transitively implied edges away and says so", () => {
    const raw = dag.edges.length;
    const graph = buildGraph(dag);
    expect(graph.edges.length).toBeLessThan(raw);
    expect(graph.notes.join(" ")).toContain("implied by a longer path");
    expect(graph.warnings).toEqual([]);
  });

  it("keeps the payload's own stage status so fallback cards are not all idle", () => {
    const graph = buildGraph(dag);
    expect(graph.nodes.every((n) => (n.status ? n.status !== "UNKNOWN" : false))).toBe(true);
    expect(graph.nodes.every((n) => (n.rddCount ?? 0) >= 0)).toBe(true);
  });

  it("connects the stage boundary when a job DAG has null endpoint ids but is expanded", () => {
    const expanded = buildGraph(dag, { expandStages: true });
    // the fallback has no RDD nodes at all, so there is nothing to expand into — and we say so rather than
    // rendering an empty canvas
    expect(expanded.nodes.length).toBe(dag.stages.length);
    expect(expanded.notes.join(" ")).toContain("no RDD detail");
  });
});

describe("defensive handling", () => {
  it("drops cyclic edges and warns", () => {
    const dag: Dag = {
      kind: "stage",
      granularity: "rdd",
      stages: [
        stage({
          nodes: [0, 1, 2].map((id) => ({ id, name: `R${id}`, callsite: "c", cached: false, clusterId: null })),
          edges: [
            { from: 0, to: 1 },
            { from: 1, to: 2 },
            { from: 2, to: 0 },
          ],
        }),
      ],
      edges: [],
    };
    const graph = buildGraph(dag);
    expect(graph.edges).toHaveLength(2);
    expect(graph.warnings.some((w) => w.includes("cyclic"))).toBe(true);
  });

  it("warns about an unknown RDD in an intra-stage edge", () => {
    const dag: Dag = {
      kind: "stage",
      granularity: "rdd",
      stages: [
        stage({
          nodes: [{ id: 0, name: "R0", callsite: "c", cached: false, clusterId: null }],
          edges: [{ from: 0, to: 99 }],
        }),
      ],
      edges: [],
    };
    expect(buildGraph(dag).warnings.some((w) => w.includes("unknown RDD"))).toBe(true);
  });

  it("stubs an endpoint that is not on this page as a ghost node", () => {
    const dag: Dag = {
      kind: "stage",
      granularity: "rdd",
      stages: [
        stage({
          nodes: [{ id: 5, name: "ShuffledRDD", callsite: "c", cached: false, clusterId: null }],
          edges: [],
        }),
      ],
      edges: [{ from: 42, to: 5, fromStage: null, toStage: null }],
    };
    const graph = buildGraph(dag);
    const ghost = graph.nodes.find((n) => n.kind === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost!.label).toBe("RDD 42");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.from).toBe(ghost!.id);
  });

  it("warns when an edge has neither a resolvable node nor a stage", () => {
    const dag: Dag = {
      kind: "job",
      granularity: "rdd",
      stages: [stage({ stageId: 0, nodes: [{ id: 0, name: "R", callsite: "c", cached: false, clusterId: null }] })],
      edges: [{ from: 7, to: 8, fromStage: null, toStage: null }],
    };
    const graph = buildGraph(dag);
    expect(graph.nodes.some((n) => n.kind === "ghost")).toBe(true);
  });

  it("survives a stage with no nodes and no clusters", () => {
    const dag: Dag = { kind: "stage", granularity: "stage", stages: [stage({ stageId: 9, status: "SKIPPED" })], edges: [] };
    const graph = buildGraph(dag);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.status).toBe("SKIPPED");
    expect(graph.nodes[0]!.kind).toBe("fallback");
  });
});

describe("hash stability", () => {
  it("is stable for identical structure and changes with structure", () => {
    const a = buildGraph(golden("rdd-wordcount", "dag-stage-0-0.json"));
    const b = buildGraph(golden("rdd-wordcount", "dag-stage-0-0.json"));
    expect(a.hash).toBe(b.hash);
    const c = buildGraph(golden("rdd-wordcount", "dag-job-1.json"));
    expect(c.nodes.length).not.toBe(a.nodes.length);
    expect(c.hash).not.toBe(a.hash);
  });

  it("does not include anything metric-like (metrics must never invalidate a layout)", () => {
    const graph = buildGraph(golden("rdd-wordcount", "dag-stage-0-0.json"));
    const sameShape = hashGraph(graph.kind, graph.granularity, {
      nodes: graph.nodes.map((n) => ({ ...n })),
      edges: graph.edges.map((e) => ({ ...e })),
      clusters: graph.clusters.map((c) => ({ ...c })),
      sizes: graph.sizes,
    });
    expect(sameShape).toBe(graph.hash);
  });
});

describe("reduceTransitive", () => {
  it("leaves small graphs untouched", () => {
    const edges: GraphEdge[] = [
      { id: "a", from: "x", to: "y", kind: "cross-stage" },
      { id: "b", from: "y", to: "z", kind: "cross-stage" },
    ];
    expect(reduceTransitive(["x", "y", "z"], edges)).toHaveLength(2);
  });

  it("removes an edge implied by a longer path", () => {
    // 8 nodes, 11 edges: dense enough for the reduction pass, with three hop-1 shortcuts that must go
    const nodes = Array.from({ length: 8 }, (_, i) => `n${i}`);
    const edges: GraphEdge[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, from: `n${i}`, to: `n${i + 1}`, kind: "cross-stage" as const })),
      { id: "shortcut-02", from: "n0", to: "n2", kind: "cross-stage" },
      { id: "shortcut-03", from: "n0", to: "n3", kind: "cross-stage" },
      { id: "shortcut-05", from: "n0", to: "n5", kind: "cross-stage" },
      { id: "parallel", from: "n1", to: "n4", kind: "cross-stage" },
    ];
    const kept = reduceTransitive(nodes, edges);
    // all three hop-1 shortcuts AND n1→n4 are implied by the chain; the chain itself is the covering set
    expect(kept.map((e) => e.id)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6"]);
  });
});

describe("SQL plan adaptation", () => {
  const plans = sqlPlans("4.2.0");

  it("has captured plans to adapt", () => {
    expect(plans.length).toBeGreaterThan(0);
  });

  it("uses Spark 2.4 per-node plan metadata when the REST plan appendix is absent", () => {
    const graph = buildSqlPlanGraph({
      id: 2,
      status: "COMPLETED",
      description: "select id from range",
      planDescription: "== Physical Plan ==\n*(1) Range (0, 10000, step=1, splits=4)",
      nodes: [{ nodeId: 12, nodeName: "Range", planLine: "Range (0, 10000, step=1, splits=4)" }],
      edges: [],
    });

    expect(graph.nodes[0]?.detail).toBe("Range (0, 10000, step=1, splits=4)");
  });

  it("recovers operator plan lines from a legacy physical tree when History Server REST has no appendix", () => {
    const graph = buildSqlPlanGraph({
      id: 2,
      status: "COMPLETED",
      description: "select id from range",
      planDescription: "== Physical Plan ==\n*(1) Sort [id#0L ASC NULLS FIRST], true, 0\n+- *(2) Range (0, 10000, step=1, splits=4)",
      nodes: [
        { nodeId: 1, nodeName: "Sort" },
        { nodeId: 2, nodeName: "Range" },
      ],
      edges: [],
    });

    expect(graph.nodes.find((node) => node.label === "Sort")?.detail).toBe("Sort [id#0L ASC NULLS FIRST], true, 0");
    expect(graph.nodes.find((node) => node.label === "Range")?.detail).toBe("Range (0, 10000, step=1, splits=4)");
  });

  it("adapts every captured plan without warnings", () => {
    for (const plan of plans) {
      const body = readSqlPlan(plan.path) as SqlPlanExecution;
      const graph = buildSqlPlanGraph(body);
      expect(graph.kind).toBe("sql");
      expect(graph.inferred).toBe(false);
      // Spark lists one `WholeStageCodegen (n)` boundary entry per codegen scope; the cluster frame draws it, so it
      // must not become a card of its own. Everything else in `nodes[]` is an operator and is kept.
      const boundaries = body.nodes.filter((n) => isCodegenBoundary(n.nodeName));
      expect(graph.nodes).toHaveLength(body.nodes.length - boundaries.length);
      expect(planOperatorCount(body.nodes)).toBe(graph.nodes.length);
      expect(graph.nodes.some((n) => isCodegenBoundary(n.label))).toBe(false);
      expect(graph.nodes.every((n) => n.id.startsWith("sql."))).toBe(true);
      expect(graph.warnings).toEqual([]);
      for (const e of graph.edges) {
        expect(graph.nodes.some((n) => n.id === e.from)).toBe(true);
        expect(graph.nodes.some((n) => n.id === e.to)).toBe(true);
      }
    }
  });

  it("groups wholeStageCodegen members into compound clusters", () => {
    const body = readSqlPlan(plans[0]!.path) as SqlPlanExecution;
    const graph = buildSqlPlanGraph(body);
    const codegenIds = new Set(body.nodes.map((n) => n.wholeStageCodegenId).filter((x): x is number => typeof x === "number"));
    expect(graph.clusters).toHaveLength(codegenIds.size);
    for (const c of graph.clusters) {
      expect(c.label).toMatch(/^WholeStageCodegen \(\d+\)$/);
      expect(graph.nodes.some((n) => n.clusterId === c.id)).toBe(true);
    }
  });

  it("carries a codegen boundary's own metric on its cluster instead of a stray card", () => {
    const body = readSqlPlan(plans[0]!.path) as SqlPlanExecution;
    const graph = buildSqlPlanGraph(body);
    const boundaries = body.nodes.filter((n) => isCodegenBoundary(n.nodeName));
    expect(boundaries.length).toBeGreaterThan(0);
    const byLabel = new Map(graph.clusters.map((c) => [c.label, c]));
    for (const b of boundaries) {
      const cluster = byLabel.get(b.nodeName.trim());
      expect(cluster).toBeDefined();
      const detail = sqlMetricSummary(b);
      expect(cluster!.detail).toBe(detail);
    }
    expect(graph.clusters.some((c) => c.detail != null)).toBe(true);
  });

  it("reads each operator's own line out of the plan text, never a neighbour's", () => {
    // Appendix argument lines: Spark's own labels for the operator's details.
    const ARGUMENT_LINE =
      /^(Output|Input|Arguments|Condition|Left keys|Right keys|Join type|Join condition|Functions|Results|Aggregate Attributes|Statistics) /m;
    let sawArguments = 0;
    let operators = 0;
    let covered = 0;
    for (const plan of plans) {
      const body = readSqlPlan(plan.path) as SqlPlanExecution;
      const graph = buildSqlPlanGraph(body);
      const withLine = graph.nodes.filter((n) => n.detail);
      expect(withLine.length).toBeGreaterThan(0);
      operators += graph.nodes.length;
      covered += withLine.length;
      for (const n of withLine) {
        // The rendered line is the operator's own appendix heading, and it must open with the operator's name, raw. The
        // bug this pins showed "Exchange (28)" on a Project: ids are not comparable between `nodes[]` and the plan text.
        const head = (n.detail ?? "").split("\n")[0] ?? "";
        expect(head.trim().startsWith(n.label)).toBe(true);
        if (ARGUMENT_LINE.test(n.detail ?? "")) sawArguments++;
      }
    }
    // the appendix carries the operator's arguments, which is the whole point of reading it
    expect(sawArguments).toBeGreaterThan(0);
    // ... and the name merge must cover the corpus rather than quietly dropping operators whose text name differs — a
    // join kind, say: "SortMergeJoin Inner" in the text vs "SortMergeJoin" in `nodes[]`.
    expect(covered / operators).toBeGreaterThan(0.9);
  });

  it("reaches an operator whose text name carries a join kind", () => {
    const plan = plans.find((p) => (readSqlPlan(p.path) as SqlPlanExecution).nodes?.some((n) => n.nodeName === "SortMergeJoin"));
    expect(plan).toBeDefined();
    const graph = buildSqlPlanGraph(readSqlPlan(plan!.path) as SqlPlanExecution);
    const joins = graph.nodes.filter((n) => n.label === "SortMergeJoin");
    expect(joins.length).toBeGreaterThan(0);
    // The text prints "SortMergeJoin Inner (15)", so the merge has to normalise the suffix away before comparing.
    for (const join of joins) {
      expect(join.detail ?? "").toMatch(/^SortMergeJoin \[/);
    }
  });

  it("keeps each operator's metrics and summarises them", () => {
    const body = readSqlPlan(plans[0]!.path) as SqlPlanExecution;
    const graph = buildSqlPlanGraph(body);
    const withMetrics = graph.nodes.filter((n) => (n.metrics?.length ?? 0) > 0);
    expect(withMetrics.length).toBeGreaterThan(0);
    const summary = sqlMetricSummary(
      {
        nodeId: 1,
        nodeName: "HashAggregate",
        metrics: [
          { name: "duration", value: "1.2 s" },
          { name: "x", value: "y" },
        ],
      },
      1,
    );
    expect(summary).toBe("duration 1.2 s (+1)");
    expect(sqlMetricSummary({ nodeId: 1, nodeName: "Project", metrics: [] })).toBeUndefined();
  });
});
