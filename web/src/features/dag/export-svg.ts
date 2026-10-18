/** DOM serialization for standalone SVG exports, kept outside the interactive graph renderer. */
import type { StageMetric } from "./metrics";
import type { EdgeVisual, Scene } from "./render/scene";
import type { DagInput, LayoutResult, RenderGraph } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

const SVG_EXPORT_STYLES = [
  "color",
  "display",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "filter",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "opacity",
  "paint-order",
  "shape-rendering",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "text-rendering",
  "visibility",
] as const;

function appendCanvasEdgesForExport(world: SVGGElement, edges: readonly EdgeVisual[], host: HTMLElement): void {
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "burrow-dag-edges");
  const colorFor = (token: string, fallback: string): string => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden";
    probe.style.backgroundColor = `var(${token}, ${fallback})`;
    host.append(probe);
    const color = window.getComputedStyle(probe).backgroundColor || fallback;
    probe.remove();
    return color;
  };
  const trackColor = colorFor("--seam-strong", "#58616d");
  const liveColor = colorFor("--live", "#36cbd0");

  for (const edge of edges) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "burrow-dag-edge");
    group.setAttribute("data-edge-id", edge.edge.id);
    group.setAttribute("data-kind", edge.edge.kind);
    if (edge.dimmed) group.setAttribute("opacity", "0.25");

    const track = document.createElementNS(SVG_NS, "path");
    track.setAttribute("class", "burrow-dag-edge-track");
    track.setAttribute("d", edge.path);
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", trackColor);
    track.setAttribute("stroke-width", edge.edge.kind === "sql" || edge.edge.kind === "cross-stage" ? "1.5" : "1.25");
    track.setAttribute("stroke-linecap", "round");
    group.append(track);

    if (edge.flowing) {
      const flow = document.createElementNS(SVG_NS, "path");
      flow.setAttribute("class", "burrow-dag-edge-flow");
      flow.setAttribute("d", edge.path);
      flow.setAttribute("fill", "none");
      flow.setAttribute("stroke", liveColor);
      flow.setAttribute("stroke-width", "1.5");
      flow.setAttribute("stroke-linecap", "round");
      flow.setAttribute("stroke-dasharray", edge.dashArray);
      flow.setAttribute("stroke-dashoffset", "0");
      flow.setAttribute("opacity", String(edge.opacity));
      group.append(flow);
    }

    if (edge.arrow) {
      const arrow = document.createElementNS(SVG_NS, "path");
      arrow.setAttribute("class", "burrow-dag-arrow");
      arrow.setAttribute("d", edge.arrow.d);
      arrow.setAttribute("fill", edge.flowing ? liveColor : trackColor);
      group.append(arrow);
    }
    layer.append(group);
  }

  const clusterLayer = world.querySelector(":scope > .burrow-dag-cluster-layer");
  if (clusterLayer?.nextSibling) world.insertBefore(layer, clusterLayer.nextSibling);
  else world.insertBefore(layer, world.firstChild);
}

function dagExportData(dag: DagInput, metrics: StageMetric[] | undefined, graph: RenderGraph, layout: LayoutResult, scene: Scene) {
  return {
    format: "burrow-dagviz-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    // Preserve the complete Spark response, including planDescription, node metrics and source edges.
    sourcePayload: dag,
    stageMetrics: metrics ?? null,
    dagViz: {
      graph: {
        hash: graph.hash,
        kind: graph.kind,
        granularity: graph.granularity,
        jobId: graph.jobId,
        nodes: graph.nodes,
        edges: graph.edges,
        clusters: graph.clusters,
        sizes: Object.fromEntries(graph.sizes),
        large: graph.large,
        warnings: graph.warnings,
        notes: graph.notes,
        inferred: graph.inferred,
      },
      layout: {
        hash: layout.hash,
        width: layout.width,
        height: layout.height,
        nodes: Object.fromEntries(layout.nodes),
        clusters: Object.fromEntries(layout.clusters),
        // Routed world-space points retain the actual edge paths used by DagViz.
        edges: Object.fromEntries(layout.edges),
        durationMs: layout.durationMs,
        ran: layout.ran,
        rung: layout.rung,
        ladderName: layout.ladderName,
      },
      scene: {
        nodes: scene.nodes,
        clusters: scene.clusters,
        edges: scene.edges,
        totals: scene.totals,
        warnings: scene.warnings,
        notes: scene.notes,
        digest: scene.digest,
      },
    },
  };
}

/** Serialize the current rendered graph with computed styles and its complete inspectable data payload. */
export function serializeDagSvg(
  source: SVGSVGElement,
  dag: DagInput,
  metrics: StageMetric[] | undefined,
  graph: RenderGraph,
  layout: LayoutResult,
  scene: Scene,
  host: HTMLElement,
  includeCanvasEdges: boolean,
): string | null {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const width = Math.ceil(layout.width);
  const height = Math.ceil(layout.height);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.removeAttribute("class");
  clone.removeAttribute("aria-describedby");

  const world = Array.from(clone.children).find((child) => child.localName === "g") as SVGGElement | undefined;
  if (!world) return null;
  world.removeAttribute("transform");

  const originals = [source, ...Array.from(source.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (let index = 0; index < originals.length; index += 1) {
    const original = originals[index];
    const copy = copies[index] as SVGElement | undefined;
    if (!original || !copy) continue;
    const styles = window.getComputedStyle(original);
    for (const property of SVG_EXPORT_STYLES) {
      const value = styles.getPropertyValue(property);
      if (value) copy.style.setProperty(property, value);
    }
  }

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", window.getComputedStyle(host).backgroundColor);
  clone.insertBefore(background, world);
  if (includeCanvasEdges) appendCanvasEdgesForExport(world, scene.edges, host);
  const metadata = document.createElementNS(SVG_NS, "metadata");
  metadata.setAttribute("id", "burrow-dagviz-export");
  metadata.textContent = JSON.stringify(dagExportData(dag, metrics, graph, layout, scene));
  clone.append(metadata);
  return new XMLSerializer().serializeToString(clone);
}
