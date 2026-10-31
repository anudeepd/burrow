/**
 * Spark REST payload schemas (Spark 3.5.x + 4.x, `/api/v1/applications/{id}/…`).
 *
 * Field coverage mirrors the Spark UI's own model classes:
 *   ApplicationInfo · JobData · StageData · TaskData · ExecutorSummary · RDDStorageInfo · RDDPartitionInfo ·
 *   EnvironmentInfo · SQLExecutionUIData (+ SparkPlanGraphNode/Edge) · StreamingStatistics/BatchInfo/ReceiverInfo.
 *
 * Shapes verified against `fixtures/spark/{3.5.9,4.2.0}/<workload>/rest/*.json` (16 workloads). Where Spark's own UI
 * computes a value from REST keys (elapsed, fractions, quantile labels) the schema keeps the REST keys verbatim and the
 * UI stamps a `spark.<entity>.derived.*` field id.
 *
 * Strictness follows `_base.obj()`: unknown keys pass through in production, are rejected in strict test mode.
 */
import { z } from "zod";
import { listOf, num, obj } from "~/api/schemas/_base";

const str = z.string();
const strOpt = z.string().nullish();

/* ── shared ─────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Spark REST timestamps: `2026-10-03T06:49:08.233GMT` (also `…+0000` on some builds). Kept as the raw string. */
export const SparkTime = strOpt;

/** Known `JobData.status` / stage statuses. Field types stay lenient strings (newer Spark may add one). */
export const SPARK_JOB_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;
export const SPARK_STAGE_STATUSES = ["ACTIVE", "COMPLETE", "FAILED", "PENDING", "SKIPPED"] as const;
export const SPARK_TASK_STATUSES = ["PENDING", "RUNNING", "SUCCESS", "FAILED", "KILLED"] as const;
export const SPARK_SQL_STATUSES = ["COMPLETED", "RUNNING", "FAILED"] as const;

/** A Java `Map<K, V>` that Spark's Jackson marshals as a plain JSON object (e.g. `killedTasksSummary`, `executorLogs`). */
const looseMap = z.record(str, z.unknown());

/* ── task metrics ───────────────────────────────────────────────────────────────────────────────────────────── */

export const InputMetricsSchema = obj({
  bytesRead: num.nullish(),
  recordsRead: num.nullish(),
});
export type InputMetrics = z.infer<typeof InputMetricsSchema>;

export const OutputMetricsSchema = obj({
  bytesWritten: num.nullish(),
  recordsWritten: num.nullish(),
});
export type OutputMetrics = z.infer<typeof OutputMetricsSchema>;

export const ShufflePushReadMetricsSchema = obj({
  corruptMergedBlockChunks: num.nullish(),
  localMergedBlocksFetched: num.nullish(),
  localMergedBytesRead: num.nullish(),
  localMergedChunksFetched: num.nullish(),
  mergedFetchFallbackCount: num.nullish(),
  remoteMergedBlocksFetched: num.nullish(),
  remoteMergedBytesRead: num.nullish(),
  remoteMergedChunksFetched: num.nullish(),
  remoteMergedReqsDuration: num.nullish(),
});
export type ShufflePushReadMetrics = z.infer<typeof ShufflePushReadMetricsSchema>;

export const ShuffleReadMetricsSchema = obj({
  fetchWaitTime: num.nullish(),
  localBlocksFetched: num.nullish(),
  localBytesRead: num.nullish(),
  recordsRead: num.nullish(),
  remoteBlocksFetched: num.nullish(),
  remoteBytesRead: num.nullish(),
  remoteBytesReadToDisk: num.nullish(),
  remoteReqsDuration: num.nullish(),
  shufflePushReadMetrics: ShufflePushReadMetricsSchema.nullish(),
});
export type ShuffleReadMetrics = z.infer<typeof ShuffleReadMetricsSchema>;

