# DAG visual language & engine (`web/src/features/dag`)

Normative for the DAG surface. `DESIGN.md` is the product-wide superset; where the two differ, the divergence is listed
at the bottom of this file. Everything here is implemented in `web/src/features/dag/**` and covered by tests that live
next to it (`bun run test`) plus `web/e2e/dag/dag.spec.ts` (`bun run e2e`).

Input: **JSON only** — `Dag` (`docs/contracts/api.md` §4, verified against `fixtures/spark/{3.5.9,4.2.0}`) and the
REST-native SQL plan (`/sql/{id}?details=true&planDescription=true`). Spark HTML is never parsed here; the DOT→JSON
extraction is the backend's job.

---

## 1. One primitive, three payloads

| payload | shape | what the graph becomes |
|---|---|---|
| job DAG (`kind:"job"`, `granularity:"rdd"`) | stages, each with clusters/nodes/edges + cross-stage `edges` | RDD nodes **inside their stage container**, operation scopes nested inside that, one edge per shuffle |
| job DAG, REST fallback (`granularity:"stage"`, `edgesInferred:true`) | stages with `rddIds`/`status`, no RDD detail; `edges[]` carries `from:null,to:null` + `fromStage`/`toStage` | one card per stage; edges are inferred (hatched pane + legend note) |
| stage DAG (`kind:"stage"`) | one stage with its RDD chain | RDD nodes + nested operation scopes; incoming cross-stage edges appear as ghost stubs |
| SQL plan (`nodes[]`/`edges[]`, metrics per node) | physical operators | operator nodes with their metric list; `wholeStageCodegenId` becomes a compound scope |

Adaptation (`dag-model.ts`, `sql-plan.ts`) is pure and sync. It is defensive by construction: duplicate ids, dangling
edges, missing cluster parents and cycles are reported as `warnings` (surfaced in the UI), not thrown. An endpoint that
is a real RDD id but is **not on this page** becomes a dashed **ghost stub** (`node.kind === "ghost"`) — the dependency
is information; we never silently drop the edge. Null endpoints with a known stage pair bind to the shuffle boundary
(producer's last RDD → consumer's first RDD), which is exactly what Spark's own job DAG draws.

### SQL plan mapping

