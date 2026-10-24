/**
 * Overview derivations — pure, total, testable (no React, no fetch).
 *
 * These mirror *exactly* what the legacy RM Overview renders, because the parity harness compares our visible text to
 * the legacy page's (docs/contracts/parity-dom.md, PLAN §8 P2). Sources are cited per function; the safe-conversions
 * (`byteDesc`, cross-partition switching, the `-1` sentinel) are the ones the legacy Java does, so the visible strings
 * are byte-identical to `/cluster/cluster` rather than "close enough".
 *
 * Nothing here formats for prettiness — `~/lib/format.ts` does that. This module exists only where Hadoop's own
 * rendering is part of the contract.
 */
import type { ClusterMetrics, FairQueueInfo, QueueInfo, ResourceInfo, SchedulerInfo } from "~/api/schemas";
import { FairQueueInfoSchema, QueueInfoSchema, ResourceInfoSchema } from "~/api/schemas";
import { type Fmt, fmtMB, fmtPct } from "~/lib/format";
import { rmProxyUrl } from "~/lib/upstream-url";

// ─────────────────────────────────────────────────────────────── Hadoop byteDesc

/**
 * `StringUtils.byteDesc(n)` = `TraditionalBinaryPrefix.long2String(n, "B", 2)` (hadoop-common 3.4.3).
 * Traditional (binary) prefixes with *short* symbols and the special case that a value which rounds up to `1024`
 * promotes to the next prefix, plus an exact-division fast path (`n >> bitShift`, no decimals).
 *
 *   byteDesc(0)          -> "0 B"
 *   byteDesc(9216 MiB)   -> "9 GB"
 *   byteDesc(1500 MiB)   -> "1.46 GB"
 */
const BINARY_PREFIXES: readonly { symbol: string; value: number }[] = [
  { symbol: "K", value: 1024 },
  { symbol: "M", value: 1024 ** 2 },
  { symbol: "G", value: 1024 ** 3 },
  { symbol: "T", value: 1024 ** 4 },
  { symbol: "P", value: 1024 ** 5 },
  { symbol: "E", value: 1024 ** 6 },
];

export function byteDesc(len: number | null | undefined): string {
  if (len == null || !Number.isFinite(len)) return "";
  const negative = len < 0;
  const n = Math.abs(len);
  let symbol = "";
  let scale = 1;
  for (const p of BINARY_PREFIXES) {
    if (n < p.value) break;
    symbol = p.symbol;
    scale = p.value;
  }
  if (scale === 1) return `${negative ? "-" : ""}${Math.trunc(n)} B`;
  let out: string;
  if (n % scale === 0) {
    out = String(n / scale); // exact division: no decimals (Java's `n >> bitShift`)
  } else {
    out = (n / scale).toFixed(2);
    if (out.startsWith("1024")) {
      // Java promotes a value that *rounds up* to 1024 to the next prefix instead of printing "1024 GB".
      const next = BINARY_PREFIXES[BINARY_PREFIXES.findIndex((p) => p.value === scale) + 1];
      if (next) {
        scale = next.value;
        symbol = next.symbol;
        out = (n / scale).toFixed(2);
      }
    }
  }
  return `${negative ? "-" : ""}${out} ${symbol}B`;
}

// ────────────────────────────────────────────────── Hadoop Resource / ResourceInfo

export interface CustomResource {
  name: string;
  value: number;
  units: string;
}

/** Custom (non memory/vcores) resource values, as `Resource.getFormattedString` walks `resources[2..]`. */
export function customResources(info: ResourceInfo | undefined | null): CustomResource[] {
  const list = info?.resourceInformations?.resourceInformation ?? [];
  return list
    .filter((ri) => ri.name !== "memory-mb" && ri.name !== "vcores" && Number(ri.value) !== 0)
    .map((ri) => ({ name: ri.name, value: Number(ri.value), units: ri.units ?? "" }));
}

