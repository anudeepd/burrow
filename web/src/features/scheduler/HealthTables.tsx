/**
 * Scheduler health — the legacy `div#health` block of `/cluster/scheduler` (Capacity only).
 *
 *  - "Aggregate scheduler counts": the legacy page reads the live scheduler's counters. REST does not expose them, but the
 *    RM's root-queue QueueMetrics MBean does, so three of the four come from `/api/rm/jmx`:
 *    `Hadoop:service=ResourceManager,name=QueueMetrics,q0=root` → AggregateContainersAllocated / AggregateContainersReleased /
 *    AggregateContainersPreempted. When JMX is unreachable (or the key is absent) we print an honest `N/A` (data-yn=1), never
 *    a zero. The fourth legacy counter, "Total Fulfilled Reservations", has no source anywhere (no SchedulerHealth bean, no
 *    reservation metrics bean, no REST) and is waived instead of being rendered as 0.
 *  - "Last scheduler run": `schedulerInfo.health.lastrun` + `health.lastRunDetails[]` (both real REST fields).
 *  - Four "Last <Allocation|Reservation|Release|Preemption>" tables: `health.operationsInfo[]` gives Container Id / Node Id /
 *    Queue. The legacy Time column is SchedulerHealth.DetailedInformation.getTimestamp(), which no REST field or JMX bean
 *    carries — it is omitted (and waived), never faked from the scheduler's last-run time.
 */
import { Datum, Entity } from "~/ui/datum";
import { DetailTableScroller } from "~/ui/detail-table-scroller";
import { fmtInt } from "~/lib/format";
import type { SchedulerHealth } from "~/api/schemas";
import { Section, StateNote } from "./Chrome";
import { HEALTH_KINDS, healthOperations } from "./model";
import { resourceText } from "./format";

export interface QueueMetricsBean {
  allocated?: number | null;
  released?: number | null;
  preempted?: number | null;
  source: string | null;
}

