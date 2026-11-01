/**
 * Card row geometry for the spacious DAG card treatment.
 */
import { describe, expect, it } from "vitest";
import {
  buildScene,
  badgeWidth,
  fittedBadges,
  flattenCandidates,
  labelCandidates,
  nodeRowGeometry,
  showsBadgeRow,
  textColumnStart,
  titleUsableWidth,
  type SceneInput,
} from "./scene";
import { buildGraph } from "../dag-model";
import { syntheticDag } from "../simulate";
import { toStageMetric } from "../metrics";
import type { Dag, LayoutResult, RenderGraph } from "../types";
import type { NodeBadge } from "./scene";

const badge = (text: string): NodeBadge => ({ key: text, text, tone: "idle" });

const KINDS = ["stage", "rdd", "sql", "fallback"] as const;
/** Every card height the layout can hand the renderer, not just the four the design doc lists. */
const HEIGHTS = Array.from({ length: 121 }, (_, i) => 40 + i);

/** The rows the renderer draws, as vertical bands. Text boxes are ~13 px around their baseline. */
function bands(height: number, kind: (typeof KINDS)[number]) {
  const g = nodeRowGeometry(height, kind);
  return {
    g,
    sub: [g.subY - 11, g.subY + 3] as const,
    meta: g.metaY > 0 ? ([g.metaY - 10, g.metaY + 3] as const) : null,
    progress: [g.progressY, g.progressY + 6] as const,
  };
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] < b[1] && b[0] < a[1];

describe("nodeRowGeometry", () => {
  it("keeps the second metadata row clear of the secondary line", () => {
    for (const kind of KINDS) {
      for (const height of HEIGHTS) {
        const b = bands(height, kind);
        if (b.meta) expect(overlaps(b.meta, b.sub), `${kind} card ${height}px: metadata ${b.meta} vs sub ${b.sub}`).toBe(false);
      }
    }
  });

  it("keeps metadata clear of the progress strip", () => {
    for (const kind of KINDS) {
      for (const height of HEIGHTS) {
        const b = bands(height, kind);
        if (b.meta)
          expect(overlaps(b.meta, b.progress), `${kind} card ${height}px: metadata ${b.meta} vs progress ${b.progress}`).toBe(false);
      }
    }
  });

  it("uses the reference card baselines for roomy nodes", () => {
    expect(nodeRowGeometry(158, "rdd")).toEqual({ titleY: 47, subY: 81, metaY: 111, progressY: 133 });
  });
});

describe("badge row width", () => {
  it("shows a badge row only when a card can fit at least one badge", () => {
    expect(showsBadgeRow(39, 1)).toBe(false);
    expect(showsBadgeRow(40, 1)).toBe(true);
    expect(showsBadgeRow(84, 0)).toBe(false);
  });

  it("stops at the first badge that does not fit", () => {
    const wide = [badge("a".repeat(10)), badge("b".repeat(10)), badge("c".repeat(10))];
    expect(badgeWidth("a".repeat(10))).toBeCloseTo(68);
    expect(fittedBadges(wide, 150)).toEqual({ count: 2, width: 140 });
    expect(fittedBadges(wide, 10)).toEqual({ count: 0, width: 0 });
    expect(fittedBadges([], 100)).toEqual({ count: 0, width: 0 });
  });

  it("caps a single badge so it cannot eat the row", () => {
    expect(badgeWidth("x".repeat(40))).toBe(96);
  });

  it("keeps the full title column when metadata moves below the title", () => {
    const badges = [badge("1 metrics")];
    const usable = titleUsableWidth(268, 52, "sql", badges);
    expect(usable).toBe(268 - textColumnStart("sql") - 12);
  });

  it("leaves the whole text column to the title when the badges have their own row", () => {
    expect(titleUsableWidth(268, 84, "stage", [badge("1 metrics")])).toBe(268 - textColumnStart("stage") - 12);
  });
});

function layoutFor(graph: RenderGraph, height = 158): LayoutResult {
  return {
    hash: `layout:${graph.hash}:${height}`,
    width: 1_200,
    height: 800,
    nodes: new Map(graph.nodes.map((node, index) => [node.id, { x: index * 220, y: 40, width: 200, height }])),
    clusters: new Map(graph.clusters.map((cluster, index) => [cluster.id, { x: index * 100, y: 10, width: 500, height: 400 }])),
    edges: new Map(
      graph.edges.map((edge, index) => [
        edge.id,
        [
          { x: index * 100, y: 100 },
          { x: index * 100 + 80, y: 100 },
        ],
      ]),
    ),
    durationMs: 1,
    ran: "main",
    rung: 0,
    ladderName: "test",
  };
}

function metric(stageId: number, status = "ACTIVE") {
  return toStageMetric({
    stageId,
    status,
    numTasks: 10,
    numActiveTasks: status === "ACTIVE" ? 2 : 0,
    numCompleteTasks: 5,
    numFailedTasks: 1,
    numKilledTasks: 0,
    submissionTime: 1_800_000_000_000,
    firstTaskLaunchedTime: 1_800_000_001_000,
    completionTime: status === "COMPLETE" ? 1_800_000_005_000 : null,
    shuffleReadBytes: 2_048,
    shuffleWriteBytes: 4_096,
  })!;
}

