/**
 * Scene derivation: (graph, layout, metrics, viewport level) → everything the SVG needs to draw.
 *
 * Pure and memo-friendly: it is recomputed only when one of those inputs changes, and it never touches the DOM. The
 * renderer's job is then purely declarative, and the tests can assert the *meaning* (tone, status, segment widths,
 * flow intensity, label text) without parsing SVG.
 */
import { fmtBytes, fmtDuration, fmtInt } from "~/lib/format";
import { statusSpec } from "~/design/status";
import type { Shape } from "~/design/status";
import type { Tone } from "~/design/status";
import { progressSegments, stageDuration, stageProgress, stageStatusKey, stageTone } from "../metrics";
import type { FlowReading, StageMetric } from "../metrics";
import { arrowAt, flowDash, pathFromPoints, pointAlong, straightEdge } from "./paths";
import type { ArrowGeometry, Point } from "./paths";
import { hashString } from "../dag-model";
import { ellipsize, ellipsizeMonospace, measureMonospaceText, measureText } from "./labels";
import type { LabelCandidate } from "./labels";
import type { GraphCluster, GraphEdge, GraphNode, LayoutResult, Rect, RenderGraph } from "../types";
import type { SemanticLevel } from "./viewport";

/** Badge shown at the right of a node's title row. */
export interface NodeBadge {
  key: string;
  text: string;
  tone: Tone;
  /** accessible title, when the visible text alone is ambiguous */
  title?: string;
}

/** Height of the `.burrow-dag-badge` rect. */
export const BADGE_H = 14;

/** Status glyph box and the gap after it. The card's text column starts past both; `./react/glyph` draws at this size. */
export const GLYPH_SIZE = 12;
export const GLYPH_GAP = 6;

/** Card inset by kind: the RDD chip is narrower, so it uses a tighter pad. */
export function nodePad(kind: GraphNode["kind"]): number {
  return kind === "rdd" ? 10 : 12;
}

/**
 * Left edge of a card's text column. Exported because the label plan must place (and truncate) text at the same x the
 * renderer draws it: the plan used the bare pad, 18 px left of the real text start, which let an ellipsised title run
 * into the right-aligned badge row.
 */
export function textColumnStart(kind: GraphNode["kind"]): number {
  return nodePad(kind) + GLYPH_SIZE + GLYPH_GAP;
}

/**
 * Roomy cards carry a metadata row below the secondary line. Compact RDD cards keep metadata beside the title so it
 * stays clear of their progress bar.
 */
export const BADGE_ROW_MIN_HEIGHT = 84;

/** Badge widths are text-derived, so the row's width is knowable before it is drawn (the title ellipsis needs it). */
export function badgeWidth(text: string): number {
  return Math.min(96, 12 + text.length * 5.6);
}

/** The badges that fit in `maxWidth` and the row's ink width. The row stops at the first badge that overflows. */
export function fittedBadges(badges: readonly NodeBadge[], maxWidth: number): { count: number; width: number } {
  let cursor = 0;
  let count = 0;
  for (const b of badges) {
    const w = badgeWidth(b.text);
    if (cursor + w > maxWidth) break;
    cursor += w + 4;
    count += 1;
  }
  return { count, width: count > 0 ? cursor - 4 : 0 };
}

/** A badge row is drawn on cards this tall that have badges at all. */
export function showsBadgeRow(height: number, badgeCount: number): boolean {
  return height >= 40 && badgeCount > 0;
}

/**
 * Width the title may occupy: the card's text column, less the badge row when the badges share the title row. Exported
 * next to `fittedBadges` so the label plan and the renderer cannot disagree about where the title has to stop.
 */
export function titleUsableWidth(width: number, height: number, kind: GraphNode["kind"], badges: readonly NodeBadge[]): number {
  const pad = nodePad(kind);
  // Status and metric details now live on their own left-aligned rows, so the operator title always gets the full
  // text column instead of reserving space for right-aligned chips.
  void height;
  void badges;
  return Math.max(0, width - textColumnStart(kind) - pad);
}

