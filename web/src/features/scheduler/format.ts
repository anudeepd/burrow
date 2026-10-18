/** Display helpers for the scheduler views (visible text only — raw values are stamped by `Datum`). */
import { fmtBytes, fmtInt, fmtMB, fmtPct } from "~/lib/format";
import type { ResourceInfo } from "~/api/schemas";
export { pressureTone } from "~/lib/progress-tone";

export interface ResourcePart {
  name: string;
  value: number;
  units?: string;
}

export function fmtVcores(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${fmtInt(n)} ${n === 1 ? "vCore" : "vCores"}`;
}

export function fmtMemory(mb: number | null | undefined): string {
  return mb == null || !Number.isFinite(mb) ? "—" : `${fmtMB(mb)} · ${fmtInt(mb)} MB`;
}

/** Format the standard YARN resources and any custom resource types as one readable value. */
export function resourceValueText(memoryMB: number, vCores: number, customs: readonly ResourcePart[] = []): string {
  const parts = [fmtMB(memoryMB), fmtVcores(vCores)];
  for (const resource of customs) {
    if (!Number.isFinite(resource.value) || resource.value === 0) continue;
    parts.push(`${resource.name}: ${fmtInt(resource.value)}${resource.units ? ` ${resource.units}` : ""}`);
  }
  return parts.join(" · ");
}

/** `ResourceInfo` → "2 GiB · 1 vCore". Null/absent → "—". */
export function resourceText(r: ResourceInfo | null | undefined): string {
  if (!r) return "—";
  const customs = (r.resourceInformations?.resourceInformation ?? [])
    .filter((resource) => resource.name !== "memory-mb" && resource.name !== "vcores")
    .map((resource) => ({ name: resource.name, value: resource.value, units: resource.units }));
  return resourceValueText(r.memory, r.vCores, customs);
}

/** Translate Hadoop's internal sentinel into a concise, human-facing partition label. */
export function partitionText(partition: string | null | undefined): string {
  const value = partition?.trim() ?? "";
  return value === "" || value === "<DEFAULT_PARTITION>" ? "Default partition" : value;
}

/** "62.5%" — already a percentage. */
export function pctText(n: number | null | undefined): string {
  return fmtPct(n, n != null && Math.abs(n) >= 1000 ? 0 : 1);
}

export function countText(n: number | null | undefined): string {
  return n == null ? "—" : fmtInt(n);
}

/** Queue path → the segment shown as the row title. */
export function queueTitle(path: string): string {
  const seg = path.split(".").filter(Boolean);
  return seg.length ? (seg[seg.length - 1] ?? path) : path;
}

/** Byte-ish label for a queue's guaranteed share of the cluster. */
export function shareText(mb: number | null | undefined): string {
  return mb == null ? "—" : fmtBytes(mb * 1024 * 1024);
}

export function deltaText(mb: number | null | undefined): string {
  if (mb == null) return "—";
  const sign = mb < 0 ? "−" : "+";
  return `${sign}${fmtBytes(Math.abs(mb) * 1024 * 1024)}`;
}

/**
 * `CapacitySchedulerLeafQueueInfo.getOrderingPolicyDisplayName()` = the ordering policy's `getInfo()`. The REST exposes only
 * `getConfigName()` (`orderingPolicyInfo`), so the display name is the `getInfo()` of the built-in policy that config name
 * selects (Hadoop 3.4 `scheduler/policy/*OrderingPolicy*.java`). `FairOrderingPolicy.getInfo()` appends " with sizeBasedWeight"
 * when `fair.enable-size-based-weight` is set; that flag is not in the scheduler REST, so it cannot be reproduced here. An
 * unknown config name (a custom policy class) is shown as-is.
 */
const ORDERING_POLICY_INFO: Readonly<Record<string, string>> = {
  fifo: "FifoOrderingPolicy",
  fair: "FairOrderingPolicy",
  "fifo-with-partitions": "FifoOrderingPolicyWithExclusivePartitions",
  "fifo-for-pending-apps": "FifoOrderingPolicyForPendingApps",
};

export function orderingPolicyDisplayName(configName: string | null | undefined): string | null {
  if (configName == null || configName === "") return null;
  return ORDERING_POLICY_INFO[configName] ?? configName;
}

/** `String.valueOf(float)` for a user weight: Java always prints a decimal point (`1.0`, `0.5`). */
export function userWeightText(w: number | null | undefined): string {
  if (w == null || !Number.isFinite(w)) return "—";
  return Number.isInteger(w) ? w.toFixed(1) : String(w);
}
