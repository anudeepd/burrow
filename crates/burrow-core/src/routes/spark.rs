//! `/api/spark/{appId}/…` — the Spark slice of contract §4.
//!
//! Shape of a request path: `{appId}[/{rest}]`, where `rest` is either `source`, `dag/…`, or one of the
//! Spark REST sub-resources in `ROUTES`. The application id is validated here (the contract's id class
//! plus the `application_` prefix); every sub-resource is validated by an anchored regex table — the same
//! allowlist convention as [`crate::routes::table`], extended with a second TTL because Spark's live data
//! changes every second while history data is effectively immutable (measured recommendations in
//! `docs/spark-rest-and-dag.md` §10).
//!
//! * Passthrough routes forward the browser query **verbatim** (minus our own `attempt` override) and are
//!   served through the shared cache; the only difference between live and history is the base path
//!   (`/proxy/{appId}/…` vs `/…`) and the TTL class.
//! * `source` and the two `dag/…` routes are synthesized: the DAG is parsed from the UI page's
//!   `#dag-viz-metadata` DOT and the page HTML is **never** forwarded (only the parsed JSON is).
//! * `details=true` is forwarded verbatim but never added speculatively: on the *list* endpoints it
//!   inlines every task of every stage attempt (measured 2–2.6× the payload). The single-stage endpoint
//!   already includes `tasks`/`executorSummary`, so `details=true` buys nothing there either.

use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use http::StatusCode;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::api::{ApiRequest, GroupFut};
use crate::cache::{CacheSource, Expect, Expect::Json, Served, TtlPolicy, weak_etag};
use crate::core::{Core, GetSpec};
use crate::error::{ApiError, ErrorCode, UpstreamInfo};
use crate::html::{html_error_message, looks_like_html};
use crate::reply::{Reply, ReplyBody};
use crate::routes::table::{ID, is_safe_segment, millis, secs};
use crate::spark::dag::{self, DagError, DagKind};
use crate::spark::resolve::{self, Mode, Resolved};
use crate::spark::sql_compat as sql;
use crate::upstream::Upstream;

// ------------------------------------------------------------------------------------------------
// Allowlist table (pattern → live TTL / history TTL)
// ------------------------------------------------------------------------------------------------

#[derive(Debug)]
struct SparkRoute {
    /// Anchored regex over `"/{sub-resource}"` after the application id; `{id}` = the contract id class.
    pattern: &'static str,
    live: TtlPolicy,
    history: TtlPolicy,
    expect: Expect,
    /// `/application`: Spark serves the application document (`id`, `name`, `attempts[]`) at the **bare**
    /// `/api/v1/applications/{appId}`, without an attempt segment (the attempt-scoped path returns a
    /// narrower attempt object). Such a route fetches [`Resolved::app_path`] instead of
    /// `rest_prefix + suffix`.
    app_doc: bool,
}

const fn sr_app(
    pattern: &'static str,
    live: TtlPolicy,
    history: TtlPolicy,
    expect: Expect,
) -> SparkRoute {
    SparkRoute {
        pattern,
        live,
        history,
        expect,
        app_doc: true,
    }
}

const fn sr(
    pattern: &'static str,
    live: TtlPolicy,
    history: TtlPolicy,
    expect: Expect,
) -> SparkRoute {
    SparkRoute {
        pattern,
        live,
        history,
        expect,
        app_doc: false,
    }
}