export interface NodeRowGeometry {
  /** baseline of the title text */
  titleY: number;
  /** baseline of the secondary line */
  subY: number;
  /** baseline of the second quiet metadata line, when the card has room */
  metaY: number;
  /** top of the progress bar */
  progressY: number;
}

/**
 * The card's text rows. The same offsets drive the rendered labels, quiet metadata, and progress strip.
 */
export function nodeRowGeometry(height: number, kind: GraphNode["kind"]): NodeRowGeometry {
  const rdd = kind === "rdd";
  const compact = height < 72;
  const roomy = height >= 144;
  const titleY = compact ? 21 : roomy ? 47 : 24;
  const subY = compact ? 39 : roomy ? 81 : 52;
  return {
    titleY,
    subY,
    metaY: roomy ? 111 : 0,
    progressY: height - (roomy ? 25 : rdd ? 16 : 16),
  };
}

export interface NodeVisual {
  node: GraphNode;
  rect: Rect;
  tone: Tone;
  /** status key for the `spark.stage` domain in src/design/status.ts */
  status: string;
  /** glyph shape for that status, so the node carries status as shape+tone, never colour alone */
  statusShape: Shape;
  statusLabel: string;
  running: boolean;
  skipped: boolean;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  flash: Tone | null;
  percent: number;
  /** per-tick transition duration in ms; 0 leaves the stylesheet's own duration in charge */
  tweenMs: number;
  segments: { percent: number; tone: Tone; label: string }[];
  /** "18 / 24 tasks" (or null when there is no metric to speak of) */
  taskSummary: string | null;
  badges: NodeBadge[];
  /** one-line secondary text (chain summary / callsite / metric summary) */
  subText: string | null;
  /** node depth in the accessibility tree: 1 = top level, 2 = inside a cluster */
  depth: number;
  /** aria-labelledby text, built once so the DOM stays stable */
  ariaLabel: string;
  /** measured label candidates for this node at the current level (title + sub) */
  labels: LabelCandidate[];
  /** true when the node belongs to the currently selected/hovered stage neighbourhood */
  related: boolean;
}

export interface ClusterVisual {
  cluster: GraphCluster;
  rect: Rect;
  depth: number;
  dimmed: boolean;
}

export interface EdgeVisual {
  edge: GraphEdge;
  points: Point[];
  path: string;
  arrow: ArrowGeometry | null;
  flowing: boolean;
  intensity: number;
  opacity: number;
  dashArray: string;
  animationSeconds: number;
  travel: number;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  /** shuffle bytes crossing this edge (consumer's shuffle-read), formatted */
  shuffleLabel: string | null;
  labels: LabelCandidate[];
}

export interface Scene {
  nodes: NodeVisual[];
  byId: Map<string, NodeVisual>;
  clusters: ClusterVisual[];
  edges: EdgeVisual[];
  edgeById: Map<string, EdgeVisual>;
  /** the producers that are currently emitting — drives the "center on running stage" action */
  runningNodes: NodeVisual[];
  totals: { done: number; total: number; active: number; failed: number };
  warnings: string[];
  /** provenance notes from the adapter (e.g. inferred edges) */
  notes: string[];
  /**
   * Digest of every field the *label plan* depends on (text, priority inputs, edge values). Geometry lives in the
   * layout, so keying the label memo on (layout, level, digest) means a progress tick that changes no label text
   * costs zero label work — that is what keeps a 300-node DAG cheap while metrics stream.
   */
  digest: string;
}

export interface SceneInput {
  graph: RenderGraph;
  layout: LayoutResult;
  metrics: ReadonlyMap<number, StageMetric>;
  /** producer node id → flow reading */
  flow: ReadonlyMap<string, FlowReading>;
  now: number;
  level: SemanticLevel;
  reducedMotion: boolean;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hoveredNodeId: string | null;
  hoveredEdgeId: string | null;
  /** node id → one-shot flash tone (from the diff plan) */
  flashes: ReadonlyMap<string, Tone>;
  /** node id → the duration this progress tick should tween over (from the diff plan; 0 = the stylesheet default) */
  tweenMs?: ReadonlyMap<string, number>;
  /** stage id to keep in focus (dims unrelated nodes) */
  focusStageId: number | null;
}

