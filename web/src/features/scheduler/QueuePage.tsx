/**
 * `/scheduler/$queue` — one queue in full: the freeness hero, the legacy "Queue Status" label block, and the per-queue
 * tables (users, applications, node-label partitions, allocation activities, configuration).
 *
 * The queue path is the URL key (e.g. `root.etl.ingest`), which is also the parity entity key.
 */
import { useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RotateCw } from "lucide-react";
import { Datum, Entity } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { Button } from "~/ui/button";
import { CenteredPageState, EmptyState, ErrorState } from "~/ui/feedback";
import { ResourceRing } from "~/ui/resource-ring";
import { Tab, TabsList, TabsPanel, TabsRoot } from "~/ui/tabs";
import { fmtMB } from "~/lib/format";
import { nodesQuery, queueAppsQuery, schedulerActivitiesQuery, schedulerConfQuery, schedulerQuery } from "~/api/queries/scheduler";
import { Card, KVRow, KVRowGroup, PageHeader, Section, StateNote } from "./Chrome";
import { CapacityBar, FairBar, FreeReadout } from "./bars";
import { CapacityQueueStatus, FairQueueStatus } from "./QueueStatusBlock";
import { UserTable, userRows } from "./UserTable";
import { QueueAppsTable } from "./QueueAppsTable";
import { PartitionsTable, type PartitionRow } from "./PartitionsTable";
import { ActivitiesTable } from "./ActivitiesTable";
import { ConfTable } from "./ConfTable";
import { errorInfo, useRemote } from "./hooks";
import { countText, pctText, pressureTone } from "./format";
import { buildTree, findQueue, metricsOf, partitionOf, pressurePctOf, schedKindOf, type QueueNode } from "./model";
import { hideFromVisibility, parseSorting, serializeSorting, visibilityFromHide } from "./search";
import type { QueueSearch } from "./search";

const EMPTY_VISIBILITY = {};