export const ShuffleWriteMetricsSchema = obj({
  bytesWritten: num.nullish(),
  recordsWritten: num.nullish(),
  writeTime: num.nullish(),
});
export type ShuffleWriteMetrics = z.infer<typeof ShuffleWriteMetricsSchema>;

/** `TaskMetrics` as nested under every `TaskData.taskMetrics`. */
export const TaskMetricsSchema = obj({
  executorDeserializeTime: num.nullish(),
  executorDeserializeCpuTime: num.nullish(),
  executorRunTime: num.nullish(),
  executorCpuTime: num.nullish(),
  resultSize: num.nullish(),
  jvmGcTime: num.nullish(),
  resultSerializationTime: num.nullish(),
  memoryBytesSpilled: num.nullish(),
  diskBytesSpilled: num.nullish(),
  peakExecutionMemory: num.nullish(),
  inputMetrics: InputMetricsSchema.nullish(),
  outputMetrics: OutputMetricsSchema.nullish(),
  shuffleReadMetrics: ShuffleReadMetricsSchema.nullish(),
  shuffleWriteMetrics: ShuffleWriteMetricsSchema.nullish(),
});
export type TaskMetrics = z.infer<typeof TaskMetricsSchema>;

/* ── application ────────────────────────────────────────────────────────────────────────────────────────────── */

export const SparkAttemptSchema = obj({
  attemptId: strOpt,
  startTime: SparkTime,
  endTime: SparkTime,
  lastUpdated: SparkTime,
  duration: num.nullish(),
  sparkUser: strOpt,
  completed: z.boolean().nullish(),
  appSparkVersion: strOpt,
  startTimeEpoch: num.nullish(),
  endTimeEpoch: num.nullish(),
  lastUpdatedEpoch: num.nullish(),
});
export type SparkAttempt = z.infer<typeof SparkAttemptSchema>;

export const SparkApplicationSchema = obj({
  id: str,
  name: strOpt,
  attempts: listOf(SparkAttemptSchema),
});
export type SparkApplication = z.infer<typeof SparkApplicationSchema>;

export const SparkApplicationsSchema = listOf(SparkApplicationSchema);
export const SparkApplicationResponseSchema = obj({ app: SparkApplicationSchema });

/* ── jobs ───────────────────────────────────────────────────────────────────────────────────────────────────── */

export const SparkJobSchema = obj({
  jobId: num,
  name: strOpt,
  description: strOpt,
  submissionTime: SparkTime,
  completionTime: SparkTime,
  stageIds: listOf(num),
  jobTags: listOf(str),
  status: strOpt,
  numTasks: num.nullish(),
  numActiveTasks: num.nullish(),
  numCompletedTasks: num.nullish(),
  numSkippedTasks: num.nullish(),
  numFailedTasks: num.nullish(),
  numKilledTasks: num.nullish(),
  numCompletedIndices: num.nullish(),
  numActiveStages: num.nullish(),
  numCompletedStages: num.nullish(),
  numSkippedStages: num.nullish(),
  numFailedStages: num.nullish(),
  killedTasksSummary: looseMap.nullish(),
  /** Present on `/jobs` rows produced by SQL/DataFrame jobs (Spark's job-group label). */
  jobGroup: strOpt,
});
export type SparkJob = z.infer<typeof SparkJobSchema>;
export const SparkJobsSchema = listOf(SparkJobSchema);

/* ── stages ─────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Quantile arrays: index-aligned with the request's `quantiles` parameter. */
const QuantileValues = listOf(num);

