/**
 * Nodes domain: pure derivations shared by the list, the heatmap and the detail page.
 * Everything here is display logic only — the *raw* value still goes through `<Datum>` (docs/contracts/parity-dom.md).
 *
 * Ground truth for the legacy columns/formats: `NodesPage.java` (Hadoop 3.4.3) and `dao/NodeInfo.java`:
 *   - "Phys Mem Used %"  = (int) info.getMemUtilization()   -> REST `memUtilization`
 *   - "Phys VCores Used %" = (int) info.getVcoreUtilization() -> REST `cpuUtilization` (field name on the wire)
 *   - "Mem Used/Avail"   = StringUtils.byteDesc(mb * 1MiB)  (binary 1024-based)
 *   - "Allocation Tags"  = AllocationTagsInfo.toString() = "tag(count),tag(count)"
 *   - inactive nodes (DECOMMISSIONED/LOST/REBOOTED/SHUTDOWN) have an empty nodeHTTPAddress and render "N/A" in legacy
 */
import type { Node, NodeLabel } from "~/api/schemas";

/** Node lifecycle filters. The default view includes every state, including unhealthy nodes. */
export const NODE_STATE_TABS = [
  { id: "ALL", label: "All" },
  { id: "NEW", label: "New" },
  { id: "RUNNING", label: "Running" },
  { id: "UNHEALTHY", label: "Unhealthy" },
  { id: "DECOMMISSIONING", label: "Decommissioning" },
  { id: "DECOMMISSIONED", label: "Decommissioned" },
  { id: "LOST", label: "Lost" },
  { id: "REBOOTED", label: "Rebooted" },
  { id: "SHUTDOWN", label: "Shutdown" },
] as const;

export type NodeStateTab = (typeof NODE_STATE_TABS)[number]["id"];

export function inTab(node: Pick<Node, "state">, tab: NodeStateTab): boolean {
  if (tab === "ALL") return true;
  return node.state === tab;
}

export function countByTab(nodes: readonly Pick<Node, "state">[], tab: NodeStateTab): number {
  return nodes.reduce((n, node) => (inTab(node, tab) ? n + 1 : n), 0);
}

/** Diagnostic text can be present on a healthy node. Use the RM's explicit state instead. */
export function healthOf(node: Pick<Node, "state">): "healthy" | "unhealthy" | "unknown" {
  if (node.state === "UNHEALTHY") return "unhealthy";
  if (node.state === "RUNNING") return "healthy";
  return "unknown";
}

export interface Util {
  /** 0..100, from `memUtilization` */
  mem: number;
  /** 0..100, from `cpuUtilization` (legacy "Phys VCores Used %") */
  cpu: number;
  /** the worst of the two, for heatmap colouring / sorting */
  max: number;
}

export function utilOf(node: Pick<Node, "memUtilization" | "cpuUtilization">): Util {
  const mem = numOf(node.memUtilization);
  const cpu = numOf(node.cpuUtilization);
  return { mem, cpu, max: Math.max(mem, cpu) };
}

/** Mean NodeManager physical-memory utilization for active nodes that reported a measurement. */
export function averageNodeMemoryUtilization(nodes: readonly (Pick<Node, "state"> & { memUtilization?: number | null })[]): {
  percent: number | null;
  reportingNodes: number;
} {
  const reported = nodes
    .filter((node) => node.state === "RUNNING" || node.state === "UNHEALTHY")
    .map((node) => node.memUtilization)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (reported.length === 0) return { percent: null, reportingNodes: 0 };
  return { percent: reported.reduce((sum, value) => sum + value, 0) / reported.length, reportingNodes: reported.length };
}

/** Resource number with Hadoop's "absent means zero" semantics (an inactive node reports neither used nor avail). */
export function numOf(v: number | undefined | null): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export type UtilBand = "idle" | "ok" | "busy" | "hot" | "full";

