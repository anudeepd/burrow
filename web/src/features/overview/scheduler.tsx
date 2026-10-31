/**
 * Scheduler snapshot shared with `/scheduler`: scheduler REST and RM configuration supply scheduler facts, while
 * ClusterMetrics supplies busy percentage and dispatcher queue sizes. The optional scheduler-overview response fills
 * facts that the primary sources omit; its absence does not block the rest of the section.
 *
 * The queue teaser below reads `/api/yarn/scheduler` and is the Overview's door into `/scheduler`.
 */
import { useQuery } from "@tanstack/react-query";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { useState } from "react";
import { ApiError } from "~/api/client";
import { tq } from "~/api/queries/tools";
import { errorReason, isSourceUnavailable, ov } from "~/api/queries/overview";
import { Datum, Entity, SINGLETON } from "~/ui/datum";
import { DataTable, defaultVisibilityOf } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { ProgressBar } from "~/ui/progress-bar";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { useParity } from "~/state/parity";
import { pressureTone } from "~/lib/progress-tone";
import { fmtInt, fmtPct } from "~/lib/format";
import type { SchedulerInfo, SchedulerResponse } from "~/api/schemas";
import {
  confValue,
  customResources,
  maxAllocationText,
  maximumClusterPriority,
  minAllocationText,
  queueTeasers,
  resourceInfoText,
  schedulerBusyPercent,
  schedulerDisplayName,
  schedulerMaxAllocation,
  schedulingResourceTypesFromInfo,
  schedulingResourceTypesText,
  type QueueTeaser,
} from "./derive";
import { resourceText, resourceValueText } from "~/features/scheduler/format";
import { CrossLink, Unavailable, useStale } from "./ui";

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="burrow-overview-data-row">
      <span className="min-w-0 break-words text-small font-medium text-ink-2">{label}</span>
      <span className="min-w-0 break-words text-body text-ink">{children}</span>
    </div>
  );
}

const numeric = (value: unknown): number => {
  if (value == null) return -1;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
};

