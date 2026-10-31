/**
 * `<DagView>` — the DAG engine's public component.
 *
 * Responsibilities, in order of importance:
 *   1. adapt (`Dag` / SQL plan) → render graph → cached worker layout, and never block the main thread on layout
 *   2. pan / zoom / fit / minimap / semantic zoom, driven by a pure viewport module
 *   3. live progress: metrics join, flow readings, diff-driven flashes (all motion gated on reduced-motion/parity)
 *   4. a11y: `role="tree"` + `role="group"` per scope, roving tabindex, Home/End/arrows/Enter, an edge list for screen
 *      readers, aria-labels that carry status + counts, and a live region for progress announcements
 *   5. honest states: loading / empty / error / partial (no REST metrics ⇒ `granularity:"stage"` fallback still reads)
 *
 * It deliberately does not use the router or the query layer: the embedding route passes data in and gets events out.
 */
import { ChevronDown } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import "../dag.css";
import { cn } from "~/lib/cn";
import { useInView } from "~/lib/in-view";
import { fmtInt, fmtPct } from "~/lib/format";
import { download } from "~/ui/data-table/export";
import { useMotion } from "./hooks";
import { useElementSize, useRafValue, useSampleClock } from "./hooks";
import { layoutClient } from "../layout/client";
import { toRenderGraph } from "../layout/adapt";
import { indexStageMetrics, stageProgress } from "../metrics";
import type { StageMetric } from "../metrics";
import { flowByProducer } from "../metrics";
import type { StageVisual } from "../progress-diff";
import { FLASH_MS, JUMP_TWEEN_MS, diffProgress, weightedPercent } from "../progress-diff";
import type { Tone } from "~/design/status";
import { buildScene, labelCandidates, flattenCandidates } from "../render/scene";
import type { EdgeVisual, NodeVisual, Scene } from "../render/scene";
import { resolveLabelCollisions } from "../render/labels";
import type { LabelPlacement } from "../render/labels";
import {
  IDENTITY_VIEWPORT,
  INITIAL_FIT_MIN_SCALE,
  LEGIBLE_MIN_SCALE,
  centerOn,
  focusScale,
  fitViewport,
  initialViewport,
  minimapProjection,
  panBy,
  semanticLevel,
  viewportTransform,
  visibleWorldRect,
  zoomAt,
} from "../render/viewport";
import type { SemanticLevel, Viewport } from "../render/viewport";
import type { DagInput, GraphNode, LayoutResult, Rect, RenderGraph } from "../types";
import { DagNode, ClusterFrame } from "./nodes";
import { CanvasEdgeLayer, EdgeLayer, renderStrategy } from "./edges";
import { DagLegend, DagLoadingPanel, DagMinimap, DagStatePanel, DagToolbar, EdgeDrawer, EdgeListView, StageDrawer } from "./chrome";
import { serializeDagHtml } from "../export-html";
import { serializeDagSvg } from "../export-svg";
import { Button } from "~/ui/button";
import { MenuContent, MenuGroup, MenuGroupLabel, MenuRoot, MenuSeparator, MenuTrigger } from "~/ui/menu";

const NO_LABELS: LabelPlacement[] = [];

