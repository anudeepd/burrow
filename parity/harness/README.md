# `parity/harness` — the executable parity proof

This directory is the **acceptance gate** for burrow (PLAN.md §8). It answers one question with
evidence from a *real* cluster and a *real* browser: **does our UI show exactly what YARN shows, and
nothing less?**

It is not a unit-test suite. It drives the stock Hadoop Hamlet UI and our SPA with Playwright, reads
the `data-yf`/`data-yv` contract out of our DOM (never our source), fetches the upstream REST
payloads, and diffs all three against the machine-readable inventory in `parity/inventory/`.

```
inventory item ──label──▶ legacy DOM text ─┐
       │                                    ├──▶ normaliser ──▶ canonical value ──▶ status
       └──field id──▶ our DOM data-yv ───────┤
                       rest.path ──▶ live REST payload ─┘
```

## The three proofs

| stage | what it proves | entry point |
|---|---|---|
| **P1** `coverage.mjs` | every REST key the live RM/NM emits is declared by the inventory (or waived), and every *required* inventory field is rendered by our DOM crawl | `bun run coverage` |
| **P2** `run.mjs` | per page × scenario × field, the stock UI text ≡ our raw value ≡ the REST value | `bun run parity` |
| **P3** `wire.mjs` | every proxied endpoint through burrow is deep-equal to the direct upstream body (plus Spark REST/id coverage) | `bun run wire` |

`run.mjs` orchestrates all three (`--stages p1,p2,p3`, the default) and writes the report.

## Commands

```bash
cd parity/harness

# --- live, against the running cluster (RM 8088 by default, from .cluster/endpoints.json)
bun run parity                          # P1+P2+P3, writes parity/report/{index.html,summary.json}
bun run parity --stages p2              # differential only (fastest)
bun run parity --scenario live-all      # one scenario
bun run parity --ours http://127.0.0.1:8787        # real Rust backend
bun run parity --ours-serve             # no backend yet: serve web/dist/client + proxy /api to the RM
bun run parity --keep-captures          # also dump every legacy/ours capture under parity/report/raw

# --- coverage / wire on their own
bun run coverage                        # P1 only, prints real totals, writes parity/report/coverage.json
bun run wire                            # P3 only
bun run wire --ours http://127.0.0.1:8787

# --- record once (live), replay forever (no Java, no cluster, no network)
bun run parity --record fixtures/parity/live --ours-serve
bun run parity --fixtures fixtures/parity/live --assert-no-network

# --- self-test: a green run must be able to go red
bun run selftest                        # replays fixtures, corrupts one upstream value, asserts detection
bun run selftest --fixtures fixtures/parity/live --keep

# --- the optional SPA dev server used by --ours-serve
bun run lib/static-server.mjs --root web/dist/client --rm http://127.0.0.1:8088 --port 8899
```

Every script is headless, re-runnable and idempotent. `bun run parity` never mutates the repo unless
`--record`/`--keep-captures` is passed.

## Options (`run.mjs`)

| flag | meaning |
|---|---|
| `--rm URL` / `--legacy-url URL` | legacy UI base (default `.cluster/endpoints.json` → `rm.webapp`) |
| `--ours URL` | our SPA base (default `http://127.0.0.1:8787`, auto-falls back to `:5173`) |
| `--ours-serve [DIR]` | serve `web/dist/client` (default) with an `/api`→live-RM passthrough when the Rust backend is not up |
| `--ours-port N` | port for `--ours-serve` (default 8899) |
| `--scenario a,b` | scenario ids from `scenarios/*.yaml` (default: all) |
| `--stages p1,p2,p3` | which proofs to run (default all three) |
| `--record DIR` | run live and write fixtures to `DIR` (repo-root relative) |
| `--fixtures DIR` | replay from `DIR`; **no network at all** |
| `--assert-no-network` | install a fetch guard; any live fetch throws (used in replay) |
| `--report DIR` | report output (default `parity/report`) |
| `--keep-captures` | dump legacy HTML / records / our datums under the report dir in live mode |
| `--reuse-captures` | no RM load for the legacy side: re-extract `parity/report/raw/<scenario>/<page>.legacy.html` with the *current* `toRecords` (so key/extraction fixes apply immediately; falls back to `<page>.records.json`, whose keys are then NOT re-derived) and reuse `ours-<route>.json`; `--refresh` overrides |
| `--strict-inventory` | treat an incomplete/invalid inventory as fatal instead of a reported blocker |
| `--quiet` | less logging |