const TASK_METRIC_QUANTILE_SHAPE = {
  quantiles: QuantileValues.nullish(),
  duration: QuantileValues.nullish(),
  executorDeserializeTime: QuantileValues.nullish(),
  executorDeserializeCpuTime: QuantileValues.nullish(),
  executorRunTime: QuantileValues.nullish(),
  executorCpuTime: QuantileValues.nullish(),
  resultSize: QuantileValues.nullish(),
  jvmGcTime: QuantileValues.nullish(),
  resultSerializationTime: QuantileValues.nullish(),
  gettingResultTime: QuantileValues.nullish(),
  schedulerDelay: QuantileValues.nullish(),
  peakExecutionMemory: QuantileValues.nullish(),
  memoryBytesSpilled: QuantileValues.nullish(),
  diskBytesSpilled: QuantileValues.nullish(),
  failedTasks: QuantileValues.nullish(),
  killedTasks: QuantileValues.nullish(),
  inputMetrics: obj({ bytesRead: QuantileValues.nullish(), recordsRead: QuantileValues.nullish() }).nullish(),
  outputMetrics: obj({ bytesWritten: QuantileValues.nullish(), recordsWritten: QuantileValues.nullish() }).nullish(),
  shuffleReadMetrics: obj({
    readBytes: QuantileValues.nullish(),
    readRecords: QuantileValues.nullish(),
    remoteBlocksFetched: QuantileValues.nullish(),
    localBlocksFetched: QuantileValues.nullish(),
    fetchWaitTime: QuantileValues.nullish(),
    remoteBytesRead: QuantileValues.nullish(),
    remoteBytesReadToDisk: QuantileValues.nullish(),
    totalBlocksFetched: QuantileValues.nullish(),
    remoteReqsDuration: QuantileValues.nullish(),
    shufflePushReadMetricsDist: z.record(str, z.unknown()).nullish(),
  }).nullish(),
  shuffleWriteMetrics: obj({
    writeBytes: QuantileValues.nullish(),
    writeRecords: QuantileValues.nullish(),
    writeTime: QuantileValues.nullish(),
  }).nullish(),
  /** Shuffle-push (push-based shuffle) quantiles, present on 3.2+. */
  shufflePushReadMetricsDist: z.record(str, z.unknown()).nullish(),
  remoteReqsDuration: QuantileValues.nullish(),
};

export const TaskMetricsDistributionsSchema = obj({
  ...TASK_METRIC_QUANTILE_SHAPE,
  /** Optional executor-level metrics (`spark.executor.metrics.pollingInterval`): same quantile arrays per key. */
  executorMetricsDistributions: z.record(str, z.unknown()).nullish(),
});
export type TaskMetricsDistributions = z.infer<typeof TaskMetricsDistributionsSchema>;