| SQL plan | graph |
|---|---|
| `nodes[].nodeName` | node label (operator name) |
| `nodes[].wholeStageCodegenId` | `GraphCluster` labelled `WholeStageCodegen (n)` |
| `nodes[]` whose `nodeName` is `WholeStageCodegen (n)` | nothing: that entry *is* the cluster above. It carries no edge and no `wholeStageCodegenId` of its own (its operators do), so drawing it as a node produced an edgeless card floating beside the frame. Its own metric — the codegen's duration — becomes the frame's tooltip |
| `nodes[].metrics[]` | node sub-label (`"<name> <value> (+k)"`) + full table in the drawer |
| `planDescription` / `planLine` | Spark REST appendix entries or the Spark 2.4 UI's `plan-meta-data-<nodeId>` text → the node's `detail`, shown in the drawer as *Plan line* and on hover. If a newer History Server replays an old event log without an appendix, Burrow uses the matching physical-plan tree row. Spark 2.4's own page supplies the operator line; newer REST payloads may include richer output and argument lines. |
| `edges[].fromId → toId` | edge, kind `sql` (Spark's direction is child→parent; arrows point at the plan root) |
| `status`, `duration`, `planDescription` | header/drawer only; they do not affect layout |

---

## 2. Layout

`layout(dag) → positions` is a pure module (`layout/`, `layout.test.ts`): same input ⇒ same output, asserted against a
committed golden snapshot (`__goldens__/positions.json`, sub-pixel tolerance) for both Spark versions.

* **Engine**: ELK layered, direction `RIGHT`, `INCLUDE_CHILDREN` so compound scopes and cross-scope edges route
  correctly, `ORTHOGONAL` routing, `FIXED_SIZE` node constraints (the renderer draws the box it asked for).
* **Off-thread**: the engine runs in a dedicated Web Worker (`layout/worker.ts`); geometry crosses the boundary as
  `Float32Array`/`Uint32Array` buffers that are **transferred**, not cloned.
* **Cache**: keyed by the graph's structural hash (`hashGraph` — ids, kinds, labels, sizes, edges, clusters). Metrics,
  selection and hover are deliberately *not* in the hash, so a progress tick never triggers layout.
* **Determinism**: ELK is deterministic for fixed input + options, and the hash key makes the cache trustworthy.
* **Known ELK trap**: `elk.layered.considerModelOrder.*` / `forceNodeModelOrder` make ELK 0.12 throw
  `Cannot read properties of undefined (reading 'a')` on hierarchical graphs. Measured over all 732 goldens: the
  model-order strategies fail 12–17 graphs, `NONE` fails none. They are therefore absent, and `LAYOUT_LADDER` keeps
  degraded rungs (`polyline`, then `SEPARATE_CHILDREN`) as a last resort; `LayoutResult.rung` reports which rung ran.

### Sizes and thresholds

| node kind | size (world px) | notes |
|---|---|---|
| stage card (job, collapsed) | 208×84 | title, RDD-chain line, badges, progress |
| RDD chip | 168×46 (132×34 when > 120 RDDs) | title, badges, progress |
| stage card (fallback, `granularity:"stage"`) | 216×66 | title, `N RDDs`, status from the payload |
| SQL operator | 140–268 × 46–52 | width follows the operator name + metric count |
| ghost stub | 132×40 | dashed, "outside this page" |
| compound scope padding | top 30 (label), 14 elsewhere | one label row per scope |

Thresholds (`dag-model.ts`, `react/edges.tsx` — see §7 for the degradation policy): `EXPAND_LIMIT = 160` RDDs before a
job DAG auto-collapses to stage cards on wider viewports; expandable job DAGs also start at stage cards on phone-width
viewports, `CANVAS_THRESHOLD = 500` nodes before edges move to canvas, and `HARD_LIMIT = 1500` nodes before nodes lose
their text.

---

## 3. Semantic zoom

Driven by viewport scale (`render/viewport.ts`). Labels are re-planned only when the level or the label-relevant scene
digest changes (`Scene.digest`), never on every progress tick.

| level | scale | what is drawn |
|---|---|---|
| `overview` | < 0.55 | node bodies, tone spine, progress bars. **No text at all** — at this zoom text is noise |
| `normal` | 0.55 – 1.25 | + node titles (ellipsized to the node, collision-resolved), status colour/shape |
| `detail` | ≥ 1.25 | + secondary line (RDD chain / callsite / metric summary), badges with durations and metric counts, edge shuffle labels, "N metrics" |

Job → stage → RDD is a two-canvas drill-down with a shared language: the job canvas shows stage cards (each carrying
its RDD chain as text at `detail`), clicking a stage opens the drawer and the host route can navigate to the stage DAG,
which is the same renderer over the RDD chain. Continuous semantic zoom happens *within* each canvas.

### Initial viewport policy (opening a DAG)

Opening a job DAG should show the full graph when it remains useful at overview scale, then preserve readable stages for
very wide graphs. `initialViewport(content, size, focus)` applies, in order:

1. **Fit the whole graph when useful** — if `fit` scale ≥ `INITIAL_FIT_MIN_SCALE = 0.4`, use it and centre the graph.
   Between 0.4 and `LEGIBLE_MIN_SCALE = 0.55`, semantic zoom shows the graph overview without node text.
2. **Otherwise fit the height**, clamped to `[LEGIBLE_MIN_SCALE = 0.55, INITIAL_MAX_SCALE = 1]`. On a phone-width pane
   (<480 px), a wide graph caps that opening scale at 0.75 so more of the flow is visible while stage cards stay readable.
   A 6 716 × 178 px chain (69 nodes) opens at **1:1** on desktop and **0.75** on a phone, instead of 0.16. A
   tall-and-wide graph still floors at 0.55.
3. **Start horizontally on `focus` for wide graphs** — the first node on open, then, as soon as the stream reports
   something running, one automatic `centerOn` on the **running stage** (once per graph; the user's own pan/zoom wins
   from then on). A graph that fits at the useful overview scale stays centred on the full graph.

The minimap carries the overview, **center on running stage** keeps following the work, and the hint
*"This graph is wider than the pane…"* (shown whenever `isTooWideToFit`) says both of those things. Job DAGs under
`EXPAND_LIMIT = 160` RDDs open **expanded** on wider viewports — stage cards *and* their RDD chains. On phone-width
viewports, expandable job DAGs start as stage-summary cards so the full job shape remains useful without shrinking node
labels to unreadable sizes; **Expand RDD details** switches to the RDD chains. An explicit `expand` URL parameter keeps
its requested mode at either width. Hosts can also request the stage-summary shape with `expandStages={false}`.

This keeps the operational overview in view on a phone while leaving the RDD chain one clear action away. On wider
viewports, the expanded open still gives users the local detail and global shape at once. Zooming changes *detail*
(semantic zoom above); structure changes only through `expandStages` or the Spark job page's expand control.

---

## 4. Node anatomy

```
┌──────────────────────────────┐   ← body: fabric-3 (stage) / fabric-2 (RDD, SQL)
│▌ Stage 7 · · · ↑12.4 MiB     │   ← ▌ tone spine (status colour), title row, badges right-aligned
│  ParallelCollectionRDD → …   │   ← secondary line (detail level only)
│  ████████████░░░░░░          │   ← segmented progress: ok / live / fail / killed / wait
└──────────────────────────────┘
```

* **tone spine** — the status colour survives at any zoom, so status is never lost when text disappears.
* **badge row** — right-aligned on the title row, which is the only row a 46-52 px card has to spare (the SQL operator
  card and the RDD chip: title, secondary line, progress, and nothing else). From `BADGE_ROW_MIN_HEIGHT` (72 px) up,
  where the card has the room — the 84 px stage card — the row moves to a line of its own under the secondary line. The
  title's ellipsis budget is reduced by the badge row's width whenever the two share a row (`titleUsableWidth`), so a
  long operator name can never run underneath it.
* **title** — stage label with `(skipped)` / `(barrier mode)` / `(attempt N)` stripped from Spark's root label into
  badges (`stageFlags`).
* **badges** — `cached` (fresh tone), `barrier` (warn), `unordered`/`indeterminate` (warn), `skipped` (idle),
  `↑ shuffle write` / `↓ shuffle read` (fresh, byte-formatted), stage duration (detail), `<n> RDDs` (fallback cards),
  `<n> metrics` (SQL, detail).
* **skipped** — whole node at 55% opacity with a dashed body; its tone is `idle`.
* **failed** — `fail` tone spine + `cross` shape wording in the drawer; a running stage with failed tasks is `warn`, so
  a retry in flight does not read as a dead stage.
* **cached RDD** — `fresh` stroke instead of the default seam, plus the `cached` badge at `detail`.
* **SQL operator** — label is the operator name, secondary line is the metric summary, badge is the metric count.
* **ghost stub** — dashed body, italic label, "outside this page" secondary line; it participates in layout so the
  edge has a real endpoint.

---

## 5. Live progress language

Status comes from `src/design/status.ts` (`spark.stage`, `spark.task`) — never from a local table. `stageTone`,
`stageStatusKey` and `progressSegments` (`metrics.ts`) are the only mapping, so lists, DAG and timelines agree.

* **Task counts** — the bar is segmented `completed` (ok) → `active` (live) → `failed` (fail) → `killed` (idle) →
  `pending` (wait); widths are task shares, so a 4-task and a 400-task stage are both honest. Counts are also exposed
  as `aria-valuetext` (`"4 completed 50%, 2 active 25%"`) on the bar itself, not only in the drawer.
* **Animated while active** — `data-running="true"` starts a translating highlight (`burrow-dag-shimmer`, opacity-only
  sweep). Under reduced motion the highlight is replaced by a **static diagonal hatch** (`.burrow-dag-node-hatch`), so
  "running" is never motion-only.
* **Skipped** — ghosted (55% + dashed) and always `idle` tone.
* **Failed** — `fail` tone; a stage that fails mid-stream triggers a one-shot tint flash (`--dur-flash`, 900 ms).
* **Cached** — `fresh` stroke; `barrier` and determinism are badges, not colours.
* **Transitions** — `progress-diff.ts` turns (previous, next) into a plan: `unchanged` nodes are not re-rendered at all,
  movement ≥ 3 pp tweens over `--dur-tween` (420 ms), ≥ 25 pp is a "jump" (620 ms), a pure status change tweens 0 ms
  (the colour is a CSS transition), new nodes flash `live`, new failures flash `fail`. The React comparators
  (`sameNodeProps`, `sameEdgeProps`) mean only the nodes/edges whose own inputs changed re-render, so a tick costs a
  couple of milliseconds rather than a full re-render of all 300+ nodes.

### Flowing edges

An edge flows when its **producer is currently producing** — status `ACTIVE` and either active tasks or a completed-task
delta. Intensity `0.25 + rate/8`, clamped to 1, from the completed-task delta per second between metric samples
(`flowReading`). Intensity drives dash density *and* animation speed (`flowDash`): idle edges keep a static dashed
texture, busy edges get short fast dashes. Direction is the edge's own arrow. Reduced motion keeps the dash texture but
freezes the travel (`animationSeconds = 0`), so liveness is still encoded statically.

---

## 6. Interaction and accessibility

| input | behaviour |
|---|---|
| wheel | ordinary wheel/trackpad input scrolls the page; `Ctrl`/`Meta`+wheel zooms about the pointer |
| drag | pan (pointer capture; a <3 px move is treated as a click) |
| double click / `0` | fit to view (or readable-fit for very wide graphs) |
| `+` / `-` | zoom about the pane centre |
| `Shift`+arrows | pan by 40 px |
| arrows / `Home` / `End` | move the roving tab stop through the graph in reading order (x, then y) |
| `Enter` / `Space` | open the detail drawer for the focused node |
| `Escape` | close the drawer |
| minimap click/drag | recentre the viewport |
| toolbar | fit · zoom −/+ · zoom readout · SVG diagram + complete JSON export · **center on running stage** (hops between producing stages) · edges list |

* The canvas is an SVG `role="tree"`; nodes are `role="treeitem"` with `aria-level` from their scope depth and a rich
  `aria-label` (label, stage id, status word, `done of total tasks (n%)`, failures, shuffle bytes, callsite, cached,
  barrier). Exactly one item is tabbable at a time (roving `tabindex`).
* Compound scopes are nested `role="group"` elements mirroring the layout hierarchy (root → stage container →
  operation scope), so a screen reader can walk the structure.
* Edges cannot be tree children, so dependencies are also exposed as a real list of focusable, fully labelled buttons
  behind the toolbar's **Edges (N)** toggle — the SVG's own hit paths are mouse-only and marked `aria-hidden` from the
  tree.
* An `aria-live="polite"` region announces stage completions and failures; a hidden summary line carries node/edge/task
  counts.
* Tooltips are supplementary: every tooltip value is also in the drawer or the aria-label.
* `prefers-contrast: more` and `forced-colors` are respected (the stylesheet switches bodies to `Canvas`/`CanvasText`).

---

## 7. Degradation policy (documented, not accidental)

| nodes | strategy |
|---|---|
| > 160 RDDs in a job | auto-collapse to one card per stage (RDD chains move into the title's secondary line) |
| phone-width viewport and expandable job DAG | start at one card per stage; **Expand RDD details** restores the RDD chains |
| > 500 | edge tracks + flow animation move to a single **canvas** layer (one paint instead of ~3 DOM elements per edge); edge labels off |
| > 1500 | nodes also lose text/badges (bodies, spine, progress only); hover, drawer and the aria tree keep every value |
| any | ghost stubs stay, layout stays off-thread, the aria tree is unaffected by layer choice |
| any size | Node bodies, labels, badges, progress marks and edge groups outside a viewport expanded by 160 CSS px on every side are omitted. All node treeitems, status glyphs, non-ghost progressbar semantics, full node/edge counts, edge list and minimap remain. |

The canvas layer draws the same geometry from the same scene, and resolves `--live`/`--seam-strong` through hidden
probe elements so it stays token-driven (`react/edges.tsx`).

---

## 8. Parity DOM

The DAG is a *presentation* of REST data, so the drawer is the parity surface: every metric row is a `<Datum>` inside an
`<Entity id="<stageId>/<attemptId>">` with `data-yf="spark.stage.<upstreamKey>"` and `data-yv` = the raw payload value,
formatted text via `data-yfmt`. Only keys present in the payload are rendered, so "no key left behind" stays checkable
and nothing is invented. Column-independent ids: `spark.stage.derived.durationText` for the derived duration.

---

## 9. Measured numbers and budgets

* **Corpus**: all 732 goldens (366 × 4.2.0 + 366 × 3.5.9) adapt and lay out with **zero warnings, zero overlapping
  nodes, zero missing boxes** — `src/features/dag/goldens.test.ts`, ~13 s.
* **Layout**: worst single graph 223 ms, whole 4.2.0 corpus 11.6 s of pure ELK; 338-node synthetic graph 436 ms
  (≈270–420 ms warm). Always off-thread; the number is the worker's, not a frame.
* **Frame timing**: see the `frame-timing` annotation on `e2e/dag/dag.spec.ts › 300-node DAG with a live progress
  stream …` — it reports nodes, flowing edges, strategy, layout ms and p50/p95/max frame time. The stream is driven at
  10 Hz (2.5× a realistic poll) so the number is a stress bound, not a best case.
* **Viewport culling**: on the unchanged 338-node, 10 Hz production-build frame gate, three Chromium runs measured p95 **24.0–24.7 ms** and long-frame share **0.41–1.21%**. Existing limits remain p50 < 20 ms, p95 ≤ 34 ms and long-frame share < 10%; no threshold or update-rate reduction.
* **Bundle**: the DAG engine is a lazy chunk — **22.5 KB gz** (67.7 KB raw) for renderer/model/adapters, with ELK in the
  worker chunk (**437 KB gz**, fetched once when a layout is requested) and a main-thread fallback copy fetched only if
  worker messaging fails. No DAG code in the initial bundle. ELK lives in the worker bundle,
  and the main-thread fallback loads it dynamically, so opening a DAG page costs the worker copy only.

---

## 10. Known limitations

1. **A linear pipeline is one long row.** ELK's wrapping strategies do not engage through elkjs 0.12 (verified with
   canonical `org.eclipse.elk.*` option ids and several aspect ratios), so a 28-stage chain is ~67 000 px wide. Mitigated
   by readable-fit, the minimap, "center on running stage", stage-collapse above 160 RDDs and the phone-width
   stage-summary default; the stage drill-down is available on the host route. A snake/multi-row layout would fix it
   properly; it needs either an ELK upgrade or a custom
   layer-packing pass.
2. **No cross-attempt comparison.** Retried stages are separate nodes; the renderer does not diff attempt N against
   N−1 (the fixture set has the vectors for it: `stage-retry/dag-stage-1-0|1-1.json`).
3. **Stage-page DAGs for SKIPPED stages** come from the enclosing job page (Spark emits no graph for them), so a
   stage route for a skipped stage shows the job's picture with that stage ghosted.
4. **Structured streaming** has no DAG; the streaming route shows stats only.

### Reconciliation with `DESIGN.md` §7 (normative)

`DESIGN.md` §7 is the intent; this file documents the implementation. Item by item:

| §7 item | status |
|---|---|
| node kinds and sizes (`NODE_SIZE`, `CLUSTER_PADDING`, compact RDD) | implemented exactly |
| `progressSegments()` stacking order + zero-width segments dropped | implemented exactly |
| `stageTone` / `stageStatusKey` overrides | implemented exactly |
| skipped = ghosted + diagonal hatch, `idle`, `slash` shape | implemented (dashed body + 55% + hatch on running only; the *skipped* node keeps a dashed outline rather than a hatch — the hatch is reserved for "running under reduced motion" so the two cues stay distinguishable) |
| failed = `cross` + a non-colour cue | implemented: **every** node draws a status glyph in its top-left corner (`react/glyph.tsx`, shape read from the shared `statusSpec()` table, tone from `burrow-tone-*`), so status is shape + tone at every zoom, with the tone spine as the low-zoom backstop |
| labels: primary/secondary, ellipsized, full value in drawer/tooltip | implemented |
| badges: cached, barrier, determinism, failed/killed, shuffle | implemented (+ `<n> RDDs` on fallback cards, `<n> metrics` on SQL) |
| clusters: labelled region, nested inset, codegen badge | implemented (label carries the scope name; the codegen id is part of the label `WholeStageCodegen (n)`, and the frame's tooltip carries the boundary's own duration). `sql-wholestage` is never emitted as a node — the boundary *is* the cluster, and Spark's `WholeStageCodegen (n)` entry in `nodes[]` is dropped rather than drawn as a second, edgeless card (`isCodegenBoundary`) |
| §7.3 cluster ids `stage:<id>.<attempt>` / `<stageKey>:<clusterId>` | implemented exactly (plus the nested parent chain) |
| §7.4 edge grammar: solid = materialised, dashed = pending, animated = actively producing | **partial**: all edges draw a solid track and flowing ones add the animated overlay. A `pending` (upstream not complete) state is not yet distinguished — needs `edgeState` in `render/scene.ts`. |
| §7.4 arrowheads + cross-cluster routing | implemented |
| §7.4 edge labels at the midpoint, hidden below **normal** zoom | implemented at **detail** zoom only (deliberately stricter: on a 300-node graph the midpoint labels collide long before the level threshold, and `resolveLabelCollisions` would drop them anyway) |
| §7.4 stroke widths (1 / 1.5 / 2 px) | implemented as 1.25 / 1.5 / 2.5; selection ring is 2 px |
| §7.4 hover dims unrelated nodes/edges | implemented at 0.28 opacity (design proposed 0.4) |
| §7.5 layout off-thread, cached by structural `hashGraph`, canvas > 500, no text > 1500, `EXPAND_LIMIT = 160` | implemented, with the phone-width stage-summary default described in §2 and §3 |
| §7.5 dash flow uses `burrow-stitch` (`stroke-dashoffset`, transform/opacity only) | implemented as the same technique with a **parameterised** keyframe (`burrow-dag-flow`, travel = the dash cycle) so the loop is seamless at any intensity. DESIGN §5.4 now names `burrow-dag-flow`; the fixed −14 px `burrow-stitch` keyframe was deleted (unused) |
| §7.6 levels `overview` / `normal` / `detail` | implemented as **rendering** levels (text off → titles → everything), with `Scene.digest`-keyed label planning. §7.6's *structural* `overview` (stage-summary graph) is implemented as a **data** decision instead: `expandStages: false`, the `EXPAND_LIMIT`, and the phone-width default, because collapsing structure on a zoom gesture would relayout mid-gesture (violating "no layout jumps") |
| §7.6 ±10 % zoom hysteresis | **not yet**: `semanticLevel` is a pure threshold function. Hysteresis is a small change in `DagView`; listed as open |
| §7.7 modified-wheel zoom to cursor, drag pan, `+`/`-`/`0`, minimap, fit on first render / hash change and never on metric change | implemented (plus `Shift`+arrows pan, `Home`/`End`, `Enter`/`Escape`). Ordinary wheel gestures scroll the page, and touch canvases retain vertical page scrolling; `Ctrl`/`Meta`+wheel is the explicit zoom gesture. |
| §7.7 space-drag pan, double-click focuses a subtree | **partial**: double-click = fit to view; no space-drag modifier |
| §7.8 reduced motion = static dash texture, no pulse rings | implemented exactly |
| §7.8 parity mode lays out synchronously | implemented as a deterministic **wait condition**: `data-dag-layout="ready" \| "pending" \| "error"` on the canvas, so a crawl never screenshots an unlaid graph. The worker is still used (same deterministic ELK, off-thread) so parity and normal runs produce identical geometry |

### Deferred (ranked)

1. `edgeState` (pending dashed vs materialised solid) in `render/scene.ts` + CSS — the flow overlay already marks the
   active case, but "waiting for its producer" is not yet visually distinguished.
2. Zoom-level hysteresis (±10 %) in `DagView`; double-click-to-focus-subtree; space-drag pan.
3. A snake/multi-row layout for very wide pipelines (§10.1) — needs an ELK upgrade or a layer-packing pass.
4. Cross-attempt comparison for retried stages.

### Open questions for the integration owner

1. `docs/design-dag.md` vs `DESIGN.md` §7.6: is the *rendering* interpretation of semantic zoom (text density, no
   relayout) acceptable, with structural collapse left to `EXPAND_LIMIT`, `expandStages`, and the phone-width
   initial mode? Collapsing on zoom would relayout during the gesture.
2. `elkjs` is **EPL-2.0 OR GPL-3.0-or-later** (owner guidance: rely on the EPL-2.0 option, keep ELK unmodified and
   confined to `layout/elk.ts`, ship its licence text in NOTICE — never fork it), while the project uses MIT.
   Bundling it is a licensing decision for the owner: keep ELK, or replace `layout/` with an in-house layered layout
   (the module boundary is one function, `runLayout`, so a swap is contained).
