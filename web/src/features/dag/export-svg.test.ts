import { describe, expect, it } from "vitest";
import { serializeDagSvg } from "./export-svg";
import type { EdgeVisual, Scene } from "./render/scene";
import type { DagInput, LayoutResult, RenderGraph } from "./types";

const dag: DagInput = { kind: "stage", granularity: "rdd", stages: [], edges: [] };

function graph(): RenderGraph {
  return {
    hash: "graph-hash",
    kind: "stage",
    granularity: "rdd",
    nodes: [],
    edges: [],
    clusters: [],
    sizes: new Map(),
    large: false,
    warnings: [],
    notes: [],
    inferred: false,
    source: dag,
  };
}

function layout(): LayoutResult {
  return {
    hash: "layout-hash",
    width: 640,
    height: 360,
    nodes: new Map(),
    clusters: new Map(),
    edges: new Map(),
    durationMs: 3,
    ran: "main",
    rung: 0,
    ladderName: "primary",
  };
}

function scene(edges: EdgeVisual[] = []): Scene {
  return {
    nodes: [],
    byId: new Map(),
    clusters: [],
    edges,
    edgeById: new Map(edges.map((edge) => [edge.edge.id, edge])),
    runningNodes: [],
    totals: { done: 0, total: 0, active: 0, failed: 0 },
    warnings: [],
    notes: [],
    digest: "scene-hash",
  };
}

function edge(overrides: Partial<EdgeVisual> & { id: string; kind: "flow" | "cross-stage" | "rdd" | "sql" }): EdgeVisual {
  const { id, kind, ...rest } = overrides;
  return {
    edge: { id, kind, from: "from", to: "to" },
    points: [],
    path: "M 0 0 L 10 10",
    arrow: null,
    flowing: false,
    intensity: 0,
    opacity: 1,
    dashArray: "4 3",
    animationSeconds: 1,
    travel: 0,
    selected: false,
    hovered: false,
    dimmed: false,
    shuffleLabel: null,
    labels: [],
    ...rest,
  } as EdgeVisual;
}

function sourceSvg(withClusterSibling = true): SVGSVGElement {
  const source = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  source.setAttribute("class", "burrow-dag-svg");
  source.setAttribute("aria-describedby", "dag-help");
  source.style.color = "rgb(12, 34, 56)";
  const world = document.createElementNS("http://www.w3.org/2000/svg", "g");
  world.setAttribute("transform", "translate(10 20) scale(2)");
  const clusters = document.createElementNS("http://www.w3.org/2000/svg", "g");
  clusters.setAttribute("class", "burrow-dag-cluster-layer");
  world.append(clusters);
  if (withClusterSibling) {
    const nodes = document.createElementNS("http://www.w3.org/2000/svg", "g");
    nodes.setAttribute("id", "node-layer");
    world.append(nodes);
  }
  source.append(world);
  return source;
}

describe("serializeDagSvg", () => {
  it("returns null when the source SVG has no world group", () => {
    const source = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    expect(serializeDagSvg(source, dag, undefined, graph(), layout(), scene(), document.createElement("div"), false)).toBeNull();
  });

  it("embeds the full export payload and computed styles without canvas edges", () => {
    const source = sourceSvg();
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(1, 2, 3)";
    const output = serializeDagSvg(source, dag, undefined, graph(), layout(), scene(), host, false);

    expect(output).toContain('width="640"');
    expect(output).toContain('height="360"');
    expect(output).toContain('viewBox="0 0 640 360"');
    expect(output).not.toContain("aria-describedby");
    expect(output).not.toContain("translate(10 20) scale(2)");
    expect(output).toContain('id="burrow-dagviz-export"');
    expect(output).toContain('"sourcePayload"');
    expect(output).toContain("graph-hash");
    expect(output).not.toContain("burrow-dag-edge-flow");
  });

  it("serializes SVG edges for canvas graphs, including dim, flow, arrow, and edge-kind styles", () => {
    const source = sourceSvg();
    const host = document.createElement("div");
    const visuals = [
      edge({ id: "plain", kind: "rdd" }),
      edge({ id: "dim", kind: "sql", dimmed: true }),
      edge({ id: "cross", kind: "cross-stage", flowing: true, opacity: 0.6, arrow: { d: "M 9 9 L 10 10" } as never }),
      edge({ id: "flow", kind: "flow", flowing: true, arrow: { d: "M 5 5 L 6 6" } as never, opacity: 0.8 }),
    ];
    const output = serializeDagSvg(source, dag, [], graph(), layout(), scene(visuals), host, true)!;
    const exported = new DOMParser().parseFromString(output, "image/svg+xml");
    const groups = [...exported.querySelectorAll(".burrow-dag-edges > .burrow-dag-edge")];

    expect(groups).toHaveLength(4);
    expect(groups[0]?.querySelector(".burrow-dag-edge-track")?.getAttribute("stroke-width")).toBe("1.25");
    expect(groups[1]?.getAttribute("opacity")).toBe("0.25");
    expect(groups[1]?.querySelector(".burrow-dag-edge-track")?.getAttribute("stroke-width")).toBe("1.5");
    expect(groups[2]?.querySelector(".burrow-dag-edge-flow")?.getAttribute("opacity")).toBe("0.6");
    expect(groups[2]?.querySelector(".burrow-dag-arrow")?.getAttribute("fill")).not.toBeNull();
    expect(groups[3]?.querySelector(".burrow-dag-arrow")).not.toBeNull();
    expect(host.querySelectorAll("span")).toHaveLength(0);
    expect(exported.querySelector(".burrow-dag-edges")?.nextElementSibling?.getAttribute("id")).toBe("node-layer");
  });

  it("inserts canvas edges first when the SVG has no cluster layer", () => {
    const source = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const world = document.createElementNS("http://www.w3.org/2000/svg", "g");
    source.append(world);
    const output = serializeDagSvg(source, dag, undefined, graph(), layout(), scene(), document.createElement("div"), true)!;
    const exported = new DOMParser().parseFromString(output, "image/svg+xml");
    expect(exported.querySelector("g.burrow-dag-edges")).not.toBeNull();
  });
});