const QUEUE_COLUMNS: ColDef<QueueTeaser>[] = [
  {
    id: "queue",
    accessorFn: (queue) => queue.path,
    size: 180,
    meta: { label: "Queue", pinned: true, hint: "Full scheduler queue path. Open a queue to inspect its limits, users and applications." },
    cell: ({ row }) => (
      <Datum field="queue.queuePath" raw={row.original.path} fmt="text" className="block min-w-0 truncate font-mono text-small">
        <Tooltip label={`Open queue ${row.original.path}`}>
          <CrossLink
            href={`/scheduler?queue=${encodeURIComponent(row.original.path)}`}
            className="block truncate hover:text-live hover:underline"
          >
            {row.original.path}
          </CrossLink>
        </Tooltip>
      </Datum>
    ),
  },
  {
    id: "share",
    accessorFn: (queue) => numeric(queue.guarantee?.raw),
    size: 130,
    meta: {
      label: "Guarantee / max",
      hint: "Guaranteed capacity and maximum capacity. Capacity schedulers show shares; fair schedulers may report resources.",
      exportValue: (queue: QueueTeaser) => `${queue.guarantee?.text ?? "—"} / ${queue.ceiling?.text ?? "—"}`,
    },
    cell: ({ row }) => {
      const queue = row.original;
      return (
        <span className="whitespace-nowrap text-small tnum">
          {queue.guarantee ? (
            <Datum field={queue.guarantee.field} raw={queue.guarantee.raw} fmt={queue.guarantee.fmt}>
              {queue.guarantee.text}
            </Datum>
          ) : (
            <span className="text-ink-4">—</span>
          )}
          <span className="text-ink-4"> / </span>
          {queue.ceiling ? (
            <Datum field={queue.ceiling.field} raw={queue.ceiling.raw} fmt={queue.ceiling.fmt}>
              {queue.ceiling.text}
            </Datum>
          ) : (
            <span className="text-ink-4">—</span>
          )}
        </span>
      );
    },
  },
  {
    id: "apps",
    accessorFn: (queue) => numeric(queue.activeApps),
    size: 132,
    meta: {
      label: "Apps",
      hint: "Applications accepted for allocation and applications still waiting for queue resources.",
      exportValue: (queue: QueueTeaser) => `${queue.activeApps ?? "—"} active / ${queue.pendingApps ?? "—"} pending`,
    },
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-small">
        <Datum field="queue.numActiveApplications" raw={row.original.activeApps} fmt="int" className="tnum">
          {row.original.activeApps == null ? "—" : String(row.original.activeApps)}
        </Datum>
        <span className="text-ink-4"> active · </span>
        <Datum field="queue.numPendingApplications" raw={row.original.pendingApps} fmt="int" className="tnum">
          {row.original.pendingApps == null ? "—" : String(row.original.pendingApps)}
        </Datum>
        <span className="text-ink-4"> pending</span>
      </span>
    ),
  },
  {
    id: "containers",
    accessorFn: (queue) => numeric(queue.allocatedContainers),
    size: 150,
    meta: {
      label: "Containers",
      hint: "Allocated containers and outstanding container requests in this queue.",
      exportValue: (queue: QueueTeaser) => `${queue.allocatedContainers ?? "—"} allocated / ${queue.pendingContainers ?? "—"} pending`,
    },
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-small">
        <Datum field="queue.allocatedContainers" raw={row.original.allocatedContainers} fmt="int" className="tnum">
          {row.original.allocatedContainers == null ? "—" : String(row.original.allocatedContainers)}
        </Datum>
        <span className="text-ink-4"> allocated · </span>
        <Datum field="queue.pendingContainers" raw={row.original.pendingContainers} fmt="int" className="tnum">
          {row.original.pendingContainers == null ? "—" : String(row.original.pendingContainers)}
        </Datum>
        <span className="text-ink-4"> pending</span>
      </span>
    ),
  },
  {
    id: "state",
    accessorFn: (queue) => queue.state ?? "",
    size: 92,
    meta: { label: "State", hint: "A running queue accepts applications; stopped or draining queues restrict new work." },
    cell: ({ row }) =>
      row.original.state ? (
        <StatusPill domain="queue.state" state={row.original.state} field="queue.state" size="sm" />
      ) : (
        <span className="text-small text-ink-4">—</span>
      ),
  },
  {
    id: "used",
    accessorFn: (queue) => numeric(queue.used.raw),
    size: 158,
    meta: {
      label: "Used",
      hint: "Current usage relative to the queue's guaranteed share. Usage can exceed the guarantee up to its maximum capacity.",
      exportValue: (queue: QueueTeaser) => queue.used.text,
    },
    cell: ({ row }) => {
      const queue = row.original;
      return (
        <div className="flex w-full min-w-0 items-center gap-2">
          <ProgressBar
            percent={queue.barPct}
            tone={pressureTone(queue.pressurePct)}
            live
            label={`${queue.path}: usage relative to guaranteed share`}
            valueText={`${queue.used.text} used of guaranteed share`}
            className="burrow-thread--headroom min-w-10 flex-1"
          />
          <Datum
            field={queue.used.field}
            raw={queue.used.raw}
            fmt={queue.used.fmt}
            className="w-20 shrink-0 whitespace-nowrap text-left text-small text-ink-2 tnum"
          >
            {queue.used.text}
          </Datum>
        </div>
      );
    },
  },
];

const QUEUE_DEFAULT_VISIBILITY = defaultVisibilityOf(QUEUE_COLUMNS);

/**
 * Shared scheduler facts: name, resource types, and maximum allocation come from scheduler REST, with the optional
 * scheduler-overview response as fallback. Minimum allocation and maximum priority use effective RM configuration
 * first, then scheduler-overview. Busy percentage and event queue sizes come from ClusterMetrics, matching `/scheduler`.
 */