## Statuses

| status | meaning | fails the gate |
|---|---|---|
| `match` | legacy text, our raw value and the REST value agree after normalisation | no |
| `waived` | `parity/waivers.yaml` (or a registry waiver) explains it | no |
| `ours-only` | we render it, legacy has no counterpart (info) | no |
| `chrome-only` | static chrome item (`static.*`: nav/legend/button) — our chrome is intentionally different (PLAN.md §5) | no |
| `not-observable` | a `when:` condition is unmet, or the inventory declares a `scenario:` the cluster does not satisfy | no (justified) |
| `not-applicable` | the page has no SPA counterpart, declared with a reason in `config/routes.yaml` | no |
| `sampling-race` | numeric live counter/gauge in `cluster.metrics.*`/`scheduler.*`/`queue.*`/`node.*` where the stock DOM snapshot and the REST sample disagree — the two can never be simultaneous on a cluster someone else is driving; counted and displayed, not hidden | no (review) |
| `legacy-only` | **the stock UI shows it and we never rendered it** | **yes** |
| `mismatch` | **both sides present but incompatible** (legacy↔rest, legacy↔ours, or ours↔rest) | **yes** |
| `absent` | neither side rendered it and nothing justifies it (needs a `when:`/`scenario:` in the inventory) | **yes** |
| `unmapped` | the inventory item has no `label`, so there is nothing to join on | **yes** |

Exit code is non-zero unless only `match`/`waived`/`ours-only`/`chrome-only`/`not-observable`/
`not-applicable` remain, plus: inventory issues, P1 unknown keys, P1 unrendered required fields and
`wire.status === "fail"` also fail the gate. `summary.gate` / `summary.exitCode` record the verdict.

### Documented deviations from a literal reading of PLAN.md §8

1. **`not-observable` does not fail the gate.** A scenario cannot exercise every scheduler type,
 *conf flag or cluster state (e.g. `scheduler=fair`, `conf:yarn.webapp.ui1.tools.enable=false`). Such
 items are reported with their justification and counted, never silently skipped. Pass
 `--strict-not-observable` to fail on them too (useful when adding scenarios, not for CI).
2. **`ui2.yaml` pages are out of P2 scope** (`includePages: ["^legacy\\."]` in `config/routes.yaml`).
 UI2/Ember is a *secondary inventory source* used for P0 completeness; PLAN.md §8 P2 defines the
 baseline as the legacy Hamlet UI. Excluded pages are listed in `summary.json` → `scopeExcluded`.
3. **Static chrome is informational.** Items whose field is `static.*` (page/section titles, column headers,
 legends, nav labels, DataTables chrome) are FORMAT.md's "pure static chrome (no data)"; our chrome is
 deliberately different. A static item our DOM does not tag is reported as `chrome-only` — also when the
 stock page printed matching text (that text stays on the observation). A static item that ours *does* tag
 is compared normally, so a missing *data* field can never hide here.
4. **`parity/waivers.yaml` holds the documented `upstream-not-exposed` waivers** (per-user QueueMetrics,
 per-attempt RMAppAttemptMetrics, per-NM log-aggregation reports): fields the RM computes in-process and
 exposes through neither REST nor JMX. Every entry cites the Hadoop source and the probe that showed the gap.
 A waiver never masks an unmet visibility gate: a `when:` that is unmet is evaluated first and yields
 `not-observable`.

### Join keys, sections and shared blocks (how a legacy record finds its inventory item)

* **Entity key.** Every record is keyed by the entity it describes. A page's own entity comes from
 `pageEntityOf(page.route, params)` (`lib/legacy.mjs`, the only implementation; `run.mjs` and `compare.mjs`
 both call it on the inventory route *template*, never on the already-resolved URL). Table rows are keyed by the
 entity link in the row (`/cluster/app/<id>`…) or by a key column (`ID`, `Node Address`, `Container ID`…);
 capacity-scheduler `'<queue>' Queue Status[ for Partition '<p>']` blocks and queue-tree bars are keyed by the
 queue path (`root.default`) — the same key our DOM uses — and carry their partition (non-default partitions are
 not joined to the single-partition datum; they stay in the records).
