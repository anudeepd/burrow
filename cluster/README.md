# `cluster/` — the burrow ground-truth test cluster

A **real** single-host Apache Hadoop 3.4.3 YARN cluster (ResourceManager + 3 NodeManagers + JobHistory Server +
Spark History Server) with `pyspark 4.2.0` submit clients, driven by one stdlib-only Python CLI. It is the ground
truth for the parity harness, the fixture capture and the backend's `doctor`/`doctor`-style probing: **everything
in this document was observed on the running cluster, never inferred**. Trimmed outputs are verbatim.

```
cluster/
├─ cluster.py          # setup · up · down · status · submit · scenario seed · logs  (Python stdlib only)
├─ scenarios.py        # the 12-scenario state matrix, written to .cluster/scenarios.json
├─ selftest.py         # end-to-end health proof (nodes, queues, history servers, proxy, logs)
├─ templates/*.xml|sh  # Hadoop config templates rendered into .cluster/state/conf*
└─ workloads/*.py      # PySpark workloads (wordcount, sql+AQE, skew, broadcast, UDF, window, streaming, failing, long)
```

Runtime state lives in the git-ignored `.cluster/`:
`.cluster/endpoints.json` (contract for downstream slices), `.cluster/scenarios.json` (app-state index),
`.cluster/state/{conf,conf-nm1..3,spark-conf,data,logs}`.

---

## 1. Topology

| Component | Endpoint | Notes |
|---|---|---|
| ResourceManager | `http://127.0.0.1:8088` (RPC 8032, admin 8033) | Capacity Scheduler, `ui2` on, ACLs on (`yarn.acl.enable=true`, admin = OS user + `dr.who`) |
| NodeManager 1 | `127.0.0.2:8041`, web `http://127.0.0.2:8042` | rack `/rack1`, node label **`gpu`** (exclusive) |
| NodeManager 2 | `127.0.0.3:8041`, web `http://127.0.0.3:8042` | rack `/rack1`, node label **`ssd`** (non-exclusive) |
| NodeManager 3 | `127.0.0.4:8041`, web `http://127.0.0.4:8042` | rack `/rack2`, **no** label (plain DEFAULT partition) |
| JobHistory Server | `http://127.0.0.1:19888` | aggregated-log web service (`yarn.log.server.url`) |
| Spark History Server | `http://127.0.0.1:18080` | scans `.cluster/state/data/spark-events` every 3 s |
| Timeline Service (ATS v2) | *not running* | `yarn.timeline-service.enabled=false`; `/ws/v1/applicationhistory/apps` → 404 |

Each NodeManager advertises **3072 MB / 4 vcores**; scheduler min allocation 256 MB, max 3072 MB, increment 256 MB.

**Capacity is per partition.** The Capacity Scheduler's cluster resource is **3072 MB / 4 vcores**, not 9216/12:
`/ws/v1/cluster/scheduler` shows `root.etl` at `absoluteUsedCapacity = 100 %` while it held 3072 MB, and
`/ws/v1/cluster/metrics` reports `totalMB: 3072`. In other words the DEFAULT partition effectively contains only
127.0.0.4, because 127.0.0.2 carries the exclusive `gpu` label and 127.0.0.3 the non-exclusive `ssd` label. This is
behavioural, not just bookkeeping: with two 1536 MB unlabelled apps RUNNING, a third unlabelled app stayed
`ACCEPTED` for 15 minutes with `availableMB: 0`. (In earlier runs, before the partition filled up, containers of
unlabelled apps *were* seen on 127.0.0.3 — `nm2-logs` — so the scheduler can spill unlabelled containers onto a
non-exclusive labelled node, but the DEFAULT partition accounting still caps out at 3072 MB.)

> **Trap:** the numbers disagree with each other. `GET /ws/v1/cluster/metrics` says `totalMB: 3072`,
> JMX `CapabilityMB` says **9216**, and the legacy `/cluster/cluster` page says
> `Total Resources <memory:9 GB, vCores:12>`. Only the *scheduler's* view (3072 per partition) predicts whether an
> app will actually be scheduled. Sizing capacity widgets from `CapabilityMB` will make them lie; read the
> per-partition fields in `/ws/v1/cluster/scheduler` (`capacities.queueCapacitiesByPartition`) or
> `/jmx?qry=Hadoop:service=ResourceManager,name=PartitionQueueMetrics,*` instead.

Everything is loopback: the three "hosts" are IP aliases, so any container can reach any other host's web UI.
Racks come from a topology script (`templates/topology.sh`), users are `HADOOP_USER_NAME` (`alice`, `bob`, `carol`),
authentication is **simple** (`hadoop.security.authentication=simple`).

Queue tree (Capacity Scheduler, single source of truth `QUEUES` in `cluster.py`):

```
root                capacity 100
├─ default          30 / max 100 / max-am 0.5 %      submit ACL *
├─ etl              65 / max 100                     submit ACL (none)
│  ├─ ingest        60 (of etl) / max-am 0.5 %       submit ACL alice,bob   ordering fair  default priority 5
│  └─ transform     40 (of etl) / max-am 0.5 %       submit ACL bob,carol
└─ adhoc             5 / max   5 / max-am 0.05 %     submit ACL *           ← the ACCEPTED/pending trap
```
The Capacity Scheduler *requires* a parent's children capacities to sum to exactly 100 (otherwise the RM refuses to
start: `Illegal capacity sum of 0.75 for children of queue root for label=.`), which is why `etl` carries 65.
`cluster.py` asserts this invariant when it renders the config.