export function utilBand(pct: number): UtilBand {
  if (pct >= 90) return "full";
  if (pct >= 75) return "hot";
  if (pct >= 50) return "busy";
  if (pct > 0) return "ok";
  return "idle";
}

export const UTIL_BAND_TONE: Record<UtilBand, string> = {
  idle: "var(--seam)",
  ok: "var(--ok)",
  busy: "var(--live)",
  hot: "var(--wait)",
  full: "var(--fail)",
};

/** mem used+avail may be 0 for an inactive node; fall back to totalResource so percentages stay meaningful. */
export function totalMemoryMB(node: Pick<Node, "usedMemoryMB" | "availMemoryMB" | "totalResource">): number {
  const used = numOf(node.usedMemoryMB);
  const avail = numOf(node.availMemoryMB);
  if (used + avail > 0) return used + avail;
  return numOf(node.totalResource?.memory);
}

export function totalVCores(node: Pick<Node, "usedVirtualCores" | "availableVirtualCores" | "totalResource">): number {
  const used = numOf(node.usedVirtualCores);
  const avail = numOf(node.availableVirtualCores);
  if (used + avail > 0) return used + avail;
  return numOf(node.totalResource?.vCores);
}

export interface ResourceMatrixRow {
  name: string;
  units: string;
  resourceType: string;
  total: number;
  /** undefined when the RM did not report a used-resource entry for this type */
  used: number | undefined;
  available: number | undefined;
  minimumAllocation: number | undefined;
  maximumAllocation: number | undefined;
  tags: string[];
}

/**
 * Every resource type the node advertises (memory-mb, vcores, GPUs, …) with total/used/available. The RM publishes the same
 * types on `totalResource`, `usedResource` and `availableResource`; this joins them by name so a custom resource (e.g.
 * `yarn.io/gpu`) is shown with the same columns as memory.
 */
export function resourceMatrix(node: Pick<Node, "totalResource" | "usedResource" | "availableResource">): ResourceMatrixRow[] {
  const totals = node.totalResource?.resourceInformations?.resourceInformation ?? [];
  const useds = new Map((node.usedResource?.resourceInformations?.resourceInformation ?? []).map((r) => [r.name, r] as const));
  const avails = new Map((node.availableResource?.resourceInformations?.resourceInformation ?? []).map((r) => [r.name, r] as const));
  return totals.map((r) => ({
    name: r.name,
    units: r.units ?? "",
    resourceType: r.resourceType ?? "",
    total: r.value,
    used: useds.get(r.name)?.value,
    available: avails.get(r.name)?.value,
    minimumAllocation: r.minimumAllocation,
    maximumAllocation: r.maximumAllocation,
    tags: r.tags ?? [],
  }));
}

/** Legacy "Allocation Tags" cell text: `tag(count),tag2(count)`. */
export function allocationTagSummary(node: Pick<Node, "allocationTags">): string {
  const tags = node.allocationTags?.allocationTagInfo ?? [];
  return tags.map((t) => `${t.allocationTag}(${t.allocationsCount})`).join(",");
}

export function allocationTags(node: Pick<Node, "allocationTags">): { tag: string; count: number }[] {
  return (node.allocationTags?.allocationTagInfo ?? []).map((t) => ({ tag: t.allocationTag, count: t.allocationsCount }));
}

/** The two resource types that already have dedicated legacy columns; the custom-resource loop skips them (NodesPage.java:238-242). */
export const STANDARD_RESOURCE_TYPES = ["memory-mb", "vcores"] as const;

/**
 * Every resource type the legacy `/cluster/nodes` page renders a `"{type} Used"`/`"{type} Avail"` column pair for:
 * all types other than memory-mb/vcores (NodesPage.java:239-249). Legacy reads the RM's configured type index; the RM
 * publishes the same types on each node's total/used/available resource, so we take the union over the node list,
 * preserving the RM's order. A cluster with no custom type configured (the live one: only memory-mb/vcores) yields [].
 */
