/**
 * Streaming — the native replacement for Spark's `/streaming/` tab.
 *
 * Spark only serves `/streaming/*` for Spark Streaming (DStream) applications; everything else (batch jobs, and in this
 * API also Structured Streaming, whose query statistics Spark renders as HTML) answers 404. That 404 is Spark's own, so
 * it is rendered as the deliberate "not a streaming application" state — never confused with the backend-missing case,
 * which `classifySparkError` handles (`unknown API group`).
 *
 * When `/streaming/statistics` exists the page shows the statistics strip, the per-batch series (a line per REST key over
 * `batchTime`), the batch table over the newest `?size=` batches and the receiver table with its inline rate trend.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { fmtDuration, fmtEpoch, fmtInt, fmtRelative } from "~/lib/format";
import { useInView } from "~/lib/in-view";
import { usePref } from "~/state/prefs";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, Entity } from "~/ui/datum";
import { Select } from "~/ui/select";
import { cn } from "~/lib/cn";
import { compact, intParam, parseColumns, parseSort, serializeColumns, serializeSort, strParam } from "../data/search";
import { parseSparkTime } from "../data/format";
import { sp } from "../data/queries";
import type { SparkStreamingBatch, SparkStreamingReceiver } from "../data/schemas";
import { CountsCell } from "../ui/Counts";
import { classifySparkError } from "../ui/errors";
import { Metric, MetricStrip, PageHeader } from "../ui/PageHeader";
import { SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { BatchMetricCharts, batchTimeOf, ReceiverTrend } from "../ui/StreamingCharts";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";
import { OptionalTooltip } from "~/ui/tooltip";

const route = getRouteApi("/apps/$appId/spark/streaming");

const DEFAULT_SIZE = 200;

/** `batch.status` is one of these in Spark's `BatchInfo`; the raw value is stamped either way. */
const BATCH_TONES: Record<string, "ok" | "live" | "wait" | "fail" | "idle"> = {
  COMPLETED: "ok",
  PROCESSING: "live",
  QUEUED: "wait",
  FAILED: "fail",
};

/** Hide optional receiver columns Spark leaves empty for a particular receiver kind. */
const RECEIVER_OPTIONAL_COLUMNS: Record<string, (r: SparkStreamingReceiver) => boolean> = {
  active: (r) => r.isActive != null,
  executor: (r) => r.executorId != null || r.executorHost != null,
  receiverSchedulerDelay: (r) => r.schedulerDelay != null,
  lastError: (r) => r.lastErrorTime != null || r.lastErrorMessage != null || r.lastError != null,
};

const BATCH_DEFAULT_VISIBILITY = {
  batchId: true,
  batchTime: true,
  status: true,
  inputSize: true,
  schedulingDelay: true,
  processingTime: true,
  totalDelay: true,
  outputOps: true,
};
const RECEIVER_DEFAULT_VISIBILITY = { streamId: true, streamName: true, avgEventRate: true, trend: true, active: true };

/**
 * The newest-batch marker. Uses the house `burrow-dot-pulse` loop (token-gated for reduced motion/parity) instead of
 * Tailwind's `animate-pulse`, which no gate here reaches, and keys the loop to visibility like every other loop.
 */
function LiveBatchDot() {
  const [ref, visible] = useInView<HTMLSpanElement>();
  return (
    <span
      ref={ref}
      data-visible={visible}
      aria-hidden="true"
      className="burrow-dot-pulse relative size-1.5 shrink-0 rounded-full bg-(--tone)"
    />
  );
}