* **Sections.** An item prefers records of its own section title (dynamic titles such as `User Metrics for `
 match by prefix). When no record carries that title, candidates whose section is claimed by *another* section
 of the same page are dropped (no more "Apps Submitted" of Cluster Metrics joining the User Metrics item). A
 section-level `when:` gates every item of the section.
* **Shared sidebar policy** (`config/routes.yaml` → `sharedSections`). The stock UI repeats the
 `legacy.rm.shared.metrics.*` blocks on cluster-about, apps, nodes and the scheduler page; our SPA renders each
 datum once. A shared-section item our own route does not render counts as covered when ANY other route crawled
 in the same scenario renders the field with an equal value (own route first; the row reports
 `sharedFromRoute` and says so in its justification). Own-route datums are never second-guessed, and a field
 rendered on no crawled route stays `legacy-only`. A scenario that restricts `pages:` must therefore still
 crawl a route that renders the shared fields it expects.
* **Field aliases** (`fieldAliases`): ids naming the same datum from two REST shapes (single-attempt vs attempts
 list), compared by value.
* **Entity tag warning.** If our attempt page tags `attempt.*` datums with the application id, the datum is
 joined to the page entity so the *value* is still proven, and an `ours-entity-tag` warning is recorded.

### `when:` facts

Besides `scheduler=`, `state=`, `conf:k=v`, `labels`, `ha`, `secure`, `ui:`, the harness evaluates
`fact:<name>`, `fact:!<name>` and `fact:<name>=<value>` against facts derived from the live cluster in
`lib/scenarios.mjs deriveLive` and persisted in the scenario (so replay evaluates the same condition). An
underived fact is *not* a gate: it is reported as an unevaluated condition and both sides are compared anyway.
`conf:` of a key that /conf omits falls back to its compiled-in default (`CONF_JAVA_DEFAULTS` in
`lib/compare.mjs`, currently `yarn.scheduler.capacity.user-metrics.enable=false`).

| fact | derived from | gates |
|---|---|---|
| `userMetricsEnabled` | scheduler=fair, or `yarn.scheduler.capacity.user-metrics.enable=true` | the whole `User Metrics for <user>` block (MetricsOverviewTable.java:157-198, FSQueue.java:95, AbstractCSQueue.java:153) |
| `attemptHasContainers` | containers of the scenario app's attempts (REST) | rows of the attempt page `#containers` table |
| `logAggReportsPresent` | app `logAggregationStatus` not NOT_START/DISABLED | rows of the `logaggregationstatus` table (one per NM report) |
| `gpuResourceTypeConfigured` | `yarn.io/gpu` among the scheduler's configured resource types | Allocated/Reserved GPUs apps-table columns (sentinel -1 otherwise, AppInfo.java:122-131) |
| `labelsWithActiveNMs` | a RUNNING NM carries a non-default label | root bar vs per-partition bars (CapacitySchedulerPage.java:474-517) |

### Decorated-text normalisers

Besides FORMAT.md's vocabulary the harness knows primitives that each invert exactly one documented legacy
decoration: `lead-int` ("0 (Higher Integer value…)", "30 seconds"), `before-colon` (clarified app state),
`after-colon` ("Log Aggregation: X"), `quoted-name` ("'root.default' Queue Status"), `final-status-text`
(UNDEFINED → "Application has not completed yet."), `resource-mb` / `resource-vcores` ("<memory:…, vCores:…>"),
`join-comma`, `disabled-text` ("disabled"/"enabled" ↔ the boolean), `default-partition` ("" ↔
`<DEFAULT_PARTITION>`, RMAppImpl.java:1814-1823), `strip-scheme` (node link = scheme prefix + host:port).
`url` treats a bare scheme (`http://`, an attempt not yet on a node) as "no link".

### Clock-derived values

`app.elapsedTime`, `attempt.derived.elapsedText` and `container.elapsedTime` are `now - start`, so samples taken
seconds apart differ by that gap; they are `sampling-race` only when the later-sampled side is >= the legacy value or at most 10s below it (response-stamping skew); a larger gap stays a mismatch.
`config/tolerances.yaml` carries the one text tolerance: `app.diagnostics` ignores a leading `[timestamp]`
the scheduler regenerates on each attempt (any other difference still fails).