function tail(customs: CustomResource[]): string {
  return customs.map((c) => `, ${c.name}: ${c.value}${c.units}`).join("");
}

/** `Resource.getFormattedString()` — `<memory:9 GB, vCores:12>` (memory through `byteDesc`). */
export function resourceText(memMB: number, vCores: number, customs: CustomResource[] = []): string {
  return `<memory:${byteDesc(memMB * 1024 * 1024)}, vCores:${vCores}${tail(customs)}>`;
}

/** Readable resource-pair summary using the same memory units as the Overview's Used Resources metric. */
export function resourceSummaryText(memMB: number, vCores: number, customs: CustomResource[] = []): string {
  return [
    `Memory ${byteDesc(memMB * 1024 * 1024)}`,
    `${vCores} ${vCores === 1 ? "vCore" : "vCores"}`,
    ...customs.map((resource) => `${resource.name}: ${resource.value}${resource.units ? ` ${resource.units}` : ""}`),
  ].join(" · ");
}

/** `ResourceInfo.toString()` = `Resource.toString()` — `<memory:256, vCores:1>` (raw MB/vcores, no unit). */
export function resourceInfoText(memMB: number, vCores: number, customs: CustomResource[] = []): string {
  return `<memory:${memMB}, vCores:${vCores}${tail(customs)}>`;
}

/**
 * `Resources.subtractFrom(used, reserved)`: the used-resources cell shows used *minus* reserved, custom resource types
 * included (a type only reserved for is dropped, not shown as a negative).
 */
export function subtractCustomResources(used: CustomResource[], reserved: CustomResource[]): CustomResource[] {
  return used.map((u) => ({ ...u, value: u.value - (reserved.find((r) => r.name === u.name)?.value ?? 0) })).filter((u) => u.value !== 0);
}

// ───────────────────────────────────────────────────────── cluster metrics (legacy)

/** Legacy "Apps Completed" = completed + failed + killed, in one cell (`MetricsOverviewTable.java:117`). */
export function appsCompletedAll(m: ClusterMetrics): number {
  return (m.appsCompleted ?? 0) + (m.appsFailed ?? 0) + (m.appsKilled ?? 0);
}

/** Legacy "Containers Running" (`MetricsOverviewTable.java:104`); the branch is `crossPartitionMetricsAvailable`. */
export function containersRunning(m: ClusterMetrics): number {
  return m.crossPartitionMetricsAvailable === true
    ? (m.totalAllocatedContainersAcrossPartition ?? m.containersAllocated ?? 0)
    : (m.containersAllocated ?? 0);
}

export interface ResourcePair {
  memory: number;
  vCores: number;
  customs: CustomResource[];
}

/** "Used Resources": cross-partition = totalUsed − totalReserved (`Resources.subtractFrom`). */
export function usedResources(m: ClusterMetrics): ResourcePair {
  if (m.crossPartitionMetricsAvailable === true && m.totalUsedResourcesAcrossPartition) {
    const used = m.totalUsedResourcesAcrossPartition;
    const reserved = m.totalReservedResourcesAcrossPartition;
    return {
      memory: Number(used.memory) - Number(reserved?.memory ?? 0),
      vCores: Number(used.vCores) - Number(reserved?.vCores ?? 0),
      customs: subtractCustomResources(customResources(used), customResources(reserved)),
    };
  }
  return { memory: m.allocatedMB ?? 0, vCores: m.allocatedVirtualCores ?? 0, customs: [] };
}

/** "Total Resources". */
export function totalResources(m: ClusterMetrics): ResourcePair {
  if (m.crossPartitionMetricsAvailable === true && m.totalClusterResourcesAcrossPartition) {
    const r = m.totalClusterResourcesAcrossPartition;
    return { memory: Number(r.memory), vCores: Number(r.vCores), customs: customResources(r) };
  }
  return { memory: m.totalMB ?? 0, vCores: m.totalVirtualCores ?? 0, customs: [] };
}