`root.adhoc` is deliberately tiny: a 5 % *maximum* capacity is ≈153 MB of the 3072 MB DEFAULT partition (≈460 MB
even if measured against the whole 9216 MB capability), so a 768 MB Spark AM container can never be assigned there
and **any** app submitted to it stays `ACCEPTED` forever — that is the `accepted_pending` scenario. (The
`maximum-am-resource-percent` knob alone was *not* sufficient: with `maxCapacity=60 %` and
`maximum-am-resource-percent=0.1` a 768 MB AM was still admitted.)

Cluster sizing knobs (all rendered from `cluster.py`): `HEAPS` (RM 512m, NM 384m, JHS 256m, SHS 384m),
`MIN_AVAILABLE_MB` (5000 MB free-RAM gate before `up` starts JVMs), `NM_LABELS`, `NODE_LABELS`, `USERS`.

---

## 2. CLI

```bash
.venv/bin/python cluster/cluster.py setup [--scheduler capacity|fair|fifo]   # render configs (idempotent)
.venv/bin/python cluster/cluster.py up    [--scheduler …] [--keep-history] [--force]
.venv/bin/python cluster/cluster.py down  [--purge]
.venv/bin/python cluster/cluster.py status                                   # JSON; exit 1 if unhealthy
.venv/bin/python cluster/cluster.py submit <workload> [--user U --queue Q --tags T --priority N
                                                       --deploy-mode cluster|client --label EXPR
                                                       --am-label EXPR --name N --attempts N --conf K=V
                                                       --wait --timeout S] [-- <workload args>]
.venv/bin/python cluster/cluster.py scenario seed [--only a,b,c]             # → .cluster/scenarios.json
.venv/bin/python cluster/cluster.py logs <rm|nm1|nm2|nm3|jhs|shs> [-n N] [-f]
.venv/bin/python cluster/selftest.py [--skip-submit] [--json]
```

`make cluster-setup | cluster-up | cluster-down | cluster-status | cluster-seed | cluster-selftest` (repo
root Makefile) are thin wrappers around exactly these commands.
`up` refuses to start when <5000 MB RAM is free, when a partially-alive cluster is recorded in `state/pids.json`,
or when stray cluster processes exist — it never fights another cluster.

`submit` is thin sugar over `spark-submit --master yarn`; it sets `HADOOP_USER_NAME`, waits for the application id
to appear in the submit log, and (with `--wait`) blocks until the app is terminal. `--queue` accepts a full path
(`root.etl.ingest`) or a short name; **for the Capacity Scheduler it is rewritten to the full path** because
`CSQueueStore.getMap` only holds full paths and *short leaf* names — `etl.ingest` is rejected with
`... to unknown queue: etl.ingest` while `root.etl.ingest` works.

---

## 3. What actually works (observed)

### 3.1 ResourceManager REST (`docs/contracts/api.md` §3)

```bash
curl -s http://127.0.0.1:8088/ws/v1/cluster/info | jq .clusterInfo
```
```json
{ "id": 1791010984040, "startedOn": 1791010984040, "state": "STARTED", "haState": "ACTIVE",
  "rmStateStoreName": "org.apache.hadoop.yarn.server.resourcemanager.recovery.NullRMStateStore",
  "resourceManagerVersion": "3.4.3", "hadoopVersion": "3.4.3",
  "haZooKeeperConnectionState": "Could not find leader elector. Verify both HA and automatic failover are enabled." }
```

Every path from the contract answers **200** on this cluster:

| path (`/ws/v1/cluster/…`) | bytes | notes |
|---|---|---|
| `info` | 732 | `state`, `haState`, versions, `startedOn` (epoch ms — same value as `clusterTimestamp` in `endpoints.json`) |
| `metrics` | 2052 | `clusterMetrics` (appsSubmitted/Running/Pending/Completed, allocatedMB, availableMB, …) |
| `scheduler` | 86 k | full Capacity-Scheduler tree, see below |
| `scheduler/activities` | — | activities list |
| `scheduler-conf` | 6.7 k | `{"property":[{"name","value"}…]}` — the *effective* `yarn.scheduler.capacity.*` set (76 props) |
| `apps`, `apps/{id}` | — | `state`, `finalStatus`, `diagnostics`, `amNodeLabelExpression`, `logAggregationStatus`, `priority`, `applicationTags`, `resourceSecondsMap` |
| `apps/{id}/appattempts` | — | `appAttemptState`, `containerId`, `nodeId`, `logsLink` (JHS), `exportPorts` |
| `apps/{id}/appattempts/{att}/containers` | — | **only while the app is live**; empty for finished apps |
| `apps/{id}/{state,priority,queue,timeouts}` | 19–99 | 200 on both a RUNNING and a FINISHED app (`{"state":"RUNNING"}`, `{"priority":0}`, `{"queue":"root.etl.transform"}`, `{"timeouts":{"timeout":[…]}}`) |
| `apps/{id}/timeout` | 113 | **503** `RemoteException` (`WebApplicationException`) — the singular path is not a GET resource |
| `apps/{id}/statistics`, `apps/{id}/appactivities`, `apps/{id}/activities` | 7.5 k | **404** HTML (the `statistics` path is in contract §3; use `resourceSecondsMap` on the app itself) |
| `scheduler-overview` | 1034 | 200 — `{"schedulerType":"Capacity Scheduler","schedulingResourceType":…}`; the only place with min/max allocation, max application priority, `schedulerBusyPercent` and the dispatcher queue sizes |
| `scheduler/activities` | 908 | 200 — `{"activities":{"nodeId":…,"timestamp":…,"dateTime":…,"diagnostic":…}}`; **stamped with the request time**, so two calls are never byte-identical |
| `scheduler/app-activities/{appId}` | 171 | 200 — `{"appActivities":{"applicationId":…,"diagnostic":…}}`; the *real* per-app activities path (`apps/{id}/appactivities` does not exist). **Trap:** it still answers 200 for an app the RM has *forgotten*, with a "fail to get application activities" diagnostic — a 200 here does not prove the app exists, so never use it to validate an app id |
| `cluster-user-info` | 7.5 k | **404** HTML |
| `appstatistics` | 359 | `{"appStatInfo":[{"state":"…","count":N},…]}` — the numbers behind the legacy "apps by state" tiles |
| `nodes`, `get-node-labels`, `get-node-to-labels`, `label-mappings` | — | see below |
| `resource-profiles`, `resource-types` | 404 | **do not exist in 3.4.3** — must be waived in the parity inventory |
| `containers/{containerId}` | 404 | **does not exist in 3.4.3** for finished containers (legacy `/cluster/container/<id>` works) |