function sceneInput(graph: RenderGraph, layout = layoutFor(graph)): SceneInput {
  return {
    graph,
    layout,
    metrics: new Map([
      [0, metric(0)],
      [1, metric(1, "COMPLETE")],
    ]),
    flow: new Map(),
    now: 1_800_000_010_000,
    level: "detail",
    reducedMotion: false,
    selectedNodeId: null,
    selectedEdgeId: null,
    hoveredNodeId: null,
    hoveredEdgeId: null,
    flashes: new Map(),
    focusStageId: null,
  };
}

describe("scene derivation", () => {
  it("adds a metric-count badge to SQL operator nodes at detail zoom", () => {
    const graph = buildGraph(syntheticDag({ stages: 1, nodesPerStage: 2, skipEvery: 0, seed: 12 }), { expandStages: true });
    const node = graph.nodes[0]!;
    graph.nodes[0] = { ...node, metrics: [{ name: "records", value: "12" }] };

    const scene = buildScene(sceneInput(graph));
    expect(scene.byId.get(node.id)?.badges).toContainEqual(expect.objectContaining({ key: "metrics", text: "1 metrics" }));
  });

  it("joins stage metrics, interactions and shuffle flow, then reuses unchanged visuals", () => {
    const graph = buildGraph(syntheticDag({ stages: 2, nodesPerStage: 3, skipEvery: 0, seed: 4 }), { expandStages: true });
    const firstNode = graph.nodes.find((node) => node.stageId === 0)!;
    const otherNode = graph.nodes.find((node) => node.stageId === 1)!;
    const edge = graph.edges.find((candidate) => candidate.kind === "cross-stage")!;
    const input = sceneInput(graph);
    input.flow = new Map([[edge.from, { active: true, intensity: 0.75, ratePerSecond: 4 }]]);
    input.selectedNodeId = firstNode.id;
    input.selectedEdgeId = edge.id;
    input.hoveredNodeId = firstNode.id;
    input.hoveredEdgeId = edge.id;
    input.focusStageId = 0;
    input.flashes = new Map([[firstNode.id, "warn"]]);
    input.tweenMs = new Map([[firstNode.id, 120]]);

    const scene = buildScene(input);
    expect(scene.runningNodes.length).toBeGreaterThan(0);
    const firstStageNodes = graph.nodes.filter((node) => node.stageId === 0).length;
    const secondStageNodes = graph.nodes.filter((node) => node.stageId === 1).length;
    expect(scene.totals).toEqual({
      done: (firstStageNodes + secondStageNodes) * 5,
      total: (firstStageNodes + secondStageNodes) * 10,
      active: firstStageNodes * 2,
      failed: firstStageNodes + secondStageNodes,
    });
    expect(scene.edges.find((candidate) => candidate.edge.id === edge.id)).toMatchObject({
      flowing: true,
      selected: true,
      hovered: true,
      shuffleLabel: "2 KiB",
    });
    expect(scene.byId.get(firstNode.id)).toMatchObject({ selected: true, hovered: true, flash: "warn", tweenMs: 120 });
    expect(scene.byId.get(otherNode.id)?.dimmed).toBe(true);
    expect(scene.clusters.length).toBe(graph.clusters.length);

    const repeated = buildScene(input);
    expect(repeated.byId.get(firstNode.id)).toBe(scene.byId.get(firstNode.id));
    expect(repeated.edgeById.get(edge.id)).toBe(scene.edgeById.get(edge.id));

    const candidates = labelCandidates({ scene, level: "detail", showEdgeLabels: true });
    expect(candidates.nodes.get(firstNode.id)?.map((candidate) => candidate.id)).toContain(`${firstNode.id}#title`);
    expect(candidates.edges.get(edge.id)?.[0]?.id).toBe(`${edge.id}#len`);
    expect(flattenCandidates(candidates).length).toBeGreaterThan(0);
    expect(labelCandidates({ scene, level: "overview", showEdgeLabels: false })).toEqual({ nodes: new Map(), edges: new Map() });
  });

  it("builds ghost and stage-summary visuals with safe missing geometry and metrics", () => {
    const base = buildGraph(syntheticDag({ stages: 1, nodesPerStage: 2, skipEvery: 0, seed: 7 }), { expandStages: true });
    const graph: RenderGraph = {
      ...base,
      hash: `${base.hash}:ghost`,
      nodes: [...base.nodes, { id: "ghost:99", label: "RDD 99", kind: "ghost" }],
    };
    const ghostInput = sceneInput(graph);
    ghostInput.layout.nodes.delete("ghost:99");
    const ghost = buildScene(ghostInput).byId.get("ghost:99");
    expect(ghost).toMatchObject({ status: "GHOST", skipped: true, related: true, rect: { width: 0, height: 0 } });

    const fallbackDag: Dag = {
      kind: "stage",
      granularity: "stage",
      stages: [{ stageId: 44, skipped: false, label: "Stage 44", clusters: [], nodes: [], edges: [] }],
      edges: [],
    };
    const fallbackGraph = buildGraph(fallbackDag);
    const fallbackInput = sceneInput(fallbackGraph, layoutFor(fallbackGraph, 66));
    fallbackInput.metrics = new Map([[44, metric(44)]]);
    fallbackInput.flow = new Map();
    fallbackInput.selectedNodeId = fallbackGraph.nodes[0]!.id;
    fallbackInput.focusStageId = 44;
    const fallback = buildScene(fallbackInput).nodes[0]!;
    expect(fallback).toMatchObject({ node: { kind: "fallback" }, subText: "5 / 10 tasks · 2 running · 1 failed", related: true });
    expect(labelCandidates({ scene: buildScene(fallbackInput), level: "detail", showEdgeLabels: false }).nodes.size).toBe(1);
  });
});
