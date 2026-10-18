//! Spark integration (`/api/spark/*`) — contract §4.
//!
//! Three pieces, each independently testable and JVM-free:
//!
//! * [`resolve`] — per YARN application, decide `mode: live-proxy | history | none`, the REST/HTML base
//!   and the Spark attempt id. Findings from the live cluster are in that module's docs.
//! * [`dag`] — the RDD DAG extractor: Spark's `#dag-viz-metadata` DOT (HTML) → the contract's `Dag` JSON,
//!   plus the REST-only fallback and the skipped-stage recovery rule. It is a 1:1 mirror of
//!   `fixtures/spark/tools/dagparse.py` and is verified against every `dag-*.json` golden (276 RDD + 90
//!   fallback goldens per Spark version).
//! * `routes/spark.rs` (in the binary's dependency graph) — the passthrough table and the DAG endpoints.
//!
//! ## SQL plans are REST-native on newer Spark; Spark 2.x uses UI compatibility
//!
//! `/sql/{id}?details=true&planDescription=true` already contains the whole physical plan as
//! `nodes[]`/`edges[]` (plus `planDescription` text). The SPA builds its plan tree from those arrays, so
//! newer Spark versions simply forward the query verbatim. Spark 2.x has no SQL REST resource; after its
//! REST route returns 404, [`sql_compat`] adapts the Spark UI list/detail pages into the same schema. Spark's
//! newer SQL UI uses a *different* DOT dialect (`nodeN` string ids, no clusters, no `[Cached]` flags) — it
//! must never be fed to the RDD parser in [`dag`].
//!
//! ## Structured Streaming has no REST surface
//!
//! `/streaming/*` is DStream-only (verified: it 404s with `no streaming listener attached to …` for a
//! Structured Streaming app). Serving Structured Streaming requires parsing its HTML tables — deliberately
//! out of scope here; the passthrough returns Spark's own 404 text for such an app, which the SPA renders
//! as "this application has no streaming listener".
//!
//! ## Error mapping (contract §4 vs §1)
//!
//! * A source-resolution failure that burrow *itself* determines (unknown app, no history server for a
//!   finished app, wrong application type) becomes the §1 envelope: `404 not_found` / `503 unavailable`
//!   with a `reason`-derived message and a `hint`.
//! * A passthrough response is forwarded **byte-for-byte with the upstream status unchanged**, exactly
//!   like the YARN routes (Spark's semantic misses are `404 text/plain`, e.g. `No tasks reported metrics
//!   for 1 / 0 yet.`; its own `503 text/plain` for a history-server thread dump —
//!   `Thread dumps not available through the history server.` — is passed through the same way, so
//!   `503` in the envelope sense is only ever produced by burrow itself). Non-2xx **HTML** (Spark's
//!   Jetty error pages for bad query parameters) becomes the JSON envelope with the upstream status
//!   preserved, because an upstream page must never be forwarded as HTML on our origin. That is what
//!   makes P3 wire parity possible while keeping the browser safe.

pub mod dag;
pub mod resolve;
pub mod sql_compat;