Node JSON (`/ws/v1/cluster/nodes`):
```json
{"id":"127.0.0.2:8041","state":"RUNNING","rack":"/rack1","nodeLabels":["gpu"],
 "usedMemoryMB":0,"availMemoryMB":3072,"numContainers":0,"nodeHostName":"127.0.0.2"}
```
Node labels are `{"name":"gpu","exclusivity":"true"}` / `{"name":"ssd","exclusivity":"false"}`;
`get-node-to-labels` returns entries for **both** `127.0.0.x:8041` **and** `127.0.0.x:0` (the RPC port alias) —
consumers must not treat the `:0` duplicates as extra hosts.

Scheduler JSON: `schedulerInfo.type == "capacityScheduler"`, `queuePath` is the fully-qualified path
(`root.etl.transform`) while `queueName` is the **short** name (`transform`); leaves carry
`absoluteCapacity`, `absoluteMaxCapacity`, `absoluteUsedCapacity`, `numApplications`, `maxParallelApps`,
`resources`, `pendingContainers`, `allocatedContainers`, `nodeLabels`, `queueAcls`, `orderingPolicyInfo`.
`usedCapacity` is a *percentage of the queue's own capacity* (it exceeds 100 while borrowing: the `default` leaf
reported `250.16` while the cluster was 25 % busy).

### 3.2 RM daemon pages

| URL | status | what it is |
|---|---|---|
| `GET /conf` | 200 `text/xml` | 264 kB Hadoop config as **XML**; `?format=json` is *ignored* (still XML, same bytes) |
| `GET /jmx` | 200 `application/json` | 465 kB, `{"beans":[…]}` |
| `GET /jmx?qry=Hadoop:service=ResourceManager,name=ClusterMetrics` | 200 | single bean |
| `GET /stacks` | 200 `text/plain` | thread dump (200 kB) |
| `GET /logs` | 200 HTML | Jetty directory listing of `HADOOP_LOG_DIR`; links `/logs/resourcemanager.log`, `/logs/rm.out` |
| `GET /logs/resourcemanager.log` | 200 `text/plain` | **no range honouring**: `?start=-2000` still returned 643 kB — slice client-side |
| `GET /metrics`, `/cluster/metrics`, `/cluster/errorsandwarnings` | 404 | not exposed |

A useful context field on the home page is the epoch-ms cluster id: `cluster_ts=1791010984040` in
`/cluster/cluster`'s `RMInfo` (`<td>Cluster ID</td>`).

### 3.3 RM web proxy → live Spark driver

With **simple auth** the proxy is transparent: `securityEnabled` in `WebAppProxyServlet` is
`UserGroupInformation.isSecurityEnabled()` (false here), so the `.../proxyapproved?...&cake=true` approval page and
the `checked_<appId>` cookie are **never** issued — a plain `curl` gets the driver's own response:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088/proxy/application_1791010984040_0001/
# 200   (37417 bytes of Spark UI HTML)
curl -s http://127.0.0.1:8088/proxy/application_1791010984040_0001/api/v1/applications
```
```json
[ { "id" : "application_1791010984040_0001", "name" : "long_running",
    "attempts" : [ { "startTime" : "2026-10-03T07:03:21.683GMT", "completed" : false,
                     "appSparkVersion" : "4.2.0" } ] } ]
```
Consumer rules learned here:
* `…/proxy/<appId>/<spark path>` forwards **verbatim**, including `/api/v1/applications`, so the whole Spark REST
  surface is reachable through the RM while the app is RUNNING.
* For a **FINISHED** app the same URL no longer proxies: the servlet `sendRedirect`s to
  `applicationReport.getOriginalTrackingUrl()`, and for a MapReduce app the AM itself answers with a "Moved" page
  pointing at `http://<host>:19888/jobhistory/job/job_<cluster>_<n>`. Follow redirects (or switch to the JHS/SHS).
* If the RM has forgotten the app, the servlet falls back to the *tracking-URI plugins* (JHS/AHS) before 404.
* Static asset URLs inside the driver HTML are **absolute** (`/proxy/<appId>/static/…`) — the backend must proxy
  under a path prefix rather than rewrite hosts.
* With Kerberos enabled you *would* get `warnUserPage` + the `checked_<appId>` cookie dance
  (`WebAppProxyServlet.getCheckCookieName`) — untested here, flag it as unverified.

