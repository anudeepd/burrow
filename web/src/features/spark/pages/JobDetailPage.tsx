/**
 * Spark job detail — the native replacement for `/jobs/job/?id=N`: job metrics, the job's RDD graph (DagViz) and the
 * per-stage table for this job, including skipped stages.
 *
 * `?stage=N` (set by clicking a node in the DAG) highlights that stage's row; the DAG's own drawer is DagViz's business.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { fmtEpoch, fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { ACTION_LINK_CLASS } from "~/ui/button";
import { DataTable } from "~/ui/data-table/data-table";
import { Datum, Entity } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { jobDurationMs, parseSparkTime } from "../data/format";
import { sp } from "../data/queries";
import type { SparkStage } from "../data/schemas";
import { boolParam, compact, parseColumns, parseSort, serializeColumns, serializeSort } from "../data/search";
import { CountsCell } from "../ui/Counts";
import { DagVizHeading, JobDagPanel } from "../ui/DagPanel";
import { Metric, MetricStrip, PageHeader } from "../ui/PageHeader";
import { SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { stageColumns } from "../ui/StageTable";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";

const route = getRouteApi("/apps/$appId/spark/jobs/$jobId");

const STAGE_DEFAULT_VISIBILITY = { name: true, tasks: true, progress: true, spill: true, jvmGcTime: true, failureReason: true };

export function JobDetailPage() {
  const { appId, jobId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const now = useNow();
  const tz = usePref("tz");

  const numericJobId = Number(jobId);
  const jobQ = useQuery(sp.job(appId, numericJobId, kind === "live" ? "live" : "static", attempt));
  const stagesQ = useQuery(sp.stages(appId, { kind, attempt }));
  const job = jobQ.data;

  const stageIds = useMemo(() => new Set((job?.stageIds ?? []).map(Number)), [job?.stageIds]);
  const jobStages = useMemo(
    () => (stagesQ.data ?? []).filter((s) => stageIds.has(s.stageId)).sort((a, b) => a.stageId - b.stageId),
    [stagesQ.data, stageIds],
  );

  const selectedStageId = search.stage != null && search.stage !== "" ? Number(search.stage) : undefined;
  const expandStages = boolParam(search.expand);
  const sorting = parseSort(search);
  const columnVisibility = parseColumns(search);
  const patch = (p: Record<string, unknown>) => {
    const scrollTop = document.querySelector<HTMLElement>(".burrow-page-scroll")?.scrollTop;
    void navigate({ search: (prev) => compact({ ...prev, ...p }), resetScroll: false }).then(() => {
      if (scrollTop == null) return;
      requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>(".burrow-page-scroll");
        if (scroller) scroller.scrollTop = scrollTop;
      });
    });
  };

  const columns = useMemo(
    () => stageColumns({ appId, now, tz, attempt, showAdvanced: true, showFailureReason: true }),
    [appId, now, tz, attempt],
  );
  const failedStages = jobStages.filter((s) => s.status === "FAILED").length;
  const skippedStages = jobStages.filter((s) => s.status === "SKIPPED").length;

  if (jobQ.isPending) return <SparkLoading rows={8} cols={8} />;
  if (jobQ.error && !job)
    return <SparkFailureState error={jobQ.error} subject={`Spark job ${jobId}`} onRetry={() => void jobQ.refetch()} />;
  if (!job)
    return (
      <SparkEmpty title={`Job ${jobId} is not in this application`}>
        It may have been evicted; Spark's job list is the authority.
      </SparkEmpty>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {jobQ.error && <SparkStaleErrorBanner error={jobQ.error} subject={`Spark job ${jobId}`} onRetry={() => void jobQ.refetch()} />}
      <PageHeader
        title={
          <Entity id={String(job.jobId)} as="span">
            <span className="flex items-center gap-2">
              <span>Job {job.jobId}</span>
              <StatusPill domain="spark.job" state={job.status} field="spark.job.status" size="sm" />
            </span>
          </Entity>
        }
        description={
          <Entity id={String(job.jobId)} as="span">
            <Datum field={job.description ? "spark.job.description" : "spark.job.name"} raw={job.description || job.name} />
            {job.description && job.name && job.description !== job.name && (
              <>
                {" "}
                <Datum field="spark.job.name" raw={job.name} className="text-ink-4" />
              </>
            )}
          </Entity>
        }
      >
        <Link to="/apps/$appId/spark/jobs" params={{ appId }} search={{ attempt: attempt ?? undefined }} className={ACTION_LINK_CLASS}>
          <ArrowLeft className="size-3.5" aria-hidden="true" /> All jobs
        </Link>
      </PageHeader>

      <Entity id={String(job.jobId)}>
        <MetricStrip>
          <Metric label="Job Id">
            <Datum field="spark.job.jobId" raw={job.jobId} fmt="int" />
          </Metric>
          <Metric label="Submitted">
            <Datum field="spark.job.submissionTime" raw={job.submissionTime} fmt="text">
              {fmtEpoch(parseSparkTime(job.submissionTime), tz)}
            </Datum>
          </Metric>
          <Metric label="Completed">
            <Datum field="spark.job.completionTime" raw={job.completionTime} fmt="text">
              {fmtEpoch(parseSparkTime(job.completionTime), tz)}
            </Datum>
          </Metric>
          <Metric label="Duration">
            <Datum field="spark.job.derived.durationMs" raw={jobDurationMs(job, now)} fmt="dur" />
          </Metric>
          <Metric label="Stages (done / active / failed / skipped)">
            <CountsCell
              counts={[
                { field: "spark.job.numCompletedStages", raw: job.numCompletedStages, tone: "ok", label: "succeeded" },
                { field: "spark.job.numActiveStages", raw: job.numActiveStages, tone: "live", label: "active" },
                { field: "spark.job.numFailedStages", raw: job.numFailedStages, tone: "fail", label: "failed" },
                { field: "spark.job.numSkippedStages", raw: job.numSkippedStages, tone: "idle", label: "skipped" },
              ]}
            />
          </Metric>
          <Metric label="Tasks (done / active / failed / killed)">
            <CountsCell
              counts={[
                { field: "spark.job.numCompletedTasks", raw: job.numCompletedTasks, tone: "ok", label: "succeeded" },
                { field: "spark.job.numActiveTasks", raw: job.numActiveTasks, tone: "live", label: "active" },
                { field: "spark.job.numFailedTasks", raw: job.numFailedTasks, tone: "fail", label: "failed" },
                { field: "spark.job.numKilledTasks", raw: job.numKilledTasks, tone: "idle", label: "killed" },
              ]}
            />
          </Metric>
          <Metric label="Indices complete">
            <Datum field="spark.job.numCompletedIndices" raw={job.numCompletedIndices} fmt="int" />
            {" / "}
            <Datum field="spark.job.numTasks" raw={job.numTasks} fmt="int" />
          </Metric>
          {job.jobTags.length > 0 && (
            <Metric label="Tags">
              <span className="flex flex-wrap gap-1">
                {job.jobTags.map((t) => (
                  <Datum key={t} field="spark.job.jobTags" raw={t} className="rounded-full bg-fabric-3 px-1.5 text-micro text-ink-2">
                    {t}
                  </Datum>
                ))}
              </span>
            </Metric>
          )}
        </MetricStrip>
      </Entity>

      <section aria-label={`RDD graph of job ${job.jobId}`} className="flex flex-col gap-2">
        <DagVizHeading title="Job DAG" />
        <JobDagPanel
          appId={appId}
          jobId={job.jobId}
          stages={jobStages}
          stagesLoading={stagesQ.isPending}
          selectedStageId={selectedStageId}
          onSelectStage={(stageId) => patch({ stage: String(stageId) })}
          expandStages={expandStages}
          onExpandStagesChange={(expanded) => patch({ expand: expanded ? "1" : "0" })}
        />
      </section>

      <section aria-label={`Stages of job ${job.jobId}`} className="flex min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-body font-semibold text-ink">Stages</h3>
          <p className="text-small text-ink-3">
            {fmtInt(jobStages.length)} stages in this job
            {skippedStages > 0 && <> · {fmtInt(skippedStages)} skipped (output reused)</>}
            {failedStages > 0 && (
              <>
                {" "}
                · <span className="text-fail">{fmtInt(failedStages)} failed</span>
              </>
            )}
          </p>
        </div>
        {stagesQ.error && stagesQ.data !== undefined && (
          <SparkStaleErrorBanner error={stagesQ.error} subject={`the stages of job ${job.jobId}`} onRetry={() => void stagesQ.refetch()} />
        )}
        {stagesQ.isPending ? (
          <SparkLoading rows={5} cols={6} />
        ) : stagesQ.error && stagesQ.data === undefined ? (
          <SparkFailureState error={stagesQ.error} subject={`the stages of job ${job.jobId}`} onRetry={() => void stagesQ.refetch()} />
        ) : jobStages.length === 0 ? (
          <SparkEmpty title="Spark reports no stages for this job">
            A job with only reused (skipped) output times out or returns immediately; its stages list can be empty.
          </SparkEmpty>
        ) : (
          <DataTable<SparkStage>
            className="min-h-[24rem]"
            data={jobStages}
            columns={columns}
            getRowId={(s) => `${s.stageId}/${s.attemptId ?? 0}`}
            entityKey={(s) => `${s.stageId}/${s.attemptId ?? 0}`}
            label={`Stages of job ${job.jobId}`}
            storageKey="spark-job-stages"
            sorting={sorting}
            onSortingChange={(s) => patch(serializeSort(s))}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
            defaultVisibility={STAGE_DEFAULT_VISIBILITY}
            onRowActivate={(s) =>
              void navigate({
                to: "/apps/$appId/spark/stages/$stageId/$attemptId",
                params: { appId, stageId: String(s.stageId), attemptId: String(s.attemptId ?? 0) },
                search: { attempt: attempt ?? undefined },
              })
            }
            rowVersion={(s) => `${s.status}:${s.numActiveTasks ?? 0}:${s.numCompleteTasks ?? 0}`}
            totalCount={jobStages.length}
            exportName={`spark-job-${job.jobId}-stages`}
            toolbar={
              selectedStageId != null ? (
                <span className="text-small text-ink-3">
                  selected stage{" "}
                  <Link
                    to="/apps/$appId/spark/stages/$stageId/$attemptId"
                    params={{
                      appId,
                      stageId: String(selectedStageId),
                      attemptId: String(
                        Math.max(0, ...jobStages.filter((s) => s.stageId === selectedStageId).map((s) => s.attemptId ?? 0)),
                      ),
                    }}
                    search={{ attempt: attempt ?? undefined }}
                    className="text-live underline-offset-2 hover:underline"
                  >
                    {selectedStageId}
                  </Link>{" "}
                  — clear
                  <Tooltip label="Clear selected stage filter">
                    <button
                      type="button"
                      onClick={() => patch({ stage: undefined })}
                      aria-label="Clear selected stage filter"
                      className="ml-1 text-ink-4 underline"
                    >
                      ×
                    </button>
                  </Tooltip>
                </span>
              ) : null
            }
          />
        )}
      </section>
    </div>
  );
}
