// @vitest-environment node
/**
 * Layout: golden positions (committed, compared with tolerance), determinism, the option ladder and the 300-node
 * timing budget. The committed snapshot is the regression guard — a change here is a deliberate visual change.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, hashGraph } from "./dag-model";
import { LAYOUT_LADDER, LAYOUT_OPTIONS, layoutRequest, runLayout } from "./layout/elk";
import { layoutGraphSync, layoutSync, toRenderGraph } from "./layout";
import { syntheticDag } from "./simulate";
import { goldensFor, overlappingPairs, readGolden } from "./testing/fixtures.node";
import type { Dag, GraphCluster, GraphEdge, GraphNode, LayoutResult, NodeSize, Rect, RenderGraph } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = join(HERE, "__goldens__", "positions.json");
/** Sub-pixel: ELK is deterministic, so any real drift is a policy change, not noise. */
const TOLERANCE = 0.51;

interface GoldenPositions {
  why: string;
  hash: string;
  width: number;
  height: number;
  nodes: Record<string, [number, number, number, number]>;
  clusters: Record<string, [number, number, number, number] | null>;
  edgePoints: Record<string, [number, number][]>;
}

const goldens = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, GoldenPositions>;

function fixtureFor(key: string): Dag {
  const [version, workload, file] = key.split("/") as [string, string, string];
  const golden = goldensFor(version).find((g) => g.workload === workload && g.file === file);
  if (!golden) throw new Error(`fixture missing for ${key}`);
  return readGolden(golden);
}

describe("layout golden positions", () => {
  const keys = Object.keys(goldens);
  it("has a committed snapshot covering every required shape", () => {
    expect(keys.length).toBeGreaterThanOrEqual(10);
    expect(keys.some((k) => k.includes("dag-fallback"))).toBe(true);
    expect(keys.some((k) => k.includes("big-dag/dag-job-2"))).toBe(true);
  });

  for (const key of keys) {
    const expected = goldens[key]!;
    it(`${key} matches the committed positions (${expected.why})`, { timeout: 60_000 }, async () => {
      const dag = fixtureFor(key);
      const graph = buildGraph(dag);
      expect(graph.hash).toBe(expected.hash);
      const layout = await layoutGraphSync(graph);
      expect(Math.abs(layout.width - expected.width)).toBeLessThan(1);
      expect(Math.abs(layout.height - expected.height)).toBeLessThan(1);
      for (const [id, box] of Object.entries(expected.nodes)) {
        const actual = layout.nodes.get(id);
        expect(actual, `node ${id} missing`).toBeDefined();
        expect(Math.abs(actual!.x - box[0])).toBeLessThan(TOLERANCE);
        expect(Math.abs(actual!.y - box[1])).toBeLessThan(TOLERANCE);
        expect(Math.abs(actual!.width - box[2])).toBeLessThan(TOLERANCE);
        expect(Math.abs(actual!.height - box[3])).toBeLessThan(TOLERANCE);
      }
      for (const [id, box] of Object.entries(expected.clusters)) {
        const actual = layout.clusters.get(id);
        if (box === null) {
          expect(actual).toBeUndefined();
          continue;
        }
        expect(actual, `cluster ${id} missing`).toBeDefined();
        expect(Math.abs(actual!.x - box[0])).toBeLessThan(TOLERANCE);
        expect(Math.abs(actual!.y - box[1])).toBeLessThan(TOLERANCE);
      }
      for (const [id, points] of Object.entries(expected.edgePoints)) {
        const actual = layout.edges.get(id);
        expect(actual, `edge ${id} missing`).toBeDefined();
        expect(actual!.length).toBe(points.length);
        for (const [i, p] of points.entries()) {
          expect(Math.abs(actual![i]!.x - p[0])).toBeLessThan(TOLERANCE);
          expect(Math.abs(actual![i]!.y - p[1])).toBeLessThan(TOLERANCE);
        }
      }
    });
  }
});