P3 starts each direct/proxy pair concurrently and retries a differing pair once. This matters for the
bulk-activities collector, which records the next scheduling window rather than a fixed document.
Hadoop 3.4.3 also consumes a shared bulk-activities deque per response. When concurrent clients race,
P3 samples sequential windows and requires identical total activity counts and all distinct decision
payloads, excluding only event clocks, ordering, and repetition frequencies. This weaker proof is
reported as a sampling race; missing decision fields or records still fail.
It tolerates at most 2 seconds of drift in activity request timestamps, Spark application duration,
and the Spark driver's wall-clock duration; missing fields, type changes, and other values still fail.
Live `/stacks` has a separately reported, weaker proof: every thread identity and required dump section
must survive, while frames and counters move as the dump requests execute. Its fixed-upstream Rust
integration test still requires byte-identical text. These cases appear as `samplingRaces` in wire.json
and in the HTML report, and must not be described as byte-identical live snapshots.

P3 tests the main Spark application, job, stage, executor, environment, storage, SQL, and streaming
collection endpoints against the resolved live proxy or history server. Optional resources returning
the same unsupported status are recorded explicitly. REST passthrough coverage does not certify UI
field coverage: absent Spark DOM captures and the missing Spark REST inventory remain visible skips.

## Where the truth comes from

* **Legacy side** — `lib/dom-extract.mjs` runs *inside the page* (live and replayed alike) and
  captures the chrome (`#layout`, `#nav`, `#user`), metrics blocks
  (`#metricsoverview`/`#nodemetricsoverview`/`#schedulermetricsoverview`), `table.info` th/td pairs,
  the DataTables **renderered** cells *and* the raw `var appsTableData`/`nodeTableData` arrays
  (page source plus `title=` attributes), `#nodelabels`, `#userinfo`, `#apps`, `#health`, `#lastrun`,
  `#Preemption|#Reservation|#Allocation|#Release` and the scheduler `#cs-wrapper`.
  Note: DataTables 1.11 relocates the `<thead>` row into `<tbody>`; the extractor detects and skips
  those header rows.
* **Our side** — `[...document.querySelectorAll('[data-yf]')]` with `data-ye`/`data-yv`/`data-yn`,
  loaded with `?parity=1` and `window.__YS_PARITY__`. Nothing about our implementation is read.
* **REST side** — the item's own `rest: {resource, path}` (or the registry's `rest: [{resource,
  jsonPath}]`), resolved per entity: arrays are searched for the element whose `id`/`name` matches
  the entity key, so `apps.app[].allocatedMB` is compared for *the row you are looking at*.
  `--keep-captures` writes these bodies under `parity/report/raw/<scenario>/rest/`.
* **Time** — legacy dates are parsed with the offset they carry (`Times.format` renders the RM JVM
  zone), and canonicalised to seconds; both sides are truncated identically so a `8sec` render
  matches an `8264 ms` raw value. See `lib/normalise.mjs`.

## Normalisers

`none · mb · bytes-desc · epoch · duration · percent · na-as-null · resource-string · lowercase · int ·
trim · html-strip · boolean-text · enum-name · url`, combined with `+` (`na-as-null+epoch`) or
`other:<text>`. Both sides go through the *same* canonicaliser; documented lossy truncations:
`epoch`/`duration` to seconds, `percent`/`mb` to 1 dp, `mb` treats a bare number as MB and an
explicit unit as bytes. Every canonicalisation note is shown in the report's *notes* column, and
unknown/opaque normaliser names are surfaced as warnings (never silently ignored).

## Fixtures & replay

```
fixtures/parity/<scenario>/
  scenario.json            resolved params + facts (the exact inputs of the live run)
  upstream/index.json      url -> recorded body (written by the live run)
  upstream/<label>-*.json  raw bodies, one file per request (bodies verbatim)
  legacy/<pageId>.html     page.content() after JS settled  (replayed with JS disabled)
  legacy/<pageId>.meta.json
  ours/<routeKey>.html     post-render SPA DOM             (replayed with JS disabled)
  ours/<routeKey>.json     extracted datums, for P1's rendered-field set
  rest/<url>.json          the reference REST bodies used by the differential
```

