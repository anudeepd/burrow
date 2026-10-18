/**
 * Scheduler domain model — normalises the three YARN scheduler REST shapes (Capacity / Fair / FIFO) into one tree the
 * views can render, WITHOUT inventing values: every normalised number is read from a real REST key and the raw object is
 * kept so components can stamp `data-yv` from it (docs/contracts/parity-dom.md).
 *
 * Shapes:
 *  - Capacity: `capacityScheduler` → `queues.queue[]` children, nested; leaves carry `type: capacitySchedulerLeafQueueInfo`.
 *  - Fair:     `fairScheduler` → `rootQueue` → `childQueues.queue[]`; `queueName` is the full path.
 *  - FIFO:     a single `scheduler` object with cluster-wide numbers; no queues.
 */
import { isCapacityScheduler, isFairScheduler } from "~/api/schemas";
import type {
  Activities,
  ActivityNode,
  CapacitySchedulerInfo,
  FairQueueInfo,
  FairSchedulerInfo,
  PartitionCapacity,
  PartitionResourcesInfo,
  QueueCapacityVector,
  QueueInfo,
  QueueTemplateProperties,
  SchedulerHealth,
  SchedulerInfo,
} from "~/api/schemas";

export type SchedKind = "capacity" | "fair" | "fifo" | "unknown";

export function schedKindOf(info: SchedulerInfo): SchedKind {
  switch (info.type) {
    case "capacityScheduler":
      return "capacity";
    case "fairScheduler":
      return "fair";
    case "fifoScheduler":
      return "fifo";
    default:
      return "unknown";
  }
}

/** Root-only keys the tree renders on the scheduler header; `root` is a `CapacitySchedulerInfo`, children are `QueueInfo`s. */
interface CapacityRootOnly {
  health?: SchedulerHealth;
  queueCapacityVectorInfo?: QueueCapacityVector;
  autoQueueTemplateProperties?: QueueTemplateProperties;
}
export type CapacityRaw = Partial<QueueInfo> & CapacityRootOnly;

export interface QueueNode {
  /** parity entity key (docs/contracts/parity-dom.md): the full queue path. */
  id: string;
  /** display name (last path segment for capacity; `queueName` is already the full path for fair). */
  name: string;
  depth: number;
  role: "root" | "parent" | "leaf";
  children: QueueNode[];
  capacity?: CapacityRaw;
  fair?: FairQueueInfo;
}

export interface QueueMetrics {
  // capacity (% of the queue's own share, or of the cluster for `absolute*`)
  usedPct: number | null;
  absUsedPct: number | null;
  capPct: number | null;
  absCapPct: number | null;
  maxPct: number | null;
  absMaxPct: number | null;
  // absolute resources (MB / vcores)
  usedMb: number | null;
  usedVcores: number | null;
  reservedMb: number | null;
  pendingMb: number | null;
  amUsedMb: number | null;
  amLimitMb: number | null;
  userAmLimitMb: number | null;
  maxMb: number | null;
  minMb: number | null;
  // counters
  apps: number | null;
  activeApps: number | null;
  pendingApps: number | null;
  containers: number | null;
  pendingContainers: number | null;
  reservedContainers: number | null;
  maxApps: number | null;
  maxAppsPerUser: number | null;
  userLimit: number | null;
  userLimitFactor: number | null;
  // fair-specific
  fairMb: number | null;
  steadyFairMb: number | null;
  demandMb: number | null;
  clusterMb: number | null;
  policy: string | null;
  preemptable: boolean | null;
}

const NO_METRICS: QueueMetrics = {
  usedPct: null,
  absUsedPct: null,
  capPct: null,
  absCapPct: null,
  maxPct: null,
  absMaxPct: null,
  usedMb: null,
  usedVcores: null,
  reservedMb: null,
  pendingMb: null,
  amUsedMb: null,
  amLimitMb: null,
  userAmLimitMb: null,
  maxMb: null,
  minMb: null,
  apps: null,
  activeApps: null,
  pendingApps: null,
  containers: null,
  pendingContainers: null,
  reservedContainers: null,
  maxApps: null,
  maxAppsPerUser: null,
  userLimit: null,
  userLimitFactor: null,
  fairMb: null,
  steadyFairMb: null,
  demandMb: null,
  clusterMb: null,
  policy: null,
  preemptable: null,
};