describe("layout determinism and policy", () => {
  it("lays out the same graph identically twice", { timeout: 60_000 }, async () => {
    const dag = fixtureFor("4.2.0/big-dag/dag-job-2.json");
    const graph = buildGraph(dag);
    const a = await layoutGraphSync(graph);
    const b = await layoutGraphSync(graph);
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    for (const [id, box] of a.nodes) {
      const other = b.nodes.get(id)!;
      expect(other.x).toBe(box.x);
      expect(other.y).toBe(box.y);
    }
  });

  it("caches by structure hash, not by content identity", { timeout: 60_000 }, async () => {
    const dag = fixtureFor("4.2.0/big-dag/dag-job-2.json");
    const client = new (await import("./layout/client")).LayoutClient(false);
    const graph = buildGraph(dag);
    await client.layout(graph);
    await client.layout(buildGraph(dag)); // a fresh object with the same structure
    const stats = client.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("uses the primary option rung for every golden shape", { timeout: 120_000 }, async () => {
    for (const key of Object.keys(goldens)) {
      const graph = buildGraph(fixtureFor(key));
      const wire = await runLayout(layoutRequest(graph, 0));
      expect(wire.rung, `${key} needed a fallback rung`).toBe(0);
    }
  });

  it("keeps the ladder's rungs monotone in degradation", () => {
    expect(LAYOUT_LADDER.length).toBeGreaterThanOrEqual(2);
    expect(LAYOUT_LADDER[0]!.options["elk.hierarchyHandling"]).toBe("INCLUDE_CHILDREN");
    expect(LAYOUT_LADDER.at(-1)!.options["elk.hierarchyHandling"]).toBe("SEPARATE_CHILDREN");
    // The crashing combination must never come back: ELK 0.12 throws on model-order strategies with nested compounds.
    expect(LAYOUT_OPTIONS["elk.layered.considerModelOrder.strategy"]).toBeUndefined();
    expect(LAYOUT_OPTIONS["elk.layered.crossingModelOrder.forceNodeModelOrder"]).toBeUndefined();
    expect(LAYOUT_OPTIONS["elk.layered.crossingMinimization.forceNodeModelOrder"]).toBeUndefined();
  });

  it("never overlaps nodes in a 300-node graph and stays inside the layout budget", { timeout: 180_000 }, async () => {
    const dag = syntheticDag({ stages: 28, nodesPerStage: 12, skipEvery: 6, failStage: 9, seed: 3 });
    const graph = toRenderGraph(dag, { expandStages: true });
    expect(graph.nodes.length).toBeGreaterThanOrEqual(300);
    const layout = await layoutGraphSync(graph);
    const boxes = graph.nodes.map((n) => ({ id: n.id, ...layout.nodes.get(n.id)! }));
    expect(overlappingPairs(boxes)).toEqual([]);
    expect(layout.nodes.size).toBe(graph.nodes.length);
    // Off-thread in the app; the budget here is for the worker thread, not the frame.
    expect(layout.durationMs).toBeLessThan(2000);
    // eslint-disable-next-line no-console -- the number is part of the report
    console.log(
      `300-node layout: ${layout.nodes.size} nodes, ${layout.edges.size} edges, ${layout.durationMs.toFixed(0)} ms, ${layout.width.toFixed(0)}×${layout.height.toFixed(0)}`,
    );
  });

  it("exposes layout(dag) and layoutSync(dag) with identical geometry", { timeout: 60_000 }, async () => {
    const dag = fixtureFor("4.2.0/barrier-scopes/dag-job-2.json");
    const a = await layoutGraphSync(buildGraph(dag));
    const b = await layoutSync(dag);
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
  });
});

/**
 * ELK lists every edge under the tree root (`elk.hierarchyHandling=INCLUDE_CHILDREN`) while the section coordinates
 * stay in the edge's own `container` frame — which for a compound graph is the nested cluster, not the root.
 * Harvesting with the *listing* shape's offset therefore left those edges floating outside their nodes; only flat
 * graphs (container = root = zero offset) looked right.
 */
describe("edge sections use the container's frame", () => {
  /** A graph literal is the shortest way to pin one ELK shape; every node is the same box. */
  function graphOf(spec: {
    nodes: [id: string, clusterId: string | null][];
    edges: [from: string, to: string][];
    clusters: [id: string, parentId: string | null][];
  }): RenderGraph {
    const sizes = new Map<string, NodeSize>(spec.nodes.map(([id]) => [id, { width: 168, height: 46 }]));
    const nodes: GraphNode[] = spec.nodes.map(([id, clusterId]) => ({ id, label: id, kind: "rdd", clusterId }));
    const edges: GraphEdge[] = spec.edges.map(([from, to]) => ({ id: `${from}>${to}`, from, to, kind: "rdd" }));
    const clusters: GraphCluster[] = spec.clusters.map(([id, parentId]) => ({ id, label: id, parentId }));
    return {
      hash: hashGraph("job", "rdd", { nodes, edges, clusters, sizes }),
      kind: "job",
      granularity: "rdd",
      nodes,
      edges,
      clusters,
      sizes,
      large: false,
      warnings: [],
      notes: [],
      inferred: false,
      source: { kind: "job", granularity: "rdd", stages: [], edges: [] },
    };
  }

  /** Every edge endpoint must sit on its node's border: a floating arrow is exactly the defect this guards. */
  function expectEdgesOnNodeBorders(graph: RenderGraph, layout: LayoutResult, tol = 2) {
    const onBorder = (p: { x: number; y: number }, r: Rect) =>
      p.x >= r.x - tol &&
      p.x <= r.x + r.width + tol &&
      p.y >= r.y - tol &&
      p.y <= r.y + r.height + tol &&
      // a point deep inside the box is not "touching" it
      !(p.x > r.x + tol && p.x < r.x + r.width - tol && p.y > r.y + tol && p.y < r.y + r.height - tol);
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const e of graph.edges) {
      const points = layout.edges.get(e.id);
      expect(points, `edge ${e.id} has no geometry`).toBeDefined();
      const from = layout.nodes.get(e.from);
      const to = layout.nodes.get(e.to);
      expect(from, `node ${e.from} has no box`).toBeDefined();
      expect(to, `node ${e.to} has no box`).toBeDefined();
      const start = points![0]!;
      const end = points!.at(-1)!;
      expect(
        onBorder(start, from!),
        `${e.id} start ${start.x},${start.y} is not on ${e.from} ${from!.x},${from!.y} ${from!.width}x${from!.height}`,
      ).toBe(true);
      expect(onBorder(end, to!), `${e.id} end ${end.x},${end.y} is not on ${e.to} ${to!.x},${to!.y} ${to!.width}x${to!.height}`).toBe(true);
    }
  }

  it("keeps a nested cluster's edges on their node borders", { timeout: 60_000 }, async () => {
    const graph = graphOf({
      nodes: [
        ["a", "c1"],
        ["b", "c1"],
      ],
      edges: [["a", "b"]],
      clusters: [["c1", null]],
    });
    expectEdgesOnNodeBorders(graph, await layoutGraphSync(graph));
  });

  it("keeps a nested cluster's cross-cluster edges on their node borders", { timeout: 60_000 }, async () => {
    const graph = graphOf({
      nodes: [
        ["outer", null],
        ["a", "c1"],
        ["b", "c1"],
      ],
      edges: [
        ["outer", "a"],
        ["a", "b"],
      ],
      clusters: [["c1", null]],
    });
    expectEdgesOnNodeBorders(graph, await layoutGraphSync(graph));
  });

  it("keeps a flat graph's edges on their node borders", { timeout: 60_000 }, async () => {
    const graph = graphOf({
      nodes: [
        ["a", null],
        ["b", null],
        ["c", null],
      ],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
      clusters: [],
    });
    expectEdgesOnNodeBorders(graph, await layoutGraphSync(graph));
  });
});
