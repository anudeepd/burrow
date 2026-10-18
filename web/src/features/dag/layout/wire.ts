/**
 * The engine-free half of layout: the option tables, the request payload and the wire decoder.
 *
 * Split out of `elk.ts` so that importing layout *helpers or types* never drags ELK into a chunk. Only `elk.ts`
 * (and therefore the layout Worker, and the fallback's dynamic import) touches the engine.
 */
import { CLUSTER_PADDING, clusterDepth } from "../dag-model";
import type { LayoutRequest, LayoutResult, LayoutWire, RenderGraph } from "../types";

/**
 * Spacing is chosen so a 300-node graph stays readable while a 5-node graph does not look sparse:
 *  - nodeNode 28 keeps sibling chips apart inside an operation scope;
 *  - 56 between layers leaves room for orthogonally routed bundles and labels;
 *  - componentComponent 64 separates disconnected sub-graphs (a job whose stages do not depend on each other).
 *
 * Note what is deliberately **absent**: `elk.layered.considerModelOrder.*` and
 * `crossingMinimization.forceNodeModelOrder`. Those make ELK 0.12 throw `Cannot read properties of undefined
 * (reading 'a')` on hierarchical graphs — measured against all 732 goldens, where the model-order strategies fail
 * 12-17 graphs and this set fails none.
 */
export const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.layered.spacing.edgeNodeBetweenLayers": "14",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
  "elk.spacing.componentComponent": "64",
  "elk.spacing.edgeLabel": "6",
  "elk.layered.mergeEdges": "true",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.padding": "[top=28,left=28,bottom=28,right=28]",
  "elk.separateConnectedComponents": "true",
  "elk.aspectRatio": "1.6",
};

/**
 * Degraded option sets, tried in order when the primary set throws. Each rung keeps the *meaning* of the graph (nodes,
 * layers, direction) and only relaxes routing/containment, so a fallback layout is still readable — and the UI says
 * which rung produced it (`LayoutResult.rung` / `ladderName`).
 */
export const LAYOUT_LADDER: readonly { name: string; options: Record<string, string> }[] = [
  { name: "layered/orthogonal/compound", options: LAYOUT_OPTIONS },
  { name: "layered/polyline/compound", options: { ...LAYOUT_OPTIONS, "elk.edgeRouting": "POLYLINE" } },
  {
    name: "layered/polyline/flat",
    options: { ...LAYOUT_OPTIONS, "elk.edgeRouting": "POLYLINE", "elk.hierarchyHandling": "SEPARATE_CHILDREN" },
  },
];

export function clusterPaddingOption(): string {
  return `[top=${CLUSTER_PADDING.top},left=${CLUSTER_PADDING.left},bottom=${CLUSTER_PADDING.bottom},right=${CLUSTER_PADDING.right}]`;
}

/** Decode the worker payload back into the map-shaped result the renderer consumes. */
export function decodeWire(wire: LayoutWire, ran: "worker" | "main"): LayoutResult {
  const nodes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (let i = 0; i < wire.nodeIds.length; i++) {
    const id = wire.nodeIds[i];
    if (id === undefined) continue;
    nodes.set(id, {
      x: wire.nodeBoxes[i * 4] ?? 0,
      y: wire.nodeBoxes[i * 4 + 1] ?? 0,
      width: wire.nodeBoxes[i * 4 + 2] ?? 0,
      height: wire.nodeBoxes[i * 4 + 3] ?? 0,
    });
  }
  const clusters = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (let i = 0; i < wire.clusterIds.length; i++) {
    const id = wire.clusterIds[i];
    if (id === undefined) continue;
    clusters.set(id, {
      x: wire.clusterBoxes[i * 4] ?? 0,
      y: wire.clusterBoxes[i * 4 + 1] ?? 0,
      width: wire.clusterBoxes[i * 4 + 2] ?? 0,
      height: wire.clusterBoxes[i * 4 + 3] ?? 0,
    });
  }
  const edges = new Map<string, { x: number; y: number }[]>();
  for (let i = 0; i < wire.edgeIds.length; i++) {
    const id = wire.edgeIds[i];
    if (id === undefined) continue;
    const start = wire.edgeOffsets[i] ?? 0;
    const end = wire.edgeOffsets[i + 1] ?? start;
    const pts: { x: number; y: number }[] = [];
    for (let p = start; p < end; p++) pts.push({ x: wire.edgePoints[p * 2] ?? 0, y: wire.edgePoints[p * 2 + 1] ?? 0 });
    edges.set(id, pts);
  }
  return {
    hash: wire.hash,
    width: wire.width,
    height: wire.height,
    nodes,
    clusters,
    edges,
    durationMs: wire.durationMs,
    ran,
    rung: wire.rung,
    ladderName: wire.ladderName,
  };
}

/** Plain, structured-cloneable request payload for a render graph. */
export function layoutRequest(
  graph: Pick<RenderGraph, "hash" | "nodes" | "edges" | "clusters" | "sizes">,
  requestId: number,
): LayoutRequest {
  const depth = clusterDepth(graph.clusters);
  return {
    requestId,
    graph: {
      hash: graph.hash,
      nodes: graph.nodes.map((n) => {
        const s = graph.sizes.get(n.id) ?? { width: 160, height: 40 };
        return { id: n.id, width: s.width, height: s.height, clusterId: n.clusterId ?? null };
      }),
      edges: graph.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
      clusters: graph.clusters.map((c) => ({
        id: c.id,
        parentId: c.parentId,
        depth: depth.get(c.id) ?? 0,
        label: c.label,
      })),
    },
    options: LAYOUT_OPTIONS,
  };
}
