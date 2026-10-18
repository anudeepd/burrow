//! The transport-agnostic `/api` surface: the request type every route group receives, the group
//! dispatcher, and the `/api/healthz` endpoint.
//!
//! The binary translates an inbound HTTP request into an [`ApiRequest`], calls [`dispatch`] and turns the
//! resulting [`Reply`] back into an HTTP response (adding the `x-burrow-*` headers and the `304` decision).
//! Everything below this line is tested without a socket — see `crates/burrow/tests/`.

use std::pin::Pin;

use http::StatusCode;

use crate::cache::CacheSource;
use crate::core::Core;
use crate::error::ApiError;
use crate::reply::{Reply, TEXT_CT};
use crate::routes::{events, logs, meta, nm, rm, spark, yarn};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type GroupFut<'a> = BoxFut<'a, Result<Reply, ApiError>>;

/// One `/api/...` request, already stripped of the `/api/` prefix and of `--base-path`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiRequest<'a> {
    /// Path after `/api/`, no leading slash (`yarn/apps`, `meta`, ``).
    pub path: &'a str,
    /// Raw query string, forwarded to the upstream verbatim (sanitised first).
    pub query: Option<&'a str>,
    /// `Cache-Control: no-cache` was requested ⇒ read straight through.
    pub bypass: bool,
    /// `If-None-Match`, compared against the weak ETag to decide a `304`.
    pub if_none_match: Option<&'a str>,
    /// Browser `Range` header (byte ranges for logs).
    pub range: Option<&'a str>,
}

impl<'a> ApiRequest<'a> {
    pub fn new(path: &'a str) -> Self {
        Self {
            path,
            query: None,
            bypass: false,
            if_none_match: None,
            range: None,
        }
    }

    /// First path segment: the route group (`yarn`, `rm`, `nm`, `meta`, `healthz`).
    pub fn group(&self) -> &'a str {
        self.path.split('/').next().unwrap_or("")
    }

    /// The request with its first segment removed: `yarn/apps` → `apps`.
    pub fn rest(&self) -> Self {
        let path = self.path.split_once('/').map_or("", |(_, r)| r);
        Self { path, ..*self }
    }
}

/// Route `/api/{group}/…` to its handler. Unknown groups and unknown resources are `404 not_found`.
pub fn dispatch<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    match req.group() {
        "healthz" => Box::pin(healthz(core, req.rest())),
        "meta" => meta::route_fn(core, req.rest()),
        "yarn" => yarn::route_fn(core, req.rest()),
        "rm" => rm::route_fn(core, req.rest()),
        "nm" => nm::route_fn(core, req.rest()),
        "logs" => logs::route_fn(core, req.rest()),
        "events" => events::route_fn(core, req.rest()),
        "spark" => spark::route_fn(core, req.rest()),
        "" => Box::pin(async { Err(ApiError::not_found("no /api resource requested")) }),
        other => Box::pin(async move {
            Err(ApiError::not_found(format!(
                "unknown API group '/api/{other}'"
            )))
        }),
    }
}

/// `GET /api/healthz` — liveness only: never touches an upstream, never touches the cache.
async fn healthz(_core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    if !req.path.is_empty() {
        return Err(ApiError::not_found(format!(
            "'/api/healthz/{}' does not exist",
            req.path
        )));
    }
    let mut reply = Reply::synthesized(StatusCode::OK, TEXT_CT, "ok");
    reply.cache = Some(CacheSource::Bypass);
    Ok(reply)
}
