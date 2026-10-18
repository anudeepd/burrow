# Contract: parity DOM convention (`data-ye` / `data-yf` / `data-yv`)

The parity harness verifies **what the user can see** by reading the DOM, never our source. Every YARN/Spark datum the UI presents
MUST be rendered through the shared `Datum` primitive (or carry the same attributes). Changing this = tell the integration owner.

## Field-id grammar

`<entity>.<path>`

* `entity` ∈ `cluster.info` · `cluster.metrics` · `scheduler` · `queue` · `app` · `attempt` · `container` · `node` · `nodelabel` ·
  `appstat` · `conf` · `spark.app` · `spark.job` · `spark.stage` · `spark.task` · `spark.executor` · `spark.rdd` · `spark.sql` · `spark.env` · `log`.
  (The inventory in `parity/inventory/` is the authority; new entities are added there first.)
* `path` = the upstream JSON key path **relative to the entity object**, dot-separated, array indices dropped.
  `app.allocatedMB` · `app.queueUsagePercentage` · `queue.resourcesUsed.memory` · `node.resourceUtilization.nodePhysicalMemoryMB` ·
  `spark.stage.taskMetricsDistributions.duration`.
* Values the legacy UI **derives** (not a REST key — e.g. "Elapsed" string, "Log Aggregation Status" label) get an explicit id with
  prefix `derived.` in the inventory: `app.derived.elapsedText`. Each derived id lists how it is computed.

## Attributes

| attribute | on | meaning |
|---|---|---|
| `data-ye="<key>"` | nearest element wrapping all fields of one entity instance (table row, card, section) | stable entity key: app id · attempt id · container id · node id · queue path (`root.a.b`) · job id · `stageId/attemptId` · executor id · `_` for singletons (`cluster.info`, `cluster.metrics`) |
| `data-yf="<field id>"` | the element presenting the value | which field this is |
| `data-yv="<raw>"` | same element | the **raw upstream value**, stringified exactly as JSON would (`String(n)`, `true`, epoch-ms ints); never formatted, never tweened; `null`/absent ⇒ attribute empty **and** `data-yn="1"` |
| `data-yfmt="<tag>"` (optional) | same element | format applied to the visible text: `bytes` · `mb` · `ms` · `dur` · `epoch` · `pct` · `int` · `id` · `text` — lets the harness pick a normaliser. `int` = group-separated quantity (matches Spark's `Utils.formatNumber`/legacy thousands separators); `id` = identifier, never group-separated (cluster id, stage/task/job ids, attempt ids) |

Rules
1. A field may be rendered many times (list + detail + drawer); **every** occurrence must agree with the upstream value.
2. Non-textual presentations (progress bar, gauge, badge colour) still carry `data-yf`/`data-yv` on the element that encodes the value.
3. Number tickers / tweens may animate the visible text, but `data-yv` is always the true final value.
4. Nested ids inside a row must be inside the row's `data-ye` element (so `(entity key, field id) → raw` is unambiguous).

## Parity mode

Any route accepts `?parity=1` (also `window.__BURROW_PARITY__ = true`, set by the harness before load). In parity mode the UI:
* shows **all** columns/sections (no hidden-by-default fields), expands every collapsed panel that holds data;
* disables virtualization windows (renders all rows), pagination, animations/transitions, and auto-refresh (data frozen after first load);
* keeps layout identical otherwise (so screenshots remain meaningful).

## Harness reads

`[...document.querySelectorAll('[data-yf]')]` → `{ entity: closest('[data-ye]').dataset.ye, field: dataset.yf, raw: dataset.yv, fmt: dataset.yfmt, text: textContent }`.
Coverage = set of distinct field ids seen across a full crawl (every route × every scenario). See `docs/parity.md`.