/** "Reserved Resources". */
export function reservedResources(m: ClusterMetrics): ResourcePair {
  if (m.crossPartitionMetricsAvailable === true && m.totalReservedResourcesAcrossPartition) {
    const r = m.totalReservedResourcesAcrossPartition;
    return { memory: Number(r.memory), vCores: Number(r.vCores), customs: customResources(r) };
  }
  return { memory: m.reservedMB ?? 0, vCores: m.reservedVirtualCores ?? 0, customs: [] };
}

/**
 * "Scheduler Busy %" — the RM reports `-1` when the event-processor monitor is off; the legacy page prints `N/A`
 * (`MetricsOverviewTable.java:221`). `null` here means "the legacy page shows N/A", and `Datum` stamps `data-yn="1"`.
 */
export function schedulerBusyPercent(m: ClusterMetrics): number | null {
  const v = m.rmSchedulerBusyPercent;
  if (v == null || v < 0) return null;
  return v;
}

/** Physical utilisation percentages; the RM itself can report >100 or negative — pass it through untouched. */
export function utilisation(m: ClusterMetrics): { memPct: number | null; vcorePct: number | null } {
  const norm = (v: number | undefined): number | null => (v == null || !Number.isFinite(v) || v < 0 ? null : v);
  return { memPct: norm(m.utilizedMBPercent), vcorePct: norm(m.utilizedVirtualCoresPercent) };
}

// ──────────────────────────────────────────────────────────────── scheduler block

/**
 * Legacy "Scheduling Resource Type" = `Arrays.toString(ResourceTypeInfo[])` → `[memory-mb (unit=Mi), vcores]`.
 * REST `/scheduler-overview` delivers the same elements joined with "," and without brackets
 * (`StringUtils.join(resourceTypeInfos, ",")`), so this is a formatting normaliser, not a re-derivation.
 */
export function schedulingResourceTypesText(rest: string | null | undefined): string | null {
  if (rest == null || rest === "") return null;
  return `[${rest.split(",").join(", ")}]`;
}

/** "Capacity Scheduler" from the REST discriminator `capacityScheduler` (`SchedulerInfo.java:51-59`). */
export function schedulerDisplayName(type: string | null | undefined): string {
  switch (type) {
    case "capacityScheduler":
      return "Capacity Scheduler";
    case "fairScheduler":
      return "Fair Scheduler";
    case "fifoScheduler":
      return "Fifo Scheduler";
    case undefined:
    case null:
    case "":
      return "unknown";
    default:
      return type;
  }
}

/**
 * Legacy "Scheduling Resource Type" re-derived from the scheduler REST JSON: `schedulerInfo.maximumAllocation.
 * resourceInformations.resourceInformation[]` is the cluster's resource-type list (RM `/resource-types` is 404 on this
 * RM). Each entry renders like `ResourceTypeInfo.toString()`: `name`, plus ` (unit=<units>)` only when units are
 * non-empty → `[memory-mb (unit=Mi), vcores]`. `null` (shown as an honest "n/a") when the array is absent.
 */
export function schedulingResourceTypesFromInfo(info: SchedulerInfo | undefined | null): string | null {
  const max = schedulerMaxAllocation(info);
  const list = max?.resourceInformations?.resourceInformation;
  if (!list || list.length === 0) return null;
  return `[${list.map((ri) => (ri.units ? `${ri.name} (unit=${ri.units})` : ri.name)).join(", ")}]`;
}

/** "Maximum Allocation" = `Resource.toString()` of `schedulerInfo.maximumAllocation` incl. extra resource types. */
export function maxAllocationText(info: SchedulerInfo | undefined | null): string | null {
  const max = schedulerMaxAllocation(info);
  if (!max) return null;
  return resourceInfoText(Number(max.memory), Number(max.vCores), customResources(max));
}

/** Value of `key` in the RM's effective configuration dump (which includes `*-default.xml`, so unset keys resolve). */
export function confValue(props: ReadonlyArray<{ key: string; value?: unknown }> | undefined | null, key: string): string | null {
  const hit = props?.find((p) => p.key === key);
  return hit?.value == null ? null : String(hit.value);
}