const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Small content-addressed caches. A progress tick rebuilds every `NodeVisual`, so the *derived* pieces (segment list,
 * badge list, aria label) must come back with a **stable identity** when their inputs did not change: the node's memo
 * comparator then short-circuits on `prev === next` and React re-renders only the nodes that actually moved. Without
 * this, 338 nodes re-render per tick even though a tick touches a handful of them.
 */
/**
 * Structural diff state, keyed by the render graph (which `DagView` memoises, so it is stable for as long as the DAG
 * structure is). A tick changes a handful of nodes; without this, `buildScene` allocates a fresh `NodeVisual` for all
 * 338 of them and React then runs 338 comparator calls against brand-new objects. Instead each node has a cheap
 * *signature* over exactly the inputs its visual exposes; when the signature is unchanged the previous visual object is
 * handed back, so the memo comparator short-circuits on identity and only genuinely changed nodes re-render.
 */
interface NodeLabelSignature {
  kind: GraphNode["kind"];
  label: string;
  subTextKey: string;
  selected: boolean;
  hovered: boolean;
  running: boolean;
}

interface SceneDiffCache {
  nodes: Map<string, { signature: string; visual: NodeVisual }>;
  edges: Map<string, { signature: string; visual: EdgeVisual }>;
  nodeLabels: Map<string, NodeLabelSignature>;
  edgeLabels: Map<string, string>;
  digest: string;
  labelsInitialized: boolean;
}

const diffCache = new WeakMap<RenderGraph, SceneDiffCache>();

function diffStateFor(graph: RenderGraph): SceneDiffCache {
  const existing = diffCache.get(graph);
  if (existing) return existing;
  const fresh: SceneDiffCache = {
    nodes: new Map(),
    edges: new Map(),
    nodeLabels: new Map(),
    edgeLabels: new Map(),
    digest: "",
    labelsInitialized: false,
  };
  diffCache.set(graph, fresh);
  return fresh;
}
function labelSubTextKey(visual: NodeVisual, level: SemanticLevel): string {
  if (
    (visual.node.kind === "stage" || visual.node.kind === "fallback") &&
    visual.node.sublabel == null &&
    level !== "overview" &&
    visual.subText &&
    visual.rect.height > 34
  ) {
    const width = titleUsableWidth(visual.rect.width, visual.rect.height, visual.node.kind, []);
    const size = visual.rect.height >= 144 ? 14 : visual.rect.height < 72 ? 10.5 : 12.5;
    const placedText = width > 40 ? ellipsize(visual.subText, size, width) : "";
    return `width:${measureText(placedText, size)}`;
  }
  return visual.subText ?? "";
}

const badgeCache = new Map<string, NodeBadge[]>();
const labelCache = new Map<string, string>();
const CACHE_LIMIT = 4096;

function memo<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = build();
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * Everything a *stage's* metric determines, computed once per stage per change and shared by every node of that stage.
 * A job DAG has ~28 stages but ~338 nodes, so deriving per stage (rather than per node) cuts the per-tick string work
 * and allocation by an order of magnitude. `version` bumps only when the tuple changes, which lets per-node values
 * (badges, aria label) be cached behind a short `node|version` key.
 */
interface StageDerived {
  version: number;
  segments: { percent: number; tone: Tone; label: string }[];
  taskSummary: string | null;
  badges: NodeBadge[];
}

const stageCache = new Map<string, StageDerived>();
let stageVersionCounter = 1;
function stageDerived(
  stageId: number | undefined,
  metric: StageMetric | undefined,
  skipped: boolean,
  level: SemanticLevel,
  now: number,
): StageDerived {
  const durationSeconds = Math.round((stageDuration(metric, now) ?? 0) / 1000);
  const key = `${stageId}|${metric?.status}|${metric?.numCompleteTasks}|${metric?.numActiveTasks}|${metric?.numFailedTasks}|${metric?.numKilledTasks}|${metric?.numTasks}|${metric?.shuffleWriteBytes}|${metric?.shuffleReadBytes}|${durationSeconds}|${level}|${skipped}`;
  const hit = stageCache.get(key);
  if (hit) return hit;
  const progress = metric ? stageProgress(metric) : null;
  const value: StageDerived = {
    version: stageVersionCounter++,
    segments: progress ? progressSegments(progress) : [],
    taskSummary: taskSummaryOf(metric),
    badges: metricBadges(metric, level, now),
  };
  if (stageCache.size >= 512) stageCache.clear();
  stageCache.set(key, value);
  return value;
}

