# burrow backend architecture

One Rust binary (`crates/burrow`) plus one library (`crates/burrow-core`), packaged by maturin as a
`py3-none-<platform>` wheel that puts `burrow` on `PATH`. The binary embeds the built SPA, so a deploy
needs neither Node nor Java nor a Python runtime beyond the interpreter that unpacked the wheel.

This document covers **what exists today** and, explicitly, what the later slices own.

```
                 ┌─────────────────────────── crates/burrow (bin) ───────────────────────────┐
 browser ──HTTP──▶ cli.rs ──config──▶ app.rs ──/api/*──▶ burrow-core::api::dispatch            │
                 │                    │                  │                                         │
                 │                    └──assets──▶ assets.rs (rust-embed / --assets-dir)          │
                 └────────────────────────────────────────────────────────────────────────────────┘
                                                          │
                          ┌─────────────────────── burrow-core ───────────────────────────────┐
                          │ api.rs ─ routes/{table,meta,yarn,rm,nm}.rs ─ core.rs ─ cache.rs       │
                          │                                    │                                  │
                          │                     upstream.rs ─ rm_pool.rs ─ http.rs                │
                          └─────────────────────────────────────────────────────────────────────┘
```

## Module map

### `crates/burrow-core` (no socket, no axum — unit-tested in isolation)

