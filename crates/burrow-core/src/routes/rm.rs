//! `GET /api/rm/*` — the ResourceManager daemon pages (the legacy "Tools" menu).
//!
//! * `conf`, `jmx`, `stacks`, `metrics` — passthrough of the daemon servlets.
//! * `logs` — the RM's HTML directory listing converted to JSON (synthesized):
//!   `{"files":[{"name","size","modified","isDir"}]}`.
//! * `logs/{file}` — streamed (uncached), always labelled `text/plain`; honours `?offset=&length=` by
//!   translating them to an HTTP `Range` request (Jetty supports it), and a browser `Range` header.
//!
//! Deliberately absent: `/logLevel` — it mutates daemon state through GET and burrow is read-only.

use std::sync::LazyLock;

use bytes::Bytes;
use http::StatusCode;
use http::header::HeaderValue;

use crate::api::{ApiRequest, GroupFut};
use crate::cache::{Expect, Served, weak_etag};
use crate::cache::{Expect::*, TtlPolicy};
use crate::core::{Core, GetSpec};
use crate::error::ApiError;
use crate::html::parse_logs_listing;
use crate::reply::{JSON_CT, Reply, ReplyBody};
use crate::routes::table::{Route, RouteTable, is_safe_segment, rewrite, route, secs};

/// TTL of the synthesized RM logs **listing** (`/api/rm/logs`): the HTML directory page it parses. Named so the route
/// table and the handler cannot drift — the SSE hub derives its poll interval from the table.
pub const LOGS_LISTING_TTL: TtlPolicy = secs(3);

pub static ROUTES: &[Route] = &[
    rewrite("conf", "/conf", secs(60), Any),
    rewrite("jmx", "/jmx", secs(1), Json),
    rewrite("stacks", "/stacks", secs(2), Text),
    rewrite("metrics", "/metrics", secs(1), Any),
    route("logs", LOGS_LISTING_TTL, Any),
    route("logs/{id}", TtlPolicy::None, Text),
];

static TABLE: LazyLock<RouteTable> = LazyLock::new(|| RouteTable::new("/", ROUTES));

pub fn table() -> &'static RouteTable {
    &TABLE
}

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

fn has_param(query: Option<&str>, name: &str, value: &str) -> bool {
    query.is_some_and(|q| {
        url::form_urlencoded::parse(q.as_bytes()).any(|(key, found)| key == name && found == value)
    })
}

fn query_value<'a>(query: Option<&'a str>, name: &str) -> Option<&'a str> {
    query?.split('&').find_map(|p| {
        p.split_once('=')
            .filter(|(k, _)| *k == name)
            .map(|(_, v)| v)
    })
}

pub async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    if req.path == "logs" || req.path == "logs/" {
        return logs_listing(core, &req).await;
    }
    let Some(r) = table().lookup(req.path) else {
        return Err(ApiError::not_found(format!(
            "'{}' is not an exposed ResourceManager daemon resource",
            req.path
        )));
    };
    let mut expect = r.route.expect;
    if req.path == "conf" && has_param(req.query, "format", "json") {
        expect = Json;
    }
    let mut spec = GetSpec::new(&r.upstream_path, r.route.ttl, expect);
    spec.query = req.query;
    spec.bypass = req.bypass;
    spec.force_text = r.route.expect == Text;

    // /logs/{file}: byte window → Range.
    let range_owned: Option<String> = if !req.path.starts_with("logs/") {
        None
    } else {
        let file = &req.path["logs/".len()..];
        if !is_safe_segment(file) {
            return Err(ApiError::bad_request("invalid log file name"));
        }
        let parse = |n: &str| -> Result<Option<u64>, ApiError> {
            query_value(req.query, n)
                .map(|v| {
                    v.parse::<u64>().map_err(|_| {
                        ApiError::bad_request(format!("'{n}' must be a non-negative integer"))
                    })
                })
                .transpose()
        };
        let (offset, length) = (parse("offset")?, parse("length")?);
        let range = match (offset, length) {
            (None, None) => req.range.map(str::to_string),
            (o, Some(l)) if l > 0 => {
                let o = o.unwrap_or(0);
                let end = o.checked_add(l - 1).ok_or_else(|| {
                    ApiError::bad_request("requested log byte range exceeds supported limits")
                })?;
                Some(format!("bytes={o}-{end}"))
            }
            (Some(o), None) => Some(format!("bytes={o}-")),
            (_, Some(_)) => return Err(ApiError::bad_request("'length' must be positive")),
        };
        // offset/length are ours, not the daemon's: do not forward them.
        spec.query = None;
        range
    };
    spec.range = range_owned.as_deref();
    core.rm_reply(&spec).await
}

async fn logs_listing(core: &Core, req: &ApiRequest<'_>) -> Result<Reply, ApiError> {
    let mut spec = GetSpec::new("/logs/", LOGS_LISTING_TTL, Any);
    spec.bypass = req.bypass;
    let served = core.served(&core.rm, &spec).await?;
    match served {
        Served::Entry { entry, source } if entry.status.is_success() => {
            let html = String::from_utf8_lossy(&entry.body);
            let files = parse_logs_listing(&html);
            let body = Bytes::from(
                serde_json::to_vec(&serde_json::json!({ "files": files })).expect("serialises"),
            );
            Ok(Reply {
                status: StatusCode::OK,
                content_type: Some(HeaderValue::from_static(JSON_CT)),
                extra: Default::default(),
                etag: Some(weak_etag(&body)),
                body: ReplyBody::Bytes(body),
                cache: Some(source),
                upstream: matches!(
                    source,
                    crate::cache::CacheSource::Miss
                        | crate::cache::CacheSource::Coalesced
                        | crate::cache::CacheSource::Bypass
                )
                .then(|| entry.served_by.to_string()),
                age_ms: Some(entry.age().as_millis() as u64),
            })
        }
        other => Ok(Reply::from_served(other, Expect::Any, false).await),
    }
}
