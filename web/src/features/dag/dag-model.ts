/**
 * `Dag` (§4) → `RenderGraph`: the normalisation every consumer (layout, render, drawer, progress) reads.
 *
 * Responsibilities:
 *  - pick the graph *shape* (job = stages, or stages-with-RDD-children; stage = RDD chains; sql = operators)
 *  - make node ids globally unique and stable across attempts
 *  - nest operation scopes as compound clusters (`DagCluster.parentId` is honoured, not flattened)
 *  - size nodes (semantic-zoom "normal" level) so ELK and the renderer agree
 *  - hash everything that affects layout, so the cached layout is keyed by structure and never by metrics
 *  - collect non-fatal warnings (dangling edges, duplicate ids, cycles, absurd fan-out) instead of throwing
 */
import type { Dag, DagCluster, DagInput, DagStage, GraphCluster, GraphEdge, GraphNode, NodeSize, RenderGraph } from "./types";

/**
 * Above this many nodes the *edge* layer moves to canvas; nodes stay DOM at every size (they carry the datums,
 * interactions and the accessibility tree). Lowered from 500 to 250 after measuring a 338-node graph at a 10 Hz metric
 * stream: ~340 SVG paths cost more per frame than the nodes do, and the canvas keeps the same tone/width/dash
 * semantics (including the flow animation, which it drives from its own rAF loop).
 */
export const CANVAS_THRESHOLD = 500; // A/B: canvas edges measured slower than SVG at 338 nodes; see docs/design-dag.md §7.5
export const HARD_LIMIT = 1500;
/** A job DAG is laid out fully expanded (RDDs inside stage containers) up to this many RDDs. */
export const EXPAND_LIMIT = 160;

export const NODE_SIZE: Record<string, NodeSize> = {
  jobStage: { width: 208, height: 84 },
  rdd: { width: 168, height: 46 },
  rddCompact: { width: 132, height: 34 },
  sql: { width: 184, height: 46 },
  fallback: { width: 216, height: 66 },
  ghost: { width: 132, height: 40 },
};

export const CLUSTER_PADDING = { top: 30, left: 14, bottom: 14, right: 14 };

const isDag = (input: DagInput): input is Dag =>
  "kind" in input && (input.kind === "job" || input.kind === "stage") && Array.isArray(input.stages);

/** FNV-1a over the canonical JSON of the layout-relevant shape. Fast, stable, collision-safe enough for a cache key. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let h2 = 0x9e3779b9;
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

const stageKey = (s: { stageId: number; attempt?: number }) => `${s.stageId}.${s.attempt ?? 0}`;

/** Compound cluster id for a stage container (job DAG with RDD children). */
const stageClusterId = (s: { stageId: number; attempt?: number }) => `stage:${stageKey(s)}`;

/** Namespaced operation-scope cluster id so two stages may reuse a scope id without colliding. */
const scopeClusterId = (s: { stageId: number; attempt?: number }, clusterId: string) => `${stageKey(s)}:${clusterId}`;

/**
 * Depth-first cycle break. `edges` is mutated by dropping back edges. Returns the dropped ids.
 * Spark's DAGs cannot contain cycles (RDD lineage is a DAG), so this only ever fires on corrupt upstream data.
 */
export function breakCycles(nodes: readonly string[], edges: GraphEdge[]): string[] {
  const index = new Map<string, number>();
  for (const n of nodes) index.set(n, -1);
  const adjacency = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from);
    if (list) list.push(e);
    else adjacency.set(e.from, [e]);
  }
  const dropped: string[] = [];
  let counter = 0;
  const visit = (n: string, stack: Set<string>): void => {
    index.set(n, counter++);
    stack.add(n);
    for (const e of adjacency.get(n) ?? []) {
      if (stack.has(e.to)) {
        dropped.push(e.id);
        continue;
      }
      const target = index.get(e.to);
      if (target === undefined) continue;
      if (target === -1) visit(e.to, stack);
    }
    stack.delete(n);
  };
  for (const n of nodes) {
    if (index.get(n) === -1) visit(n, new Set());
  }
  return dropped;
}