| Module | Responsibility |
|---|---|
| `config.rs` | Layered resolution (`resolve`) of a `PartialConfig` stack into `Config`; validates URLs, headers, tokens, bind, `--base-path`, allowed hosts, tuning and cache limits. Every resolved key records **where it came from** (`Config::sources`) for the banner and `doctor`. |
| `hadoop_conf.rs` | Auto-discovery: reads `core-site.xml`/`mapred-site.xml`/`yarn-site.xml` (+ `${var}` expansion) and `spark-defaults.conf`; derives RM web addresses (single or HA via `yarn.resourcemanager.ha.rm-ids`, https-aware ports), `yarn.http.policy`, log-server/JobHistory URL, timeline address, Spark history address. Malformed files become warnings, never failures. |
| `http.rs` | One `reqwest` client pool (rustls/ring, optional custom CA / insecure), credential injection (`user.name`, `--header`, bearer) that never reaches the browser, per-endpoint semaphores, bounded body buffering with stream overflow. |
| `upstream.rs` | `Upstream` enum over `Single` / `RmPool` / `Fleet`; health + exponential backoff (`Health`), liveness `probe`, cache identity (`cache_id`). New upstream kinds = one enum variant + one constructor. |
| `rm_pool.rs` | ResourceManager HA (algorithm below), plus `probe`/`probe_all` used by `doctor` and `/api/meta`. |
| `cache.rs` | Single-flight TTL cache: canonical query keys, byte-weighted moka store, `TtlPolicy` per route class (including state-dependent app detail), stale-while-revalidate on failure, weak ETags from an xxh3 of the body, oversize streaming, stats. |
| `core.rs` | `Core`: the shared state (config, upstreams, cache, topics, events hub, memo, node-set) and the single read path `served`/`reply`; query sanitisation; `Memo` (coalesced non-body computations); `node_authorities`; `shared()` (a `Weak` self-handle so long-lived tasks can own the state they poll). |
| `api.rs` | Transport-agnostic `ApiRequest`, the group dispatcher, `/api/healthz`. |
| `routes/table.rs` | Data-driven route table: one regex per allowed resource (with `{id}` → `[A-Za-z0-9_:.\-]+` and dot-only segments rejected), carrying TTL class, expected content type and optional upstream rewrite. The same table is the allowlist and the cache policy. |
| `routes/yarn.rs` | `/api/yarn/{path}` → `{rm}/ws/v1/cluster/{path}`. |
| `routes/rm.rs` | `/api/rm/*`: `conf`/`jmx`/`stacks`/`metrics` passthrough (`/logs/` HTML → JSON listing; `/logs/{file}` with `offset`/`length` → HTTP `Range`). `/logLevel` is deliberately absent (it mutates through GET). |
| `routes/nm.rs` | `/api/nm/{host:port}/*` with the **SSRF guard** (§Security). |
| `routes/meta.rs` | `/api/meta` (synthesized) and its memoized probing. |
| `logs/source.rs` | Container-log source resolution (contract §5): NodeManager for a live container, JobHistoryServer for an aggregated one, `503` + hint when neither answers. Node targets come from the RM's own node list (same fail-closed SSRF guard as `routes/nm.rs`); the JHS target is always the configured upstream. Also the byte-window math and the ranged read. |
| `logs/page.rs` | Parsers for the HTML log pages both daemons serve (there is no raw-text endpoint): `<pre>` extraction + HTML-entity unescaping, the NodeManager `Local Logs:` listing, the JobHistoryServer `Log Type:`/`Log Length:` sections, and Java `Date.toString()` → epoch. |
| `logs/tail.rs` | The server-side offset tailer behind `…/files/{name}/stream`: polls `[offset, offset+256 KiB)` with backoff, emits `chunk`/`eof`/`error` SSE frames, and stops on client disconnect, the 30-minute deadline or the 64 MiB cap. |
| `events/mod.rs` | The SSE hub (contract §6): topic registry validation, per-topic subscriber refcounts, one global poller that polls a topic **only while subscribed** at its class interval, change detection by body hash, 15 s heartbeat, `hello` on connect, 64 topics/connection and 256 topics process-wide, unsubscribe-on-disconnect. Polls go through `api::dispatch`, so they share the cache and single flight with browser GETs. |
| `routes/logs.rs` | `/api/logs/*`: the synthesized listing, the ranged read (`x-burrow-log-*` headers, 8 MiB hard cap) and the follow stream. Log bodies are never cached. |
| `routes/events.rs` | `/api/events`: topic parsing and the `text/event-stream` reply. |
| `spark/resolve.rs` | Per-YARN-app Spark source resolution (`live-proxy` via `{rm}/proxy/{appId}`, `history` via the Spark History Server, `none`), the conditional attempt-id rule, and the `reason`/`hint` for an unavailable source. Live findings are in the module docs. |
| `spark/dag.rs` | Spark RDD DAG extractor: `#dag-viz-metadata` DOT (job/stage HTML) → the contract §4 `Dag` JSON, the REST-only stage fallback and the skipped-stage recovery rule. A mirror of `fixtures/spark/tools/dagparse.py`, verified against every golden. |
| `routes/spark.rs` | `/api/spark/{appId}/…`: the `/source` payload, the REST passthrough (allowlist table with a **live and a history TTL class**), and `/dag/jobs/{id}` / `/dag/stages/{id}/{attempt}`. UI HTML is parsed, never forwarded. |
| `reply.rs` | `Reply` (transport-agnostic) + the browser-safety rules: non-2xx HTML → JSON envelope, 2xx HTML never forwarded as HTML, only `content-type`/`content-range`/`accept-ranges` survive, `conditional()` for `304`. |
| `error.rs` | `ApiError` + `ErrorCode` and the envelope from `docs/contracts/api.md` §1; URL credential redaction. |
| `html.rs` | HTML detection, HTML error page → one-line message, Jetty directory listing → `LogFile` entries (both the classic positional layout and Jetty ≥ 9's `class="size"/"lastmodified"`). |
| `topics.rs` | The SSE hub's topic registry: per-class poll intervals (longest prefix wins) + the `features.events` flag. No I/O — the hub in `events/` does the polling. |

### `crates/burrow` (bin/HTTP layer)

| Module | Responsibility |
|---|---|
| `cli.rs` | clap definitions (every flag also reads `BURROW_*`), the CLI/TOML/conf layer stack, `serve` and `doctor` output. Uses `ArgMatches::value_source` so "flag" and "env" are distinguished per key. |
| `app.rs` | The axum router: one fallback handler that splits `/api` from static, the `x-burrow-*` response contract, `Reply` → HTTP (including `304`), Host allowlist middleware, security headers, compression, bind-with-port-fallback, startup banner, graceful shutdown, plus `state_for`/`serve_ephemeral` for tests. |
| `assets.rs` | Static delivery: `rust-embed` (staged + precompressed by `build.rs`) or `--assets-dir`; percent-decoded, traversal-proof lookup; `Accept-Encoding` negotiation (`br` → `gzip` → identity) with correct `Content-Encoding` tokens; the "assets not built" page. |
| `build.rs` | Stages `BURROW_ASSETS_DIR` / `web/dist/client` / `crates/burrow/assets` into `$OUT_DIR/burrow-assets`, writes `.br`/`.gz` siblings for compressible files, and warns when no shell was found. |

## Request path (a GET that misses the cache)

1. `app::handle` rejects non-GET (405 + `allow: GET`), strips `--base-path`, and splits `/api/...` from static.
2. `api::dispatch` picks the group; each group resolves its route table (no match ⇒ `404 not_found`, before any upstream contact).
3. `Core::served` builds the cache key `(upstream id, path, canonical query)` — parameter *names* are sorted for the key only; the browser's query string is forwarded verbatim after dropping `user.name`/`doas`/`delegation`/`token`.
4. `Cache::get`: fresh hit → serve; otherwise join or lead a single flight. The leader fetches into a bounded buffer; bodies over `max_body_bytes` are streamed through and remembered as oversized; 2xx bodies are stored with a per-class TTL (`TtlPolicy`, `AppState{live,terminal}` for app detail).
5. Failures: transport error or 5xx ⇒ serve the previous entry as `stale` if it is younger than `max_stale`, else the error; 4xx/5xx bodies are passed through, shared with the waiters and never stored.
6. `Reply::from_served` applies the browser-safety rules; `app::api_response` adds `x-burrow-api`, `x-burrow-cache`, `x-burrow-upstream`, `x-burrow-age`, `etag`, `cache-control: no-cache`, and turns a matching `If-None-Match` into an empty `304`.

A `Cache-Control: no-cache` request goes straight through (`x-burrow-cache: bypass`); the fetch still refreshes
the entry, which is what makes the parity harness and hard reloads both correct and cheap.

## Cache design notes

* **One upstream request per resource per TTL.** 200 concurrent identical requests ⇒ 1 fetch (integration
  test: `two_hundred_concurrent_identical_requests_hit_the_upstream_exactly_once`; measured split
  `miss=1 coalesced=132 hit=67` on a 4-worker runtime — the non-misses either shared the flight or read the
  fresh entry, and the upstream saw exactly one request).
* **TTL classes** come from the route tables: metrics/activities 1 s, apps 2 s, running-app detail 1 s,
  terminal app detail 60 s, nodes/scheduler 3 s, conf 60 s, resource types 60 s; log files and any
  `Range` request are never cached (`TtlPolicy::None`).
* **Memory bound**: moka with a byte weigher (`max_bytes`, default 128 MiB), a `time_to_live` of
  `max_stale`, and a hard `max_body_bytes` (default 32 MiB) above which bodies stream through uncached.
* **ETags** are weak (`W/"<128-bit xxh3>"`), so they survive compression and cheap revalidation.
* **`x-burrow-cache`** is `hit`, `miss`, `coalesced`, `stale` or `bypass`; `x-burrow-upstream` is present only when a
  real fetch happened.

## ResourceManager HA algorithm

1. Candidates = endpoints not in backoff, ordered *remembered active → non-standby → standby*. If all are in
   backoff, fail fast (502) with the remaining wait time instead of hammering dead RMs.
2. Try the first candidate:
   * transport error → record failure (exponential backoff, 1 s → 15 s cap), forget it as active; **connect**
     errors move on to the next candidate, other errors (timeouts, truncated responses) are returned as-is
     because the request may have reached the RM and GETs must not be replayed blindly;
   * `3xx` (a standby redirecting) → mark standby, jump to the configured RM whose authority matches
     `Location` (never to an arbitrary host);
   * `503` with more than one RM configured → treat as "not ready/standby", remember as a fallback and try
     the next;
   * `/ws/v1/cluster/info` → read `haState`; `ACTIVE` is remembered, `STANDBY` is only a fallback;
   * any other answer is returned, and for `/ws/v1/cluster/*` it also becomes the remembered active.
3. `doctor` and `/api/meta` use `probe_all` (no force): an RM in backoff is reported rather than contacted.

## Security posture

* **Bind loopback by default**; no CORS headers anywhere; a Host-header allowlist (loopback, the bind
  address, `--allowed-host` entries, `*`) rejects anything else with 403 before routing.
* **SSRF**: `/api/nm/{host:port}` is only reachable for authorities in the RM's own node list
  (`nodeHTTPAddress`, cached by body ETag) — and the guard **fails closed**: if the node list cannot be
  read, no NodeManager request is made. Fleet endpoints are constructed from the authority, never from a
  browser URL.
* **No open proxy**: routes are an allowlist of regexes; identifiers are validated; dot-only segments are
  rejected; asset lookups percent-decode before validating segments and then canonicalise.
* **Upstream credentials** (`--user`, `--header`, `--token`, URL userinfo) are attached only in `http.rs`;
  responses carry an allowlist of upstream headers (`content-type`, `content-range`, `accept-ranges`) and
  errors carry a redacted URL. Query parameters that would let a browser choose the effective user are
  stripped.
* **Browser-visible hardening**: `nosniff`, `referrer-policy: no-referrer`, the contract's CSP on every
  response, HTML from an upstream never forwarded as HTML.
* Never `unsafe`, no `dlopen`; Kerberos is a later, explicitly-disabled slice.

## Extension points left in place (for later slices)

| Slice | Where it plugs in |
|---|---|
| **SSE hub** (`/api/events`) | **Implemented** (`events/mod.rs`, `routes/events.rs`): topics are polled *through* `api::dispatch`, so the hub reuses the cache and single-flight machinery (a hub poll and a browser GET for the same resource are one upstream fetch). `features.events` reports `true`. |
| **Spark** (`/api/spark/*`, `/api/spark/*/dag/*`) | **Implemented** (`spark/{resolve,dag}.rs`, `routes/spark.rs`): the resolver picks `live-proxy`/`history`/`none` per YARN app, the passthrough table carries a live **and** a history TTL class, and the DAG routes parse Spark's UI HTML (never forwarding it). `/api/meta`'s `features.sparkLive|sparkHistory` are now `true`. |
| **Logs** (`/api/logs/*`) | **Implemented** (`logs/{source,page,tail}.rs`, `routes/logs.rs`): NodeManager listing/ranged read/follow for live containers, JobHistoryServer aggregated logs for finished ones, `503` + hint when neither answers. `/api/meta`'s `features.{nodeLogs,aggregatedLogs}` are `true`. |
| **New RM resources** | One line in `routes/yarn.rs`'s `ROUTES`. |
| **New upstream kind** | One `UpstreamKind` variant + one constructor line in `Core::new`. |

## Findings against the real cluster (Spark, verified live)

Evidence: `BURROW_LIVE=1 cargo test -p burrow --test spark_live -- --nocapture` plus the served binary
(`burrow serve --rm http://127.0.0.1:8088 --spark-history http://127.0.0.1:18080`) against cluster
`1791015583684`. Quoted output is verbatim.

* **The RM web proxy needs no approval handshake with simple auth.** `GET {rm}/proxy/{appId}/` answered
  `200` with 35 KB of Spark UI HTML, and `/proxy/{appId}/api/v1/applications/{appId}` forwards verbatim
  (`x-burrow-upstream: 127.0.0.1:8088`). `WebAppProxyServlet.securityEnabled` is
  `UserGroupInformation.isSecurityEnabled()` = false here, so the `proxyapproved?…&cake=true` page and the
  `checked_<appId>` cookie are never issued. With Kerberos the handshake *would* be required — untested.
* **Attempt ids exist only in history mode.** A RUNNING cluster-mode app's driver document reports
  `attempts[0]` **without** an `attemptId` (`attempts [(None, False)]`) and `…/applications/{id}/1`
  answers `404` on the driver; the live driver accepts `/jobs` with *and* without an attempt segment
  (identical 7794 B). The SHS does report `attemptId: "1"` and 404s without the segment for a cluster-mode
  app. So: segment iff known, `?attempt=N` always wins, `source.attempt` is `null` for `live-proxy`.
  `?attempt=1`/`?attempt=2` on the two-attempt app `…_0012` both answer `200` (9373 B each).
* **`/application` is the bare document.** Spark serves `{id,name,attempts[]}` at
  `/api/v1/applications/{appId}` (715 B) and returns a *narrower attempt object* (no `id`/`name`) at
  `/applications/{appId}/{attemptId}` (593 B); `/application` as a path is a `404`. The route therefore
  rewrites to the bare document — that is what makes `GET /api/spark/{appId}/application` work from the
  history server alone.
* **The skipped-stage rule is real and exercised live.** Stage 9 of `…_0001` is `SKIPPED`; its SHS stage
  page is a 4 624 B placeholder with no `#dag-viz-metadata`, yet
  `GET /api/spark/{appId}/dag/stages/9/0` answered `200 {"kind":"stage","granularity":"rdd",…}` with
  `edges:[{from:4,to:5,fromStage:9,toStage:10}]` — resolved from the enclosing job page.
* **Passthrough fidelity and headers.** In history mode `GET /api/spark/{appId}/jobs` is **byte-identical**
  (3 768 B) to `{shs}/api/v1/applications/{appId}/1/jobs` with `Cache-Control: no-cache` on both sides;
  the live route reports `x-burrow-cache: hit` on the second call and the derived DAGs revalidate with `304`.
* **Spark's own text/plain errors pass through.** `…/stages/9/0/taskSummary` → `404 No tasks reported
  metrics for 9 / 0 yet.`; `…/executors/driver/threads` on the SHS → `503 Thread dumps not available
  through the history server.`; `…/streaming/statistics` → `404 no streaming listener attached to
  <name>`. Status and body are preserved byte-for-byte (only the `x-burrow-*` headers are added), so a `503`
  produced by burrow itself is distinguishable from Spark's own.
* **Pending applications.** The ACCEPTED app `…_0013` (the `root.adhoc` AM-quota trap) yields
  `mode: "live-proxy", available: false, reason: "…is ACCEPTED: its Spark driver web UI is not running
  yet"`, and any passthrough is `503 {"error":{"code":"unavailable",…,"hint":…}}`.

## Findings against the real cluster (Hadoop 3.4.3, verified live)

Evidence: `BURROW_LIVE=1 cargo test -p burrow --test live_cluster -- --nocapture` (the run is quoted in the
slice report).

* **Allowlist vs reality.** These REST paths are in `docs/contracts/api.md` §3 but do **not** exist on
  RM 3.4.3 — they answer `404` with an HTML error page: `apps/{id}/activities`, `apps/{id}/appactivities`,
  `apps/{id}/statistics`, `resource-types`, `resource-profiles`, `cluster-user-info`, and the daemon page
  `/metrics` (note: `/ws/v1/cluster/metrics` **is** served). They stay in the table (the contract owns it)
  and are passed through honestly: status preserved, HTML converted to the JSON envelope.
  `GET /ws/v1/cluster/apps/{id}/timeout` answers `503` with the RM's `RemoteException` JSON.
* **`apps/{id}/{state,priority,queue,timeouts}` *are* served** (`200`, e.g. `{"state":"RUNNING"}`,
  `{"priority":0}`, `{"queue":"root.etl.transform"}`, `{"timeouts":{…}}`) — measured on a RUNNING and a
  FINISHED app. An earlier reading of mine had them as 404; that was a **stale app id from a previous RM
  incarnation** (the RM forgets applications when it restarts, and `scheduler/app-activities/{id}` answers
  `200` with a "fail to get application activities" diagnostic even for an unknown id, so the staleness was
  invisible). ClusterInfra2 caught it; the live test now pins both halves of the claim from fresh ids.
* **Per-application scheduler activities live elsewhere.** The real path is
  `GET /ws/v1/cluster/scheduler/app-activities/{appId}` (RM 3.4.3, verified `200`). Added to the table as
  an additive line; the `apps/{id}/appactivities` entry is dead on 3.4.3.
* **`scheduler-overview`** (`/ws/v1/cluster/scheduler-overview`) exists and is the only source for
  minimum/maximum allocation and max application priority; added (`1s` TTL).
* **`/conf?format=json`** returns JSON only when the request *also* carries `Accept: application/json`
  (Hadoop's `ConfServlet` content-negotiates on `Accept`). burrow sets `Accept: application/json`
  exactly for routes whose expected content type is JSON, so `/api/rm/conf?format=json` is JSON while
  `/api/rm/conf` stays the daemon's default XML. The browser's own `Accept`/`Accept-Encoding` are never
  forwarded (they would fragment the cache, and compression to the browser is ours).
* **RM log listing layout** is Jetty 12's `<td class="name|lastmodified|size">`; the parser handles that
  *and* the classic positional layout (both have unit tests, the modern one with a verbatim capture).
* **SSRF allow-set** must use `nodeHTTPAddress` only — the node `id` is `host:<RPC port>` (`127.0.0.2:8041`),
  which is not an HTTP endpoint. Both are in `/ws/v1/cluster/nodes`, so using `id` as a fallback made the
  guard (and `doctor`) admit a port that 404s.
* **Volatile endpoints** (worth knowing for the parity harness): `/ws/v1/cluster/apps` and
  `scheduler/activities` change while you look at them, `/scheduler/app-activities/{id}` embeds the
  *request time* in `appActivities.timestamp`, and RUNNING apps' `progress` moves every second. The live
  test therefore proves parity three ways (byte-identical; id-keyed "every app that did not change
  mid-comparison"; key/type-shape identity), instead of pretending a live document is stable.

## Findings against the real cluster (logs + SSE, verified live)

Evidence: `BURROW_LIVE=1 cargo test -p burrow --test logs_live --test events_live -- --nocapture` against
cluster `1791015583684`; quoted output is verbatim. The daemons' own source (`ContainerLogsPage.java`,
`NMWebAppFilter.java`, `TFileAggregatedLogsBlock.java`) was read alongside the wire captures.

* **Neither daemon has a raw-text log endpoint.** `GET {nm}/node/containerlogs/{cid}/{user}[/{file}/]` and
  `GET {jhs}/jobhistory/logs/{nodeId}/{cid}/{cid}/{user}[/{file}/]` always answer `text/html`; the file
  content is one `<pre>` block, HTML-escaped (`&lt;`, `&quot;`, …). `Range:` is ignored. burrow extracts
  and unescapes the text and serves `text/plain`; the page itself is never forwarded.
* **The trailing slash is part of the contract.** Without it the JobHistoryServer silently answers with the
  *listing* page instead of the requested file (200, no `<pre>`, no `Log Length`), so `file_path()` appends
  one for both daemons.
* **The NodeManager 307s to the log server** once the application has left its context (or
  `log.aggregation.type=remote`), with `Location: {yarn.log.server.url}/{nodeId}/{cid}/{cid}/{user}…`.
  burrow refuses upstream redirects (SSRF/credential hazard) and instead picks the JobHistoryServer up
  front from the application's terminal state; the redirect is still the fallback trigger when a live
  lookup 404s (`NM 404 → JHS` is covered by `logs_routes.rs`).
* **`?start=`/`?end=` are byte offsets on both daemons** (`start` default `-4096` = from the end). The
  JobHistoryServer honours them exactly and prints the file's full length, which is where `x-burrow-log-size`
  comes from; the NodeManager prints only "Total file length is N bytes." on its listing.
* **`logsLink` in `appattempts` already points at the right daemon** (`{nm}/node/containerlogs/…` while the
  app runs, `{jhs}/jobhistory/logs/…` once it finished) — but it only covers the AM container, so a task
  container's node is resolved from the RM node list (`nodeHTTPAddress` → `nodeId`, the key the JHS URL
  needs) and/or the browser's `?node=` hint.
* **Live numbers** (cluster `1791015583684`): RUNNING `…_0011` on `127.0.0.3:8042` → NM listing with 6
  files, `stdout` 1 777 B, ranged read served 200 B, follow first `chunk` after **42 ms** with
  `{"start":0,"end":1777}`. Aggregated `…_0009` `stdout` = **5 245 011 B**: a mid-file 256 KiB window
  served 262 144 B in **244 ms**, `tail=1024` served 1 024 B, and following from offset 5 244 911 reached
  `eof` in **39 ms**.
* **SSE**: `/api/events?topics=yarn/metrics` sent `hello` immediately, the hub's first poll made a
  subsequent `GET /api/yarn/metrics` a `x-burrow-cache: hit` (`x-burrow-age: 743`), and a real
  `invalidate {"topic":"yarn/metrics","etag":"W/\"70de4dc2…\"","at":1791016230216}` arrived when the
  cluster metrics moved — i.e. the hub polls through the shared cache, not beside it.
* **SSE must be excluded from compression.** `tower-http`'s encoder buffers until its window fills, so a
  `text/event-stream` response would deliver nothing until the connection ended; `app.rs` now passes a
  `compress_when` predicate that skips it.

## Contract change requests (owner: integration owner, `docs/contracts/api.md`)

1. §3 allowlist: add `scheduler-overview` and `scheduler/app-activities/{appId}`; drop
   `statistics`/`appactivities`/`activities` from the `apps/{appId}/…` alternation and drop
   `resource-types`/`resource-profiles`/`cluster-user-info` (all 404 on RM 3.4.3, verified). Keep
   `state|priority|queue|timeouts` — those **are** served (200), and keep `timeout` (singular), which
   answers 503 with the RM's `RemoteException`. (An earlier version of this request wrongly listed
   `state|priority|queue|timeouts` as dead; corrected after ClusterInfra2 re-measured them.)
