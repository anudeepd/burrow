# Burrow features

Burrow brings YARN cluster operations and Spark-on-YARN tracking into one read-only browser UI. This page is the detailed coverage list; the [README](../README.md) has the short overview.

| Area | Coverage |
|---|---|
| **Cluster overview** (`/`) | Cluster identity and HA state; ResourceManager metrics for applications by state, containers, resources and utilization with live trends; node-state counts; scheduler snapshot; currently running applications; per-service health. |
| **Applications** (`/apps`) | Legacy states New, New Saving, Submitted, Accepted, Running, Finished, Failed and Killed, plus final-status facets; 24 legacy columns; user, queue, type, tag and time filters; virtualized rows; CSV/JSON export; URL-addressable filters and state. |
| **Application details** (`/apps/$appId`) | Priority, queue, timing, timeouts, diagnostics, label expressions, preemption and aggregate-allocation metrics; status timeline; attempts and AM containers; container details and log links. |
| **Spark** (`/apps/$appId/spark/*`) | Jobs and job details with stage DAGs; stages and stage details with task distributions, quantiles and paged/filtered task tables; RDD operation DAGs; executors; storage/RDDs; environment; SQL executions and plan DAGs; streaming; timeline. Running apps use the ResourceManager web proxy; finished apps use the Spark History Server. |
| **Scheduler** (`/scheduler`) | Capacity, Fair and FIFO schedulers; queue tree with used, guaranteed and maximum capacity; headroom; per-queue users, apps and partitions; scheduler activities, health and configuration; treemap. |
| **Nodes and labels** (`/nodes`, `/node-labels`) | All 16 legacy node columns; state tabs; label and rack filters; utilization heatmap and top consumers; node details with resource matrix, NodeManager info and live containers; label catalogue and read-only mapping matrix. |
| **Tools** (`/tools/*`) | Searchable configuration with overridden-only filtering and diffs; JMX tree; live thread stacks; daemon logs; corresponding configuration and JMX views for NodeManagers. |
| **Container logs** (`/apps/$appId/logs`) | Running-container logs from NodeManagers and aggregated logs for finished containers; byte-addressed reads; ANSI handling; level filters; search; live follow over SSE; virtualized rendering, verified with logs of up to one million lines. |

Burrow does not send YARN write actions. See the [limitations](../README.md#limitations) and the [verification record](verification.md) for exclusions and tested behavior.
