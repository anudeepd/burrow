/**
 * Scheduler summary and configuration metrics as one responsive card set. Values absent from the RM REST contract are
 * rendered as explicitly unavailable rather than as plausible-looking zeros. Entity `_` covers the scheduler/cluster
 * singletons so every field id resolves to the raw upstream value.
 */
import { type ClusterMetrics, isCapacityScheduler, isFairScheduler, type SchedulerInfo } from "~/api/schemas";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ov } from "~/api/queries/overview";
import { selectNodes } from "~/api/schemas";
import { averageNodeMemoryUtilization } from "~/features/nodes/domain";
import { cn } from "~/lib/cn";
import { Datum, Entity } from "~/ui/datum";
import { fmtPct, fmtInt, fmtMB } from "~/lib/format";
import { Button } from "~/ui/button";
import { Tile, TileLabel, Unavailable } from "./Chrome";
import { Tooltip } from "~/ui/tooltip";
import { pctText } from "./format";

const SCHEDULER_NAMES: Record<string, string> = {
  capacityScheduler: "Capacity Scheduler",
  fairScheduler: "Fair Scheduler",
  fifoScheduler: "Fifo Scheduler",
};

/** `[memory-mb=100.0%, vcores=100.0%]` → `memory-mb 100% · vcores 100%`; anything unexpected is shown as-is. */
function formatCapacityVector(raw: string): string {
  const body = raw.trim().replace(/^\[|\]$/g, "");
  if (!body) return raw;
  return body
    .split(",")
    .map((part) => {
      const [key, value] = part.split("=");
      if (!key || value === undefined) return part.trim();
      const n = Number.parseFloat(value);
      return `${key.trim()} ${Number.isFinite(n) ? `${n}%` : value.trim()}`;
    })
    .join(" · ");
}