2. §3 RM daemon pages: document the synthesized `/api/rm/logs` entry shape actually served —
   `{"files":[{"name": string, "size": number, "modified": string|null, "isDir": bool}]}` where `modified`
   is the zone-free locale string from Jetty (never an epoch). The epoch `lastModified` belongs to the §5
   container-log shape only.
3. §1 error envelope: state that a non-2xx **HTML** body from an upstream is replaced by the envelope with
   the upstream status preserved (and `error.upstream.{url,status}` naming the origin) — that is what
   `reply.rs` does on purpose, because an upstream page must never be forwarded as HTML on our origin.
   Non-2xx **JSON** bodies pass through byte-for-byte.
4. §5 logs: state that the byte window is **UTF-8-lossy** and that `x-burrow-log-start`/`x-burrow-log-end` report
   the *requested* window (clamped to the file), while `x-burrow-log-size` is the file's true length as the
   daemon reports it; an offset past EOF is a `200` with an empty body and `start == end == size`.
   Also state that `lastModified` is `null` for `source:"nm"` (the NodeManager's listing prints only a
   size) and epoch **milliseconds** for `source:"jhs"` (parsed from the page's Java `Date.toString()`
   upload stamp), and that a container no source can serve is a `503 unavailable` with a `hint` naming
   each source tried — there is no `source:"none"` on the wire.