export const SparkStageSchema = obj({
  status: strOpt,
  stageId: num,
  attemptId: num.nullish(),
  name: strOpt,
  description: strOpt,
  details: strOpt,
  /** Populated by Spark for FAILED stages: the task failure summary shown in the stage list's "Failure Reason" column. */
  failureReason: strOpt,
  numTasks: num.nullish(),
  numActiveTasks: num.nullish(),
  numCompleteTasks: num.nullish(),
  numFailedTasks: num.nullish(),
  numKilledTasks: num.nullish(),
  numCompletedIndices: num.nullish(),
  submissionTime: SparkTime,
  firstTaskLaunchedTime: SparkTime,
  completionTime: SparkTime,
  executorDeserializeTime: num.nullish(),
  executorDeserializeCpuTime: num.nullish(),
  executorRunTime: num.nullish(),
  executorCpuTime: num.nullish(),
  resultSize: num.nullish(),
  jvmGcTime: num.nullish(),
  resultSerializationTime: num.nullish(),
  memoryBytesSpilled: num.nullish(),
  diskBytesSpilled: num.nullish(),
  peakExecutionMemory: num.nullish(),
  inputBytes: num.nullish(),
  inputRecords: num.nullish(),
  outputBytes: num.nullish(),
  outputRecords: num.nullish(),
  shuffleRemoteBlocksFetched: num.nullish(),
  shuffleLocalBlocksFetched: num.nullish(),
  shuffleFetchWaitTime: num.nullish(),
  shuffleRemoteBytesRead: num.nullish(),
  shuffleRemoteBytesReadToDisk: num.nullish(),
  shuffleLocalBytesRead: num.nullish(),
  shuffleReadBytes: num.nullish(),
  shuffleReadRecords: num.nullish(),
  shuffleCorruptMergedBlockChunks: num.nullish(),
  shuffleMergedFetchFallbackCount: num.nullish(),
  shuffleMergedRemoteBlocksFetched: num.nullish(),
  shuffleMergedLocalBlocksFetched: num.nullish(),
  shuffleMergedRemoteChunksFetched: num.nullish(),
  shuffleMergedLocalChunksFetched: num.nullish(),
  shuffleMergedRemoteBytesRead: num.nullish(),
  shuffleMergedLocalBytesRead: num.nullish(),
  shuffleRemoteReqsDuration: num.nullish(),
  shuffleMergedRemoteReqsDuration: num.nullish(),
  shuffleWriteBytes: num.nullish(),
  shuffleWriteRecords: num.nullish(),
  shuffleWriteTime: num.nullish(),
  shuffleMergersCount: num.nullish(),
  rddIds: listOf(num),
  schedulingPool: strOpt,
  resourceProfileId: num.nullish(),
  killedTasksSummary: looseMap.nullish(),
  accumulatorUpdates: listOf(z.unknown()),
  peakExecutorMetrics: looseMap.nullish(),
  executorSummary: looseMap.nullish(),
  isShufflePushEnabled: z.boolean().nullish(),
  /** Present when `details=true&withSummaries=true`: per-executor metric quantiles keyed by metric name,
   *  including `peakMemoryMetrics.<Key>` (where Spark's stage page reads peak JVM heap / on- and off-heap execution). */
  executorMetricsDistributions: z.record(str, z.unknown()).nullish(),
  /** Task-type breakdown (`{"SUCCESS":…}`) returned alongside `executorSummary`. */
  tasks: z.record(str, z.unknown()).nullish(),
  /** Shuffle-push (MergedShuffleFileManager) totals; only present on 3.2+ with push-based shuffle enabled. */
  shufflePushReadMetrics: z.record(str, z.unknown()).nullish(),
  shufflePushReadMetricsDist: z.record(str, z.unknown()).nullish(),
  remoteReqsDuration: num.nullish(),
  taskMetricsDistributions: TaskMetricsDistributionsSchema.nullish(),
});
export type SparkStage = z.infer<typeof SparkStageSchema>;
export const SparkStagesSchema = listOf(SparkStageSchema);
export const SparkStageResponseSchema = obj({ stage: SparkStageSchema.nullish() });

export const SparkTaskSummarySchema = obj(TASK_METRIC_QUANTILE_SHAPE);
export type SparkTaskSummary = z.infer<typeof SparkTaskSummarySchema>;

/* ── tasks ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export const SparkTaskSchema = obj({
  taskId: num,
  index: num.nullish(),
  attempt: num.nullish(),
  partitionId: num.nullish(),
  /** Spark REST emits this as a GMT string (`2026-10-03T07:06:01.867GMT`), unlike `JobData.submissionTime` style ms. */
  launchTime: SparkTime,
  duration: num.nullish(),
  executorId: strOpt,
  host: strOpt,
  status: strOpt,
  taskLocality: strOpt,
  speculative: z.boolean().nullish(),
  gettingResultTime: num.nullish(),
  schedulerDelay: num.nullish(),
  errorMessage: strOpt,
  killed: z.boolean().nullish(),
  /** Per-executor log links (`{"stdout": "…"}`); present on every task row in Spark 3.x/4.x. */
  executorLogs: z.record(str, str).nullish(),
  taskMetrics: TaskMetricsSchema.nullish(),
  accumulatorUpdates: listOf(z.unknown()),
});
export type SparkTask = z.infer<typeof SparkTaskSchema>;
export const SparkTasksSchema = listOf(SparkTaskSchema);

