/**
 * `/scheduler` — the queue-freeness view.
 *
 * Layout: scheduler metrics strip → tabs. The "Queues" tab is the hero: the hierarchical queue tree with a
 * used-vs-share-vs-max bar per queue (freeness first), then the used-resources treemap, then the node-label partitions.
 * Activities / Health / Configuration are the three things the legacy page shows beside the tree.
 *
 * All three scheduler types are handled: Capacity and Fair get the tree (different shapes, same freeness idea), FIFO gets
 * its single-queue block. Unknown scheduler types get an explicit note instead of a broken page.
 */
import { useCallback, useMemo } from "react";
import { RotateCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "~/ui/button";
import { CenteredPageState, ErrorState, EmptyState } from "~/ui/feedback";
import { Select } from "~/ui/select";
import { Tab, TabsList, TabsPanel, TabsRoot } from "~/ui/tabs";
import { cn } from "~/lib/cn";
import { fmtMB, fmtPct } from "~/lib/format";
import { q } from "~/api/queries";
import { nodesQuery, schedulerActivitiesQuery, schedulerConfQuery, schedulerQuery } from "~/api/queries/scheduler";
import { isCapacityScheduler, isFifoScheduler } from "~/api/schemas";
import { PageHeader, Section, StateNote, Tile, TileLabel } from "./Chrome";
import { QueueTree, type SiblingSort } from "./QueueTree";
import { TreemapSection, type TreemapBasis } from "./TreemapSection";
import { SchedulerMetrics } from "./SchedulerMetrics";
import { FifoQueueStatus } from "./FifoQueueStatus";
import { HealthTables, aggregateCounts } from "./HealthTables";
import { ActivitiesTable } from "./ActivitiesTable";
import { ConfTable } from "./ConfTable";
import { NodeLabelsCard } from "./NodeLabelsCard";
import { UserTable, userRows } from "./UserTable";
import { errorInfo, useRemote } from "./hooks";
import { buildTree, metricsOf, overShareCount, partitionNames, schedKindOf, walkTree } from "./model";
import { hideFromVisibility, parseOpenQueues, parseSorting, serializeOpenQueues, serializeSorting, visibilityFromHide } from "./search";
import { partitionText } from "./format";
import type { SchedulerSearch } from "./search";

const JMX_QUEUE_METRICS = "Hadoop:service=ResourceManager,name=QueueMetrics,q0=root";

const EMPTY_VISIBILITY = {};

export function SchedulerPage({
  search,
  patch,
}: {
  search: SchedulerSearch;
  patch: (p: Partial<SchedulerSearch>, options?: { resetScroll?: boolean }) => void;
}) {
  const navigate = useNavigate();
  const infoQ = useRemote(useQuery(schedulerQuery()));
  const metricsQ = useRemote(useQuery(q.metrics()));
  const info = infoQ.data;
  const kind = info ? schedKindOf(info) : "unknown";
  const tab = search.tab ?? "queues";
  const partition = search.partition ?? "";
  const basis: TreemapBasis = search.basis ?? "used";
  const sort: SiblingSort = search.sort ?? "name";

  const root = useMemo(() => (info ? buildTree(info) : null), [info]);
  const partitions = useMemo(() => (root ? partitionNames(root) : []), [root]);
  const barScale = useMemo(() => {
    let largest = kind === "capacity" ? 100 : 1;
    if (!root) return largest;
    for (const node of walkTree(root)) {
      const metrics = metricsOf(node, partition);
      const values =
        kind === "capacity"
          ? [metrics.absUsedPct ?? metrics.usedPct, metrics.absCapPct ?? metrics.capPct, metrics.absMaxPct ?? metrics.maxPct]
          : [metrics.usedMb, metrics.minMb, metrics.fairMb, metrics.maxMb];
      for (const value of values) {
        if (value != null && Number.isFinite(value)) largest = Math.max(largest, value);
      }
    }
    return largest;
  }, [root, kind, partition]);
  const users = useMemo(
    () => (root && kind === "capacity" ? walkTree(root).flatMap((n) => userRows(n.id, n.capacity, partition)) : []),
    [root, kind, partition],
  );
  const open = useMemo(() => parseOpenQueues(search.openQueues), [search.openQueues]);
  const isOpen = useCallback((path: string) => (open === null ? true : open.includes(path)), [open]);
  const toggle = useCallback(
    (path: string) => {
      const all = root ? walkTree(root).map((n) => n.id) : [];
      const current = open ?? all;
      const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
      patch({ openQueues: serializeOpenQueues(next) });
    },
    [open, root, patch],
  );

  const wantActivities = tab === "activities";
  const actQ = useRemote(
    useQuery({ ...schedulerActivitiesQuery({ nodeId: search.nodeId, groupBy: search.groupBy }), enabled: wantActivities }),
  );
  const nodesQ = useRemote(useQuery({ ...nodesQuery(), enabled: tab === "queues" || tab === "activities" }));
  const confQ = useRemote(
    useQuery({
      ...schedulerConfQuery(kind === "capacity" ? "capacityScheduler" : undefined),
      enabled: tab === "conf" && kind === "capacity",
    }),
  );
  const jmxQ = useRemote(useQuery({ ...q.rmJmx(JMX_QUEUE_METRICS), enabled: tab === "health" && kind === "capacity" }));

  if (infoQ.loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <PageHeader title="Scheduler" subtitle="Loading the scheduler tree from the ResourceManager…" />
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))" }}>
          {Array.from({ length: 12 }, (_, i) => (
            <Tile key={i}>
              <TileLabel>Loading</TileLabel>
              <div className="burrow-skeleton mt-1 h-4 w-2/3" />
            </Tile>
          ))}
        </div>
      </div>
    );
  }
  if (infoQ.error && !info) {
    const e = errorInfo(infoQ.error);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Scheduler" subtitle="Queue capacity, scheduling activity, and ResourceManager health." />
        <CenteredPageState>
          <ErrorState title={e.title} message={e.message} hint={e.hint} detail={e.detail} onRetry={infoQ.retry} />
        </CenteredPageState>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Scheduler" subtitle="Queue capacity, scheduling activity, and ResourceManager health." />
        <EmptyState title="This cluster reports no scheduler">
          The ResourceManager answered without a scheduler tree. This happens on a federation router or a very old RM.
        </EmptyState>
      </div>
    );
  }
  if ((kind === "capacity" || kind === "fair") && !root) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Scheduler" subtitle="Queue capacity, scheduling activity, and ResourceManager health." />
        <EmptyState title={`The ${kind} payload has no queue tree`}>
          The ResourceManager reported a {kind} scheduler without a root queue, so there is nothing to render. Reload once the scheduler has
          started.
        </EmptyState>
      </div>
    );
  }

  const overShare = root ? overShareCount(root, partition) : 0;
  const queueCount = root ? walkTree(root).length : 0;
  const actSorting = parseSorting(search.actSort);
  const confSorting = parseSorting(search.confSort);
  /* undefined = no URL override: the queue tree falls back to its own default visibility (the core columns) */
  const queueVis = search.queueHide === undefined ? undefined : visibilityFromHide(search.queueHide, EMPTY_VISIBILITY);

  return (
    <div
      className={cn(
        "burrow-scroll burrow-page-scroll burrow-page-scroll--stable flex min-h-0 flex-1 flex-col overflow-y-auto",
        tab !== "conf" && "[&>*]:shrink-0",
        tab === "conf" && "pb-6",
      )}
    >
      <PageHeader
        title="Scheduler"
        subtitle="Queue capacity, scheduling activity, and ResourceManager health."
        actions={
          <>
            {infoQ.stale && (
              <span role="status" className="rounded-md border border-warn/40 px-2 py-0.5 text-small text-warn">
                cached — the ResourceManager is not answering
              </span>
            )}
            <Button size="sm" variant="quiet" onClick={infoQ.retry} aria-busy={infoQ.loading}>
              <RotateCw className="size-3.5" aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      />

      <SchedulerMetrics
        info={info}
        queueCount={queueCount}
        overShare={overShare}
        metrics={metricsQ.data}
        metricsError={metricsQ.error ? errorInfo(metricsQ.error).message : null}
      />

      <TabsRoot
        value={tab}
        onValueChange={(v) => patch({ tab: v as SchedulerSearch["tab"] })}
        className={cn("mt-3 flex min-w-0 flex-col", tab === "conf" ? "min-h-0 flex-1" : "shrink-0")}
      >
        <TabsList label="Scheduler sections" overflowFade className="shrink-0 bg-ground">
          <Tab value="queues">Queues</Tab>
          <Tab value="activities" field="activities.timestamp">
            Activities
          </Tab>
          <Tab value="health">Health</Tab>
          <Tab value="conf" field="conf.property.name">
            Configuration
          </Tab>
        </TabsList>

        <TabsPanel value="queues" data-burrow-scheduler-tab-panel="queues" className="mt-2 flex min-w-0 flex-col gap-7 pb-8">
          {isFifoScheduler(info) && <FifoQueueStatus info={info} />}
          {kind === "unknown" && (
            <StateNote title={`Scheduler type "${info.type}" is not recognised by this build`} tone="warn">
              The page renders what the payload contains: the raw scheduler object is shown below, and queue freeness is unavailable because
              there is no known queue shape.
            </StateNote>
          )}
          {(kind === "capacity" || kind === "fair") && root && (
            <Section
              title="Queue headroom"
              actions={
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {kind === "capacity" && partitions.length > 1 && (
                    <span className="flex items-center gap-1.5 text-small text-ink-3">
                      Partition
                      <Select
                        label="Partition"
                        value={partition}
                        onValueChange={(v) => patch({ partition: v ?? "" })}
                        options={partitions.map((p) => ({ value: p, label: partitionText(p) }))}
                      />
                    </span>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3" aria-label="Queue bar legend">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="h-1 w-4 rounded-full"
                        style={{ background: "linear-gradient(90deg, var(--ok), var(--live), var(--wait), var(--warn), var(--fail))" }}
                      />
                      used · color shows pressure
                    </span>
                    {kind === "capacity" ? (
                      <>
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden="true" className="burrow-progress-legend-guarantee" />
                          guaranteed share
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden="true" className="burrow-progress-legend-max" />
                          max capacity
                        </span>
                        <span>free = unused guaranteed share</span>
                        <span className="text-ink-4">scale 0–{fmtPct(barScale)}</span>
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
                        <span>free = memory to fair share</span>
                        <span className="text-ink-4">scale 0–{fmtMB(barScale)}</span>
                      </>
                    )}
                  </div>
                </div>
              }
            >
              <QueueTree
                root={root}
                kind={kind}
                partition={partition}
                scale={barScale}
                isOpen={isOpen}
                onToggle={toggle}
                sort={sort}
                onSortChange={(s) => patch({ sort: s })}
                sorting={[]}
                onSortingChange={() => undefined}
                columnVisibility={queueVis}
                onColumnVisibilityChange={(v) => patch({ queueHide: hideFromVisibility(v) })}
                onActivate={(node) => void navigate({ to: "/scheduler/$queue", params: { queue: node.id } })}
                className="h-[min(58dvh,560px)]"
              />
            </Section>
          )}
          <div className="flex flex-col gap-7">
            {(kind === "capacity" || kind === "fair") && root && (
              <>
                {users.length > 0 && (
                  <Section
                    title="Queue users"
                    className="gap-1"
                    actions={<span className="text-small text-ink-3 tnum">{users.filter((r) => r.user.isActive).length} active</span>}
                  >
                    <UserTable
                      rows={users}
                      showQueue
                      sorting={parseSorting(search.usersSort)}
                      onSortingChange={(s) => patch({ usersSort: serializeSorting(s) })}
                      columnVisibility={visibilityFromHide(search.usersHide, EMPTY_VISIBILITY)}
                      onColumnVisibilityChange={(v) => patch({ usersHide: hideFromVisibility(v) })}
                      stableViewport
                    />
                  </Section>
                )}
                <TreemapSection root={root} basis={basis} partition={partition} onBasisChange={(b) => patch({ basis: b })} />
              </>
            )}
            {kind === "unknown" && (
              <pre className="max-h-96 overflow-auto rounded-lg border border-seam bg-well p-3 text-caption">
                {JSON.stringify(info, null, 2)}
              </pre>
            )}
            <NodeLabelsCard
              nodes={nodesQ.data ?? []}
              loading={nodesQ.loading}
              stale={nodesQ.stale}
              error={nodesQ.error && !nodesQ.data ? <ErrorState {...errorInfo(nodesQ.error)} onRetry={nodesQ.retry} compact /> : undefined}
            />
          </div>
        </TabsPanel>

        <TabsPanel value="activities" data-burrow-scheduler-tab-panel="activities" className="mt-2 min-w-0">
          {actQ.stale && <ErrorState compact {...errorInfo(actQ.error)} onRetry={actQ.retry} />}
          <ActivitiesTable
            activities={actQ.data}
            loading={actQ.loading}
            fetching={actQ.fetching}
            error={actQ.error && !actQ.data ? <ErrorState {...errorInfo(actQ.error)} onRetry={actQ.retry} /> : undefined}
            sorting={actSorting}
            onSortingChange={(s) => patch({ actSort: serializeSorting(s) })}
            columnVisibility={visibilityFromHide(search.actHide, EMPTY_VISIBILITY)}
            onColumnVisibilityChange={(v) => patch({ actHide: hideFromVisibility(v) })}
            nodeId={search.nodeId ?? ""}
            onNodeIdChange={(id) => patch({ nodeId: id || undefined })}
            nodeOptions={(nodesQ.data ?? []).map((n) => n.id)}
            groupBy={search.groupBy ?? ""}
            onGroupByChange={(g) => patch({ groupBy: g === "DIAGNOSTIC" ? "DIAGNOSTIC" : undefined })}
          />
        </TabsPanel>

        <TabsPanel value="health" data-burrow-scheduler-tab-panel="health" className="mt-2 min-w-0">
          {kind === "capacity" ? (
            <HealthTables
              health={isCapacityScheduler(info) ? info.health : undefined}
              aggregates={jmxQ.data ? aggregateCounts(jmxQ.data.beans?.[0]) : undefined}
              aggregateError={jmxQ.error ? errorInfo(jmxQ.error).message : null}
            />
          ) : (
            <StateNote title="Health counters are unavailable for this scheduler">
              Health counters are only reported by the Capacity Scheduler.
            </StateNote>
          )}
        </TabsPanel>

        <TabsPanel
          value="conf"
          data-burrow-scheduler-tab-panel="conf"
          className={cn("mt-2 min-w-0", tab === "conf" && "flex min-h-0 flex-1 flex-col")}
        >
          {kind === "capacity" ? (
            <>
              {confQ.stale && <ErrorState compact {...errorInfo(confQ.error)} onRetry={confQ.retry} />}
              <ConfTable
                properties={confQ.data ?? []}
                showAll={true}
                onShowAllChange={() => undefined}
                loading={confQ.loading}
                error={confQ.error && !confQ.data ? <ErrorState {...errorInfo(confQ.error)} onRetry={confQ.retry} /> : undefined}
                sorting={confSorting}
                onSortingChange={(s) => patch({ confSort: serializeSorting(s) })}
                columnVisibility={visibilityFromHide(search.confHide, EMPTY_VISIBILITY)}
                onColumnVisibilityChange={(v) => patch({ confHide: hideFromVisibility(v) })}
                fit={tab === "conf"}
              />
            </>
          ) : (
            <StateNote title="Configuration is unavailable for this scheduler" tone="warn">
              The ResourceManager exposes scheduler configuration only for the Capacity Scheduler.
            </StateNote>
          )}
        </TabsPanel>
      </TabsRoot>
    </div>
  );
}