/**
 * "Minimum Allocation": the scheduler REST JSON does not carry it (Capacity), so it is read from the effective RM conf
 * `yarn.scheduler.minimum-allocation-mb` / `-vcores` and formatted as `Resource.toString()`: `<memory:256, vCores:1>`.
 */
export function minAllocationText(props: ReadonlyArray<{ key: string; value?: unknown }> | undefined | null): string | null {
  const mem = confValue(props, "yarn.scheduler.minimum-allocation-mb");
  const vc = confValue(props, "yarn.scheduler.minimum-allocation-vcores");
  if (mem == null || vc == null || Number.isNaN(Number(mem)) || Number.isNaN(Number(vc))) return null;
  return resourceInfoText(Number(mem), Number(vc));
}

/** "Maximum Cluster Application Priority" = effective RM conf `yarn.cluster.max-application-priority`. */
export function maximumClusterPriority(props: ReadonlyArray<{ key: string; value?: unknown }> | undefined | null): number | null {
  const v = confValue(props, "yarn.cluster.max-application-priority");
  return v == null || v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v);
}

// ───────────────────────────────────────────────────────────── queue headroom

/**
 * A value the teaser shows: the upstream key it comes from (`data-yf`), its raw value (`data-yv`), how it is formatted,
 * and the visible text. Nothing derived is ever presented as if the RM had reported it.
 */
export interface TeasedValue {
  field: string;
  raw: unknown;
  fmt: Fmt;
  text: string;
}

/** One row of the Overview's queue teaser, normalised across the three schedulers. */
export interface QueueTeaser {
  path: string;
  state: string | null;
  /** used share/memory of the queue, in the queue's own reporting unit */
  used: TeasedValue;
  /** guaranteed share (Capacity: `absoluteCapacity`, Fair: `minResources.memory`) */
  guarantee: TeasedValue | null;
  /** ceiling share (Capacity: `absoluteMaxCapacity`, Fair: `maxResources.memory`) */
  ceiling: TeasedValue | null;
  /** bar geometry 0..100 — Capacity usage relative to guarantee; Fair usage relative to its ceiling */
  barPct: number;
  /** Used as percent of the guaranteed/fair share, for pressure coloring. */
  pressurePct: number | null;
  pendingContainers: number | null;
  allocatedContainers: number | null;
  activeApps: number | null;
  pendingApps: number | null;
}

/** Percentages/longs arrive as numbers or numeric strings depending on the Jersey marshaller. */
const numberOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * The generated scheduler schemas are a union whose members TypeScript does not narrow through `z.infer` (the recursive
 * `get queues()` property in `queue.ts`/`scheduler.ts` collapses to `{}`). Rather than cast, these readers re-validate
 * the two subtrees with the same schemas the response was parsed with, which restores the element types and cannot
 * produce a silently-wrong read. Reported to the schema owner for a root fix.
 */