### 3.4 Spark History Server REST — attempt ids differ by deploy mode

```bash
curl -s http://127.0.0.1:18080/api/v1/version           # {"spark":"4.2.0"}
curl -s http://127.0.0.1:18080/api/v1/applications      # [ {id,name,attempts[]} … ]
```

**Cluster mode** (any `spark-submit --deploy-mode cluster` on YARN):

```bash
A=application_1791010984040_0015
curl -s http://127.0.0.1:18080/api/v1/applications/$A        # attempts[0].attemptId == "1"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/jobs          # 404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/1/jobs        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/1/stages      # 200 (45292 B)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/1/executors   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/1/environment # 200 (126875 B)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/1/storage/rdd # 200, body "{}"
```
UI: `/history/<appId>/1/jobs/` → 200; `/history/<appId>/jobs/` → 404; `/history/<appId>/` → 302.

**Client mode** (`--deploy-mode client`):

```bash
A=application_1791010984040_0008
curl -s http://127.0.0.1:18080/api/v1/applications/$A        # attempts[0] has NO attemptId
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/jobs          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/v1/applications/$A/1/jobs        # 404
```

So the resolver in PLAN §6.5 must be: `attemptId = attempts[0].attemptId if present else None`, and only insert
the `/api/v1/applications/<appId>/<attemptId>` segment when a non-empty attempt id exists. `/sql`, `/storage/rdd`
legitimately return `{}`/`[ ]` for jobs without SQL/RDD data — not an error.

### 3.5 NodeManager REST + container logs

```bash
curl -s http://127.0.0.3:8042/ws/v1/node/info | jq .nodeInfo
```
```json
{"healthReport":"","totalPmemAllocatedContainersMB":3072,"totalVCoresAllocatedContainers":4,
 "lastNodeUpdateTime":1791010508213,"resourceTypes":"memory-mb (unit=Mi), vcores",
 "nodeHealthy":true,"nodeManagerVersion":"3.4.3","hadoopVersion":"3.4.3"}
```
| URL | status |
|---|---|
| `/ws/v1/node/info`, `/ws/v1/node/apps`, `/ws/v1/node/containers` | 200 |
| `/ws/v1/node/containers/{containerId}` | 200 (`containerLogFiles`, `containerLogsLink`, `totalMemoryNeededMB`, `executionType`) |
| `/conf`, `/jmx`, `/stacks`, `/node` | 200 |
| `/logs` | 302 |
| `/node/containers` | 404 (use `/node`) |

Container logs (running **and** just-finished containers, while `delete.debug-delay-sec` keeps the dirs):

```bash
C=container_1791010984040_0009_01_000002
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://127.0.0.3:8042/node/containerlogs/$C/alice
# 200 4692      → HTML accordion listing prelaunch.out prelaunch.err launch_container.sh directory.info stdout stderr
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.3:8042/node/containerlogs/$C/alice/stderr?start=0&end=400"
# 200 3651      → HTML page wrapping the requested byte range (default: last 4096 bytes)
```
`start`/`end` are honoured as byte offsets (`start` may be negative = from EOF, `end` negative = from EOF); the
response is **always an HTML page with the bytes in a `<pre>`**, never `text/plain`.

### 3.6 Aggregated logs (JobHistory Server)

`yarn.log-aggregation-enable=true`, `yarn.log.server.url=http://127.0.0.1:19888/jobhistory/logs`, remote dir
`.cluster/state/data/app-logs`, suffix `logs`. Aggregation completes shortly after the app finishes
(`logAggregationStatus` in the RM JSON goes `NOT_START → RUNNING → SUCCEEDED`).

> The default aggregation **file controller is TFile**, so the aggregated copy is *not* a plain text file: it lands
> in `.cluster/state/data/app-logs/<user>/bucket-logs-tfile/<bucket>` and can only be decoded through the
> `LogAggregationFileController` — i.e. via the JHS endpoint below or `yarn logs -applicationId <appId>`
> (which starts with `LogAggregationType: AGGREGATED`). Range reads work per file:
> `…/logs/<node>/<container>/<container>/<user>/stdout/?start=1000000&end=1000600` →
> `Showing 600 bytes of 5245011 total`.

```bash
# three interchangeable middle segments; the last is only informational
curl -s -o /tmp/agg.html -w '%{http_code} %{size_download}\n' \
  http://127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/container_1791010984040_0005_01_000001/job_1791010984040_0005/alice
# 200 18754
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/container_1791010984040_0005_01_000001/container_1791010984040_0005_01_000001/alice
# 200   ← the container-id form (this is the `logsLink` the RM puts in appattempts)
curl -s "http://127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/container_1791010984040_0005_01_000001/container_1791010984040_0005_01_000001/alice/syslog/?start=0&end=600"
# 200 4302   ← per-file subpath + byte range
```
The listing reports these log types: `directory.info launch_container.sh prelaunch.err prelaunch.out stderr stdout syslog`
(the NM-side set is the same minus `syslog`). Like the NM, responses are **HTML**, with
`Showing N bytes of M total` and a link `…?start=0&start.time=0&end.time=9223372036854775807` for the full file.