interface Builder {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  sizes: Map<string, NodeSize>;
  warnings: string[];
  /** `${stageKey}:${rddId}` -> graph node id, for edge resolution */
  rddIdToNode: Map<string, string>;
  seenNodeIds: Set<string>;
}

function addCluster(b: Builder, c: GraphCluster): void {
  if (b.clusters.some((x) => x.id === c.id)) return;
  b.clusters.push(c);
}

function pushNode(b: Builder, node: GraphNode, size: NodeSize): void {
  if (b.seenNodeIds.has(node.id)) {
    b.warnings.push(`duplicate node id ${node.id} — the second occurrence was dropped`);
    return;
  }
  b.seenNodeIds.add(node.id);
  b.nodes.push(node);
  b.sizes.set(node.id, size);
}

/** Operation scopes may nest; each becomes a compound cluster whose parent is the enclosing scope or the stage. */
function addScopeClusters(b: Builder, stage: DagStage, fallbackParent: string | null): void {
  const byId = new Map<string, DagCluster>();
  for (const c of stage.clusters) byId.set(c.id, c);
  const resolveParent = (c: DagCluster): string | null => {
    const p = c.parentId ? byId.get(c.parentId) : undefined;
    if (c.parentId && !p) {
      b.warnings.push(`cluster ${c.id} in stage ${stage.stageId} references missing parent ${c.parentId}`);
    }
    if (p) return scopeClusterId(stage, p.id);
    return fallbackParent;
  };
  for (const c of stage.clusters) {
    addCluster(b, {
      id: scopeClusterId(stage, c.id),
      label: c.name,
      parentId: resolveParent(c),
    });
  }
}

function addRddNodes(b: Builder, stage: DagStage, container: string | null, compact: boolean): void {
  const size = compact ? NODE_SIZE.rddCompact! : NODE_SIZE.rdd!;
  for (const n of stage.nodes) {
    const id = `${stageKey(stage)}.n${n.id}`;
    b.rddIdToNode.set(`${stageKey(stage)}:${n.id}`, id);
    const sublabel = [n.determinism && n.determinism !== "determinate" ? n.determinism : null, n.barrier ? "barrier" : null]
      .filter((x): x is string => x !== null)
      .join(" · ");
    pushNode(
      b,
      {
        id,
        label: n.name,
        sublabel: sublabel || undefined,
        kind: "rdd",
        ref: n.id,
        stageId: stage.stageId,
        attempt: stage.attempt,
        skipped: stage.skipped,
        cached: n.cached,
        barrier: n.barrier,
        determinism: n.determinism,
        callsite: n.callsite,
        clusterId: n.clusterId ? scopeClusterId(stage, n.clusterId) : container,
      },
      size,
    );
  }
}

/** Intra-stage RDD edges. */
function addRddEdges(b: Builder, stage: DagStage): void {
  for (const e of stage.edges) {
    const from = `${stageKey(stage)}.n${e.from}`;
    const to = `${stageKey(stage)}.n${e.to}`;
    if (!b.seenNodeIds.has(from) || !b.seenNodeIds.has(to)) {
      b.warnings.push(`stage ${stage.stageId} edge ${e.from}→${e.to} references an unknown RDD`);
      continue;
    }
    b.edges.push({
      id: `${stageKey(stage)}.e${e.from}>${e.to}`,
      from,
      to,
      kind: "rdd",
      fromRef: e.from ?? undefined,
      toRef: e.to ?? undefined,
    });
  }
}

/** Map every RDD id to its owning stage, so an edge can be attributed with one lookup (and collisions stay hard). */
function rddStageIndex(stages: readonly DagStage[]): Map<number, { stageId: number; attempt: number }> {
  const index = new Map<number, { stageId: number; attempt: number }>();
  for (const s of stages) {
    for (const n of s.nodes) if (!index.has(n.id)) index.set(n.id, { stageId: s.stageId, attempt: s.attempt ?? 0 });
  }
  return index;
}