function capacityChildren(info: SchedulerInfo): QueueInfo[] {
  const parsed = QueueInfoSchema.array().safeParse(readField(info, "queues", "queue"));
  return parsed.success ? parsed.data : [];
}
function fairChildren(info: SchedulerInfo): FairQueueInfo[] {
  const parsed = FairQueueInfoSchema.array().safeParse(readField(info, "rootQueue", "childQueues", "queue"));
  return parsed.success ? parsed.data : [];
}
/** `CapacitySchedulerInfo.maximumAllocation` (the only scheduler limit the REST API exposes at the top level). */
export function schedulerMaxAllocation(info: SchedulerInfo | undefined | null): ResourceInfo | null {
  const value = readPath(info, ["maximumAllocation"]);
  const parsed = ResourceInfoSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Walk an unknown path of plain object keys, returning `undefined` at the first missing/odd link. */
function readPath(root: unknown, keys: string[]): unknown {
  let node: unknown = root;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const readField = (root: unknown, ...keys: string[]): unknown => readPath(root, keys);

const ratioPct = (part: number | null, whole: number | null): number =>
  part == null || whole == null || whole <= 0 ? 0 : (part / whole) * 100;

/**
 * The scheduler tree's top-level queues. Capacity reports percentages directly (`usedCapacity`/`absoluteCapacity`),
 * Fair reports resource amounts (shown in MB against `minResources`/`maxResources`), FIFO has no tree.
 */
export function queueTeasers(info: SchedulerInfo | undefined | null): QueueTeaser[] {
  if (!info) return [];
  if (info.type === "capacityScheduler") {
    return capacityChildren(info).map((q) => {
      const used = numberOrNull(q.usedCapacity);
      const absoluteUsed = numberOrNull(q.absoluteUsedCapacity);
      const guarantee = numberOrNull(q.absoluteCapacity);
      const ceiling = numberOrNull(q.absoluteMaxCapacity);
      const pressurePct =
        guarantee === 0 && ((used ?? 0) > 0 || (absoluteUsed ?? 0) > 0)
          ? Number.POSITIVE_INFINITY
          : (used ?? (absoluteUsed != null && guarantee != null && guarantee > 0 ? ratioPct(absoluteUsed, guarantee) : null));
      return {
        path: q.queuePath ?? q.queueName,
        state: q.state ?? null,
        used: { field: "queue.usedCapacity", raw: used, fmt: "pct", text: fmtPct(used, 1) },
        guarantee: { field: "queue.absoluteCapacity", raw: guarantee, fmt: "pct", text: fmtPct(guarantee, 1) },
        ceiling: { field: "queue.absoluteMaxCapacity", raw: ceiling, fmt: "pct", text: fmtPct(ceiling, 1) },
        // `usedCapacity` and the visible value are percentages of the queue's guarantee. Keep the bar on that same
        // basis: once usage reaches 100%, fill it, then let pressureTone communicate the overage.
        barPct: pressurePct == null ? 0 : Math.max(0, Math.min(100, pressurePct)),
        pressurePct,
        pendingContainers: numberOrNull(q.pendingContainers),
        allocatedContainers: numberOrNull(q.allocatedContainers),
        activeApps: numberOrNull(q.numActiveApplications),
        pendingApps: numberOrNull(q.numPendingApplications),
      };
    });
  }
  if (info.type === "fairScheduler") {
    return fairChildren(info).map((q) => {
      const used = numberOrNull(q.usedResources?.memory);
      const guarantee = numberOrNull(q.minResources?.memory);
      const ceiling = numberOrNull(q.maxResources?.memory);
      const pressurePct =
        guarantee === 0 && used != null && used > 0
          ? Number.POSITIVE_INFINITY
          : guarantee != null && guarantee > 0
            ? ratioPct(used, guarantee)
            : null;
      return {
        path: q.queueName,
        state: null,
        used: { field: "queue.usedResources.memory", raw: used, fmt: "mb", text: fmtMB(used, 1) },
        guarantee: { field: "queue.minResources.memory", raw: guarantee, fmt: "mb", text: fmtMB(guarantee, 1) },
        ceiling: { field: "queue.maxResources.memory", raw: ceiling, fmt: "mb", text: fmtMB(ceiling, 1) },
        barPct: Math.min(100, used != null && used > 0 && (ceiling ?? guarantee) === 0 ? 100 : ratioPct(used, ceiling ?? guarantee)),
        pressurePct,
        pendingContainers: numberOrNull(q.pendingContainers),
        allocatedContainers: numberOrNull(q.allocatedContainers),
        activeApps: numberOrNull(q.numActiveApps),
        pendingApps: numberOrNull(q.numPendingApps),
      };
    });
  }
  return [];
}

// ────────────────────────────────────────────────────────────────── node counts

export const NODE_STATE_METRICS = [
  { key: "activeNodes", label: "Active", state: "RUNNING" },
  { key: "decommissioningNodes", label: "Decommissioning", state: "DECOMMISSIONING" },
  { key: "decommissionedNodes", label: "Decommissioned", state: "DECOMMISSIONED" },
  { key: "lostNodes", label: "Lost", state: "LOST" },
  { key: "unhealthyNodes", label: "Unhealthy", state: "UNHEALTHY" },
  { key: "rebootedNodes", label: "Rebooted", state: "REBOOTED" },
  { key: "shutdownNodes", label: "Shutdown", state: "SHUTDOWN" },
] as const;

export type NodeStateMetricKey = (typeof NODE_STATE_METRICS)[number]["key"];

// ──────────────────────────────────────────────────────────────────── app states

/** The states the "now active" rail asks the RM for (one request, one SSE topic). */
export const ACTIVE_STATES = ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING"] as const;
export const ACTIVE_STATES_QS = ACTIVE_STATES.join(",");

export type AppPhase = "queued" | "running" | "terminal";

export function appPhase(state: string | null | undefined): AppPhase {
  switch (state) {
    case "RUNNING":
      return "running";
    case "NEW":
    case "NEW_SAVING":
    case "SUBMITTED":
    case "ACCEPTED":
      return "queued";
    default:
      return "terminal";
  }
}

export const FINAL_APP_STATES = ["FINISHED", "FAILED", "KILLED"];

/**
 * Legacy "Tracking UI" cell (`RMAppsBlock.java:207-212`): `Unassigned` only while the app is NEW, `History` in a final
 * state, `ApplicationMaster` otherwise. The legacy page derives this from `app.getTrackingUrl()`, which inside the RM is
 * never null for a live app (it is the RM's own `/proxy/<appId>/` URL) — verified across all 50 live apps: every
 * ACCEPTED/RUNNING app reads `ApplicationMaster` even though the REST `trackingUrl` is absent and `trackingUI` says
 * `UNASSIGNED`. The REST `trackingUI` key therefore MUST NOT drive this label.
 */
export function trackingUiText(app: { trackingUI?: string | null; trackingUrl?: string | null; state?: string | null }): string {
  if (app.state === "NEW") return "Unassigned";
  if (app.state != null && FINAL_APP_STATES.includes(app.state)) return "History";
  return "ApplicationMaster";
}

/** Utilisation-window options; `all` is the session so far (Burrow keeps no cluster history of its own). */
export const HISTORY_WINDOWS = [
  { key: "5m", label: "5m", ms: 5 * 60_000 },
  { key: "30m", label: "30m", ms: 30 * 60_000 },
  { key: "all", label: "all", ms: null },
] as const;

export type HistoryWindow = (typeof HISTORY_WINDOWS)[number]["key"];

/** Samples inside the selected window, newest last. */
export function withinWindow<T extends { t: number }>(samples: T[], window: HistoryWindow, now: number): T[] {
  const ms = HISTORY_WINDOWS.find((w) => w.key === window)?.ms ?? null;
  return ms == null ? samples : samples.filter((s) => s.t >= now - ms);
}

/**
 * The link target of the legacy Tracking UI anchor (`RMAppsBlock.java:213`): the REST `trackingUrl` when present, else
 * the RM's own `/proxy/<appId>/` URL for any app past NEW (the RM advertises that URL for live apps the REST payload
 * leaves null). NEW apps and final states without a URL have no link (`#` in the legacy markup).
 */
export function trackingHref(
  app: { id?: string | null; trackingUrl?: string | null; state?: string | null },
  rmBase?: string | null,
): string | null {
  if (app.state === "NEW") return null;
  const url = app.trackingUrl;
  if (url != null && url !== "" && url !== "N/A" && url !== "UNASSIGNED") return url;
  if (app.state == null || FINAL_APP_STATES.includes(app.state)) return null;
  return app.id ? rmProxyUrl(app.id, { rm: rmBase }) : null;
}
