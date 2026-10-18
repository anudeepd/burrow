/**
 * Spark query factories — one per contract route (docs/contracts/api.md §4). Pages/loaders only ever use these.
 * Owned by the Spark slice: imported directly by `web/src/features/spark/**`, deliberately NOT merged into
 * `web/src/api/queries.ts` (shared file).
 *
 * Every factory carries `meta.topic` (SSE topic = API path minus `/api/` + canonical query) and the adaptive refetch
 * policy. `kind` is chosen by the caller: "live" for a RUNNING app (1–3 s), "static" for a finished app / history mode
 * (Spark's history data is immutable; the SHS itself caches nothing, so we do not poll it).
 */
import { queryOptions } from "@tanstack/react-query";
import type { ZodType } from "zod";
import { type Query, apiGet, topicOf } from "~/api/client";
import { adaptive, type RefetchKind } from "~/api/refetch";
import {
  SparkApplicationSchema,
  SparkDagSchema,
  SparkEnvironmentSchema,
  SparkExecutorsSchema,
  SparkJobSchema,
  SparkJobsSchema,
  SparkRddResponseSchema,
  SparkRddsSchema,
  SparkSourceSchema,
  SparkSqlExecutionSchema,
  SparkSqlExecutionsSchema,
  SparkStageSchema,
  SparkStagesSchema,
  SparkStreamingBatchesSchema,
  SparkStreamingBatchSchema,
  SparkStreamingReceiversSchema,
  SparkStreamingStatisticsSchema,
  SparkTaskSummarySchema,
  SparkTasksSchema,
  type SparkTask,
} from "./schemas";

const enc = encodeURIComponent;

type Kind = RefetchKind;

function spark<S extends ZodType>(key: readonly unknown[], path: string, schema: S, kind: Kind, query?: Query) {
  const attempt = query?.attempt;
  return queryOptions({
    queryKey: attempt == null ? key : [...key, "attempt", attempt],
    queryFn: ({ signal }) => apiGet(path, { schema, signal, query }),
    ...adaptive(kind, { topic: topicOf(path, query) }),
  });
}