/// One line per exposed Spark REST resource. TTLs: `docs/spark-rest-and-dag.md` §10.
static ROUTES: &[SparkRoute] = &[
    // The contract's `/application` is Spark's bare application document (see `app_doc`).
    sr_app("/application", millis(1000), secs(60), Json),
    sr("/jobs", millis(1000), secs(300), Json),
    sr("/jobs/{id}", millis(1000), secs(300), Json),
    sr("/stages", millis(1000), secs(300), Json),
    sr("/stages/{id}", millis(1000), secs(300), Json),
    sr("/stages/{id}/{id}", secs(2), secs(300), Json),
    sr("/stages/{id}/{id}/taskSummary", secs(2), secs(300), Json),
    sr("/stages/{id}/{id}/taskList", secs(2), secs(300), Json),
    sr("/executors", secs(2), secs(300), Json),
    sr("/allexecutors", secs(2), secs(300), Json),
    sr("/executors/{id}/threads", millis(1000), secs(60), Json),
    sr("/storage/rdd", secs(2), secs(300), Json),
    sr("/storage/rdd/{id}", secs(2), secs(300), Json),
    sr("/environment", secs(10), secs(3600), Json),
    sr("/sql", millis(1000), secs(300), Json),
    sr("/sql/{id}", millis(1000), secs(300), Json),
    sr("/streaming/statistics", millis(1000), secs(300), Json),
    sr("/streaming/receivers", millis(1000), secs(300), Json),
    sr("/streaming/batches", millis(1000), secs(300), Json),
    sr("/streaming/batches/{id}", millis(1000), secs(300), Json),
    sr(
        "/streaming/batches/{id}/operations",
        millis(1000),
        secs(300),
        Json,
    ),
    sr(
        "/streaming/batches/{id}/operations/{id}",
        millis(1000),
        secs(300),
        Json,
    ),
];

struct SparkTable {
    compiled: Vec<Regex>,
}

impl SparkTable {
    fn new() -> Self {
        Self {
            compiled: ROUTES
                .iter()
                .map(|r| {
                    Regex::new(&format!("^(?:{})$", r.pattern.replace("{id}", ID)))
                        .unwrap_or_else(|e| panic!("bad Spark route pattern {:?}: {e}", r.pattern))
                })
                .collect(),
        }
    }

    /// The route whose pattern matches `suffix` (which starts with `/`), if any. Dot-only segments are
    /// rejected exactly like [`crate::routes::table::RouteTable`].
    fn lookup(&self, suffix: &str) -> Option<&'static SparkRoute> {
        if suffix
            .split('/')
            .any(|s| !s.is_empty() && s.bytes().all(|b| b == b'.'))
        {
            return None;
        }
        ROUTES
            .iter()
            .zip(&self.compiled)
            .find(|(_, re)| re.is_match(suffix))
            .map(|(r, _)| r)
    }
}

static TABLE: LazyLock<SparkTable> = LazyLock::new(SparkTable::new);

fn route_ttl(r: &SparkRoute, mode: Mode) -> TtlPolicy {
    match mode {
        Mode::History => r.history,
        _ => r.live,
    }
}

/// Poll interval for an SSE topic on this route. `/source` and `/dag/…` are synthesized before the table is consulted,
/// so they carry their own policy; every other sub-resource uses its route's **live** TTL (the mode is unknown until
/// the app is resolved, and polling a finished app a little too often only costs a cache hit).
pub fn topic_ttl(suffix: &str) -> Option<TtlPolicy> {
    if suffix == "/source" {
        return Some(resolve::source_ttl());
    }
    if suffix.starts_with("/dag/") {
        return Some(dag_page_ttl(Mode::LiveProxy));
    }
    TABLE.lookup(suffix).map(|r| route_ttl(r, Mode::LiveProxy))
}

/// UI pages are DAG source, not user data: 2 s while live, immutable once finished.
fn dag_page_ttl(mode: Mode) -> TtlPolicy {
    match mode {
        Mode::History => secs(3600),
        _ => secs(2),
    }
}

// ------------------------------------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------------------------------------

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