export function SchedulerSection({ collapseQueueTable = false }: { collapseQueueTable?: boolean }) {
  const overview = useQuery(ov.schedulerOverview());
  const sched = useQuery(ov.scheduler());
  const metricsQ = useQuery(ov.metrics());
  const stale = useStale();
  const parity = useParity();
  const [queueSorting, setQueueSorting] = useState<SortingState>([]);
  const [queueVisibility, setQueueVisibility] = useState<ColumnVisibilityState>(QUEUE_DEFAULT_VISIBILITY);

  const response = sched.data as SchedulerResponse | undefined;
  const info: SchedulerInfo | undefined = response?.scheduler?.schedulerInfo;
  const so = overview.data;
  const overviewUnavailableReason =
    overview.error && !so && isSourceUnavailable(overview.error)
      ? `HTTP ${overview.error instanceof ApiError ? overview.error.status : "unknown"}: ${errorReason(overview.error)}`
      : null;
  const teasers = queueTeasers(info);
  const confQ = useQuery(tq.conf());
  const conf = confQ.data;

  const nameText = info?.type ? schedulerDisplayName(info.type) : (so?.schedulerType ?? null);
  const typesText = schedulingResourceTypesFromInfo(info) ?? schedulingResourceTypesText(so?.schedulingResourceType);
  const maxText =
    maxAllocationText(info) ??
    (so
      ? resourceInfoText(Number(so.maximumAllocation.memory), Number(so.maximumAllocation.vCores), customResources(so.maximumAllocation))
      : null);
  const configuredMinText = minAllocationText(conf);
  const minText =
    configuredMinText ?? (so ? resourceInfoText(Number(so.minimumAllocation.memory), Number(so.minimumAllocation.vCores)) : null);
  const maxResource = schedulerMaxAllocation(info) ?? so?.maximumAllocation;
  const minMemory = configuredMinText ? confValue(conf, "yarn.scheduler.minimum-allocation-mb") : so?.minimumAllocation.memory;
  const minVCores = configuredMinText ? confValue(conf, "yarn.scheduler.minimum-allocation-vcores") : so?.minimumAllocation.vCores;
  const maxDisplayText = maxText == null || parity || maxResource == null ? maxText : resourceText(maxResource);
  const minDisplayText =
    minText == null || parity || minMemory == null || minVCores == null ? minText : resourceValueText(Number(minMemory), Number(minVCores));
  const priority = maximumClusterPriority(conf) ?? so?.applicationPriority ?? null;
  const metrics = metricsQ.data;
  const busy = metrics == null ? null : schedulerBusyPercent(metrics);
  const rmQueue = metrics?.rmEventQueueSize ?? null;
  const schedulerQueue = metrics?.schedulerEventQueueSize ?? null;
  const metricsUnavailableReason = metricsQ.error ? `Cluster metrics unavailable: ${errorReason(metricsQ.error)}` : null;
  const queueTable = (
    <DataTable
      data={teasers}
      columns={QUEUE_COLUMNS}
      getRowId={(queue) => queue.path}
      entityKey={(queue) => queue.path}
      label="Queue headroom"
      storageKey="overview-queue-headroom"
      sorting={queueSorting}
      onSortingChange={setQueueSorting}
      columnVisibility={queueVisibility}
      onColumnVisibilityChange={setQueueVisibility}
      defaultVisibility={QUEUE_DEFAULT_VISIBILITY}
      loading={sched.isPending}
      error={
        sched.isError && sched.data === undefined ? (
          <ErrorState
            title="Queue data is unavailable"
            message={sched.error instanceof Error ? sched.error.message : String(sched.error)}
            hint="Try again in a moment."
            onRetry={() => void sched.refetch()}
          />
        ) : undefined
      }
      empty={
        <p className="m-0 text-small text-ink-3" data-testid="queues-empty">
          {info?.type === "fifoScheduler"
            ? "The Fifo Scheduler has a single unnamed queue: there is no queue tree to show."
            : "No queues reported."}
        </p>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-small font-medium text-ink-2">Queue headroom</h3>
          {sched.isPending && <span className="text-micro text-ink-4">loading…</span>}
        </div>
      }
      toolbarArrangement="inline"
      exportName="overview-queue-headroom"
      className="min-h-[13rem] w-full flex-none"
    />
  );

  if (overview.isPending && sched.isPending) {
    return (
      <div className="burrow-overview-metrics-container" aria-busy="true">
        <div className="burrow-overview-row-grid burrow-overview-row-grid--two">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="burrow-overview-data-row">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!so && !info) {
    return (
      <ErrorState
        title="The scheduler did not answer"
        message={
          overview.error instanceof Error
            ? overview.error.message
            : sched.error instanceof Error
              ? sched.error.message
              : "The ResourceManager did not return scheduler details."
        }
        hint="Try again in a moment. Cluster metrics remain available."
        onRetry={() => {
          void overview.refetch();
          void sched.refetch();
        }}
      />
    );
  }

  const missing = !so;
  const why = so ? null : "Detailed scheduler information is unavailable on this cluster.";

  return (
    <div className="burrow-overview-metrics-container flex flex-col gap-[var(--gap-card)]" data-testid="scheduler">
      {overview.error && so && (
        <StaleErrorBanner
          title="Scheduler overview refresh failed; showing the last loaded values"
          error={overview.error}
          onRetry={() => void overview.refetch()}
        />
      )}
      {overviewUnavailableReason && (
        <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Unavailable reason={overviewUnavailableReason} />
          <span className="text-micro text-ink-3">Showing scheduler and configuration data where available.</span>
        </div>
      )}
      {overview.error && !so && !isSourceUnavailable(overview.error) && (
        <ErrorState
          compact
          title="Scheduler overview could not be read"
          message={overview.error instanceof Error ? overview.error.message : String(overview.error)}
          onRetry={() => void overview.refetch()}
        />
      )}
      {sched.error && sched.data && (
        <StaleErrorBanner
          title="Scheduler refresh failed; showing the last loaded values"
          error={sched.error}
          onRetry={() => void sched.refetch()}
        />
      )}
      {confQ.error &&
        (conf ? (
          <StaleErrorBanner
            title="Scheduler configuration refresh failed; showing the last loaded values"
            error={confQ.error}
            onRetry={() => void confQ.refetch()}
          />
        ) : (
          <ErrorState
            compact
            title="Scheduler configuration could not be read; overview values are used where available"
            message={confQ.error instanceof Error ? confQ.error.message : String(confQ.error)}
            onRetry={() => void confQ.refetch()}
          />
        ))}
      <Entity id={SINGLETON} className="burrow-overview-row-grid burrow-overview-row-grid--scheduler">
        <Cell label="Scheduler Type">
          {nameText ? (
            <span className="flex min-w-0 items-center">
              {info?.type && <Datum field="scheduler.type" raw={info.type} fmt="text" className="sr-only" aria-hidden="true" />}
              {info?.type && (
                <Tooltip label={`YARN API type: ${info.type}`}>
                  <span
                    className="font-medium"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus the tooltip trigger.
                    tabIndex={0}
                  >
                    <Datum field="scheduler.derived.schedulerName" raw={nameText} fmt="text">
                      {nameText}
                    </Datum>
                  </span>
                </Tooltip>
              )}
              {!info?.type && (
                <Datum field="scheduler.derived.schedulerName" raw={nameText} fmt="text" className="font-medium">
                  {nameText}
                </Datum>
              )}
            </span>
          ) : (
            <Unavailable variant="info" reason="scheduler type not reported" />
          )}
        </Cell>

        <Cell label="Scheduling Resource Type">
          {typesText ? (
            <Datum field="scheduler.derived.schedulingResourceTypes" raw={typesText} fmt="text" className="mono text-body">
              {typesText}
            </Datum>
          ) : (
            <Tooltip label="Resource types were not reported.">
              <Datum
                field="scheduler.derived.schedulingResourceTypes"
                raw={null}
                fmt="text"
                className="mono text-body text-ink-3"
                tabIndex={0}
              >
                n/a
              </Datum>
            </Tooltip>
          )}
        </Cell>

        <Cell label="Minimum Allocation">
          <Datum field="scheduler.derived.minAllocationText" raw={minText} fmt="text" className={parity ? "mono" : "tnum"}>
            {minText == null ? <Unavailable variant="info" reason="Minimum allocation was not reported." /> : (minDisplayText ?? minText)}
          </Datum>
        </Cell>

        <Cell label="Maximum Allocation">
          <Datum field="scheduler.derived.maxAllocationText" raw={maxText} fmt="text" className={parity ? "mono" : "tnum"}>
            {maxText == null ? <Unavailable variant="info" reason="Maximum allocation was not reported." /> : (maxDisplayText ?? maxText)}
          </Datum>
        </Cell>

        <Cell label="Maximum Cluster Application Priority">
          {priority != null ? (
            <Datum field="scheduler.derived.maximumClusterPriority" raw={priority} fmt="int" className="mono" />
          ) : (
            <Datum field="scheduler.derived.maximumClusterPriority" raw={null} fmt="int" className="mono">
              <Unavailable variant="info" reason="Application priority was not reported." />
            </Datum>
          )}
        </Cell>

        <Cell label="Scheduler Busy %">
          <Datum field="cluster.metrics.rmSchedulerBusyPercent" raw={busy} fmt="pct" className="mono">
            {busy == null ? (
              <Unavailable variant="info" reason={metricsUnavailableReason ?? "Scheduler load was not reported."} />
            ) : (
              fmtPct(busy)
            )}
          </Datum>
        </Cell>

        <Cell label="RM Dispatcher EventQueue Size">
          <Datum field="cluster.metrics.rmEventQueueSize" raw={rmQueue} fmt="int" className="mono">
            {rmQueue == null ? (
              <Unavailable variant="info" reason={metricsUnavailableReason ?? "Queue activity was not reported."} />
            ) : (
              fmtInt(rmQueue)
            )}
          </Datum>
        </Cell>

        <Cell label="Scheduler Dispatcher EventQueue Size">
          <Datum field="cluster.metrics.schedulerEventQueueSize" raw={schedulerQueue} fmt="int" className="mono">
            {schedulerQueue == null ? (
              <Unavailable variant="info" reason={metricsUnavailableReason ?? "Queue activity was not reported."} />
            ) : (
              fmtInt(schedulerQueue)
            )}
          </Datum>
        </Cell>

        {missing && (
          <div className="col-span-full flex flex-wrap items-center gap-2">
            <Unavailable reason={why ?? "Detailed scheduler information is unavailable."} />
            <CrossLink href="/scheduler" className="text-small text-live hover:underline">
              Full scheduler view →
            </CrossLink>
          </div>
        )}
        {stale && (
          <div className="col-span-full">
            <Unavailable variant="info" reason="upstream served stale cache" />
          </div>
        )}
      </Entity>

      {collapseQueueTable ? (
        <details className="burrow-overview-disclosure overflow-hidden rounded-md border border-seam-soft bg-well">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-small font-medium text-ink-2 focus-visible:outline-2">
            <span>Queue headroom</span>
            <span className="flex items-center gap-2 text-micro font-normal text-ink-4">
              {teasers.length} {teasers.length === 1 ? "row" : "rows"}
              <span>expand table</span>
              <span aria-hidden="true" className="burrow-overview-disclosure-indicator" />
            </span>
          </summary>
          <div className="border-t border-seam-soft px-3 pb-3">{queueTable}</div>
        </details>
      ) : (
        queueTable
      )}
    </div>
  );
}
