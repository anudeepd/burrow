/**
 * Spark SQL execution detail — the native replacement for `/SQL/execution/?id=N`: header + metrics, the plan DAG
 * (DagViz via `SqlPlanDag`), the raw foldable plan tree, and the jobs the execution ran.
 *
 * The SQL REST payload has no stage ids, so the stage-exploration links are derived from the job list
 * (jobId → stageIds) — fetched lazily and only when the execution actually has jobs.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { cn } from "~/lib/cn";
import { fmtEpoch, fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { ACTION_LINK_CLASS } from "~/ui/button";
import { Datum, Entity } from "~/ui/datum";
import { ErrorState } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { useParity } from "~/state/parity";
import { planOperatorCount } from "~/features/dag/sql-plan";
import { parseSparkTime, sqlDurationMs } from "../data/format";
import { sp } from "../data/queries";
import type { SparkSqlExecution } from "../data/schemas";
import { compact } from "../data/search";
import { DagVizHeading, SqlPlanDag } from "../ui/DagPanel";
import { Metric, MetricStrip, PageHeader } from "../ui/PageHeader";
import { PlanTree } from "../ui/PlanTree";
import { SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";

const route = getRouteApi("/apps/$appId/spark/sql/$executionId");

function SqlStatus({ status }: { status: string | null | undefined }) {
  return (
    <StatusPill domain="spark.sql" state={status} field="spark.sql.status" size="sm">
      {status ?? "UNKNOWN"}
    </StatusPill>
  );
}

function JobGroup({
  appId,
  title,
  ids,
  field,
  tone,
  attempt,
}: {
  appId: string;
  title: string;
  ids: number[];
  field: string;
  tone: string;
  attempt: string | null;
}) {
  return (
    <div className="flex min-w-40 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className={cn("tnum text-small font-medium", tone)}>{ids.length}</span>
        <span className="text-micro uppercase tracking-wide text-ink-4">{title}</span>
      </div>
      {ids.length === 0 ? (
        <span className="text-small text-ink-4">none</span>
      ) : (
        <span className="flex flex-wrap gap-1.5">
          {ids.map((jid) => (
            <Link
              key={jid}
              to="/apps/$appId/spark/jobs/$jobId"
              params={{ appId, jobId: String(jid) }}
              search={{ attempt: attempt ?? undefined }}
              className="rounded-md border border-seam-strong bg-well px-1.5 py-0.5 text-small text-live underline-offset-2 hover:underline"
            >
              <Datum field={field} raw={jid} fmt="int" className="font-mono text-micro">
                {jid}
              </Datum>
            </Link>
          ))}
        </span>
      )}
    </div>
  );
}

export function SqlDetailPage() {
  const { appId, executionId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const parity = useParity();
  const now = useNow();
  const tz = usePref("tz");

  const q = typeof search.q === "string" ? search.q : "";
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  const execQ = useQuery(sp.sqlExecution(appId, executionId, { kind, attempt }));
  const exec: SparkSqlExecution | undefined = execQ.data;

  const running = useMemo(() => exec?.runningJobIds ?? [], [exec?.runningJobIds]);
  const success = useMemo(() => exec?.successJobIds ?? [], [exec?.successJobIds]);
  const failed = useMemo(() => exec?.failedJobIds ?? [], [exec?.failedJobIds]);
  const jobIds = useMemo(() => [...new Set([...running, ...success, ...failed])], [running, success, failed]);
  const jobKeyStr = jobIds.join(",");

  const jobsQ = useQuery({ ...sp.jobs(appId, { kind: "static", attempt }), enabled: jobIds.length > 0 });
  const stageIds = useMemo(() => {
    const wanted = new Set(jobKeyStr ? jobKeyStr.split(",").map(Number) : []);
    const out = new Set<number>();
    for (const j of jobsQ.data ?? []) {
      if (!wanted.has(j.jobId)) continue;
      for (const s of j.stageIds ?? []) out.add(Number(s));
    }
    return [...out].sort((a, b) => a - b);
  }, [jobsQ.data, jobKeyStr]);

  if (execQ.isPending) return <SparkLoading rows={10} cols={4} />;
  if (execQ.error && !exec)
    return <SparkFailureState error={execQ.error} subject={`SQL execution ${executionId}`} onRetry={() => void execQ.refetch()} />;
  if (!exec)
    return (
      <SparkEmpty title={`SQL execution ${executionId} is not in this application`}>
        Spark's SQL list is the authority; the execution may have been evicted from the driver's store.
      </SparkEmpty>
    );

  return (
    // AppLayout owns the page-level scroller for the application header, section tabs and all Spark content. Keep this
    // route in normal document flow; only bounded code/data panels inside it should have their own scroll area.
    <div className="flex min-h-0 flex-1 flex-col gap-4 pb-6">
      {execQ.error && (
        <SparkStaleErrorBanner error={execQ.error} subject={`SQL execution ${executionId}`} onRetry={() => void execQ.refetch()} />
      )}
      <PageHeader
        title={
          <Entity id={String(exec.id)} as="span">
            <span className="flex items-center gap-2">
              <span>SQL execution {exec.id}</span>
              <SqlStatus status={exec.status} />
            </span>
          </Entity>
        }
        description={
          <Entity id={String(exec.id)} as="span">
            <Datum field="spark.sql.description" raw={exec.description} />
          </Entity>
        }
      >
        <Link to="/apps/$appId/spark/sql" params={{ appId }} search={{ attempt: attempt ?? undefined }} className={ACTION_LINK_CLASS}>
          <ArrowLeft className="size-3.5" aria-hidden="true" /> All SQL executions
        </Link>
      </PageHeader>

      <Entity id={String(exec.id)}>
        <MetricStrip>
          <Metric label="Id">
            <Datum field="spark.sql.id" raw={exec.id} fmt="int" />
          </Metric>
          <Metric label="Status">
            <SqlStatus status={exec.status} />
          </Metric>
          <Metric label="Submitted">
            <Datum field="spark.sql.submissionTime" raw={exec.submissionTime} fmt="text">
              {fmtEpoch(parseSparkTime(exec.submissionTime), tz)}
            </Datum>
          </Metric>
          <Metric label="Completed">
            <Datum field="spark.sql.completionTime" raw={exec.completionTime} fmt="text">
              {fmtEpoch(parseSparkTime(exec.completionTime), tz)}
            </Datum>
          </Metric>
          <Metric label="Duration">
            <Datum field="spark.sql.derived.durationMs" raw={sqlDurationMs(exec, now)} fmt="dur" />
          </Metric>
          <Metric label="Query id">
            <Datum field="spark.sql.queryId" raw={exec.queryId} className="font-mono text-micro" />
          </Metric>
          <Metric label="Root execution id" hint="Set when this execution was re-used by an adaptive re-plan.">
            <Datum field="spark.sql.rootExecutionId" raw={exec.rootExecutionId} fmt="int" />
          </Metric>
          <Metric label="Plan graph">
            {fmtInt(planOperatorCount(exec.nodes))} nodes · {fmtInt((exec.edges ?? []).length)} edges
          </Metric>
        </MetricStrip>
      </Entity>

      {exec.errorMessage && (
        <section id="error" aria-label={`Error of SQL execution ${exec.id}`} className="flex flex-col gap-2">
          <h3 className="text-body font-semibold text-fail">Error</h3>
          <Entity id={String(exec.id)}>
            <Datum
              field="spark.sql.errorMessage"
              raw={exec.errorMessage}
              as="pre"
              className="max-h-72 overflow-auto rounded-md border border-seam bg-well p-3 font-mono text-micro leading-[1.5] text-ink-2 whitespace-pre-wrap"
            />
          </Entity>
        </section>
      )}

      <section id="plan" aria-label={`Plan DAG of SQL execution ${exec.id}`} className="flex flex-col gap-2">
        <DagVizHeading title="Plan DAG" />
        <SqlPlanDag execution={exec} />
      </section>

      <section aria-label={`Raw plan of SQL execution ${exec.id}`}>
        <details open={parity} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg border border-seam bg-fabric px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-fabric-2 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="block text-lead font-medium text-ink">Raw plan tree</span>
              <span className="mt-0.5 block text-small text-ink-3">Search, expand, and copy the full physical plan.</span>
            </span>
            <ChevronDown
              className="size-4 shrink-0 text-ink-3 transition-transform duration-(--dur-fast) group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="mt-3">
            <Entity id={String(exec.id)}>
              <PlanTree key={exec.id} plan={exec.planDescription} q={q} onQ={(v) => patch({ q: v || undefined })} />
            </Entity>
          </div>
        </details>
      </section>

      <section aria-label={`Jobs of SQL execution ${exec.id}`} className="flex flex-col gap-2 rounded-lg border border-seam bg-fabric p-3">
        <h3 className="text-body font-semibold text-ink">Jobs</h3>
        <Entity id={String(exec.id)}>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <JobGroup
              appId={appId}
              title="Running"
              ids={running}
              field="spark.sql.runningJobIds"
              tone="burrow-tone-live"
              attempt={attempt}
            />
            <JobGroup
              appId={appId}
              title="Succeeded"
              ids={success}
              field="spark.sql.successJobIds"
              tone="burrow-tone-ok"
              attempt={attempt}
            />
            <JobGroup appId={appId} title="Failed" ids={failed} field="spark.sql.failedJobIds" tone="burrow-tone-fail" attempt={attempt} />
          </div>
        </Entity>
        <div className="flex flex-wrap items-center gap-2 border-t border-seam-soft pt-2">
          <span className="text-micro uppercase tracking-wide text-ink-4">Stages</span>
          {jobsQ.error && jobsQ.data !== undefined && (
            <SparkStaleErrorBanner error={jobsQ.error} subject="the jobs for this SQL execution" onRetry={() => void jobsQ.refetch()} />
          )}
          {jobIds.length === 0 ? (
            <span className="text-small text-ink-4">This execution ran no jobs.</span>
          ) : jobsQ.isPending ? (
            <span className="text-small text-ink-4">Resolving stage ids from the job list…</span>
          ) : jobsQ.error && jobsQ.data === undefined ? (
            <ErrorState
              compact
              title="Could not resolve stage ids"
              message={jobsQ.error instanceof Error ? jobsQ.error.message : String(jobsQ.error)}
              onRetry={() => void jobsQ.refetch()}
            />
          ) : stageIds.length === 0 ? (
            <span className="text-small text-ink-4">No stage ids reported for these jobs.</span>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {stageIds.map((sid) => (
                <a
                  key={sid}
                  href={`/apps/${encodeURIComponent(appId)}/spark/stages?q=${sid}${attempt ? `&attempt=${encodeURIComponent(attempt)}` : ""}`}
                  className="rounded-md border border-seam-strong bg-well px-1.5 py-0.5 font-mono text-micro text-live underline-offset-2 hover:underline"
                >
                  stage {sid}
                </a>
              ))}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