5. §6 events: state that a topic must match a registered class (`yarn/*`, `rm/jmx`, `rm/conf`, `spark/*`);
   an unknown topic is `400 bad_request` rather than silently polling arbitrary upstreams, and beyond
   `MAX_TOPICS` (256) distinct topics the hub answers `503 unavailable`. `?topics=` may be repeated as
   well as comma-separated.
6. §5 logs: `node` in the listing echoes the resolved NodeManager authority (or `null` for an aggregated
   read), and `?node=`/`?user=`/`?app=` are hints the backend validates against the RM's node list — a
   foreign host is `403 forbidden`, not a proxy.

## What is deliberately *not* here

* `ats` as a log source: the Timeline Service serves container *metadata*, never log content, and this
  cluster runs `yarn.timeline-service.enabled=false`; `/api/logs/*` therefore reports `nm` or `jhs` only.
  The `features` object describes **this build's capability**; the *environment* is described under
  `services.*` (`configured`/`url`/`urls`/`reachable`/`candidates`), so each configured Spark History or
  JobHistory endpoint is visible and probed independently, and a running server is visible even
  when no Spark application is resolvable.
* Spark **Structured Streaming** has no REST surface at all (its UI is server-rendered HTML); the
  DStream `/streaming/*` passthrough is exposed, Structured Streaming tables are not parsed.
