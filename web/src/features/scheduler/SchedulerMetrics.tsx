/**
 * Scheduler summary and configuration metrics as one responsive card set. Values absent from the RM REST contract are
 * rendered as explicitly unavailable rather than as plausible-looking zeros. Entity `_` covers the scheduler/cluster
 * singletons so every field id resolves to the raw upstream value.
 */
import { type ClusterMetrics, isCapacityScheduler, isFairScheduler, type SchedulerInfo } from "~/api/schemas";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ov } from "~/api/queries/overview";
import { tq } from "~/api/queries/tools";
import { selectNodes } from "~/api/schemas";
import { averageNodeMemoryUtilization } from "~/features/nodes/domain";
import {
  confValue,
  customResources,
  maxAllocationText,
  maximumClusterPriority,
  minAllocationText,
  resourceInfoText,
  schedulerBusyPercent,
  schedulerDisplayName,
  schedulerMaxAllocation,
  schedulingResourceTypesFromInfo,
  schedulingResourceTypesText,
} from "~/features/overview/derive";
import { cn } from "~/lib/cn";
import { Datum, Entity } from "~/ui/datum";
import { fmtPct, fmtInt, fmtMB } from "~/lib/format";
import { Button } from "~/ui/button";
import { Tile, TileLabel, Unavailable } from "./Chrome";
import { Tooltip } from "~/ui/tooltip";
import { pctText, resourceText, resourceValueText } from "./format";

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
  const overviewQuery = useQuery(ov.schedulerOverview());
  const confQuery = useQuery(tq.conf());
  const schedulerOverview = overviewQuery.data;
  const conf = confQuery.data;
  const nameText = schedulerDisplayName(info.type);
  const typesText = schedulingResourceTypesFromInfo(info) ?? schedulingResourceTypesText(schedulerOverview?.schedulingResourceType);
  const maxAlloc = schedulerMaxAllocation(info) ?? schedulerOverview?.maximumAllocation;
  const maxRawText =
    maxAllocationText(info) ??
    (schedulerOverview
      ? resourceInfoText(
          Number(schedulerOverview.maximumAllocation.memory),
          Number(schedulerOverview.maximumAllocation.vCores),
          customResources(schedulerOverview.maximumAllocation),
        )
      : null);
  const configuredMinText = minAllocationText(conf);
  const minRawText =
    configuredMinText ??
    (schedulerOverview
      ? resourceInfoText(Number(schedulerOverview.minimumAllocation.memory), Number(schedulerOverview.minimumAllocation.vCores))
      : null);
  const minMemory = configuredMinText
    ? confValue(conf, "yarn.scheduler.minimum-allocation-mb")
    : schedulerOverview?.minimumAllocation.memory;
  const minVCores = configuredMinText
    ? confValue(conf, "yarn.scheduler.minimum-allocation-vcores")
    : schedulerOverview?.minimumAllocation.vCores;
  const minDisplayText =
    minRawText == null || minMemory == null || minVCores == null ? null : resourceValueText(Number(minMemory), Number(minVCores));
  const priority = maximumClusterPriority(conf) ?? schedulerOverview?.applicationPriority ?? null;
  const rootQueue = isCapacityScheduler(info)
    ? { raw: info.queuePath, label: info.queuePath ?? "root" }
    : isFairScheduler(info)
      ? { raw: info.rootQueue.queueName, label: info.rootQueue.queueName }
      : { raw: undefined, label: "—" };
  const allocationPct = metrics && metrics.totalMB > 0 ? (metrics.allocatedMB / metrics.totalMB) * 100 : null;
  const busy = metrics == null ? null : schedulerBusyPercent(metrics);
  const rmQueue = metrics?.rmEventQueueSize ?? null;
  const schedQueue = metrics?.schedulerEventQueueSize ?? null;
  return (
    <Entity id="_" className={className} data-page-motion="metric-group">
      <div className="burrow-scheduler-metrics" data-expanded={expanded}>
        <div className="burrow-scheduler-metrics-primary grid gap-2">
          <Tile className="flex min-h-[4.5rem] flex-col justify-center gap-1">
            <TileLabel>Scheduler Type</TileLabel>
            <div className="text-body font-semibold text-ink-2">
              <Datum field="scheduler.derived.schedulerName" raw={nameText} fmt="text">
                <Datum field="scheduler.type" raw={info.type} fmt="text" bare />
                {nameText}
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
          <Metric label="Scheduling Resource Type" hint="Resource types reported for the active scheduler">
            {typesText ? (
              <Datum field="scheduler.derived.schedulingResourceTypes" raw={typesText} fmt="text" className="font-mono text-small">
                {typesText}
              </Datum>
            ) : (
              <Tooltip label="Resource types were not reported.">
                <Datum field="scheduler.derived.schedulingResourceTypes" raw={null} fmt="text" className="font-mono text-small text-ink-3">
                  n/a
                </Datum>
              </Tooltip>
            )}
          </Metric>
          <Metric label="Minimum Allocation" hint="Effective RM configuration, with scheduler-overview fallback">
            {minRawText == null ? (
              <Datum field="scheduler.derived.minAllocationText" raw={null} fmt="text">
                <Unavailable reason="Minimum allocation was not reported." hint="Check the active scheduler's configuration." />
              </Datum>
            ) : (
              <Datum field="scheduler.derived.minAllocationText" raw={minRawText} fmt="text" className="tnum">
                {minDisplayText ?? minRawText}
              </Datum>
            )}
          </Metric>
          <Metric label="Maximum Allocation" hint="maximumAllocation — the largest container the scheduler will grant">
            {maxAlloc && maxRawText ? (
              <Datum field="scheduler.derived.maxAllocationText" raw={maxRawText} fmt="text" className="tnum">
                <span className="text-ink-2">
                  <Datum field="scheduler.maximumAllocation.memory" raw={maxAlloc.memory} fmt="mb" bare />
                  <Datum field="scheduler.maximumAllocation.vCores" raw={maxAlloc.vCores} fmt="int" bare />
                  {resourceText(maxAlloc)}
                </span>
              </Datum>
            ) : (
              <Datum field="scheduler.derived.maxAllocationText" raw={null} fmt="text">
                <Unavailable reason="Maximum allocation was not reported." />
              </Datum>
            )}
          </Metric>
          <Metric label="Maximum Cluster Application Priority" hint="Effective RM configuration, with scheduler-overview fallback">
            {priority == null ? (
              <Datum field="scheduler.derived.maximumClusterPriority" raw={null} fmt="int">
                <Unavailable
                  reason="Application priority was not reported."
                  hint="Check whether the active scheduler supports application priority."
                />
              </Datum>
            ) : (
              <Datum field="scheduler.derived.maximumClusterPriority" raw={priority} fmt="int" className="tnum">
                {fmtInt(priority)}
              </Datum>
            )}
          </Metric>
          <Metric label="Scheduler Busy %" hint="cluster metrics: rmSchedulerBusyPercent">
            <Datum field="cluster.metrics.rmSchedulerBusyPercent" raw={busy} fmt="pct" className="tnum">
              {busy == null ? (
                <Unavailable reason={metricsError ? `cluster metrics unavailable: ${metricsError}` : "Scheduler load was not reported."} />
              ) : (
                fmtPct(busy)
              )}
            </Datum>
          </Metric>
          <Metric label="RM Dispatcher EventQueue Size" hint="cluster metrics: rmEventQueueSize">
            <Datum field="cluster.metrics.rmEventQueueSize" raw={rmQueue} fmt="int" className="tnum">
              {rmQueue == null ? (
                <Unavailable reason={metricsError ? `cluster metrics unavailable: ${metricsError}` : "Queue activity was not reported."} />
              ) : (
                fmtInt(rmQueue)
              )}
            </Datum>
          </Metric>
          <Metric label="Scheduler Dispatcher EventQueue Size" hint="cluster metrics: schedulerEventQueueSize">
            <Datum field="cluster.metrics.schedulerEventQueueSize" raw={schedQueue} fmt="int" className="tnum">
              {schedQueue == null ? (
                <Unavailable reason={metricsError ? `cluster metrics unavailable: ${metricsError}` : "Queue activity was not reported."} />
              ) : (
                fmtInt(schedQueue)
              )}
            </Datum>
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
