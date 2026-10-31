/**
 * SVG edge layer + the canvas fallback for very large graphs.
 *
 * The SVG layer draws every edge as three elements (track, flow, hit target) plus an arrow, and it is the only layer
 * that carries pointer semantics. Past `CANVAS_THRESHOLD` nodes the tracks and flow animation move to a single canvas:
 * 500+ edges × 3 elements is where Chromium's style/layout work starts to dominate frame time, and a canvas draw of
 * 3000 polyline segments is one paint.
 *
 * The canvas layer receives the *same* scene geometry, so switching strategies never changes what the graph means.
 */
import { memo, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { EdgeVisual } from "../render/scene";
import type { Viewport } from "../render/viewport";
import type { Size } from "../render/viewport";
import { CANVAS_THRESHOLD, HARD_LIMIT } from "../dag-model";

/** Which layers are used for a graph of this size; also the documented degradation strategy. */
export interface RenderStrategy {
  edges: "svg" | "canvas";
  /** nodes lose their text/badges (kept: body, spine, progress) */
  plainNodes: boolean;
  /** edge labels (shuffle bytes) suppressed */
  edgeLabels: boolean;
  reason: string;
}

export function renderStrategy(nodeCount: number): RenderStrategy {
  if (nodeCount > HARD_LIMIT) {
    return {
      edges: "canvas",
      plainNodes: true,
      edgeLabels: false,
      reason: `${nodeCount} nodes: canvas edges, simplified nodes (no labels) — hover/drawer still give every value`,
    };
  }
  if (nodeCount > CANVAS_THRESHOLD) {
    return {
      edges: "canvas",
      plainNodes: false,
      edgeLabels: false,
      reason: `${nodeCount} nodes: edges on canvas, labels limited to the prioritised subset`,
    };
  }
  return { edges: "svg", plainNodes: false, edgeLabels: true, reason: `${nodeCount} nodes: full SVG` };
}

/** A custom property on an SVG element: `style` cannot express `--x` in its TS type, hence the cast. */
function flowStyle(edge: EdgeVisual): CSSProperties {
  const vars = {
    "--dash-travel": `${edge.travel}px`,
    "--flow-opacity": `${edge.opacity}`,
    strokeDasharray: edge.dashArray,
    animationDuration: `${edge.animationSeconds}s`,
  };
  return vars as CSSProperties;
}

export interface EdgeLayerProps {
  edges: readonly EdgeVisual[];
  showLabels: boolean;
  interactive: boolean;
  onHover: (id: string | null) => void;
  onActivate: (edge: EdgeVisual) => void;
}

interface EdgeProps {
  edge: EdgeVisual;
  showLabels: boolean;
  interactive: boolean;
  onHover: (id: string | null) => void;
  onActivate: (edge: EdgeVisual) => void;
}

/** A progress tick creates fresh visuals; an edge only needs to re-render when its own drawing inputs changed. */
function sameEdgeProps(prev: EdgeProps, next: EdgeProps): boolean {
  if (prev.showLabels !== next.showLabels || prev.interactive !== next.interactive) return false;
  const a = prev.edge;
  const b = next.edge;
  if (a === b) return true;
  if (a.path !== b.path || a.dashArray !== b.dashArray) return false;
  if (
    a.flowing !== b.flowing ||
    a.intensity !== b.intensity ||
    a.opacity !== b.opacity ||
    a.animationSeconds !== b.animationSeconds ||
    a.travel !== b.travel ||
    a.selected !== b.selected ||
    a.hovered !== b.hovered ||
    a.dimmed !== b.dimmed
  ) {
    return false;
  }
  const la = a.labels[0];
  const lb = b.labels[0];
  if (la?.text !== lb?.text || la?.x !== lb?.x || la?.y !== lb?.y) return false;
  return a.arrow?.d === b.arrow?.d;
}

const Edge = memo(function Edge({ edge: e, showLabels, interactive, onHover, onActivate }: EdgeProps) {
  const label = e.labels[0];
  return (
    <g
      className="burrow-dag-edge"
      data-edge-id={e.edge.id}
      data-kind={e.edge.kind}
      data-flowing={e.flowing}
      data-hovered={e.hovered}
      data-selected={e.selected}
      data-dimmed={e.dimmed}
    >
      <path className="burrow-dag-edge-track" d={e.path} />
      {e.flowing ? <path className="burrow-dag-edge-flow" d={e.path} style={flowStyle(e)} /> : null}
      {e.arrow ? <path className="burrow-dag-arrow" d={e.arrow.d} /> : null}
      {interactive ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only hit target; the focusable edge list is the keyboard equivalent.
        <path
          className="burrow-dag-edge-hit"
          d={e.path}
          onPointerEnter={() => onHover(e.edge.id)}
          onPointerLeave={() => onHover(null)}
          onClick={(ev) => {
            ev.stopPropagation();
            onActivate(e);
          }}
        />
      ) : null}
      {showLabels && label ? (
        <g data-label="edge">
          <rect
            className="burrow-dag-edge-label-bg"
            x={label.x - 5}
            y={label.y - 2}
            width={label.width + 10}
            height={14}
            rx={4}
            fill="var(--ground)"
            opacity={0.86}
          />
          <text className="burrow-dag-edge-label" x={label.x} y={label.y + 9}>
            {label.text}
          </text>
        </g>
      ) : null}
    </g>
  );
}, sameEdgeProps);
function sameEdgeCollectionProps(prev: EdgeLayerProps, next: EdgeLayerProps): boolean {
  if (
    prev.showLabels !== next.showLabels ||
    prev.interactive !== next.interactive ||
    prev.onHover !== next.onHover ||
    prev.onActivate !== next.onActivate
  ) {
    return false;
  }
  if (prev.edges === next.edges) return true;
  if (prev.edges.length !== next.edges.length) return false;
  for (let i = 0; i < prev.edges.length; i += 1) {
    if (prev.edges[i] !== next.edges[i]) return false;
  }
  return true;
}

