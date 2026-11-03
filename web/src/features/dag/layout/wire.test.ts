// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeWire, layoutRequest } from "./wire";
import type { LayoutWire } from "../types";

function wire(overrides: Partial<LayoutWire> = {}): LayoutWire {
  return {
    hash: "graph",
    width: 120,
    height: 80,
    durationMs: 3,
    rung: 0,
    ladderName: "layered",
    nodeIds: [],
    nodeBoxes: new Float32Array(0),
    clusterIds: [],
    clusterBoxes: new Float32Array(0),
    edgeIds: [],
    edgeOffsets: new Uint32Array([0]),
    edgePoints: new Float32Array(0),
    ...overrides,
  };
}

describe("layout wire conversion", () => {
  it("decodes sparse buffers and skips missing ids", () => {
    const decoded = decodeWire(
      wire({
        nodeIds: ["node", undefined] as unknown as string[],
        clusterIds: ["cluster", undefined] as unknown as string[],
        edgeIds: ["empty", undefined] as unknown as string[],
        nodeBoxes: new Float32Array(0),
        clusterBoxes: new Float32Array(0),
        edgeOffsets: new Uint32Array(0),
      }),
      "worker",
    );

    expect(decoded.nodes.get("node")).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(decoded.clusters.get("cluster")).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(decoded.edges.get("empty")).toEqual([]);
    expect(decoded.ran).toBe("worker");
    expect(decoded.nodes.has(undefined as never)).toBe(false);
  });

  it("fills absent edge coordinates with the origin", () => {
    const decoded = decodeWire(wire({ edgeIds: ["edge"], edgeOffsets: new Uint32Array([0, 1]), edgePoints: new Float32Array(0) }), "main");
    expect(decoded.edges.get("edge")).toEqual([{ x: 0, y: 0 }]);
  });

  it("builds worker requests with default node sizes", () => {
    const graph = {
      hash: "graph",
      nodes: [{ id: "node", clusterId: null }],
      edges: [],
      clusters: [{ id: "cluster", parentId: null, label: "scope" }],
      sizes: new Map(),
    } as unknown as Parameters<typeof layoutRequest>[0];

    const request = layoutRequest(graph, 9);
    expect(request.graph.nodes).toEqual([{ id: "node", width: 160, height: 40, clusterId: null }]);
    expect(request.graph.clusters).toEqual([{ id: "cluster", parentId: null, depth: 0, label: "scope" }]);
    expect(request.requestId).toBe(9);
  });
});