export function customResourceNames(nodes: readonly Pick<Node, "totalResource" | "usedResource" | "availableResource">[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    for (const info of [node.totalResource, node.usedResource, node.availableResource]) {
      for (const r of info?.resourceInformations?.resourceInformation ?? []) {
        if (!(STANDARD_RESOURCE_TYPES as readonly string[]).includes(r.name) && !names.includes(r.name)) names.push(r.name);
      }
    }
  }
  return names;
}

/**
 * One custom resource's used/available value for a node, name-matched against `usedResource`/`availableResource`
 * (NodesPage.java:246-248). Hadoop's `Resource.getResourceValue` returns 0 for a type the node does not report.
 */
export function customResourceValue(node: Pick<Node, "usedResource" | "availableResource">, name: string, kind: "used" | "avail"): number {
  const list = (kind === "used" ? node.usedResource : node.availableResource)?.resourceInformations?.resourceInformation ?? [];
  return list.find((r) => r.name === name)?.value ?? 0;
}

/** Contains / label / rack / free-text predicate shared by the table, heatmap and top-consumers panel. */
export interface NodeFilter {
  label?: string | null;
  rack?: string | null;
  q?: string;
}

export function matchesFilter(node: Node, f: NodeFilter): boolean {
  if (f.label) {
    const labels = node.nodeLabels ?? [];
    if (f.label === "(none)") {
      if (labels.length > 0) return false;
    } else if (!labels.includes(f.label)) return false;
  }
  if (f.rack && (node.rack || "/default-rack") !== f.rack) return false;
  const q = f.q?.trim().toLowerCase();
  if (q) {
    const hay = [
      node.id,
      node.nodeHostName,
      node.nodeHTTPAddress,
      node.rack,
      node.state,
      node.version ?? "",
      (node.nodeLabels ?? []).join(","),
      allocationTagSummary(node),
      node.healthReport,
    ]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** `container_<ts>_<seq>_<attempt>_<num>` -> `application_<ts>_<seq>`; `null` when the id is not a container id. */
export function appIdOfContainer(containerId: string): string | null {
  const m = /^container_(?:e\d+_)?(\d+)_(\d+)_\d+_\d+$/.exec(containerId);
  return m ? `application_${m[1]}_${m[2]}` : null;
}

export interface LabelRow {
  label: NodeLabel;
  /** derived from `/nodes` — REST `/get-node-labels` does not serialise `RMNodeLabel.getNumActiveNMs()` */
  activeNMs: number;
  /** derived: the live nodes sitting in this label's partition */
  nodes: Node[];
  /** true for the DEFAULT partition row synthesized from the nodes that carry no label */
  derived: boolean;
}

export const DEFAULT_LABEL = "";
export const DEFAULT_PARTITION_TEXT = "<DEFAULT_PARTITION>";

/** NodeLabelsPage.java:61-63 — empty label name is the default partition. */
export const labelNameText = (name: string): string => (name === DEFAULT_LABEL ? DEFAULT_PARTITION_TEXT : name);

/** NodeLabelsPage.java:64-66. */
export const labelTypeText = (exclusive: boolean): string => (exclusive ? "Exclusive Partition" : "Non Exclusive Partition");

/** `Resource.toString()` as the legacy label table prints it: `<memory:3 GB, vCores:4>` (byteDesc of MiB). */
export const resourceText = (memoryMB: number, vCores: number): string => `<memory:${byteDescMB(memoryMB)}, vCores:${vCores}>`;

/** Hadoop `StringUtils.byteDesc(mb MiB)`: binary prefixes spelled KB/MB/GB/TB…, one decimal only when not integral. */
export function byteDescMB(mb: number): string {
  const units = ["MB", "GB", "TB", "PB", "EB"];
  let v = mb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`;
}

/**
 * Build the label catalogue exactly as `/cluster/nodelabels` shows it: every declared label plus (when the REST list omits
 * it, which Hadoop 3.4.3 does) the DEFAULT partition derived from unlabelled nodes.
 */
export function buildLabelRows(labels: readonly NodeLabel[], nodes: readonly Node[]): LabelRow[] {
  const rows: LabelRow[] = labels.map((label) => {
    const members =
      label.name === DEFAULT_LABEL
        ? nodes.filter((n) => (n.nodeLabels ?? []).length === 0)
        : nodes.filter((n) => (n.nodeLabels ?? []).includes(label.name));
    return {
      label,
      activeNMs: members.filter((n) => n.state === "RUNNING" || n.state === "DECOMMISSIONING").length,
      nodes: members,
      derived: false,
    };
  });
  if (!labels.some((l) => l.name === DEFAULT_LABEL)) {
    const unlabelled = nodes.filter((n) => (n.nodeLabels ?? []).length === 0 && (n.state === "RUNNING" || n.state === "DECOMMISSIONING"));
    if (unlabelled.length > 0) {
      rows.push({
        // The default partition is always exclusive; its total is the sum of used+available over its nodes (RMNodeLabel.getResource()).
        label: {
          name: DEFAULT_LABEL,
          exclusivity: true,
          activeNMs: unlabelled.length,
          partitionInfo: {
            resourceAvailable: {
              memory: unlabelled.reduce((a, n) => a + n.usedMemoryMB + n.availMemoryMB, 0),
              vCores: unlabelled.reduce((a, n) => a + n.usedVirtualCores + n.availableVirtualCores, 0),
            },
          },
        },
        activeNMs: unlabelled.length,
        nodes: unlabelled,
        derived: true,
      });
    }
  }
  return rows.sort((a, b) =>
    a.label.name === DEFAULT_LABEL ? -1 : b.label.name === DEFAULT_LABEL ? 1 : a.label.name.localeCompare(b.label.name),
  );
}

/** Distinct racks, `/default-rack` for nodes without one (Hadoop's default). */
export function rackOf(node: Pick<Node, "rack">): string {
  return node.rack && node.rack !== "" ? node.rack : "/default-rack";
}

export function groupByRack(nodes: readonly Node[]): { rack: string; nodes: Node[] }[] {
  const map = new Map<string, Node[]>();
  for (const node of nodes) {
    const rack = rackOf(node);
    const arr = map.get(rack);
    if (arr) arr.push(node);
    else map.set(rack, [node]);
  }
  return [...map.entries()]
    .map(([rack, list]) => ({ rack, nodes: [...list].sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.rack.localeCompare(b.rack));
}

export interface NodeSummary {
  total: number;
  running: number;
  unhealthy: number;
  inactive: number;
  lost: number;
  containers: number;
  memUsedMB: number;
  memTotalMB: number;
  vcoresUsed: number;
  vcoresTotal: number;
  worst: number;
}

export function summarize(nodes: readonly Node[]): NodeSummary {
  const s: NodeSummary = {
    total: nodes.length,
    running: 0,
    unhealthy: 0,
    inactive: 0,
    lost: 0,
    containers: 0,
    memUsedMB: 0,
    memTotalMB: 0,
    vcoresUsed: 0,
    vcoresTotal: 0,
    worst: 0,
  };
  for (const n of nodes) {
    if (n.state === "RUNNING") s.running++;
    if (n.state === "UNHEALTHY") s.unhealthy++;
    if (n.state === "LOST") s.lost++;
    if (n.state === "DECOMMISSIONED" || n.state === "LOST" || n.state === "REBOOTED" || n.state === "SHUTDOWN") s.inactive++;
    s.containers += numOf(n.numContainers);
    s.memUsedMB += numOf(n.usedMemoryMB);
    s.memTotalMB += totalMemoryMB(n);
    s.vcoresUsed += numOf(n.usedVirtualCores);
    s.vcoresTotal += totalVCores(n);
    const u = utilOf(n);
    if (n.state === "RUNNING" && u.max > s.worst) s.worst = u.max;
  }
  return s;
}
