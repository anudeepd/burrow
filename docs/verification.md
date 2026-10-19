# Verification — what has actually been proven

Every number here was produced by running the thing, not by reading the code. Commands are listed so any claim can be
re-produced. Nothing in this file is aspirational: items still open are marked **OPEN** at the end.

Environment: Fedora 44 box (16 cores, ~15 GB RAM), single-host Hadoop 3.4.3 cluster — ResourceManager + 3 NodeManagers
(racks `/rack1`,`/rack1`,`/rack2`; labels `gpu` exclusive, `ssd` non-exclusive) + JobHistory (19888) + Spark History
(18080), Capacity Scheduler with `root.{default, etl.{ingest,transform}, adhoc}`, PySpark 4.2.0. Scenario matrix:
3 RUNNING, 2 ACCEPTED, 31 FINISHED, 2 FINISHED/FAILED, 3 KILLED, plus MAPREDUCE and distributed-shell applications.

## 1. Build and test gates

| Gate | Command | Result |
|---|---|---|
| Rust toolchain | `rustup` stable (`clippy`, `rustfmt`) | rustc 1.99.1, Cargo 1.99.1, Clippy 0.1.99, rustfmt 1.10.0-stable (macOS 27 arm64) |
| Rust tests | `cargo test --workspace` | **189 passed / 0 failed** (19 suites; live-cluster paths gated by `BURROW_LIVE=1`) |
| Rust line coverage | `RUST_TEST_THREADS=1 $HOME/.cargo/bin/cargo llvm-cov --workspace --json --summary-only -- --test-threads=1` | **84.7%** lines (8,380/9,890); `service_discovery.rs` 96.4%, `cli.rs` 84.0%, `main.rs` 60.0% |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| Rust format | `cargo fmt --all -- --check` | clean |
| Burrow CLI smoke | `cargo run -p burrow -- --help` | **passed** — prints `Usage: burrow [OPTIONS] [COMMAND]` and the `BURROW_*` environment options |
| Web unit tests | `cd web && bun run test` (Bun 1.4.3; Vitest with Happy DOM and thread workers) | **719 passed / 0 failed** (63 files; includes the motion-contract/policy tests and status-motion guard, §5) |
| Web typecheck | `cd web && bun run typecheck` | 0 errors |
| Web lint | `cd web && bunx biome check .` | **clean** — 413 files checked; two standalone design exploration files were excluded at the time and have since been removed |
| SPA build | `cd web && bun run build` | **passed** — Vite 8.3.2 transformed 3,181 client and 339 SSR modules; client/server outputs emitted; `/` prerendered. Vite warned about minified chunks larger than 500 kB (worker/ELK). |
| Bundle budget | `bun run scripts/check-bundle-budget.ts` | see parity/report; initial entry chunk is the budget holder |
| Wheel build (historical, before the distribution rename) | `maturin build --release --manifest-path crates/burrow/Cargo.toml` | `burrow-0.1.0-py3-none-manylinux_2_39_x86_64.whl`, 10.1 MB; the current distribution name is `yarn-burrow` |
| Wheel install smoke | clean `uv venv` → `pip install` the wheel → serve | binary on `PATH`; `/api/healthz` 200; `/api/meta` reports all five features true; SPA shell carries the CSP nonce; `/api/yarn/apps` 74 KB of live RM data; container-log listing via the RM's URL-form node hint (`source: nm`, 6 files); **RSS: 17.3 MB idle → 19.3 MB after 400 apps requests → 19.3 MB after conf+jmx+stacks → 19.3 MB after a log tail** |

## 2. Live product verification (real browser, real cluster, shipped binary)

`target/release/burrow --assets-dir …` and the pip-installed binary were both driven by a real Chromium:

| Surface | Evidence |
|---|---|
| Overview `/` | 184–210 `data-yf` datums; live tickers; cluster id rendered raw (`1791015583684`, no group separators) |
| Applications `/apps` | 339 → 963 datums in parity mode; 24 columns; category tabs with live counts; final-status facets |
| App detail `/apps/$appId` | 65 datums; status timeline; preemption/allocation metrics |
| Attempt detail | after the `<Outlet/>` fix: renders the legacy AM/attempt/locality blocks; 47 datums with containers |
| Container table | fixed: RM's root-unwrapped `{"container":[…]}` now parses (was silently empty for *running* apps); live proof `container.containerId/nodeHttpAddress/logUrl/containerExitStatus` |
| Scheduler `/scheduler` | 296 datums; queue-freeness bars with granted-share and maxCapacity markers; treemap; users/apps partitions; activities/health/config tabs |
| Nodes `/nodes`, `/node-labels` | 16 legacy columns; heatmap; node detail; label catalogue |
| Tools `/tools/{conf,jmx,stacks,logs}` | 1,709 config rows; 464 KB JMX tree; 230-thread stack dump; daemon log pager |
| Spark `/apps/$appId/spark/*` | jobs 383 datums, stages 571, executors 69, environment 136; live apps via RM web proxy, finished via History Server |
| DAG frame cost | Real 8-node Spark DAG: p50 16.7 ms / p95 19 ms / max 30.6 ms at the SPA's 1 Hz poll. The 338-node synthetic live-stream gate (10 Hz) remains red: latest Playwright p95 57.4 ms, retry 48.6 ms. A steady direct-browser 1 Hz synthetic run measured p95 48.7 ms vs 17.7 ms with metrics off. The gate is a stress diagnostic, not a product SLA; details in §5.2–§6. |
| DAG | live job DAG from a running app: `data-dag-layout="ready"`, 43 node groups / 112 edges; ELK worker + chunk both 200 under the CSP (`worker-*.js`, `elk-*.js`); keyboard nav verified (`n0 → n1`, Enter opens drawer) |
| Logs `/apps/$appId/logs` | 416 lines of a real 5.2 MB AM stdout from JobHistory; NM-side listing for live containers; SSE follow + `eof`; independent perf run: 1M lines first paint 3.2 s, scroll p50 16.7 ms, full-text search 953 ms |

## 3. Parity proof (PLAN §8)

