# Contract: SPA ↔ backend HTTP/SSE API (v1)

Same-origin. Everything under `/api`. **GET only** in v1 (read-only product). UTF-8. JSON unless stated.
The backend is **passthrough-first**: YARN and Spark JSON are forwarded byte-for-byte (cached). Only the endpoints marked
**synthesized** build their own payloads. Changing anything here = tell the integration owner.

## 1. Common behaviour

Response headers on every `/api` response
| header | values |
|---|---|
| `x-burrow-api` | `1` |
| `x-burrow-cache` | `hit` · `miss` · `stale` (served stale because upstream failed/refreshing) · `coalesced` (shared an in-flight fetch) · `bypass` |
| `x-burrow-upstream` | `host:port` that served the miss (absent on `hit`) |
| `x-burrow-age` | ms since the cached body was fetched |
| `etag` | weak ETag on cacheable JSON; `If-None-Match` ⇒ `304` with empty body |

Request headers: `Cache-Control: no-cache` ⇒ bypass cache (parity harness + hard-reload use this).
`Accept-Encoding: br, zstd, gzip` honoured. Query strings are forwarded verbatim to the upstream (parameter *names* are
sorted for the cache key only; values untouched).

Error envelope (any non-2xx produced by burrow itself):
```json
{ "error": { "code": "upstream_unreachable|upstream_status|not_found|bad_request|forbidden|unavailable|internal",
             "message": "human readable",
             "upstream": { "url": "http://rm:8088/ws/v1/cluster/apps", "status": 503 }  /* optional */,
             "hint": "e.g. start Spark History Server or pass --spark-history" /* optional */ } }
```
Upstream non-2xx bodies (e.g. RM's `RemoteException` JSON) are passed through with the upstream status **unchanged** — except
that the `x-burrow-*` headers are still added. `502` is used for unreachable upstreams.

## 2. Meta (synthesized)

`GET /api/meta`
```jsonc
{
  "name": "burrow", "version": "0.1.0", "now": 1767225600000,        // server epoch ms (clock-skew correction)
  "readOnly": true,
  "rm":   { "urls": ["http://rm1:8088","http://rm2:8088"], "active": "http://rm1:8088", "haState": "ACTIVE"|"STANDBY"|null,
            "hadoopVersion": "3.4.3", "reachable": true },
  "services": {                                             // each: configured?, preferred url, urls, aggregate reachable
    "sparkHistory": { "configured": true, "url": "http://shs:18080", "urls": ["http://shs:18080", "http://shs-backup:18080"],
                      "reachable": true, "candidates": [{"url":"http://shs:18080","reachable":true},{"url":"http://shs-backup:18080","reachable":false,"reason":"connection refused"}] },
    "jobHistory":   { "configured": true, "url": "http://jhs:19888", "urls": ["http://jhs:19888"], "reachable": true,
                      "candidates": [{"url":"http://jhs:19888","reachable":true}] },
    "timeline":     { "configured": false }
  },
  "features": { "sparkLive": true, "sparkHistory": true, "aggregatedLogs": true, "nodeLogs": true, "events": true, "kerberos": false },
  "yarn": { "logServerUrl": "…|null", "httpPolicy": "HTTP_ONLY|HTTPS_ONLY|HTTP_AND_HTTPS", "scheduler": "capacity|fair|fifo|null" }
}
```
`GET /api/healthz` → `200 ok` (text, no upstream calls).

## 3. ResourceManager passthrough

`GET /api/yarn/{path}` ⇒ `{rm}/ws/v1/cluster/{path}` (query forwarded). The following JSON lists the read-only
upstream resources for the executable parity harness. RM paths are relative to `/ws/v1/cluster/`; NM paths are relative
to `/ws/v1/node/`; daemon paths are relative to the daemon root. Every concrete parameter must be available before a
resource is tested. `{type}` defaults to `LIFETIME`.

<!-- parity-resources -->
```json
{
  "rm": [
    "info", "metrics", "userinfo", "scheduler", "scheduler-overview",
    "scheduler/activities", "scheduler/bulk-activities", "scheduler/app-activities/{appId}",
    "scheduler-conf", "scheduler-conf/version", "apps", "apps/{appId}",
    "apps/{appId}/appattempts", "apps/{appId}/appattempts/{attemptId}",
    "apps/{appId}/appattempts/{attemptId}/containers",
    "apps/{appId}/appattempts/{attemptId}/containers/{containerId}",
    "apps/{appId}/{state|priority|queue|timeouts}", "apps/{appId}/timeouts/{type}",
    "appstatistics", "nodes", "nodes/{nodeId}", "nodes/{nodeId}/get-labels",
    "get-node-labels", "get-rm-node-labels", "get-node-to-labels", "label-mappings",
    "resource-profiles", "resource-types", "containers/{containerId}"
  ],
  "nm": ["info", "apps", "apps/{appId}", "containers", "containers/{containerId}"],
  "daemon": ["conf?format=json", "jmx?qry=Hadoop:*", "stacks", "metrics"],
  "nmDaemon": ["conf?format=json", "jmx?qry=Hadoop:*"]
}
```
<!-- /parity-resources -->

Anything outside the allowlist ⇒ `404 not_found`. Identifiers are validated (`[A-Za-z0-9_:.\-]+`). RM and NM REST collection
URLs accept a trailing slash. `resource-profiles`, `resource-types`, and top-level `containers/{containerId}` are compatibility
probes: **Hadoop 3.4.3 returns 404**. Obtain configured resource types from `scheduler` / `scheduler-overview`, and containers
from the application-attempt path. The singular `/apps/{appId}/timeout` is a mutation endpoint upstream; read a particular
expiry with `/apps/{appId}/timeouts/{type}`. Per-app `statistics` / `appactivities` / `activities` compatibility paths may
return 404; `appstatistics` and `scheduler/app-activities/{appId}` are the supported resources on Hadoop 3.4.3.

RM daemon pages (the legacy "Tools" menu):
`GET /api/rm/conf?format=json` · `GET /api/rm/jmx[?qry=…]` · `GET /api/rm/stacks` (text) · `GET /api/rm/metrics` (if exposed).
`GET /api/rm/logs` returns a **synthesized** JSON listing from RM HTML; `GET /api/rm/logs/{file}?offset&length` returns text.
The listing is not included in the passthrough wire proof, since its JSON deliberately differs from the daemon HTML.

NodeManager passthrough (host must be in the RM node list ⇒ SSRF guard):
`GET /api/nm/{host:port}/{path}` ⇒ `http(s)://{host:port}/ws/v1/node/{path}` for the NM resources above;
`GET /api/nm/{host:port}/conf|jmx` ⇒ daemon pages. The harness tests every known NodeManager, including its daemon endpoints.

## 4. Spark (resolved per YARN application)

`{appId}` = YARN application id (`application_<ts>_<n>`); the backend resolves the Spark REST base (RM web-proxy for live, History Server
for finished) and the Spark attempt id. `?attempt=N` overrides the default (latest).

`GET /api/spark/{appId}/source` (synthesized)
```json
{ "mode": "live-proxy|history|none", "baseUrl": "http://rm:8088/proxy/application_1_1", "sparkAppId": "application_1_1",
  "attempt": "1|null", "available": true, "reason": null, "hint": null }
```
Passthrough (Spark REST under `/api/v1/applications/{sparkAppId}[/{attempt}]/…`; query forwarded; same JSON as Spark):
```
GET /api/spark/{appId}/application                       (application info incl. attempts[])
GET /api/spark/{appId}/jobs[?status=]                    GET …/jobs/{jobId}
GET /api/spark/{appId}/stages[?status&details&withSummaries&quantiles&taskStatus]
GET /api/spark/{appId}/stages/{stageId}                  GET …/stages/{stageId}/{stageAttemptId}[?details&withSummaries&quantiles]
GET /api/spark/{appId}/stages/{stageId}/{stageAttemptId}/taskSummary[?quantiles]
GET /api/spark/{appId}/stages/{stageId}/{stageAttemptId}/taskList[?offset&length&sortBy&status]
GET /api/spark/{appId}/executors   GET …/allexecutors     GET …/executors/{execId}/threads (if supported)
GET /api/spark/{appId}/storage/rdd   GET …/storage/rdd/{rddId}
GET /api/spark/{appId}/environment
GET /api/spark/{appId}/sql[?details&planDescription&offset&length]   GET …/sql/{executionId}[?details&planDescription]
GET /api/spark/{appId}/streaming/{statistics|receivers|batches|…}
```
Spark failures map to: `404 not_found` (unknown app/path), `503 unavailable` (`error.code="unavailable"` with `hint`, e.g. no history server
for a finished app), `502` unreachable.

For Spark 2.x, SQL list and execution routes retain the same response schema: when Spark's SQL REST route answers 404 and
the application document reports a 2.x version, burrow reads the Spark UI's SQL list and execution pages and converts their
tables and plan DOT. HTML is parsed on the server and is never returned to the browser. If those pages are unavailable, the API
returns the upstream failure with a retry hint.

**DAG (synthesized — parsed from Spark HTML, never forwarded)**
`GET /api/spark/{appId}/dag/jobs/{jobId}` · `GET /api/spark/{appId}/dag/stages/{stageId}/{stageAttemptId}`
```ts
type Dag = {
  kind: "job" | "stage";
  granularity: "rdd" | "stage";          // "stage" = REST-only fallback (no RDD detail)
  jobId?: number;
  edgesInferred?: boolean;                // true ⇒ edges came from the REST-only fallback; never authoritative
  stages: DagStage[];                     // job: every stage of the job incl. skipped; stage: exactly one
  edges: DagEdge[];                       // cross-stage edges (node ids); job kind, and stage kind when the page has them
};
type DagStage   = { stageId: number; attempt?: number; skipped: boolean; label: string;
                    status?: string;            // fallback only (REST stage status)
                    rddIds?: number[];          // fallback only (REST rddIds)
                    clusters: DagCluster[]; nodes: DagNode[]; edges: DagEdge[] };   // intra-stage
type DagCluster = { id: string; name: string; parentId: string | null };            // operation scopes, may nest
type DagNode    = { id: number; name: string; callsite: string; cached: boolean; clusterId: string | null;
                    barrier?: boolean; determinism?: "determinate" | "unordered" | "indeterminate" };
type DagEdge    = { from: number | null; to: number | null; fromStage?: number | null; toStage?: number | null };
```
Verified against real captures (see `docs/spark-rest-and-dag.md`, fixtures for Spark 4.2.0 and 3.5.9):
Spark's REST API **never** exposes the RDD operation graph — it is emitted as a DOT graph in the job/stage page HTML
(`#dag-viz-metadata`); the SQL plan DAG *is* in REST (`/sql/{id}?details=true&planDescription=true` → `nodes[]`/`edges[]`);
SKIPPED stages have no DAG on their own stage page, so the extractor must read the enclosing **job** page for them;
structured streaming has no REST surface at all (HTML only).
The authoritative field set is finalised by the Spark-discovery slice in `docs/spark-rest-and-dag.md`; additive changes only.

## 5. Logs

```
GET /api/logs/containers/{containerId}?node=host:port&user=U&app=application_…
  → { "source": "nm|jhs|ats", "node": "host:port|null", "files": [ { "name": "stdout", "size": 123, "lastModified": 1767… } ] }
GET /api/logs/containers/{containerId}/files/{name}?node&user&app&offset=&length=&tail=N
  → text/plain; charset=utf-8   headers: x-burrow-log-size (total), x-burrow-log-start, x-burrow-log-end, x-burrow-log-source
     offset/length = byte range; tail=N = last N bytes; both absent = first 1 MiB; hard cap per request (default 8 MiB)
GET /api/logs/containers/{containerId}/files/{name}/stream?node&user&app&offset=
  → text/event-stream:  event: chunk  {"start":N,"end":M,"text":"…"} · event: eof {} · event: error {…}
```
`node`/`user`/`app` are hints the SPA already knows (from RM attempt/container lists); the backend validates `node` against the RM node list.

## 6. Events (SSE) — push invalidation, pull data

`GET /api/events?topics=t1,t2,…` (`text/event-stream`). A **topic is an API resource path without `/api/`** including its canonical query
(e.g. `yarn/metrics`, `yarn/apps?states=RUNNING`, `yarn/apps/application_1_1`, `spark/application_1_1/jobs`).
The list is split on **literal commas before decoding**: each topic is percent-encoded on its own and joined with `,`, so a comma
inside a topic's query (`yarn/apps?…&states=NEW,NEW_SAVING,…`) arrives as `%2C` and stays in the topic.
```
event: hello       data: {"serverTime":1767…,"topics":["…"]}
event: invalidate  data: {"topic":"yarn/metrics","etag":"W/\"…\"","at":1767…}
: heartbeat                                            (comment line every 15 s)
```
The hub polls a topic upstream **only while ≥1 subscriber exists**, at a topic-class interval, emitting only when the body hash changes.
The SPA keeps `refetchInterval` as a fallback when the stream is down. Max 64 topics per connection.

## 7. Static

`/` and any non-`/api` path ⇒ embedded SPA (`_shell.html` fallback for unknown paths); hashed `/assets/*` ⇒ `immutable`; precompressed br/gzip served by
`Accept-Encoding`; `index/_shell` ⇒ `no-cache`. Security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
CSP `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'`.
Host-header allowlist (loopback + `--allowed-host`); no CORS headers.