/** Pull the three aggregate counters out of a `Hadoop:service=ResourceManager,name=QueueMetrics,q0=root` bean. */
export function aggregateCounts(bean: Record<string, unknown> | undefined): QueueMetricsBean {
  if (!bean) return { allocated: null, released: null, preempted: null, source: null };
  const read = (k: string): number | null => {
    const v = bean[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return {
    allocated: read("AggregateContainersAllocated") ?? read("AggregateContainerAllocated"),
    released: read("AggregateContainersReleased") ?? read("AggregateContainerReleased"),
    preempted: read("AggregateContainersPreempted") ?? read("AggregateContainerPreempted"),
    source: typeof bean.name === "string" ? bean.name : null,
  };
}

/**
 * The three legacy aggregate counters that the RM's QueueMetrics JMX bean actually carries, keyed by their inventory field
 * ids. "Total Fulfilled Reservations(count)" is deliberately absent: no REST/JMX source exists (see the waivers on
 * `scheduler.derived.aggregateFulfilledReservations`).
 */
const AGG_COLUMNS = [
  {
    label: "Total Container Allocations(count)",
    field: "scheduler.derived.aggregateAllocatedContainers",
    read: (a: QueueMetricsBean) => a.allocated,
  },
  {
    label: "Total Container Releases(count)",
    field: "scheduler.derived.aggregateReleasedContainers",
    read: (a: QueueMetricsBean) => a.released,
  },
  {
    label: "Total Container Preemptions(count)",
    field: "scheduler.derived.aggregatePreemptions",
    read: (a: QueueMetricsBean) => a.preempted,
  },
] as const;

const RUN_OPERATIONS = [
  { key: "allocations", label: "Allocations" },
  { key: "reservations", label: "Reservations" },
  { key: "releases", label: "Releases" },
] as const;

export function HealthTables({
  health,
  aggregates,
  aggregateError,
  className,
}: {
  health: SchedulerHealth | undefined;
  aggregates: QueueMetricsBean | undefined;
  /** set when the JMX source failed — the aggregate row then says so instead of showing blanks */
  aggregateError?: string | null;
  className?: string;
}) {
  const operations = healthOperations(health);
  const lastRun = health?.lastrun ?? null;
  const lastDetails = health?.lastRunDetails ?? [];

  return (
    <Entity id="_" className={className}>
      <Section title="Aggregate scheduler counts">
        {aggregateError && (
          <p role="status" className="text-small text-ink-3">
            JMX unavailable: {aggregateError}
          </p>
        )}
        <DetailTableScroller ariaLabel="Aggregate scheduler counts" className="rounded-lg border border-seam bg-fabric">
          <table className="w-full text-body sm:min-w-[46rem]">
            <thead>
              <tr className="border-b border-seam bg-fabric-2 text-small text-ink-3">
                {AGG_COLUMNS.map((c) => (
                  <th key={c.field} scope="col" className="px-2 py-1.5 text-left font-medium sm:px-3">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {AGG_COLUMNS.map((c) => {
                  const v = aggregates ? c.read(aggregates) : null;
                  return (
                    <td key={c.field} className="px-2 py-1.5 tnum sm:px-3">
                      {v == null ? (
                        <Datum field={c.field} raw={null}>
                          N/A
                        </Datum>
                      ) : (
                        <Datum field={c.field} raw={v} fmt="int">
                          {fmtInt(v)}
                        </Datum>
                      )}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </DetailTableScroller>
      </Section>

      <Section
        title="Last scheduler run"
        actions={
          <span className="text-small text-ink-3 tnum">
            <Datum field="scheduler.health.lastrun" raw={lastRun} fmt="epoch">
              {lastRun === 0 ? "Never" : undefined}
            </Datum>
          </span>
        }
        className="mt-4"
      >
        <DetailTableScroller ariaLabel="Last scheduler run" className="rounded-lg border border-seam bg-fabric">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b border-seam bg-fabric-2 text-small text-ink-3">
                <th scope="col" className="px-2 py-1.5 text-left font-medium sm:px-3">
                  Operation
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium sm:px-3">
                  Count
                </th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium sm:px-3">
                  Resources
                </th>
              </tr>
            </thead>
            <tbody>
              {RUN_OPERATIONS.map(({ key, label }) => {
                const detail = lastDetails.find((item) => item.operation === key);
                return (
                  <tr key={key} className="border-b border-seam-soft last:border-b-0">
                    <th scope="row" className="px-2 py-1.5 text-left font-medium sm:px-3">
                      {label}
                    </th>
                    <td className="px-2 py-1.5 text-right tnum sm:px-3">
                      <Datum field="scheduler.health.lastRunDetails.count" raw={detail?.count} fmt="int">
                        {detail?.count == null ? "—" : fmtInt(detail.count)}
                      </Datum>
                    </td>
                    <td className="px-2 py-1.5 tnum sm:px-3">
                      <Datum
                        field="scheduler.health.lastRunDetails.resources.memory"
                        raw={detail?.resources?.memory}
                        fmt="mb"
                        className="text-ink-2"
                      >
                        {detail?.resources ? resourceText(detail.resources) : "—"}
                      </Datum>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DetailTableScroller>
      </Section>

      <Section title="Last operations" className="mt-4">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {HEALTH_KINDS.map((kind) => {
            const row = operations.find((o) => o.kind === kind);
            return (
              <div key={kind} className="overflow-hidden rounded-lg border border-seam">
                <h3 className="border-b border-seam bg-fabric-2 px-3 py-1.5 text-small font-medium text-ink-2">Last {kind}</h3>
                <table className="w-full table-fixed text-body">
                  <thead>
                    <tr className="border-b border-seam text-micro text-ink-4">
                      <th scope="col" className="w-[42%] px-3 py-1 text-left font-medium">
                        Container Id
                      </th>
                      <th scope="col" className="w-[28%] px-3 py-1 text-left font-medium">
                        Node Id
                      </th>
                      <th scope="col" className="w-[30%] px-3 py-1 text-left font-medium">
                        Queue
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="px-3 py-1.5 font-mono text-caption">
                        <Datum
                          field="scheduler.health.operationsInfo.containerId"
                          raw={row?.containerId}
                          className="block truncate"
                          title={row?.containerId ?? undefined}
                        >
                          {row?.containerId ?? "N/A"}
                        </Datum>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-caption">
                        <Datum
                          field="scheduler.health.operationsInfo.nodeId"
                          raw={row?.nodeId}
                          className="block truncate"
                          title={row?.nodeId ?? undefined}
                        >
                          {row?.nodeId ?? "N/A"}
                        </Datum>
                      </td>
                      <td className="px-3 py-1.5">
                        <Datum
                          field="scheduler.health.operationsInfo.queue"
                          raw={row?.queue}
                          className="block truncate"
                          title={row?.queue ?? undefined}
                        >
                          {row?.queue ?? "N/A"}
                        </Datum>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
        {operations.length === 0 && <StateNote title="No scheduler operation recorded yet" />}
      </Section>
    </Entity>
  );
}