What exists in 3.4.3 and what does not:
| URL | result |
|---|---|
| `/ws/v1/history/info` | 200 `{"historyInfo":{"startedOn":…,"hadoopVersion":"3.4.3",…}}` |
| `/ws/v1/history/mapreduce/jobs` | 200, MR jobs only (Spark apps are **not** here) |
| `/ws/v1/history/mapreduce/jobs/{jobId}` | 200 (`state`,`mapsTotal`,`avgMapTime`,…) |
| `…/{jobId}/tasks`, `…/tasks/{tid}`, `…/tasks/{tid}/attempts[/{aid}]`, `…/jobattempts`, `…/counters` | 200 |
| `…/jobattempts` → `logsLink` | `…/jobhistory/logs/<node>/<container>/<jobId>/<user>` |
| `…/jobs?state=SUCCEEDED`, `…/jobs?user=…&queue=…` | **404** — no query filters on this path in 3.4.3 |
| `…/{jobId}/tasks/{tid}/attempts/{aid}/containers/{cid}` | **404** — the AHS-style container REST is absent |
| `/ws/v1/applicationhistory/apps` | **404** — no ApplicationHistoryServer / ATS in this cluster |

Per-attempt JSON (from `jobattempts`):
```json
{"jobAttempts":{"jobAttempt":[{"nodeHttpAddress":"127.0.0.4:8042","nodeId":"127.0.0.4:8041","id":1,
  "containerId":"container_1791010984040_0005_01_000001",
  "logsLink":"http://127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/container_1791010984040_0005_01_000001/job_1791010984040_0005/alice"}]}}
```

### 3.7 Legacy UI (`/cluster/*`) inventory — all 200 in 3.4.3

`/cluster/cluster` · `/cluster/apps` · `/cluster/apps/{NEW,SUBMITTED,ACCEPTED,RUNNING,FINISHED,FAILED,KILLED}` ·
`/cluster/app/{appId}` · `/cluster/appattempt/{attemptId}` · `/cluster/container/{containerId}` ·
`/cluster/nodes` · `/cluster/nodelabels[?label=gpu]` · `/cluster/scheduler` · `/cluster/queue/root.default` ·
`/cluster/queue/root.etl.ingest` · `/conf` · `/jmx` · `/stacks` · `/metrics`→404 · `/cluster/metrics`→404 ·
`/cluster/node/{id}`→404 (no per-node page) · `/cluster/errorsandwarnings`→404 · `/ui2/` → 200.

`/logs` → 302 to the Jetty listing (200 when followed). UI2 is enabled (`yarn.webapp.ui2.enable=true`) and serves
the Ember inventory at `/ui2/#/…`; the Ember *data* endpoints it calls live under
`/ws/v1/cluster/*` (already covered) plus `/conf`/`/jmx`/`/stacks`.

### 3.8 Scheduler alternation (`up --scheduler capacity|fair|fifo`) — verified

All three schedulers start on this config and run real jobs. `endpoints.json.scheduler` records which one is live.

**Capacity (default)** — `schedulerInfo.type = capacityScheduler`, full queue tree with `queuePath`/`queueName`/
`capacity`/`maximumCapacity`/`capacities.queueCapacitiesByPartition`, plus `scheduler/activities` and a working
`scheduler-conf` (below). Queue capacities must sum to exactly 100 per parent.

**Fair** — `up --scheduler fair` (RM STARTED in 3 s, cluster healthy in ~14 s):
```
GET /ws/v1/cluster/scheduler
{"scheduler":{"schedulerInfo":{"type":"fairScheduler","rootQueue":{
   "queueName":"root","schedulingPolicy":"fair","maxResources":{"memory":9216,"vCores":12},
   "clusterResources":{...},"fairResources":{...},"steadyFairResources":{...},"demandResources":{...},
   "amMaxResources":{...},"maxContainerAllocation":{...},"pendingContainers":0,"allocatedContainers":0,
   "childQueues":{"queue":[
      {"queueName":"root.adhoc","schedulingPolicy":"fair","maxResources":{"memory":5529,...}},
      {"queueName":"root.etl","schedulingPolicy":"fair","childQueues":{"queue":[
          {"queueName":"root.etl.transform","schedulingPolicy":"FIFO"},
          {"queueName":"root.etl.ingest","schedulingPolicy":"fair"}]}},
      {"queueName":"root.default","schedulingPolicy":"fair"}]}}}}
```
The shape is *completely different* from the capacity tree (children live under `rootQueue.childQueues.queue`, not
`queues`, and `maxResources` is absolute MB) — the scheduler page needs two renderers. Two pitfalls found the hard
way: (a) a child whose `schedulingPolicy` its parent does not allow is **silently dropped** —
`ERROR fair.QueueManager: Can't create queue 'root.etl.ingest', the child scheduling policy is not allowed by parent
queue!` (a `drf` child under a `fair` parent; the allocation file in `cluster.py` uses `fair`/`fifo` only);
(b) `GET /ws/v1/cluster/scheduler-conf` returns **404** with the body
`This API only supports to retrieve scheduler configuration from a mutable-conf scheduler, underneath scheduler
FairScheduler is not an instance of MutableConfScheduler`. A `spark-submit --queue default` job reaches
`FINISHED/SUCCEEDED` on this scheduler.

**FIFO** — `up --scheduler fifo` (cluster healthy in ~10 s): `schedulerInfo` is a *single queue*, no tree:
```json
{"type":"fifoScheduler","capacity":1.0,"usedCapacity":0.0,"qstate":"RUNNING","minQueueMemoryCapacity":256,
 "maxQueueMemoryCapacity":3072,"numNodes":3,"usedNodeCapacity":0,"availNodeCapacity":9216,
 "totalNodeCapacity":9216,"numContainers":0}
```
`scheduler-conf` 404s the same way; a submitted job reaches `FINISHED/SUCCEEDED`; `endpoints.json` reports
`scheduler: "fifo"`, one queue `default` and `nodeLabels: []`.