export function QueuePage({ queue, search, patch }: { queue: string; search: QueueSearch; patch: (p: Partial<QueueSearch>) => void }) {
  const navigate = useNavigate();
  const infoQ = useRemote(useQuery(schedulerQuery()));
  const info = infoQ.data;
  const kind = info ? schedKindOf(info) : "unknown";
  const root = useMemo(() => (info ? buildTree(info) : null), [info]);
  const node = useMemo(() => findQueue(root, queue), [root, queue]);
  const tab = search.tab ?? "users";
  const appsQ = useRemote(useQuery(queueAppsQuery(queue, ["RUNNING", "ACCEPTED"])));
  const actQ = useRemote(
    useQuery({ ...schedulerActivitiesQuery({ nodeId: search.nodeId, groupBy: search.groupBy }), enabled: tab === "activities" }),
  );
  const nodesQ = useRemote(useQuery({ ...nodesQuery(), enabled: tab === "activities" }));
  const confQ = useRemote(
    useQuery({
      ...schedulerConfQuery(kind === "capacity" ? "capacityScheduler" : undefined),
      enabled: tab === "conf" && kind === "capacity",
    }),
  );

  if (infoQ.loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title={queue} subtitle="Loading this queue from the scheduler tree…" />
        <div className="burrow-skeleton h-24 w-full" />
      </div>
    );
  }
  if (infoQ.error && !info) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title={queue} subtitle="Queue capacity, running applications, and scheduler settings." />
        <CenteredPageState>
          <ErrorState {...errorInfo(infoQ.error)} onRetry={infoQ.retry} />
        </CenteredPageState>
      </div>
    );
  }
  if (!node) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title={queue} subtitle="Queue capacity, running applications, and scheduler settings." />
        <EmptyState
          title={`No queue named ${queue} in this scheduler`}
          action={<Button onClick={() => void navigate({ to: "/scheduler" })}>Back to the scheduler tree</Button>}
        >
          Queue paths are case-sensitive and include their ancestors (for example <span className="font-mono">root.etl.ingest</span>). The
          queue may also have been removed since the page was opened.
        </EmptyState>
      </div>
    );
  }

  const m = metricsOf(node, "");
  const ancestors = queue.split(".").reduce<string[]>((acc, seg) => {
    const prev = acc[acc.length - 1];
    acc.push(prev ? `${prev}.${seg}` : seg);
    return acc;
  }, []);

  return (
    // The scheduler layout is a bare `<Outlet/>` and `main` is `overflow-hidden`, so a page has to bring its own
    // scroller (the index page does, in its tabs panel). Without this the queue page's content was clipped at the
    // viewport edge on any screen shorter than the page — nothing scrolled at all.
    <div className="burrow-scroll burrow-page-scroll burrow-page-scroll--stable flex min-h-0 flex-1 flex-col overflow-y-auto">
      <nav aria-label="Queue path" className="flex flex-wrap items-center gap-1 pb-1 text-small text-ink-3">
        <Link to="/scheduler" className="text-live hover:underline">
          Scheduler
        </Link>
        {ancestors.map((path, i) => (
          <span key={path} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-ink-4" aria-hidden="true" />
            {i === ancestors.length - 1 ? (
              <span className="font-mono text-ink-2" aria-current="page">
                {path}
              </span>
            ) : (
              <Link to="/scheduler/$queue" params={{ queue: path }} className="font-mono text-live hover:underline">
                {path}
              </Link>
            )}
          </span>
        ))}
      </nav>

      <PageHeader
        title={<span className="font-mono">{node.id}</span>}
        subtitle={
          node.role === "root"
            ? "Root queue · cluster-wide capacity, applications, and scheduler settings."
            : node.role === "leaf"
              ? "Queue capacity, running applications, and scheduler settings."
              : "Parent queue · child queue capacity and aggregate application activity."
        }
        meta={
          <Entity as="span" id={node.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {node.capacity && (
              <>
                <StatusPill domain="queue.state" state={node.capacity.state} field="queue.state" size="sm" />
                <span className="flex items-center gap-1">
                  <span className="text-ink-4">policy</span>
                  <Datum field="queue.orderingPolicyInfo" raw={node.capacity.orderingPolicyInfo} className="text-ink-2">
                    {node.capacity.orderingPolicyInfo ?? "—"}
                  </Datum>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-ink-4">labels</span>
                  <Datum
                    field="queue.nodeLabels"
                    raw={(node.capacity.nodeLabels ?? []).join(",")}
                    className="font-mono text-small text-ink-2"
                  >
                    {node.capacity.nodeLabels?.length ? node.capacity.nodeLabels.join(",") : "—"}
                  </Datum>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-ink-4">apps</span>
                  <Datum field="queue.numActiveApplications" raw={node.capacity.numActiveApplications} fmt="int" className="text-ink-2">
                    {countText(m.activeApps ?? m.apps)}
                  </Datum>
                  <span className="text-ink-4">active ·</span>
                  <Datum field="queue.numPendingApplications" raw={node.capacity.numPendingApplications} fmt="int" className="text-ink-2">
                    {countText(m.pendingApps)}
                  </Datum>
                  <span className="text-ink-4">pending</span>
                </span>
              </>
            )}
            {node.fair && (
              <>
                <span className="flex items-center gap-1">
                  <span className="text-ink-4">policy</span>
                  <Datum field="queue.schedulingPolicy" raw={node.fair.schedulingPolicy} className="text-ink-2">
                    {node.fair.schedulingPolicy}
                  </Datum>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-ink-4">preemptable</span>
                  <Datum field="queue.preemptable" raw={node.fair.preemptable} className="text-ink-2">
                    {String(node.fair.preemptable)}
                  </Datum>
                </span>
              </>
            )}
          </Entity>
        }
        actions={
          <Button size="sm" variant="quiet" onClick={infoQ.retry} aria-busy={infoQ.loading}>
            <RotateCw className="size-3.5" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <Entity id={node.id} className="flex flex-col gap-3">
        <FreenessHero node={node} />
        <Section title="Queue Status">
          <Card>
            {node.capacity ? (
              <CapacityQueueStatus raw={node.capacity} leaf={node.role === "leaf"} />
            ) : node.fair ? (
              <FairQueueStatus raw={node.fair} leaf={node.role === "leaf"} />
            ) : (
              <p className="text-body text-ink-3">This scheduler type has no queue status block.</p>
            )}
            {node.role !== "leaf" && (
              <p className="mt-2 text-small text-ink-4">
                Parent queue: the legacy page renders no status block for parents, so these rows are the queue's own REST fields shown for
                completeness.
              </p>
            )}
          </Card>
        </Section>
      </Entity>

      <TabsRoot value={tab} onValueChange={(v) => patch({ tab: v as QueueSearch["tab"] })} className="mt-3 flex min-h-0 flex-none flex-col">
        <TabsList label="Queue sections" overflowFade>
          <Tab value="users" field="queueuser.username">
            Users
          </Tab>
          <Tab value="apps" field="app.id">
            Applications
          </Tab>
          <Tab value="partitions" field="queue.capacities.queueCapacitiesByPartition.partitionName">
            Partitions
          </Tab>
          <Tab value="activities" field="activities.timestamp">
            Activities
          </Tab>
          <Tab value="conf" field="conf.property.name">
            Configuration
          </Tab>
        </TabsList>

        <div className="mt-2 min-w-0">
          <TabsPanel value="users" data-burrow-queue-tab-panel="users" className="pb-8">
            {node.capacity ? (
              <UserTable
                rows={userRows(node.id, node.capacity)}
                sorting={parseSorting(search.usersSort)}
                onSortingChange={(s) => patch({ usersSort: serializeSorting(s) })}
                columnVisibility={visibilityFromHide(search.usersHide, EMPTY_VISIBILITY)}
                onColumnVisibilityChange={(v) => patch({ usersHide: hideFromVisibility(v) })}
                stableViewport
              />
            ) : (
              <StateNote title="The Fair scheduler has no per-user table">
                `users.user[]` only exists on Capacity leaf queues. Fair shares are per queue, not per user, in this REST shape.
              </StateNote>
            )}
          </TabsPanel>

          <TabsPanel value="apps" data-burrow-queue-tab-panel="apps" className="pb-8">
            {appsQ.stale && <ErrorState compact {...errorInfo(appsQ.error)} onRetry={appsQ.retry} />}
            <QueueAppsTable
              apps={appsQ.data ?? []}
              loading={appsQ.loading}
              error={appsQ.error && !appsQ.data ? <ErrorState {...errorInfo(appsQ.error)} onRetry={appsQ.retry} /> : undefined}
              sorting={parseSorting(search.appsSort)}
              onSortingChange={(s) => patch({ appsSort: serializeSorting(s) })}
              columnVisibility={visibilityFromHide(search.appsHide, {
                applicationType: false,
                finalStatus: false,
                reservedMB: false,
                reservedVCores: false,
              })}
              onColumnVisibilityChange={(v) => patch({ appsHide: hideFromVisibility(v) })}
              stableViewport
            />
          </TabsPanel>

          <TabsPanel value="partitions" data-burrow-queue-tab-panel="partitions" className="pb-8">
            {node.capacity ? (
              <PartitionsTable
                queuePath={node.id}
                rows={partitionRows(node)}
                sorting={parseSorting(search.partSort)}
                onSortingChange={(s) => patch({ partSort: serializeSorting(s) })}
                columnVisibility={visibilityFromHide(search.partHide, {
                  configuredMin: false,
                  configuredMax: false,
                  weight: false,
                  reservedMem: false,
                  pendingMem: false,
                })}
                onColumnVisibilityChange={(v) => patch({ partHide: hideFromVisibility(v) })}
                stableViewport
              />
            ) : (
              <StateNote title="No partitions in this scheduler shape">
                Fair queues are not split by node-label partition in the REST payload.
              </StateNote>
            )}
          </TabsPanel>

          <TabsPanel value="activities" data-burrow-queue-tab-panel="activities" className="pb-8">
            {actQ.stale && <ErrorState compact {...errorInfo(actQ.error)} onRetry={actQ.retry} />}
            <ActivitiesTable
              activities={actQ.data}
              loading={actQ.loading}
              fetching={actQ.fetching}
              error={actQ.error && !actQ.data ? <ErrorState {...errorInfo(actQ.error)} onRetry={actQ.retry} /> : undefined}
              sorting={parseSorting(search.actSort)}
              onSortingChange={(s) => patch({ actSort: serializeSorting(s) })}
              columnVisibility={visibilityFromHide(search.actHide, EMPTY_VISIBILITY)}
              onColumnVisibilityChange={(v) => patch({ actHide: hideFromVisibility(v) })}
              nodeId={search.nodeId ?? ""}
              onNodeIdChange={(id) => patch({ nodeId: id || undefined })}
              nodeOptions={(nodesQ.data ?? []).map((n) => n.id)}
              groupBy={search.groupBy ?? ""}
              onGroupByChange={(g) => patch({ groupBy: g === "DIAGNOSTIC" ? "DIAGNOSTIC" : undefined })}
              queueFilter={node.id}
              stableViewport
            />
          </TabsPanel>

          <TabsPanel value="conf" data-burrow-queue-tab-panel="conf" className="pb-8">
            {kind === "capacity" ? (
              <>
                {confQ.stale && <ErrorState compact {...errorInfo(confQ.error)} onRetry={confQ.retry} />}
                <ConfTable
                  properties={confQ.data ?? []}
                  queuePath={node.id}
                  showAll={search.confAll ?? false}
                  onShowAllChange={(v) => patch({ confAll: v })}
                  loading={confQ.loading}
                  error={confQ.error && !confQ.data ? <ErrorState {...errorInfo(confQ.error)} onRetry={confQ.retry} /> : undefined}
                  sorting={parseSorting(search.confSort)}
                  onSortingChange={(s) => patch({ confSort: serializeSorting(s) })}
                  columnVisibility={visibilityFromHide(search.confHide, EMPTY_VISIBILITY)}
                  onColumnVisibilityChange={(v) => patch({ confHide: hideFromVisibility(v) })}
                  stableViewport
                />
              </>
            ) : (
              <StateNote title="This scheduler has no retrievable configuration" tone="warn">
                `GET /ws/v1/cluster/scheduler-conf` only answers for schedulers implementing MutableConfScheduler — the CapacityScheduler.
                The {kind === "fair" ? "FairScheduler" : "FifoScheduler"} returns HTTP 400.
              </StateNote>
            )}
          </TabsPanel>
        </div>
      </TabsRoot>
    </div>
  );
}

/** All partitions of a capacity queue, zipped capacity ↔ usage by partition name. */
function partitionRows(node: QueueNode): PartitionRow[] {
  const caps = node.capacity?.capacities?.queueCapacitiesByPartition ?? [];
  const res = node.capacity?.resources?.resourceUsagesByPartition ?? [];
  return caps.map((cap) => ({ cap, res: res.find((r) => (r.partitionName ?? "") === (cap.partitionName ?? "")) }));
}

function FreenessHero({ node }: { node: QueueNode }) {
  const m = metricsOf(node, "");
  const { cap, res } = partitionOf(node, "");
  const usedPct = m.absUsedPct ?? m.usedPct;
  const tone = pressureTone(pressurePctOf(node, m));
  const freePct = node.capacity ? Math.max(0, (m.absCapPct ?? m.capPct ?? 0) - (usedPct ?? 0)) : null;
  return (
    <Section title="Freeness">
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <ResourceRing
          used={m.usedMb ?? 0}
          reserved={m.reservedMb ?? 0}
          total={m.maxMb ?? 0}
          tone={tone}
          size={84}
          label={`${node.id} memory used`}
          centre={<span className="tnum">{m.maxMb ? `${(((m.usedMb ?? 0) / m.maxMb) * 100).toFixed(0)}%` : "—"}</span>}
        />
        <div className="flex min-w-64 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            {node.capacity ? (
              <CapacityBar
                usedPct={usedPct}
                capPct={m.absCapPct ?? m.capPct}
                maxPct={m.absMaxPct ?? m.maxPct}
                tone={tone}
                label={node.id}
                datum={{
                  "data-yf": "queue.absoluteUsedCapacity",
                  "data-yv": cap?.absoluteUsedCapacity == null ? "" : String(cap.absoluteUsedCapacity),
                  "data-yfmt": "pct",
                }}
              />
            ) : (
              <FairBar
                usedMb={m.usedMb}
                minMb={m.minMb}
                fairMb={m.fairMb}
                maxMb={m.maxMb}
                tone={tone}
                label={node.id}
                datum={{
                  "data-yf": "queue.usedResources.memory",
                  "data-yv": node.fair?.usedResources?.memory == null ? "" : String(node.fair.usedResources.memory),
                  "data-yfmt": "mb",
                }}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-3" aria-label="Freeness bar legend">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-1 w-4 rounded-full"
                style={{ background: "linear-gradient(90deg, var(--ok), var(--live), var(--wait), var(--warn), var(--fail))" }}
              />
              used · color shows pressure
            </span>
            {node.capacity ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="burrow-progress-legend-guarantee" />
                  guaranteed share
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="burrow-progress-legend-max" />
                  max capacity
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="burrow-progress-legend-minimum" />
                  minimum
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="burrow-progress-legend-fair" />
                  fair share
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="burrow-progress-legend-max" />
                  max
                </span>
              </>
            )}
          </div>
          {/* one column until `xl`: `KVRow` keeps its label at `shrink-0` and truncates the value, and this grid sits
              beside the freeness ring, so it is narrower than a full-width KV — three columns only fit on wide screens
              (≥1280px). At 390/768/1024 values like "16.0% free" collapsed to "16.0…" */}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-0 text-body xl:grid-cols-3">
            {node.capacity ? (
              <>
                <KVRow
                  label="Used of its share"
                  field="queue.capacities.queueCapacitiesByPartition.usedCapacity"
                  raw={cap?.usedCapacity}
                  fmt="pct"
                >
                  {pctText(m.usedPct)}
                </KVRow>
                <KVRowGroup label="Free inside the share">
                  <FreeReadout freePct={freePct} freeMb={null} field="queue.derived.freeGuaranteedPct" />
                </KVRowGroup>
                <KVRowGroup label="Room before max">
                  <FreeReadout
                    freePct={node.capacity ? Math.max(0, (m.absMaxPct ?? m.maxPct ?? 0) - (usedPct ?? 0)) : null}
                    freeMb={null}
                    field="queue.derived.burstRoomPct"
                  />
                </KVRowGroup>
              </>
            ) : (
              <>
                <KVRowGroup label="Free inside the fair share">
                  <FreeReadout
                    freePct={null}
                    freeMb={m.fairMb != null && m.usedMb != null ? m.fairMb - m.usedMb : null}
                    field="queue.derived.fairShareFreeMb"
                  />
                </KVRowGroup>
                <KVRowGroup label="Used of fair">
                  <Datum field="queue.derived.usedOfFairPct" raw={m.fairMb ? ((m.usedMb ?? 0) / m.fairMb) * 100 : null} fmt="pct" />
                </KVRowGroup>
                <KVRowGroup label="Used of minimum">
                  <Datum field="queue.derived.usedOfMinPct" raw={m.minMb ? ((m.usedMb ?? 0) / m.minMb) * 100 : null} fmt="pct" />
                </KVRowGroup>
              </>
            )}
            <KVRowGroup label="Headroom to max">
              <Datum
                field="queue.derived.headroomMb"
                raw={
                  node.capacity?.maxEffectiveCapacity?.memory != null && m.usedMb != null
                    ? node.capacity.maxEffectiveCapacity.memory - m.usedMb
                    : m.maxMb != null && m.usedMb != null
                      ? m.maxMb - m.usedMb
                      : null
                }
                fmt="mb"
                className="tnum text-ink-2"
              >
                {fmtMB(Math.max(0, (m.maxMb ?? 0) - (m.usedMb ?? 0)))}
              </Datum>
            </KVRowGroup>
            <KVRowGroup label="Reserved / pending">
              <span className="inline-flex items-baseline gap-1 tnum">
                <Datum
                  field="queue.resources.resourceUsagesByPartition.reserved.memory"
                  raw={res?.reserved?.memory ?? node.fair?.reservedResources?.memory}
                  fmt="mb"
                  className="text-ink-2"
                >
                  {countText(res?.reserved?.memory ?? m.reservedMb)}
                </Datum>
                <span className="text-ink-4">res ·</span>
                <Datum
                  field="queue.resources.resourceUsagesByPartition.pending.memory"
                  raw={res?.pending?.memory}
                  fmt="mb"
                  className="text-ink-2"
                >
                  {countText(res?.pending?.memory ?? m.pendingMb)}
                </Datum>
                <span className="text-ink-4">pend</span>
              </span>
            </KVRowGroup>
            <KVRow
              label="Containers"
              field="queue.allocatedContainers"
              raw={node.capacity?.allocatedContainers ?? node.fair?.allocatedContainers}
              fmt="int"
            >
              {countText(m.containers)}
            </KVRow>
            <KVRow
              label="Max containers"
              field="queue.maxApplications"
              raw={node.capacity?.maxApplications ?? node.fair?.maxApps}
              fmt="int"
            >
              {countText(m.maxApps)}
            </KVRow>
          </dl>
        </div>
      </Card>
    </Section>
  );
}