export function StreamingPage() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const now = useNow();
  const tz = usePref("tz");

  // No retry: Spark's 404 for a non-streaming application is a definitive answer, and the honest state should appear
  // immediately instead of after three backoff attempts.
  const statsQ = useQuery({ ...sp.streamingStatistics(appId, kind, attempt), retry: false });
  const failure = statsQ.error ? classifySparkError(statsQ.error, "the streaming statistics") : null;
  /** Spark's own 404 for a non-streaming app — distinct from `backend-missing` ("unknown API group"). */
  const notStreaming = failure?.kind === "not-found";
  const streaming = statsQ.isSuccess && statsQ.data != null;

  // Only ask for the batch/receiver lists once Spark has confirmed there is a streaming listener.
  const batchesQ = useQuery({ ...sp.streamingBatches(appId, kind, attempt), enabled: streaming });
  const receiversQ = useQuery({ ...sp.streamingReceivers(appId, kind, attempt), enabled: streaming });

  const stats = statsQ.data;
  const size = Math.max(1, intParam(search.size, DEFAULT_SIZE) ?? DEFAULT_SIZE);
  const statusFilter = strParam(search.status);
  const allBatches = useMemo(() => batchesQ.data ?? [], [batchesQ.data]);
  /** Spark returns batches newest-first; the window is the newest `size` rows. */
  const windowed = useMemo(() => allBatches.slice(0, size), [allBatches, size]);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const b of windowed) if (b.status) set.add(b.status);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [windowed]);

  const batches = useMemo(() => (statusFilter ? windowed.filter((b) => b.status === statusFilter) : windowed), [windowed, statusFilter]);

  const newestId = useMemo(() => windowed.reduce<number | null>((m, b) => (m == null || b.batchId > m ? b.batchId : m), null), [windowed]);
  const newest = useMemo(() => windowed.find((b) => b.batchId === newestId), [windowed, newestId]);
  const newestTime = newest ? batchTimeOf(newest) : null;

  const receivers = receiversQ.data ?? [];

  const [sizeDraft, setSizeDraft] = useState<string | null>(null);

  const sorting = parseSort(search);
  const columnVisibility = parseColumns(search);
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  const batchColumns = useMemo<ColDef<SparkStreamingBatch>[]>(
    () => [
      {
        id: "batchId",
        accessorKey: "batchId",
        size: 88,
        meta: { label: "Batch id", pinned: true, align: "start", exportValue: (b: SparkStreamingBatch) => b.batchId },
        header: "Batch id",
        cell: (info) => {
          const b = info.row.original;
          const t = batchTimeOf(b);
          return (
            <OptionalTooltip label={t != null ? fmtEpoch(t, tz) : undefined}>
              <span className="font-mono text-micro">
                <Datum field="spark.streaming.batches.batchId" raw={b.batchId} fmt="int" />
              </span>
            </OptionalTooltip>
          );
        },
      },
      {
        id: "batchTime",
        accessorFn: (b) => batchTimeOf(b) ?? -1,
        sortFn: "basic",
        size: 158,
        meta: { label: "Batch time", exportValue: (b: SparkStreamingBatch) => b.batchTime },
        header: "Batch time",
        cell: (info) => {
          const b = info.row.original;
          return (
            <Datum field="spark.streaming.batches.batchTime" raw={b.batchTime} fmt="text" className="whitespace-nowrap text-ink-3">
              {fmtEpoch(parseSparkTime(b.batchTime), tz)}
            </Datum>
          );
        },
      },
      {
        id: "status",
        accessorKey: "status",
        meta: { label: "Status", exportValue: (b: SparkStreamingBatch) => b.status },
        header: "Status",
        cell: (info) => {
          const b = info.row.original;
          const tone = BATCH_TONES[b.status ?? ""] ?? "idle";
          const live = b.batchId === newestId && b.status !== "COMPLETED";
          return (
            <OptionalTooltip label={live ? "Newest batch — Spark has not completed it yet" : undefined}>
              <span
                className={cn("burrow-pill inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-caption", `burrow-tone-${tone}`)}
              >
                {live && <LiveBatchDot />}
                <Datum field="spark.streaming.batches.status" raw={b.status} />
              </span>
            </OptionalTooltip>
          );
        },
      },
      {
        id: "batchDuration",
        accessorKey: "batchDuration",
        sortFn: "basic",
        meta: { label: "Batch interval", align: "end", exportValue: (b: SparkStreamingBatch) => b.batchDuration },
        header: "Batch interval",
        cell: (info) => <Datum field="spark.streaming.batches.batchDuration" raw={info.row.original.batchDuration} fmt="ms" />,
      },
      {
        id: "inputSize",
        accessorKey: "inputSize",
        sortFn: "basic",
        meta: {
          label: "Input records",
          hint: "Number of records received in this batch; Spark inputSize is a record count.",
          align: "end",
          exportValue: (b: SparkStreamingBatch) => b.inputSize,
        },
        header: "Input records",
        cell: (info) => <Datum field="spark.streaming.batches.inputSize" raw={info.row.original.inputSize} fmt="int" />,
      },
      {
        id: "schedulingDelay",
        accessorKey: "schedulingDelay",
        sortFn: "basic",
        meta: { label: "Scheduling delay", align: "end", exportValue: (b: SparkStreamingBatch) => b.schedulingDelay },
        header: "Scheduling delay",
        cell: (info) => <Datum field="spark.streaming.batches.schedulingDelay" raw={info.row.original.schedulingDelay} fmt="ms" />,
      },
      {
        id: "processingTime",
        accessorKey: "processingTime",
        sortFn: "basic",
        meta: { label: "Processing time", align: "end", exportValue: (b: SparkStreamingBatch) => b.processingTime },
        header: "Processing time",
        cell: (info) => <Datum field="spark.streaming.batches.processingTime" raw={info.row.original.processingTime} fmt="ms" />,
      },
      {
        id: "totalDelay",
        accessorKey: "totalDelay",
        sortFn: "basic",
        meta: { label: "Total delay", align: "end", exportValue: (b: SparkStreamingBatch) => b.totalDelay },
        header: "Total delay",
        cell: (info) => <Datum field="spark.streaming.batches.totalDelay" raw={info.row.original.totalDelay} fmt="ms" />,
      },
      {
        id: "outputOps",
        enableSorting: false,
        meta: { label: "Output ops (active / completed / failed)" },
        header: "Output ops",
        cell: (info) => {
          const b = info.row.original;
          return (
            <CountsCell
              counts={[
                { field: "spark.streaming.batches.numActiveOutputOps", raw: b.numActiveOutputOps, tone: "live", label: "active" },
                { field: "spark.streaming.batches.numCompletedOutputOps", raw: b.numCompletedOutputOps, tone: "ok", label: "completed" },
                { field: "spark.streaming.batches.numFailedOutputOps", raw: b.numFailedOutputOps, tone: "fail", label: "failed" },
              ]}
            />
          );
        },
      },
    ],
    [newestId, tz],
  );

  const receiverColumns = useMemo<ColDef<SparkStreamingReceiver>[]>(() => {
    const columns: ColDef<SparkStreamingReceiver>[] = [
      {
        id: "streamId",
        accessorKey: "streamId",
        enableSorting: false,
        size: 88,
        meta: { label: "Stream id", pinned: true, align: "start", exportValue: (r: SparkStreamingReceiver) => r.streamId },
        header: "Stream id",
        cell: (info) => <Datum field="spark.streaming.receivers.streamId" raw={info.row.original.streamId} fmt="int" />,
      },
      {
        id: "streamName",
        accessorKey: "streamName",
        enableSorting: false,
        size: 200,
        meta: { label: "Stream name", exportValue: (r: SparkStreamingReceiver) => r.streamName },
        header: "Stream name",
        cell: (info) => <Datum field="spark.streaming.receivers.streamName" raw={info.row.original.streamName} className="truncate" />,
      },
      {
        id: "avgEventRate",
        accessorKey: "avgEventRate",
        enableSorting: false,
        meta: { label: "Avg event rate", align: "end", exportValue: (r: SparkStreamingReceiver) => r.avgEventRate },
        header: "Avg event rate",
        cell: (info) => {
          const r = info.row.original;
          return (
            <span className="flex items-baseline justify-end gap-1">
              <Datum field="spark.streaming.receivers.avgEventRate" raw={r.avgEventRate} fmt="int" />
              {r.avgEventRateUnit && (
                <Datum field="spark.streaming.receivers.avgEventRateUnit" raw={r.avgEventRateUnit} className="text-micro text-ink-4" />
              )}
            </span>
          );
        },
      },
      {
        id: "trend",
        enableSorting: false,
        meta: { label: "Event rate trend" },
        header: "Trend",
        cell: (info) => <ReceiverTrend receiver={info.row.original} />,
      },
      {
        id: "active",
        enableSorting: false,
        meta: { label: "Active", exportValue: (r: SparkStreamingReceiver) => r.isActive },
        header: "Active",
        cell: (info) => {
          const v = info.row.original.isActive;
          return (
            <Datum
              field="spark.streaming.receivers.isActive"
              raw={v}
              className={v === true ? "text-ok" : v === false ? "text-ink-3" : "text-ink-4"}
            >
              {v == null ? "—" : v ? "Active" : "Inactive"}
            </Datum>
          );
        },
      },
      {
        id: "executor",
        enableSorting: false,
        meta: { label: "Executor" },
        header: "Executor",
        cell: (info) => {
          const r = info.row.original;
          if (!r.executorId && !r.executorHost) return <span className="text-ink-4">—</span>;
          return (
            <span className="flex min-w-0 flex-col">
              {r.executorId && (
                <Datum
                  field="spark.streaming.receivers.executorId"
                  raw={r.executorId}
                  className="truncate font-mono text-micro"
                  title={r.executorId}
                />
              )}
              {r.executorHost && (
                <Datum
                  field="spark.streaming.receivers.executorHost"
                  raw={r.executorHost}
                  className="truncate text-micro text-ink-4"
                  title={r.executorHost}
                />
              )}
            </span>
          );
        },
      },
      {
        id: "receiverSchedulerDelay",
        accessorKey: "schedulerDelay",
        enableSorting: false,
        meta: { label: "Scheduler delay", align: "end", exportValue: (r: SparkStreamingReceiver) => r.schedulerDelay },
        header: "Scheduler delay",
        cell: (info) => <Datum field="spark.streaming.receivers.schedulerDelay" raw={info.row.original.schedulerDelay} fmt="ms" />,
      },
      {
        id: "lastError",
        enableSorting: false,
        meta: { label: "Last error" },
        header: "Last error",
        cell: (info) => {
          const r = info.row.original;
          if (!r.lastErrorTime && !r.lastErrorMessage && !r.lastError) return <span className="text-ink-4">—</span>;
          const t = parseSparkTime(r.lastErrorTime);
          return (
            <span className="flex min-w-0 flex-col">
              {r.lastErrorTime && (
                <Datum field="spark.streaming.receivers.lastErrorTime" raw={r.lastErrorTime} fmt="text" className="text-ink-3">
                  {fmtEpoch(t, tz)}
                </Datum>
              )}
              {r.lastErrorMessage && (
                <Datum
                  field="spark.streaming.receivers.lastErrorMessage"
                  raw={r.lastErrorMessage}
                  className="truncate text-micro text-fail"
                />
              )}
              {!r.lastErrorMessage && r.lastError && (
                <Datum field="spark.streaming.receivers.lastError" raw={r.lastError} className="truncate text-micro text-fail" />
              )}
            </span>
          );
        },
      },
    ];
    // Keep the full table shape while loading or when no receivers are present. Once Spark returns rows, omit optional
    // columns that are missing from every receiver rather than filling the table with dashes.
    if (receivers.length === 0) return columns;
    return columns.filter((column) => {
      const hasValue = column.id == null ? undefined : RECEIVER_OPTIONAL_COLUMNS[column.id];
      return hasValue == null || receivers.some(hasValue);
    });
  }, [receivers, tz]);

  if (statsQ.isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <PageHeader title="Streaming" hideTitle />
        <SparkLoading rows={6} cols={6} />
      </div>
    );
  }

  if (notStreaming) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <PageHeader title="Streaming" hideTitle />
        <SparkEmpty title="Not a streaming application">
          Spark Streaming metrics apply to DStream applications. Structured Streaming queries appear on the SQL page.
        </SparkEmpty>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <PageHeader title="Streaming" hideTitle />
        <SparkFailureState error={statsQ.error} subject="the streaming statistics" onRetry={() => void statsQ.refetch()} />
      </div>
    );
  }

  const batchesLoading = batchesQ.isPending;
  const batchesError = batchesQ.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {statsQ.error && (
        <SparkStaleErrorBanner error={statsQ.error} subject="the streaming statistics" onRetry={() => void statsQ.refetch()} />
      )}
      <PageHeader title="Streaming" hideTitle>
        {kind === "live" && newestTime != null && newestId != null && (
          <Entity id={String(newestId)} as="span" className="text-small text-ink-3 tnum">
            newest batch{" "}
            <Datum field="spark.streaming.batches.batchTime" raw={newest?.batchTime} fmt="text">
              {fmtRelative(newestTime, now)}
            </Datum>
          </Entity>
        )}
      </PageHeader>

      <Entity id="_">
        <MetricStrip>
          <Metric label="Start time">
            <Datum field="spark.streaming.startTime" raw={stats.startTime} fmt="text">
              {fmtEpoch(parseSparkTime(stats.startTime), tz)}
            </Datum>
          </Metric>
          <Metric label="Batch interval" hint="Spark's batchDuration">
            <Datum field="spark.streaming.batchDuration" raw={stats.batchDuration} fmt="ms">
              {fmtDuration(stats.batchDuration)}
            </Datum>
          </Metric>
          <Metric label="Receivers (total / active / inactive)" hint="numReceivers / numActiveReceivers / numInactiveReceivers">
            <CountsCell
              counts={[
                { field: "spark.streaming.numReceivers", raw: stats.numReceivers, tone: "idle", label: "total" },
                { field: "spark.streaming.numActiveReceivers", raw: stats.numActiveReceivers, tone: "live", label: "active" },
                { field: "spark.streaming.numInactiveReceivers", raw: stats.numInactiveReceivers, tone: "wait", label: "inactive" },
              ]}
            />
          </Metric>
          <Metric
            label="Batches (completed / retained / active)"
            hint="numTotalCompletedBatches / numRetainedCompletedBatches / numActiveBatches"
          >
            <CountsCell
              counts={[
                { field: "spark.streaming.numTotalCompletedBatches", raw: stats.numTotalCompletedBatches, tone: "ok", label: "completed" },
                {
                  field: "spark.streaming.numRetainedCompletedBatches",
                  raw: stats.numRetainedCompletedBatches,
                  tone: "idle",
                  label: "retained",
                },
                { field: "spark.streaming.numActiveBatches", raw: stats.numActiveBatches, tone: "live", label: "active" },
              ]}
            />
          </Metric>
          <Metric label="Records (processed / received)" hint="numProcessedRecords / numReceivedRecords">
            <CountsCell
              counts={[
                { field: "spark.streaming.numProcessedRecords", raw: stats.numProcessedRecords, tone: "ok", label: "processed" },
                { field: "spark.streaming.numReceivedRecords", raw: stats.numReceivedRecords, tone: "idle", label: "received" },
              ]}
            />
          </Metric>
          <Metric label="Avg input rate" hint="avgInputRate — records received per second, as Spark reports it">
            <Datum field="spark.streaming.avgInputRate" raw={stats.avgInputRate} fmt="int" />
          </Metric>
          <Metric label="Avg scheduling delay">
            <Datum field="spark.streaming.avgSchedulingDelay" raw={stats.avgSchedulingDelay} fmt="ms">
              {fmtDuration(stats.avgSchedulingDelay)}
            </Datum>
          </Metric>
          <Metric label="Avg processing time">
            <Datum field="spark.streaming.avgProcessingTime" raw={stats.avgProcessingTime} fmt="ms">
              {fmtDuration(stats.avgProcessingTime)}
            </Datum>
          </Metric>
          <Metric label="Avg total delay">
            <Datum field="spark.streaming.avgTotalDelay" raw={stats.avgTotalDelay} fmt="ms">
              {fmtDuration(stats.avgTotalDelay)}
            </Datum>
          </Metric>
        </MetricStrip>
      </Entity>

      <section aria-label="Batch metrics over time" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-body font-semibold text-ink">Statistics over time</h3>
        </div>
        {batchesLoading ? (
          <SparkLoading rows={3} cols={2} />
        ) : batchesError && batchesQ.data === undefined ? (
          <SparkFailureState error={batchesError} subject="the streaming batches" onRetry={() => void batchesQ.refetch()} />
        ) : (
          <>
            {batchesError && (
              <SparkStaleErrorBanner error={batchesError} subject="the streaming batches" onRetry={() => void batchesQ.refetch()} />
            )}
            <BatchMetricCharts batches={windowed} />
          </>
        )}
      </section>

      <section aria-label="Streaming batches" className="flex min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-body font-semibold text-ink">Batches</h3>
        </div>
        <DataTable<SparkStreamingBatch>
          className="min-h-[24rem]"
          data={batches}
          columns={batchColumns}
          getRowId={(b) => String(b.batchId)}
          entityKey={(b) => String(b.batchId)}
          label="Streaming batches"
          storageKey="spark-streaming-batches"
          sorting={sorting}
          onSortingChange={(s: SortingState) => patch(serializeSort(s))}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={BATCH_DEFAULT_VISIBILITY}
          rowVersion={(b) => `${b.status}:${b.processingTime ?? -1}:${b.numCompletedOutputOps ?? -1}`}
          totalCount={allBatches.length}
          loading={batchesLoading}
          error={
            batchesError && batchesQ.data === undefined ? (
              <SparkFailureState error={batchesError} subject="the streaming batches" onRetry={() => void batchesQ.refetch()} />
            ) : undefined
          }
          empty={
            <SparkEmpty title={statusFilter ? `No ${statusFilter.toLowerCase()} batches` : "No batches recorded"}>
              Spark's batch queue is empty for this application.
            </SparkEmpty>
          }
          exportName={`spark-streaming-batches-${appId}`}
          toolbar={
            <>
              <Select
                label="Batch status filter"
                value={statusFilter ?? ""}
                onValueChange={(v) => patch({ status: v === "" ? undefined : v })}
                options={[{ value: "", label: "All statuses" }, ...statuses.map((s) => ({ value: s, label: s }))]}
              />
              <label className="flex items-center gap-1.5 text-small text-ink-3">
                <span className="whitespace-nowrap">Newest batches</span>
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={sizeDraft ?? String(size)}
                  onChange={(e) => {
                    setSizeDraft(e.target.value);
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) patch({ size: Math.trunc(n) === DEFAULT_SIZE ? undefined : String(Math.trunc(n)) });
                  }}
                  onBlur={() => setSizeDraft(null)}
                  aria-label="How many of the newest batches to load"
                  className="h-(--ctl-h) w-20 rounded-md border border-seam-strong bg-well px-2 text-body text-ink tnum"
                />
              </label>
              <span className="text-small text-ink-4">
                {batches.length === windowed.length ? (
                  <>{fmtInt(windowed.length)} shown</>
                ) : (
                  <>
                    {fmtInt(batches.length)} of {fmtInt(windowed.length)} shown
                  </>
                )}
              </span>
            </>
          }
        />
      </section>

      <section aria-label="Streaming receivers" className="flex min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-body font-semibold text-ink">Receivers</h3>
        </div>
        {receiversQ.error && receiversQ.data !== undefined && (
          <SparkStaleErrorBanner error={receiversQ.error} subject="the streaming receivers" onRetry={() => void receiversQ.refetch()} />
        )}
        <DataTable<SparkStreamingReceiver>
          className="min-h-[24rem]"
          data={receivers}
          columns={receiverColumns}
          getRowId={(r) => String(r.streamId ?? r.streamName ?? "receiver")}
          entityKey={(r) => String(r.streamId ?? r.streamName ?? "receiver")}
          label="Streaming receivers"
          storageKey="spark-streaming-receivers"
          sorting={[]}
          onSortingChange={() => undefined}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={RECEIVER_DEFAULT_VISIBILITY}
          loading={receiversQ.isPending}
          error={
            receiversQ.error && receiversQ.data === undefined ? (
              <SparkFailureState error={receiversQ.error} subject="the streaming receivers" onRetry={() => void receiversQ.refetch()} />
            ) : undefined
          }
          empty={
            <SparkEmpty title="No receivers">
              Spark reported no receivers; a receiver-less streaming job reads from a queue or custom source.
            </SparkEmpty>
          }
          totalCount={receivers.length}
          exportName={`spark-streaming-receivers-${appId}`}
        />
      </section>
    </div>
  );
}