const EdgeBatch = memo(function EdgeBatch({ edges, showLabels, interactive, onHover, onActivate }: EdgeLayerProps) {
  return edges.map((e) => (
    <Edge key={e.edge.id} edge={e} showLabels={showLabels} interactive={interactive} onHover={onHover} onActivate={onActivate} />
  ));
}, sameEdgeCollectionProps);

export const EdgeLayer = memo(function EdgeLayer({ edges, showLabels, interactive, onHover, onActivate }: EdgeLayerProps) {
  const batches: EdgeVisual[][] = [];
  let previousStage: number | null | undefined;
  let current: EdgeVisual[] | null = null;
  for (const edge of edges) {
    const stage = edge.edge.fromStage ?? null;
    if (!current || stage !== previousStage) {
      current = [];
      batches.push(current);
      previousStage = stage;
    }
    current.push(edge);
  }
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: the SVG edge layer is a pointer-only surface; the focusable edge list is the keyboard equivalent.
    <g className="burrow-dag-edges" aria-hidden="true">
      {batches.map((batch) => (
        <EdgeBatch
          key={batch[0]!.edge.id}
          edges={batch}
          showLabels={showLabels}
          interactive={interactive}
          onHover={onHover}
          onActivate={onActivate}
        />
      ))}
    </g>
  );
}, sameEdgeCollectionProps);

export interface CanvasEdgeLayerProps {
  edges: readonly EdgeVisual[];
  viewport: Viewport;
  size: Size;
  reducedMotion: boolean;
  /** monotonic ms used to advance the dash phase; ignored under reduced motion */
  now: number;
  /** the pane is on screen; offscreen the loop is stopped and one static frame is painted */
  inView?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Dash phase for one frame: distance travelled = speed × elapsed, wrapped into the dash cycle. */
export function dashPhase(elapsedMs: number, cycle: number, speedPxPerSec: number): number {
  if (cycle <= 0) return 0;
  const travelled = (elapsedMs / 1000) * speedPxPerSec;
  return -(((travelled % cycle) + cycle) % cycle);
}

/** Canvas needs concrete colours: resolve the two tokens once through hidden probes. */
function resolveTokens(trackProbe: HTMLElement | null, flowProbe: HTMLElement | null): { track: string; live: string } {
  const track = (trackProbe && getComputedStyle(trackProbe).backgroundColor) || "rgba(127,127,127,0.35)";
  const live = (flowProbe && getComputedStyle(flowProbe).backgroundColor) || "rgba(120,200,220,0.9)";
  return { track, live };
}

export const CanvasEdgeLayer = memo(function CanvasEdgeLayer({
  edges,
  viewport,
  size,
  reducedMotion,
  now,
  inView = true,
  className,
  style,
}: CanvasEdgeLayerProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const trackProbe = useRef<HTMLSpanElement | null>(null);
  const flowProbe = useRef<HTMLSpanElement | null>(null);
  /* `now` is a 1 Hz sample used only as a phase origin. Keeping it in a ref instead of the dependency list stops the
     rAF loop from being torn down and rebuilt every second. */
  const nowRef = useRef(now);
  nowRef.current = now;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(size.width));
    const h = Math.max(1, Math.round(size.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { track, live } = resolveTokens(trackProbe.current, flowProbe.current);
    // three gates: reduced motion, a flowing edge to draw, and the pane being on screen
    const animated = !reducedMotion && inView && edges.some((e) => e.flowing);
    let raf = 0;
    const started = performance.now();
    const draw = (elapsedMs: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      for (const e of edges) {
        if (e.points.length < 2) continue;
        ctx.beginPath();
        const first = { x: (e.points[0]!.x - viewport.x) * viewport.scale, y: (e.points[0]!.y - viewport.y) * viewport.scale };
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < e.points.length; i++) {
          const p = e.points[i]!;
          ctx.lineTo((p.x - viewport.x) * viewport.scale, (p.y - viewport.y) * viewport.scale);
        }
        ctx.globalAlpha = e.dimmed ? 0.4 : 1;
        ctx.strokeStyle = e.flowing ? live : track;
        ctx.lineWidth = Math.max(0.6, (e.flowing ? 1.5 : 1) * Math.min(1.6, Math.max(0.6, viewport.scale)));
        if (e.flowing) {
          // same dash grammar as the SVG path: static texture under reduced motion, travelling while producing
          ctx.setLineDash(e.dashArray.split(" ").map(Number));
          ctx.lineDashOffset = reducedMotion ? 0 : dashPhase(elapsedMs, e.travel, 20 + e.intensity * 90);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    };
    draw(0);
    if (animated) {
      const loop = (): void => {
        draw(performance.now() - started + nowRef.current);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [edges, viewport, size, reducedMotion, inView]);
  const probeStyle: CSSProperties = { position: "absolute", width: 0, height: 0, visibility: "hidden", pointerEvents: "none" };
  return (
    <>
      <canvas ref={ref} className={className} style={style} />
      <span ref={trackProbe} aria-hidden="true" style={{ ...probeStyle, background: "var(--seam-strong)" }} />
      <span ref={flowProbe} aria-hidden="true" style={{ ...probeStyle, background: "var(--live)" }} />
    </>
  );
});