/* ── executors ──────────────────────────────────────────────────────────────────────────────────────────────── */

export const MemoryMetricsSchema = obj({
  usedOnHeapStorageMemory: num.nullish(),
  usedOffHeapStorageMemory: num.nullish(),
  totalOnHeapStorageMemory: num.nullish(),
  totalOffHeapStorageMemory: num.nullish(),
});
export type MemoryMetrics = z.infer<typeof MemoryMetricsSchema>;

export const SparkExecutorSchema = obj({
  id: str,
  hostPort: strOpt,
  isActive: z.boolean().nullish(),
  isBlacklisted: z.boolean().nullish(),
  rddBlocks: num.nullish(),
  memoryUsed: num.nullish(),
  diskUsed: num.nullish(),
  totalCores: num.nullish(),
  maxTasks: num.nullish(),
  activeTasks: num.nullish(),
  failedTasks: num.nullish(),
  completedTasks: num.nullish(),
  totalTasks: num.nullish(),
  totalDuration: num.nullish(),
  totalGCTime: num.nullish(),
  totalInputBytes: num.nullish(),
  totalShuffleRead: num.nullish(),
  totalShuffleWrite: num.nullish(),
  maxMemory: num.nullish(),
  addTime: SparkTime,
  removeTime: SparkTime,
  removeReason: strOpt,
  executorLogs: z.record(str, str).nullish(),
  memoryMetrics: MemoryMetricsSchema.nullish(),
  blacklistedInStages: listOf(num),
  peakMemoryMetrics: looseMap.nullish(),
  attributes: looseMap.nullish(),
  resources: z.record(str, z.unknown()).nullish(),
  /** 4.x: nodes that excluded this executor, and the executor's request profile. */
  excludedInStages: listOf(num).nullish(),
  isExcluded: z.boolean().nullish(),
  resourceProfileId: num.nullish(),
});
export type SparkExecutor = z.infer<typeof SparkExecutorSchema>;
export const SparkExecutorsSchema = listOf(SparkExecutorSchema);

/* ── storage ────────────────────────────────────────────────────────────────────────────────────────────────── */

export const RddPartitionSchema = obj({
  blockName: strOpt,
  storageLevel: strOpt,
  memoryUsed: num.nullish(),
  diskUsed: num.nullish(),
  executors: listOf(str),
});
export type RddPartition = z.infer<typeof RddPartitionSchema>;

export const RddDataDistributionSchema = obj({
  address: strOpt,
  memoryUsed: num.nullish(),
  memoryRemaining: num.nullish(),
  diskUsed: num.nullish(),
  onHeapMemoryUsed: num.nullish(),
  offHeapMemoryUsed: num.nullish(),
  onHeapMemoryRemaining: num.nullish(),
  offHeapMemoryRemaining: num.nullish(),
});
export type RddDataDistribution = z.infer<typeof RddDataDistributionSchema>;

export const SparkRddSchema = obj({
  id: num,
  name: strOpt,
  numPartitions: num.nullish(),
  numCachedPartitions: num.nullish(),
  storageLevel: strOpt,
  memoryUsed: num.nullish(),
  diskUsed: num.nullish(),
  dataDistribution: listOf(RddDataDistributionSchema),
  partitions: listOf(RddPartitionSchema),
});
export type SparkRdd = z.infer<typeof SparkRddSchema>;
export const SparkRddsSchema = listOf(SparkRddSchema);
/** Live Spark REST returns the RDD object directly; history/proxy adapters may wrap it as `{ rdd }`. */
export const SparkRddResponseSchema = z.preprocess(
  (value) => (typeof value === "object" && value !== null && "rdd" in value ? value : { rdd: value }),
  obj({ rdd: SparkRddSchema.nullish() }),
);

/* ── environment ────────────────────────────────────────────────────────────────────────────────────────────── */