export const sp = {
  source: (appId: string, attempt?: string | null) =>
    spark(["spark", appId, "source"], `spark/${enc(appId)}/source`, SparkSourceSchema, "slow", attempt ? { attempt } : undefined),

  application: (appId: string, kind: Kind = "live") =>
    spark(["spark", appId, "application"], `spark/${enc(appId)}/application`, SparkApplicationSchema, kind),

  jobs: (appId: string, opts?: { status?: string; kind?: Kind; attempt?: string | null }) =>
    spark(["spark", appId, "jobs", opts?.status ?? ""], `spark/${enc(appId)}/jobs`, SparkJobsSchema, opts?.kind ?? "live", {
      ...(opts?.status ? { status: opts.status } : {}),
      ...(opts?.attempt ? { attempt: opts.attempt } : {}),
    }),

  job: (appId: string, jobId: number | string, kind: Kind = "static", attempt?: string | null) =>
    spark(
      ["spark", appId, "jobs", String(jobId)],
      `spark/${enc(appId)}/jobs/${enc(String(jobId))}`,
      SparkJobSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),

  /** `/stages` (optionally with `details`/`withSummaries`/`quantiles`/`taskStatus`/`status`). */
  stages: (
    appId: string,
    opts?: {
      status?: string;
      details?: boolean;
      withSummaries?: boolean;
      quantiles?: readonly number[];
      taskStatus?: string;
      kind?: Kind;
      attempt?: string | null;
    },
  ) => {
    const query: Query = {};
    if (opts?.status) query.status = opts.status;
    if (opts?.details) query.details = true;
    if (opts?.withSummaries) query.withSummaries = true;
    if (opts?.quantiles?.length) query.quantiles = opts.quantiles.join(",");
    if (opts?.taskStatus) query.taskStatus = opts.taskStatus;
    if (opts?.attempt) query.attempt = opts.attempt;
    return spark(
      ["spark", appId, "stages", query],
      `spark/${enc(appId)}/stages`,
      SparkStagesSchema,
      opts?.kind ?? "live",
      Object.keys(query).length ? query : undefined,
    );
  },

  /** `/stages/{stageId}` → one entry per attempt (Spark REST returns an array). */
  stageAttempts: (appId: string, stageId: number | string, kind: Kind = "static", attempt?: string | null) =>
    spark(
      ["spark", appId, "stages", String(stageId)],
      `spark/${enc(appId)}/stages/${enc(String(stageId))}`,
      SparkStagesSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),

  stageAttempt: (
    appId: string,
    stageId: number | string,
    attemptId: number | string,
    opts?: { details?: boolean; withSummaries?: boolean; quantiles?: readonly number[]; kind?: Kind; attempt?: string | null },
  ) => {
    const query: Query = {};
    if (opts?.details) query.details = true;
    if (opts?.withSummaries) query.withSummaries = true;
    if (opts?.quantiles?.length) query.quantiles = opts.quantiles.join(",");
    if (opts?.attempt) query.attempt = opts.attempt;
    return spark(
      ["spark", appId, "stages", String(stageId), String(attemptId), query],
      `spark/${enc(appId)}/stages/${enc(String(stageId))}/${enc(String(attemptId))}`,
      SparkStageSchema,
      opts?.kind ?? "static",
      Object.keys(query).length ? query : undefined,
    );
  },

  taskSummary: (
    appId: string,
    stageId: number | string,
    attemptId: number | string,
    quantiles: readonly number[] = [0.05, 0.25, 0.5, 0.75, 0.95],
    kind: Kind = "static",
    attempt?: string | null,
  ) =>
    spark(
      ["spark", appId, "stages", String(stageId), String(attemptId), "taskSummary", quantiles.join(",")],
      `spark/${enc(appId)}/stages/${enc(String(stageId))}/${enc(String(attemptId))}/taskSummary`,
      SparkTaskSummarySchema,
      kind,
      { quantiles: quantiles.join(","), ...(attempt ? { attempt } : {}) },
    ),

  taskList: (
    appId: string,
    stageId: number | string,
    attemptId: number | string,
    opts?: { offset?: number; length?: number; sortBy?: string; status?: string; kind?: Kind; attempt?: string | null },
  ) => {
    const query: Query = {};
    if (opts?.offset != null) query.offset = opts.offset;
    if (opts?.length != null) query.length = opts.length;
    if (opts?.sortBy) query.sortBy = opts.sortBy;
    if (opts?.status) query.status = opts.status;
    if (opts?.attempt) query.attempt = opts.attempt;
    return spark(
      ["spark", appId, "stages", String(stageId), String(attemptId), "taskList", query],
      `spark/${enc(appId)}/stages/${enc(String(stageId))}/${enc(String(attemptId))}/taskList`,
      SparkTasksSchema,
      opts?.kind ?? "static",
      Object.keys(query).length ? query : undefined,
    );
  },

  /** Spark defaults taskList to only 20 rows. Read explicit bounded pages until every retained task is loaded. */
  allTasks: (appId: string, stageId: number | string, attemptId: number | string, kind: Kind = "static", attempt?: string | null) => {
    const path = `spark/${enc(appId)}/stages/${enc(String(stageId))}/${enc(String(attemptId))}/taskList`;
    const queryKey: readonly unknown[] = ["spark", appId, "stages", String(stageId), String(attemptId), "allTasks", attempt ?? ""];
    return queryOptions({
      queryKey,
      queryFn: async ({ signal }) => {
        const result: SparkTask[] = [];
        const length = 1000;
        for (let offset = 0; ; offset += length) {
          const page = await apiGet(path, { schema: SparkTasksSchema, signal, query: { offset, length, ...(attempt ? { attempt } : {}) } });
          result.push(...page);
          if (page.length < length) return result;
        }
      },
      ...adaptive(kind),
    });
  },

  executors: (appId: string, kind: Kind = "live", attempt?: string | null) =>
    spark(["spark", appId, "executors"], `spark/${enc(appId)}/executors`, SparkExecutorsSchema, kind, attempt ? { attempt } : undefined),
  /** Every executor that ever ran, including dead ones (`allexecutors`). */
  allExecutors: (appId: string, kind: Kind = "static", attempt?: string | null) =>
    spark(
      ["spark", appId, "allexecutors"],
      `spark/${enc(appId)}/allexecutors`,
      SparkExecutorsSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),

  rdds: (appId: string, kind: Kind = "live", attempt?: string | null) =>
    spark(["spark", appId, "storage", "rdd"], `spark/${enc(appId)}/storage/rdd`, SparkRddsSchema, kind, attempt ? { attempt } : undefined),
  rdd: (appId: string, rddId: number | string, kind: Kind = "static", attempt?: string | null) =>
    spark(
      ["spark", appId, "storage", "rdd", String(rddId)],
      `spark/${enc(appId)}/storage/rdd/${enc(String(rddId))}`,
      SparkRddResponseSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),

  environment: (appId: string, attempt?: string | null) =>
    spark(
      ["spark", appId, "environment"],
      `spark/${enc(appId)}/environment`,
      SparkEnvironmentSchema,
      "static",
      attempt ? { attempt } : undefined,
    ),

  sql: (
    appId: string,
    opts?: { details?: boolean; planDescription?: boolean; offset?: number; length?: number; kind?: Kind; attempt?: string | null },
  ) => {
    const query: Query = {};
    if (opts?.details) query.details = true;
    if (opts?.planDescription) query.planDescription = true;
    if (opts?.offset != null) query.offset = opts.offset;
    if (opts?.length != null) query.length = opts.length;
    if (opts?.attempt) query.attempt = opts.attempt;
    return spark(
      ["spark", appId, "sql", query],
      `spark/${enc(appId)}/sql`,
      SparkSqlExecutionsSchema,
      opts?.kind ?? "static",
      Object.keys(query).length ? query : undefined,
    );
  },

  sqlExecution: (
    appId: string,
    executionId: number | string,
    opts?: { details?: boolean; planDescription?: boolean; kind?: Kind; attempt?: string | null },
  ) => {
    const query: Query = {};
    if (opts?.details !== false) query.details = true;
    if (opts?.planDescription !== false) query.planDescription = true;
    if (opts?.attempt) query.attempt = opts.attempt;
    return spark(
      ["spark", appId, "sql", String(executionId), query],
      `spark/${enc(appId)}/sql/${enc(String(executionId))}`,
      SparkSqlExecutionSchema,
      opts?.kind ?? "static",
      query,
    );
  },

  streamingStatistics: (appId: string, kind: Kind = "live", attempt?: string | null) =>
    spark(
      ["spark", appId, "streaming", "statistics"],
      `spark/${enc(appId)}/streaming/statistics`,
      SparkStreamingStatisticsSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),
  streamingReceivers: (appId: string, kind: Kind = "live", attempt?: string | null) =>
    spark(
      ["spark", appId, "streaming", "receivers"],
      `spark/${enc(appId)}/streaming/receivers`,
      SparkStreamingReceiversSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),
  streamingBatches: (appId: string, kind: Kind = "static", attempt?: string | null) =>
    spark(
      ["spark", appId, "streaming/batches"],
      `spark/${enc(appId)}/streaming/batches`,
      SparkStreamingBatchesSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),
  streamingBatch: (appId: string, batchId: number | string, kind: Kind = "static", attempt?: string | null) =>
    spark(
      ["spark", appId, "streaming", "batches", String(batchId)],
      `spark/${enc(appId)}/streaming/batches/${enc(String(batchId))}`,
      SparkStreamingBatchSchema,
      kind,
      attempt ? { attempt } : undefined,
    ),

  dagJob: (appId: string, jobId: number | string, attempt?: string | null) =>
    spark(
      ["spark", appId, "dag", "jobs", String(jobId)],
      `spark/${enc(appId)}/dag/jobs/${enc(String(jobId))}`,
      SparkDagSchema,
      "static",
      attempt ? { attempt } : undefined,
    ),
  dagStage: (appId: string, stageId: number | string, attemptId: number | string, attempt?: string | null) =>
    spark(
      ["spark", appId, "dag", "stages", String(stageId), String(attemptId)],
      `spark/${enc(appId)}/dag/stages/${enc(String(stageId))}/${enc(String(attemptId))}`,
      SparkDagSchema,
      "static",
      attempt ? { attempt } : undefined,
    ),
};
