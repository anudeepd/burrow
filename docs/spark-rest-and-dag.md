# Spark REST API & DAG discovery (Spark 3.5.9 vs 4.2.0; SQL compatibility for Spark 2.x)

> Evidence base for the Spark half of burrow. The cross-version REST and RDD-DAG measurements use **real captures** from
> 2026-10-03 in local mode (`local[N]`), Temurin JDK 17.0.20.1, PySpark **4.2.0** (Python 3.12) and **3.5.9** (Python 3.11).
> The Spark 2.4 SQL compatibility section is grounded in a real YARN application captured on 2026-10-12; source, UI pages, and
> adapted API output are in `fixtures/spark/2.4.0/sql-demo/`. Version-specific field sets and shapes come from those fixtures.
>
> **Headline results**
> 1. The Spark REST API **never exposes the RDD operator graph**. On Spark 3.x/4.x, jobs/stages/executors/storage/SQL are
>    REST resources; the RDD DAG exists **only as Graphviz DOT embedded in the job page and stage page HTML** (`#dag-viz-metadata`).
> 2. On Spark 3.x/4.x, the **SQL plan DAG is in REST** (`GET …/sql/{id}?details=true&planDescription=true` → `nodes[]`,
>    `edges[]`). Spark 2.x has no SQL REST resource; burrow reconstructs the same response from the SQL UI pages.
> 3. A **standalone stage page carries no DAG for SKIPPED stages** (it renders a placeholder). The DAG of a skipped stage
>    is only available from the **job page** that contains it. This is the single most important discovery rule.
> 4. Structured Streaming has **no REST at all**; its UI is server-rendered HTML.
> 5. Version deltas are small but real (see [§9](#9-spark-359-vs-420-real-deltas)).

---

## 1. What exists, how to reproduce

### 1.1 Layout

```
fixtures/spark/
├─ tools/
│  ├─ sparkcap.py      # Capture: raw HTTP -> rest/*.json + html/*.html, MANIFEST.json (no re-serialisation)
│  ├─ run_workload.py  # boot one local-mode SparkSession, import workloads/<name>.py, snapshot("final")
│  ├─ run_all.sh       # run every workload sequentially, one JVM at a time
│  ├─ dagparse.py      # REFERENCE DAG extractor (HTML -> Dag JSON) + regen/check/verify
│  └─ keycensus.py     # enumerate every JSON key path/type/nullability per endpoint -> rest-keys.json
├─ workloads/*.py      # 15 scenarios (one job per module)
├─ 4.2.0/<workload>/{MANIFEST.json, rest/, html/, dag-*.json}
└─ 3.5.9/<workload>/{…}
```

`MANIFEST.json` records, for **every captured file**: the exact request `{method, path, query}`, HTTP `status`,
`contentType`, `bytes`, `sha256[:16]`, `capturedAt`, plus document-level `sparkVersion`, `javaVersion`, `pythonVersion`,
`workload`, `workloadSource` (+ sha), `master`, `conf`, `uiBase`, `appId`, `attempt`, `startedAt`, `finishedAt`.

### 1.2 Commands

```bash
# one workload (the Python interpreter picks the Spark version)
.venv/bin/python        fixtures/spark/tools/run_workload.py rdd-wordcount     # -> 4.2.0/rdd-wordcount
.venv-spark35/bin/python fixtures/spark/tools/run_workload.py rdd-wordcount    # -> 3.5.9/rdd-workcount

# all workloads, one JVM at a time (default driver memory 1g, UI port 4140)
WORKLOADS="… " bash fixtures/spark/tools/run_all.sh .venv/bin/python
WORKLOADS="… " bash fixtures/spark/tools/run_all.sh .venv-spark35/bin/python

# DAG goldens
.venv/bin/python fixtures/spark/tools/dagparse.py regen  fixtures/spark/4.2.0   # (re)write dag-*.json
.venv/bin/python fixtures/spark/tools/dagparse.py --verify fixtures/spark/4.2.0 # reparse + schema-validate (exit 1 on drift)

# REST field census
.venv/bin/python fixtures/spark/tools/keycensus.py fixtures/spark/4.2.0         # -> rest-keys.json
```

### 1.3 Captured volume

| | Spark 4.2.0 | Spark 3.5.9 |
|---|---|---|
| workloads | 15 | 15 |
| raw bytes (`rest/`+`html/`+`dag-*`+`MANIFEST`) | **43 121 215** (41.1 MiB) | **41 300 118** (39.4 MiB) |
| REST response files | 2 687 | 2 684 |
| HTML pages | 553 | 551 |
| golden `dag-*.json` | **366** | **366** |
| REST endpoints (census) | 26 | 26 |
| distinct REST key paths | 1 878 | 1 813 |
| `--verify` | 366 validated, 0 invalid, 0 drifted | 366 validated, 0 invalid, 0 drifted |

`du -sh` reports ~50 MB / ~48 MB (filesystem block rounding); the byte totals above are exact. No JSON `null` was
emitted in any 200 response in either version (scanned: 0 files contain `: null`).

### 1.4 Workloads (scenario coverage)

| workload | what it exercises |
|---|---|
| `rdd-wordcount` | RDD API, cache, unions, many small jobs; **also carries the `quirks=True` capture** (error shapes, threads, metrics, non-JSON bodies) |
| `df-join-aqe` | AQE, sort-merge join, skipped stages, many small AQE jobs, reused exchange |
| `window-sql` | SQL window functions, SQL executions |
| `sql-cache-union` | DataFrame cache + union, nested SQL plan scopes, skipped stages |
| `python-udf` | Python UDF stages (PythonRDD), shuffle |
| `broadcast-join` | broadcast join, AQE on |
| `task-retries` | failed+killed tasks, task retries |
| `job-failed` | a job that fails outright |
| `stage-retry` | stage retries with `stageAttemptId` 0 and 1, job/stage failure |
| `shared-stages-multijob` | one stage shared by several jobs |
| `barrier-scopes` | barrier stages (`[Barrier]`), nested barrier scopes |
| `big-dag` | deep lineage: 12 distinct shuffles → **14–15 stages / 65–69 RDD nodes**, many skipped stages |
| `dstream` | DStream / `streaming/*` REST + `/streaming/` pages |
| `structured-streaming` | StreamingQuery UI (HTML only) |
| `long-running` | mid-flight captures (`live`, `live1`, `live2` phases) + final; running apps |

---

## 2. Endpoint catalogue (what REST really exposes)

Base path: **`{base}/api/v1`**. Live driver (through the RM web-proxy or directly) and History Server both serve the
**same** `/api/v1` at the root — the History Server does *not* prefix REST with `/history/<app>`, only the **HTML** pages
are `/history/<app>/…`. The application path is `applications/{appId}[/{attemptId}]`.

All responses are `Content-Type: application/json` unless noted. **Spark omits non-applicable fields instead of emitting
`null`** — in the whole corpus not a single JSON `null` was observed in a 200 response (`rest-keys.json` `nullable` is
`false` everywhere it exists). Absence, not null, is the "no value" signal.

### 2.1 Endpoint summary

| Endpoint (under `{base}/api/v1`) | query params | top-level | notes |
|---|---|---|---|
| `applications` | `status=running\|completed`, `limit=N` | `[]` of app | `status` filters on the attempt `completed` flag; `limit` optional |
| `applications/{app}` | — | object | `{id, name, attempts[]}` |
| `applications/{app}/jobs` | `status=running\|succeeded\|failed` | `[]` of job | no pagination |
| `applications/{app}/jobs/{jobId}` | — | object | 404 text/plain if unknown |
| `applications/{app}/stages` | `status=`, `details=`, `withSummaries=`, `quantiles=`, `taskStatus=` | `[]` of stage attempt | **no pagination**; `details=true` inlines `tasks`+`executorSummary` (big) |
| `applications/{app}/stages/{stageId}` | `details`, `withSummaries`, `quantiles` | object | latest attempt |
| `applications/{app}/stages/{stageId}/{attemptId}` | `details`, `withSummaries`, `quantiles` | object | single attempt; always includes `tasks`,`executorSummary` |
| `…/{stageId}/{attemptId}/taskSummary` | `quantiles=0.1,0.5,0.9` | object | per-metric arrays; 404 text/plain when the stage has no task metrics |
| `…/{stageId}/{attemptId}/taskList` | `offset`, `length`, `sortBy`, `status=SUCCESS\|FAILED\|RUNNING` | `[]` of task | offset 0-based |
| `applications/{app}/executors` | — | `[]` | **active** executors only |
| `applications/{app}/allexecutors` | — | `[]` | includes dead executors |
| `applications/{app}/executors/{execId}/threads` | — | `[]` | `execId` = `driver` or numeric; 404 text/plain unknown |
| `applications/{app}/storage/rdd` | — | `[]` of RDD | cached RDDs only (may be empty) |
| `applications/{app}/storage/rdd/{rddId}` | — | object | 404 text/plain unknown |
| `applications/{app}/environment` | — | object | spark properties, classpath entries, system properties |
| `applications/{app}/logs` | — | **ZIP** (`application/octet-stream`) | event-log download, not JSON |
| `applications/{app}/sql` | `details`, `planDescription`, `offset`, `length` | `[]` of execution | SQL/DataFrame executions |
| `applications/{app}/sql/{executionId}` | `details`, `planDescription` | object | `nodes[]`,`edges[]` when `details=true&planDescription=true` |
| `applications/{app}/streaming/statistics` | — | object | DStream only |
| `applications/{app}/streaming/receivers` | — | `[]` | DStream only |
| `applications/{app}/streaming/batches` | — | `[]` | DStream only |
| `applications/{app}/streaming/batches/{batchId}` | — | object | DStream only |
| `applications/{app}/streaming/batches/{batchId}/operations[/{id}]` | — | `[]`/object | DStream only |
| `version` | — | `{"spark":"4.2.0"}` | outside the app path |
| `/metrics/json/` | — | object | **not under `/api/v1`**; `"version":"4.0.0"` = metrics-system version, not Spark |
| `/metrics/executors/prometheus/` | — | text | Prometheus; not under `/api/v1` |
| `/metrics/applications/prometheus/` | — | 404 | not supported |

### 2.2 `applications` / `application`

```jsonc
[{"id":"local-…","name":"burrow-rdd-wordcount",
  "attempts":[{"startTime":"2026-10-03T07:05:52.572GMT","endTime":"1969-12-31T23:59:59.999GMT",
               "lastUpdated":"…","duration":13832,"sparkUser":"puppyseal","completed":false,
               "appSparkVersion":"4.2.0","startTimeEpoch":1791011152572,"endTimeEpoch":-1,
               "lastUpdatedEpoch":1791011152572}]}]
```
* **Running sentinel**: `endTime = "1969-12-31T23:59:59.999GMT"`, `endTimeEpoch = -1`; `duration` (ms) grows. A backend
  must treat `-1`/epoch-0 as "no end time", not as a date.
* Timestamps are `"yyyy-MM-dd'T'HH:mm:ss.SSS'GMT'"`. The `*Epoch` fields are the reliable machine-readable form.
* In a live local-mode UI the app is `completed:false` until the UI stops, so `applications?status=running` returns it for
  its entire life and `status=completed` returns `[]`. `status` is **not** the job/stage notion of running.

### 2.3 `jobs` element (top-level `[]`)

`jobId:int`, `status:"RUNNING|SUCCEEDED|FAILED"`, `name:str`, `description:str?` (SQL jobs), `jobGroup:str?`,
`jobTags:[]`, `submissionTime:str`, `completionTime:str?` (**absent while running**), `stageIds:[int]`,
`numTasks/numActiveTasks/numCompletedTasks/numFailedTasks/numKilledTasks/numSkippedTasks:int`,
`numActiveStages/numCompletedStages/numFailedStages/numSkippedStages:int`, `numCompletedIndices:int`,
`killedTasksSummary:{reason:count}`.
All are always present **except** `completionTime` (present only after the job ends), `description`/`jobGroup` (present
roughly when the job came from SQL / a job group), and `killedTasksSummary` entries (usually `{}`).
**Version note:** in 3.5.9 `killedTasksSummary` is populated with the cancellation reason string; in 4.2.0 it is always
`{}` (the reason moved to the stage `failureReason`, see §9).

### 2.4 `stages` element (counts and units)

Always present: `stageId:int`, `attemptId:int`, `status`, `name:str`, `numTasks/numActiveTasks/numCompleteTasks/
numFailedTasks/numKilledTasks:int`, `submissionTime:str?` (absent for skipped), `firstTaskLaunchedTime:str?`,
`completionTime:str?`, `failureReason:str?`, `rddIds:[int]`, `details:str`, `schedulingPool:str`, `resourceProfileId:int`,
and the metrics below. Optional: `completionTime`/`firstTaskLaunchedTime` (absent when not reached), `failureReason`,
`executorSummary` (`details=true`), `tasks` (`details=true`), `taskMetricsDistributions`/`executorMetricsDistributions`
(`withSummaries=true`), `peakExecutorMetrics` (on the single-stage endpoint).

Statuses observed in the corpus: **`COMPLETE`, `SKIPPED`, `FAILED`, `PENDING`, `ACTIVE`** (the list `status=` filter
also accepts `complete`/`active`/`pending`/`failed`/`skipped`; values are matched case-insensitively by Spark).

Units: all `*Time` are **milliseconds**; all `*Bytes*` are **bytes**; `*Records*` are **counts**; `peakExecutionMemory`
is **bytes**; `shuffleWriteTime` is **nanoseconds** (Spark's `ShuffleWriteMetrics.writeTime` is ns — verified: a stage
with 21 ms `executorRunTime` reports 2 497 948 `shuffleWriteTime`, ≈119× in ns terms); `executorCpuTime`/
`executorDeserializeCpuTime` are **nanoseconds**; `jvmGcTime` is **milliseconds**. Local-mode single-executor apps
report `shuffleWriteTime` etc. as `0` when no shuffle occurred.

Complete metric groups: `inputBytes/inputRecords`, `outputBytes/outputRecords`,
`shuffleReadBytes/shuffleReadRecords/shuffleWriteBytes/shuffleWriteRecords`,
`shuffleLocalBlocksFetched/shuffleRemoteBlocksFetched/shuffleLocalBytesRead/shuffleRemoteBytesRead/
shuffleRemoteBytesReadToDisk`, `shuffleFetchWaitTime/shuffleRemoteReqsDuration/shuffleWriteTime`,
`memoryBytesSpilled/diskBytesSpilled`, `executorRunTime/executorCpuTime/executorDeserializeTime/
executorDeserializeCpuTime`, `resultSerializationTime/resultSize/gettingResultTime/schedulerDelay`, plus the shuffle-merge
(`shuffleMerged{Local,Remote}{Blocks,Bytes,Chunks}Fetched`, `shuffleMergedRemoteReqsDuration`,
`shuffleMergedFetchFallbackCount`, `shuffleMergersCount`) and shuffle-push (`isShufflePushEnabled`,
`shuffleCorruptMergedBlockChunks`) counters. There is **no** `shuffleTotalBytesRead` and **no** `numSkippedTasks` at
stage level (only jobs have `numSkippedTasks`).

### 2.5 `executors` / `allexecutors` element

`id:"driver"|"<n>"`, `hostPort:str`, `isActive:bool`, `rddBlocks:int`, `memoryUsed:int`, `diskUsed:int`,
`totalCores:int`, `maxTasks:int`, `activeTasks/completedTasks/failedTasks:int`, `totalTasks:int`,
`totalDuration:int` (ms), `totalGCTime:int` (ms), `totalInputBytes:int`, `totalShuffleRead:int`,
`totalShuffleWrite:int`, `isBlacklisted:bool`, `isExcluded:bool`, `blacklistedInStages:[]`, `excludedInStages:[]`,
`addTime:str`, `executorLogs:{stdout,stderr}`, `memoryMetrics:{usedOnHeapStorageMemory,usedOffHeapStorageMemory,
totalOnHeapStorageMemory,totalOffHeapStorageMemory}`, `peakMemoryMetrics:{…}` (JVM heap/off-heap, pool memory, GC counts,
`ProcessTree*RSSMemory`), `attributes:{}`, `resources:{}`, `resourceProfileId:int`.
`executors` = **active only**; `allexecutors` = all. In local mode both contain only the `driver`.

### 2.6 `storage/rdd` element

`id:int` (the RDD id), `name:str`, `numPartitions:int`, `numCachedPartitions:int`, `storageLevel:str`,
`memoryUsed:int`, `diskUsed:int`, `dataDistribution:[]`, `partitions:[]`.

### 2.7 `sql` element / `sql/{id}`

`id:int`, `status:"RUNNING|COMPLETED|FAILED"` (observed at final capture: `COMPLETED`, `FAILED`; `RUNNING` appears only
mid-flight), `description:str`, `planDescription:str` (the textual physical plan),
`submissionTime:str`, `duration:int` (ms), `successJobIds:[int]`, `failedJobIds:[int]`, `runningJobIds:[int]`,
`nodes:[]`, `edges:[]` — the last two populated only with `details=true&planDescription=true`.
Node: `nodeId:int`, `nodeName:str`, `wholeStageCodegenId:int?`, `metrics:[{name:str,value:str}]`; the Spark 2.4 UI
adapter also supplies optional `planLine:str` from `plan-meta-data-<nodeId>` for the operator hover text.
Edge: `{fromId:int, toId:int}`.
**Version note:** 4.2.0 adds `queryId:str`, `rootExecutionId:int`, `errorMessage:str`; 3.5.9 has none of the three.

### 2.8 `taskSummary`

An object whose **every value is an array**, parallel to the quantile vector. Default quantiles
`[0.0, 0.25, 0.5, 0.75, 1.0]` (5 entries); `quantiles=0.1,0.5,0.9` → 3 entries. Groups:
`duration`, `executorRunTime`, `executorCpuTime`, `executorDeserializeTime`, `executorDeserializeCpuTime`, `resultSize`,
`jvmGcTime`, `resultSerializationTime`, `memoryBytesSpilled`, `diskBytesSpilled`, `peakExecutionMemory`,
`schedulerDelay`, `gettingResultTime`, `quantiles` (the echoed quantile values), and nested
`inputMetrics.{bytesRead,recordsRead}`, `outputMetrics.{bytesWritten,recordsWritten}`,
`shuffleReadMetrics.{readBytes,readRecords,fetchWaitTime,remoteBlocksFetched,localBlocksFetched,remoteBytesRead,
remoteBytesReadToDisk,totalBlocksFetched,remoteReqsDuration,shufflePushReadMetricsDist{…}}`,
`shuffleWriteMetrics.{writeBytes,writeRecords,writeTime}`.
**404 text/plain** `"No tasks reported metrics for {stageId} / {attemptId} yet."` when the attempt has no task metrics
(observed for every SKIPPED stage).

### 2.9 `taskList` element

`taskId:int`, `index:int`, `attempt:int`, `partitionId:int`, `status:"SUCCESS|FAILED|RUNNING|KILLED"` (observed:
`SUCCESS`, `FAILED`, and `RUNNING` in live phases; `KILLED` is a valid `TaskState` not observed), `executorId:str`,
`host:str`, `launchTime:str`, `duration:int` (ms), `gettingResultTime:int`, `schedulerDelay:int`, `speculative:bool`,
`taskLocality:str`, `errorMessage:str?`, `accumulatorUpdates:[]`, `executorLogs:{stdout,stderr}`,
`taskMetrics:{…}` (scalar form of all the metrics in §2.8 — **absent while the task is RUNNING**).

### 2.10 `executors/{id}/threads` element

3.5.9: `threadId:int`, `threadName:str`, `threadState:str`, `blockedByLock:str`, `holdingLocks:[]`, `stackTrace:{elems:[]}`.
4.2.0: adds `inNative:bool`, `isDaemon:bool`, `lockName:str`, `monitors:[]`, `priority:int`, `suspended:bool`,
`synchronizers:[]`, and drops `blockedByThreadId`. See §9.

---

## 3. Error shapes and status codes

Semantic misses are **HTTP 404 with a `text/plain` body** (not JSON, not the API error envelope):

| request | status | body |
|---|---|---|
| `/api/v1/applications/{app}/nonexistent` | 404 | `unknown app local-…, attempt nonexistent` |
| `/api/v1/applications/{app}/stages/1/0/taskSummary` (no tasks) | 404 | `No tasks reported metrics for 1 / 0 yet.` |
| `/api/v1/applications/{app}/executors/0/threads` | 404 | `Executor does not exist.` |
| `/api/v1/applications/{app}/storage/rdd/9999` | 404 | `no rdd found w/ id 9999` |
| `/api/v1/applications/{app}/sql/9999` | 404 | `unknown query execution id: 9999` |
| `/api/v1/applications/{app}/streaming/statistics` (no DStream) | 404 | `no streaming listener attached to <app name>` |

Bad **query parameters** and unknown paths produce the **Jetty HTML error page** (`text/html;charset=iso-8859-1`,
`<title>Error …`) with 404 — e.g. `taskList?sortBy=DURATION` (the valid sort keys are the `TaskSorting` names, observed
`runtime` and `-runtime`).

**Backend consequence:** for Spark, inspect `Content-Type` before decoding; a 404 is very often a *semantic* miss whose
plain-text body is the user-facing reason. Map to the contract's `404 not_found` (unknown id) / `503 unavailable`
(with a `hint`: "no task metrics yet", "no streaming listener") rather than `502`.

---

## 4. Pagination and size traps

* **`jobs`, `stages`, `executors`, `allexecutors`, `storage/rdd`** return the **full list** — no `offset`/`length` support.
* **`sql`** (executions) supports `offset`+`length` (0-based). `offset=1&length=2` → the 2nd and 3rd executions (observed
  on a 2-element list → 1 result).
* **`taskList`** supports `offset` (0-based) + `length` + `sortBy` + `status`. `sortBy=-runtime` is descending duration;
  `sortBy=runtime` ascending. Example: 8 tasks, `offset=1&length=3&sortBy=-runtime` → the 2nd–4th slowest tasks.
* **`details=true` is the one dangerous flag.** On the **list** endpoint it inlines every task of every stage attempt:

  | workload | `/stages` | `/stages?details=true` | `/stages?withSummaries=true` |
  |---|---|---|---|
  | sql-cache-union | 71 316 B | **183 416 B (2.6×)** | 137 900 B |
  | rdd-wordcount | 53 725 B | **130 461 B (2.4×)** | 105 957 B |
  | df-join-aqe | 58 593 B | 104 414 B (1.8×) | 102 235 B |

  On the **single-stage** endpoint, `tasks`/`executorSummary` are already included; `details=true` changes nothing, while
  `withSummaries=true` adds the two `*Distributions` objects. So `details=true` is only worth it on the **single-stage**
  endpoint. The backend should never fetch `/stages?details=true` speculatively for a live app.
* HTML DAG pages range from ~4 KB (placeholder) to ~300 KB (big-dag job pages). Only `#dag-viz-metadata` is needed.

---

## 5. The RDD DAG: where it lives and its format

### 5.1 Location

REST exposes `jobs[].stageIds` and `stages[].rddIds` **as unordered integer sets** (no parents, no names, no edges) — see
`rest-keys.json`: there is **no** key anywhere in any 200 response describing RDD parents, RDD names or an operation graph.
The graph is written into the HTML:

* Job page (`/jobs/job/?id=N`) — one `<div class="stage-metadata" stage-id="…" skipped="true|false">` per stage of the
  job (including skipped ones), inside `<div id="dag-viz-metadata" class="d-none">`, itself inside
  `<span id="job-dag-viz">`.
* Stage page (`/stages/stage/?id=N&attempt=M`) — normally one `.stage-metadata` for that attempt, inside
  `<span id="stage-dag-viz">`.

Each `.stage-metadata` contains:
```html
<div class="dot-file">digraph G { … }</div>
<div class="incoming-edge">3,4</div>          <!-- zero or more; RDD-id pairs consumed by this stage -->
<!-- .outgoing-edge: never emitted by 3.5.9 or 4.2.0 -->
<div class="cached-rdd">6</div>               <!-- zero or more; cached RDD ids in this stage -->
<!-- .barrier-rdd / .indeterminate-rdd: never emitted by 3.5.9 or 4.2.0 -->
```

### 5.2 `.stage-metadata` availability (the critical rule)

Measured over all 4.2.0 stage pages (`status` from `stages.json`):

| stage status | stage page has `.stage-metadata`? | count |
|---|---|---|
| COMPLETE | yes | 152 |
| COMPLETE | **no** — page raced the UI (live phase) | 2 |
| FAILED | yes | 5 |
| ACTIVE | yes | 1 |
| **SKIPPED** | **no** (placeholder page, "No tasks have started yet") | 81 |
| unknown id (9999) | no (`#no-info`) | 1 |

Therefore: **for a SKIPPED stage, fetch the DAG from the job page** (`/jobs/job/?id=<job containing that stage>`), not
from the stage page. A live stage page may also lack the graph even when REST says COMPLETE → the backend must fall back
to REST (or refetch).

### 5.3 DOT dialect

Only what `RDDOperationGraph.makeDotFile` emits:

```
digraph G {
  id="graph_<stageId>";                     // job page: graph_<stageId>; stage page root subgraph: graph_stage_<stageId>
  subgraph graph_stage_<stageId> {
    id="graph_stage_<stageId>";
    isCluster="true";
    label="Stage 0"                         // may contain "\n(barrier mode)" / " (skipped)"
    2 [id="node_2" labelType="html" label="PythonRDD [2]<br>reduceByKey at File.scala:22"];
    subgraph cluster_0 {
      id="cluster_0"; isCluster="true"; label="textFile";
      0 [id="node_0" labelType="html" label="… [0]<br>textFile at …"];
    }
  }
  0->1; 1->2; 2->3;                         // intra-stage edges, may appear at any nesting level
}
```

* **Node id == RDD id**, globally unique per application. In a job page, node ids continue across stages
  (stage 3 uses 0–3, stage 4 uses 4–12) — that is what makes cross-stage edge resolution possible.
* **Cluster ids** are `cluster_N` (RDD operation scope, e.g. `textFile`, `mapPartitionsInternal`) or
  `cluster_spark_plan_N` (a SQL/whole-stage-codegen scope). Cluster ids **repeat across stages**; they are only
  unique within a stage.
* Clusters nest (observed depth 2). Attribute keys on clusters: `id`, `isCluster`, `label`.
* Intra-stage edges are `A->B;` statements, possibly interleaved with node/cluster declarations.
* The text inside `.dot-file` is **XML-escaped by the Scala XML literal** (`&quot; &lt; &gt; &amp;`). An HTML parser with
  entity decoding turns it back into `"`, `<`, `>` once.

### 5.4 Node label encoding

```
label = javaEscape( name " [" rddId "]" [" [Cached]"] [" [Barrier]"] [" [Indeterminate]" | " [Unordered]"] "<br>" xmlEscape(callsite) )
```

* Decode twice: an HTML entity pass (implicit in an HTML parser), then a **Java string-unescape**
  (commons-text `escapeJava`: `\n \t \" \\`, `\uXXXX` incl. surrogate pairs) because the label was `escapeJava`-ed.
* The separator is the **last** `<br>` (callsites are XML-escaped and cannot contain a literal `<`).
* Flags, in order: `[Cached]` (in the Spark UI cache), `[Barrier]` (barrier stage op), and exactly one determinism flag
  `[Indeterminate]` or `[Unordered]` for non-deterministic RDDs (shuffles are `[Unordered]`). Absent ⇒ determinate.
* `name` is the RDD's name (e.g. `PythonRDD`, `ShuffledRowRDD`, `In-memory table tc`, an input path).
* `callsite` is `"<op> at <file>:<line>"` (or `"<op> at NativeMethodAccessorImpl.java:0"` for reflective calls).
* The root label is `"Stage <id>"`, `"Stage <id> (attempt <n>)"` (rare), `"Stage <id> (skipped)"`,
  or `"Stage <id>\n(barrier mode)"`. The stage id is authoritative from the `stage-id` attribute, not the label.

### 5.5 Cross-stage edges

Cross-stage links are **only** in `.incoming-edge` divs (format `"<fromRddId>,<toRddId>"`), and they live in the
*consuming* stage's metadata. The producer stage is not recorded. Resolution used by `dagparse` (documented ambiguity):

> the producing stage is the stage (≠ the consumer) that contains `from` as a **sink** (no intra-stage outgoing edge);
> ties broken by lowest stage id.

`.outgoing-edge` was never emitted by either version, so the reverse direction is unavailable.

### 5.6 Golden inventory / test vectors

`fixtures/spark/<version>/<workload>/dag-{job-N,stage-N-M}.json` are the parser's canonical output, regenerated by
`dagparse.py regen` and machine-checked by `--verify`. They cover every captured job/stage page that has a graph
(366 files per version). Notable vectors:

| vector | file | what it pins |
|---|---|---|
| skipped stage inside a job | `sql-cache-union/dag-job-2.json` | `skipped:true`, cross-stage edge `3→4` with `fromStage:3` |
| many skipped stages + big DAG | `big-dag/dag-job-2.json` | 15 stages, 69 nodes, 13 skipped, cross-stage edges |
| barrier stage | `barrier-scopes/dag-stage-0-0.json` | node `barrier:true`, root label `Stage 0\n(barrier mode)` |
| indeterminate RDD | `barrier-scopes/dag-stage-3-0.json` | `determinism:"unordered"` (3 nodes) |
| cached RDD | `rdd-wordcount/dag-job-1.json` | `cached:true`; `.cached-rdd` div |
| nested scopes | `sql-cache-union/dag-stage-11-0.json` | clusters with `parentId`, `cluster_spark_plan_*` |
| shared stage across jobs | `shared-stages-multijob/dag-job-2.json` | same `stageId` in two jobs |
| failed + retried stage | `stage-retry/dag-stage-1-0.json`, `…/dag-stage-1-1.json` | `attempt` 0 and 1 |
| SQL job | any `window-sql/dag-job-*.json` | SQL RDD chain (`ShuffledRowRDD`, `cluster_spark_plan_*`) |
| page without graph | `rdd-wordcount/final.job-9999.html`, `…/final.stage-9999-0.html` | parser returns `None`, no golden |
| REST-only fallback | `*/dag-fallback-job-N.json` | stage-level DAG from REST alone |

Largest RDD DAG observed: **15 stages / 69 nodes / 71 edges** (55 intra-stage + 16 cross-stage) in
`big-dag/dag-job-2.json` (identical in both versions). Max cluster count in one stage: **9** (4.2.0) / **10** (3.5.9);
max cluster nesting depth: **2**. The fallback DAG can be larger in edge count (105 inferred edges for big-dag job-2)
because it links every earlier producer, not just the nearest.

---

## 6. DAG JSON (as produced by `dagparse.py`) + additive fields

The base shape is `docs/contracts/api.md` §4. The reference parser emits these **additive** fields:

```ts
type Dag = {
  kind: "job" | "stage";
  granularity: "rdd" | "stage";
  jobId?: number;                 // present for job kind, absent for stage kind
  stages: DagStage[];
  edges: DagEdge[];               // job kind: all cross-stage edges; stage kind: this stage's .incoming-edge entries (fromStage null)
  edgesInferred?: true;           // granularity:"stage" fallback only
};
type DagStage   = { stageId: number; attempt: number; skipped: boolean; label: string;
                    clusters: DagCluster[]; nodes: DagNode[]; edges: DagEdge[];
                    rddIds?: number[]; status?: string };        // fallback only
type DagCluster = { id: string; name: string; parentId: string | null };   // id may be "cluster_…"/"cluster_spark_plan_…"
type DagNode    = { id: number; name: string; callsite: string; cached: boolean;
                    barrier: boolean; determinism: "determinate" | "unordered" | "indeterminate";
                    clusterId: string | null };
type DagEdge    = { from: number | null; to: number | null;      // null in stage-kind / fallback
                    fromStage: number | null; toStage: number | null };
```

* `attempt` = the `attempt` from the stage page URL (and the root label when present); `0` when unknown.
* `label` is the raw (Java-unescaped) root label — may contain `\n`.
* `clusterId`/`parentId` resolve within the stage; `null` = node outside any cluster (the top-level `graph_stage_N`
  scope) or a top-level cluster.
* Edge endpoints in a stage-kind DAG may be `null` where the counterpart is not on the page.
* The fallback (`granularity:"stage"`) infers edges from REST shuffle metrics; treat `edgesInferred:true` as low
  confidence (no transitive reduction — see `rest_fallback_dag`'s docstring).

### CONTRACT CHANGE REQUESTS (additive; contract owned by the integration owner)
1. §4 `Dag.edges` currently says "cross-stage edges (node ids), **job kind only**". Change to: *job kind = cross-stage
   edges; stage kind = the stage page's `incoming-edge` list (endpoints may be `null`, `fromStage`/`toStage` may be
   `null`)*. Reason: stage pages really do carry `incoming-edge` (e.g. `sql-cache-union/dag-stage-11-0.json`).
2. §4 `DagStage`: add optional `attempt: number`, and for the fallback `rddIds: number[]`, `status: string`.
3. §4 `DagNode`: add `barrier: boolean` and `determinism: "determinate"|"unordered"|"indeterminate"`.
4. §4 `DagEdge`: add `fromStage: number | null` and `toStage: number | null` (currently only `from`/`to`).
5. §4 `Dag`: add optional `edgesInferred: boolean` (fallback DAG only).
6. §4 note that `granularity:"stage"` implementations **must** set `edgesInferred:true` and that consumers should not
   render inferred edges as authoritative.
7. Cross-reference §6.5: the DAG source is per-page HTML; **skipped-stage DAGs require the job page** (see §5.2).

---

## 7. SQL plan DAG

Spark 2.x has no SQL REST resource. After a SQL REST 404, the backend detects the app version and adapts the SQL UI's list
and execution pages into the existing response schema. Spark 2.4 uses status-specific execution tables, numeric DOT node IDs,
codegen subgraphs, multiline metric labels, and edges from child operators to parent operators. This adapter is separate from
both the newer SQL DOT dialect and the RDD DAG parser. The captured YARN workload and pages are in
`fixtures/spark/2.4.0/sql-demo/`.

* Spark 3.x/4.x REST (preferred, structured): `GET …/sql/{id}?details=true&planDescription=true` →
  `nodes:[{nodeId,nodeName,wholeStageCodegenId?,metrics:[{name,value}]}]`, `edges:[{fromId,toId}]`, plus
  `planDescription` (text). This is a complete plan graph — no HTML needed.
* Spark 2.x UI (`/SQL/` and `/SQL/execution/?id=N`): status-specific tables expose execution metadata and job IDs; the detail
  page contains a numeric-ID DOT plan (including codegen clusters) and `#physical-plan-details > pre`. Burrow parses these
  server-side and never sends the HTML to the browser.
* Spark 3.x/4.x UI HTML uses a **different SQL DOT dialect**: node IDs are `nodeN` strings, labels are plain, and there are
  no clusters. Do **not** feed SQL DOT to the RDD parser.

## 8. Structured Streaming (no REST)

There is **no** REST endpoint for Structured Streaming in 3.5.9 or 4.2.0
(`/streaming/*` is DStream-only and 404s with `no streaming listener attached to <app name>`). The UI is server-rendered:

* `/StreamingQuery/` — active + completed query tables (client-side sorted via query params `completed.sort`,
  `completed.pageSize`). The page shell shows "Loading…" then the table.
* `/StreamingQuery/statistics/?id=<queryId>` — per-query progress: a metrics table (`#stat-table`), per-batch chart data
  inlined as JS (`var formattedTimeToValues = {…}`, e.g. input rate / processed rows / batch duration), state-store
  metrics (`numTotalStateRows`, `stateMemoryUsedBytes`, …), watermark histograms/timelines.

Backend implication: to show Structured Streaming we must parse this HTML (tables + inline JS arrays) or omit it. The
fixtures `structured-streaming/html/{live,final}.streamingquery*.html` are the reference.

---

## 9. Spark 3.5.9 vs 4.2.0 (real deltas)

Both versions were captured with the **same workload sources** (same `workloadSourceSha256`), same master, same conf,
same JDK. 26 endpoints and the same endpoint set were observed in both. Deltas (keycensus diff, dynamic keys collapsed):

| endpoint | 4.2.0 adds | 3.5.9 only |
|---|---|---|
| `executors`, `allexecutors` | `peakMemoryMetrics.ConcurrentGCCount`, `peakMemoryMetrics.ConcurrentGCTime` | — |
| `stages` (all variants) | `…peakMemoryMetrics.ConcurrentGCCount/ConcurrentGCTime` (list, single, distributions, `executorSummary`) | — |
| `executors/{id}/threads` | `inNative`, `isDaemon`, `lockName`, `monitors[]`, `priority`, `suspended`, `synchronizers[]` | `blockedByThreadId` |
| `jobs`, `jobs/{id}` | — | `killedTasksSummary` non-empty (`{reason: count}`) |
| `sql`, `sql/{id}` | `errorMessage`, `queryId`, `rootExecutionId` | — |

Non-census behavioural deltas (from the same fixture files):

* **`failureReason` wording/shape.** `stage-retry`:
  * 3.5.9: `"Job aborted due to stage failure: Task 0 in stage 1.1 failed 4 times, most recent failure: Lost task 0.3 … PythonException: Traceback …"`, `numKilledTasks:1`, `killedTasksSummary:{…}` populated.
  * 4.2.0: `"[PYTHON_EXCEPTION] An exception was thrown from the Python worker: Traceback …"` — a **classified prefix**
    (`[PYTHON_EXCEPTION]`) and the raw worker traceback; `numKilledTasks:0`, `killedTasksSummary:{}`.
  * A UI that shows `failureReason` verbatim is correct on both; a UI that parses it must handle both prefixes.
* **`sql.queryId`** (a UUID) exists only in 4.2.0 and is the key to `/StreamingQuery/statistics/?id=`; 3.5.9 SQL REST
  has no query id.
* Golden DAG counts: 4.2.0 366, 3.5.9 366 (identical after the `big-dag` fix). HTML DAG **format is byte-compatible**
  across the two (same tags, same DOT dialect, same flags) — one parser serves both. The 4.2.0 root label can be
  `Stage N\n(barrier mode)` in both versions.

**Conclusion:** the contract's field set is 3.5.9-compatible; treat the 4.2.0-only fields (ConcurrentGC*, thread extras,
SQL ids/errorMessage) as optional in the Rust types (serde `Option`/`#[serde(default)]`), and treat 3.5.9's
`killedTasksSummary`/`blockedByThreadId` as optional too.

---

## 10. Recommended backend TTLs

`Cache-Control: no-cache` always bypasses. TTLs are for the route class; finished-Spark data is effectively immutable, so
serve it from cache with a long TTL and revalidate cheaply (weak ETag on the body hash).

| resource | live app (driver) | finished app (History Server) |
|---|---|---|
| `applications` list | 2 s | 30 s |
| `applications/{app}` | 1 s | 60 s |
| `jobs`, `jobs/{id}` | 1 s | 300 s (immutable once the job ended) |
| `stages` (list, no `details`) | 1 s | 300 s |
| `stages/{id}/{att}`, `taskSummary`, `taskList` | 1–2 s | 300 s (`taskList` page offsets: 300 s) |
| `executors`, `allexecutors` | 2 s | 300 s |
| `executors/{id}/threads` | 1 s | 60 s |
| `storage/rdd` | 2 s | 300 s |
| `environment` | 10 s | 3600 s |
| `sql`, `sql/{id}` | 1 s | 300 s |
| `streaming/*` (DStream) | 1 s | 300 s |
| `version` | 3600 s | 3600 s |
| `/metrics/*` | 1 s | n/a |
| **DAG (HTML-derived)** | 2 s (running), 1 s while the stage is ACTIVE | 3600 s / immutable |
| Structured Streaming HTML | 2 s | 300 s |

Coalesce aggressively: the DAG for a job page is derived from one HTML fetch shared by all its stages. When a job is
finished, its DAG is immutable — cache the parsed JSON by `(appId, jobId)` forever (bounded LRU).

---

## 11. Spark UI page → REST / HTML source table

Seed for the Spark parity inventory. "HTML-only" means no REST equivalent exists.

| Spark UI page | REST source | HTML-only data |
|---|---|---|
| `/jobs/` | `GET …/jobs` | — |
| `/jobs/job/?id=N` | `GET …/jobs/{id}` + `…/stages` (filter `stageIds`) | **RDD DAG** (`#dag-viz-metadata`, incl. skipped stages), event-timeline data |
| `/stages/` | `GET …/stages` | — |
| `/stages/stage/?id=N&attempt=M` | `GET …/stages/{id}/{M}` (+`taskSummary`, `taskList`) | **RDD DAG** (COMPLETE/FAILED only; skipped → use the job page), task event timeline |
| `/stages/pool/?poolname=` | `GET …/stages?status=…` (group client-side by `schedulingPool`) | pool aggregation page |
| `/storage/` | `GET …/storage/rdd` | — |
| `/storage/rdd/?id=N` | `GET …/storage/rdd/{id}` | partition distribution rendering |
| `/environment/` | `GET …/environment` | classpath/system-property rendering |
| `/executors/` | `GET …/executors` + `…/allexecutors` | — |
| `/executors/?id=X` | `GET …/executors/{X}/threads` (thread dump) | — |
| `/SQL/` | `GET …/sql` | — |
| `/SQL/execution/?id=N` | `GET …/sql/{id}?details=true&planDescription=true` | plan DOT + `node-details` map, textual physical plan |
| `/streaming/` (DStream) | `GET …/streaming/statistics`, `…/receivers`, `…/batches` | batch timeline (JS) |
| `/streaming/batch/?id=N` | `GET …/streaming/batches/{N}` (+`/operations`) | per-output-op timeline |
| `/StreamingQuery/` | **HTML-only** | active/completed query tables |
| `/StreamingQuery/statistics/?id=Q` | **HTML-only** | progress metrics table + inline JS chart data |
| `/api/v1/…` (REST root) | the endpoints above | — |
| `/metrics/json/`, `/metrics/executors/prometheus/` | direct | — |

**List order.** `jobs` and `stages` come back newest-first from REST (event-log order) in both 3.5.9 and 4.2.0; `sql` is
**ascending** — its ids are the DataFrames' execution order. The legacy UI renders all three tables newest-first
(DataTables `ID ▾`), so the SQL list is the one page that has to apply the order client-side; a server-paged page sorts
only the loaded page, exactly as the legacy page's table does. Storage (RDD) carries no sort marker in the legacy UI and
stays in REST order.

---

## 12. Implementation advice for the Rust parser

1. **Two-pass extraction.** First locate `id="dag-viz-metadata"` and, within it, every `class="stage-metadata"` whose
   `stage-id`/`skipped` attributes are captured. Then, inside each, capture the text of each child div by class:
   `dot-file`, `incoming-edge`, `cached-rdd` (ignore `barrier-rdd`/`indeterminate-rdd`/`outgoing-edge` — never emitted).
   A tolerant scanner (find the `div id="dag-viz-metadata"` … then split on `class="stage-metadata"`) is enough —
   the markup is machine-generated and stable. Use `html5ever`/`scraper` or manual byte scanning; either is fine, but
   entity-decode once (`&quot; &lt; &gt; &amp;`).
2. **Don't generalise the DOT parser.** Only `digraph G { … }` with `id=`/`isCluster=`/`label=` assignments,
   `subgraph <name> { … }`, node statements `<int> [<attrs>];`, and `<int>-><int>;`. No ports, no edge attributes, no
   global attrs, no quoted ids. A hand-written tokenizer is ~80 lines (see `dagparse.tokenize`/`parse_dot`) and is much
   safer than a full DOT crate.
3. **Label decoding is the only fiddly part.** java-unescape (incl. `\uXXXX` + surrogate pairs) **after** the HTML entity
   pass; split on the **last** `<br>`; match `^(.*) \[(\d+)\]( flags)*$` where flags are `[Cached]`, `[Barrier]`,
   `[Indeterminate]| [Unordered]`. Keep the raw name if the pattern fails (defensive — never drop a node).
4. **Node id == RDD id**, unique per app; cluster ids repeat across stages — scope cluster maps per stage.
5. **Skipped stages.** Never request the skipped-stage page for a DAG; get it from the job page. The stage page for a
   skipped stage is a ~4 KB placeholder ("No tasks have started yet") — detect and fall back.
6. **Live races.** A stage page can lack the graph even when REST says COMPLETE (observed). Treat missing
   `.stage-metadata` as "retry / fall back to REST", not "empty DAG".
7. **Cross-stage edges** come only from `.incoming-edge`; the producer is inferred (sink heuristic, lowest-id tie-break).
   Surface the inference in the DAG model (or resolve from the job page, where both stages are present, and use the
   job-page DAG for cross-stage edges even when showing a single stage).
8. **Numbers.** `*Epoch` fields and ISO-GMT strings disagree on precision; prefer epoch. `-1`/epoch-0 = "not finished".
   `shuffleWriteTime`/`executorCpuTime` are nanoseconds, everything else time is ms; label units in the UI.
9. **Error sniffing.** Spark 404s are often `text/plain` semantic messages or Jetty HTML. Branch on `Content-Type`.
10. **Never fetch `/stages?details=true`** for a live app (2–2.6× payload); fetch the single-stage endpoint instead.
11. **SQL plan DOT is a different dialect** (`nodeN` ids, no clusters/flags) — keep the two parsers separate; prefer the
    REST `nodes[]`/`edges[]`.
12. Mirror `dagparse.py` in Rust and unit-test against the golden `dag-*.json` (366 per version). `--verify` is the
    Python-side oracle; the Rust test should assert byte-equality of the serialised DAG against the goldens.

---

## 13. Endpoint coverage & documented absences

Per workload (4.2.0): all 15 carry `MANIFEST.json`, per-file request/status/type/hash/timestamp, `rest/` for the §4
endpoint set, `html/` for jobs/stages/storage/executors/environment/SQL, and golden DAGs.

| endpoint | captured in |
|---|---|
| `application`, `applications`, `applications?status/limit`, `version` | all 15 |
| `jobs`, `jobs/{id}`, `jobs?status=*` | all 15 |
| `stages`, `stages?details/withSummaries/quantiles/status/taskStatus`, `stages/{id}`, `stages/{id}/{att}` | all 15 |
| `taskSummary`, `taskList`(+`offset/length/sortBy/status`) | all 15 |
| `executors`, `allexecutors` | all 15 |
| `storage/rdd`, `storage/rdd/{id}` | all 15 |
| `environment` | **all 15** (rest+html) |
| `sql`, `sql/{id}` | the 6 SQL workloads (window-sql, sql-cache-union, df-join-aqe, broadcast-join, python-udf, structured-streaming); others legitimately have zero executions (`sql: []`) |
| `streaming/statistics|receivers|batches|batches/{id}|operations` | `dstream` only (correct — DStream is the only thing that serves these) |
| `logs` | all 15 (ZIP binary; recorded as a `_binary` summary) |
| `executors/{id}/threads` | `rdd-wordcount` (driver, 200) — the numeric `0` variant returns 404 text/plain; that error shape is captured too |
| `/metrics/json/`, `/metrics/executors/prometheus/`, `/metrics/applications/prometheus/` (404) | `rdd-wordcount` (`quirks=True`) |
| error shapes (`nonexistent`, `sql/9999`, `storage/rdd/9999`, `sortBy=DURATION`, `taskSummary` on a task-less stage, `streaming/statistics` without DStream, job/stage 9999 pages) | `rdd-wordcount` (`quirks=True`) |

Deliberately **not** captured per workload (documented absence):
* `details=true` on `/stages` — captured on every workload (`final.stages.details.json`) but the big inline payload is
  intentionally not duplicated across the `item_cap`.
* Large streaming runs are `item_cap`-limited (16 jobs/stages/SQL executions get individual REST+HTML captures; the list
  endpoints still return everything). This mirrors the frontend's virtualised-table needs; a Rust implementer does not
  need thousands of duplicate pages.
* `metrics.*` and error shapes are captured once (`rdd-wordcount`) because their *shape* is endpoint-global.

## 14. Known gaps / not reproduced

* **No YARN-cluster Spark capture.** All captures are local mode. The live-proxy path (RM `/proxy/{appId}/`) was *not*
  exercised here (the running cluster was used only as an optional sanity check, per the brief). The REST/DAG formats
  are identical in cluster mode (same driver web UI), but the proxy handshake and the History-Server replay of a fully
  finished app are untested by this slice.
  **Closed by the backend slice (2026-10-03, cluster `1791015583684`):** the RM proxy answered `200` with no
  `proxyapproved`/cookie handshake under simple auth; a live cluster-mode driver reported `attempts[0]` **without** an
  `attemptId` and 404s on `/applications/{id}/{attemptId}`, while the SHS reports `attemptId:"1"` and needs the
  attempt segment (see `crates/burrow-core/src/spark/resolve.rs` and `docs/architecture-backend.md` §Findings).
  The HTML path in history mode is `/history/{appId}[/{attempt}]/{page}`.
* **Task-level DAG of a running stage during shuffle** is covered only by the `live*` phases of `long-running`,
  `dstream`, `stage-retry`, `structured-streaming`.
* **Structured Streaming** has no REST; only HTML parsing is possible (captured).
* **`outgoing-edge` / `barrier-rdd` / `indeterminate-rdd`** divs do not exist in either version (handled defensively in
  `dagparse.py`, never emitted by Spark 3.5.9/4.2.0).
* **16 vs 15 workloads.** The brief says "16 captured workloads"; there are **15** workload modules and 15 capture dirs —
  the count in the brief is off by one (no workload is missing). All 15 complete end-to-end in both versions.
