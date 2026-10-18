/**
 * Types for the DAG engine.
 *
 * The wire shape is `docs/contracts/api.md` §4 (`Dag`). The Spark-discovery fixtures add four fields
 * (`stages[].attempt`, `stages[].status`, `stages[].rddIds`, `nodes[].barrier`, `nodes[].determinism`,
 * `edges[].fromStage`/`toStage`); they are declared optional here so both spellings typecheck, and the
 * engine never *requires* them. `SqlPlanExecution` is the `/sql/{id}?details=true&planDescription=true`
 * payload, adapted by `sql-plan.ts` onto the same render primitive.
 *
 * Nothing in this file imports runtime code: it is the shared vocabulary of layout / render / progress.
 */

// ---------------------------------------------------------------------------------------------------
// §4 wire types (plus documented additive fields)
// ---------------------------------------------------------------------------------------------------

export type DagKind = "job" | "stage";

/** "rdd" = the DOT operation graph was available; "stage" = REST-only fallback, one node per stage. */
export type DagGranularity = "rdd" | "stage";

export interface DagNode {
  id: number;
  name: string;
  callsite: string;
  cached: boolean;
  clusterId: string | null;
  /** Spark 4.x: this RDD's operator is a barrier (deterministic shuffle). */
  barrier?: boolean;
  /** Spark operator determinism; absent means determinate. */
  determinism?: "determinate" | "unordered" | "indeterminate";
}

export interface DagEdge {
  /** null in the REST fallback, where Spark reports the stage pair but no RDD endpoints */
  from: number | null;
  to: number | null;
  /** job DAG only: which stage each endpoint belongs to. */
  fromStage?: number | null;
  toStage?: number | null;
}

export interface DagCluster {
  id: string;
  name: string;
  parentId: string | null;
}

export interface DagStage {
  stageId: number;
  skipped: boolean;
  label: string;
  clusters: DagCluster[];
  nodes: DagNode[];
  edges: DagEdge[];
  /** additive: attempt number of the stage whose DOT this was taken from */
  attempt?: number;
  /** additive: stage status as seen on the Spark stage page (COMPLETE|ACTIVE|FAILED|PENDING|SKIPPED) */
  status?: string;
  /** additive: RDD ids the stage page linked (used to cross-link detail pages) */
  rddIds?: number[];
}

export interface Dag {
  kind: DagKind;
  granularity: DagGranularity;
  jobId?: number;
  /** true when the backend inferred the edges from RDD lineage because Spark's DOT had none */
  edgesInferred?: boolean;
  /** job: every stage of the job including skipped ones. stage: exactly one. */
  stages: DagStage[];
  /** cross-stage edges (node ids). job kind only. */
  edges: DagEdge[];
}

// ---------------------------------------------------------------------------------------------------
// SQL plan (`/sql/{id}?details=true`)
// ---------------------------------------------------------------------------------------------------

export interface SqlPlanMetric {
  name: string;
  value: string;
}

export interface SqlPlanNode {
  nodeId: number;
  nodeName: string;
  /** Operator hover text supplied by the Spark 2.4 SQL UI compatibility adapter. */
  planLine?: string;
  wholeStageCodegenId?: number;
  metrics?: SqlPlanMetric[];
}

export interface SqlPlanEdge {
  fromId: number;
  toId: number;
}

export interface SqlPlanExecution {
  id: number;
  status: string;
  description: string;
  planDescription?: string;
  nodes: SqlPlanNode[];
  edges: SqlPlanEdge[];
  submissionTime?: string;
  duration?: number;
  runningJobIds?: number[];
  successJobIds?: number[];
  failedJobIds?: number[];
  errorMessage?: string;
}

/** Anything the renderer accepts. */
export type DagInput = Dag | SqlPlanExecution;

// ---------------------------------------------------------------------------------------------------
// Normalised render graph — the single primitive every adapter produces
// ---------------------------------------------------------------------------------------------------

/** What a node *means*, which decides its size, anatomy and detail level. */
export type GraphNodeKind =
  | "stage" // job DAG: one Spark stage, carries task progress + shuffle badges
  | "rdd" // stage DAG: one RDD in an operator chain
  | "sql" // SQL plan: one physical operator, carries its metric list
  | "sql-wholestage" // SQL plan: a WholeStageCodegen boundary (cluster, not a node)
  | "fallback" // granularity:"stage" placeholder for a stage with no RDD detail
  | "ghost"; // an edge endpoint that is not on this page: drawn as a dashed stub, never dropped

