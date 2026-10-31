/**
 * SQL plan → the same render primitive.
 *
 * `/api/spark/{appId}/sql/{id}?details=true&planDescription=true` already exposes `nodes` (physical operators plus
 * their metric list) and `edges` (`fromId`→`toId`), and — when the plan was captured with whole-stage codegen — a
 * `wholeStageCodegenId` per node. That maps 1:1 onto the DAG vocabulary:
 *
 *   operator            → GraphNode kind "sql"   (label = nodeName, sublabel = "<n> metrics", metrics carried)
 *   wholeStageCodegenId → GraphCluster            (label "WholeStageCodegen (n)"), i.e. a compound scope
 *   WholeStageCodegen n → nothing: that entry *is* the cluster above (see `isCodegenBoundary`)
 *   edge.fromId→toId    → GraphEdge kind "sql"
 *
 * Per Spark's convention the edge direction is child→parent, so the arrow points *toward the plan root*; we keep the
 * upstream direction verbatim (never flip data) and let the layout treat the root as the sink at the right.
 */
import { CLUSTER_PADDING, NODE_SIZE, hashGraph } from "./dag-model";
import type { GraphCluster, GraphEdge, GraphNode, NodeSize, RenderGraph, SqlPlanExecution, SqlPlanNode } from "./types";

/** "WholeStageCodegen (3)" — Spark's own label. */
export function codegenClusterLabel(codegenId: number): string {
  return `WholeStageCodegen (${codegenId})`;
}

/**
 * Spark's `nodes[]` carries one `WholeStageCodegen (n)` entry per codegen boundary alongside the operators. That
 * entry is not an operator: no edge in any captured plan references it (checked across both Spark versions), and it
 * is not a member of its own scope — the operators it wraps carry the `wholeStageCodegenId`. The cluster frame *is*
 * that boundary, so mapping the entry to a node as well drew every codegen twice: the frame, plus an edgeless card
 * floating outside it, since the boundary has no `wholeStageCodegenId` to belong to.
 */
export function isCodegenBoundary(nodeName: string): boolean {
  return /^WholeStageCodegen(?: \(\d+\))?$/.test(nodeName.trim());
}

/**
 * How many operators the DAG draws for a plan: the raw `nodes[]` count includes one boundary entry per codegen scope,
 * which the cluster frame represents instead of a node. Used by the plan summary so its count matches the canvas.
 */
export function planOperatorCount(nodes: readonly { nodeName?: string | null }[] | null | undefined): number {
  return (nodes ?? []).filter((n) => !isCodegenBoundary(n.nodeName ?? "")).length;
}