/** Neighbourhood of a node: itself plus every node one edge away (used for focus dimming). */
function relatedSet(graph: RenderGraph, focusId: string | null): Set<string> {
  const set = new Set<string>();
  if (!focusId) return set;
  set.add(focusId);
  for (const e of graph.edges) {
    if (e.from === focusId) set.add(e.to);
    else if (e.to === focusId) set.add(e.from);
  }
  return set;
}

/** Badges that come from the *metric*: shared by every node of the stage. */
function metricBadges(metric: StageMetric | undefined, level: SemanticLevel, now: number): NodeBadge[] {
  const badges: NodeBadge[] = [];
  if (metric?.shuffleWriteBytes) {
    badges.push({ key: "sw", text: `↑ ${fmtBytes(metric.shuffleWriteBytes)}`, tone: "fresh", title: "Shuffle write" });
  }
  if (metric?.shuffleReadBytes) {
    badges.push({ key: "sr", text: `↓ ${fmtBytes(metric.shuffleReadBytes)}`, tone: "fresh", title: "Shuffle read" });
  }
  const dur = stageDuration(metric, now);
  if (dur != null && dur > 0 && level === "detail") {
    badges.push({ key: "dur", text: fmtDuration(dur), tone: "idle", title: "Stage duration" });
  }
  return badges;
}

/** Badges that come from the *node*: cached behind `node|stageVersion`, so a tick rebuilds only changed stages. */
function nodeBadges(node: GraphNode, stage: StageDerived, level: SemanticLevel): NodeBadge[] {
  const badges: NodeBadge[] = [...stage.badges];
  if (node.cached) badges.push({ key: "cached", text: "cached", tone: "fresh", title: "RDD is cached in memory or on disk" });
  if (node.barrier) badges.push({ key: "barrier", text: "barrier", tone: "warn", title: "Barrier stage: all tasks synchronise" });
  if (node.determinism && node.determinism !== "determinate") {
    badges.push({ key: "det", text: node.determinism, tone: "warn", title: `${node.determinism} output ordering` });
  }
  if (node.skipped) badges.push({ key: "skipped", text: "skipped", tone: "idle", title: "Stage skipped: output already exists" });
  if (node.metrics && node.metrics.length > 0 && level === "detail") {
    badges.push({ key: "metrics", text: `${node.metrics.length} metrics`, tone: "idle" });
  }
  if (node.rddCount != null && node.rddCount > 0 && (node.kind === "stage" || node.kind === "fallback")) {
    badges.push({ key: "rdds", text: `${node.rddCount} RDD${node.rddCount === 1 ? "" : "s"}`, tone: "idle" });
  }
  return badges;
}

/** Human summary of a stage's task counts. Kept honest: no metric ⇒ no number invented. */
function taskSummaryOf(metric: StageMetric | undefined): string | null {
  if (!metric) return null;
  const p = stageProgress(metric);
  if (p.total === 0) return null;
  const parts = [`${fmtInt(p.done)} / ${fmtInt(p.total)} tasks`];
  if (p.active > 0) parts.push(`${fmtInt(p.active)} running`);
  if (p.failed > 0) parts.push(`${fmtInt(p.failed)} failed`);
  return parts.join(" · ");
}

function subTextFor(node: GraphNode, metric: StageMetric | undefined, level: SemanticLevel): string | null {
  if (node.kind === "stage" || node.kind === "fallback") {
    return node.sublabel ?? (level !== "overview" ? taskSummaryOf(metric) : null);
  }
  if (node.kind === "sql") return level === "overview" ? null : (node.sublabel ?? null);
  // RDD nodes: the callsite is the interesting second line, and only when there is room for it.
  if (level === "overview") return null;
  return node.sublabel ?? node.callsite ?? null;
}

