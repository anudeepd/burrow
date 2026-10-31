# Burrow features

Burrow brings YARN cluster operations and Spark-on-YARN tracking into one read-only browser UI. This page is the detailed coverage list; the [README](../README.md) has the short overview.

| Area | Coverage |
|---|---|
| **Cluster overview** (`/`) | Cluster identity and HA state; ResourceManager metrics for applications by state, containers, resources and utilization with live trends; node-state counts; scheduler snapshot with scheduler REST/config fallback and a non-blocking notice when the detailed overview source is unavailable (unsupported fields are marked unavailable); currently running applications; per-service health. |
| **Applications** (`/apps`) | Legacy states New, New Saving, Submitted, Accepted, Running, Finished, Failed and Killed, plus distinct final-outcome facets; 24 legacy columns; user, queue, type, tag and time filters; virtualized rows; CSV/JSON export; URL-addressable filters, state, sorting and columns (newest start time first by default) with a one-action **Reset view**; the default scan keeps ID, Name and State first while all columns remain available in legacy source order; at compact content widths, state tabs become a selector and secondary filters move behind a labeled disclosure with an active-filter count while name search and final-outcome facets stay visible; routine freshness remains in the shell while Apps keeps sample, stale and retryable-error cues; short viewports keep filters and rows reachable without collapsing the table viewport. |
| **Global shell** | Search and navigation palette (⌘K or `/`) with application search and keyboard-active results kept visible; shortcut help; cluster connection, theme, time-zone, and live-update controls. |
| **Application details** (`/apps/$appId`) | Priority, queue, timing, timeouts, diagnostics, label expressions, preemption and aggregate-allocation metrics; status timeline; attempts and AM containers; container details and log links; a shared YARN identity header and section navigation across overview, attempts, logs, and native Spark pages. |
| **Spark** (`/apps/$appId/spark/*`) | Jobs and job details with stage DAGs; stages and stage details with task distributions, quantiles and paged/filtered task tables; constrained stage/task metric pairs stay on one line and expose the full formatted pair on hover; RDD operation DAGs; executors; storage/RDDs; environment; SQL executions and plan DAGs; streaming; timeline. Running apps use the ResourceManager web proxy; finished apps use the Spark History Server. |
| **Scheduler** (`/scheduler`) | Capacity, Fair and FIFO schedulers; queue tree with used, guaranteed and maximum capacity; headroom; per-queue users, apps and partitions; scheduler activities, health and configuration; treemap. Scheduler type/resource types, allocation limits, maximum priority, busy percentage and dispatcher queue sizes match Overview, with scheduler memory consistently formatted in MiB/GiB. |
| **Nodes and labels** (`/nodes`, `/node-labels`) | All 16 legacy node columns; state tabs; label and rack filters; utilization heatmap and top consumers; node details with resource matrix, NodeManager info, and a live-container table with an explicit empty state; label catalogue and read-only mapping matrix. |
| **Tools** (`/tools/*`) | Searchable configuration with overridden-only filtering and diffs; JMX tree; live thread stacks; daemon logs; corresponding configuration and JMX views for NodeManagers. |
| **Container logs** (`/apps/$appId/logs`) | Running-container logs from NodeManagers and aggregated logs for finished containers; byte-addressed reads; ANSI handling; level filters; search; live follow over SSE with explicit following/transport status; tall desktop viewports keep the application header fixed around an independently scrolling, virtualized log pane, while narrow or short viewports retain page scrolling to keep the toolbar and pane usable; verified with logs of up to one million lines. |

## Overview and application filter behavior

- Overview's **Used Resources** display subtracts reservations from cross-partition usage, while its raw DOM values retain the ResourceManager's reported totals. When an optional cross-partition resource block is absent, its values use the corresponding ResourceManager counters.
- Overview's live registered-node inventory keeps long lists inside the table's own vertical scroll area.
- **Reset view** and **Clear filters** cancel pending name-search edits; an unfinished debounced search cannot reapply itself after a reset.
- Start-time and finish-time presets replace the whole range, clearing a previous upper bound. Clearing a range removes both bounds without changing the lifecycle filter.
- Expanded application filters keep a scrollable results area on phones, including the recovery action when no applications match.

## Cluster table behavior

- Nodes restores the exact URL-selected columns (`?cols=…`) after reload, including an explicit empty selection.
- The node-label catalogue and node-to-label mapping keep independent sort and column state in the URL, so switching views or reloading preserves each table's configuration.
- Scheduler and queue pages treat numeric-looking search values as strings or flags instead of failing the route; a hand-typed `?queueHide=0` still renders the queue tree.
- The shared column chooser is capped to the space available in short viewports so every column remains reachable.

Burrow does not send YARN write actions. See the [limitations](../README.md#limitations) and the [verification record](verification.md) for exclusions and tested behavior.