- Inventory: 74 pages / 179 sections / **1,143 items** / **1,568 field ids** derived from Hadoop's own Java sources;
  validator `parity/inventory/validate.py` → **0 errors**, 23/23 RM webapp classes accounted for. 0 unknown REST keys.
- DAG golden corpus: **732 goldens** (366 × Spark 4.2.0 + 366 × 3.5.9) re-parsed by the Rust extractor and compared
  structure-equal to the reference parser: **0 mismatches**.
- **Differential gate — PASS** (`cd parity/harness && bun run run.mjs --stages p1,p2,p3 --ours http://127.0.0.1:8788`,
  live RM + live binary, scenario matrix over RUNNING/ACCEPTED/FINISHED/FAILED/KILLED states):

| Stage | What it proves | Result |
|---|---|---|
| P1 REST coverage | every key the RM/NM serve is declared in the inventory, and every *required* field is observable | 1023 observed keys / 1330 declared · **unknown 0** · **unrenderedRequired 0** (17 registry-only REST *source* paths listed separately as `sourceOnlyRequired`, never hidden) |
| P2 DOM differential | field-by-field: the stock Hamlet UI vs our SPA, joined on `data-yf`/`data-ye`/`data-yv` | **failures 0** — match 546 · sampling-race 25 (clock-stamped values) · waived 145 · chrome-only 1,819 (stock chrome we deliberately replace) · not-applicable 1,034 (UI2/ATS scope) · not-observable 198 (config-gated) · harness-uncovered 78 (non-HTML endpoints) |
| P3 wire fidelity | the binary's upstream calls are byte-comparable to a direct RM call (requires `x-burrow-api: 1`) | **pass** — 26 endpoints compared, **mismatches 0**, 13 clock-derived values ignored with a stated reason and bound (|Δ| ≤ 5 s) |

Every unmatched item resolves to a fix, a documented waiver (`parity/waivers.yaml`, each carrying a source reference or
a live probe), or a justified `not-observable` — nothing is silent. The three findings that were real *product* gaps are
now rendered: the 5 Scheduler-Metrics values, the queue/user table columns, and the node Allocation-Tags/custom-resource
columns.

## 4. Bugs found by running the artifact (not by unit tests)

1. **Production blank page**: the shell's inline TanStack bootstrap was blocked by our own strict CSP, leaving
   `window.$_TSR` undefined and hydration dead. Fixed with a per-response CSP nonce stamped into every `<script>` plus
   `meta[property="csp-nonce"]`; HTML is now served identity-encoded and compressed on the fly so a cached `.br` can
   never carry a stale nonce. Regression test asserts nonce freshness, consistency across the three placements, and no
   `content-encoding` on HTML.
2. **Identifier formatting**: the cluster id rendered as `1,791,015,583,684`; legacy prints it raw. Added an `id`
   formatter (never group-separated) and applied it to cluster/stage/task/job ids.
3. **Unreachable attempt page**: `/apps/$appId/attempts` was a layout route with children but no `<Outlet/>`, so the
   attempt detail never mounted. Split into a layout + `attempts.index.tsx`.
4. **Silently empty container tables**: the RM answers `{"container":[…]}` (root-unwrapped) for attempt containers;
   the schema union matched it leniently and produced zero containers. Now one tolerant schema handles wrapped,
   unwrapped, `{}` and `null`, verified against the live payload (0 → 2 containers).
5. **`attempt.logsLink` never stamped** although the RM serialises it and the legacy page links it — now a real
   "Aggregated logs" field.
6. **Trailing-slash 404**: `/api/yarn/…/containers/` returned 404 where the RM returns 200. Normalised before matching;
   live proof both forms 200 with identical bodies.
7. **Container logs "not a host:port"** (reported by the owner): `ContainerInfo.nodeHttpAddress` is a full URL
   (`http://127.0.0.4:8042`) while the log route validated `host:port` strictly. Fixed on both sides — the UI
   normalises through `nodeHostPort()` and the backend accepts either form (case-insensitive scheme, still rejecting
   paths). Verified live: listing returns 6 files and `stderr` serves real bytes with `x-burrow-log-*` headers.
8. **Wrong node address preferred**: my first fix preferred `assignedNodeId`, which is the RM's *scheduler* address
   (`:8041`) — the log route's membership check is against the NM **HTTP** addresses (`:8042`), so it answered
   "not a NodeManager of this cluster". Corrected to prefer `nodeHttpAddress`; caught by running the fix, not by tests.