function ariaLabelFor(node: GraphNode, metric: StageMetric | undefined, percent: number): string {
  const bits: string[] = [];
  if (node.kind === "stage" || node.kind === "fallback") bits.push(node.skipped ? `${node.label} (skipped)` : node.label);
  else if (node.kind === "sql") bits.push(`SQL operator ${node.label}`);
  else bits.push(`RDD ${node.label}`);
  if (node.stageId != null) bits.push(`stage ${node.stageId}`);
  if (metric) {
    const spec = statusSpec("spark.stage", stageStatusKey(metric, node.skipped === true));
    bits.push(spec.label);
    const p = stageProgress(metric);
    if (p.total > 0) bits.push(`${p.done} of ${p.total} tasks complete (${percent.toFixed(0)}%)`);
    if (p.failed > 0) bits.push(`${p.failed} failed`);
    if (metric.shuffleWriteBytes) bits.push(`shuffle write ${fmtBytes(metric.shuffleWriteBytes)}`);
    if (metric.shuffleReadBytes) bits.push(`shuffle read ${fmtBytes(metric.shuffleReadBytes)}`);
  } else if (node.skipped) {
    bits.push("skipped");
  }
  if (node.cached) bits.push("cached");
  if (node.barrier) bits.push("barrier stage");
  if (node.callsite) bits.push(node.callsite);
  return bits.join(", ");
}

/** Cluster depths are stable for a render graph; compute them once instead of rebuilding the cluster index per node. */
const clusterDepthCache = new WeakMap<RenderGraph, ReadonlyMap<string, number>>();

function clusterDepthsFor(graph: RenderGraph): ReadonlyMap<string, number> {
  const cached = clusterDepthCache.get(graph);
  if (cached) return cached;
  const byId = new Map(graph.clusters.map((cluster) => [cluster.id, cluster]));
  const depths = new Map<string, number>();
  for (const cluster of graph.clusters) {
    let depth = 1;
    let cur = byId.get(cluster.id);
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      depth += 1;
      cur = byId.get(cur.parentId);
    }
    depths.set(cluster.id, depth);
  }
  clusterDepthCache.set(graph, depths);
  return depths;
}

