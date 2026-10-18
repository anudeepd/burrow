/**
 * DAG panels — thin adapters over the DagViz engine (`~/features/dag`, owner: DagViz). This file owns NO rendering logic
 * for graphs: it fetches the synthesized `/dag/*` payloads (or receives a SQL execution) and hands them to `DagViewLazy`.
 *
 * Spark's REST API does not expose the RDD operation graph; the backend parses it out of the job/stage HTML
 * (`docs/contracts/api.md` §4). When that route is missing or Spark's HTML had no `#dag-viz-metadata`, the panel says so
 * — it never draws an approximated graph.
 */
import { useQuery } from "@tanstack/react-query";
import { DagViewLazy } from "~/features/dag/react/DagViewLazy";
import { stageMetricsFromRest } from "~/features/dag/metrics";
import { EXPAND_LIMIT } from "~/features/dag/dag-model";
import type { Dag } from "~/features/dag/types";
import { useMemo, useSyncExternalStore } from "react";
import { fmtInt } from "~/lib/format";
import { Button } from "~/ui/button";
import { Datum, Entity } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { sp } from "../data/queries";
import type { SparkSqlExecution, SparkStage } from "../data/schemas";
import { SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "./StateViews";
import { useSpark } from "./context";

const PHONE_QUERY = "(max-width: 639px)";

export function DagVizHeading({ title }: { title: string }) {
  return (
    <div className="flex flex-wrap items-center justify-start gap-x-3 gap-y-1">
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      <span className="text-small text-ink-4">Powered by Burrow DagViz</span>
    </div>
  );
}

function subscribeToPhoneViewport(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getPhoneViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}

function usePhoneViewport(): boolean {
  return useSyncExternalStore(subscribeToPhoneViewport, getPhoneViewport, () => false);
}

interface PanelProps {
  height?: number;
  className?: string;
}

function MobileStageSummary({
  jobId,
  stages,
  loading,
  selectedStageId,
  onSelectStage,
}: {
  jobId: number;
  stages: SparkStage[];
  loading?: boolean;
  selectedStageId?: number;
  onSelectStage?: (stageId: number) => void;
}) {
  if (loading && stages.length === 0) {
    return (
      <p
        role="status"
        className="m-0 rounded-md border border-seam bg-well px-3 py-2 text-small text-ink-3"
        data-testid="mobile-dag-stage-summary"
      >
        Loading stage summary…
      </p>
    );
  }
  if (stages.length === 0) {
    return (
      <p className="m-0 rounded-md border border-seam bg-well px-3 py-2 text-small text-ink-3" data-testid="mobile-dag-stage-summary">
        Stage details are unavailable. Show the full graph to explore this job.
      </p>
    );
  }

  return (
    <ol
      aria-label={`Stages in Spark job ${jobId}`}
      className="m-0 list-none divide-y divide-seam-soft rounded-md border border-seam bg-well px-3"
      data-testid="mobile-dag-stage-summary"
    >
      {stages.map((stage) => {
        const id = `${stage.stageId}/${stage.attemptId ?? 0}`;
        const completed = stage.numCompletedIndices ?? stage.numCompleteTasks;
        const completedField = stage.numCompletedIndices != null ? "spark.stage.numCompletedIndices" : "spark.stage.numCompleteTasks";
        return (
          <Entity key={id} id={id} as="li" className="min-w-0">
            <button
              type="button"
              aria-label={`Stage ${stage.stageId}, ${stage.status ?? "unknown"}, ${fmtInt(completed)} of ${fmtInt(stage.numTasks)} tasks`}
              aria-pressed={selectedStageId === stage.stageId}
              className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left"
              onClick={() => onSelectStage?.(stage.stageId)}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-medium text-ink">
                    Stage{" "}
                    <Datum field="spark.stage.stageId" raw={stage.stageId} fmt="id">
                      {String(stage.stageId)}
                    </Datum>
                  </span>
                  <StatusPill domain="spark.stage" state={stage.status} field="spark.stage.status" size="sm" />
                </span>
                {stage.name && <Datum field="spark.stage.name" raw={stage.name} className="truncate text-caption text-ink-3" />}
              </span>
              <span className="shrink-0 text-small text-ink-2 tnum">
                <Datum field={completedField} raw={completed} fmt="int">
                  {fmtInt(completed)}
                </Datum>
                {" / "}
                <Datum field="spark.stage.numTasks" raw={stage.numTasks} fmt="int">
                  {fmtInt(stage.numTasks)}
                </Datum>
                {" tasks"}
              </span>
            </button>
          </Entity>
        );
      })}
    </ol>
  );
}

/** Job DAG: every stage of the job (including skipped ones) as a compound node, edges across stages. */
export function JobDagPanel({
  appId,
  jobId,
  stages,
  selectedStageId,
  onSelectStage,
  stagesLoading,
  expandStages,
  onExpandStagesChange,
  height = 460,
  className,
}: PanelProps & {
  appId: string;
  jobId: number;
  stages?: SparkStage[];
  selectedStageId?: number;
  onSelectStage?: (stageId: number) => void;
  stagesLoading?: boolean;
  expandStages?: boolean;
  onExpandStagesChange?: (expanded: boolean) => void;
}) {
  const { attempt } = useSpark();
  const phoneViewport = usePhoneViewport();
  const q = useQuery(sp.dagJob(appId, jobId, attempt));
  const metrics = useMemo(
    () => (stages?.length ? stageMetricsFromRest(stages as Parameters<typeof stageMetricsFromRest>[0]) : undefined),
    [stages],
  );

  if (q.isPending) return <SparkLoading rows={6} cols={1} />;
  if (q.error && !q.data)
    return <SparkFailureState error={q.error} subject={`the RDD graph of job ${jobId}`} onRetry={() => void q.refetch()} />;
  if (!q.data || q.data.stages.length === 0) {
    return (
      <>
        {q.error && <SparkStaleErrorBanner error={q.error} subject={`the RDD graph of job ${jobId}`} onRetry={() => void q.refetch()} />}
        <p className="rounded-md border border-dashed border-seam-strong bg-well px-2.5 py-2 text-small text-ink-3">
          Spark's job page carries no RDD graph for job {jobId} (no <code className="font-mono text-micro">#dag-viz-metadata</code> was
          emitted — common for jobs whose stages are all skipped).
        </p>
      </>
    );
  }
  const rddCount = q.data.stages.reduce((count, stage) => count + stage.nodes.length, 0);
  const canExpand = q.data.granularity === "rdd" && rddCount > 0;
  // A text stage list is readable at phone width; keep the graph available as an explicit drill-in.
  const expanded = expandStages ?? (q.data.kind === "job" ? !phoneViewport && rddCount <= EXPAND_LIMIT : true);
  const showStageList = phoneViewport && !expanded;
  const canToggle = canExpand || phoneViewport;
  return (
    <div className={className} data-burrow-dag={`job-${jobId}`}>
      {q.error && <SparkStaleErrorBanner error={q.error} subject={`the RDD graph of job ${jobId}`} onRetry={() => void q.refetch()} />}
      {canToggle && onExpandStagesChange && (
        <div className="mb-2 flex justify-end">
          <Button size="sm" variant="quiet" aria-pressed={expanded} onClick={() => onExpandStagesChange(!expanded)}>
            {phoneViewport ? (expanded ? "Show stage list" : "Show full graph") : expanded ? "Show stage summary" : "Expand RDD details"}
          </Button>
        </div>
      )}
      {phoneViewport && expanded && (
        <p className="m-0 text-caption text-ink-3" data-testid="mobile-dag-expanded-hint">
          The graph is focused on part of this job. Show the stage list to review every stage.
        </p>
      )}
      {showStageList ? (
        <MobileStageSummary
          jobId={jobId}
          stages={stages ?? []}
          loading={stagesLoading}
          selectedStageId={selectedStageId}
          onSelectStage={onSelectStage}
        />
      ) : (
        <DagViewLazy
          dag={q.data as unknown as Dag}
          metrics={metrics}
          selectedStageId={selectedStageId}
          onSelectStage={onSelectStage}
          expandStages={expanded}
          height={height}
          ariaLabel={`RDD graph of Spark job ${jobId}`}
        />
      )}
    </div>
  );
}