9. **Overview had no scrollbar**: the page rendered its own `<main>` (duplicating the shell's) inside the shell's
   `overflow-hidden` region, so 2,043 px of content was clipped at 832 px. Now a `burrow-scroll` container; verified live
   (`canScroll: true`, scrolled to 400).
10. **Upstream links pointed at the cluster's own hostname**: the RM advertises `http://<cluster-host>:8088/…` in
    `trackingUrl`, unreachable from a browser that reaches burrow over a tunnel. All outbound links now rewrite to
    the operator-configured base (RM / Spark History / JobHistory), NodeManager links are flagged cluster-internal,
    and the raw value stays untouched in `data-yv` (9 unit tests).
11. **DAG chrome unstyled in the preview**: `dag.css` was imported only by the barrel, which the preview route does not
    use — chrome fell into document flow and nodes were unpainted. Fixed at the component; 20 screenshots regenerated.
12. **Harness-side (for the record)**: its P1 "848 unknown keys" was a declared-key expansion bug (now **4** real
    undeclared keys), and its attempt.*/apps false positives were a label collision (`Started:` app-level vs the
    attempts-table column) — both fixed in the harness, not waived.
13. **Last row clipped under the table's horizontal scrollbar** (reported by the owner): the DataTable's height cap sized
    the card to `chrome + HEADER_H + rows`, omitting the header rowgroup's own 1px separator and — where the platform's
    bar consumes layout space (Chromium with custom `::-webkit-scrollbar`, Firefox thin bars) — the horizontal bar's 10px
    lane, so the bar sat on the last row's bottom and a vertical scrollbar appeared for the missing pixels. Forensics on
    the owner's screenshot: 10px lane with the 6px thumb, last row clipped by 11px, vertical thumb 449px (= 464²/475).
    Reproduced at the same viewport (headed Chromium, 1687px, 13 rows x all 24 columns): scroller 474px, `clientHeight`
    464, `scrollHeight` 475, clip 11px, vertical overflow 11. The cap now measures the rendered content box plus the
    lane (`offsetHeight − clientHeight`, 0 for floating bars) each render: scroller 485 / client 475 / scroll 475 / clip
    0 / overflow 0; overlay-bar mode 475/475/475, clip 1px → 0 (the separator is now counted too), uncapped tables
    unchanged (at max scroll the last row sits flush above the lane). Regression test `e2e/apps.spec.ts` "a short list
    caps the card…" (fails before the fix: vertical overflow 1 ≠ 0, last row 1px under the scrollport).
    Cross-browser follow-up: Blink/WebKit now use an 8px custom lane and `--seam-strong` thumb; the standardized color pair
    is also applied globally, and Gecko uses its `thin` width. Vite E2E `e2e/scrollbars.spec.ts` confirms Chromium's
    computed lane and token color; a Vite-served overflow surface rendered in Waterfox with a transparent track and themed
    thumb. Native scrollbar geometry can still vary by OS.
14. **Spark SQL list ordered oldest-first** (reported by the owner): the REST `sql` list is ascending while the legacy UI's
    SQL tab renders newest-first (DataTables `ID ▾`) — jobs and stages arrive descending from REST, so SQL was the only
    list that mismatched. The page now defaults to `id` descending, marked as the table's default (the URL stays clean),
    and the SQL e2e asserts the order plus the toggle. That exposed a second gap: removing the last sort kept the stale
    `sort`/`dir` in the URL and pinned the table to the old order (`serializeSort([])` returned `{}`, which the Spark
    pages merge into the previous search) — it now clears both params, so the third click returns to the default on every
    Spark table. Verified live against the History Server (`application_1791163838825_0006`: legacy 1,0 → ours 1,0;
    toggle → asc → back to the default) and by the jsdom render test `src/features/spark/pages/SqlPage.test.tsx` over the
    `sql-cache-union` capture (7…0, fails on the pre-fix wiring).
15. **The Spark e2e suite could not run at all** (harness-side, found while adding the test above): the dev mock replays the
    Spark fixtures' REST under YARN app ids (`application_1791010000001_000X`) but never served their RM identity — the
    workloads were captured on `local[2]`, so no RM ever had them — and the SPA's `/apps/$appId` layout gates every child
    route on `GET /apps/{id}`. Result: 24 of 25 spark tests answered "Could not load …" (or a blank page) and the suite
    reported 1 passed. `dev/mock-spark.ts` now derives that identity (name/user/attempt times from the captured Spark
    application, state from the scenario phase, the deliberate no-event-log app included), and the spec's 22 theme
    snapshots were regenerated: **30/30 green**, 24 s.
16. **Sorting did not follow the legacy cycle** (found while un-reddening the apps spec): the legacy tables are DataTables
    with `asSorting: ['asc','desc']` — every header reads "activate to sort column ascending", there is no "unsorted"
    step, and the initial order is ID descending (`aaSorting: [[0,'desc']]`). TanStack instead inferred `desc` first for
    *numeric* columns and cycled through removal, so a first click on Allocated Memory sorted descending, the
    default-sorted column (the apps id) had a dead header click, and the spark pages pinned a stale `sort`/`dir` when the
    last sort was removed. The DataTable now sets `sortDescFirst: false` + `enableSortingRemoval: false` (asc → desc →
    asc, Clear lives in the sort panel, which drops the params). Also from the same pass: the topbar's cluster identity
    now sits in the `_` singleton entity the parity contract requires (it was the only `data-yf` outside a `data-ye`),
    and the apps spec's own defects were fixed (two ambiguous locators, the `startedTime`/`starttime` column-id mix-up,
    the two-state `states=` URL no tab can represent, and two races that read `data-burrow-rows` before the list landed).
    The remaining specs had drifted the same way and were reconciled: the shell spec pinned a fixture cluster id
    (`"1,767"`, now read from `/api/yarn/info`), assumed a dark OS theme (now pins the pref), and searched a mock app
    name that no longer exists (now taken from the loaded list, matched by app id since the palette also offers a
    "filter /apps by name" action); the logs spec matched a heading by substring (`getByText` also hit the sr-only
    caption); the overview spec required four scheduler field ids the page had renamed. Stale `overview`/`scheduler`
    theme snapshots (already failing before this round) were regenerated. Full suite, serial, on the built dist:
    **145 passed / 1 failed**, the failure being the documented DAG frame-budget gate.
17. **Spark timeline bars rendered black** (reported by the owner: "black bars … in either dark or light mode"): the Gantt
    bars paint with `fill="var(--tone)"`, but the row's tone class sat on the *label* cell only — inside the chart cell
    `--tone` was undefined, so the SVG paint fell back to its initial value, black, in both themes. The chart cell now
    carries `burrow-tone-<tone>`; measured on the live History Server's `sql_join_agg` timeline: 21 succeeded bars resolve
    to the `ok` dye, active executors to `live`, skipped stages to `idle` (previously all `rgb(0, 0, 0)`), identical in
    both themes. Structural guard: `src/features/spark/ui/Timeline.test.tsx` asserts every `[fill/stroke="var(--tone)"]`
    element has a `burrow-tone-*` ancestor (fails on the pre-fix markup), so the same mistake in another SVG component is
    caught the same way.
18. **The app Overview tab panned sideways on phones** (reported by the owner): `Field`'s InfoBlock row kept a fixed
    8rem label column at every width, so at 390px the value cell was ~160px — and content that cannot shrink (the
    Diagnostics toolbar: count + Copy + Show all ≈ 325px; the `YarnApplicationState:` label + its info icon, 136px)
    pushed the card and then the whole page scroller 95px wide. Measured on the captured app-detail fixture: the page
    container `scrollWidth 441 > clientWidth 346`. The row now stacks below `sm` (label above value) and returns to the
    two-column layout from `sm` (9rem label) / `lg` (minmax(9rem,15rem)) — identical to before at desktop widths; the
    label spans get `min-w-0`, the info icon `shrink-0`, the diagnostics toolbar `flex-wrap`. Re-measured with a fresh
    browser at 390/414/640/768/1024/1440 across the app overview and the Spark pages: `body == viewport` and
    `pageScroll 0` everywhere (was 95px of panning at 390). The same sweep on the live cluster then caught two more of
    the class, both from text that cannot break: the page **subtitle** (a SQL execution's `collect at /home/…/sql_join_agg.py:19`
    is one 732px word) panned the SQL-detail and stage-detail pages by 392px, and the DataTable toolbar's button group
    (`Sort · Columns · Export`, `shrink-0`) panned `/tools/conf` by 8px. `break-words` on the four page-subtitle
    headers (spark/nodes/scheduler/logs) and `flex-wrap` on the toolbar's button group fix both; re-measured live at
    390px across 21 routes: `pageScroll 0` everywhere.