/** `["key","value"]` pairs, as Spark emits `Seq[(String,String)]`. */
export const PropertyPairsSchema = listOf(listOf(str));
export const ClasspathEntrySchema = listOf(str);
export const SparkRuntimeSchema = obj({
  javaVersion: strOpt,
  javaHome: strOpt,
  scalaVersion: strOpt,
});

export const SparkEnvironmentSchema = obj({
  sparkProperties: PropertyPairsSchema.nullish(),
  systemProperties: PropertyPairsSchema.nullish(),
  classpathEntries: listOf(ClasspathEntrySchema).nullish(),
  hadoopProperties: PropertyPairsSchema.nullish(),
  metricsProperties: PropertyPairsSchema.nullish(),
  resourceProfiles: listOf(z.unknown()).nullish(),
  runtime: SparkRuntimeSchema.nullish(),
});
export type SparkEnvironment = z.infer<typeof SparkEnvironmentSchema>;

/* ── SQL ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const SparkSqlPlanNodeSchema = obj({
  nodeId: num,
  nodeName: strOpt,
  planLine: strOpt,
  wholeStageCodegenId: num.nullish(),
  metrics: listOf(obj({ name: strOpt, value: strOpt })).nullish(),
});
export type SparkSqlPlanNode = z.infer<typeof SparkSqlPlanNodeSchema>;

export const SparkSqlPlanEdgeSchema = obj({ fromId: num, toId: num });
export type SparkSqlPlanEdge = z.infer<typeof SparkSqlPlanEdgeSchema>;

export const SparkSqlExecutionSchema = obj({
  id: num,
  status: strOpt,
  description: strOpt,
  submissionTime: SparkTime,
  completionTime: SparkTime,
  duration: num.nullish(),
  queryId: strOpt,
  rootExecutionId: num.nullish(),
  planDescription: strOpt,
  nodes: listOf(SparkSqlPlanNodeSchema).nullish(),
  edges: listOf(SparkSqlPlanEdgeSchema).nullish(),
  runningJobIds: listOf(num).nullish(),
  successJobIds: listOf(num).nullish(),
  failedJobIds: listOf(num).nullish(),
  errorMessage: strOpt,
});
export type SparkSqlExecution = z.infer<typeof SparkSqlExecutionSchema>;
export const SparkSqlExecutionsSchema = listOf(SparkSqlExecutionSchema);

/* ── streaming ──────────────────────────────────────────────────────────────────────────────────────────────── */

export const SparkStreamingStatisticsSchema = obj({
  startTime: SparkTime,
  batchDuration: num.nullish(),
  numReceivers: num.nullish(),
  numActiveReceivers: num.nullish(),
  numInactiveReceivers: num.nullish(),
  numTotalCompletedBatches: num.nullish(),
  numRetainedCompletedBatches: num.nullish(),
  numActiveBatches: num.nullish(),
  numProcessedRecords: num.nullish(),
  numReceivedRecords: num.nullish(),
  avgInputRate: num.nullish(),
  avgSchedulingDelay: num.nullish(),
  avgProcessingTime: num.nullish(),
  avgTotalDelay: num.nullish(),
});
export type SparkStreamingStatistics = z.infer<typeof SparkStreamingStatisticsSchema>;

export const SparkStreamingBatchSchema = obj({
  batchId: num,
  batchTime: SparkTime,
  status: strOpt,
  batchDuration: num.nullish(),
  inputSize: num.nullish(),
  schedulingDelay: num.nullish(),
  processingTime: num.nullish(),
  totalDelay: num.nullish(),
  numActiveOutputOps: num.nullish(),
  numCompletedOutputOps: num.nullish(),
  numFailedOutputOps: num.nullish(),
  numTotalOutputOps: num.nullish(),
});
export type SparkStreamingBatch = z.infer<typeof SparkStreamingBatchSchema>;

