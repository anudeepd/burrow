/**
 * (b) Cluster Metrics — the legacy `#metricsoverview` set (`MetricsOverviewTable.java:88-127`) plus the container
 * counters the legacy page omits. Every card is one `Datum`; the composite resource cards carry the exact legacy
 * string in `data-yv` with the REST primitives nested inside them (contract rule 4).
 *
 * Live: the numbers tween (`Ticker`), the rings animate, and the utilisation chart is a *session-local* history
 * sampled from `/api/yarn/metrics` (PLAN §5, `~/state/history.ts` — Burrow keeps no cluster history by design).
 */
import { useQuery } from "@tanstack/react-query";
import { ov } from "~/api/queries/overview";
import { fmtClock, fmtEpoch, fmtInt, fmtMB, fmtPct } from "~/lib/format";
import { utilizationTone } from "~/lib/progress-tone";
import { AreaChart } from "~/ui/charts";
import { Datum, Entity, SINGLETON } from "~/ui/datum";
import { ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { ResourceRing } from "~/ui/resource-ring";
import { Ticker } from "~/ui/ticker";
import { TabContent } from "~/ui/tabs";
import { HelpTip } from "~/ui/tooltip";
import { useUtilisation } from "~/state/history";
import { usePref } from "~/state/prefs";
import { selectNodes, type ClusterMetrics } from "~/api/schemas";
import { averageNodeMemoryUtilization } from "~/features/nodes/domain";
import {
  type HistoryWindow,
  appsCompletedAll,
  byteDesc,
  containersRunning,
  reservedResources,
  resourceText,
  totalResources,
  usedResources,
  withinWindow,
} from "./derive";
import { CompositeMetric, MetricCard } from "./metric-card";
import { Unavailable, useStale } from "./ui";

const appsHref = (states?: string) => (states ? `/apps?states=${states}` : "/apps");

function MetricsGridSkeleton() {
  const cards = (count: number) =>
    Array.from({ length: count }, (_, i) => (
      <div key={i} className="burrow-overview-skeleton-metric">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-5 w-14" />
      </div>
    ));

  return (
    <div className="burrow-overview-metrics-container" aria-busy="true">
      <div className="burrow-overview-metric-groups">
        <div className="burrow-overview-metric-group">
          <h3 className="m-0 text-small font-semibold text-ink-2">Applications</h3>
          <div className="burrow-overview-card-grid burrow-overview-card-grid--apps">{cards(6)}</div>
        </div>
        <div className="burrow-overview-metric-group">
          <h3 className="m-0 text-small font-semibold text-ink-2">Containers</h3>
          <div className="burrow-overview-card-grid burrow-overview-card-grid--containers">{cards(4)}</div>
        </div>
        <div className="burrow-overview-metric-group">
          <h3 className="m-0 text-small font-semibold text-ink-2">YARN resource allocation</h3>
          <div className="burrow-overview-card-grid burrow-overview-card-grid--resources">{cards(3)}</div>
        </div>
      </div>
    </div>
  );
}

/** Keep the reported MB in parity attributes even when the legacy cell displays used minus reserved. */
function MemDatum({ field, mb, displayMB = mb }: { field: string; mb: number | null | undefined; displayMB?: number | null }) {
  return (
    <Datum field={field} raw={mb ?? null} fmt="mb">
      {displayMB == null || !Number.isFinite(displayMB) ? "—" : byteDesc(displayMB * 1024 * 1024)}
    </Datum>
  );
}

export function ClusterMetricsSection({
  historyWindow = "all",
  showRawAggregate = false,
}: {
  historyWindow?: HistoryWindow;
  showRawAggregate?: boolean;
}) {
  const metrics = useQuery(ov.metrics());
  const nodesQuery = useQuery(ov.nodes());
  const stale = useStale();
  const history = useUtilisation();
  const tz = usePref("tz");

  const m = metrics.data as ClusterMetrics | undefined;
  const nodeList = nodesQuery.data ? selectNodes(nodesQuery.data) : [];
  const averageMemory = averageNodeMemoryUtilization(nodeList);

  if (metrics.isPending) return <MetricsGridSkeleton />;
  if (!m) {
    return (
      <ErrorState
        title="Cluster metrics are not available"
        message={
          metrics.error instanceof Error
            ? metrics.error.message
            : String(metrics.error ?? "The ResourceManager did not return cluster metrics.")
        }
        hint="Try again in a moment. Other Overview sections remain available."
        onRetry={() => void metrics.refetch()}
      />
    );
  }

  const used = usedResources(m);
  const total = totalResources(m);
  const reserved = reservedResources(m);
  const raceRunning = containersRunning(m);
  const memPct = used.memory > 0 && total.memory > 0 ? (used.memory / total.memory) * 100 : 0;
  const vcorePct = used.vCores > 0 && total.vCores > 0 ? (used.vCores / total.vCores) * 100 : 0;
  const busy = m.rmSchedulerBusyPercent == null || m.rmSchedulerBusyPercent < 0 ? null : m.rmSchedulerBusyPercent;
  const cross = m.crossPartitionMetricsAvailable === true;

  const memSeries = withinWindow(
    history.filter((s) => Number.isFinite(s.memPct)),
    historyWindow,
    Date.now(),
  ).map((s) => ({ t: s.t, v: s.memPct }));
  const runSeries = withinWindow(history, historyWindow, Date.now()).map((s) => ({ t: s.t, v: s.appsRunning }));
  const pendSeries = withinWindow(history, historyWindow, Date.now()).map((s) => ({ t: s.t, v: s.appsPending }));

  return (
    <Entity id={SINGLETON} className="burrow-overview-metrics-container flex flex-col gap-[var(--gap-card)]" data-testid="cluster-metrics">
      {metrics.isError && (
        <StaleErrorBanner
          title="Cluster metrics refresh failed; showing the last loaded values"
          error={metrics.error}
          onRetry={() => void metrics.refetch()}
        />
      )}
      <div className="burrow-overview-metric-groups">
        <div className="burrow-overview-metric-group burrow-overview-metric-group--apps">
          <h3 className="m-0 text-small font-semibold text-ink-2">Applications</h3>
          <div className="burrow-overview-card-grid burrow-overview-card-grid--apps">
            <MetricCard
              layout="row"
              size="lg"
              label="Apps Submitted"
              field="cluster.metrics.appsSubmitted"
              raw={m.appsSubmitted}
              href={appsHref()}
              hrefHint="All applications"
              testId="metric-apps-submitted"
            />
            <TabContent value={historyWindow} className="h-full">
              <MetricCard
                layout="row"
                size="lg"
                label="Apps Pending"
                field="cluster.metrics.appsPending"
                raw={m.appsPending}
                tone="wait"
                href={appsHref("NEW,NEW_SAVING,SUBMITTED,ACCEPTED")}
                hrefHint="Applications not yet running"
                spark={pendSeries}
                testId="metric-apps-pending"
                className="h-full"
              />
            </TabContent>
            <TabContent value={historyWindow} className="h-full">
              <MetricCard
                layout="row"
                size="lg"
                label="Apps Running"
                field="cluster.metrics.appsRunning"
                raw={m.appsRunning}
                href={appsHref("RUNNING")}
                hrefHint="Running applications"
                spark={runSeries}
                testId="metric-apps-running"
                className="h-full"
              />
            </TabContent>
            <MetricCard
              layout="row"
              size="lg"
              label="Apps Completed"
              field="cluster.metrics.derived.appsCompletedAll"
              raw={appsCompletedAll(m)}
              tone="ok"
              href={appsHref("FINISHED,FAILED,KILLED")}
              hrefHint="Finished, failed and killed applications"
              tooltip={
                <span className="block">
                  <span className="block">
                    {fmtInt(m.appsCompleted)} finished · {fmtInt(m.appsFailed)} failed · {fmtInt(m.appsKilled)} killed
                  </span>
                  <span className="mt-1 block text-ink-3">Opens applications in these states.</span>
                </span>
              }
              footnote={
                <>
                  <Datum field="cluster.metrics.appsCompleted" raw={m.appsCompleted} fmt="int" /> finished ·{" "}
                  <Datum field="cluster.metrics.appsFailed" raw={m.appsFailed} fmt="int" /> failed ·{" "}
                  <Datum field="cluster.metrics.appsKilled" raw={m.appsKilled} fmt="int" /> killed
                </>
              }
              footnoteClassName="overflow-visible text-clip whitespace-normal"
              testId="metric-apps-completed"
            />
            <MetricCard
              layout="row"
              size="lg"
              label="Apps Failed"
              field="cluster.metrics.appsFailed"
              raw={m.appsFailed}
              tone="fail"
              href={appsHref("FAILED")}
              hrefHint="Failed applications"
              testId="metric-apps-failed"
            />
            <MetricCard
              layout="row"
              size="lg"
              label="Apps Killed"
              field="cluster.metrics.appsKilled"
              raw={m.appsKilled}
              tone="idle"
              href={appsHref("KILLED")}
              hrefHint="Killed applications"
              testId="metric-apps-killed"
            />
          </div>
        </div>

        <div className="burrow-overview-metric-group burrow-overview-metric-group--containers">
          <h3 className="m-0 text-small font-semibold text-ink-2">Containers</h3>
          <div className="burrow-overview-card-grid burrow-overview-card-grid--containers">
            <MetricCard
              layout="row"
              size="lg"
              label="Containers Running"
              field={cross ? "cluster.metrics.totalAllocatedContainersAcrossPartition" : "cluster.metrics.containersAllocated"}
              raw={cross ? (m.totalAllocatedContainersAcrossPartition ?? raceRunning) : (m.containersAllocated ?? raceRunning)}
              footnote={
                cross ? (
                  <>
                    effective count · allocated <Datum field="cluster.metrics.containersAllocated" raw={m.containersAllocated} fmt="int" />
                  </>
                ) : undefined
              }
              testId="metric-containers-running"
            />
            <MetricCard
              layout="row"
              size="lg"
              label="Containers Allocated"
              field="cluster.metrics.containersAllocated"
              raw={m.containersAllocated}
              testId="metric-containers-allocated"
            />
            <MetricCard
              layout="row"
              size="lg"
              label="Containers Pending"
              field="cluster.metrics.containersPending"
              raw={m.containersPending}
              tone="wait"
              testId="metric-containers-pending"
            />
            <MetricCard
              layout="row"
              size="lg"
              label="Containers Reserved"
              field="cluster.metrics.containersReserved"
              raw={m.containersReserved}
              tone="wait"
              testId="metric-containers-reserved"
            />
          </div>
        </div>

        <div className="burrow-overview-metric-group burrow-overview-metric-group--resources">
          <h3 className="m-0 text-small font-semibold text-ink-2">YARN resource allocation</h3>
          <p className="m-0 -mt-1 text-micro text-ink-3">
            {cross ? "Scheduler capacity summed across partitions" : "ResourceManager cluster-wide counters"}
          </p>
          <div className="burrow-overview-card-grid burrow-overview-card-grid--resources">
            <CompositeMetric
              layout="row"
              label="Used Resources"
              derivedField="cluster.metrics.derived.usedResourcesText"
              derivedValue={resourceText(used.memory, used.vCores, used.customs)}
              tone="live"
              href={appsHref("RUNNING")}
              hrefHint="The applications holding these resources"
              testId="metric-used-resources"
              parts={
                cross && m.totalUsedResourcesAcrossPartition ? (
                  <>
                    Memory{" "}
                    <MemDatum
                      field="cluster.metrics.totalUsedResourcesAcrossPartition.memory"
                      mb={m.totalUsedResourcesAcrossPartition.memory}
                      displayMB={used.memory}
                    />{" "}
                    ·{" "}
                    <Datum
                      field="cluster.metrics.totalUsedResourcesAcrossPartition.vCores"
                      raw={m.totalUsedResourcesAcrossPartition.vCores}
                      fmt="int"
                    >
                      {fmtInt(used.vCores)}
                    </Datum>{" "}
                    vCores
                  </>
                ) : (
                  <>
                    Memory <MemDatum field="cluster.metrics.allocatedMB" mb={m.allocatedMB} /> ·{" "}
                    <Datum field="cluster.metrics.allocatedVirtualCores" raw={m.allocatedVirtualCores} fmt="int" /> vCores
                  </>
                )
              }
            />
            <CompositeMetric
              layout="row"
              label="Total Resources"
              derivedField="cluster.metrics.derived.totalResourcesText"
              derivedValue={resourceText(total.memory, total.vCores, total.customs)}
              testId="metric-total-resources"
              parts={
                cross && m.totalClusterResourcesAcrossPartition ? (
                  <>
                    Memory <MemDatum field="cluster.metrics.totalClusterResourcesAcrossPartition.memory" mb={total.memory} /> ·{" "}
                    <Datum field="cluster.metrics.totalClusterResourcesAcrossPartition.vCores" raw={total.vCores} fmt="int" /> vCores
                  </>
                ) : (
                  <>
                    Memory <MemDatum field="cluster.metrics.totalMB" mb={m.totalMB} /> ·{" "}
                    <Datum field="cluster.metrics.totalVirtualCores" raw={m.totalVirtualCores} fmt="int" /> vCores
                  </>
                )
              }
            />
            <CompositeMetric
              layout="row"
              label="Reserved Resources"
              derivedField="cluster.metrics.derived.reservedResourcesText"
              derivedValue={resourceText(reserved.memory, reserved.vCores, reserved.customs)}
              tone={reserved.memory > 0 ? "wait" : undefined}
              testId="metric-reserved-resources"
              parts={
                cross && m.totalReservedResourcesAcrossPartition ? (
                  <>
                    Memory <MemDatum field="cluster.metrics.totalReservedResourcesAcrossPartition.memory" mb={reserved.memory} /> ·{" "}
                    <Datum field="cluster.metrics.totalReservedResourcesAcrossPartition.vCores" raw={reserved.vCores} fmt="int" /> vCores
                  </>
                ) : (
                  <>
                    Memory <MemDatum field="cluster.metrics.reservedMB" mb={m.reservedMB} /> ·{" "}
                    <Datum field="cluster.metrics.reservedVirtualCores" raw={m.reservedVirtualCores} fmt="int" /> vCores
                  </>
                )
              }
            />
          </div>
        </div>
      </div>

      <div className="burrow-overview-utilization-grid">
        <div className="flex flex-col gap-6 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]">
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-caption font-semibold tracking-wide text-ink-2 uppercase">YARN allocation</h3>
            <div className="flex flex-wrap items-start justify-center gap-x-8 gap-y-4">
              <figure className="m-0 flex w-32 flex-col items-center gap-1.5">
                <ResourceRing
                  used={Math.max(0, used.memory)}
                  reserved={Math.max(0, reserved.memory)}
                  total={Math.max(1, total.memory)}
                  tone={utilizationTone(memPct)}
                  label="Cluster memory: used and reserved"
                  centre={<span className="text-body font-semibold">{fmtPct(memPct, 0)}</span>}
                />
                {/* the ring's own numbers, next to the ring: the shared footnote this replaces described only the
                  memory ring and left the vCores ring unexplained */}
                <figcaption className="text-center text-micro text-ink-3">
                  memory <span className="tnum text-ink-2">{fmtMB(used.memory)}</span> of{" "}
                  <span className="tnum text-ink-2">{fmtMB(total.memory)}</span>
                  {reserved.memory > 0 && (
                    <>
                      {" · "}
                      <span className="tnum text-wait">{fmtMB(reserved.memory)}</span> reserved
                    </>
                  )}
                </figcaption>
              </figure>
              <figure className="m-0 flex w-32 flex-col items-center gap-1.5">
                <ResourceRing
                  used={Math.max(0, used.vCores)}
                  reserved={Math.max(0, reserved.vCores)}
                  total={Math.max(1, total.vCores)}
                  tone={utilizationTone(vcorePct)}
                  label="Cluster vCores: used and reserved"
                  centre={<span className="text-body font-semibold">{fmtPct(vcorePct, 0)}</span>}
                />
                <figcaption className="text-center text-micro text-ink-3">
                  vCores <span className="tnum text-ink-2">{fmtInt(used.vCores)}</span> of{" "}
                  <span className="tnum text-ink-2">{fmtInt(total.vCores)}</span>
                  {reserved.vCores > 0 && (
                    <>
                      {" · "}
                      <span className="tnum text-wait">{fmtInt(reserved.vCores)}</span> reserved
                    </>
                  )}
                </figcaption>
              </figure>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <h3 className="m-0 text-caption font-semibold tracking-wide text-ink-2 uppercase">Physical utilization</h3>
            {/* Keep node-level measurements and the RM aggregate in one aligned list so their different meanings
                are easy to compare without burying the RM value in explanatory copy. */}
            <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2">
              <dt className="min-w-0 text-caption tracking-wide text-ink-3 uppercase">Average node physical memory</dt>
              <dd className="m-0 justify-self-end text-lead font-semibold tnum">
                <Ticker
                  value={averageMemory.percent}
                  field="cluster.metrics.derived.averageNodeMemoryUtilization"
                  fmt="pct"
                  format={(n) => fmtPct(n, 1)}
                />
              </dd>
              <dt className="min-w-0 text-caption tracking-wide text-ink-3 uppercase">Physical vCores used %</dt>
              <dd className="m-0 justify-self-end text-lead font-semibold tnum">
                <Ticker
                  value={Number.isFinite(m.utilizedVirtualCoresPercent) ? (m.utilizedVirtualCoresPercent as number) : null}
                  field="cluster.metrics.utilizedVirtualCoresPercent"
                  fmt="pct"
                  format={(n) => fmtPct(n, 1)}
                />
              </dd>
              <dt className="min-w-0 text-caption tracking-wide text-ink-3 uppercase">Scheduler busy %</dt>
              <dd className="m-0 justify-self-end text-lead font-semibold tnum">
                {busy == null ? (
                  /* the RM's -1 sentinel, not a reading: muted so it never reads as a percentage, with the reason
                   on its own line rather than squeezing the label */
                  <Datum
                    field="cluster.metrics.rmSchedulerBusyPercent"
                    raw={m.rmSchedulerBusyPercent ?? null}
                    fmt="int"
                    className="font-normal text-ink-3"
                  />
                ) : (
                  <Ticker value={busy} field="cluster.metrics.rmSchedulerBusyPercent" fmt="pct" format={(n) => fmtPct(n, 1)} />
                )}
              </dd>
              {busy == null && (
                <dd className="col-span-2 m-0 justify-self-start">
                  <Unavailable variant="info" reason="RM event-processor monitor is off, so the RM reports only -1" />
                </dd>
              )}
              <dt className="flex min-w-0 items-center gap-1 text-caption tracking-wide text-ink-3 uppercase">
                <span>RM memory utilization</span>
                <HelpTip label="ResourceManager memory utilization">
                  This ResourceManager aggregate can differ from the average across {fmtInt(averageMemory.reportingNodes)} reporting
                  NodeManagers and can exceed 100%.
                </HelpTip>
              </dt>
              <dd className="m-0 justify-self-end text-lead font-semibold tnum">
                <Ticker
                  value={Number.isFinite(m.utilizedMBPercent) ? (m.utilizedMBPercent as number) : null}
                  field="cluster.metrics.utilizedMBPercent"
                  fmt="pct"
                  format={(n) => fmtPct(n, 1)}
                />
              </dd>
            </dl>
          </div>
        </div>

        <div className="burrow-overview-history-card flex min-h-0 flex-col gap-2 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-caption tracking-wide text-ink-3 uppercase">YARN allocation · this session</span>
            <span className="text-micro text-ink-4">{memSeries.length > 1 ? `${memSeries.length} samples` : "collecting"}</span>
            {stale && <Unavailable variant="info" reason="upstream served stale cache" />}
          </div>
          {/* The chart frame renders in both states so the card keeps its height: when samples arrive only
              the line fades in and the neighbour card never shifts. */}
          <TabContent value={historyWindow} className="burrow-overview-history-panel relative">
            <AreaChart
              points={memSeries}
              label="Cluster memory utilisation, sampled while this tab has been open"
              sampleAriaLabel="Memory utilisation history samples"
              sampleTooltip={(point) =>
                `Memory utilisation ${fmtPct(point.v, 1)} at ${fmtEpoch(point.t, tz)} (${tz === "utc" ? "UTC" : "local time"})`
              }
              timeLabel={(timestamp) => fmtClock(timestamp, tz)}
              domain={[0, 100]}
              unit="%"
              height={132}
              fillHeight
              className={`burrow-overview-history-chart${memSeries.length > 1 ? "" : " opacity-60"}`}
            />
            {memSeries.length < 2 && (
              <p
                data-testid="history-collecting"
                className="absolute inset-0 m-0 grid place-items-center px-3 text-center text-micro text-ink-3"
              >
                <span className="max-w-[72%] rounded-full border border-seam bg-fabric px-2.5 py-1">
                  collecting samples · trend appears after two samples
                </span>
              </p>
            )}
          </TabContent>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-ink-3">
            <span>
              used / capacity now <span className="tnum text-ink-2">{fmtPct(memPct, 1)}</span>
            </span>
            <span>
              vcores now <span className="tnum text-ink-2">{fmtPct(vcorePct, 1)}</span>
            </span>
          </div>
        </div>
      </div>

      {showRawAggregate && (
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 rounded-lg border border-seam-soft bg-well px-3 py-2 text-micro text-ink-3 sm:grid-cols-5 lg:grid-cols-6">
          <span className="font-medium uppercase tracking-wide">RM aggregate</span>
          <span>
            totalMB <b className="tnum text-ink-2">{m.totalMB == null ? "—" : byteDesc(m.totalMB * 1024 * 1024)}</b>
          </span>
          <span>
            allocatedMB <b className="tnum text-ink-2">{m.allocatedMB == null ? "—" : byteDesc(m.allocatedMB * 1024 * 1024)}</b>
          </span>
          <span>
            availableMB <b className="tnum text-ink-2">{m.availableMB == null ? "—" : byteDesc(m.availableMB * 1024 * 1024)}</b>
          </span>
          <span>
            reservedMB <b className="tnum text-ink-2">{m.reservedMB == null ? "—" : byteDesc(m.reservedMB * 1024 * 1024)}</b>
          </span>
          <span>
            pendingMB <b className="tnum text-ink-2">{m.pendingMB == null ? "—" : byteDesc(m.pendingMB * 1024 * 1024)}</b>
          </span>
          <span>
            totalVirtualCores <b className="tnum text-ink-2">{fmtInt(m.totalVirtualCores)}</b>
          </span>
          <span>
            allocatedVirtualCores <b className="tnum text-ink-2">{fmtInt(m.allocatedVirtualCores)}</b>
          </span>
          <span>
            availableVirtualCores <b className="tnum text-ink-2">{fmtInt(m.availableVirtualCores)}</b>
          </span>
          <span>
            reservedVirtualCores <b className="tnum text-ink-2">{fmtInt(m.reservedVirtualCores)}</b>
          </span>
          <span>
            pendingVirtualCores <b className="tnum text-ink-2">{fmtInt(m.pendingVirtualCores)}</b>
          </span>
          <span>
            containerAssignedPerSecond <b className="tnum text-ink-2">{fmtInt(m.containerAssignedPerSecond)}</b>
          </span>
        </div>
      )}
    </Entity>
  );
}

const RM_MEMORY_METRICS = [
  { key: "totalMB", label: "Total memory", field: "cluster.metrics.totalMB" },
  { key: "allocatedMB", label: "Allocated memory", field: "cluster.metrics.allocatedMB" },
  { key: "availableMB", label: "Available memory", field: "cluster.metrics.availableMB" },
  { key: "reservedMB", label: "Reserved memory", field: "cluster.metrics.reservedMB" },
  { key: "pendingMB", label: "Pending memory", field: "cluster.metrics.pendingMB" },
] as const;

const RM_VCORE_METRICS = [
  { key: "totalVirtualCores", label: "Total vCores", field: "cluster.metrics.totalVirtualCores" },
  { key: "allocatedVirtualCores", label: "Allocated vCores", field: "cluster.metrics.allocatedVirtualCores" },
  { key: "availableVirtualCores", label: "Available vCores", field: "cluster.metrics.availableVirtualCores" },
  { key: "reservedVirtualCores", label: "Reserved vCores", field: "cluster.metrics.reservedVirtualCores" },
  { key: "pendingVirtualCores", label: "Pending vCores", field: "cluster.metrics.pendingVirtualCores" },
] as const;

export function ResourceManagerMetricsSection() {
  const metrics = useQuery(ov.metrics());
  const m = metrics.data as ClusterMetrics | undefined;

  if (metrics.isPending) return <MetricsGridSkeleton />;
  if (!m) {
    return (
      <ErrorState
        title="ResourceManager metrics are not available"
        message={
          metrics.error instanceof Error
            ? metrics.error.message
            : String(metrics.error ?? "The ResourceManager did not return its resource counters.")
        }
        hint="Try again in a moment. Other Overview sections remain available."
        onRetry={() => void metrics.refetch()}
      />
    );
  }

  return (
    <Entity
      id={SINGLETON}
      className="burrow-overview-metrics-container flex flex-col gap-[var(--gap-card)]"
      data-testid="resource-manager-metrics"
    >
      {metrics.isError && (
        <StaleErrorBanner
          title="ResourceManager metrics refresh failed; showing the last loaded values"
          error={metrics.error}
          onRetry={() => void metrics.refetch()}
        />
      )}
      {m.crossPartitionMetricsAvailable === true && (
        <p className="m-0 text-caption text-ink-3" data-testid="rm-capacity-basis-note">
          <span className="font-medium text-ink-2">Cluster-wide totals.</span>
        </p>
      )}
      <div className="burrow-overview-rm-groups">
        <div className="burrow-overview-metric-group burrow-overview-metric-group--rm">
          <h3 className="mb-2 text-small font-medium text-ink-2">Memory</h3>
          <div className="burrow-overview-row-grid burrow-overview-row-grid--three">
            {RM_MEMORY_METRICS.map(({ key, label, field }) => (
              <MetricCard key={key} layout="row" label={label} field={field} raw={m[key]} fmt="mb" size="md" />
            ))}
          </div>
        </div>
        <div className="burrow-overview-metric-group burrow-overview-metric-group--rm">
          <h3 className="mb-2 text-small font-medium text-ink-2">Virtual cores</h3>
          <div className="burrow-overview-row-grid burrow-overview-row-grid--three">
            {RM_VCORE_METRICS.map(({ key, label, field }) => (
              <MetricCard key={key} layout="row" label={label} field={field} raw={m[key]} fmt="int" size="md" />
            ))}
            <MetricCard
              layout="row"
              label="Assignments/s"
              field="cluster.metrics.containerAssignedPerSecond"
              raw={m.containerAssignedPerSecond}
              fmt="int"
              size="md"
            />
          </div>
        </div>
      </div>
    </Entity>
  );
}