* Runtime discovery reads the active RM's effective `/conf` and recent finished-app tracking links. Operator-set
  service addresses are added as fallback endpoints. App tracking destinations are displayed by `doctor` as
  suggestions; when a link goes through the RM web proxy, Burrow reads the RM's redirect Location but never follows
  it. A Spark History Server that is only derivable from an application's tracking URL is reported as `history` with
  `available:false` and a `hint` to pass `--spark-history <url>` (see `spark/resolve.rs`).
* Kerberos/SPNEGO, write actions, multi-cluster, persisted history.
* `--base-path` is enforced for routing but the SPA must be built with a matching base (its asset URLs are
  absolute).
* Upstream non-2xx bodies from passthrough routes are forwarded **unchanged** except that HTML error pages
  become the JSON envelope (status preserved) — this is what makes byte-parity testable.

## Test map

| Layer | Where | What it proves |
|---|---|---|
| Unit | `crates/burrow-core/src/*` (`#[cfg(test)]`) | config precedence/validation, Hadoop-conf discovery (single/HA/https/spark-defaults/malformed), cache keys + canonical query + ETag compare + terminal-state detection, HTML→JSON listing (both Jetty layouts), route tables + id validation, meta mapping helpers, topic registry. |
| Integration (no network, no JVM) | `crates/burrow/tests/` | `passthrough.rs` — byte fidelity, upstream status/body passthrough, HTML→envelope, 502s, query forwarding + sanitisation, credential containment, `/api/meta`, `/api/healthz`, 404s/traversal/verbs, Host allowlist, security headers. `cache_behaviour.rs` — 200-way coalescing (1 upstream hit), TTL, terminal-vs-running TTL, SWR + stale expiry, ETag/304, bypass, oversize streaming, byte budget, canonical keys, stats. `routes_rm_nm.rs` — daemon pages, synthesized log listing, `Range` translation and rejection, uncached log files, NM allowlist + SSRF guard + fail-closed, inventory allowlist mappings. `ha_failover.rs` — 307 standby, `haState: STANDBY` fallback, connect-error failover, no-replay-after-mid-flight-death, all-down + backoff, duplicate `--rm` collapse. `static_assets.rs` — shell/no-cache, SPA fallback, immutable hashed assets, 404 for missing files, br/gzip selection + decoding, percent-encoded names, raw-socket traversal probes, placeholder page, Host allowlist, `--base-path`, and (when `web/dist/client` exists) the real embedded SPA byte-for-byte. |
| Live (opt-in) | `crates/burrow/tests/live_cluster.rs` (`BURROW_LIVE=1`, reads `.cluster/endpoints.json`) | Against the real ResourceManager/NodeManagers: `/api/meta` facts, byte-identical + deep-equal parity for 15 RM resources and every real app's detail/attempts/activities, RM daemon pages + a real log window, NM passthrough + SSRF denial, coalescing on the live RM, `304` revalidation. |
| Spark (no JVM, no network) | `crates/burrow/tests/spark_dag.rs`, `spark_routes.rs` | Every captured Spark UI page (722 across 4.2.0+3.5.9) and every golden (366 per version: 276 RDD + 90 REST-only fallback) reproduces exactly — 732 deep-equal comparisons, 0 mismatches; error shapes (unknown id, no metadata, truncated, non-UTF-8, oversize); resolver live/history/none + attempt override + RM down + SHS down + tracking-URL derivation; passthrough path shape, verbatim query, live/history TTL, ETag/304, error envelopes; DAG routes incl. a skipped stage recovered from the job page and the REST fallback. |
| Spark (live, opt-in) | `crates/burrow/tests/spark_live.rs` (`BURROW_LIVE=1`) | Real `/source` resolution (RM web proxy when an app is RUNNING, SHS otherwise), `/application` from the history server alone, `/jobs`+`/stages` through the resolved base (byte-identical to the SHS in history mode), and a real job/stage DAG parsed from the UI HTML — the skipped-stage recovery included. |
| Logs + SSE (no network) | `crates/burrow/tests/logs_routes.rs`, `events_hub.rs` | Logs: NM listing/ranged read/`tail=N`/default window/offset-past-EOF, `x-burrow-log-*` headers, never-cached bodies, `NM 404 → JHS` and `NM 307 → JHS` fallbacks, `503` + every reason when both fail, SSRF rejection for a foreign/unknown host, bad parameters rejected before any upstream contact, and a follow stream that reports **mid-stream growth** then `eof` (and an aggregated follow that replays then `eof`s). SSE: `hello`, one upstream poll for a topic, the hub poll and a GET sharing one fetch (`hit`), one `invalidate` per change and none without, heartbeat timing, the 64-topic cap, unknown-topic rejection, and disconnect stopping the polling. |
| Logs + SSE (live, opt-in) | `crates/burrow/tests/logs_live.rs`, `events_live.rs` (`BURROW_LIVE=1`) | A real RUNNING container's NM listing + ranged read + follow (first `chunk` in ~42 ms), a real 5.2 MB aggregated `stdout` (mid-file 256 KiB window, `tail=1024`, follow-to-`eof`), and the SSE hub against the live RM: `hello`, a cache `hit` right after the hub's poll, and a real `invalidate` when the cluster metrics move. |

Run: `cargo test --workspace` (plus `BURROW_LIVE=1 cargo test -p burrow --test live_cluster --test
logs_live --test events_live -- --nocapture` with the test cluster up), `cargo clippy --all-targets -- -D
warnings`, `cargo fmt --check`.