export function buildScene(input: SceneInput): Scene {
  const { graph, layout, metrics, flow, level, reducedMotion } = input;
  const diff = diffStateFor(graph);
  const related = relatedSet(graph, input.focusStageId != null ? (input.selectedNodeId ?? null) : null);
  const clusterDepths = clusterDepthsFor(graph);

  const nodes: NodeVisual[] = [];
  const byId = new Map<string, NodeVisual>();
  const totals = { done: 0, total: 0, active: 0, failed: 0 };
  const derivedByStage = new Map<number | undefined, Map<boolean, StageDerived>>();

  for (const node of graph.nodes) {
    if (node.kind === "ghost") {
      const rect = layout.nodes.get(node.id) ?? EMPTY_RECT;
      const depth = node.clusterId ? (clusterDepths.get(node.clusterId) ?? 1) : 1;
      const ghost: NodeVisual = {
        node,
        rect,
        tone: "idle",
        status: "GHOST",
        statusShape: "ring-dash",
        statusLabel: "Outside this page",
        running: false,
        skipped: true,
        selected: input.selectedNodeId === node.id,
        hovered: input.hoveredNodeId === node.id,
        dimmed: false,
        flash: null,
        percent: 0,
        tweenMs: 0,
        segments: [],
        taskSummary: null,
        badges: [],
        subText: node.sublabel ?? null,
        depth,
        ariaLabel: `${node.label}, referenced by an edge but not part of this page`,
        labels: [],
        related: true,
      };
      byId.set(node.id, ghost);
      nodes.push(ghost);
      continue;
    }
    const rect = layout.nodes.get(node.id) ?? EMPTY_RECT;
    const metric = node.stageId != null ? metrics.get(node.stageId) : undefined;
    const skipped = node.skipped === true || metric?.status === "SKIPPED";
    const p = metric ? stageProgress(metric) : null;
    const percent = p ? p.percent : skipped ? 0 : 0;
    // Status: REST metrics win; the payload's own status (fallback DAGs carry `stages[].status`) is the second
    // source; only then do we fall back to "pending".
    const status =
      node.kind === "sql"
        ? node.metrics && node.metrics.length > 0
          ? "COMPLETE"
          : "PENDING"
        : metric
          ? stageStatusKey(metric, skipped)
          : (node.status ?? (skipped ? "SKIPPED" : "PENDING"));
    const tone: Tone =
      node.kind === "sql"
        ? node.metrics && node.metrics.length > 0
          ? "fresh"
          : "idle"
        : metric
          ? stageTone(metric, skipped)
          : statusSpec("spark.stage", status).tone;
    if (p && !skipped) {
      totals.done += p.done;
      totals.total += p.total;
      totals.active += p.active;
      totals.failed += p.failed;
    }
    const depth = node.clusterId ? (clusterDepths.get(node.clusterId) ?? 1) : 1;
    const isRelated = !input.selectedNodeId || related.has(node.id);
    let bySkipped = derivedByStage.get(node.stageId);
    let derived = bySkipped?.get(skipped);
    if (!derived) {
      derived = stageDerived(node.stageId, metric, skipped, level, input.now);
      if (!bySkipped) {
        bySkipped = new Map();
        derivedByStage.set(node.stageId, bySkipped);
      }
      bySkipped.set(skipped, derived);
    }
    const selected = input.selectedNodeId === node.id;
    const hovered = input.hoveredNodeId === node.id;
    const flash = input.flashes.get(node.id) ?? null;
    const dimmed = input.selectedNodeId != null && !isRelated;
    // Everything this node's visual exposes that can change without the graph or the layout changing: the layout hash
    // (geometry), the semantic level (which badges/labels are drawn), the stage's metric version, the node's own flags
    // and the interaction state. Same signature ⇒ hand back the previous visual object, so the memo comparator
    // short-circuits on identity and only genuinely changed nodes re-render.
    const tweenMs = input.tweenMs?.get(node.id) ?? 0;
    const signature = `${layout.hash}|${level}|${derived.version}|${tweenMs}|${node.skipped === true ? 1 : 0}|${selected ? 1 : 0}${hovered ? 1 : 0}${dimmed ? 1 : 0}${isRelated ? 1 : 0}|${flash ?? ""}`;
    const cachedNode = diff.nodes.get(node.id);
    if (cachedNode && cachedNode.signature === signature) {
      byId.set(node.id, cachedNode.visual);
      nodes.push(cachedNode.visual);
      continue;
    }
    const visual: NodeVisual = {
      node,
      rect,
      tone,
      status,
      statusShape: statusSpec("spark.stage", status).shape,
      statusLabel: node.kind === "sql" ? "" : statusSpec("spark.stage", status).label,
      running: status === "ACTIVE" || status === "RUNNING",
      skipped,
      selected,
      hovered,
      dimmed,
      flash,
      percent,
      tweenMs,
      segments: derived.segments,
      taskSummary: derived.taskSummary,
      badges: memo(badgeCache, `${node.id}|${derived.version}`, () => nodeBadges(node, derived, level)),
      subText: subTextFor(node, metric, level),
      depth,
      ariaLabel: memo(labelCache, `${node.id}|${derived.version}|${status}`, () => ariaLabelFor(node, metric, percent)),
      labels: [],
      related: isRelated,
    };
    byId.set(node.id, visual);
    nodes.push(visual);
    diff.nodes.set(node.id, { signature, visual });
  }

  const clusters: ClusterVisual[] = [];
  for (const cluster of graph.clusters) {
    const rect = layout.clusters.get(cluster.id);
    if (!rect) continue;
    clusters.push({
      cluster,
      rect,
      depth: clusterDepths.get(cluster.id) ?? 1,
      dimmed: input.selectedNodeId != null && !nodes.some((n) => n.node.clusterId === cluster.id && n.related),
    });
  }

  const edges: EdgeVisual[] = [];
  const edgeById = new Map<string, EdgeVisual>();
  for (const edge of graph.edges) {
    const fromVisual = byId.get(edge.from);
    const toVisual = byId.get(edge.to);
    const points = layout.edges.get(edge.id) ?? straightEdge(fromVisual?.rect ?? EMPTY_RECT, toVisual?.rect ?? EMPTY_RECT);
    const reading = flow.get(edge.from);
    const flowing = reading?.active === true;
    const dash = flowDash(flowing ? (reading?.intensity ?? 0) : 0, reducedMotion);
    const consumerMetric = edge.toStage != null ? metrics.get(edge.toStage) : undefined;
    const shuffleLabel =
      level === "detail" && edge.kind === "cross-stage" && consumerMetric?.shuffleReadBytes
        ? fmtBytes(consumerMetric.shuffleReadBytes)
        : null;
    const selectedEdge = input.selectedEdgeId === edge.id;
    const hoveredEdge = input.hoveredEdgeId === edge.id;
    const edgeDimmed = input.selectedNodeId != null && !(fromVisual?.related || toVisual?.related);
    const signature = `${layout.hash}|${level}|${flowing ? 1 : 0}|${(reading?.intensity ?? 0).toFixed(2)}|${shuffleLabel ?? ""}|${selectedEdge ? 1 : 0}${hoveredEdge ? 1 : 0}${edgeDimmed ? 1 : 0}`;
    const cachedEdge = diff.edges.get(edge.id);
    if (cachedEdge && cachedEdge.signature === signature) {
      edgeById.set(edge.id, cachedEdge.visual);
      edges.push(cachedEdge.visual);
      continue;
    }
    const visual: EdgeVisual = {
      edge,
      points,
      path: pathFromPoints(points),
      arrow: arrowAt(points),
      flowing,
      intensity: reading?.intensity ?? 0,
      opacity: dash.opacity,
      dashArray: dash.dashArray,
      animationSeconds: dash.animationSeconds,
      travel: dash.travel,
      selected: selectedEdge,
      hovered: hoveredEdge,
      dimmed: edgeDimmed,
      shuffleLabel,
      labels: [],
    };
    edgeById.set(edge.id, visual);
    edges.push(visual);
    diff.edges.set(edge.id, { signature, visual });
  }

  let labelsChanged = !diff.labelsInitialized;
  for (const visual of nodes) {
    const subTextKey = labelSubTextKey(visual, input.level);
    const previous = diff.nodeLabels.get(visual.node.id);
    if (
      !previous ||
      previous.kind !== visual.node.kind ||
      previous.label !== visual.node.label ||
      previous.subTextKey !== subTextKey ||
      previous.selected !== visual.selected ||
      previous.hovered !== visual.hovered ||
      previous.running !== visual.running
    ) {
      diff.nodeLabels.set(visual.node.id, {
        kind: visual.node.kind,
        label: visual.node.label,
        subTextKey,
        selected: visual.selected,
        hovered: visual.hovered,
        running: visual.running,
      });
      labelsChanged = true;
    }
  }
  for (const visual of edges) {
    const shuffleLabel = visual.shuffleLabel ?? "";
    if (diff.edgeLabels.get(visual.edge.id) !== shuffleLabel) {
      diff.edgeLabels.set(visual.edge.id, shuffleLabel);
      labelsChanged = true;
    }
  }
  if (labelsChanged) {
    const digestParts: string[] = [];
    for (const visual of nodes) {
      const subTextKey = labelSubTextKey(visual, input.level);
      digestParts.push(
        `${visual.node.id}\u001f${visual.node.kind}\u001f${visual.node.label}\u001f${subTextKey}\u001f${visual.selected ? 1 : 0}${visual.hovered ? 1 : 0}${visual.running ? 1 : 0}`,
      );
    }
    for (const visual of edges) digestParts.push(`${visual.edge.id}\u001e${visual.shuffleLabel ?? ""}`);
    diff.digest = hashString(digestParts.join("\u001c"));
    diff.labelsInitialized = true;
  }

  return {
    nodes,
    byId,
    clusters,
    edges,
    edgeById,
    runningNodes: nodes.filter((n) => n.running),
    totals,
    warnings: graph.warnings,
    notes: graph.notes,
    digest: diff.digest,
  };
}