export interface GraphNode {
  /** globally unique within the graph (a stage id may repeat across attempts) */
  id: string;
  /** label shown on the node */
  label: string;
  /** secondary line (callsite / operator metrics summary) */
  sublabel?: string;
  kind: GraphNodeKind;
  /** the wire node id, when one exists */
  ref?: number;
  /** stage id this node belongs to (job feedback / metrics join) */
  stageId?: number;
  attempt?: number;
  skipped?: boolean;
  cached?: boolean;
  barrier?: boolean;
  determinism?: "determinate" | "unordered" | "indeterminate";
  callsite?: string;
  /** status from the payload itself (fallback DAGs carry `stages[].status`); REST metrics win when present */
  status?: string;
  /** number of RDDs Spark listed for this stage (fallback DAGs: `rddIds.length`) */
  rddCount?: number;
  /** SQL plan metric list */
  metrics?: SqlPlanMetric[];
  /** compound cluster id */
  clusterId?: string | null;
  /** SQL: Spark's per-operator plan line (from `planDescription` or the Spark 2.4 UI metadata). */
  detail?: string;
}

export type GraphEdgeKind = "flow" | "cross-stage" | "rdd" | "sql";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** wire-level ids for click-through (absent when the endpoint is a ghost or a null-endpoint fallback edge) */
  fromRef?: number;
  toRef?: number;
  fromStage?: number | null;
  toStage?: number | null;
  /** true when `from`/`to` are in different compound clusters (ELK must route across the hierarchy) */
  crossCluster?: boolean;
}

export interface GraphCluster {
  id: string;
  label: string;
  parentId: string | null;
  /** SQL: the WholeStageCodegen id, for badge rendering */
  codegenId?: number;
  /** Hover text for the frame. SQL codegen scopes put the boundary's own metric (its duration) here. */
  detail?: string;
}

/** Bounds for a node at a given semantic level; the layout engine consumes these. */
export interface NodeSize {
  width: number;
  height: number;
}

export interface RenderGraph {
  /** stable hash of everything that affects layout */
  hash: string;
  kind: "job" | "stage" | "sql";
  granularity: DagGranularity;
  jobId?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  /** semantic-zoom base: node sizes used to lay out (the "normal" level) */
  sizes: Map<string, NodeSize>;
  /** true when the caller must degrade (> CANVAS_THRESHOLD nodes) */
  large: boolean;
  /** non-fatal problems found while adapting (surfaced in the UI, never hidden) */
  warnings: string[];
  /** provenance notes that are not problems, e.g. "edges inferred from RDD lineage" */
  notes: string[];
  /** true for the REST-only fallback: edges are inferred, so the picture is drawn with a hatch and a legend note */
  inferred: boolean;
  /** the source payload, for drawer/tooltip detail that is not in the graph */
  source: DagInput;
}

// ---------------------------------------------------------------------------------------------------
// Layout results
// ---------------------------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  hash: string;
  width: number;
  height: number;
  nodes: Map<string, Rect>;
  clusters: Map<string, Rect>;
  /** edge id -> polyline points in world space (first = source end, last = target end) */
  edges: Map<string, { x: number; y: number }[]>;
  /** ms spent inside the layout engine (for the perf HUD + tests) */
  durationMs: number;
  /** "worker" | "main" — where the layout ran */
  ran: "worker" | "main";
  /** 0 = the primary option set; >0 = a degraded rung of `LAYOUT_LADDER` produced this layout */
  rung: number;
  /** human-readable name of the rung that produced this layout */
  ladderName: string;
}

/** Serialisable, transferable layout payload crossing the worker boundary. */
export interface LayoutWire {
  hash: string;
  width: number;
  height: number;
  durationMs: number;
  rung: number;
  ladderName: string;
  nodeIds: string[];
  nodeBoxes: Float32Array;
  clusterIds: string[];
  clusterBoxes: Float32Array;
  edgeIds: string[];
  edgeOffsets: Uint32Array;
  edgePoints: Float32Array;
}

export interface LayoutRequest {
  requestId: number;
  graph: {
    hash: string;
    nodes: { id: string; width: number; height: number; clusterId: string | null }[];
    edges: { id: string; from: string; to: string }[];
    clusters: { id: string; parentId: string | null; depth: number; label: string }[];
  };
  /** tuned spacing, passed in so tests and prod share one source of truth */
  options: Record<string, string>;
}

export type LayoutResponse = { requestId: number; ok: true; wire: LayoutWire } | { requestId: number; ok: false; error: string };