19. **The app-detail tab strip showed a vertical scrollbar, and the page below would not scroll** (reported by the owner,
    with a screenshot of the strip): the active tab's underline sits at `-bottom-px` — 1px below the tabs — and
    `overflow-x-auto` makes the strip a scroll container on *both* axes, so the strip had a one-pixel vertical scroll
    range: a real 10px vertical scrollbar lane on classic-scrollbar platforms (and wheel scrolling over the tabs went to
    the strip). Separately, `OverviewTab` wrapped its content in a second `burrow-scroll … overflow-y-auto` inside the
    route's scroller; `.burrow-scroll` carried `overscroll-behavior: contain`, so that inner, range-less scroller consumed
    the wheel entirely — measured: a wheel over the overview moved no scroll container at all. Fixes: the underline sits
    inside the tab (`bottom-0`, matching the shared `TabsList` indicator); `OverviewTab` no longer nests a scroller (the
    route owns it — the same shape `SqlDetailPage` already documents); `overscroll-behavior: contain` moved from
    `.burrow-scroll` to `.burrow-page-scroll`, so nested scrollers chain to the page as usual while page scrollers still keep
    their own overscroll. Verified live (classic scrollbars): the strip reports `scrollHeight == clientHeight` with no
    scrollbar lane, and a wheel over the overview content scrolls the page (240px). Pinned by
    `e2e/app-detail.spec.ts` "the section tab strip never grows a vertical scroll range, and the page below still
    scrolls".