function Metric({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  const tile = (
    <Tile className="flex flex-col justify-center gap-1">
      <TileLabel>{label}</TileLabel>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-body">{children}</div>
    </Tile>
  );
  return hint ? <Tooltip label={hint}>{tile}</Tooltip> : tile;
}

export function SchedulerMetrics({
  info,
  queueCount,
  overShare,
  metrics,
  metricsError,
  className,
}: {
  info: SchedulerInfo;
  queueCount: number;
  overShare: number;
  metrics: ClusterMetrics | undefined;
  /** when set, the three cluster-metric rows say why they are empty */
  metricsError?: string | null;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const nodesQuery = useQuery(ov.nodes());
  const averageMemory = averageNodeMemoryUtilization(nodesQuery.data ? selectNodes(nodesQuery.data) : []);
  const additionalMetricsId = useId();
  const capacity = isCapacityScheduler(info) ? info : null;
  const vector = capacity?.queueCapacityVectorInfo;
  const maxAlloc = capacity?.maximumAllocation;
  const rootQueue = isCapacityScheduler(info)
    ? { raw: info.queuePath, label: info.queuePath ?? "root" }
    : isFairScheduler(info)
      ? { raw: info.rootQueue.queueName, label: info.rootQueue.queueName }
      : { raw: undefined, label: "—" };
  const allocationPct = metrics && metrics.totalMB > 0 ? (metrics.allocatedMB / metrics.totalMB) * 100 : null;
  const busy = metrics?.rmSchedulerBusyPercent ?? null;
  const rmQueue = metrics?.rmEventQueueSize ?? null;
  const schedQueue = metrics?.schedulerEventQueueSize ?? null;

  return (
    <Entity id="_" className={className} data-page-motion="metric-group">
      <div className="burrow-scheduler-metrics" data-expanded={expanded}>
        <div className="burrow-scheduler-metrics-primary grid gap-2">
          <Tile className="flex min-h-[4.5rem] flex-col justify-center gap-1">
            <TileLabel>Type</TileLabel>
            <div className="text-body font-semibold text-ink-2">
              <Datum field="scheduler.type" raw={info.type}>
                {SCHEDULER_NAMES[info.type] ?? info.type}
              </Datum>
            </div>
          </Tile>
          <Tile className="flex min-h-[4.5rem] flex-col justify-center gap-1">
            <TileLabel>Root queue</TileLabel>
            <div className="font-mono text-body text-ink-2">
              <Datum field="scheduler.queuePath" raw={rootQueue.raw}>
                {rootQueue.label}
              </Datum>
            </div>
          </Tile>
          <Tile className="flex min-h-[4.5rem] flex-col justify-center gap-1">
            <TileLabel>Queues</TileLabel>
            <div className="text-h2 font-semibold text-ink-2 tnum">{queueCount}</div>
          </Tile>
          {capacity && (
            <Tile className="flex min-h-[4.5rem] flex-col justify-center gap-1">
              <Tooltip label="Queues currently using more than their guaranteed share.">
                <TileLabel>Over their share</TileLabel>
              </Tooltip>
              <div className={cn("text-h2 font-semibold tnum", overShare > 0 ? "text-warn" : "text-ok")}>{overShare}</div>
            </Tile>
          )}
        </div>
        <div className="burrow-scheduler-metrics-secondary grid gap-2" id={additionalMetricsId}>
          <Tile className="flex min-h-[4.5rem] flex-col justify-center gap-1">
            <TileLabel>Default-partition YARN memory allocation</TileLabel>
            <div className="text-h2 font-semibold text-ink-2 tnum">
              <Datum field="cluster.metrics.derived.defaultPartitionMemoryPct" raw={allocationPct} fmt="pct">
                {allocationPct == null ? "—" : pctText(allocationPct)}
              </Datum>
            </div>
            <div className="flex items-baseline gap-1 text-caption text-ink-3 tnum">
              <Datum field="cluster.metrics.allocatedMB" raw={metrics?.allocatedMB} fmt="mb">
                {fmtMB(metrics?.allocatedMB)}
              </Datum>
              <span>allocated of</span>
              <Datum field="cluster.metrics.totalMB" raw={metrics?.totalMB} fmt="mb">
                {fmtMB(metrics?.totalMB)}
              </Datum>
              <span>capacity</span>
            </div>
          </Tile>
          <Tile className="flex min-h-[4.5rem] flex-col justify-center gap-1">
            <TileLabel>Average node physical memory</TileLabel>
            <div className="text-h2 font-semibold text-ink-2 tnum">
              <Datum field="cluster.metrics.derived.averageNodeMemoryUtilization" raw={averageMemory.percent} fmt="pct">
                {averageMemory.percent == null ? "—" : fmtPct(averageMemory.percent, 1)}
              </Datum>
            </div>
            <div className="text-caption text-ink-3">{fmtInt(averageMemory.reportingNodes)} NodeManagers reporting</div>
          </Tile>
          <Metric label="Scheduling Resource Type" hint="configuredCapacityVector — the resources the scheduler allocates">
            {vector ? (
              <Datum
                field="scheduler.queueCapacityVectorInfo.configuredCapacityVector"
                raw={vector.configuredCapacityVector}
                className="font-mono text-small"
              >
                {vector.configuredCapacityVector ? formatCapacityVector(vector.configuredCapacityVector) : "—"}
              </Datum>
            ) : (
              <Unavailable reason="The ResourceManager did not return this setting." hint="Check the active scheduler's configuration." />
            )}
          </Metric>
          <Metric label="Minimum Allocation" hint="scheduler.getMinimumResourceCapability() on the legacy page">
            <Unavailable reason="The ResourceManager did not return this setting." hint="Check the active scheduler's configuration." />
          </Metric>
          <Metric label="Maximum Allocation" hint="maximumAllocation — the largest container the scheduler will grant">
            {maxAlloc ? (
              <span className="inline-flex items-baseline gap-1 tnum">
                <Datum field="scheduler.maximumAllocation.memory" raw={maxAlloc.memory} fmt="mb" className="text-ink-2">
                  {fmtMB(maxAlloc.memory)}
                </Datum>
                <span className="text-ink-4">·</span>
                <Datum field="scheduler.maximumAllocation.vCores" raw={maxAlloc.vCores} fmt="int" className="text-ink-2">
                  {fmtInt(maxAlloc.vCores)} vCores
                </Datum>
              </span>
            ) : (
              <Unavailable reason="This scheduler did not provide a maximum allocation." />
            )}
          </Metric>
          <Metric label="Maximum Cluster Application Priority" hint="scheduler.getMaxClusterLevelAppPriority() on the legacy page">
            <Unavailable
              reason="The ResourceManager did not return a priority limit."
              hint="Check whether the active scheduler supports application priority."
            />
          </Metric>
          <Metric label="Scheduler Busy %" hint="cluster metrics: rmSchedulerBusyPercent">
            {busy == null ? (
              <Unavailable reason={metricsError ? `cluster metrics unavailable: ${metricsError}` : "not reported"} />
            ) : (
              <Datum field="cluster.metrics.rmSchedulerBusyPercent" raw={metrics?.rmSchedulerBusyPercent} fmt="pct" className="tnum">
                {fmtPct(busy)}
              </Datum>
            )}
          </Metric>
          <Metric label="RM Dispatcher EventQueue Size" hint="cluster metrics: rmEventQueueSize">
            {rmQueue == null ? (
              <Unavailable reason={metricsError ? `cluster metrics unavailable: ${metricsError}` : "not reported"} />
            ) : (
              <Datum field="cluster.metrics.rmEventQueueSize" raw={metrics?.rmEventQueueSize} fmt="int" className="tnum">
                {fmtInt(rmQueue)}
              </Datum>
            )}
          </Metric>
          <Metric label="Scheduler Dispatcher EventQueue Size" hint="cluster metrics: schedulerEventQueueSize">
            {schedQueue == null ? (
              <Unavailable reason={metricsError ? `cluster metrics unavailable: ${metricsError}` : "not reported"} />
            ) : (
              <Datum field="cluster.metrics.schedulerEventQueueSize" raw={metrics?.schedulerEventQueueSize} fmt="int" className="tnum">
                {fmtInt(schedQueue)}
              </Datum>
            )}
          </Metric>
        </div>
        <Button
          type="button"
          size="sm"
          variant="quiet"
          className="burrow-scheduler-metrics-toggle"
          aria-expanded={expanded}
          aria-controls={additionalMetricsId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Fewer metrics" : "More scheduler metrics"}
        </Button>
      </div>
    </Entity>
  );
}