pub async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    let (app_id, suffix) = match req.path.find('/') {
        Some(i) => (&req.path[..i], &req.path[i..]),
        None => (req.path, ""),
    };
    if !is_app_id(app_id) {
        return Err(ApiError::not_found(format!(
            "'{app_id}' is not a YARN application id (application_<ts>_<n>)"
        )));
    }
    let q = split_query(req.query)?;

    if suffix == "/source" {
        let resolved = resolve::resolve(core, app_id, q.attempt.as_deref()).await?;
        let mut reply = Reply::json(&resolved.source);
        finish_synthesized(&mut reply, resolved.cache, resolved.served_by.clone());
        return Ok(reply);
    }

    if suffix.is_empty() || suffix == "/" {
        return Err(ApiError::not_found(format!(
            "'/api/spark/{app_id}' is not a resource; try '/source', a Spark REST resource, or '/dag/…'"
        )));
    }

    if let Some(dag_suffix) = suffix.strip_prefix("/dag/") {
        return dag_route(core, app_id, dag_suffix, q.attempt.as_deref(), req.bypass).await;
    }

    let Some(route) = TABLE.lookup(suffix) else {
        return Err(ApiError::not_found(format!(
            "'{suffix}' is not an exposed Spark resource of /api/spark/{app_id}"
        )));
    };
    let resolved = resolve::resolve(core, app_id, q.attempt.as_deref()).await?;
    let up = resolved.upstream_or_unavailable()?;
    let path = if route.app_doc {
        resolved.app_path.clone()
    } else {
        resolved.rest_path(suffix)
    };
    let ttl = route_ttl(route, resolved.source.mode);
    let mut spec = GetSpec::new(&path, ttl, route.expect);
    spec.query = q.forwarded.as_deref();
    spec.bypass = req.bypass;

    // Spark 2.x has no SQL REST resource. First preserve the native REST behavior; only a 404 triggers
    // version detection and the HTML compatibility adapter. Other upstream errors remain byte-for-byte
    // Spark responses, and newer Spark versions never pay for the extra application-document read.
    if suffix == "/sql" || suffix.starts_with("/sql/") {
        let served = core.served(up, &spec).await?;
        let sql_rest_missing = matches!(
            &served,
            Served::Entry { entry, .. } if entry.status == StatusCode::NOT_FOUND
        );
        if sql_rest_missing
            && spark_app_version(core, &resolved, req.bypass)
                .await
                .as_deref()
                .is_some_and(is_legacy_sql_version)
        {
            return legacy_sql_route(core, &resolved, suffix, q.forwarded.as_deref(), req.bypass)
                .await;
        }
        return Ok(Reply::from_served(served, route.expect, false).await);
    }
    core.reply(up, &spec).await
}

fn is_legacy_sql_version(version: &str) -> bool {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major < 3)
}

/// Read Spark's version from its application document. The doc is already used by the SQL UI and has
/// the same stable terminal/live cache policy as the other app metadata.
async fn spark_app_version(core: &Core, resolved: &Resolved, bypass: bool) -> Option<String> {
    let up = resolved.upstream.as_ref()?;
    let mut spec = GetSpec::new(&resolved.app_path, secs(60), Expect::Json);
    spec.bypass = bypass;
    let Served::Entry { entry, .. } = core.served(up, &spec).await.ok()? else {
        return None;
    };
    if !entry.status.is_success() {
        return None;
    }
    let doc: Value = serde_json::from_slice(&entry.body).ok()?;
    let attempts = doc.get("attempts")?.as_array()?;
    let selected = resolved.source.attempt.as_deref().and_then(|id| {
        attempts
            .iter()
            .find(|attempt| attempt.get("attemptId").and_then(Value::as_str) == Some(id))
    });
    selected
        .or_else(|| attempts.first())?
        .get("appSparkVersion")?
        .as_str()
        .map(str::to_string)
}