export const SparkStreamingReceiverSchema = obj({
  streamId: num.nullish(),
  streamName: strOpt,
  avgEventRate: num.nullish(),
  eventRates: listOf(listOf(num)),
  lastErrorTime: SparkTime,
  lastErrorMessage: strOpt,
  lastError: strOpt,
  avgEventRateUnit: strOpt,
  schedulerDelay: num.nullish(),
  isActive: z.boolean().nullish(),
  executorId: strOpt,
  executorHost: strOpt,
});
export type SparkStreamingReceiver = z.infer<typeof SparkStreamingReceiverSchema>;
/** `/streaming/receivers` returns an array (one entry per stream). */
export const SparkStreamingReceiversSchema = listOf(SparkStreamingReceiverSchema);
/** `/streaming/batches` returns an array (newest first). */
export const SparkStreamingBatchesSchema = listOf(SparkStreamingBatchSchema);
export const SparkStreamingBatchResponseSchema = obj({ batch: SparkStreamingBatchSchema.nullish() });

/* ── source (synthesized route, docs/contracts/api.md §4) ───────────────────────────────────────────────────── */

export const SPARK_SOURCE_MODES = ["live-proxy", "history", "none"] as const;
export const SparkSourceSchema = obj({
  mode: z.enum(SPARK_SOURCE_MODES).catch("none"),
  baseUrl: strOpt,
  sparkAppId: strOpt,
  attempt: strOpt,
  available: z.boolean().nullish(),
  reason: strOpt,
  hint: strOpt,
});
export type SparkSource = z.infer<typeof SparkSourceSchema>;

/* ── Dag (synthesized, parsed by the backend from Spark's HTML dot) ─────────────────────────────────────────── */

export const DagClusterSchema = obj({ id: str, name: strOpt, parentId: strOpt });
export const DagNodeSchema = obj({
  id: num,
  name: strOpt,
  callsite: strOpt,
  cached: z.boolean().nullish(),
  barrier: z.boolean().nullish(),
  determinism: strOpt,
  clusterId: strOpt,
});
/**
 * `from`/`to` are RDD node ids; the backend's REST-only fallback (`granularity: "stage"`, captured as
 * `dag-fallback-*.json` under each `fixtures/spark/<version>/<workload>/`) has no node ids and carries `null` there,
 * using `fromStage`/`toStage` instead.
 */
export const DagEdgeSchema = obj({ from: num.nullish(), to: num.nullish(), fromStage: num.nullish(), toStage: num.nullish() });
export const DagStageSchema = obj({
  stageId: num,
  attempt: num.nullish(),
  skipped: z.boolean(),
  label: strOpt,
  clusters: listOf(DagClusterSchema),
  nodes: listOf(DagNodeSchema),
  edges: listOf(DagEdgeSchema),
});
export const SparkDagSchema = obj({
  kind: z.enum(["job", "stage"]).catch("job"),
  granularity: z.enum(["rdd", "stage"]).catch("rdd"),
  jobId: num.nullish(),
  stageId: num.nullish(),
  attempt: num.nullish(),
  stages: listOf(DagStageSchema),
  edges: listOf(DagEdgeSchema),
});
export type SparkDag = z.infer<typeof SparkDagSchema>;
export type DagStage = z.infer<typeof DagStageSchema>;
export type DagNode = z.infer<typeof DagNodeSchema>;
export type DagEdge = z.infer<typeof DagEdgeSchema>;

/* ── entity keys (data-ye) ──────────────────────────────────────────────────────────────────────────────────── */

export const jobKey = (jobId: number | string): string => String(jobId);
export const stageKey = (stageId: number | string, attemptId: number | string | null | undefined): string => `${stageId}/${attemptId ?? 0}`;
export const taskKey = (taskId: number | string): string => String(taskId);
export const executorKey = (id: string): string => id;
export const rddKey = (id: number | string): string => String(id);
export const sqlKey = (id: number | string): string => String(id);