/** Edge id for a cross-stage edge: stable whether or not Spark named the endpoints. */
const crossEdgeId = (fromNodeId: string, toNodeId: string) => `x.${fromNodeId}>${toNodeId}`;

/**
 * A dashed stub for an RDD referenced by an edge but not present in the payload. Ghosts are top-level (they belong to
 * no scope on this page) and capped at GHOST_LIMIT; past the cap the edge is dropped with a warning instead.
 */
function addGhost(b: Builder, key: string, rddId: number): string | undefined {
  const id = ghostNodeId(key, rddId);
  if (b.seenNodeIds.has(id)) return id;
  if (b.nodes.filter((n) => n.kind === "ghost").length >= GHOST_LIMIT) return undefined;
  b.seenNodeIds.add(id);
  b.nodes.push({ id, label: `RDD ${rddId}`, sublabel: "outside this page", kind: "ghost", ref: rddId });
  b.sizes.set(id, NODE_SIZE.ghost!);
  return id;
}

/**
 * Cross-stage edges. Spark's DOT normally names the RDD on both sides; the REST fallback (`edgesInferred`) reports
 * only the stage pair with `from`/`to` null. In that case the shuffle boundary *is* the edge, so we attach it to the
 * producer's last RDD and the consumer's first RDD — the same two nodes Spark's own job DAG connects.
 */
function crossStageEdges(b: Builder, dag: Dag, stages: readonly DagStage[]): void {
  const attemptOf = new Map<number, number>();
  const first = new Map<number, DagStage>();
  const last = new Map<number, DagStage>();
  for (const s of stages) {
    attemptOf.set(s.stageId, s.attempt ?? 0);
    if (!first.has(s.stageId)) first.set(s.stageId, s);
    last.set(s.stageId, s);
  }
  const exactNodeId = (stageId: number | null, rddId: number): string | undefined => {
    if (stageId == null) return undefined;
    const attempt = attemptOf.get(stageId) ?? 0;
    return b.rddIdToNode.get(`${stageId}.${attempt}:${rddId}`);
  };
  /** The shuffle boundary: the producer's last RDD and the consumer's first RDD. */
  const boundaryNodeId = (stageId: number | null, prefer: "first" | "last"): string | undefined => {
    if (stageId == null) return undefined;
    const attempt = attemptOf.get(stageId) ?? 0;
    const stage = prefer === "first" ? first.get(stageId) : last.get(stageId);
    const nodes = stage?.nodes ?? [];
    const pick = prefer === "first" ? nodes[0] : nodes[nodes.length - 1];
    return pick ? b.rddIdToNode.get(`${stageId}.${attempt}:${pick.id}`) : undefined;
  };
  const stageOf = rddStageIndex(stages);
  for (const e of dag.edges) {
    const fromStage = e.fromStage ?? stageOf.get(e.from ?? -1)?.stageId ?? null;
    const toStage = e.toStage ?? stageOf.get(e.to ?? -1)?.stageId ?? null;
    // Resolve exactly. When Spark named the stages (the REST fallback) but not the RDDs, the edge is the shuffle
    // boundary between those stages — that derivation is documented and safe. When we know neither endpoint node nor
    // which stage it belongs to, the honest rendering is a ghost stub: the dependency exists but lives elsewhere.
    const namedStages = e.fromStage != null && e.toStage != null;
    const fromExact = e.from != null ? exactNodeId(fromStage, e.from) : undefined;
    const toExact = e.to != null ? exactNodeId(toStage, e.to) : undefined;
    const fromNode =
      fromExact ??
      (namedStages ? boundaryNodeId(fromStage, "last") : undefined) ??
      (e.from != null ? addGhost(b, `s${fromStage ?? "ext"}`, e.from) : undefined);
    const toNode =
      toExact ??
      (namedStages ? boundaryNodeId(toStage, "first") : undefined) ??
      (e.to != null ? addGhost(b, `s${toStage ?? "ext"}`, e.to) : undefined);
    if (!fromNode || !toNode) {
      b.warnings.push(`cross-stage edge ${e.from ?? "?"}→${e.to ?? "?"} has no resolvable endpoint on this page`);
      continue;
    }
    if (fromNode === toNode) continue;
    b.edges.push({
      id: crossEdgeId(fromNode, toNode),
      from: fromNode,
      to: toNode,
      kind: "cross-stage",
      fromRef: e.from ?? undefined,
      toRef: e.to ?? undefined,
      fromStage,
      toStage,
      crossCluster: true,
    });
  }
}