/** `"NaN"`/`"Infinity"`/`"-1"`/absent are all "no number" for display purposes (the schema already maps NaN → number). */
export function num(v: unknown): number | null {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function capacityMetrics(raw: CapacityRaw, partition = ""): QueueMetrics {
  const part = raw.resources?.resourceUsagesByPartition?.find((p) => (p.partitionName ?? "") === partition);
  const cap = raw.capacities?.queueCapacitiesByPartition?.find((p) => (p.partitionName ?? "") === partition);
  const r = raw.resourcesUsed;
  return {
    ...NO_METRICS,
    usedPct: num(cap?.usedCapacity) ?? num(raw.usedCapacity),
    absUsedPct: num(cap?.absoluteUsedCapacity) ?? num(raw.absoluteUsedCapacity),
    capPct: num(cap?.capacity) ?? num(raw.capacity),
    absCapPct: num(cap?.absoluteCapacity) ?? num(raw.absoluteCapacity),
    maxPct: num(cap?.maxCapacity) ?? num(raw.maxCapacity),
    absMaxPct: num(cap?.absoluteMaxCapacity) ?? num(raw.absoluteMaxCapacity),
    usedMb: num(r?.memory) ?? num(part?.used?.memory),
    usedVcores: num(r?.vCores) ?? num(part?.used?.vCores),
    reservedMb: num(part?.reserved?.memory),
    pendingMb: num(part?.pending?.memory),
    amUsedMb: num(part?.amUsed?.memory),
    amLimitMb: num(part?.amLimit?.memory),
    userAmLimitMb: num(part?.userAmLimit?.memory),
    maxMb: num(raw.maxEffectiveCapacity?.memory) ?? num(cap?.effectiveMaxResource?.memory),
    minMb: num(raw.minEffectiveCapacity?.memory) ?? num(cap?.effectiveMinResource?.memory),
    apps: num(raw.numApplications),
    activeApps: num(raw.numActiveApplications),
    pendingApps: num(raw.numPendingApplications),
    containers: num(raw.numContainers) ?? num(raw.allocatedContainers),
    pendingContainers: num(raw.pendingContainers),
    reservedContainers: num(raw.reservedContainers),
    maxApps: num(raw.maxApplications),
    maxAppsPerUser: num(raw.maxApplicationsPerUser),
    userLimit: num(raw.userLimit),
    userLimitFactor: num(raw.userLimitFactor),
    policy: raw.orderingPolicyInfo ?? null,
    preemptable: raw.preemptionDisabled == null ? null : !raw.preemptionDisabled,
  };
}

export function fairMetrics(q: FairQueueInfo): QueueMetrics {
  return {
    ...NO_METRICS,
    usedMb: num(q.usedResources?.memory),
    usedVcores: num(q.usedResources?.vCores),
    reservedMb: num(q.reservedResources?.memory),
    minMb: num(q.minResources?.memory),
    maxMb: num(q.maxResources?.memory),
    fairMb: num(q.fairResources?.memory),
    steadyFairMb: num(q.steadyFairResources?.memory),
    demandMb: num(q.demandResources?.memory),
    clusterMb: num(q.clusterResources?.memory),
    amUsedMb: num(q.amUsedResources?.memory),
    amLimitMb: num(q.amMaxResources?.memory),
    activeApps: num(q.numActiveApps),
    pendingApps: num(q.numPendingApps),
    containers: num(q.allocatedContainers),
    pendingContainers: num(q.pendingContainers),
    reservedContainers: num(q.reservedContainers),
    maxApps: num(q.maxApps),
    policy: q.schedulingPolicy ?? null,
    preemptable: q.preemptable ?? null,
  };
}

export function metricsOf(node: QueueNode, partition = ""): QueueMetrics {
  if (node.capacity) return capacityMetrics(node.capacity, partition);
  if (node.fair) return fairMetrics(node.fair);
  return NO_METRICS;
}

/** Pressure uses each scheduler's share metric, never a cluster-wide percentage. */
export function pressurePctOf(node: QueueNode, metrics: QueueMetrics): number | null {
  if (node.capacity) {
    if (metrics.absCapPct === 0 && metrics.absUsedPct != null && metrics.absUsedPct > 0) return Number.POSITIVE_INFINITY;
    if (metrics.usedPct != null) return metrics.usedPct;
    return metrics.absUsedPct != null && metrics.absCapPct != null && metrics.absCapPct > 0
      ? (metrics.absUsedPct / metrics.absCapPct) * 100
      : null;
  }
  if (metrics.fairMb === 0 && metrics.usedMb != null && metrics.usedMb > 0) return Number.POSITIVE_INFINITY;
  return metrics.fairMb != null && metrics.fairMb > 0 && metrics.usedMb != null ? (metrics.usedMb / metrics.fairMb) * 100 : null;
}

/** The queue's capacity/resource entry for one node-label partition (default partition = ""). */
export function partitionOf(
  node: QueueNode,
  partition: string,
): { cap: PartitionCapacity | undefined; res: PartitionResourcesInfo | undefined } {
  const raw = node.capacity;
  if (!raw) return { cap: undefined, res: undefined };
  return {
    cap: raw.capacities?.queueCapacitiesByPartition?.find((p) => (p.partitionName ?? "") === partition),
    res: raw.resources?.resourceUsagesByPartition?.find((p) => (p.partitionName ?? "") === partition),
  };
}

/** Every node-label partition this scheduler knows about, default partition ("") first. */
export function partitionNames(root: QueueNode): string[] {
  const seen = new Set<string>();
  for (const q of walkTree(root)) {
    for (const p of q.capacity?.capacities?.queueCapacitiesByPartition ?? []) seen.add(p.partitionName ?? "");
  }
  const all = [...seen];
  return all.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

// ---------------------------------------------------------------------------- tree building

export function buildCapacityTree(info: CapacitySchedulerInfo): QueueNode {
  const build = (raw: CapacityRaw, depth: number, fallbackPath: string): QueueNode => {
    const id = (typeof raw.queuePath === "string" && raw.queuePath) || fallbackPath;
    const children = (raw.queues?.queue ?? []).map((c) => build(c, depth + 1, id));
    const role: QueueNode["role"] = depth === 0 ? "root" : children.length ? "parent" : "leaf";
    return { id, name: id.split(".").pop() ?? id, depth, role, children, capacity: raw };
  };
  return build(info, 0, info.queuePath ?? info.queueName ?? "root");
}

export function buildFairTree(info: FairSchedulerInfo): QueueNode {
  const build = (raw: FairQueueInfo, depth: number, fallbackPath: string): QueueNode => {
    const rawName = raw.queueName || fallbackPath;
    const children = (raw.childQueues?.queue ?? []).map((c) => build(c, depth + 1, rawName));
    const role: QueueNode["role"] = depth === 0 ? "root" : children.length ? "parent" : "leaf";
    return { id: rawName, name: rawName.split(".").pop() ?? rawName, depth, role, children, fair: raw };
  };
  return build(info.rootQueue, 0, info.rootQueue.queueName || "root");
}

export function buildTree(info: SchedulerInfo): QueueNode | null {
  // the exported type guards, not `info.type === …`: the union also holds a loose "unknown scheduler" member, which
  // defeats TypeScript's discriminant narrowing.
  if (isCapacityScheduler(info)) return buildCapacityTree(info);
  if (isFairScheduler(info)) return buildFairTree(info);
  return null;
}

export function walkTree(node: QueueNode): QueueNode[] {
  return [node, ...node.children.flatMap(walkTree)];
}

export function findQueue(node: QueueNode | null, path: string): QueueNode | null {
  if (!node) return null;
  return walkTree(node).find((n) => n.id === path) ?? null;
}

export function leafNodes(node: QueueNode): QueueNode[] {
  return node.children.length ? node.children.flatMap(leafNodes) : [node];
}

// ---------------------------------------------------------------------------- headroom / freeness

export interface Headroom {
  /** unused portion of the queue's guaranteed share, as a percentage of that share (0 when full/over) */
  guaranteedFreePct: number | null;
  /** unused portion of maxCapacity, as a percentage of that limit (0 when full/over) */
  burstRoomPct: number | null;
  /** absolute MB free before the queue's max (maxEffective/maxResources − used) */
  freeMb: number | null;
  /** fair-share freeness in MB (Fair only): fairResources − usedResources */
  fairShareFreeMb: number | null;
}

/** Non-negative part of a headroom delta (used by every bar: a queue over its share has zero *free* room). */
export const freeOf = (v: number): number => (v > 0 ? v : 0);

/** Remaining percentage within a limit; null when the limit is absent or zero. */
function remainingPct(used: number | null, limit: number | null): number | null {
  if (used == null || limit == null || limit <= 0) return null;
  return Math.min(100, freeOf(((limit - used) / limit) * 100));
}

export function headroomOf(node: QueueNode, partition = ""): Headroom {
  const m = metricsOf(node, partition);
  const absUsed = m.absUsedPct;
  const absCap = m.absCapPct;
  const absMax = m.absMaxPct;
  const freeMb = m.maxMb != null && m.usedMb != null ? freeOf(m.maxMb - m.usedMb) : null;
  if (node.capacity) {
    // `usedCapacity` is already expressed as a percentage of the queue's own guarantee.
    // Display the unused share, not the same amount as percentage points of the whole cluster.
    const guaranteedFreePct = m.usedPct == null ? remainingPct(absUsed, absCap) : Math.min(100, freeOf(100 - m.usedPct));
    return {
      guaranteedFreePct,
      burstRoomPct: remainingPct(absUsed, absMax),
      freeMb,
      fairShareFreeMb: null,
    };
  }
  return {
    guaranteedFreePct: null,
    burstRoomPct: null,
    freeMb,
    fairShareFreeMb: m.fairMb != null && m.usedMb != null ? m.fairMb - m.usedMb : null,
  };
}

/** Used as a share of the fair share (Fair) — `null` when there is no fair share. */
export function usedOfFairPct(node: QueueNode): number | null {
  const m = metricsOf(node);
  if (m.fairMb == null || m.fairMb <= 0 || m.usedMb == null) return null;
  return (m.usedMb / m.fairMb) * 100;
}

/** Used as a share of the minimum share (Fair) — `null` when min is 0 (unset). */
export function usedOfMinPct(node: QueueNode): number | null {
  const m = metricsOf(node);
  if (m.minMb == null || m.minMb <= 0 || m.usedMb == null) return null;
  return (m.usedMb / m.minMb) * 100;
}

/** How many queues in this subtree are over their guaranteed share (the tree's summary pill). */
export function overShareCount(node: QueueNode, partition = ""): number {
  let n = 0;
  for (const q of walkTree(node)) {
    const m = metricsOf(q, partition);
    const absUsed = m.absUsedPct ?? m.usedPct;
    const absCap = m.absCapPct ?? m.capPct;
    if (absUsed != null && absCap != null && absUsed > absCap + 0.01) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------- activities

export interface ActivityRow {
  /** epoch ms of the containing activity snapshot */
  time: number | null;
  containerId: string | null;
  nodeId: string | null;
  /** queue path from the allocation tree node */
  queue: string;
  state: string | null;
  diagnostic: string | null;
  partition: string | null;
  finalState: string | null;
  /** depth of the allocation-tree node (root = 0), so the datum path can mirror the nesting */
  depth: number;
  /** the allocation-tree node the row came from */
  raw: ActivityNode;
}

/** Field id for a leaf of an allocation-tree node at `depth` (entity `activities`, per the inventory owner). */
export function activityField(depth: number, leaf: string): string {
  return `activities.allocations.root${".children".repeat(Math.max(0, depth))}.${leaf}`;
}

const EMPTY_ACTIVITY_NODE: ActivityNode = { nodeIds: [], children: [] };

function walkActivity(node: ActivityNode, out: { node: ActivityNode; depth: number }[], depth: number): void {
  out.push({ node, depth });
  for (const c of node.children ?? []) walkActivity(c, out, depth + 1);
}

/** Flatten every allocation snapshot into one row per (allocation, queue-tree node). */
export function activityRows(activities: Activities | undefined): ActivityRow[] {
  if (!activities) return [];
  const rows: ActivityRow[] = [];
  for (const alloc of activities.allocations ?? []) {
    const nodes: { node: ActivityNode; depth: number }[] = [];
    if (alloc.root) walkActivity(alloc.root, nodes, 0);
    if (!nodes.length) {
      rows.push({
        time: num(activities.timestamp),
        containerId: alloc.updatedContainerId ?? null,
        nodeId: activities.nodeId ?? null,
        queue: activities.diagnostic ?? "",
        state: null,
        diagnostic: activities.diagnostic ?? null,
        partition: alloc.partition ?? null,
        finalState: alloc.finalAllocationState ?? null,
        depth: 0,
        raw: EMPTY_ACTIVITY_NODE,
      });
      continue;
    }
    for (const { node, depth } of nodes) {
      rows.push({
        time: num(activities.timestamp),
        containerId: alloc.updatedContainerId ?? null,
        nodeId: node.nodeId ?? node.nodeIds?.[0] ?? activities.nodeId ?? null,
        queue: node.name ?? "",
        state: node.allocationState ?? null,
        diagnostic: node.diagnostic ?? null,
        partition: alloc.partition ?? null,
        finalState: alloc.finalAllocationState ?? null,
        depth,
        raw: node,
      });
    }
  }
  return rows;
}

/** Rows whose queue is exactly `path` or below it. */
export function rowsForQueue(rows: ActivityRow[], path: string): ActivityRow[] {
  return rows.filter((r) => r.queue === path || r.queue.startsWith(`${path}.`));
}

// ---------------------------------------------------------------------------- health

export interface HealthOperationRow {
  operation: string;
  kind: "Allocation" | "Release" | "Preemption" | "Reservation" | "Other";
  nodeId: string | null;
  containerId: string | null;
  queue: string | null;
}

const OPERATION_KIND: Record<string, HealthOperationRow["kind"]> = {
  "last-allocation": "Allocation",
  "last-release": "Release",
  "last-preemption": "Preemption",
  "last-reservation": "Reservation",
};

export function healthOperations(health: SchedulerHealth | undefined): HealthOperationRow[] {
  return (health?.operationsInfo ?? []).map((o) => ({
    operation: o.operation,
    kind: OPERATION_KIND[o.operation] ?? "Other",
    nodeId: o.nodeId ?? null,
    containerId: o.containerId ?? null,
    queue: o.queue ?? null,
  }));
}

export const HEALTH_KINDS = ["Allocation", "Release", "Preemption", "Reservation"] as const;

export type { Activities };