/** A plan node's second line: the first one or two metric names, so zoomed-in nodes are informative without hover. */
export function sqlMetricSummary(node: SqlPlanNode, max = 1): string | undefined {
  const metrics = node.metrics ?? [];
  if (metrics.length === 0) return undefined;
  const shown = metrics.slice(0, max).map((m) => `${m.name} ${m.value}`);
  const rest = metrics.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} (+${rest})` : shown.join(" · ");
}

/** One operator as Spark's plan *tree* prints it; the tree and the appendix share these ids. */
interface PlanTextEntry {
  id: number;
  name: string;
  /** The operator's own physical-plan row, used when Spark omits the detailed appendix. */
  line?: string;
}

export interface PlanText {
  /** the glyph-indented tree, in the order Spark printed it (root first) */
  tree: PlanTextEntry[];
  /** appendix id → the entry's own lines: its name line, then its argument lines */
  appendix: Map<number, string[]>;
}

const TREE_GLYPHS = /^[+\-|\\*:\s]+/;
const JOIN_KIND_SUFFIX = / (Inner|LeftSemi|LeftAnti|FullOuter|LeftOuter|RightOuter)$/;

/** Spark prints "SortMergeJoin Inner" in the text plan and names the same operator "SortMergeJoin" in `nodes[]`. */
function planTextName(raw: string): string {
  // Order matters: the tree slice keeps the space before the id, so the suffix only matches after a trim.
  return raw.replace(TREE_GLYPHS, "").trim().replace(JOIN_KIND_SUFFIX, "").replace(/\s+/g, " ").trim();
}

/**
 * Spark's `planDescription` has two halves that share Spark's own node ids — and neither shares them with `nodes[]`,
 * whose ids are its array indices and which lists AQE stage wrappers the text renames:
 *
 *   tree     `   +- * Project (15)`                    glyph-indented, the id after the operator name
 *   appendix `(3) Project [codegen id : 1]`            starts at column 0; its argument lines follow unindented
 *            `Output [2]: [cast((id#0L % 500) as int) AS k#1, …]`
 *
 * The appendix is the payload — those argument lines are the text Spark's own UI shows on hover — and the tree exists
 * only to relate a `nodes[]` operator to an appendix id.
 */
export function parsePlanText(planDescription: string | null | undefined): PlanText {
  const tree: PlanTextEntry[] = [];
  const appendix = new Map<number, string[]>();
  let open: number | null = null;
  for (const raw of (planDescription ?? "").split("\n")) {
    const close = raw.startsWith("(") ? raw.indexOf(")", 1) : -1;
    if (close > 1) {
      const idText = raw.slice(1, close);
      let digitsOnly = true;
      for (let i = 0; i < idText.length; i += 1) {
        const digit = idText.charCodeAt(i);
        if (digit < 48 || digit > 57) {
          digitsOnly = false;
          break;
        }
      }
      if (digitsOnly) {
        open = Number(idText);
        appendix.set(open, [raw.trim()]);
        continue;
      }
    }
    // Past the first appendix heading every unindented line belongs to the entry above it; tree lines are indented.
    if (open !== null) {
      if (raw.trim() && !raw.startsWith(" ") && !raw.startsWith("==")) appendix.get(open)?.push(raw.trim());
      continue;
    }
    // Tree lines name the operator before the id: "AdaptiveSparkPlan (41)", "   +- * Project (15)".
    const inTree = /\((\d+)\)/.exec(raw);
    const name = inTree ? planTextName(raw.slice(0, inTree.index)) : "";
    if (name) tree.push({ id: Number(inTree![1]), name, line: raw.trim() });
  }
  // Some Spark History Servers can replay Spark 2.4 event logs and expose the newer REST endpoint, but the
  // planDescription still contains only the physical tree (no numbered appendix). Keep each physical operator row so
  // the same node hover/drawer can show its plan line. The true Spark 2.4 HTML adapter's planLine remains authoritative.
  if (appendix.size === 0) {
    const physicalLines = parsePhysicalPlanLines(planDescription ?? "");
    if (physicalLines.length > 0) tree.splice(0, tree.length, ...physicalLines);
  }
  return { tree, appendix };
}

function parsePhysicalPlanLines(planDescription: string): PlanTextEntry[] {
  const marker = "== Physical Plan ==";
  const markerAt = planDescription.indexOf(marker);
  if (markerAt < 0) return [];
  const start = markerAt + marker.length;
  const nextSection = planDescription.indexOf("\n== ", start);
  const physicalPlan = planDescription.slice(start, nextSection < 0 ? undefined : nextSection);
  const entries: PlanTextEntry[] = [];
  for (const raw of physicalPlan.split("\n")) {
    // Remove Spark's ASCII tree connector and whole-stage marker but keep the operator's argument text intact.
    const line = raw
      .trim()
      .replace(/^[+\-|\\:\s]+/, "")
      .replace(/^\*\(\d+\)\s*/, "")
      .replace(/^\*\s*/, "");
    const name = /^([A-Za-z][A-Za-z0-9_]*)/.exec(line)?.[1];
    if (name) entries.push({ id: entries.length, name: planTextName(name), line });
  }
  return entries;
}

/**
 * Attach each operator's appendix entry to its `nodes[]` id. The two id spaces differ, so the link is the *order*: both
 * listings run root-first, the merge walks forward, and a name that does not match means no line rather than a wrong one
 * — the failure mode this replaced showed "Exchange (28)" on a Project node.
 */
export function matchPlanDetails(nodes: readonly SqlPlanNode[], text: PlanText): Map<number, string> {
  const out = new Map<number, string>();
  const ordered = nodes.filter((n) => !isCodegenBoundary(n.nodeName)).sort((a, b) => a.nodeId - b.nodeId);
  let cursor = 0;
  for (const node of ordered) {
    const wanted = planTextName(node.nodeName);
    let at = -1;
    for (let i = cursor; i < text.tree.length; i++) {
      if (text.tree[i]?.name === wanted) {
        at = i;
        break;
      }
    }
    if (at < 0) continue;
    cursor = at + 1;
    const entry = text.tree[at]!;
    const lines = text.appendix.get(entry.id);
    if (lines?.length) {
      const head = lines[0]!.replace(/^\(\d+\)\s*/, "");
      if (planTextName(head.split("[")[0] ?? "") !== wanted) continue;
      out.set(node.nodeId, [head, ...lines.slice(1)].join("\n"));
    } else if (entry.line) {
      out.set(node.nodeId, entry.line);
    }
  }
  return out;
}

/**
 * Codegen scope membership is per-node, so the cluster set is derived rather than declared. Each boundary entry's own
 * metric (its duration) rides on the frame as a tooltip, matching Spark's own box, so dropping the stray card does not
 * drop the number it carried.
 */
function codegenClusters(nodes: readonly SqlPlanNode[]): GraphCluster[] {
  const ids = new Set<number>();
  const details = new Map<string, string>();
  for (const n of nodes) {
    if (isCodegenBoundary(n.nodeName)) {
      const detail = sqlMetricSummary(n);
      if (detail) details.set(n.nodeName.trim(), detail);
      continue;
    }
    if (typeof n.wholeStageCodegenId === "number") ids.add(n.wholeStageCodegenId);
  }
  const out: GraphCluster[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const label = codegenClusterLabel(id);
    const detail = details.get(label);
    out.push({ id: `wsg.${id}`, label, parentId: null, codegenId: id, ...(detail ? { detail } : {}) });
  }
  return out;
}

/** SQL operators use the same roomy, two-row card face as RDD operations. */
function sqlNodeSize(node: SqlPlanNode): NodeSize {
  const longest = Math.max(node.nodeName.length, sqlMetricSummary(node, 1)?.length ?? 0);
  const width = Math.max(254, Math.min(336, 184 + longest * 7.4));
  const height = NODE_SIZE.sql!.height;
  return { width, height };
}

export function buildSqlPlanGraph(plan: SqlPlanExecution): RenderGraph {
  const warnings: string[] = [];
  const nodes: GraphNode[] = [];
  const sizes = new Map<string, NodeSize>();
  const seen = new Set<string>();
  const planLines = matchPlanDetails(plan.nodes ?? [], parsePlanText(plan.planDescription));
  for (const n of plan.nodes) {
    // The codegen boundary is drawn as the cluster, not as an operator card; see `isCodegenBoundary`.
    if (isCodegenBoundary(n.nodeName)) continue;
    const id = `sql.${n.nodeId}`;
    if (seen.has(id)) {
      warnings.push(`duplicate plan node id ${n.nodeId} — the second occurrence was dropped`);
      continue;
    }
    seen.add(id);
    const planLine = n.planLine || planLines.get(n.nodeId);
    nodes.push({
      id,
      label: n.nodeName,
      sublabel: sqlMetricSummary(n),
      kind: "sql",
      ref: n.nodeId,
      metrics: n.metrics,
      clusterId: typeof n.wholeStageCodegenId === "number" ? `wsg.${n.wholeStageCodegenId}` : null,
      ...(planLine ? { detail: planLine } : {}),
    });
    sizes.set(id, sqlNodeSize(n));
  }
  const edges: GraphEdge[] = [];
  for (const e of plan.edges) {
    const from = `sql.${e.fromId}`;
    const to = `sql.${e.toId}`;
    if (!seen.has(from) || !seen.has(to)) {
      warnings.push(`plan edge ${e.fromId}→${e.toId} references an unknown operator`);
      continue;
    }
    const fromNode = nodes.find((x) => x.id === from);
    const toNode = nodes.find((x) => x.id === to);
    edges.push({
      id: `sql.e${e.fromId}>${e.toId}`,
      from,
      to,
      kind: "sql",
      fromRef: e.fromId,
      toRef: e.toId,
      crossCluster: (fromNode?.clusterId ?? null) !== (toNode?.clusterId ?? null),
    });
  }
  const clusters = codegenClusters(plan.nodes);
  // Plan nodes whose WholeStageCodegen id never appeared (partial payloads) are pulled out of their dead cluster.
  const clusterIds = new Set(clusters.map((c) => c.id));
  for (const n of nodes) {
    if (n.clusterId && !clusterIds.has(n.clusterId)) {
      warnings.push(`${n.label}: wholeStageCodegenId ${n.clusterId.slice(4)} has no other members`);
      n.clusterId = null;
    }
  }
  return {
    hash: hashGraph("sql", "rdd", { nodes, edges, clusters, sizes }),
    kind: "sql",
    granularity: "rdd",
    nodes,
    edges,
    clusters,
    sizes,
    large: nodes.length > 500,
    warnings,
    notes: [],
    inferred: false,
    source: plan,
  };
}

export const SQL_CLUSTER_PADDING = CLUSTER_PADDING;