/** Stages as leaf nodes, with edges aggregated to stage→stage. Used for `granularity:"stage"` and large jobs. */
function buildStageSummaryGraph(
  dag: Dag,
  warnings: string[],
  notes: string[],
): Pick<RenderGraph, "nodes" | "edges" | "clusters" | "sizes"> {
  const stageOf = rddStageIndex(dag.stages);
  const b: Builder = {
    nodes: [],
    edges: [],
    clusters: [],
    sizes: new Map(),
    warnings,
    rddIdToNode: new Map(),
    seenNodeIds: new Set(),
  };
  for (const s of dag.stages) {
    const flags = stageFlags(s);
    pushNode(
      b,
      {
        id: `st.${stageKey(s)}`,
        label: flags.label,
        barrier: flags.barrier ? true : undefined,
        sublabel: rddChainSummary(s),
        kind: s.skipped || dag.granularity === "stage" ? "fallback" : "stage",
        stageId: s.stageId,
        attempt: s.attempt,
        skipped: s.skipped,
        status: s.status,
        rddCount: s.rddIds?.length ?? s.nodes.length,
        callsite: undefined,
      },
      s.skipped || dag.granularity === "stage" ? NODE_SIZE.fallback! : NODE_SIZE.jobStage!,
    );
  }
  const seen = new Set<string>();
  for (const e of dag.edges) {
    const fromStage = e.fromStage ?? stageOf.get(e.from ?? -1)?.stageId;
    const toStage = e.toStage ?? stageOf.get(e.to ?? -1)?.stageId;
    if (fromStage == null || toStage == null || fromStage === toStage) continue;
    const from = `${fromStage}.${dag.stages.find((s) => s.stageId === fromStage)?.attempt ?? 0}`;
    const to = `${toStage}.${dag.stages.find((s) => s.stageId === toStage)?.attempt ?? 0}`;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!b.seenNodeIds.has(`st.${from}`) || !b.seenNodeIds.has(`st.${to}`)) {
      warnings.push(`cross-stage edge ${fromStage}→${toStage} references an unknown stage`);
      continue;
    }
    b.edges.push({
      id: `x.st.${key}`,
      from: `st.${from}`,
      to: `st.${to}`,
      kind: "cross-stage",
      fromStage,
      toStage,
      fromRef: e.from ?? undefined,
      toRef: e.to ?? undefined,
      crossCluster: true,
    });
  }
  const edges = reduceTransitive(
    b.nodes.map((n) => n.id),
    b.edges,
  );
  if (edges.length !== b.edges.length) {
    notes.push(`${b.edges.length - edges.length} inferred edge(s) hidden: already implied by a longer path`);
  }
  return { nodes: b.nodes, edges, clusters: b.clusters, sizes: b.sizes };
}

/**
 * Spark's root cluster label carries flags: `Stage 3`, `Stage 3 (skipped)`, `Stage 3 (attempt 1)`,
 * `Stage 3\n(barrier mode)`. The clean name goes on the node; the flags become badges.
 */
export interface StageFlags {
  label: string;
  barrier: boolean;
  skipped: boolean;
  attempt: number | null;
}