async fn legacy_sql_route(
    core: &Core,
    resolved: &Resolved,
    suffix: &str,
    query: Option<&str>,
    bypass: bool,
) -> Result<Reply, ApiError> {
    let up = resolved.upstream_or_unavailable()?;
    let ttl = dag_page_ttl(resolved.source.mode);
    let list_page = resolved.html_path("SQL/");
    if suffix == "/sql" {
        let page = fetch_sql_page(core, up, &list_page, None, ttl, bypass).await?;
        let html = String::from_utf8_lossy(&page.bytes);
        let rows = sql::parse_list(&html).ok_or_else(|| {
            ApiError::unavailable(
                "Spark's SQL compatibility page did not contain an execution list",
            )
            .with_hint(
                "check that the application has SQL executions and that its Spark UI SQL tab is reachable",
            )
        })?;
        let rows = sql::page(rows, query);
        return Ok(json_reply(
            &rows,
            &Prov {
                source: page.cache,
                served_by: Some(page.served_by),
            },
        ));
    }

    let raw_id = suffix
        .strip_prefix("/sql/")
        .ok_or_else(|| ApiError::not_found("invalid Spark SQL execution path"))?;
    let execution_id = raw_id.parse::<i64>().map_err(|_| {
        ApiError::bad_request(format!(
            "invalid Spark SQL execution id '{raw_id}' (expected an integer)"
        ))
    })?;
    let list = fetch_sql_page(core, up, &list_page, None, ttl, bypass).await?;
    let rows = sql::parse_list(&String::from_utf8_lossy(&list.bytes)).ok_or_else(|| {
        ApiError::unavailable("Spark's SQL compatibility page did not contain an execution list")
            .with_hint("check that the Spark UI SQL tab is reachable")
    })?;
    let execution = rows
        .into_iter()
        .find(|row| row["id"].as_i64() == Some(execution_id))
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "no SQL execution {execution_id} in Spark application {}",
                resolved.source.spark_app_id
            ))
            .with_hint("the execution may have been evicted from Spark's retained SQL UI data")
        })?;
    let detail_path = resolved.html_path("SQL/execution/");
    let detail_query = format!("id={execution_id}");
    let page = fetch_sql_page(core, up, &detail_path, Some(&detail_query), ttl, bypass).await?;
    let execution = sql::parse_detail(
        &String::from_utf8_lossy(&page.bytes),
        execution_id,
        execution,
    )
    .ok_or_else(|| {
        ApiError::not_found(format!(
            "Spark's SQL UI has no details for execution {execution_id}"
        ))
        .with_hint("the execution may have been evicted or its SQL plan was not recorded")
    })?;
    Ok(json_reply(
        &execution,
        &Prov {
            source: page.cache,
            served_by: Some(page.served_by),
        },
    ))
}

async fn fetch_sql_page(
    core: &Core,
    up: &Arc<Upstream>,
    path: &str,
    query: Option<&str>,
    ttl: TtlPolicy,
    bypass: bool,
) -> Result<PageBody, ApiError> {
    let mut spec = GetSpec::new(path, ttl, Expect::Any);
    spec.query = query;
    spec.bypass = bypass;
    match core.served(up, &spec).await? {
        Served::Entry { entry, source } if entry.status.is_success() => Ok(PageBody {
            bytes: entry.body.to_vec(),
            cache: source,
            served_by: entry.served_by.to_string(),
        }),
        Served::Entry { entry, .. } => {
            let message = if looks_like_html(entry.content_type.as_ref(), &entry.body) {
                html_error_message(&entry.body)
            } else {
                String::from_utf8_lossy(&entry.body)
                    .trim()
                    .chars()
                    .take(200)
                    .collect()
            };
            let missing = entry.status == StatusCode::NOT_FOUND;
            let mut error = ApiError::new(
                entry.status,
                if missing {
                    ErrorCode::NotFound
                } else {
                    ErrorCode::UpstreamStatus
                },
                if message.is_empty() {
                    format!("Spark SQL UI answered {} for {path}", entry.status.as_u16())
                } else {
                    message
                },
            );
            error.upstream = Some(UpstreamInfo {
                url: entry.url.clone(),
                status: Some(entry.status.as_u16()),
            });
            error.hint = Some(
                "the Spark 2.x SQL view is reconstructed from its SQL listener data; check that the selected application attempt and SQL UI page are available"
                    .into(),
            );
            Err(error)
        }
        Served::Stream { .. } => Err(ApiError::unavailable(
            "Spark's SQL UI page was too large to parse safely",
        )
        .with_hint("the SQL page exceeds burrow's buffered HTML limit")),
    }
}