function intersectsRect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function boundsOfPoints(points: readonly { x: number; y: number }[]): Rect | null {
  const first = points[0];
  if (!first) return null;
  let minX = first.x;
  let maxX = minX;
  let minY = first.y;
  let maxY = minY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

interface DagNodeBucketProps {
  nodes: readonly GraphNode[];
  visuals: ReadonlyMap<string, NodeVisual>;
  labels: ReadonlyMap<string, LabelPlacement[]>;
  visibleNodeIds: ReadonlySet<string>;
  tabbableId: string | null;
  onActivate: (visual: NodeVisual) => void;
  onHover: (id: string | null) => void;
  onFocus: (id: string) => void;
}

function sameDagNodeBucketProps(prev: DagNodeBucketProps, next: DagNodeBucketProps): boolean {
  if (prev.nodes !== next.nodes || prev.onActivate !== next.onActivate || prev.onHover !== next.onHover || prev.onFocus !== next.onFocus) {
    return false;
  }
  for (const node of prev.nodes) {
    if (
      prev.visuals.get(node.id) !== next.visuals.get(node.id) ||
      prev.labels.get(node.id) !== next.labels.get(node.id) ||
      prev.visibleNodeIds.has(node.id) !== next.visibleNodeIds.has(node.id) ||
      (prev.tabbableId === node.id) !== (next.tabbableId === node.id)
    ) {
      return false;
    }
  }
  return true;
}

const DagNodeBucket = memo(function DagNodeBucket({
  nodes,
  visuals,
  labels,
  visibleNodeIds,
  tabbableId,
  onActivate,
  onHover,
  onFocus,
}: DagNodeBucketProps) {
  return nodes.map((node) => {
    const visual = visuals.get(node.id);
    if (!visual) return null;
    return (
      <DagNode
        key={node.id}
        visual={visual}
        labels={labels.get(node.id) ?? NO_LABELS}
        visible={visibleNodeIds.has(node.id)}
        tabbable={tabbableId === node.id}
        onActivate={onActivate}
        onHover={onHover}
        onFocus={onFocus}
      />
    );
  });
}, sameDagNodeBucketProps);

/**
 * Above this many nodes the per-node CSS transitions are switched off: animating the fill/width of several hundred SVG
 * shapes at once costs more than it communicates (measured: ~60% of frames over budget at 338 nodes with a 10 Hz
 * metric stream). Values stay exact — they simply update without a tween.
 */
const DENSE_NODE_LIMIT = 200;
const MINIMAP_W = 168;
const MINIMAP_H = 112;
/** Zoom step for the +/- buttons and keyboard: one "notch" of the wheel. */
const ZOOM_STEP = 1.25;

export interface DagSelection {
  from: number;
  to: number;
  fromStage?: number | null;
  toStage?: number | null;
}

export interface DagViewProps {
  dag: DagInput;
  className?: string;
  height?: number | string;
  /** stage metrics overlay (REST `/stages` rows, any shape `stageMetricsFromRest` accepts) */
  metrics?: StageMetric[];
  selectedStageId?: number | null;
  onSelectStage?: (stageId: number, attempt: number) => void;
  onSelectRdd?: (rddId: number) => void;
  onSelectEdge?: (edge: DagSelection) => void;
  ariaLabel?: string;
  /** job DAGs: force RDD-level (true) or stage-summary (false) rendering */
  expandStages?: boolean;
  /** injected by the embedding route to deep-link into the Spark pages */
  stageHref?: (stageId: number, attempt: number) => string;
  rddHref?: (rddId: number) => string;
  /** hides the legend (the preview route shows its own) */
  showLegend?: boolean;
  /** called after every successful scene build — the review route and the perf test hook in here */
  onScene?: (scene: Scene, layout: LayoutResult, graph: RenderGraph) => void;
  /** extra controls rendered inside the toolbar (e.g. the preview's simulate toggle) */
  toolbarExtras?: React.ReactNode;
  /** disables the internal live-metrics drive; the DAG still follows the `metrics` prop */
  onFrame?: (ms: number) => void;
}

export interface FlashState {
  id: string;
  tone: Tone;
  at: number;
}

export function DagView({
  dag,
  className,
  height = 420,
  metrics,
  selectedStageId,
  onSelectStage,
  onSelectRdd,
  onSelectEdge,
  ariaLabel,
  expandStages,
  stageHref,
  rddHref,
  showLegend = true,
  onScene,
  toolbarExtras,
}: DagViewProps) {
  const motion = useMotion();
  const graph = useMemo(() => toRenderGraph(dag, expandStages === undefined ? {} : { expandStages }), [dag, expandStages]);
  const { metricOrder, nodeIdsByRepresentative, representativeByStage } = useMemo(() => {
    const nodeIdsByStage = new Map<number, string[]>();
    for (const node of graph.nodes) {
      if (node.stageId == null) continue;
      const ids = nodeIdsByStage.get(node.stageId);
      if (ids) ids.push(node.id);
      else nodeIdsByStage.set(node.stageId, [node.id]);
    }
    const metricOrder: string[] = [];
    const nodeIdsByRepresentative = new Map<string, string[]>();
    const representativeByStage = new Map<number, string>();
    for (const [stageId, ids] of nodeIdsByStage) {
      const representative = ids[0];
      if (!representative) continue;
      metricOrder.push(representative);
      nodeIdsByRepresentative.set(representative, ids);
      representativeByStage.set(stageId, representative);
    }
    return { metricOrder, nodeIdsByRepresentative, representativeByStage };
  }, [graph.nodes]);
  const strategy = useMemo(() => renderStrategy(graph.nodes.length), [graph.nodes.length]);
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  /* Loops (running shimmer, flowing dashes, the canvas rAF) key off the pane being on screen. The pane already owns a
     ref for its size, so the two are merged rather than measured twice. */
  const [inViewRef, paneVisible] = useInView<HTMLDivElement>();
  const paneRef = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      inViewRef.current = el;
    },
    [containerRef, inViewRef],
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dagKeyboardRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeListOpen, setEdgeListOpen] = useState(false);
  const [flashes, setFlashes] = useState<readonly FlashState[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [layoutNote, setLayoutNote] = useState("laying out…");
  const [layoutRetry, setLayoutRetry] = useState(0);
  const panRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClickUntil = useRef(0);
  const [panning, setPanning] = useState(false);
  const flashTimers = useRef<number[]>([]);
  const prevMetricsRef = useRef<{ at: number; metrics: Map<number, StageMetric>; visuals: Map<string, StageVisual> } | null>(null);

  // Declared before the scene so the semantic level (and therefore the label plan) reads the same transform the
  // SVG is drawn with.
  const rafViewport = useRafValue(viewport);
  const effectiveViewport = rafViewport ?? IDENTITY_VIEWPORT;
  const level: SemanticLevel = semanticLevel(effectiveViewport.scale);

  // ---- layout ------------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLayoutError(null);
    layoutClient()
      .layout(graph)
      .then((result) => {
        if (cancelled) return;
        setLayout(result);
        setLayoutNote(`${result.ran === "worker" ? "worker" : "main thread"} · ${result.durationMs.toFixed(0)} ms`);
        setViewport(null); // a new graph starts fitted (the effect below does it once the pane is measured)
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLayoutError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [graph, layoutRetry]);

  // Initial view whenever a *different* graph arrives: fit when legible, else fit the height at a legible scale and
  // start on the first node. The first running stage may take over once, but only before the user moves the viewport.
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    didAutoFocusRef.current = false;
  }, [graph]);
  useEffect(() => {
    if (!layout || size.width <= 0 || size.height <= 0) return;
    const focus = graph.nodes[0] ? layout.nodes.get(graph.nodes[0].id) : undefined;
    setViewport((prev) => (prev !== null && prev.scale > 0 ? prev : initialViewport(layout, size, focus ?? null)));
  }, [layout, size, graph.nodes]);

  // ---- metrics join ------------------------------------------------------------------------------
  const metricsIndex = useMemo(() => indexStageMetrics(metrics ?? []), [metrics]);
  const sampledNow = useSampleClock(1000);
  const flow = useMemo(() => {
    const prev = prevMetricsRef.current;
    const windowMs = prev ? Math.min(10_000, Math.max(500, Date.now() - prev.at)) : 1000;
    return flowByProducer(graph.nodes, metricsIndex, prev?.metrics ?? new Map(), windowMs);
  }, [graph.nodes, metricsIndex]);

  // Diff-driven flashes + announcements. Build each stage visual once; all RDD nodes in a stage share its metrics.
  // Build transition data during the metrics render; scheduling it from an effect makes React reconcile this DAG twice per tick.
  const progressPlan = useMemo(() => {
    const visuals = new Map<string, StageVisual>();
    for (const [stageId, metric] of metricsIndex) {
      const representative = representativeByStage.get(stageId);
      if (!representative) continue;
      visuals.set(representative, {
        percent: stageProgress(metric).percent,
        status: metric.status,
        failed: metric.numFailedTasks,
      });
    }
    const prev = prevMetricsRef.current;
    const stagePlan = prev ? diffProgress(metricOrder, prev.visuals, visuals) : null;
    let plan = stagePlan;
    if (stagePlan) {
      const updates = [];
      for (const update of stagePlan.updates) {
        const nodeIds = nodeIdsByRepresentative.get(update.id);
        if (!nodeIds) {
          updates.push(update);
          continue;
        }
        for (const id of nodeIds) updates.push({ ...update, id });
      }
      const entering: string[] = [];
      for (const representative of stagePlan.entering) {
        const nodeIds = nodeIdsByRepresentative.get(representative);
        if (nodeIds) entering.push(...nodeIds);
        else entering.push(representative);
      }
      const exiting: string[] = [];
      for (const representative of stagePlan.exiting) {
        const nodeIds = nodeIdsByRepresentative.get(representative);
        if (nodeIds) exiting.push(...nodeIds);
        else exiting.push(representative);
      }
      plan = { ...stagePlan, updates, entering, exiting, unchanged: [] };
    }
    const tweenMs = new Map<string, number>();
    if (plan) for (const update of plan.updates) if (update.tweenMs > 0) tweenMs.set(update.id, update.tweenMs);
    return { visuals, plan, tweenMs };
  }, [metricsIndex, metricOrder, nodeIdsByRepresentative, representativeByStage]);
  const tweenMs = progressPlan.tweenMs;

  useEffect(() => {
    const { plan, visuals } = progressPlan;
    if (plan) {
      const next: FlashState[] = [];
      for (const update of plan.updates) if (update.flash) next.push({ id: update.id, tone: update.flash, at: Date.now() });
      for (const id of plan.entering) next.push({ id, tone: "live", at: Date.now() });
      if (next.length > 0) {
        setFlashes(next);
        for (const timer of flashTimers.current) window.clearTimeout(timer);
        flashTimers.current = [window.setTimeout(() => setFlashes([]), FLASH_MS)];
      }
      const finished = plan.updates.filter((update) => update.statusChanged && update.toPercent >= 100).length;
      const failed = plan.updates.filter((update) => update.flash === "fail").length;
      if (failed > 0) setAnnouncement(`${failed} stage${failed === 1 ? "" : "s"} failed`);
      else if (finished > 0) setAnnouncement(`${finished} stage${finished === 1 ? "" : "s"} completed`);
    }
    prevMetricsRef.current = { at: Date.now(), metrics: metricsIndex, visuals };
  }, [metricsIndex, progressPlan]);

  useEffect(
    () => () => {
      for (const t of flashTimers.current) window.clearTimeout(t);
    },
    [],
  );

  // ---- scene ------------------------------------------------------------------------------------

  const flashMap = useMemo(() => {
    const m = new Map<string, Tone>();
    for (const f of flashes) m.set(f.id, f.tone);
    return m;
  }, [flashes]);

  const scene = useMemo<Scene | null>(() => {
    if (!layout) return null;
    return buildScene({
      graph,
      layout,
      metrics: metricsIndex,
      flow,
      now: sampledNow,
      level,
      reducedMotion: !motion,
      selectedNodeId,
      selectedEdgeId,
      hoveredNodeId,
      hoveredEdgeId,
      flashes: flashMap,
      tweenMs,
      focusStageId: selectedStageId ?? null,
    });
  }, [
    graph,
    layout,
    metricsIndex,
    flow,
    sampledNow,
    level,
    motion,
    selectedNodeId,
    selectedEdgeId,
    hoveredNodeId,
    hoveredEdgeId,
    flashMap,
    selectedStageId,
    tweenMs,
  ]);

  // Task-summary text can change each progress tick; keep placements while its rendered width stays the same.
  // DagNode reads current summary text from the visual and clips it to the cached placement width.
  const labels = useMemo(() => {
    if (!scene) return { nodes: new Map<string, LabelPlacement[]>(), edges: new Map<string, LabelPlacement[]>() };
    const candidates = labelCandidates({ scene, level, showEdgeLabels: strategy.edgeLabels });
    const resolved = resolveLabelCollisions(flattenCandidates(candidates), 400);
    const placedIds = new Set(resolved.placed.map((p) => p.id));
    const nodes = new Map<string, LabelPlacement[]>();
    for (const [nodeId, list] of candidates.nodes) {
      const keep = list.filter((c) => placedIds.has(c.id));
      if (keep.length > 0) nodes.set(nodeId, keep);
    }
    const edges = new Map<string, LabelPlacement[]>();
    for (const [edgeId, list] of candidates.edges) {
      const keep = list.filter((c) => placedIds.has(c.id));
      if (keep.length > 0) edges.set(edgeId, keep);
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scene.digest` + `layout` fully determine the plan.
  }, [scene?.digest, level, strategy.edgeLabels, layout]);

  useEffect(() => {
    if (scene && layout) onScene?.(scene, layout, graph);
  }, [scene, layout, graph, onScene]);

  // For wide graphs, once something is running, open on it instead of on stage 0 (the "follow the work" default).
  // When the whole graph fits at a useful overview scale, preserve that full-graph framing.
  useEffect(() => {
    if (didAutoFocusRef.current || !layout || !scene) return;
    if (fitViewport(layout, size).scale >= INITIAL_FIT_MIN_SCALE) {
      didAutoFocusRef.current = true;
      return;
    }
    const running = scene.runningNodes[0];
    if (!running) return;
    didAutoFocusRef.current = true;
    setViewport((v) => {
      const base = v ?? IDENTITY_VIEWPORT;
      // Follow the work by *re-centring* at the scale the user is already at. Scaling the viewport up to
      // `focusScale` would zoom into the running node (measured: a 168x46 node in a 728x598 pane asks for
      // 3.03x, which clamped to MAX_SCALE and opened the synthetic-300 graph at 300%).
      return centerOn(running.rect, size, base.scale);
    });
  }, [layout, scene, size]);

  // ---- viewport interaction ----------------------------------------------------------------------
  const zoomBy = useCallback(
    (factor: number) => {
      if (size.width <= 0) return;
      didAutoFocusRef.current = true;
      setViewport((v) => {
        const base = v ?? IDENTITY_VIEWPORT;
        return zoomAt(base, factor, size.width / 2, size.height / 2);
      });
    },
    [size.height, size.width],
  );
  const pickMinimapPoint = useCallback(
    (worldX: number, worldY: number) => {
      didAutoFocusRef.current = true;
      setViewport((v) => {
        const base = v ?? IDENTITY_VIEWPORT;
        return centerOn({ x: worldX, y: worldY, width: 0, height: 0 }, size, base.scale);
      });
    },
    [size],
  );
  const startMinimapDrag = useCallback(() => {
    didAutoFocusRef.current = true;
    setPanning(true);
  }, []);
  const endMinimapDrag = useCallback(() => setPanning(false), []);

  const fitToView = useCallback(() => {
    if (!layout) return;
    didAutoFocusRef.current = true;
    setViewport(fitViewport(layout, size));
  }, [layout, size]);

  const focusStageCandidates = [
    selectedStageId,
    scene?.runningNodes.find((node) => node.node.stageId != null)?.node.stageId,
    graph.nodes.find((node) => node.stageId != null)?.stageId,
  ];
  const focusStageId =
    focusStageCandidates.find(
      (candidate): candidate is number => candidate != null && graph.nodes.some((node) => node.stageId === candidate),
    ) ?? null;
  const focusStage = useCallback(() => {
    if (!layout || focusStageId == null || size.width <= 0 || size.height <= 0) return;
    const stageNode = graph.nodes.find((node) => node.stageId === focusStageId);
    if (!stageNode) return;

    const stageRect =
      layout.clusters.get(`stage:${focusStageId}.${stageNode.attempt ?? 0}`) ??
      (() => {
        const rects = graph.nodes
          .filter((node) => node.stageId === focusStageId)
          .map((node) => layout.nodes.get(node.id))
          .filter((rect): rect is Rect => rect !== undefined);
        if (rects.length === 0) return undefined;
        const left = Math.min(...rects.map((rect) => rect.x));
        const top = Math.min(...rects.map((rect) => rect.y));
        const right = Math.max(...rects.map((rect) => rect.x + rect.width));
        const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
        return { x: left, y: top, width: right - left, height: bottom - top };
      })();
    if (!stageRect) return;

    didAutoFocusRef.current = true;
    const maxScale = size.width < 480 ? 0.75 : 1;
    const scale = Math.max(LEGIBLE_MIN_SCALE, Math.min(maxScale, focusScale(stageRect, size, 0.8)));
    setViewport(centerOn(stageRect, size, scale));
  }, [focusStageId, graph.nodes, layout, size]);

  const prepareDagHtmlExport = useCallback(() => setExporting(true), []);
  useEffect(() => {
    if (!exporting || !layout || !scene) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        const source = svgRef.current;
        const host = containerRef.current;
        if (!source || !host) return;
        const serializedSvg = serializeDagSvg(source, dag, metrics, graph, layout, scene, host, strategy.edges === "canvas");
        if (!serializedSvg) return;
        const stem = (ariaLabel ?? `${graph.kind} DAG`)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        const css = window.getComputedStyle(host);
        const token = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
        const html = serializeDagHtml(serializedSvg, ariaLabel ?? `${graph.kind} DAG`, {
          ground: token("--ground", "#0b1015"),
          surface: token("--fabric", "#11171d"),
          raised: token("--fabric-2", "#1a2028"),
          ink: token("--ink", "#e7edf2"),
          muted: token("--ink-3", "#9ba6b2"),
          line: token("--seam", "#2b343e"),
          accent: token("--live", "#43d4d5"),
        });
        download(`${stem || "dag"}.html`, "text/html", html);
      } finally {
        setExporting(false);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ariaLabel, dag, exporting, graph, layout, metrics, scene, strategy.edges]);

  // native non-passive wheel listener: React's onWheel is passive, so preventDefault there is a no-op
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (
        (e.target as Element | null)?.closest?.(
          ".burrow-dag-toolbar, .burrow-dag-minimap, .burrow-dag-drawer, [data-testid='dag-edge-list']",
        )
      )
        return;
      // Shift+wheel keeps page navigation possible while the pointer is over the graph; ordinary wheel and Ctrl/Meta
      // wheel zoom at the pointer (the latter is also the browser's trackpad-pinch gesture).
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const amount = e.deltaY || e.deltaX;
        let parent = el.parentElement;
        while (parent) {
          const overflowY = window.getComputedStyle(parent).overflowY;
          if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) {
            const canScroll = amount < 0 ? parent.scrollTop > 0 : parent.scrollTop + parent.clientHeight < parent.scrollHeight;
            if (canScroll && amount !== 0) {
              e.preventDefault();
              parent.scrollTop += amount;
            }
            return;
          }
          parent = parent.parentElement;
        }
        return;
      }
      if (e.deltaY === 0) return;
      e.preventDefault();
      didAutoFocusRef.current = true;
      const rect = el.getBoundingClientRect();
      const ax = e.clientX - rect.left;
      const ay = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      setViewport((v) => zoomAt(v ?? IDENTITY_VIEWPORT, factor, ax, ay));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerRef]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // Panning must work from *anywhere* on the canvas, including on top of a node — at readable zoom the graph covers
    // the whole pane, so excluding nodes would make dragging impossible. Chrome that owns its own gestures (toolbar,
    // minimap, drawer, edge list) is excluded instead; a press that does not move is still a click on the node.
    if (
      (e.target as Element).closest(
        ".burrow-dag-toolbar, .burrow-dag-minimap, .burrow-dag-drawer, button, a, input, select, [data-testid='dag-edge-list']",
      )
    )
      return;
    didAutoFocusRef.current = true;
    panRef.current = { x: e.clientX, y: e.clientY, moved: false };
    // Deliberately no setPointerCapture here: capturing on pointerdown makes Chromium retarget the *click* to the
    // capturing element, so a plain click on a node would never open the drawer. Capture happens lazily below, as soon
    // as the press turns into a drag — which is exactly when we want the click suppressed.
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (!pan) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 3) return;
      pan.moved = true;
      setPanning(true);
      if (typeof e.currentTarget.hasPointerCapture === "function" && !e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    }
    pan.x = e.clientX;
    pan.y = e.clientY;
    setViewport((v) => panBy(v ?? IDENTITY_VIEWPORT, dx, dy));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (pan?.moved) {
      // A drag that ends on a node would otherwise also fire that node's click: suppress the click that follows.
      suppressClickUntil.current = Date.now() + 320;
    } else if (pan) {
      // A press that never moved is a click. On a node or an edge the element's own handler picks the selection;
      // anywhere else on the canvas it clears both drawers, which is what clicking the background is expected to do
      // (pointerdown already ignores the chrome, so a click in the drawer, toolbar or minimap never reaches here).
      if (!(e.target as Element).closest(".burrow-dag-node, .burrow-dag-edge")) {
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
      }
    }
    panRef.current = null;
    setPanning(false);
    // jsdom implements neither pointer-capture method; real browsers always do.
    if (typeof e.currentTarget.hasPointerCapture === "function" && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // ---- keyboard ----------------------------------------------------------------------------------
  const navOrder = useMemo(() => {
    if (!layout) return [] as GraphNode[];
    const nodes = [...graph.nodes];
    nodes.sort((a, b) => {
      const aRect = layout.nodes.get(a.id);
      const bRect = layout.nodes.get(b.id);
      return (aRect?.x ?? 0) - (bRect?.x ?? 0) || (aRect?.y ?? 0) - (bRect?.y ?? 0) || (a.id < b.id ? -1 : 1);
    });
    return nodes;
  }, [graph.nodes, layout]);

  const focusedIdRef = useRef<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const onFocusNode = useCallback((id: string) => {
    focusedIdRef.current = id;
    setFocusedId(id);
  }, []);
  const tabbableId = focusedId ?? navOrder[0]?.id ?? null;

  const focusNode = useCallback(
    (id: string, opts: { center?: boolean } = {}) => {
      const target = navOrder.find((n) => n.id === id);
      if (!target) return;
      didAutoFocusRef.current = true;
      const rect = layout?.nodes.get(target.id) ?? { x: 0, y: 0, width: 0, height: 0 };
      focusedIdRef.current = id;
      setFocusedId(id);
      const el = svgRef.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`);
      el?.focus({ preventScroll: true });
      if (opts.center === false || !size.width) return;
      setViewport((v) => {
        const base = v ?? IDENTITY_VIEWPORT;
        const visible = visibleWorldRect(base, size);
        const inside =
          rect.x >= visible.x &&
          rect.y >= visible.y &&
          rect.x + rect.width <= visible.x + visible.width &&
          rect.y + rect.height <= visible.y + visible.height;
        if (inside) return base;
        return centerOn(rect, size, base.scale);
      });
    },
    [layout, navOrder, size],
  );

  const step = useCallback(
    (delta: number) => {
      if (navOrder.length === 0) return;
      const current = focusedId ?? navOrder[0]?.id ?? "";
      const idx = navOrder.findIndex((n) => n.id === current);
      const nextIdx = Math.min(navOrder.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta));
      const next = navOrder[nextIdx];
      if (next) focusNode(next.id);
    },
    [focusNode, focusedId, navOrder],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      didAutoFocusRef.current = true;
      const shift = e.shiftKey;
      switch (e.key) {
        case "ArrowDown":
        case "ArrowRight":
          if (shift) {
            setViewport((v) => panBy(v ?? IDENTITY_VIEWPORT, -40, 0));
          } else step(1);
          e.preventDefault();
          break;
        case "ArrowUp":
        case "ArrowLeft":
          if (shift) {
            setViewport((v) => panBy(v ?? IDENTITY_VIEWPORT, 40, 0));
          } else step(-1);
          e.preventDefault();
          break;
        case "Home":
          if (navOrder[0]) focusNode(navOrder[0].id);
          e.preventDefault();
          break;
        case "End":
          if (navOrder.length > 0) focusNode(navOrder[navOrder.length - 1]!.id);
          e.preventDefault();
          break;
        case "+":
        case "=":
          zoomBy(ZOOM_STEP);
          e.preventDefault();
          break;
        case "-":
        case "_":
          zoomBy(1 / ZOOM_STEP);
          e.preventDefault();
          break;
        case "0":
          fitToView();
          e.preventDefault();
          break;
        case "Escape":
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
          break;
        default:
          break;
      }
    },
    [fitToView, focusNode, navOrder, step, zoomBy],
  );

  useEffect(() => {
    const element = dagKeyboardRef.current;
    if (!element) return;
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  // ---- actions -----------------------------------------------------------------------------------
  const activateNode = useCallback(
    (visual: NodeVisual) => {
      if (Date.now() < suppressClickUntil.current) return; // the press was a pan, not a selection
      setSelectedEdgeId(null);
      setSelectedNodeId(visual.node.id);
      if (visual.node.stageId != null) onSelectStage?.(visual.node.stageId, visual.node.attempt ?? 0);
      if (visual.node.kind === "rdd" && visual.node.ref != null) onSelectRdd?.(visual.node.ref);
    },
    [onSelectRdd, onSelectStage],
  );

  const activateEdge = useCallback(
    (edge: EdgeVisual) => {
      if (Date.now() < suppressClickUntil.current) return;
      setSelectedNodeId(null);
      setSelectedEdgeId(edge.edge.id);
      onSelectEdge?.({
        from: edge.edge.fromRef ?? 0,
        to: edge.edge.toRef ?? 0,
        fromStage: edge.edge.fromStage,
        toStage: edge.edge.toStage,
      });
    },
    [onSelectEdge],
  );

  // ---- memoised node rows ------------------------------------------------------------------------
  /**
   * Accessibility tree: nodes grouped by their compound scope, nested exactly like the layout
   * (root → stage container → operation scope), so `aria-level` and the group names describe the real structure.
   */
  // Group graph nodes, not per-tick visuals; the tree structure changes only when the graph does.
  const nodeGroups = useMemo(() => {
    const nodesByCluster = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
      const key = node.clusterId ?? "__root__";
      const bucket = nodesByCluster.get(key);
      if (bucket) bucket.push(node);
      else nodesByCluster.set(key, [node]);
    }
    const childrenOf = new Map<string, typeof graph.clusters>();
    for (const c of graph.clusters) {
      const key = c.parentId ?? "__root__";
      const bucket = childrenOf.get(key);
      if (bucket) bucket.push(c);
      else childrenOf.set(key, [c]);
    }
    return { nodesByCluster, childrenOf };
  }, [graph.nodes, graph.clusters]);

  const selectedVisual = selectedNodeId && scene ? (scene.byId.get(selectedNodeId) ?? null) : null;
  const selectedEdgeVisual = selectedEdgeId && scene ? (scene.edgeById.get(selectedEdgeId) ?? null) : null;
  const selectedMetric = selectedVisual?.node.stageId != null ? (metricsIndex.get(selectedVisual.node.stageId) ?? null) : null;
  const chain = useMemo(() => {
    if (!selectedVisual?.node.stageId) return [];
    return graph.nodes
      .filter((n) => n.kind === "rdd" && n.stageId === selectedVisual.node.stageId)
      .sort((a, b) => (a.ref ?? 0) - (b.ref ?? 0));
  }, [graph.nodes, selectedVisual]);

  // Offscreen edge graphics are culled below; keep the reported count over the complete scene.
  const flowingEdgeCount = useMemo(() => (scene?.edges ?? []).reduce((n, e) => (e.flowing ? n + 1 : n), 0), [scene]);

  const totalsPercent = weightedPercent(scene?.totals ?? { done: 0, total: 0, active: 0, failed: 0 });
  const viewRect = useMemo(() => visibleWorldRect(effectiveViewport, size), [effectiveViewport, size]);
  const overscan = 160 / Math.max(effectiveViewport.scale, 0.001);
  const cullRect = useMemo<Rect>(
    () => ({
      x: viewRect.x - overscan,
      y: viewRect.y - overscan,
      width: viewRect.width + overscan * 2,
      height: viewRect.height + overscan * 2,
    }),
    [viewRect, overscan],
  );
  const visibleNodeIds = useMemo(() => {
    const visible = new Set<string>();
    if (!layout) return visible;
    for (const node of graph.nodes) {
      const rect = layout.nodes.get(node.id);
      if (!rect || intersectsRect(rect, cullRect)) visible.add(node.id);
    }
    return visible;
  }, [graph.nodes, layout, cullRect]);
  const allNodeIds = useMemo(() => new Set(graph.nodes.map((node) => node.id)), [graph.nodes]);
  const renderedNodeIds = exporting ? allNodeIds : visibleNodeIds;
  const visibleEdgeIds = useMemo(() => {
    const visible = new Set<string>();
    if (!layout) return visible;
    for (const edge of graph.edges) {
      const bounds = boundsOfPoints(layout.edges.get(edge.id) ?? []);
      if (!bounds || intersectsRect(bounds, cullRect)) visible.add(edge.id);
    }
    return visible;
  }, [graph.edges, layout, cullRect]);
  const visibleEdges = useMemo(() => scene?.edges.filter((edge) => visibleEdgeIds.has(edge.edge.id)) ?? [], [scene?.edges, visibleEdgeIds]);
  const renderedEdges = exporting ? (scene?.edges ?? []) : visibleEdges;
  const minimap = useMemo(
    () => minimapProjection({ width: layout?.width ?? 0, height: layout?.height ?? 0 }, { width: MINIMAP_W, height: MINIMAP_H }),
    [layout],
  );
  const liveId = useId();

  function renderNodeGroups(clusterId: string, depth: number): React.ReactNode {
    if (!scene) return null;
    const direct = nodeGroups.nodesByCluster.get(clusterId) ?? [];
    const nested = nodeGroups.childrenOf.get(clusterId) ?? [];
    if (direct.length === 0 && nested.length === 0) return null;
    const label = clusterId === "__root__" ? "graph nodes" : (graph.clusters.find((c) => c.id === clusterId)?.label ?? clusterId);
    return (
      // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: <g> groups an operation scope; role="group" names it for screen readers.
      <g key={clusterId} role="group" aria-label={depth === 0 ? label : `${label} (scope)`} data-cluster={clusterId}>
        <DagNodeBucket
          nodes={direct}
          visuals={scene.byId}
          labels={labels.nodes}
          visibleNodeIds={renderedNodeIds}
          tabbableId={tabbableId}
          onActivate={activateNode}
          onHover={setHoveredNodeId}
          onFocus={onFocusNode}
        />
        {nested.map((c) => renderNodeGroups(c.id, depth + 1))}
      </g>
    );
  }

  const hasMetrics = metricsIndex.size > 0;
  const empty = graph.nodes.length === 0;

  return (
    <div className="burrow-dag-frame" style={{ height }}>
      <div
        ref={dagKeyboardRef}
        className={cn("burrow-dag", className)}
        style={{ height: "100%", width: "100%" }}
        data-level={level}
        data-panning={panning}
        data-visible={paneVisible}
        data-strategy={strategy.edges}
        // The SVG edge groups that carried `data-flowing` disappear above CANVAS_THRESHOLD, so the count stays
        // observable here for tests and assistive tech regardless of which layer draws the edges.
        data-flowing-edges={flowingEdgeCount}
        data-inferred={graph.inferred}
        data-dag-layout={layoutError ? "error" : layout ? "ready" : "pending"}
        data-dense={scene && scene.nodes.length > DENSE_NODE_LIMIT ? "true" : undefined}
        data-testid="dag-canvas"
      >
        <div className="burrow-dag-toolbar-slot">
          {layout ? (
            <DagToolbar
              scale={effectiveViewport.scale}
              onZoomIn={() => zoomBy(ZOOM_STEP)}
              onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
              onFit={fitToView}
              onExportHtml={prepareDagHtmlExport}
              exporting={exporting}
              totals={scene?.totals ?? { done: 0, total: 0, active: 0, failed: 0 }}
              percent={totalsPercent}
              layoutNote={layoutNote}
              nodeCount={graph.nodes.length}
              edgeCount={graph.edges.length}
              focusStageId={focusStageId}
              onFocusStage={focusStage}
              trailingControls={
                <>
                  {toolbarExtras}
                  <div className="burrow-dag-toolbar-extras burrow-dag-edge-menu">
                    <MenuRoot
                      open={edgeListOpen}
                      onOpenChange={(open) => {
                        setEdgeListOpen(open);
                        if (open) {
                          // Keep the edge menu and node/edge detail card from occupying the same small DAG pane.
                          setSelectedNodeId(null);
                          setSelectedEdgeId(null);
                        }
                      }}
                    >
                      <MenuTrigger
                        render={
                          <Button
                            size="sm"
                            variant={edgeListOpen ? "default" : "quiet"}
                            aria-label={`Edges (${graph.edges.length})`}
                            aria-expanded={edgeListOpen}
                          />
                        }
                      >
                        Edges <span className="burrow-dag-edge-count">({graph.edges.length})</span>
                        <ChevronDown
                          className={cn(
                            "size-3.5 text-ink-3 transition-transform duration-(--dur-fast) ease-(--ease-out)",
                            edgeListOpen && "rotate-180",
                          )}
                          aria-hidden="true"
                        />
                      </MenuTrigger>
                      <MenuContent className="max-h-[min(20rem,calc(100dvh-2rem))] w-64 overflow-y-auto">
                        <MenuGroup data-testid="dag-edge-list">
                          <MenuGroupLabel>Dependency edges</MenuGroupLabel>
                          <MenuSeparator />
                          <EdgeListView
                            edges={scene?.edges ?? []}
                            nodes={scene?.byId ?? new Map()}
                            onActivate={(edge) => {
                              activateEdge(edge);
                              setEdgeListOpen(false);
                            }}
                            metrics={metricsIndex}
                          />
                        </MenuGroup>
                      </MenuContent>
                    </MenuRoot>
                  </div>
                </>
              }
            />
          ) : null}
        </div>

        <div
          ref={paneRef}
          className="burrow-dag-stage"
          data-testid="dag-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoveredNodeId(null)}
        >
          {!layoutError && !empty ? (
            <DagLoadingPanel detail={`${graph.nodes.length} nodes · ${graph.edges.length} edges`} hidden={Boolean(layout)} />
          ) : null}
          {layoutError && !empty ? (
            <DagStatePanel
              title="Could not lay out this DAG"
              detail={`${layoutError} — the graph structure is still available in the drawer/list views.`}
              action={
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    setLayoutError(null);
                    setLayoutRetry((attempt) => attempt + 1);
                  }}
                >
                  Retry
                </Button>
              }
            />
          ) : null}
          {empty ? <DagStatePanel title="This DAG has no nodes" detail="Spark reported an empty graph for this job or stage." /> : null}

          <svg
            ref={svgRef}
            className="burrow-dag-svg"
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA graph pattern; the SVG is the interactive surface.
            role="tree"
            aria-label={ariaLabel ?? (graph.kind === "sql" ? "SQL plan DAG" : `${graph.kind} DAG`)}
            aria-describedby={`${liveId}-help`}
            width={size.width || undefined}
            height={size.height || undefined}
            onDoubleClick={fitToView}
          >
            <title>{ariaLabel ?? `${graph.kind} DAG with ${graph.nodes.length} nodes`}</title>
            <g transform={viewportTransform(effectiveViewport)}>
              {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the cluster frames are decoration; the node groups inside carry the a11y tree. */}
              <g className="burrow-dag-cluster-layer" aria-hidden="true">
                {scene?.clusters.map((c) => (
                  <ClusterFrame
                    key={c.cluster.id}
                    x={c.rect.x}
                    y={c.rect.y}
                    width={c.rect.width}
                    height={c.rect.height}
                    label={c.cluster.label}
                    detail={c.cluster.detail}
                    depth={c.depth}
                    dimmed={c.dimmed}
                  />
                ))}
              </g>
              {strategy.edges === "svg" && scene ? (
                <EdgeLayer
                  edges={renderedEdges}
                  showLabels={strategy.edgeLabels}
                  interactive
                  onHover={setHoveredEdgeId}
                  onActivate={activateEdge}
                />
              ) : null}
              {scene ? renderNodeGroups("__root__", 0) : null}
            </g>
          </svg>

          {strategy.edges === "canvas" && scene ? (
            <CanvasEdgeLayer
              edges={visibleEdges}
              viewport={effectiveViewport}
              size={size}
              reducedMotion={!motion}
              inView={paneVisible}
              now={sampledNow}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            />
          ) : null}

          {layout ? (
            <>
              <DagMinimap
                nodes={scene?.nodes ?? []}
                width={MINIMAP_W}
                height={MINIMAP_H}
                contentWidth={layout.width}
                contentHeight={layout.height}
                projection={minimap}
                viewRect={viewRect}
                onPick={pickMinimapPoint}
                onDragStart={startMinimapDrag}
                onDragEnd={endMinimapDrag}
              />
              {/* Notes that explain graph provenance and incomplete stage metrics. */}
              <div className="burrow-dag-hints">
                {graph.notes.length > 0 ? (
                  <button
                    type="button"
                    className="burrow-dag-hint text-left"
                    data-interactive="true"
                    aria-expanded={notesOpen}
                    onClick={() => setNotesOpen((v) => !v)}
                  >
                    {graph.notes.length} provenance note{graph.notes.length === 1 ? "" : "s"}
                    {notesOpen ? `: ${graph.notes.join("; ")}` : ""}
                  </button>
                ) : null}
                {!hasMetrics && !empty && graph.kind !== "sql" ? (
                  // Stage metrics are a stage-graph join; a SQL plan has none by design (its own accumulables are in the
                  // drawer), so this message was permanent noise on every SQL execution.
                  <div className="burrow-dag-hint" data-testid="dag-partial">
                    {graph.granularity === "stage"
                      ? "Structure only: this DAG came from the REST fallback, so there is no RDD detail."
                      : "Waiting for stage metrics — task progress appears as soon as the stage list loads."}
                  </div>
                ) : null}
              </div>
              {scene && scene.warnings.length > 0 ? (
                <div className="burrow-dag-warn" role="status" data-testid="dag-warnings">
                  {scene.warnings.length} data warning{scene.warnings.length === 1 ? "" : "s"}: {scene.warnings[0]}
                </div>
              ) : null}
            </>
          ) : null}

          <StageDrawer
            open={selectedVisual !== null}
            onClose={() => setSelectedNodeId(null)}
            node={selectedVisual}
            metric={selectedMetric}
            now={sampledNow}
            chain={chain}
            stageHref={
              selectedVisual?.node.stageId != null && stageHref
                ? stageHref(selectedVisual.node.stageId, selectedVisual.node.attempt ?? 0)
                : null
            }
            rddHref={
              selectedVisual?.node.kind === "rdd" && selectedVisual.node.ref != null && rddHref ? rddHref(selectedVisual.node.ref) : null
            }
          />
          <EdgeDrawer
            open={selectedEdgeVisual !== null}
            onClose={() => setSelectedEdgeId(null)}
            edge={selectedEdgeVisual}
            graphKind={graph.kind}
            metrics={metricsIndex}
            producer={selectedEdgeVisual ? (scene?.byId.get(selectedEdgeVisual.edge.from) ?? null) : null}
            consumer={selectedEdgeVisual ? (scene?.byId.get(selectedEdgeVisual.edge.to) ?? null) : null}
          />

          <p id={`${liveId}-help`} className="sr-only">
            Graph with {graph.nodes.length} nodes and {graph.edges.length} edges. Mouse wheel zooms at the pointer; scrolling beside the
            graph or Shift plus mouse wheel scrolls the page. Arrow keys move between nodes, Enter opens details, Shift plus arrow keys pan,
            plus and minus zoom, zero fits the graph.
          </p>
          <p className="sr-only" role="status" aria-live="polite">
            {announcement
              ? `${announcement}. ${fmtInt(scene?.totals.done ?? 0)} of ${fmtInt(scene?.totals.total ?? 0)} tasks complete, ${fmtPct(totalsPercent, 0)}.`
              : ""}
          </p>
          <span className="sr-only" data-testid="dag-sr-summary">
            {`nodes ${graph.nodes.length}; edges ${graph.edges.length}; running ${scene?.runningNodes.length ?? 0}; tasks ${scene?.totals.done ?? 0}/${scene?.totals.total ?? 0}`}
          </span>
        </div>
        <div className="burrow-dag-footer">{showLegend ? <DagLegend showFlow={hasMetrics} inferred={graph.inferred} /> : null}</div>
      </div>
    </div>
  );
}

export const DAG_ZOOM_STEP = ZOOM_STEP;
export const DAG_JUMP_TWEEN_MS = JUMP_TWEEN_MS;