export function stageFlags(stage: DagStage, label = stage.label): StageFlags {
  let rest = label;
  const barrier = /barrier mode/i.test(rest) || stage.nodes.some((n) => n.barrier === true);
  const skipped = stage.skipped || /\bskipped\b/i.test(rest);
  const attemptMatch = /\(attempt (\d+)\)/i.exec(rest);
  rest = rest
    .replace(/\((?:attempt \d+|skipped|barrier mode)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return { label: rest || `Stage ${stage.stageId}`, barrier, skipped, attempt: attemptMatch?.[1] ? Number(attemptMatch[1]) : null };
}

/**
 * Transitive reduction for the *stage-summary* graph only. The REST fallback links every earlier producer
 * (105 edges for 14 stages in big-dag), which is a hairball; keeping just the covering edges preserves every
 * reachability relation. RDD graphs are never reduced — parallel paths there are the point.
 */
export function reduceTransitive(nodes: readonly string[], edges: readonly GraphEdge[]): GraphEdge[] {
  // Only worth it when the graph is dense (the fallback links every earlier producer), and bounded so the O(E²·V)
  // reachability check can never dominate on a pathological payload.
  if (edges.length <= nodes.length * 1.2 || edges.length > 600) return [...edges];
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from);
    if (list) list.push(e.to);
    else adjacency.set(e.from, [e.to]);
  }
  const reachableWithout = (skipIndex: number, from: string, target: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of edges) {
        if (e.from !== cur) continue;
        if (e === edges[skipIndex]) continue;
        if (e.to === target) return true;
        if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    return false;
  };
  const keep: GraphEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (!reachableWithout(i, e.from, e.to)) keep.push(e);
  }
  return keep.length > 0 ? keep : [...edges];
}

/**
 * Edges whose endpoint is not on this page become a dashed stub node instead of disappearing: the dependency is real
 * information even when the node is elsewhere. Capped so a corrupt payload cannot flood the canvas.
 */
const GHOST_LIMIT = 24;

export const ghostNodeId = (stageKeyOrPage: string, rddId: number) => `ghost.${stageKeyOrPage}.${rddId}`;

/** "ParallelCollectionRDD → PythonRDD → PairwiseRDD" (used as a stage card's secondary line). */
export function rddChainSummary(s: DagStage): string | undefined {
  if (s.nodes.length === 0) return undefined;
  const names = s.nodes.map((n) => n.name);
  if (names.length <= 3) return names.join(" → ");
  return `${names.slice(0, 2).join(" → ")} → … → ${names[names.length - 1]}`;
}

export interface BuildOptions {
  /** job DAGs: draw RDDs inside their stage containers instead of one card per stage */
  expandStages?: boolean;
}

/**
 * Adapt a `Dag` (or SQL plan) into a render graph. Pure and synchronous; runs on every payload change, so it must
 * stay cheap (single pass over nodes/edges, no sorting).
 */