20. **Queue values truncated and the queue link pointing nowhere** (reported by the owner: "Queue isn't being
    highlighted in /apps … Queue pages need css fixing and optimization for mobile"): three defects. (a) The apps table's
    Queue cell was plain text while the app detail's Queue field is a link — it is now a `text-live` link to
    `/scheduler/$queue` (with `stopPropagation`, or the row's own activation swallowed the click; the same missing
    `stopPropagation` on the Tracking-UI link made the list navigate away while the tracking tab opened — both fixed).
    (b) The app detail's Queue link pointed at `/scheduler?queue=…`, which is not a scheduler search param: it silently
    landed on the freeness index. Both now use the `/scheduler/$queue` path form. (c) On the queue page, `KVRow` keeps
    its label at `shrink-0` and truncated the value, so the freeness grid and the Queue Status block lost data at
    390/768/1024px ("16.0% free" → "16.0…", "1.5 GiB · 1 vCores" → "1.5…"): the grids are single-column until `xl` and
    labels/values wrap instead of truncating. The scheduler search enums also `catch` hand-typed values now
    (`?tab=applications` failed the whole route with a zod error). Verified live: the Queue cell navigates to the queue
    page, and the queue page shows zero truncated values at 390/768/1024/1440px. Full audit of the other pages is
    listed in the same round's report; `/tools/jmx`, `/tools/stacks`, `/tools/logs` and `/` remain to be done.
    (d) Follow-up from the same report: the queue page had **no scroll container at all** — the scheduler layout is a
    bare `<Outlet/>` and `main` is `overflow-hidden`, so a page has to bring its own scroller (the index page does, in
    its tabs panel). At 390×700 the content overflowed `main` by 933px with nothing scrollable; the root now carries
    `burrow-scroll burrow-page-scroll … overflow-y-auto` (964px range, the Queue Status tail reachable). `/tools/logs` shows the
    same *kind* of clip (77px at 390×700, no page scroller) but its layout is a full-height pane by design, so it is not
    the same one-liner.
21. **Every SSE connection answered 400** (reported by the owner: `GET /api/events?topics=…` → 400 in the console):
    two independent defects on the same path.
    (a) **Encoding.** The SPA encoded the *joined* topic list (`encodeURIComponent(topics.join(","))`) while the hub
    percent-decoded the parameter and *then* split on `,` — so the commas inside `yarn/apps?…&states=NEW,NEW_SAVING,…`
    were indistinguishable from the separators and `NEW_SAVING` was rejected as an unknown topic. Now each topic is
    encoded on its own and joined with literal commas, and the hub splits the **raw** value before decoding each part
    (`routes/table::query_params_raw` + `percent_decode`), so a comma inside a topic stays inside it. The mock hub had
    the same decode-first bug and is fixed the same way.
    (b) **A stale topic-class list.** The hub validated topics against a hand-copied prefix list that no longer matched
    the SPA: `yarn/info` (the overview page's own topic), `yarn/get-node-labels`, `yarn/get-node-to-labels`,
    `yarn/label-mappings`, `yarn/resource-profiles`, `yarn/resource-types`, `yarn/containers/<id>`, `yarn/scheduler-conf`,
    `yarn/appstatistics`, `rm/logs`, `nm/<host:port>/*` were all rejected — a 400 killed the *whole* connection, so the
    live-update feature was effectively dead. The interval now falls back to the route table the hub polls through
    (`routes::topic_interval`: the route's cache TTL, `AppState.live`, the synthesized `/source` and `/dag/…` policies),
    with the registry kept as an *override* list; an unresolvable path is still a 400. A test walks the full set of
    topics `topicOf` produces (`routes::tests::topic_interval_covers_every_spa_topic`), which is the guard that was
    missing. Verified against the live cluster on 8787: the exact SPA topic list answers `hello` with the topics intact
    (states list included), invalidates for `yarn/apps…`/`yarn/nodes`/`yarn/scheduler` arrive within seconds, a browser
    pass over `/`, `/apps`, `/nodes`, `/scheduler/<queue>` records **zero console errors** and 200s only, and `yarn/nodes`
    refetches twice without user action (the relaxed 30 s fallback cannot explain that).
22. **The rail's collapse button crowding the logo** (reported by the owner: "the sidebar collapse button on mobile and
    desktop hanging over the logo"): the brand row is one flex line — logo, wordmark, toggle — and it was the same row at
    both widths. Expanded (224px) it reads fine, but collapsed (56px) the row is `justify-center px-0` with two
    `shrink-0` 24px items and an 8px gap: the logo sat flush at x=0 (off the nav icons' centred column) and the toggle
    at x=32..56, hard against the rail's edge — the button reads as sitting on the logo. The mobile drawer made it
    worse: `Rail` was rendered without its `collapsed` prop, so a drawer that should be *closed* instead inherited the
    `railCollapsed` pref (a phone showed a 56px icon-only drawer, no labels) and rendered a toggle that flipped the
    *desktop* rail's pref. Now: the collapsed rail's brand row is the logo alone, centred on the icon column; a drawer
    always renders the expanded rail and no toggle at all (the dead `collapsed` prop became `inDrawer`).
    (b) The control's placement was checked across widths. The first fix put the toggle in the brand row when expanded
    and the footer when collapsed — two zones. The toggle now has **one** zone: the footer's status row, `ml-auto`, so it
    sits at the rail's trailing corner at the same 8px inset at both widths (measured: 9px inset at 224px and at 56px,
    brand row 0 buttons in both states, logo centred 16..40 in the collapsed rail). Verified in the browser at 1440px
    and 390px (drawer 224px with readable labels, zero buttons in the rail), with geometry tests in
    `e2e/shell.spec.ts` asserting the identical trailing inset in both states.

23. **Uncaught React error #418 on every load for anyone with a persisted preference** (reported by the owner from the
    browser console: `Minified React error #418 … args[]=HTML`). The shell is server-rendered (prerendered HTML is served
    for every route) *before* `localStorage` is readable, so the server renders the rail expanded; the client's first
    render read `railCollapsed: true` and rendered it collapsed — different markup, so React gave up on hydration, threw
    the whole tree away and rebuilt it client-side on every navigation. Reproduced deterministically by seeding one key
    (`localStorage["burrow.prefs.v1"] = {"railCollapsed":true}` → `#418`; no other pref did it). Two mechanisms now keep the
    shell's first client render identical to the server's:
    **(a) CSS for anything that must look right before the bundle loads** — `theme-init.js` mirrors the pref onto
    `<html data-rail-collapsed="true">` pre-paint, `applyPrefsToDom()` keeps it in sync, and the rail derives *every*
    collapsible piece from those hooks instead of unmounting them (labels, wordmark, badges, section label, footer text);
    **(b) `useMounted()` for JS values the server cannot know** — the topbar's "paused"/relative-time readout and the
    interval select's label render `PREF_DEFAULTS.liveIntervalMs` / `"…"` on the first pass and their real value in a
    layout effect, so the swap lands in the same painted frame. `web/src/features/shell/rail.test.tsx` pins the rail
    invariant (identical element structure collapsed vs expanded) and DESIGN §5.5 rule 11 states the rule. Verified: the
    pref sweep below reports no errors and the collapsed rail still renders collapsed (224 → 56 px, rail content
    `display: none`, the collapse control still inside the rail at its 9 px inset).
    Two traps found while fixing it, both now covered by the same rule: React keeps the server's **attributes and class
    lists** while hydrating and only patches a value that *changes* on a later render — so a pref read straight from the
    store stays wrong forever (the rail toggle kept the expanded icon/label; the paused control showed both glyphs at
    once; `data-live`/`data-paused`/`data-pressed` kept the server's values). Every pref-derived render therefore goes
    through one `mounted`-gated value per component (`pausedNow`, `mounted && collapsedPref`, `mounted ? pref : PREF_DEFAULTS.*`).
    Verified after the fix with `{railCollapsed, livePaused, liveIntervalMs: 30000}`: rail 56 px / `data-collapsed="true"`
    / toggle `Expand navigation` + `panel-left-open`, `data-live="paused"`, `data-paused="true"`, the pause glyph at
    `opacity-0`, readout "paused", interval "30 s", **0 console errors**.
24. **Playwright checks had drifted from the current Burrow UI**: stale log-source/button labels, fixed GPU-memory
    expectations, keyboard-only palette opening, old rail geometry/timing assumptions, and an immediate minimap-position
    read made assertions brittle or incorrect. The e2e checks now use current UI labels, compare GPU memory against the
    API response, open the palette through its visible trigger, measure the intended rail states, and wait for minimap
    movement. `/tools/conf` also exposed a real desktop layout defect: the property grid collapsed and hid its first
    row. `ConfView` now gives the grid a desktop minimum height; dark/light browser checks require the first property
    row in view. The configuration screenshots were regenerated after verifying the visible row.
25. **macOS loopback fan-out reset the cache test's connections**: the 200-request cache-coalescing test failed
    reproducibly on macOS 27 with TCP connection resets; `kern.ipc.somaxconn` is 128. The test now yields after each
    16-task launch batch to let the accept loop drain without serializing the requests. The focused run recorded
    `miss=1, coalesced=199, hit=0`; the full workspace run passes.

## 5. Motion pass (2026-10-05)

The motion system is normative in `DESIGN.md §5` (tokens, the four semantics, tiered gating, the keyframe table, the
entrance primitives). This section records what was *run* to prove the implementation, plus the honest limits.

| Gate | Command | Result |
|---|---|---|
| Motion contract (source) | `cd web && bunx vitest run src/styles/__tests__/motion-contract.test.ts` | **15 passed** — no `transition: all`, no `ease-in`, no `scale(0)`; every `infinite` animation sits under the `motion` **and** `parity` predicates; every loop has a `prefers-reduced-motion` escape; keyframes only touch `transform`/`opacity`/`stroke-dashoffset`; every Tailwind `transition-*`/`animate-*` utility carries a `duration-(--dur-*)` token or an inline override; `--dur-fade` survives reduced motion but parity zeroes it |
| JS policy | `cd web && bunx vitest run src/lib/__tests__/motion.test.ts` | **8 passed** — `motionAllowed()` is false under parity, OS reduce and the in-app toggle; `flash()` reads `--dur-flash` from the computed style and is a no-op when motion is off or WAAPI is missing |
| Web unit tests | `cd web && bunx vitest run` | **646 passed / 0 failed** (46 files) |
| Web typecheck | `cd web && bun run typecheck` | 0 errors |
| Web lint | `cd web && bunx biome check .` | clean (exit 0; the 4 remaining warnings are pre-existing `noExplicitAny` in `api/refetch.ts`) |
| SPA build | `cd web && bun run build` | built + prerendered (`dist/client`, `dist/server`) |
| e2e (full, serially) | `cd web && bunx playwright test --workers=1` | **148 passed / 1 failed** — the failure is the *pre-existing* DAG frame-budget gate (§6 below); every screenshot baseline (spark, overview, scheduler, DAG, apps, logs, tools) matched |
| Reduced-motion sweep (real Chromium) | `e2e/dag/dag.spec.ts` → "honours reduced motion" | `0` elements animating among the DAG's loops `animation-name`/duration, and the static hatch stays attached |
| App row feedback | `e2e/apps.spec.ts` → "submitted app updates do not pulse the whole row" | A live progress update changes the cell without an active row-overlay animation; the RUNNING badge keeps `burrow-dot-pulse` |
| Shell motion (real Chromium) | `e2e/shell.spec.ts` | rail collapse keeps one inset at both widths, the mobile drawer renders inside a real dialog, ⌘K/`/`/`?` still focus and dismiss correctly, theme/time-zone persist |
| Fixed medium density (real Chromium/Vite) | `e2e/shell.spec.ts` → "saved density options are ignored and the layout stays medium" | **1 passed** — seeded legacy `density: "compact"` is ignored; no density selector, palette action or `data-density`; sizing stays 34/10/30 px; the legacy key is removed on write and UTC survives reload |
| Topbar refresh/update spacing (Vite Chromium) | `e2e/shell.spec.ts` → "keeps the refresh interval and update label visually close" | **1 passed** — the visible 3 s chevron-to-status gap measures 18.3 px, down from 62.5 px before; status text is left aligned |
| Local/UTC timestamp switching (Vite) | `PW_BASE_URL=http://127.0.0.1:5174 bun run e2e -- --grep timezone --workers=1` | **7 passed** — Overview, app detail, node, scheduler, logs, JMX and Stacks; local assertions use `America/Los_Angeles`, then switch to UTC. `TZ=America/Los_Angeles bun run test -- src/features/tools/jmx.test.ts`: **28 passed**, including timezone-specific epoch-hint rendering. |
| Scheduler queue tabs (Vite Chromium) | `PW_BASE_URL=http://127.0.0.1:5174 bun run e2e -- e2e/scheduler.spec.ts --grep "queue detail tabs" --workers=1` | **1 passed** — real clicks switch through Users, Applications, Partitions, Activities and Configuration, and each shows its matching table. Reproduced the failure before the fix: the tab list collapsed to 1 px and intercepted pointer clicks; after the fix it measures 37 px and the queue page scrolls to expose the tabs. Confirmed on `http://127.0.0.1:5173/scheduler/root.default`. |
| Reduced-motion press regression (real Chromium) | `e2e/shell.spec.ts` → "removes press scaling for both reduced-motion settings" | **1 passed** — OS and in-app reduced-motion settings both suppress press scaling |
| Status motion (unit) | `cd web && bunx vitest run src/ui/status.test.tsx` | **7 passed** — `app.state RUNNING` pills carry the pulse ring on the gated icon wrapper, `spark.job RUNNING` / `spark.stage ACTIVE` carry the flow ring, `node.state DECOMMISSIONING` carries `burrow-drain`, each with `data-visible`; the pill still stamps `data-yf`/`data-yv` when it is the datum |

### 5.1 Browser walkthrough on the built artifact (headless Chromium, mock API)

| Check | What was observed |
|---|---|
| Route content fade | `main > div` is `burrow-page` with `transition: opacity 0.12s cubic-bezier(0.23, 1, 0.32, 1)` and `opacity: 1` once settled; the element is re-keyed on the pathname, so a navigation mounts a new one and a re-render of the same page cannot restart it |
| Row feedback | `.burrow-row` carries `transition: background-color 0.12s cubic-bezier(0.23, 1, 0.32, 1)`, and the shipped stylesheet contains `@media (hover: hover) and (pointer: fine) { .burrow-row:hover { background: var(--fabric-2) } }`. **Limit:** the headless harness reports `hover: none, pointer: coarse`, so the hover *colour* was verified structurally (rule present + contract test) rather than with a pointer |
| Row / line change flash | Generic `DataTable` consumers and streamed logs share `flash()`; the `/apps` list omits `rowVersion`, keeping polling feedback off the whole row; the log rows still carry their attached overlay layers |
| Theme switch | clicking *light* produced `data-theme="light"` **and** `data-switching` in the same task, with the probe element's `transition-duration` reading `0s`; 300 ms later the attribute was gone and transitions were back at `0.12s` — the flip snaps instead of smearing |
| Command palette | its `[role=dialog]` carries `burrow-instant`, computed `transition-duration` is `0s`, focus lands on the combobox, Escape unmounts it (keyboard-first ⇒ no entrance, by decision) |
| Mobile drawer | at 390 px: `[role=dialog]` named **Navigation** (sr-only title), class `burrow-sheet`, `data-side="left"`, `transition: transform 0.34s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.12s`; both opening and closing ran a real slide (sampled mid-flight at `translateX(-224px)` → `-124px`) before unmounting |
| Status rings | the RUNNING app pill's icon wrapper is `burrow-dot-pulse` with `data-visible="true"` and `::after` = `burrow-pulse-ring 1.8s infinite`; a synthetic probe of the shipped CSS gives `.burrow-dot-flow[data-visible="true"]::after` = `burrow-flow-ring 1.1s linear infinite` (dashed 1 px, `--dur-stitch`) while `[data-visible="false"]` yields `animation: none, opacity: 0`; the app-detail timeline's live step dot pulsed once scrolled into view and stayed `none` offscreen (it never pulsed before this pass — the class had no `data-visible`) |
| Share bars (Vite E2E) | A Nodes top-consumer fill keeps `transform: scaleX(var(--fill))` and computes `transition-duration: 0.18s`, matching the shared progress cadence |
| Progress readouts and segments (Vite E2E) | Applications and Overview percentage readouts occupy the same 48 px tabular column with one decimal; Overview's active track fills available width; Spark stage segments transition their widths in 0.18 s |
| Visualization transitions (Vite E2E) | Five targeted Playwright checks passed against Vite: node table ↔ rack heatmap, label catalogue ↔ mapping, Scheduler treemap basis, Overview history-range charts, and the six-section Overview entry cascade |
| Reduced motion | `html[data-motion="reduced"]` → `--dur-base: 0s`, `--dur-fade: .12s`, skeleton shimmer `animation-name: none`, row transition `0s`, page fade **kept** at `0.12s opacity` (tiering) |
| Parity | `?parity=1` → `data-parity="1"`, `--dur-fade: 0s`, every sampled element `animation-name: none` + `transition: none`, page opacity `1` (a screenshot cannot catch a half-run animation) |
| DAG | running shimmer / edge flow / flash key off `[data-visible]` on the pane (`useInView`), the canvas edge loop is stopped offscreen, the per-tick progress duration comes from the diff plan (420 ms / 620 ms), and the change cue survives reduced motion/parity as a static 0.22 tint |
| Log new-line cue | **limit:** the mock replays a fixed captured tail, so nothing is appended after first paint and the cue never fired in the browser (an instrumented `Element.animate` counter stayed `0` after `?tail=`). Its layer is present on every row and `flash()` is unit-tested; the streaming path itself is covered by `e2e/logs.spec.ts` (follow → eof, polling fallback) |

### 5.2 DAG update smoothness (stress diagnostic, not a product SLA)

The 300-node test measures `requestAnimationFrame` intervals on a 338-node synthetic graph at 10 Hz. Its p95 ≤ 34 ms and `longFrameShare < 0.1` thresholds are regression heuristics for headless Chromium, not a user-facing SLA. They allow one missed refresh at the p95 boundary; they do not promise 60 fps.

The progress effect previously set a new `tweenMs` state after the metrics render, causing a second DAG reconciliation when the duration map changed. `scene` also omitted `tweenMs` from its memo dependencies, so catch-up durations were not applied to the rendered progress bars. The diff and tween map now derive in the metrics render and feed `scene` directly. A regression test verifies a large progress catch-up gets its intended 620 ms transition.

| Measurement | Viewport / cadence | Frames | p50 | p95 | Other |
|---|---|---:|---:|---:|---|
| Current full-suite Playwright stress gate | 1280×720 / synthetic 10 Hz | 241 | 16.7 ms | **16.7 ms** | max 16.8 ms; `longFrameShare` 0; `overBudgetShare` 0.3071 |
| Earlier Playwright stress attempt | 1280×720 / synthetic 10 Hz | — | — | **57.4 ms** | Retry p95 **48.6 ms**; failed at 34 ms cutoff |
| Browser UI, synthetic live metrics after reset | 1440×900 / 1 Hz | 512 | 16.7 ms | **48.7 ms** | 41.8% over 16.7 ms |
| Same graph, metrics off after reset | 1440×900 / static | 553 | 16.7 ms | 17.7 ms | 29.3% over 16.7 ms |

The current full-suite stress gate passed; the earlier red sample shows run-to-run variability. The direct-browser A/B
still records a synthetic live-update cost. The UI readout's “over 16.7 ms” share is not `longFrameShare` (>33.4 ms);
thresholds were not changed. These measurements are a stress diagnostic, not evidence that ordinary 8-node Spark traffic
is janky.

## 6. Current verification and open items

Full Playwright suite: `CFFIXED_USER_HOME=/tmp/burrow-playwright-firefox-home PW_PORT=5274 bun run e2e` —
**281 passed (2.4 min), 2 workers**, including Chromium and Firefox. On macOS 27, Firefox 155 otherwise fails before
test startup with “Could not find profile folder”; pointing `CFFIXED_USER_HOME` at a fresh temporary directory works
around the browser-launch failure. The DAG frame gate passed in this run (241 frames, p95 16.8 ms; §5.2).

- **Kerberos/SPNEGO** is not implemented (`features.kerberos: false`).
- **Non-HTML legacy pages** (`/conf`, `/jmx`, `/stacks`, `/metrics`) are `harness-uncovered`: the scraper reads DOM
  tables, those endpoints return XML/JSON/text bodies. Harness gap, not a product gap — our SPA renders all four pages.
- **Write actions** are deliberately out of scope (read-only product); **Timeline/ATS v2** and **Federation** likewise
  (inventory pages catalogued and marked `not-applicable`, never dropped silently).
- Two runtime facts are consumed as documented waivers rather than fabricated: per-user QueueMetrics (`usermetrics.*`)
  and two scheduler-health items (`aggregateFulfilledReservations`, `lastOperationTimestamp`) — this RM exposes neither
  in REST nor JMX (probe recorded in `parity/waivers.yaml`).

- **Rust live-cluster coverage is verified:** tested in an Ubuntu 24.04 ARM64 Lima guest against Hadoop 3.4.3. `cluster/selftest.py --json` passed 11/11 checks; scenario seeding produced 13 scenarios.
  Environment: macOS 27 ARM64 host; Lima VM `burrow` running Ubuntu 24.04 ARM64. The repository was mounted at its host path, and Hadoop, Spark, Python, and Cargo commands were run inside the VM through `limactl shell burrow`—not on the macOS host.
  Approach: run the real `cluster/` YARN topology (ResourceManager, three NodeManagers, JobHistory Server, and Spark History Server) inside the Ubuntu Lima guest. For each Spark version, submit the `sql_join_agg` workload with that version's Spark client, then run `BURROW_LIVE=1 cargo test -p burrow --test spark_live -- --nocapture` while the YARN app is running; this exercises SQL execution listing/details and the Spark SQL/RDD DAG routes. After the version matrix, seed `.cluster/scenarios.json` with `.venv/bin/python cluster/cluster.py scenario seed`, run the full live-target command below against Spark 4.2, and stop the cluster with `.venv/bin/python cluster/cluster.py down`.
  Full live-suite command: `BURROW_LIVE=1 RUST_TEST_THREADS=1 cargo test -p burrow --test live_cluster --test logs_live --test events_live --test spark_live -- --nocapture --test-threads=1`
  It passed **6 tests across 4 targets**. Coverage exercised direct RM/NM response parity, events/cache behavior, local and aggregated log reads (including a 5 MiB log), Spark live proxy/DAG routes, and the live cluster metadata.
- `spark_live` also passed separately on all three requested Spark versions; each run returned the SQL execution list and its plan details:

  | Spark | Python / Java | SQL plan |
  |---|---|---|
  | 2.4.8 | 3.7.12 / JDK 8 | 27 nodes, 18 edges |
  | 3.3.2 | 3.8.20 / JDK 17 | 33 nodes, 24 edges |
  | 4.2.0 | 3.12 / JDK 17 | 33 nodes, 24 edges |

  Spark 2.4 required Python 3.7.12 because its bundled cloudpickle is incompatible with Python 3.8. The cluster was stopped after the live tests. NodeManager local directories used guest-native storage via `.cluster` symlinks; Spark could not create temporary directories on the Lima shared mount.
- **Rename audit:** the initial case-insensitive scan found 35,781 occurrences across 3,506 text files; a final raw-byte scan of
  19,426 current non-ignored worktree files found zero matches and no matching project paths.
  Captured Spark/parity/log fixtures were normalized, not preserved byte-for-byte; log file-size metadata and byte-range
  assertions were recalculated after the rename. Cargo/Python metadata and local Git `origin` point to
  `https://github.com/anudeepd/burrow`; GitHub API access returned 404, so the remote's availability is unverified.
  Git history itself was not rewritten.

### Single-instance 1,000-session load test

Run on 2026-10-19 in the Ubuntu 24.04 ARM64 Lima `burrow` guest (6 vCPU, 10 GiB), with Bun 1.4.3. The release Burrow process, Bun load generator, and Hadoop 3.4.3 / Spark 4.2.0 cluster shared the VM. The driver connected directly to `127.0.0.1:8787`; no host-to-guest SSH tunnel was in the request path. The ResourceManager, three NodeManagers, JobHistory Server, and Spark History Server were healthy. `.cluster/scenarios.json` contained one finished Spark application.

The Bun-only driver in `web/scripts/load-test.ts` exercised 1,000 virtual sessions: 700 Overview, 200 Applications, and 100 Spark detail; 30-second ramp, then 120 seconds at full load. Each session opened one SSE stream, followed invalidations, and used the app's refresh/safety-poll cadence. `load:test` sets `BUN_CONFIG_MAX_HTTP_REQUESTS=65535` (Bun's default is 256); `ulimit -n 16384` was set for both processes.

From the Lima guest, start the single Burrow process:

```bash
ulimit -n 16384
exec /usr/bin/time -v -o /tmp/burrow-load-1000-server.time \
  "$HOME/.cache/burrow-cargo-target/release/burrow" \
  --bind 127.0.0.1 --port 8787 --no-open \
  --allowed-host 127.0.0.1:8787 \
  --rm http://127.0.0.1:8088 \
  --spark-history http://127.0.0.1:18080 \
  --jhs http://127.0.0.1:19888
```

From `web/` in another Lima shell:

```bash
ulimit -n 16384
export PATH="$HOME/.bun/bin:$PATH"
exec /usr/bin/time -v -o /tmp/burrow-load-1000-generator.time \
  bun run load:test -- --target http://127.0.0.1:8787 \
  --users 1000 --ramp-seconds 30 --duration-seconds 120 \
  --scenario-file ../.cluster/scenarios.json \
  --output ../.cluster/load-test-1000.json
```

The run completed in 150.02 seconds with **117,474 HTTP requests and zero failures**. All 1,000 SSE streams opened and received hello frames; all 1,000 sessions were healthy at the end, with zero failed connections or unexpected disconnects. Peak active SSE streams: 1,000; peak in-flight HTTP requests: 2,100. The report is `.cluster/load-test-1000.json` (local generated artifact).

| Path | Requests | p95 | p99 | Failures |
|---|---:|---:|---:|---:|
| `/` | 1,000 | 1.87 ms | 15.78 ms | 0 |
| `/api/yarn/metrics` | 12,206 | 29.96 ms | 53.17 ms | 0 |
| `/api/yarn/nodes` | 34,701 | 48.83 ms | 61.09 ms | 0 |
| `/api/yarn/scheduler` | 34,687 | 50.32 ms | 1,016.31 ms | 0 |

`/api/yarn/scheduler` reached 1,262.67 ms maximum latency, so its long tail remains a limit to investigate before setting a p99 service objective. The load report counted 412 API-visible upstream miss/bypass responses from `x-burrow-upstream`; this is not a complete count of internal SSE Hub polling.

GNU `time -v` recorded Burrow at 17.08 CPU-seconds over 3:05.87, 9% of one CPU, with 124.5 MiB maximum RSS. The Bun generator used 17.18 CPU-seconds over 2:30.08, 11% of one CPU, with 137.2 MiB maximum RSS. Neither process swapped.

Immediately after the run, `.venv/bin/python cluster/cluster.py status` reported a healthy cluster and 8,014 MiB guest memory available. `.venv/bin/python cluster/cluster.py down` then reported no remaining cluster processes.

**Decision:** this run supports one Burrow process for this 1,000-session profile; it does not justify dedicated worker nodes. `Core` owns the cache and event `Hub`, and the `Hub` is one per `Core`; adding independent replicas therefore adds independent caches and pollers. Consider replicas for availability or when production measurements show a resource limit, and measure the resulting upstream load.

This is a Bun HTTP/SSE session simulation, not 1,000 browser engines: it requests the shell and API routes but does not fetch JavaScript/CSS bundles or render pages. The 100 Spark-detail sessions shared one finished app, and the load generator was co-located with Burrow and Hadoop in the Lima VM. Treat the result as evidence for this traffic mix, not as a production SLA or a browser/static-asset capacity test.

