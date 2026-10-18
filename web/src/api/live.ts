/** Wires the always-on live behaviour once per page load: SSE, visibility/pref-driven refetch, utilisation sampling, clock skew. */
import type { QueryClient } from "@tanstack/react-query";
import { pushSample } from "~/state/history";
import { isParity } from "~/state/parity";
import { prefsStore } from "~/state/prefs";
import { setClockSkew } from "./connection";
import { startEvents } from "./events";
import type { ClusterMetrics, Meta } from "./schemas";

let started = false;

type SampledMetrics = Pick<
  ClusterMetrics,
  | "allocatedMB"
  | "allocatedVirtualCores"
  | "appsPending"
  | "appsRunning"
  | "containersAllocated"
  | "crossPartitionMetricsAvailable"
  | "totalMB"
  | "totalClusterResourcesAcrossPartition"
  | "totalReservedResourcesAcrossPartition"
  | "totalVirtualCores"
  | "totalUsedResourcesAcrossPartition"
>;

export function metricHistorySample(m: SampledMetrics, t = Date.now()) {
  const cross = m.crossPartitionMetricsAvailable === true;
  const used = cross ? m.totalUsedResourcesAcrossPartition : undefined;
  const reserved = cross ? m.totalReservedResourcesAcrossPartition : undefined;
  const total = cross ? m.totalClusterResourcesAcrossPartition : undefined;
  const memoryUsed = used ? Number(used.memory) - Number(reserved?.memory ?? 0) : m.allocatedMB;
  const vcoresUsed = used ? Number(used.vCores) - Number(reserved?.vCores ?? 0) : m.allocatedVirtualCores;
  const memoryTotal = total ? Number(total.memory) : m.totalMB;
  const vcoresTotal = total ? Number(total.vCores) : m.totalVirtualCores;
  if (memoryTotal <= 0) return null;
  return {
    t,
    memPct: (memoryUsed / memoryTotal) * 100,
    vcorePct: vcoresTotal > 0 ? (vcoresUsed / vcoresTotal) * 100 : 0,
    appsRunning: m.appsRunning,
    appsPending: m.appsPending,
    containers: m.containersAllocated,
  };
}

export function startLive(qc: QueryClient): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // utilisation history + clock skew: sample whenever the metrics/meta queries succeed
  qc.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.action.type !== "success") return;
    const key = e.query.queryKey;
    if (key[0] === "yarn" && key[1] === "metrics") {
      const raw = e.query.state.data as { clusterMetrics?: ClusterMetrics } | undefined;
      const m = raw?.clusterMetrics;
      if (m) {
        const sample = metricHistorySample(m);
        if (sample) pushSample(sample);
      }
    } else if (key[0] === "meta") {
      const meta = e.query.state.data as Meta | undefined;
      if (meta?.now) setClockSkew(meta.now);
    }
  });

  if (isParity()) return; // parity: data frozen after first load, no SSE, no resume refetch

  startEvents(qc, () => (qc.getQueryData<Meta>(["meta"])?.features?.events ?? true) !== false);

  const dynamicQuery = (query: { meta: unknown }) => {
    const kind = (query.meta as { refetchKind?: string } | undefined)?.refetchKind;
    return kind === "live" || kind === "slow";
  };
  const refetchDynamic = () => void qc.refetchQueries({ type: "active", predicate: dynamicQuery });

  // resuming (unpause, interval change, tab visible again) must nudge polling back to life: refetchInterval functions are
  // only re-evaluated after a fetch completes, so a paused query would otherwise never wake up.
  let prev = prefsStore.get();
  prefsStore.subscribe((p) => {
    const resumed = !p.livePaused && ((prev.livePaused && !p.livePaused) || prev.liveIntervalMs !== p.liveIntervalMs);
    prev = p;
    if (resumed) refetchDynamic();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !prefsStore.get().livePaused) refetchDynamic();
  });
}