Node labels are **capacity-only**: for fair/fifo the templates omit `yarn.node-labels.*`, `up` skips
`rmadmin -addToClusterNodeLabels`, `endpoints.json.nodeLabels` is `[]`, and `up` wipes `.cluster/state/data`
(including the label store) unless `--keep-history`, so any label from a previous capacity run is gone — a
scheduling assertion must be made against `endpoints.json.nodeLabels`.

### 3.9 Scheduler configuration is mutable at runtime

Because `yarn.scheduler.configuration.store.class=memory`, `rmadmin -refreshQueues` is **refused**
(`IOException: Scheduler configuration is mutable. refreshQueues is not allowed in this scenario.`) and the queue
tree is changed over REST instead:
```bash
curl -s -X PUT -H 'Content-Type: application/xml' --data-binary @newqueue.xml \
     http://127.0.0.1:8088/ws/v1/cluster/scheduler-conf      # -> "Configuration change successfully applied."
curl -s http://127.0.0.1:8088/ws/v1/cluster/scheduler-conf   # GET returns the effective 76-property set
```
(The PUT endpoint reports success even when the payload changes nothing observable — always re-read the scheduler
JSON to confirm. Durable changes belong in `cluster.py`'s `QUEUES` + a restart.)

### 3.10 Submitting, killing, restarting

```bash
# Spark, cluster mode, on the nested queue, with tags + priority, waiting for the result
.venv/bin/python cluster/cluster.py submit wordcount_rdd --user alice --queue root.etl.ingest \
  --tags 'burrow,demo' --priority 7 --name demo --wait --timeout 600 -- --lines 6000 --vocab 120
# → {"appId":"application_<ts>_<n>", …, "finalState":{"state":"FINISHED","finalStatus":"SUCCEEDED"}}

# kill (the AM's user must own the app, or be the yarn admin)
.venv/bin/python -c "import importlib.util as u;s=u.spec_from_file_location('c','cluster/cluster.py');c=u.module_from_spec(s);s.loader.exec_module(c);c.kill_app('application_<ts>_<n>', user='bob')"

# read the aggregated logs of any app (TFile-backed aggregation)
.cluster/hadoop/bin/yarn logs -applicationId application_<ts>_<n> -size 2000000   # "LogAggregationType: AGGREGATED"

# stop everything (verifies no strays) / start fresh
.venv/bin/python cluster/cluster.py down          # exits non-zero if any cluster process survives
.venv/bin/python cluster/cluster.py up            # 11–15 s to healthy
```

`down` walks `/proc` for anything with `.cluster/state` in its cmdline/cwd or `BURROW_CLUSTER=1` in its environ
(daemons, containers, submit clients, client-mode drivers), SIGTERMs, waits 40 s, SIGKILLs, then re-scans three
times and **fails loudly** if anything survived. `up` is idempotent: the second start writes the same
`endpoints.json` (identical modulo timestamps) and reuses the same rendered configs.

---

## 4. Scenario matrix (`.cluster/scenarios.json`)

`.venv/bin/python cluster/cluster.py scenario seed [--only a,b,c]` brings all of the following into existence
**simultaneously** and writes their RM-observed truth (app id, `state`, `finalStatus`, attempt list, containers
captured while RUNNING, users, queue, tags, priority, label expressions, node ids, every relevant URL) into
`.cluster/scenarios.json`. `observed[]` keeps the state samples taken while seeding, and a final `refresh()` pass
re-reads every record from the RM so the file is never stale.

| scenario | app | state · finalStatus | user · queue | what it exercises |
|---|---|---|---|---|
| `finished_succeeded` | SPARK wordcount | FINISHED · SUCCEEDED | alice · `root.default` | jobs/stages/executors/storage, SHS history, aggregated logs |
| `failed_app_exception` | SPARK failing_job | FINISHED · **FAILED** | carol · `root.etl.transform` | `diagnostics` with a Python traceback; the "Failed" facet is `finalStatus`, not `state` |
| `killed_app` | SPARK long_running | **KILLED** · KILLED | bob · `root.etl.transform` | `yarn application -kill` while RUNNING |
| `mapreduce_pi` | **MAPREDUCE** | FINISHED · SUCCEEDED | alice · `root.default` | JobHistory Server job/attempt/task REST + aggregated logs |
| `distributed_shell` | **YARN** | FINISHED · SUCCEEDED | carol · `root.default` | a second `applicationType`, 2 extra containers |
| `tags_priority` | SPARK sql_join_agg | FINISHED · SUCCEEDED | bob · `root.default` | `applicationTags`, `priority=7` |
| `node_label_gpu` | SPARK wordcount | FINISHED · SUCCEEDED | alice · `root.default` | `amNodeLabelExpression=gpu` on the app *and* every container; placement on the exclusive node only |
| `client_mode` | SPARK wordcount | FINISHED · SUCCEEDED | alice · `root.default` | `--deploy-mode client` (local driver, SHS attempt-id = none) |
| `big_log` | SPARK log_spam | FINISHED · SUCCEEDED | alice · `root.default` | ~5 MiB written to the **ApplicationMaster's stdout** → a multi-MB container log for the log viewer (path + byte counts recorded) |
| `running_ingest` | SPARK long_running | **RUNNING** | alice · `root.etl.ingest` | long multi-stage live app on a nested queue, pinned to the `ssd` label partition |
| `running_transform` | SPARK long_running | **RUNNING** | bob · `root.etl.transform` | second live app, different user + queue, also `ssd`-pinned |
| `multi_attempt` | SPARK long_running | **RUNNING**, 2 attempts | alice · `root.default` | attempt 1's AM SIGKILLed → attempt 2 RUNNING (`maxAppAttempts=3`) |
| `accepted_pending` | SPARK long_running | **ACCEPTED** | carol · `root.adhoc` | the AM-limit trap, never scheduled |
| `remote_user_metrics` *(opt-in)* | SPARK wordcount | FINISHED · SUCCEEDED | **dr.who** · `root.default` | makes the legacy `/cluster/cluster` **`User Metrics for dr.who`** table (JMX `q0=root,user=dr.who`) exist; `facts.remoteUserHasQueueMetrics=true` |

**`remote_user_metrics` is opt-in.** Stock CapacityScheduler creates root `QueueMetrics` with
`enableUserMetrics=false` (`yarn.scheduler.capacity.user-metrics.enable`, default `false`), so no per-user bean exists
and the legacy page *never* renders `User Metrics for <user>` (`MetricsOverviewTable.java:157-160`, even for a user
that owns apps — verified: apps of `alice` produce no `user=alice` bean). FairScheduler always has it. To exercise the
block: `BURROW_USER_METRICS=1 .venv/bin/python cluster/cluster.py setup`, restart the RM (`down` + `up`; apps are lost,
`NullRMStateStore`), then `BURROW_USER_METRICS=1 … scenario seed` (or `scenario seed --only remote_user_metrics`). The step
submits a short app as `dr.who` (the anonymous remote user under simple auth), then asserts the JMX bean and the
`User Metrics for dr.who` heading. The default config and default seed leave it off.

**Preemption is intentionally not seeded**; `scenarios.json → notes.preemption` records why (needs a sustained
two-queue over-capacity pattern for >`max_wait_before_kill`, and the observable is just another KILLED app with
`preemptedResourceMB>0` — already covered by `killed_app`) plus the exact reproduction recipe.

**Sizing:** the Capacity Scheduler's cluster resource here is **3072 MB per partition** — the DEFAULT partition
contains only 127.0.0.4 (`.2` carries the exclusive `gpu` label, `.3` the non-exclusive `ssd` label), so the whole
matrix has to fit in 3 GiB. Scenarios therefore use 512 MB containers (`SMALL`/`TINY` in `scenarios.py`:
480m heap + 32m overhead — Spark 4.2 refuses heaps below ~466m), and the two long-lived apps are pinned to the
non-exclusive `ssd` partition (`am_label=ssd`, `label=ssd`, `SSD` conf list) so the DEFAULT partition stays free
for `multi_attempt` and for `selftest.py`'s fresh job. `accepted_pending` consumes nothing.

---

## 5. Self-test

```bash
.venv/bin/python cluster/selftest.py            # 11 checks, exit 0 only if every one passes
```
It asserts: `endpoints.json` agrees with the live RM; 3 RUNNING NodeManagers with the configured racks and node
labels; the Capacity-Scheduler queue tree matches `endpoints.json`; JHS + SHS reachable; the RM REST surface of
`docs/contracts/api.md` §3 answers; the legacy `/cluster/*`, `/ui2`, `/conf`, `/jmx`, `/stacks` paths exist;
a **fresh** tiny PySpark job reaches `FINISHED/SUCCEEDED`; its container logs are aggregated and readable through
the JHS aggregated-log endpoint; it appears in the Spark History Server; a RUNNING app is reachable through the RM
web proxy; and the NodeManager REST + container-log endpoints answer. It prints a `cluster memory:` line
(daemon RSS/PSS, container/client process RSS, host MemAvailable) at the end.

---

## 6. Measured resource use

Measured on this 16-core / 15 GB host on 2026-10-03 with `.venv/bin/python cluster/cluster.py status`
(`memory_report()` sums `/proc/<pid>/status:VmRSS` and `smaps_rollup:Pss` for every process whose cmdline/cwd
contains `.cluster/state` or whose environ has `BURROW_CLUSTER=1`):

| state | daemon RSS | daemon PSS | container/client procs | all cluster procs | host MemAvailable |
|---|---|---|---|---|---|
| **idle** (fresh `up`, empty RM, nothing submitted) | 1302.6 MB | 1188.1 MB | 0 | 1302.6 MB | 8523 MB |
| **under load** (matrix seeded: 3 apps RUNNING, 1 ACCEPTED, 10 finished) | 1176.6 MB | ~1051 MB | 18 (≈2497.6 MB) | **3674.2 MB** | 6337 MB |

Six JVMs (RM 512m heap, 3×NM 384m, JHS 256m, SHS 384m) all run with SerialGC and small metaspace caps; the RM is
the biggest (≈120 MB RSS after startup, growing with the number of retained applications — it keeps up to
`yarn.resourcemanager.max-completed-applications=10000`). Each Spark application contributes ~5 processes per
running app at this size (AM JVM + Python driver + executor JVM + Python worker), ≈1.0 GB RSS for three apps with
one 512 MB executor each. The `up` RAM gate (`MIN_AVAILABLE_MB=5000`) exists because a cold start needs headroom;
`--force` overrides it.

---

## 7. Known quirks / gaps

* **Never put `SPARK_LOCAL_IP` in `yarn.nodemanager.admin-env`.** YARN appends admin-env values to an
  already-present variable with `:` (`Apps.addToEnvironment`) and Spark's AM re-exports every `SPARK_*` variable
  into the *executor* containers, so executors get `SPARK_LOCAL_IP="127.0.0.x:127.0.0.x"` and die with
  `UnknownHostException: 127.0.0.x:127.0.0.x: invalid IPv6 address literal` → `Max number of executor failures (4)
  reached`. Let Spark detect its own address (it picks the site-local 192.168.0.x, reachable from every container
  because all "hosts" are one machine).
* **Spark 4.2 refuses driver/executor heaps below 450 MB** (`INVALID_DRIVER_MEMORY: System memory N must be at least
  471859200`), so an AM container is never smaller than 768 MB on this cluster (512m heap + 256m overhead, rounded
  up to the 256 MB allocation increment).
* **MapReduce on a local FS + `HADOOP_USER_NAME`**: `JobSubmissionFiles` rejects an existing
  `<staging>/<user>/.staging` whose owner is the OS user rather than the submitter, so only the *first* MR job
  succeeds; `scenarios.py` removes that directory before submitting.
* `/ws/v1/cluster/resource-profiles`, `/resource-types`, `/containers/{id}`, `/apps/{id}/statistics`,
  `/apps/{id}/appactivities`, `/apps/{id}/activities`, `/cluster-user-info` → 404 in 3.4.3; `apps/{id}/timeout`
  (singular) → 503 `RemoteException`. `/scheduler-overview` and `/scheduler/app-activities/{appId}` exist but are
  *not* in contract §3. `scheduler/activities` and `scheduler/app-activities/{id}` are stamped with the request
  time, so they can never be byte-identical across calls — fixture capture must normalise `timestamp`/`dateTime`.
* The RM container payload for `apps/{id}/appattempts/{att}/containers` is `{"container":[…]}` — *not*
  `{"containers":{"container":[…]}}` as the YARN docs suggest — and it reports `containerState`,
  `containerExitStatus` and `logUrl` (no `nodeLabelExpression`).
* `/conf?format=json` is **not** honoured by the 3.4.3 RM — it always returns `text/xml`.
* `/logs/{file}` ignores `?start=`/`?length=` byte ranges; the whole file is returned.
* NM and JHS log endpoints return **HTML**, not `text/plain`; the byte range (or the default last 4 KiB) is inside a
  `<pre>`, so log consumers must extract it.
* The RM drops container lists the moment an app finishes; `scenarios.json` therefore stores the container set
  captured while the app was RUNNING.
* A Spark app that fails *inside the driver* (task/job failure) is reported by YARN as
  `state=FINISHED, finalStatus=FAILED` because Spark's AM calls `unregisterApplicationMaster(FAILED)`. Only AM-level
  failures (launch/AM crash) produce `state=FAILED`. `killed_app` and `failed_app_exception` cover both.
* Cluster-mode Spark apps need the SHS attempt-id URL segment; client-mode apps must omit it (§3.4). `/sql`,
  `/storage/rdd` returning `{}` is normal for jobs without SQL/RDD data.
* No ApplicationHistoryServer / ATS v2; no HDFS (`fs.defaultFS=file:///`), so all "remote" dirs are local paths.
* Simple auth ⇒ the RM web proxy needs no approval page. Kerberos behaviour is untested.
* The `gpu` label is exclusive, so 127.0.0.2 is unavailable to unlabelled containers.
* App-scoped paths must be measured with an id read *fresh* from `/ws/v1/cluster/apps`: the RM forgets
  applications across restarts, so a cached id 404s `apps/{id}/{state,priority,queue,timeouts}` (and HTML-404s the
  other app paths) while `scheduler/app-activities/{id}` still returns 200 with a failure diagnostic — the
  combination that makes a stale id look valid.
* Container logs and NM container dirs disappear after `yarn.nodemanager.log.retain-seconds` /
  `delete.debug-delay-sec` (900 s each); capture fixtures inside that window.

## 8. Contract change requests

1. `docs/contracts/api.md` §3 — replace `GET /api/rm/conf?format=json` with `GET /api/rm/conf` returning the
   RM's `text/xml` (3.4.3 ignores `format=json`); if JSON is wanted the backend must convert.
2. `docs/contracts/api.md` §3 — `resource-profiles`, `resource-types`, `containers/{containerId}`,
   `apps/{appId}/statistics` and `apps/{appId}/appactivities` return 404 on Hadoop 3.4.3; keep them in the
   allowlist (404s pass through unchanged) or drop them. Also note the containers payload shape
   (`{"container":[…]}`) and field names (`containerState`/`containerExitStatus`/`logUrl`) differ from the
   YARN javadoc.
3. `docs/contracts/api.md` §4 — the Spark attempt-id rule must be *conditional*: cluster-mode YARN apps require
   `/api/v1/applications/{appId}/{attemptId}` with `attempts[0].attemptId`, client-mode apps must **omit** the
   segment (see §3.4 above).
4. `docs/contracts/api.md` §5 — the NM/JHS log upstreams are **HTML documents with an embedded byte range**, not
   `text/plain` (RM `/logs/{file}` returns the whole file and ignores byte ranges). The backend's
   `GET /api/logs/containers/{id}/files/{name}` contract stays valid because it synthesises text, but the upstream
   wording should be corrected, `x-burrow-log-source` should be able to say `nm-html`/`jhs-html`, and the range
   parameters must be applied to the *extracted* log body rather than trusted from upstream.