/** Stage DAG: the RDD operator chain of one stage attempt. */
export function StageDagPanel({
  appId,
  stageId,
  attemptId,
  stage,
  onSelectRdd,
  height = 420,
  className,
}: PanelProps & {
  appId: string;
  stageId: number;
  attemptId: number;
  stage?: SparkStage | null;
  onSelectRdd?: (rddId: number) => void;
}) {
  const { attempt } = useSpark();
  const q = useQuery(sp.dagStage(appId, stageId, attemptId, attempt));
  const metrics = useMemo(() => (stage ? stageMetricsFromRest([stage] as Parameters<typeof stageMetricsFromRest>[0]) : undefined), [stage]);

  if (q.isPending) return <SparkLoading rows={5} cols={1} />;
  if (q.error && !q.data)
    return (
      <SparkFailureState error={q.error} subject={`the RDD graph of stage ${stageId}.${attemptId}`} onRetry={() => void q.refetch()} />
    );
  if (!q.data || q.data.stages.every((s) => s.nodes.length === 0)) {
    return (
      <>
        {q.error && (
          <SparkStaleErrorBanner
            error={q.error}
            subject={`the RDD graph of stage ${stageId}.${attemptId}`}
            onRetry={() => void q.refetch()}
          />
        )}
        <p className="rounded-md border border-dashed border-seam-strong bg-well px-2.5 py-2 text-small text-ink-3">
          This stage attempt has no RDD graph (Spark omits it for stages with no shuffle boundaries and for reused/skipped output).
        </p>
      </>
    );
  }
  return (
    <div className={className} data-burrow-dag={`stage-${stageId}-${attemptId}`}>
      {q.error && (
        <SparkStaleErrorBanner
          error={q.error}
          subject={`the RDD graph of stage ${stageId}.${attemptId}`}
          onRetry={() => void q.refetch()}
        />
      )}
      <DagViewLazy
        dag={q.data as unknown as Dag}
        metrics={metrics}
        onSelectRdd={onSelectRdd}
        height={height}
        ariaLabel={`RDD graph of Spark stage ${stageId} attempt ${attemptId}`}
      />
    </div>
  );
}

/**
 * SQL plan DAG. The backend's `/sql/{id}?details=true&planDescription=true` returns the same execution object the Spark
 * UI draws from (`nodes[].nodeId/nodeName/wholeStageCodegenId/metrics`, `edges[].fromId/toId`) — DagViz auto-detects it.
 */
export function SqlPlanDag({ execution, height = 520, className }: PanelProps & { execution: SparkSqlExecution }) {
  const nodes = execution.nodes ?? [];
  if (nodes.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-seam-strong bg-well px-2.5 py-2 text-small text-ink-3">
        No plan graph for SQL execution {execution.id}: Spark only returns <code className="font-mono text-micro">nodes</code>/
        <code className="font-mono text-micro">edges</code> when <code className="font-mono text-micro">planDescription=true</code> is
        accepted, and AQE executions keep the final plan only.
      </p>
    );
  }
  return (
    <div className={className} data-burrow-dag={`sql-${execution.id}`}>
      <DagViewLazy dag={execution as unknown as Dag} height={height} ariaLabel={`Spark SQL plan for execution ${execution.id}`} />
    </div>
  );
}
