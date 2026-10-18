/**
 * Spark stage detail — the native replacement for `/stages/stage/?id=N&attempt=M`: the stage's metrics, its RDD graph
 * (DagViz), the task-distribution summary and the task table.
 *
 * Sources: `/stages/{id}/{attempt}?details=true&withSummaries=true&quantiles=…` (task metrics distributions + executor
 * peak-memory distributions), `/stages/{id}` (one entry per attempt, for the attempt selector), `/taskSummary` (fallback
 * when the stage payload carries no distributions) and `/taskList` (whole list, or server-paged by `?size`/`?page`).
 *
 * Spark returns task aggregates only for stages that ran tasks: skipped/reused stages answer `taskSummary` with 404
 * ("No tasks reported metrics …") and their `taskList` is empty. Both cases are presented as such, never as zeros.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";
import { ApiError } from "~/api/client";
import { fmtEpoch, fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { ACTION_LINK_CLASS, Button } from "~/ui/button";
import { Datum, Entity } from "~/ui/datum";
import { ErrorState } from "~/ui/feedback";
import { Select } from "~/ui/select";
import { StatusPill } from "~/ui/status";
import { Switch } from "~/ui/toggles";
import { parseSparkTime, stageDurationMs } from "../data/format";
import { sp } from "../data/queries";
import { compact, DEFAULT_QUANTILES, intParam, parseColumns, parseSort, serializeColumns, serializeSort, strParam } from "../data/search";
import { ByteRecCell, CountsCell } from "../ui/Counts";
import { DagVizHeading, StageDagPanel } from "../ui/DagPanel";
import { Metric, MetricStrip, PageHeader } from "../ui/PageHeader";
import { InlineNote, SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { stagePeakMemoryDistributions } from "../ui/StageAggregates";
import { DistributionTable, distributionsOf } from "../ui/TaskDistributions";
import { TaskTable } from "../ui/TaskTable";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";
import { OptionalTooltip } from "~/ui/tooltip";

const route = getRouteApi("/apps/$appId/spark/stages/$stageId/$attemptId");

const TASK_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "errors", label: "Errors (failed + killed)" },
  { value: "SUCCESS", label: "Succeeded" },
  { value: "RUNNING", label: "Running" },
  { value: "FAILED", label: "Failed" },
  { value: "KILLED", label: "Killed" },
];

const TASK_PAGE_SIZES: { value: string; label: string }[] = [
  { value: "", label: "All tasks (client-sorted)" },
  { value: "25", label: "25 per page" },
  { value: "50", label: "50 per page" },
  { value: "100", label: "100 per page" },
];

const TASK_DEFAULT_VISIBILITY = {
  status: true,
  taskId: true,
  executorId: true,
  host: true,
  launchTime: true,
  duration: true,
  gcTime: true,
  input: true,
  shuffleRead: true,
  shuffleWrite: true,
  spill: true,
  error: true,
  gettingResultTime: true,
  schedulerDelay: true,
  taskLocality: true,
  speculative: true,
  resultSize: true,
  peakExecutionMemory: true,
};

export function StageDetailPage() {
  const { appId, stageId, attemptId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const now = useNow();
  const tz = usePref("tz");

  const stageQ = useQuery(
    sp.stageAttempt(appId, stageId, attemptId, { details: true, withSummaries: true, quantiles: DEFAULT_QUANTILES, kind, attempt }),
  );
  const attemptsQ = useQuery(sp.stageAttempts(appId, stageId, kind, attempt));
  const stage = stageQ.data;
  const dist = stage?.taskMetricsDistributions ?? null;
  const summaryQ = useQuery({
    ...sp.taskSummary(appId, stageId, attemptId, DEFAULT_QUANTILES, kind, attempt),
    enabled: stageQ.isSuccess && !dist,
  });

  const metrics = useMemo(() => (dist ? distributionsOf(dist) : distributionsOf(summaryQ.data)), [dist, summaryQ.data]);
  const peakMetrics = useMemo(() => stagePeakMemoryDistributions(stage), [stage]);

  const statusFilter = strParam(search.taskStatus) ?? "";
  const rawSize = intParam(search.size);
  const size = rawSize === 25 || rawSize === 50 || rawSize === 100 ? rawSize : undefined;
  // The failed+killed union must be filtered before paging, so load it as a complete task set.
  const paged = size != null && statusFilter !== "errors";
  const pageSize = size ?? 0;
  const page = Math.max(1, intParam(search.page, 1) ?? 1);
  const sortId = typeof search.sort === "string" ? search.sort : undefined;
  const sorting = parseSort(search);
  const columnVisibility = parseColumns(search);
  const showMore = search.level === "more";
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  // Spark's REST taskList sorts only by `runtime` / `-runtime` (its TaskSorting enum); every other column is client-side.
  const serverSortBy = paged && sortId === "duration" ? (sorting[0]?.desc ? "-runtime" : "runtime") : undefined;
  // Single statuses go to Spark's REST (one status at a time); "errors" is the failed+killed union, which REST cannot express.
  const serverStatus = statusFilter && statusFilter !== "errors" ? statusFilter : undefined;
  const taskQ = useQuery(
    paged
      ? sp.taskList(appId, stageId, attemptId, {
          offset: (page - 1) * pageSize,
          length: pageSize,
          sortBy: serverSortBy,
          status: serverStatus,
          kind,
          attempt,
        })
      : sp.allTasks(appId, stageId, attemptId, kind, attempt),
  );

  const tasks = useMemo(() => taskQ.data ?? [], [taskQ.data]);
  const visibleTasks = useMemo(() => {
    if (!statusFilter) return tasks;
    if (statusFilter === "errors") return tasks.filter((t) => t.status === "FAILED" || t.status === "KILLED");
    if (serverStatus && paged) return tasks;
    return tasks.filter((t) => t.status === statusFilter);
  }, [tasks, statusFilter, serverStatus, paged]);

  if (stageQ.isPending) return <SparkLoading rows={12} cols={8} />;
  if (stageQ.error && !stage)
    return (
      <SparkFailureState error={stageQ.error} subject={`stage ${stageId} attempt ${attemptId}`} onRetry={() => void stageQ.refetch()} />
    );
  if (!stage) {
    return (
      <SparkEmpty title={`Stage ${stageId} attempt ${attemptId} is not in this application`}>
        Spark's stage list is the authority; the attempt may have been evicted.
      </SparkEmpty>
    );
  }

  const entityKey = `${stageId}/${attemptId}`;
  const attempts = attemptsQ.data ?? [];
  const numTasks = stage.numTasks ?? 0;
  const statusCount =
    statusFilter === "SUCCESS"
      ? stage.numCompleteTasks
      : statusFilter === "FAILED"
        ? stage.numFailedTasks
        : statusFilter === "KILLED"
          ? stage.numKilledTasks
          : statusFilter === "RUNNING"
            ? stage.numActiveTasks
            : undefined;
  // Task attempts can exceed the partition count after retries. Keep paging based on the returned page, rather than
  // stopping at numTasks and hiding retry records.
  const retainedTotal =
    statusCount ??
    Math.max(
      numTasks,
      (stage.numCompleteTasks ?? 0) + (stage.numFailedTasks ?? 0) + (stage.numKilledTasks ?? 0) + (stage.numActiveTasks ?? 0),
    );
  const offset = paged ? (page - 1) * pageSize : 0;
  const shownFrom = tasks.length === 0 ? 0 : offset + 1;
  const shownTo = offset + tasks.length;
  const failed = stage.status === "FAILED" || stage.failureReason != null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {stageQ.error && (
        <SparkStaleErrorBanner
          error={stageQ.error}
          subject={`stage ${stageId} attempt ${attemptId}`}
          onRetry={() => void stageQ.refetch()}
        />
      )}
      <PageHeader
        title={
          <Entity id={entityKey} as="span">
            <span className="flex items-center gap-2">
              <span>
                Stage <Datum field="spark.stage.stageId" raw={stage.stageId} fmt="id" /> · attempt{" "}
                <Datum field="spark.stage.attemptId" raw={stage.attemptId} fmt="id" />
              </span>
              <StatusPill domain="spark.stage" state={stage.status} field="spark.stage.status" size="sm" />
            </span>
          </Entity>
        }
        description={
          <Entity id={entityKey} as="span">
            {stage.description != null ? (
              <Datum field="spark.stage.description" raw={stage.description} />
            ) : stage.name != null ? (
              <Datum field="spark.stage.name" raw={stage.name} />
            ) : (
              "—"
            )}
            {stage.description && stage.name && stage.description !== stage.name && (
              <>
                {" "}
                <Datum field="spark.stage.name" raw={stage.name} className="text-ink-4" />
              </>
            )}
          </Entity>
        }
      >
        <Link to="/apps/$appId/spark/stages" params={{ appId }} search={{ attempt: attempt ?? undefined }} className={ACTION_LINK_CLASS}>
          <ArrowLeft className="size-3.5" aria-hidden="true" /> All stages
        </Link>
        <Link to="/apps/$appId/spark/jobs" params={{ appId }} search={{ attempt: attempt ?? undefined }} className={ACTION_LINK_CLASS}>
          Jobs <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
        {attempts.length > 1 && (
          <Select
            label="Stage attempt"
            value={attemptId}
            onValueChange={(v) => {
              if (v)
                void navigate({
                  to: "/apps/$appId/spark/stages/$stageId/$attemptId",
                  params: { appId, stageId, attemptId: v },
                  search: { attempt: attempt ?? undefined },
                });
            }}
            options={attempts.map((a, i) => ({
              value: String(a.attemptId ?? i),
              label: `Attempt ${a.attemptId ?? i} · ${a.status ?? "?"}`,
            }))}
          />
        )}
        {attemptsQ.error && attemptsQ.data !== undefined && (
          <SparkStaleErrorBanner error={attemptsQ.error} subject="the stage attempts" onRetry={() => void attemptsQ.refetch()} />
        )}
        {attemptsQ.error && attemptsQ.data === undefined && (
          <ErrorState
            compact
            title="Could not load stage attempts"
            message={attemptsQ.error instanceof Error ? attemptsQ.error.message : String(attemptsQ.error)}
            onRetry={() => void attemptsQ.refetch()}
          />
        )}
      </PageHeader>

      {attempts.length > 1 && (
        <InlineNote tone="warn">
          This stage was retried: Spark reports {fmtInt(attempts.length)} attempts for stage {stageId}. Metrics below belong to attempt{" "}
          {attemptId} only.
        </InlineNote>
      )}

      {failed && (
        <Entity id={entityKey} className="shrink-0 rounded-lg border border-seam bg-fabric">
          <ErrorState
            title="Stage failed"
            message={
              <>
                <Datum field="spark.stage.numFailedTasks" raw={stage.numFailedTasks} fmt="int" /> failed tasks on stage {stageId} attempt{" "}
                {attemptId}.
              </>
            }
            hint="Spark reports a failure reason for the stage as a whole; per-task errors are in the task table below."
            detail={
              <Datum field="spark.stage.failureReason" raw={stage.failureReason} fmt="text" className="block whitespace-pre-wrap text-left">
                {stage.failureReason}
              </Datum>
            }
          />
        </Entity>
      )}

      <Entity id={entityKey}>
        <MetricStrip>
          <Metric label="Stage Id">
            <Datum field="spark.stage.stageId" raw={stage.stageId} fmt="id" />
          </Metric>
          <Metric label="Attempt">
            <Datum field="spark.stage.attemptId" raw={stage.attemptId} fmt="id" />
          </Metric>
          <Metric label="Submitted">
            <Datum field="spark.stage.submissionTime" raw={stage.submissionTime} fmt="text">
              {fmtEpoch(parseSparkTime(stage.submissionTime), tz)}
            </Datum>
          </Metric>
          <Metric label="First task launched">
            <Datum field="spark.stage.firstTaskLaunchedTime" raw={stage.firstTaskLaunchedTime} fmt="text">
              {fmtEpoch(parseSparkTime(stage.firstTaskLaunchedTime), tz)}
            </Datum>
          </Metric>
          <Metric label="Completed">
            <Datum field="spark.stage.completionTime" raw={stage.completionTime} fmt="text">
              {fmtEpoch(parseSparkTime(stage.completionTime), tz)}
            </Datum>
          </Metric>
          <Metric label="Duration">
            <Datum field="spark.stage.derived.durationMs" raw={stageDurationMs(stage, now)} fmt="dur" />
          </Metric>
          <Metric label="Tasks (done / active / failed / killed)">
            <CountsCell
              counts={[
                { field: "spark.stage.numCompleteTasks", raw: stage.numCompleteTasks, tone: "ok", label: "complete" },
                { field: "spark.stage.numActiveTasks", raw: stage.numActiveTasks, tone: "live", label: "active" },
                { field: "spark.stage.numFailedTasks", raw: stage.numFailedTasks, tone: "fail", label: "failed" },
                { field: "spark.stage.numKilledTasks", raw: stage.numKilledTasks, tone: "idle", label: "killed" },
              ]}
            />
          </Metric>
          <Metric label="Input (bytes / records)">
            <ByteRecCell
              bytes={stage.inputBytes}
              records={stage.inputRecords}
              bytesField="spark.stage.inputBytes"
              recordsField="spark.stage.inputRecords"
            />
          </Metric>
          <Metric label="Output (bytes / records)">
            <ByteRecCell
              bytes={stage.outputBytes}
              records={stage.outputRecords}
              bytesField="spark.stage.outputBytes"
              recordsField="spark.stage.outputRecords"
            />
          </Metric>
          <Metric label="Shuffle Read (bytes / records)">
            <ByteRecCell
              bytes={stage.shuffleReadBytes}
              records={stage.shuffleReadRecords}
              bytesField="spark.stage.shuffleReadBytes"
              recordsField="spark.stage.shuffleReadRecords"
            />
          </Metric>
          <Metric label="Shuffle Write (bytes / records)">
            <ByteRecCell
              bytes={stage.shuffleWriteBytes}
              records={stage.shuffleWriteRecords}
              bytesField="spark.stage.shuffleWriteBytes"
              recordsField="spark.stage.shuffleWriteRecords"
            />
          </Metric>
          <Metric label="Spill (memory / disk)">
            <span className="flex items-center gap-1 tnum">
              <Datum field="spark.stage.memoryBytesSpilled" raw={stage.memoryBytesSpilled} fmt="bytes" />
              <span className="text-ink-4">/</span>
              <Datum field="spark.stage.diskBytesSpilled" raw={stage.diskBytesSpilled} fmt="bytes" />
            </span>
          </Metric>
          <Metric label="GC Time">
            <Datum field="spark.stage.jvmGcTime" raw={stage.jvmGcTime} fmt="dur" />
          </Metric>
          <Metric label="Peak execution memory">
            <Datum field="spark.stage.peakExecutionMemory" raw={stage.peakExecutionMemory} fmt="bytes" />
          </Metric>
          <Metric label="Scheduler pool">
            <Datum field="spark.stage.schedulingPool" raw={stage.schedulingPool} />
          </Metric>
          <Metric label="RDDs">
            {stage.rddIds.length === 0 ? (
              <span className="text-ink-4">—</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {stage.rddIds.map((id) => (
                  <Link
                    key={id}
                    to="/apps/$appId/spark/storage/$rddId"
                    params={{ appId, rddId: String(id) }}
                    search={{ attempt: attempt ?? undefined }}
                    className="text-live underline-offset-2 hover:underline"
                  >
                    <Datum field="spark.stage.rddIds" raw={id} fmt="id">
                      {String(id)}
                    </Datum>
                  </Link>
                ))}
              </span>
            )}
          </Metric>
          <Metric label="Resource profile">
            <Datum field="spark.stage.resourceProfileId" raw={stage.resourceProfileId} fmt="id" />
          </Metric>
          <Metric label="Shuffle push enabled">
            <Datum field="spark.stage.isShufflePushEnabled" raw={stage.isShufflePushEnabled} fmt="text">
              {stage.isShufflePushEnabled == null ? "—" : stage.isShufflePushEnabled ? "Enabled" : "Disabled"}
            </Datum>
          </Metric>
        </MetricStrip>
      </Entity>

      <section aria-label={`RDD graph of stage ${stageId} attempt ${attemptId}`} className="flex flex-col gap-2">
        <DagVizHeading title="Stage DAG" />
        <StageDagPanel
          appId={appId}
          stageId={Number(stageId)}
          attemptId={Number(attemptId)}
          stage={stage}
          onSelectRdd={(rddId) =>
            void navigate({
              to: "/apps/$appId/spark/storage/$rddId",
              params: { appId, rddId: String(rddId) },
              search: { attempt: attempt ?? undefined },
            })
          }
        />
      </section>

      <div className="flex flex-col gap-2">
        {summaryQ.error && summaryQ.data !== undefined && (
          <SparkStaleErrorBanner error={summaryQ.error} subject="the task summary metrics" onRetry={() => void summaryQ.refetch()} />
        )}
        {metrics.length > 0 ? (
          <DistributionTable metrics={metrics} />
        ) : !dist && summaryQ.isPending ? (
          <SparkLoading rows={4} cols={4} />
        ) : summaryQ.error && summaryQ.data === undefined && !(summaryQ.error instanceof ApiError && summaryQ.error.status === 404) ? (
          <SparkFailureState error={summaryQ.error} subject="the task summary metrics" onRetry={() => void summaryQ.refetch()} />
        ) : (
          <InlineNote>No task summary metrics have been reported for this stage attempt.</InlineNote>
        )}
        {peakMetrics.length > 0 && <DistributionTable metrics={peakMetrics} title="Peak memory metrics" />}
      </div>

      <section aria-label={`Tasks of stage ${stageId} attempt ${attemptId}`} className="flex min-h-0 flex-col gap-2">
        {taskQ.error && taskQ.data !== undefined && (
          <SparkStaleErrorBanner
            error={taskQ.error}
            subject={`the tasks of stage ${stageId} attempt ${attemptId}`}
            onRetry={() => void taskQ.refetch()}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-body font-semibold text-ink">Tasks</h3>
          <p className="text-small text-ink-3">
            {paged ? (
              <>
                showing <span className="tnum">{fmtInt(shownFrom)}</span>–<span className="tnum">{fmtInt(shownTo)}</span> of{" "}
                <span className="tnum">{fmtInt(retainedTotal)}</span> task attempts
              </>
            ) : (
              <>
                <span className="tnum">{fmtInt(visibleTasks.length)}</span> retained task attempts ·{" "}
                <span className="tnum">{fmtInt(numTasks)}</span> partitions
              </>
            )}
          </p>
        </div>
        <TaskTable
          tasks={visibleTasks}
          label={`Tasks of stage ${stageId} attempt ${attemptId}`}
          tz={tz}
          showMore={showMore}
          sorting={sorting}
          onSortingChange={(s: SortingState) => patch({ ...serializeSort(s), page: undefined })}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={TASK_DEFAULT_VISIBILITY}
          rowVersion={(t) => `${t.status}:${t.duration ?? 0}:${t.attempt ?? 0}`}
          {...(paged ? { totalCount: retainedTotal } : {})}
          loading={taskQ.isPending}
          {...(taskQ.error && taskQ.data === undefined
            ? {
                error: (
                  <SparkFailureState
                    error={taskQ.error}
                    subject={`the tasks of stage ${stageId} attempt ${attemptId}`}
                    onRetry={() => void taskQ.refetch()}
                  />
                ),
              }
            : {})}
          empty={
            numTasks === 0 ? (
              <SparkEmpty title="Spark has no task records for this attempt">
                A skipped or reused stage runs no tasks, so Spark's <code className="font-mono text-micro">taskList</code> is empty for it.
              </SparkEmpty>
            ) : (
              <SparkEmpty title="No tasks match this filter">Clear the status filter to see every task of this attempt.</SparkEmpty>
            )
          }
          toolbar={
            <>
              <Select
                label="Task status filter"
                value={statusFilter}
                onValueChange={(v) => patch({ taskStatus: v === "" ? undefined : v, page: undefined })}
                options={TASK_STATUS_OPTIONS}
              />
              <Select
                label="Tasks per page"
                value={size != null ? String(size) : ""}
                onValueChange={(v) => patch({ size: v === "" ? undefined : v, page: undefined })}
                options={TASK_PAGE_SIZES}
              />
              <span className="flex items-center gap-1.5 text-small text-ink-3">
                <Switch
                  checked={showMore}
                  onCheckedChange={(v) => patch({ level: v ? "more" : undefined })}
                  label="Show additional task metrics"
                />
                <span>Additional metrics</span>
              </span>
              {paged && (
                <span className="flex items-center gap-1.5 text-small text-ink-3">
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={page <= 1}
                    onClick={() => patch({ page: page <= 2 ? undefined : String(page - 1) })}
                  >
                    Previous
                  </Button>
                  <Button size="sm" variant="quiet" disabled={tasks.length < pageSize} onClick={() => patch({ page: String(page + 1) })}>
                    Next
                  </Button>
                </span>
              )}
              {paged && sortId && sortId !== "duration" && (
                <OptionalTooltip
                  label={"Spark's REST taskList can sort only by runtime; this column is sorted client-side on the current page."}
                >
                  <span className="text-small text-ink-4">server sorts runtime only</span>
                </OptionalTooltip>
              )}
              {statusFilter === "errors" && (
                <OptionalTooltip
                  label={
                    "Spark's REST taskList accepts one status at a time, so all retained tasks are loaded before selecting failed + killed attempts."
                  }
                >
                  <span className="text-small text-ink-4">all failed + killed attempts loaded</span>
                </OptionalTooltip>
              )}
            </>
          }
          exportName={`spark-stage-${stageId}-${attemptId}-tasks`}
        />
      </section>

      <p className="text-micro text-ink-4">
        Task aggregates are Spark's own per-task metrics; the stage-level numbers sum the tasks Spark actually recorded.
        <code className="font-mono"> ?size</code> switches the task table to Spark's server-side paging, whose only sort key is{" "}
        <code className="font-mono">runtime</code> — every other column is sorted client-side.
      </p>
    </div>
  );
}
