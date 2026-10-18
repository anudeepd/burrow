/**
 * Spark executors — the native replacement for Spark's tracking-UI executor table.
 *
 * Defaults to `/executors` (live executors only); `?all=1` switches to `/allexecutors`, which adds executors Spark has
 * removed. That is exactly Spark's own wording in its UI ("Include dead executors"). Every REST value is stamped inside
 * the row's `<Entity>` with a `spark.executor.*` field id. The summary strip sums across rows, so its values are derived
 * (`spark.executor.derived.*`) and never stamped with a REST key they do not have.
 *
 * Spark omits several fields (removal time/reason, peak metrics, blacklist stages) unless it actually reports them: they
 * render as "—", never as zero.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { CircleCheck, CircleOff } from "lucide-react";
import { useMemo } from "react";
import { cn } from "~/lib/cn";
import { rewriteUpstreamUrl, useUpstreamBases } from "~/lib/upstream-url";
import { fmtBytes, fmtEpoch, fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, Entity } from "~/ui/datum";
import { Switch } from "~/ui/toggles";
import { parseSparkTime } from "../data/format";
import { sp } from "../data/queries";
import type { SparkExecutor } from "../data/schemas";
import { boolParam, compact, matchesQuery, parseColumns, parseSort, serializeColumns, serializeSort } from "../data/search";
import { Metric, MetricStrip, PageHeader } from "../ui/PageHeader";
import { SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { useSpark } from "../ui/context";
import { OptionalTooltip } from "~/ui/tooltip";

const route = getRouteApi("/apps/$appId/spark/executors");

const DEFAULT_VISIBILITY = {
  hostPort: true,
  rddBlocks: true,
  storageMemory: true,
  memoryUsed: true,
  diskUsed: true,
  activeTasks: true,
  completedTasks: true,
  failedTasks: true,
  totalTasks: true,
  totalDuration: true,
  logs: true,
};

/** Sum a numeric REST field across executors; null (→ "—") when Spark reported it for none of them. */
function sumOf(executors: SparkExecutor[], pick: (e: SparkExecutor) => number | null | undefined): number | null {
  let any = false;
  let sum = 0;
  for (const e of executors) {
    const v = pick(e);
    if (v != null) {
      any = true;
      sum += v;
    }
  }
  return any ? sum : null;
}

/** Peak JVM heap (`peakMemoryMetrics.JVMHeapMemory`) is loosely typed upstream; only a real number is a datum. */
function peakJvmHeap(e: SparkExecutor): number | undefined {
  const v = e.peakMemoryMetrics?.JVMHeapMemory;
  return typeof v === "number" ? v : undefined;
}