// ---------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------

export interface LabelPlanInput {
  scene: Scene;
  level: SemanticLevel;
  /** show edge labels (shuffle bytes) — suppressed under overview and for the dense canvas path */
  showEdgeLabels: boolean;
}

/**
 * Build the label candidates in *priority order* and let `resolveLabelCollisions` drop what does not fit.
 * Priorities: selected > hovered > running > big stages > everything else, so the interesting text survives.
 */
export function labelCandidates(input: LabelPlanInput): { nodes: Map<string, LabelCandidate[]>; edges: Map<string, LabelCandidate[]> } {
  const { scene, level } = input;
  const nodeCandidates = new Map<string, LabelCandidate[]>();
  const all: LabelCandidate[] = [];
  if (level !== "overview") {
    for (const v of scene.nodes) {
      const textX = v.rect.x + textColumnStart(v.node.kind);
      // Badges share the title row on short cards, so the title has to stop before them: without this the ellipsised
      // title runs underneath the right-aligned badges.
      const usable = titleUsableWidth(v.rect.width, v.rect.height, v.node.kind, v.badges);
      const compact = v.rect.height < 72;
      const roomy = v.rect.height >= 144;
      const titleSize = compact ? 12.5 : roomy ? 18 : 14.5;
      const titleCandidates: LabelCandidate[] = [];
      if (usable > 24) {
        // Titles use the monospace face: a proportional estimate let long names pass as fitting and spill past the
        // card edge. Reserve one glyph of slack after accounting for the actual monospace advance.
        const text = ellipsizeMonospace(v.node.label, titleSize, Math.max(0, usable - titleSize));
        if (text) {
          titleCandidates.push({
            id: `${v.node.id}#title`,
            text,
            x: textX,
            y: v.rect.y + nodeRowGeometry(v.rect.height, v.node.kind).titleY - titleSize + 1,
            width: measureMonospaceText(text, titleSize),
            height: titleSize + 3,
            priority: 100 + (v.selected ? 60 : 0) + (v.hovered ? 40 : 0) + (v.running ? 20 : 0) + (v.node.kind === "rdd" ? 0 : 10),
          });
        }
      }
      // The secondary line is on its own row, so it gets the whole text column: only the title shares its row.
      const subUsable = titleUsableWidth(v.rect.width, v.rect.height, v.node.kind, []);
      if (v.subText && v.rect.height >= 56 && subUsable > 40) {
        const subSize = compact ? 10.5 : roomy ? 14 : 12.5;
        const text = ellipsize(v.subText, subSize, subUsable);
        if (text) {
          titleCandidates.push({
            id: `${v.node.id}#sub`,
            text,
            x: textX,
            y: v.rect.y + nodeRowGeometry(v.rect.height, v.node.kind).subY - subSize + 1,
            width: measureText(text, subSize),
            height: subSize + 3,
            priority: 40 + (v.selected ? 30 : 0),
          });
        }
      }
      if (titleCandidates.length > 0) {
        nodeCandidates.set(v.node.id, titleCandidates);
        all.push(...titleCandidates);
      }
    }
  }
  const edgeCandidates = new Map<string, LabelCandidate[]>();
  if (input.showEdgeLabels) {
    for (const e of scene.edges) {
      if (!e.shuffleLabel) continue;
      const at = pointAlong(e.points, 0.5);
      const size = 10;
      const width = measureText(e.shuffleLabel, size);
      const candidate: LabelCandidate = {
        id: `${e.edge.id}#len`,
        text: e.shuffleLabel,
        x: at.x - width / 2,
        y: at.y - size,
        width,
        height: size + 2,
        priority: 55,
      };
      edgeCandidates.set(e.edge.id, [candidate]);
      all.push(candidate);
    }
  }
  return { nodes: nodeCandidates, edges: edgeCandidates };
}

/** Flattened candidate list in the order the collision pass must consider it. */
export function flattenCandidates(plan: { nodes: Map<string, LabelCandidate[]>; edges: Map<string, LabelCandidate[]> }): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  for (const list of plan.nodes.values()) out.push(...list);
  for (const list of plan.edges.values()) out.push(...list);
  return out;
}