Replay re-runs the **same extractor** on the recorded HTML with `javaScriptEnabled: false` and reads
upstream bodies from disk. A `ReplayMiss` (a URL that was never recorded) is a hard error: replay can
never silently skip a fetch. `--assert-no-network` additionally installs a fetch guard that throws on
any attempted network call, so "replay works offline" is proven, not asserted.

Recording captures the *live* run's inputs, so re-record whenever `.cluster/` state changes in a way
that changes a page's rows (the self-test and the report are only meaningful for the same cluster
state).

## Self-test

`selftest.mjs` replays a recorded scenario twice — once pristine, once with one upstream JSON value
replaced by `PARITY-SELFTEST-CORRUPTED` — and asserts that the item consuming that value flips to
`mismatch`, that the mismatch count grows, and that the report names the corrupted value. It exits
non-zero if the harness fails to notice. This is what makes a green `bun run parity` meaningful.

## Inventory contract

Reads (in this order):

1. `parity/inventory/field-ids.yaml` (registry) — else derived from `src/rest-*.yaml` + `src/field-overrides.yaml`.
2. `parity/inventory/legacy-pages.yaml` — else `src/legacy-*.yaml` merged, plus `ui2.yaml`.
3. `parity/waivers.yaml`.

Broken behaviour is loud: a missing file is fatal, an invalid part file is reported as an
`inventory-invalid-file` issue and skipped (fatal with `--strict-inventory`), dangling field
references become `inventory-incomplete` issues, and both are printed on the report's front page and
counted into the exit code. `static.*` fields are auto-declared per FORMAT.md.

`--strict-inventory` is the switch to use in CI once the inventory is complete.

## Adding coverage

* **New legacy page** → nothing to do here; it appears when the inventory declares it. If the route
  alternatives need an override, add `legacyRoutes: {<page id>: "<route>"}` to `config/routes.yaml`.
* **New SPA route** → add a `rules:` entry (`match` regex on the page id → `ours` route template).
  A page with no SPA counterpart must carry `outOfScope: <reason>`; that is what turns its items into
  `not-applicable` rows in the report (counted, visible, never hidden).
* **New scenario** → add it to `scenarios/*.yaml`. `auto` (or `auto:<key>`) params are derived from
  the live cluster; explicit values win. `pages:` limits the crawl; `facts:` overrides the derived
  facts; `legacyQuery:` appends a query string to legacy URLs.
* **New waiver** → `parity/waivers.yaml`, keyed by `fieldId` or `page`+`label` (or `key` for a REST
  key path), always with `category` (FORMAT.md vocabulary) and `reason`.

## Limitations / known gaps

* **Non-HTML daemon pages.** `legacy.rm.tools.conf` (`/conf`), `.jmx` (`/jmx`), `.stacks` (`/stacks`),
  `.metrics` (`/metrics`) are servlet bodies (XML/JSON/text), not Hamlet HTML; the legacy DOM scraper
  records 0 records for them, so their inventory items show up as `absent`/`unmapped`. Closing this
  needs a raw-body capture+parse path for those four pages.
* **Volatile counters** are sampled twice non-simultaneously (DOM snapshot vs REST fetch). Numeric
  live metrics are reported as `sampling-race` (counted, displayed, never hidden); non-numeric fields
  in the same entities stay strict. Reference REST bodies are re-fetched *after* the page captures
  (`--no-refresh-reference` disables) to shrink that skew.
* `--ours-serve`'s static server is a harness convenience (it proxies `/api/yarn|nm|rm/*` straight to
  the live daemons). It is **not** the product and must never be used as evidence for P3 — P3 always
  targets the Rust binary (`--ours`).
* Scenario derivation uses the RM REST API only; `containerId` falls back to a container of a
  finished application when the running app has none (the container page then needs that app id —
  handled automatically for our route).
* Scheduler-page internals (`#cs` treemap canvas, `ul#pq`/`ul#lq` bars) are captured as text/HTML
  blobs; per-field joins depend on the inventory declaring labels for them.
* Spark P3 id-coverage compares *identifiers*; value comparison needs `spark.*` fields in the
  inventory (`parity/inventory/src/rest-spark.yaml`). Without them the Spark part reports `skipped`
  with a reason and still records the Spark REST evidence in `parity/report/raw/spark-rest.json`.
* Waivers for REST keys (`key:`) are an extension of the FORMAT.md waiver vocabulary; documented here
  because `parity/inventory/FORMAT.md` only defines field/page waivers.
