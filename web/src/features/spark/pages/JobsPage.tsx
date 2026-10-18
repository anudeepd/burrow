/**
 * Spark Jobs list — the native replacement for `/jobs/` in Spark's tracking UI.
 *
 * Columns mirror Spark's own job table (Job Id, Status, Name, Submitted, Duration, Stages, Tasks) plus the progress bar the
 * brief asks for. Every REST value is stamped with a `spark.job.*` field id; the computed duration uses
 * `spark.job.derived.durationMs`. Sorting / visible columns / status filter live in the URL.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";
import { fmtEpoch, fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { Select } from "~/ui/select";
import { StatusPill } from "~/ui/status";
import { jobDurationMs, parseSparkTime } from "../data/format";
import { sp } from "../data/queries";
import type { SparkJob } from "../data/schemas";
import { compact, matchesQuery, parseColumns, parseSort, serializeColumns, serializeSort } from "../data/search";
import { CountsCell, TaskProgress } from "../ui/Counts";
import { PageHeader } from "../ui/PageHeader";
import { SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";

const route = getRouteApi("/apps/$appId/spark/jobs/");

const DEFAULT_VISIBILITY = { name: true, stages: true, tasks: true, progress: true };

export function JobsPage() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const now = useNow();
  const tz = usePref("tz");

  const status = typeof search.status === "string" && search.status !== "" ? search.status : undefined;
  const q = typeof search.q === "string" ? search.q : "";
  const qJobs = useQuery(sp.jobs(appId, { status, kind, attempt }));
  const jobs = useMemo(() => qJobs.data ?? [], [qJobs.data]);

  const filtering = useMemo(() => (q ? jobs.filter((j) => matchesQuery([j.jobId, j.name, j.description, j.status], q)) : jobs), [jobs, q]);

  const sorting = parseSort(search);
  const columnVisibility = parseColumns(search);
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  const columns = useMemo<ColDef<SparkJob>[]>(
    () => [
      {
        id: "jobId",
        accessorKey: "jobId",
        size: 64,
        meta: { label: "Job Id", pinned: true, align: "start", exportValue: (r: SparkJob) => r.jobId },
        header: "Job Id",
        cell: (info) => (
          <Link
            to="/apps/$appId/spark/jobs/$jobId"
            params={{ appId, jobId: String(info.row.original.jobId) }}
            search={{ attempt: attempt ?? undefined }}
            className="font-medium text-live underline-offset-2 hover:underline"
          >
            <Datum field="spark.job.jobId" raw={info.row.original.jobId} fmt="int">
              {String(info.row.original.jobId)}
            </Datum>
          </Link>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        size: 128,
        meta: { label: "Status", exportValue: (r: SparkJob) => r.status },
        header: "Status",
        cell: (info) => <StatusPill domain="spark.job" state={info.row.original.status} field="spark.job.status" size="sm" />,
      },
      {
        id: "name",
        accessorKey: "name",
        meta: { label: "Name / description", exportValue: (r: SparkJob) => r.description ?? r.name },
        header: "Name",
        cell: (info) => {
          const j = info.row.original;
          return (
            <span className="flex min-w-0 flex-col">
              <Datum
                field={j.description ? "spark.job.description" : "spark.job.name"}
                raw={j.description || j.name}
                className="truncate"
                title={j.description || j.name || undefined}
              />
              {j.description && j.name && j.description !== j.name && (
                <Datum field="spark.job.name" raw={j.name} className="truncate text-micro text-ink-4" title={j.name} />
              )}
            </span>
          );
        },
      },
      {
        id: "submitted",
        accessorKey: "submissionTime",
        meta: { label: "Submitted", exportValue: (r: SparkJob) => r.submissionTime },
        header: "Submitted",
        cell: (info) => {
          const t = parseSparkTime(info.row.original.submissionTime);
          return (
            <Datum
              field="spark.job.submissionTime"
              raw={info.row.original.submissionTime}
              fmt="text"
              className="whitespace-nowrap text-ink-3"
            >
              {fmtEpoch(t, tz)}
            </Datum>
          );
        },
      },
      {
        id: "duration",
        sortFn: "basic",
        accessorFn: (j) => jobDurationMs(j, now) ?? -1,
        meta: { label: "Duration", align: "end", exportValue: (r: SparkJob) => jobDurationMs(r, now) },
        header: "Duration",
        cell: (info) => (
          <Datum field="spark.job.derived.durationMs" raw={jobDurationMs(info.row.original, now)} fmt="dur" className="whitespace-nowrap" />
        ),
      },
      {
        id: "stages",
        enableSorting: false,
        meta: { label: "Stages (done / active / failed / skipped)" },
        header: "Stages",
        cell: (info) => {
          const j = info.row.original;
          return (
            <CountsCell
              counts={[
                { field: "spark.job.numCompletedStages", raw: j.numCompletedStages, tone: "ok", label: "succeeded" },
                { field: "spark.job.numActiveStages", raw: j.numActiveStages, tone: "live", label: "active" },
                { field: "spark.job.numFailedStages", raw: j.numFailedStages, tone: "fail", label: "failed" },
                { field: "spark.job.numSkippedStages", raw: j.numSkippedStages, tone: "idle", label: "skipped" },
              ]}
            />
          );
        },
      },
      {
        id: "tasks",
        enableSorting: false,
        meta: { label: "Tasks (done / active / failed)" },
        header: "Tasks",
        cell: (info) => {
          const j = info.row.original;
          return (
            <CountsCell
              counts={[
                { field: "spark.job.numCompletedTasks", raw: j.numCompletedTasks, tone: "ok", label: "succeeded" },
                { field: "spark.job.numActiveTasks", raw: j.numActiveTasks, tone: "live", label: "active" },
                { field: "spark.job.numFailedTasks", raw: j.numFailedTasks, tone: "fail", label: "failed" },
              ]}
            />
          );
        },
      },
      {
        id: "progress",
        enableSorting: false,
        meta: { label: "Progress" },
        header: "Progress",
        cell: (info) => {
          const j = info.row.original;
          return (
            <TaskProgress
              complete={j.numCompletedIndices ?? j.numCompletedTasks ?? 0}
              active={j.numActiveTasks ?? 0}
              failed={j.numFailedTasks ?? 0}
              killed={j.numKilledTasks ?? 0}
              total={j.numTasks ?? 0}
              field={j.numCompletedIndices != null ? "spark.job.numCompletedIndices" : "spark.job.numCompletedTasks"}
              label={`Job ${j.jobId} tasks`}
            />
          );
        },
      },
    ],
    [appId, now, tz, attempt],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="Jobs" hideTitle />
      {qJobs.error && qJobs.data !== undefined && (
        <SparkStaleErrorBanner error={qJobs.error} subject="the job list" onRetry={() => void qJobs.refetch()} />
      )}
      {qJobs.isPending ? (
        <SparkLoading rows={10} cols={7} />
      ) : qJobs.error && qJobs.data === undefined ? (
        <SparkFailureState error={qJobs.error} subject="the job list" onRetry={() => void qJobs.refetch()} />
      ) : jobs.length === 0 ? (
        <SparkEmpty title={status ? `No ${status.toLowerCase()} jobs` : "No jobs yet"}>
          {status ? "Clear the status filter to see every job." : "Jobs appear as soon as the application submits one."}
        </SparkEmpty>
      ) : (
        <DataTable<SparkJob>
          className="min-h-[24rem]"
          data={filtering}
          columns={columns}
          getRowId={(j) => String(j.jobId)}
          entityKey={(j) => String(j.jobId)}
          label="Spark jobs"
          storageKey="spark-jobs"
          sorting={sorting}
          onSortingChange={(s: SortingState) => patch(serializeSort(s))}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={DEFAULT_VISIBILITY}
          onRowActivate={(j) =>
            void navigate({
              to: "/apps/$appId/spark/jobs/$jobId",
              params: { appId, jobId: String(j.jobId) },
              search: { attempt: attempt ?? undefined },
            })
          }
          rowVersion={(j) => `${j.status}:${j.numActiveTasks ?? 0}:${j.numCompletedTasks ?? 0}`}
          totalCount={jobs.length}
          exportName={`spark-jobs-${appId}`}
          toolbar={
            <>
              <Select
                label="Job status filter"
                value={status ?? ""}
                onValueChange={(v) => patch({ status: v === "" ? undefined : v })}
                options={[
                  { value: "", label: "All statuses" },
                  { value: "RUNNING", label: "Running" },
                  { value: "SUCCEEDED", label: "Succeeded" },
                  { value: "FAILED", label: "Failed" },
                ]}
              />
              <label className="flex items-center gap-1.5 text-small text-ink-3">
                <span className="sr-only">Filter jobs by name or id</span>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => patch({ q: e.target.value || undefined })}
                  placeholder="Filter name / id…"
                  className="h-(--ctl-h) w-52 rounded-md border border-seam-strong bg-well px-2 text-body text-ink placeholder:text-ink-4"
                />
              </label>
              <span className="text-small text-ink-4">
                {filtering.length === jobs.length ? (
                  <>{fmtInt(jobs.length)} shown</>
                ) : (
                  <>
                    {fmtInt(filtering.length)} of {fmtInt(jobs.length)}
                  </>
                )}
              </span>
            </>
          }
        />
      )}
    </div>
  );
}