export function buildGraph(input: DagInput, opts: BuildOptions = {}): RenderGraph {
  if (!isDag(input)) {
    // SQL plans are adapted by a separate module; importing it here would create a cycle, so the caller passes
    // the built graph in. Reaching this branch means someone handed us a plan without adapting it first.
    throw new TypeError("buildGraph expects a Dag; use buildSqlPlanGraph for SQL plan executions");
  }
  const dag = input;
  const warnings: string[] = [];
  const notes: string[] = [];
  if (dag.edgesInferred) notes.push("edges inferred from RDD lineage (Spark emitted no operation graph)");
  const rddCount = dag.stages.reduce((a, s) => a + s.nodes.length, 0);
  const granularity = dag.granularity;

  // Decide the shape once, then build. `granularity:"stage"` has no RDD detail at all, so there is nothing to expand
  // even if the caller asked for it — say so instead of rendering an empty canvas.
  const canExpand = granularity === "rdd" && rddCount > 0;
  const expand = canExpand && (opts.expandStages ?? (dag.kind === "job" ? rddCount <= EXPAND_LIMIT : true));
  if (!canExpand && opts.expandStages === true) {
    notes.push(`this payload has no RDD detail (granularity "${granularity}"), so the stage summary is shown`);
  }

  if (!expand) {
    const summary = buildStageSummaryGraph(dag, warnings, notes);
    const hash = hashGraph(dag.kind, granularity, summary);
    return {
      hash,
      kind: "job",
      granularity,
      jobId: dag.jobId,
      ...summary,
      large: summary.nodes.length > CANVAS_THRESHOLD,
      warnings,
      notes,
      inferred: dag.edgesInferred === true || granularity === "stage",
      source: dag,
    };
  }

  const b: Builder = {
    nodes: [],
    edges: [],
    clusters: [],
    sizes: new Map(),
    warnings,
    rddIdToNode: new Map(),
    seenNodeIds: new Set(),
  };
  const compact = rddCount > 120;
  for (const stage of dag.stages) {
    const container = dag.kind === "job" ? stageClusterId(stage) : null;
    if (container) {
      const flags = stageFlags(stage);
      const marks = [flags.barrier ? "barrier" : null, flags.skipped || stage.skipped ? "skipped" : null].filter(
        (m): m is string => m !== null,
      );
      addCluster(b, {
        id: container,
        label: marks.length > 0 ? `${flags.label} · ${marks.join(" · ")}` : flags.label,
        parentId: null,
      });
    }
    addScopeClusters(b, stage, container);
    addRddNodes(b, stage, container, compact);
  }
  for (const stage of dag.stages) addRddEdges(b, stage);
  // Cross-stage edges exist on job pages and, per the contract, on stage pages "when the page has them".
  crossStageEdges(b, dag, dag.stages);

  const dropped = breakCycles(
    b.nodes.map((n) => n.id),
    b.edges,
  );
  if (dropped.length > 0) b.warnings.push(`${dropped.length} cyclic edge(s) removed: ${dropped.slice(0, 3).join(", ")}`);
  const edges = b.edges.filter((e) => !dropped.includes(e.id));

  const hash = hashGraph(dag.kind, granularity, { nodes: b.nodes, edges, clusters: b.clusters, sizes: b.sizes });
  return {
    hash,
    kind: dag.kind,
    granularity,
    jobId: dag.jobId,
    nodes: b.nodes,
    edges,
    clusters: b.clusters,
    sizes: b.sizes,
    large: b.nodes.length > CANVAS_THRESHOLD,
    warnings: b.warnings,
    notes,
    // reaching here means the payload had RDD detail, so only the flag can make this an inferred graph
    inferred: dag.edgesInferred === true,
    source: dag,
  };
}

/** Hash of the layout-relevant shape only: metrics, selection and hover must not invalidate a cached layout. */
export function hashGraph(
  kind: RenderGraph["kind"],
  granularity: RenderGraph["granularity"],
  g: Pick<RenderGraph, "nodes" | "edges" | "clusters" | "sizes">,
): string {
  const parts: string[] = [kind, granularity];
  for (const n of g.nodes) {
    const s = g.sizes.get(n.id);
    parts.push(
      `${n.id}\u001f${n.kind}\u001f${n.label}\u001f${n.sublabel ?? ""}\u001f${n.clusterId ?? ""}\u001f${s?.width ?? 0}x${s?.height ?? 0}`,
    );
  }
  for (const e of g.edges) parts.push(`${e.id}\u001e${e.from}>${e.to}`);
  for (const c of g.clusters) parts.push(`${c.id}\u001d${c.parentId ?? ""}\u001d${c.label}`);
  return hashString(parts.join("\u001c"));
}

/** Cluster depth for the layout request (ELK needs children before parents). */
export function clusterDepth(clusters: readonly GraphCluster[]): Map<string, number> {
  const byId = new Map<string, GraphCluster>();
  for (const c of clusters) byId.set(c.id, c);
  const depth = new Map<string, number>();
  const walk = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const c = byId.get(id);
    let d = 0;
    if (c?.parentId) d = walk(c.parentId, seen) + 1;
    depth.set(id, d);
    return d;
  };
  for (const c of clusters) walk(c.id, new Set());
  return depth;
}

export { isDag };