export function ExecutorsPage() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const tz = usePref("tz");
  const bases = useUpstreamBases();

  const includeDead = boolParam(search.all) === true;
  const q = typeof search.q === "string" ? search.q : "";

  const qExecutors = useQuery(includeDead ? sp.allExecutors(appId, kind, attempt) : sp.executors(appId, kind, attempt));
  const executors = useMemo(() => qExecutors.data ?? [], [qExecutors.data]);
  const filtering = useMemo(() => (q ? executors.filter((e) => matchesQuery([e.id, e.hostPort], q)) : executors), [executors, q]);

  const sorting = parseSort(search);
  const columnVisibility = parseColumns(search);
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  const totalCores = sumOf(executors, (e) => e.totalCores);
  const activeCount = executors.filter((e) => e.isActive === true).length;
  const memoryUsed = sumOf(executors, (e) => e.memoryUsed);
  const shuffleRead = sumOf(executors, (e) => e.totalShuffleRead);
  const shuffleWrite = sumOf(executors, (e) => e.totalShuffleWrite);

  const columns = useMemo<ColDef<SparkExecutor>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        size: 132,
        meta: {
          label: "Executor ID",
          hint: "Spark executor identifier; driver identifies the application driver process.",
          pinned: true,
          exportValue: (e: SparkExecutor) => e.id,
        },
        header: "Executor ID",
        cell: (info) => (
          <Datum field="spark.executor.id" raw={info.row.original.id} className="font-medium">
            {info.row.original.id}
          </Datum>
        ),
      },
      {
        id: "status",
        accessorKey: "isActive",
        sortFn: "basic",
        size: 104,
        meta: {
          label: "Status",
          hint: "Whether Spark still considers this executor active. Include dead executors to inspect removed processes.",
          exportValue: (e: SparkExecutor) => e.isActive,
        },
        header: "Status",
        cell: (info) => {
          const active = info.row.original.isActive;
          const Icon = active ? CircleCheck : CircleOff;
          return (
            <Datum
              field="spark.executor.isActive"
              raw={active}
              fmt="text"
              title={
                active == null
                  ? "Spark did not report executor activity"
                  : active
                    ? "Executor is active"
                    : "Executor is no longer active (removed or lost)"
              }
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 text-micro font-medium",
                active ? "burrow-tone-ok text-(--tone)" : "burrow-tone-idle text-(--tone)",
              )}
            >
              <Icon className="size-3" aria-hidden="true" />
              {active == null ? "Unknown" : active ? "Active" : "Dead"}
            </Datum>
          );
        },
      },
      {
        id: "hostPort",
        accessorKey: "hostPort",
        meta: { label: "Worker Host", exportValue: (e: SparkExecutor) => e.hostPort },
        header: "Worker Host",
        cell: (info) => <Datum field="spark.executor.hostPort" raw={info.row.original.hostPort} className="font-mono text-micro" />,
      },
      {
        id: "rddBlocks",
        accessorKey: "rddBlocks",
        meta: {
          label: "RDD Blocks",
          hint: "Cached data blocks currently held by this executor.",
          align: "end",
          exportValue: (e: SparkExecutor) => e.rddBlocks,
        },
        header: "RDD Blocks",
        cell: (info) => <Datum field="spark.executor.rddBlocks" raw={info.row.original.rddBlocks} fmt="int" className="tnum" />,
      },
      {
        id: "storageMemory",
        enableSorting: false,
        meta: {
          label: "Storage Memory (on-heap / off-heap)",
          hint: "Memory occupied by cached data within and outside the JVM heap.",
          align: "end",
        },
        header: "Storage Memory",
        cell: (info) => {
          const m = info.row.original.memoryMetrics;
          const on = m?.usedOnHeapStorageMemory ?? null;
          const off = m?.usedOffHeapStorageMemory ?? null;
          const total = on == null && off == null ? null : (on ?? 0) + (off ?? 0);
          return (
            <OptionalTooltip label={`on-heap ${fmtBytes(on)} + off-heap ${fmtBytes(off)}${total == null ? "" : ` = ${fmtBytes(total)}`}`}>
              <span className="flex items-center gap-1 tnum">
                <Datum field="spark.executor.memoryMetrics.usedOnHeapStorageMemory" raw={on} fmt="bytes" />
                <span className="text-ink-4">/</span>
                <Datum field="spark.executor.memoryMetrics.usedOffHeapStorageMemory" raw={off} fmt="bytes" className="text-ink-3" />
              </span>
            </OptionalTooltip>
          );
        },
      },
      {
        id: "memoryUsed",
        accessorKey: "memoryUsed",
        meta: {
          label: "Memory Used",
          hint: "Memory occupied by cached data on this executor, rather than total process memory.",
          align: "end",
          exportValue: (e: SparkExecutor) => e.memoryUsed,
        },
        header: "Memory Used",
        cell: (info) => <Datum field="spark.executor.memoryUsed" raw={info.row.original.memoryUsed} fmt="bytes" className="tnum" />,
      },
      {
        id: "onOffHeap",
        enableSorting: false,
        meta: { label: "On Heap / Off Heap (total)", align: "end" },
        header: "On Heap / Off Heap",
        cell: (info) => {
          const m = info.row.original.memoryMetrics;
          return (
            <span className="flex items-center gap-1 tnum">
              <Datum field="spark.executor.memoryMetrics.totalOnHeapStorageMemory" raw={m?.totalOnHeapStorageMemory ?? null} fmt="bytes" />
              <span className="text-ink-4">/</span>
              <Datum
                field="spark.executor.memoryMetrics.totalOffHeapStorageMemory"
                raw={m?.totalOffHeapStorageMemory ?? null}
                fmt="bytes"
                className="text-ink-3"
              />
            </span>
          );
        },
      },
      {
        id: "diskUsed",
        accessorKey: "diskUsed",
        meta: {
          label: "Disk Used",
          hint: "Disk space occupied by cached data on this executor.",
          align: "end",
          exportValue: (e: SparkExecutor) => e.diskUsed,
        },
        header: "Disk Used",
        cell: (info) => <Datum field="spark.executor.diskUsed" raw={info.row.original.diskUsed} fmt="bytes" className="tnum" />,
      },
      {
        id: "activeTasks",
        accessorKey: "activeTasks",
        meta: {
          label: "Active Tasks",
          hint: "Task attempts currently running on this executor.",
          align: "end",
          exportValue: (e: SparkExecutor) => e.activeTasks,
        },
        header: "Active Tasks",
        cell: (info) => <Datum field="spark.executor.activeTasks" raw={info.row.original.activeTasks} fmt="int" className="tnum" />,
      },
      {
        id: "completedTasks",
        accessorKey: "completedTasks",
        meta: { label: "Completed Tasks", align: "end", exportValue: (e: SparkExecutor) => e.completedTasks },
        header: "Completed Tasks",
        cell: (info) => <Datum field="spark.executor.completedTasks" raw={info.row.original.completedTasks} fmt="int" className="tnum" />,
      },
      {
        id: "failedTasks",
        accessorKey: "failedTasks",
        meta: {
          label: "Failed Tasks",
          hint: "Task attempts that failed on this executor. Retries may later succeed elsewhere.",
          align: "end",
          exportValue: (e: SparkExecutor) => e.failedTasks,
        },
        header: "Failed Tasks",
        cell: (info) => <Datum field="spark.executor.failedTasks" raw={info.row.original.failedTasks} fmt="int" className="tnum" />,
      },
      {
        id: "totalTasks",
        accessorKey: "totalTasks",
        meta: { label: "Total Tasks", align: "end", exportValue: (e: SparkExecutor) => e.totalTasks },
        header: "Total Tasks",
        cell: (info) => <Datum field="spark.executor.totalTasks" raw={info.row.original.totalTasks} fmt="int" className="tnum" />,
      },
      {
        id: "totalDuration",
        accessorKey: "totalDuration",
        meta: {
          label: "Total Duration",
          hint: "Total execution time summed across task attempts on this executor.",
          align: "end",
          exportValue: (e: SparkExecutor) => e.totalDuration,
        },
        header: "Total Duration",
        cell: (info) => (
          <Datum field="spark.executor.totalDuration" raw={info.row.original.totalDuration} fmt="dur" className="tnum whitespace-nowrap" />
        ),
      },
      {
        id: "totalGCTime",
        accessorKey: "totalGCTime",
        meta: { label: "Total GC Time", align: "end", exportValue: (e: SparkExecutor) => e.totalGCTime },
        header: "Total GC Time",
        cell: (info) => (
          <Datum field="spark.executor.totalGCTime" raw={info.row.original.totalGCTime} fmt="dur" className="tnum whitespace-nowrap" />
        ),
      },
      {
        id: "totalInputBytes",
        accessorKey: "totalInputBytes",
        meta: { label: "Total Input", align: "end", exportValue: (e: SparkExecutor) => e.totalInputBytes },
        header: "Total Input",
        cell: (info) => (
          <Datum field="spark.executor.totalInputBytes" raw={info.row.original.totalInputBytes} fmt="bytes" className="tnum" />
        ),
      },
      {
        id: "totalShuffleRead",
        accessorKey: "totalShuffleRead",
        meta: { label: "Total Shuffle Read", align: "end", exportValue: (e: SparkExecutor) => e.totalShuffleRead },
        header: "Total Shuffle Read",
        cell: (info) => (
          <Datum field="spark.executor.totalShuffleRead" raw={info.row.original.totalShuffleRead} fmt="bytes" className="tnum" />
        ),
      },
      {
        id: "totalShuffleWrite",
        accessorKey: "totalShuffleWrite",
        meta: { label: "Total Shuffle Write", align: "end", exportValue: (e: SparkExecutor) => e.totalShuffleWrite },
        header: "Total Shuffle Write",
        cell: (info) => (
          <Datum field="spark.executor.totalShuffleWrite" raw={info.row.original.totalShuffleWrite} fmt="bytes" className="tnum" />
        ),
      },
      {
        id: "maxMemory",
        accessorKey: "maxMemory",
        meta: { label: "Max Memory", align: "end", exportValue: (e: SparkExecutor) => e.maxMemory },
        header: "Max Memory",
        cell: (info) => <Datum field="spark.executor.maxMemory" raw={info.row.original.maxMemory} fmt="bytes" className="tnum" />,
      },
      {
        id: "peakJvmHeap",
        sortFn: "basic",
        accessorFn: (e) => peakJvmHeap(e) ?? -1,
        meta: { label: "Peak JVM Heap", align: "end", exportValue: (e: SparkExecutor) => peakJvmHeap(e) },
        header: "Peak JVM Heap",
        cell: (info) => (
          <Datum field="spark.executor.peakMemoryMetrics.JVMHeapMemory" raw={peakJvmHeap(info.row.original)} fmt="bytes" className="tnum" />
        ),
      },
      {
        id: "blacklisted",
        accessorKey: "isBlacklisted",
        sortFn: "basic",
        meta: { label: "Blacklisted", exportValue: (e: SparkExecutor) => e.isBlacklisted },
        header: "Blacklisted",
        cell: (info) => {
          const e = info.row.original;
          const stages = e.blacklistedInStages ?? [];
          return (
            <span className="flex items-center gap-1.5">
              <Datum
                field="spark.executor.isBlacklisted"
                raw={e.isBlacklisted}
                fmt="text"
                className={e.isBlacklisted ? "burrow-tone-warn font-medium text-(--tone)" : "text-ink-4"}
              >
                {e.isBlacklisted == null ? "—" : e.isBlacklisted ? "Yes" : "No"}
              </Datum>
              {stages.length > 0 && (
                <Datum
                  field="spark.executor.blacklistedInStages"
                  raw={stages}
                  fmt="text"
                  className="text-warn"
                  title={`Blacklisted in stages ${stages.join(", ")}`}
                >
                  ({stages.length} stages)
                </Datum>
              )}
            </span>
          );
        },
      },
      {
        id: "totalCores",
        accessorKey: "totalCores",
        meta: {
          label: "Cores",
          align: "end",
          defaultVisible: false,
          hint: "CPU cores allocated to this executor.",
          exportValue: (e: SparkExecutor) => e.totalCores,
        },
        header: "Cores",
        cell: ({ row }) => <Datum field="spark.executor.totalCores" raw={row.original.totalCores} fmt="int" />,
      },
      {
        id: "maxTasks",
        accessorKey: "maxTasks",
        meta: {
          label: "Task slots",
          align: "end",
          defaultVisible: false,
          hint: "Maximum concurrent tasks, based on executor cores and each task's CPU requirement.",
          exportValue: (e: SparkExecutor) => e.maxTasks,
        },
        header: "Task slots",
        cell: ({ row }) => <Datum field="spark.executor.maxTasks" raw={row.original.maxTasks} fmt="int" />,
      },
      {
        id: "addTime",
        accessorFn: (e) => parseSparkTime(e.addTime),
        meta: { label: "Added", defaultVisible: false, exportValue: (e: SparkExecutor) => e.addTime },
        header: "Added",
        cell: ({ row }) => (
          <Datum field="spark.executor.addTime" raw={row.original.addTime}>
            {fmtEpoch(parseSparkTime(row.original.addTime), tz)}
          </Datum>
        ),
      },
      {
        id: "logs",
        enableSorting: false,
        meta: {
          label: "Logs",
          hint: "Log files reported by Spark for this executor. Links open the NodeManager or configured log service.",
        },
        header: "Logs",
        cell: ({ row }) => {
          const logs = Object.entries(row.original.executorLogs ?? {});
          return logs.length === 0 ? (
            <span className="text-ink-4">—</span>
          ) : (
            <span className="flex flex-wrap gap-2">
              {logs.map(([file, url]) => (
                <a
                  key={file}
                  href={rewriteUpstreamUrl(url, bases).href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-live hover:underline"
                >
                  <Datum field={`spark.executor.executorLogs.${file}`} raw={url}>
                    {file}
                  </Datum>
                </a>
              ))}
            </span>
          );
        },
      },
      {
        id: "excluded",
        accessorKey: "isExcluded",
        meta: {
          label: "Excluded",
          defaultVisible: false,
          hint: "Spark can exclude an executor globally or for specific stages after repeated failures.",
          exportValue: (e: SparkExecutor) => e.isExcluded,
        },
        header: "Excluded",
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            <Datum field="spark.executor.isExcluded" raw={row.original.isExcluded}>
              {row.original.isExcluded == null ? "—" : row.original.isExcluded ? "Yes" : "No"}
            </Datum>
            {(row.original.excludedInStages?.length ?? 0) > 0 && (
              <Datum field="spark.executor.excludedInStages" raw={row.original.excludedInStages}>
                stages {row.original.excludedInStages?.join(", ")}
              </Datum>
            )}
          </span>
        ),
      },
      {
        id: "resourceProfileId",
        accessorKey: "resourceProfileId",
        meta: {
          label: "Resource profile",
          defaultVisible: false,
          hint: "The resource request profile used when Spark allocated this executor.",
          exportValue: (e: SparkExecutor) => e.resourceProfileId,
        },
        header: "Resource profile",
        cell: ({ row }) => <Datum field="spark.executor.resourceProfileId" raw={row.original.resourceProfileId} fmt="id" />,
      },
      ...(["peakMemoryMetrics", "resources", "attributes"] as const).map(
        (key): ColDef<SparkExecutor> => ({
          id: key,
          enableSorting: false,
          meta: {
            label: key === "peakMemoryMetrics" ? "Peak memory metrics" : key === "resources" ? "Resources" : "Attributes",
            defaultVisible: false,
            exportValue: (e: SparkExecutor) => (e[key] == null ? null : JSON.stringify(e[key])),
          },
          header: key === "peakMemoryMetrics" ? "Peak memory metrics" : key === "resources" ? "Resources" : "Attributes",
          cell: ({ row }) => (
            <Datum field={`spark.executor.${key}`} raw={row.original[key]} className="font-mono text-micro break-all">
              {row.original[key] == null ? "—" : JSON.stringify(row.original[key])}
            </Datum>
          ),
        }),
      ),
      {
        id: "removal",
        enableSorting: false,
        meta: { label: "Removed (dead executors only)" },
        header: "Removed",
        cell: (info) => {
          const e = info.row.original;
          if (e.removeTime == null && e.removeReason == null) {
            return (
              <OptionalTooltip label={"Spark reports removeTime / removeReason only once an executor has been removed"}>
                <span className="text-ink-4">—</span>
              </OptionalTooltip>
            );
          }
          return (
            <span className="flex min-w-0 flex-col">
              {e.removeTime != null && (
                <Datum field="spark.executor.removeTime" raw={e.removeTime} fmt="text" className="whitespace-nowrap text-ink-3">
                  {fmtEpoch(parseSparkTime(e.removeTime), tz)}
                </Datum>
              )}
              {e.removeReason != null && (
                <Datum
                  field="spark.executor.removeReason"
                  raw={e.removeReason}
                  className="truncate text-micro text-ink-4"
                  title={e.removeReason}
                />
              )}
            </span>
          );
        },
      },
    ],
    [tz, bases],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="Executors" hideTitle>
        <div className="flex items-center gap-2 text-small text-ink-3">
          <Switch checked={includeDead} onCheckedChange={(v) => patch({ all: v ? "1" : undefined })} label="Include dead executors" />
          <span>Include dead executors</span>
        </div>
        <label className="flex items-center gap-1.5 text-small text-ink-3">
          <span className="sr-only">Filter executors by id or host</span>
          <input
            type="search"
            value={q}
            onChange={(e) => patch({ q: e.target.value || undefined })}
            placeholder="Filter id / host…"
            className="h-(--ctl-h) w-48 rounded-md border border-seam-strong bg-well px-2 text-body text-ink placeholder:text-ink-4"
          />
        </label>
      </PageHeader>

      {!qExecutors.isPending && !qExecutors.error && executors.length > 0 && (
        <Entity id="_" className="shrink-0">
          <MetricStrip>
            <Metric label={includeDead ? "Executors (incl. dead)" : "Live executors"}>
              <Datum field="spark.executor.derived.count" raw={executors.length} fmt="int" />
            </Metric>
            <Metric label="Active executors">
              <Datum field="spark.executor.derived.activeCount" raw={activeCount} fmt="int" />
            </Metric>
            <Metric label="Total cores">
              <Datum field="spark.executor.derived.totalCoresSum" raw={totalCores} fmt="int" />
            </Metric>
            <Metric label="Memory used">
              <Datum field="spark.executor.derived.memoryUsedSum" raw={memoryUsed} fmt="bytes" />
            </Metric>
            <Metric label="Shuffle read / write">
              <Datum field="spark.executor.derived.totalShuffleReadSum" raw={shuffleRead} fmt="bytes" />
              {" / "}
              <Datum field="spark.executor.derived.totalShuffleWriteSum" raw={shuffleWrite} fmt="bytes" />
            </Metric>
          </MetricStrip>
        </Entity>
      )}

      {qExecutors.error && qExecutors.data !== undefined && (
        <SparkStaleErrorBanner error={qExecutors.error} subject="the executor list" onRetry={() => void qExecutors.refetch()} />
      )}
      {qExecutors.isPending ? (
        <SparkLoading rows={6} cols={10} />
      ) : qExecutors.error && qExecutors.data === undefined ? (
        <SparkFailureState error={qExecutors.error} subject="the executor list" onRetry={() => void qExecutors.refetch()} />
      ) : executors.length === 0 ? (
        <SparkEmpty title="No executors reported">
          {includeDead
            ? "Spark knows no executor for this application yet."
            : "Turn on “Include dead executors” to see executors Spark has already removed."}
        </SparkEmpty>
      ) : (
        <DataTable<SparkExecutor>
          className="min-h-[24rem]"
          data={filtering}
          columns={columns}
          getRowId={(e) => e.id}
          entityKey={(e) => e.id}
          label="Spark executors"
          storageKey="spark-executors"
          sorting={sorting}
          onSortingChange={(s: SortingState) => patch(serializeSort(s))}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={DEFAULT_VISIBILITY}
          rowVersion={(e) => `${e.isActive}:${e.activeTasks ?? 0}:${e.memoryUsed ?? 0}`}
          totalCount={executors.length}
          exportName={`spark-executors-${appId}`}
          toolbar={
            <span className="text-small text-ink-4">
              {filtering.length === executors.length ? (
                <>{fmtInt(executors.length)} shown</>
              ) : (
                <>
                  {fmtInt(filtering.length)} of {fmtInt(executors.length)}
                </>
              )}
            </span>
          }
        />
      )}
    </div>
  );
}