/// `application_<ts>_<n>`: the YARN prefix, two all-digit parts, and the contract's id class (which also
/// rules out dot-only and slash-bearing segments before any upstream is contacted).
pub fn is_app_id(s: &str) -> bool {
    if !is_safe_segment(s) {
        return false;
    }
    let Some(rest) = s.strip_prefix("application_") else {
        return false;
    };
    match rest.split_once('_') {
        Some((ts, n)) => {
            !ts.is_empty()
                && !n.is_empty()
                && ts.bytes().all(|b| b.is_ascii_digit())
                && n.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

/// The browser query with our own `attempt` override removed (the rest is forwarded verbatim).
struct Query {
    attempt: Option<String>,
    forwarded: Option<String>,
}

fn split_query(query: Option<&str>) -> Result<Query, ApiError> {
    let Some(query) = query else {
        return Ok(Query {
            attempt: None,
            forwarded: None,
        });
    };
    let mut attempt = None;
    let mut kept: Vec<&str> = Vec::new();
    for part in query.split('&').filter(|p| !p.is_empty()) {
        match part.split_once('=') {
            Some(("attempt", v)) if !v.is_empty() => {
                if v.bytes().all(|b| b.is_ascii_digit()) {
                    attempt = Some(v.to_string());
                } else {
                    return Err(ApiError::bad_request(format!(
                        "invalid Spark attempt override '{v}' (expected a number)"
                    )));
                }
            }
            // `attempt=` (empty) means "no override": drop it rather than forwarding it to Spark.
            Some(("attempt", _)) => {}
            _ => kept.push(part),
        }
    }
    Ok(Query {
        attempt,
        forwarded: (!kept.is_empty()).then(|| kept.join("&")),
    })
}

// ------------------------------------------------------------------------------------------------
// Synthesized replies
// ------------------------------------------------------------------------------------------------

/// Provenance of a synthesized body: where the bytes it was derived from came from.
#[derive(Debug, Clone)]
struct Prov {
    source: CacheSource,
    served_by: Option<String>,
}

/// A JSON reply derived from cached upstream bytes: weak ETag (⇒ `304` on `If-None-Match`), the cache
/// outcome of the underlying read, and `x-burrow-upstream` when a real fetch happened.
fn json_reply<T: Serialize>(value: &T, prov: &Prov) -> Reply {
    let mut reply = Reply::json(value);
    finish_synthesized(&mut reply, prov.source, prov.served_by.clone());
    reply
}

fn finish_synthesized(reply: &mut Reply, cache: CacheSource, served_by: Option<String>) {
    if let ReplyBody::Bytes(b) = &reply.body {
        reply.etag = Some(weak_etag(b));
    }
    reply.cache = Some(cache);
    reply.upstream = matches!(
        cache,
        CacheSource::Miss | CacheSource::Coalesced | CacheSource::Bypass
    )
    .then_some(served_by)
    .flatten();
}

// ------------------------------------------------------------------------------------------------
// DAG routes
// ------------------------------------------------------------------------------------------------

async fn dag_route(
    core: &Core,
    app_id: &str,
    suffix: &str,
    attempt_override: Option<&str>,
    bypass: bool,
) -> Result<Reply, ApiError> {
    let segs: Vec<&str> = suffix.split('/').filter(|s| !s.is_empty()).collect();
    match segs.as_slice() {
        ["jobs", job] => {
            let job_id = parse_id(job, "jobId")?;
            let resolved = resolve::resolve(core, app_id, attempt_override).await?;
            dag_job(core, &resolved, job_id, bypass).await
        }
        ["stages", stage, attempt] => {
            let stage_id = parse_id(stage, "stageId")?;
            let attempt = parse_id(attempt, "stageAttemptId")?;
            let resolved = resolve::resolve(core, app_id, attempt_override).await?;
            dag_stage(core, &resolved, stage_id, attempt, bypass).await
        }
        _ => Err(ApiError::not_found(format!(
            "'/dag/{suffix}' is not a Spark DAG resource; use /dag/jobs/{{id}} or /dag/stages/{{id}}/{{attempt}}"
        ))),
    }
}

fn parse_id(raw: &str, what: &str) -> Result<i64, ApiError> {
    raw.parse::<i64>()
        .map_err(|_| ApiError::bad_request(format!("invalid {what} '{raw}' (expected an integer)")))
}

async fn dag_job(
    core: &Core,
    resolved: &Resolved,
    job_id: i64,
    bypass: bool,
) -> Result<Reply, ApiError> {
    let up = resolved.upstream_or_unavailable()?;
    let page = resolved.html_path(DagKind::Job.html_path());
    let query = format!("id={job_id}");
    let ttl = dag_page_ttl(resolved.source.mode);
    let fetched = fetch_page(core, up, &page, Some(&query), ttl, bypass).await?;
    let mut primary = None;
    if let Some(page) = &fetched {
        primary = Some(Prov {
            source: page.cache,
            served_by: Some(page.served_by.clone()),
        });
        match dag::parse(&page.bytes, Some(DagKind::Job), Some(job_id)) {
            Ok(Some(dag)) => return Ok(json_reply(&dag, primary.as_ref().expect("just set"))),
            Err(DagError::NoInfo) => return Err(no_job(job_id, resolved)),
            // No graph on the page (a live race) or an unusable page: fall back to REST.
            _ => {}
        }
    }
    rest_fallback_job(core, resolved, job_id, bypass, primary).await
}

async fn dag_stage(
    core: &Core,
    resolved: &Resolved,
    stage_id: i64,
    attempt: i64,
    bypass: bool,
) -> Result<Reply, ApiError> {
    let up = resolved.upstream_or_unavailable()?;
    let page = resolved.html_path(DagKind::Stage.html_path());
    let query = format!("id={stage_id}&attempt={attempt}");
    let ttl = dag_page_ttl(resolved.source.mode);
    let fetched = fetch_page(core, up, &page, Some(&query), ttl, bypass).await?;
    let mut primary = None;
    if let Some(page) = &fetched {
        primary = Some(Prov {
            source: page.cache,
            served_by: Some(page.served_by.clone()),
        });
        match dag::parse(&page.bytes, Some(DagKind::Stage), None) {
            Ok(Some(dag)) => return Ok(json_reply(&dag, primary.as_ref().expect("just set"))),
            Err(DagError::NoInfo) => return Err(no_stage(stage_id, attempt, resolved)),
            // A SKIPPED stage page carries no graph (Spark renders a placeholder), and a live page can
            // race the UI: resolve from REST, using the enclosing job page for skipped stages.
            _ => {}
        }
    }
    rest_stage(core, resolved, stage_id, attempt, bypass, primary).await
}

fn no_job(job_id: i64, resolved: &Resolved) -> ApiError {
    ApiError::not_found(format!(
        "no job {job_id} in Spark application {}",
        resolved.source.spark_app_id
    ))
    .with_hint("Spark answered 'no information to display' for this job id")
}

fn no_stage(stage_id: i64, attempt: i64, resolved: &Resolved) -> ApiError {
    ApiError::not_found(format!(
        "no stage {stage_id} attempt {attempt} in Spark application {}",
        resolved.source.spark_app_id
    ))
    .with_hint("Spark answered 'no information to display' for this stage attempt")
}

/// REST-only job DAG (`granularity:"stage"`, `edgesInferred:true`).
async fn rest_fallback_job(
    core: &Core,
    resolved: &Resolved,
    job_id: i64,
    bypass: bool,
    primary: Option<Prov>,
) -> Result<Reply, ApiError> {
    let up = resolved.upstream_or_unavailable()?;
    let job_suffix = format!("/jobs/{job_id}");
    let (job, prov) = fetch_json(core, up, resolved, &job_suffix, None, bypass).await?;
    let (stages, _) = fetch_json(core, up, resolved, "/stages", None, bypass).await?;
    let stages = stages.as_array().cloned().unwrap_or_default();
    let dag = dag::rest_fallback_dag(&job, &stages);
    Ok(json_reply(&dag, primary.as_ref().unwrap_or(&prov)))
}

/// Stage DAG for a stage whose page carries no graph: the enclosing job page for SKIPPED stages, else a
/// single-stage REST fallback.
async fn rest_stage(
    core: &Core,
    resolved: &Resolved,
    stage_id: i64,
    attempt: i64,
    bypass: bool,
    primary: Option<Prov>,
) -> Result<Reply, ApiError> {
    let up = resolved.upstream_or_unavailable()?;
    let suffix = format!("/stages/{stage_id}/{attempt}");
    let (stage, prov) = fetch_json(core, up, resolved, &suffix, None, bypass).await?;
    let status = stage
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN")
        .to_string();

    if status == "SKIPPED" {
        // A skipped stage's DAG exists only on the enclosing job page. Pick the lowest job id containing
        // the stage (deterministic; a stage shared by several jobs yields the same graph).
        if let Some(job_id) = enclosing_job(core, resolved, up, stage_id, bypass).await {
            let page = resolved.html_path(DagKind::Job.html_path());
            let query = format!("id={job_id}");
            let ttl = dag_page_ttl(resolved.source.mode);
            if let Ok(Some(page)) = fetch_page(core, up, &page, Some(&query), ttl, bypass).await
                && let Ok(Some(job)) = dag::parse(&page.bytes, Some(DagKind::Job), Some(job_id))
                && let Some(dag) = dag::stage_from_job_dag(&job, stage_id)
            {
                return Ok(json_reply(
                    &dag,
                    &Prov {
                        source: page.cache,
                        served_by: Some(page.served_by.clone()),
                    },
                ));
            }
        }
    }
    let dag = dag::single_stage_fallback(&stage, stage_id, attempt);
    Ok(json_reply(&dag, primary.as_ref().unwrap_or(&prov)))
}

/// The lowest job id whose `stageIds` contains `stage_id`, from the cached `/jobs` list.
async fn enclosing_job(
    core: &Core,
    resolved: &Resolved,
    up: &Arc<Upstream>,
    stage_id: i64,
    bypass: bool,
) -> Option<i64> {
    let (jobs, _) = fetch_json(core, up, resolved, "/jobs", None, bypass)
        .await
        .ok()?;
    jobs.as_array()?
        .iter()
        .filter(|j| {
            j.get("stageIds")
                .and_then(Value::as_array)
                .is_some_and(|ids| ids.iter().any(|v| v.as_i64() == Some(stage_id)))
        })
        .filter_map(|j| j.get("jobId").and_then(Value::as_i64))
        .min()
}

// ------------------------------------------------------------------------------------------------
// Upstream reads used by the DAG routes
// ------------------------------------------------------------------------------------------------

struct PageBody {
    bytes: Vec<u8>,
    cache: CacheSource,
    served_by: String,
}

/// Fetch a UI page. `Ok(None)` = a non-2xx answer (the caller falls back to REST); `Err` = transport
/// failure. HTML is only ever parsed, never forwarded.
async fn fetch_page(
    core: &Core,
    up: &Arc<Upstream>,
    path: &str,
    query: Option<&str>,
    ttl: TtlPolicy,
    bypass: bool,
) -> Result<Option<PageBody>, ApiError> {
    let mut spec = GetSpec::new(path, ttl, Expect::Any);
    spec.query = query;
    spec.bypass = bypass;
    match core.served(up, &spec).await? {
        Served::Entry { entry, source } => {
            if !entry.status.is_success() {
                return Ok(None);
            }
            Ok(Some(PageBody {
                bytes: entry.body.to_vec(),
                cache: source,
                served_by: entry.served_by.to_string(),
            }))
        }
        Served::Stream { .. } => Err(ApiError::unavailable(
            "the Spark UI page is too large to extract a DAG from",
        )
        .with_hint(
            "the page is far larger than any Spark DAG page; check the resolved Spark REST base",
        )),
    }
}

/// Fetch JSON from the resolved base using the same TTL class as the passthrough route.
async fn fetch_json(
    core: &Core,
    up: &Arc<Upstream>,
    resolved: &Resolved,
    suffix: &str,
    query: Option<&str>,
    bypass: bool,
) -> Result<(Value, Prov), ApiError> {
    let route = TABLE.lookup(suffix);
    let ttl = route
        .map(|r| route_ttl(r, resolved.source.mode))
        .unwrap_or(TtlPolicy::Fixed(Duration::from_secs(2)));
    let path = resolved.rest_path(suffix);
    let mut spec = GetSpec::new(&path, ttl, Expect::Json);
    spec.query = query;
    spec.bypass = bypass;
    let (entry, source) = match core.served(up, &spec).await? {
        Served::Entry { entry, source } => (entry, source),
        Served::Stream { .. } => {
            return Err(ApiError::internal(
                "a Spark REST response was too large to parse",
            ));
        }
    };
    if !entry.status.is_success() {
        let message = if looks_like_html(entry.content_type.as_ref(), &entry.body) {
            html_error_message(&entry.body)
        } else {
            String::from_utf8_lossy(&entry.body)
                .trim()
                .chars()
                .take(200)
                .collect()
        };
        let missing = entry.status == StatusCode::NOT_FOUND;
        let mut err = ApiError::new(
            entry.status,
            if missing {
                ErrorCode::NotFound
            } else {
                ErrorCode::UpstreamStatus
            },
            if message.is_empty() {
                format!("Spark answered {} for {suffix}", entry.status.as_u16())
            } else {
                message
            },
        );
        err.upstream = Some(UpstreamInfo {
            url: entry.url.clone(),
            status: Some(entry.status.as_u16()),
        });
        if missing {
            err.hint = Some(
                "Spark's REST API answered 404: the id does not exist in this application, or the \
                 application's data has been retired"
                    .into(),
            );
        }
        return Err(err);
    }
    let value = serde_json::from_slice(&entry.body).map_err(|e| {
        ApiError::internal(format!(
            "cannot parse the Spark REST response from {}: {e}",
            entry.url
        ))
    })?;
    Ok((
        value,
        Prov {
            source,
            served_by: Some(entry.served_by.to_string()),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_id_validation() {
        assert!(is_app_id("application_1791010984040_0001"));
        assert!(!is_app_id("application_1"));
        assert!(!is_app_id("app_1_1"));
        assert!(!is_app_id(".."));
        assert!(!is_app_id("application_1_1/../x"));
    }

    #[test]
    fn table_covers_the_contract_and_rejects_the_rest() {
        let t = SparkTable::new();
        for ok in [
            "/application",
            "/jobs",
            "/jobs/0",
            "/stages",
            "/stages/1",
            "/stages/1/0",
            "/stages/1/0/taskSummary",
            "/stages/1/0/taskList",
            "/executors",
            "/allexecutors",
            "/executors/driver/threads",
            "/storage/rdd",
            "/storage/rdd/6",
            "/environment",
            "/sql",
            "/sql/3",
            "/streaming/statistics",
            "/streaming/receivers",
            "/streaming/batches",
            "/streaming/batches/1",
            "/streaming/batches/1/operations",
            "/streaming/batches/1/operations/2",
        ] {
            assert!(t.lookup(ok).is_some(), "{ok} must be allowed");
        }
        for bad in [
            "/logs",
            "/jobs/1/tasks",
            "/../jobs",
            "/stages/1/0/taskSummary/x",
            "/metrics/json",
            "/sql/1/plan",
        ] {
            assert!(t.lookup(bad).is_none(), "{bad} must be rejected");
        }
    }

    #[test]
    fn query_splits_the_attempt_override() {
        let q = split_query(Some("status=running&attempt=2&details=true")).unwrap();
        assert_eq!(q.attempt.as_deref(), Some("2"));
        assert_eq!(q.forwarded.as_deref(), Some("status=running&details=true"));

        let q = split_query(Some("attempt=1")).unwrap();
        assert_eq!(q.attempt.as_deref(), Some("1"));
        assert_eq!(q.forwarded, None);

        assert!(split_query(Some("attempt=abc")).is_err());
        // An empty override is dropped, not forwarded to Spark.
        let q = split_query(Some("attempt=")).unwrap();
        assert_eq!(q.attempt, None);
        assert_eq!(q.forwarded, None);
    }

    #[test]
    fn ttl_classes_follow_the_measured_recommendations() {
        let t = SparkTable::new();
        assert!(t.lookup("/application").unwrap().app_doc);
        assert!(!t.lookup("/jobs").unwrap().app_doc);
        assert_eq!(
            route_ttl(t.lookup("/jobs").unwrap(), Mode::LiveProxy),
            secs(1)
        );
        assert_eq!(
            route_ttl(t.lookup("/jobs").unwrap(), Mode::History),
            secs(300)
        );
        assert_eq!(
            route_ttl(t.lookup("/environment").unwrap(), Mode::History),
            secs(3600)
        );
        assert_eq!(dag_page_ttl(Mode::LiveProxy), secs(2));
        assert_eq!(dag_page_ttl(Mode::History), secs(3600));
    }
}
