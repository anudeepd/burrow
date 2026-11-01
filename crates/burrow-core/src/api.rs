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
        self.path
            .split_once('/')
            .map_or(self.path, |(group, _)| group)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn core() -> std::sync::Arc<Core> {
        Core::new(Config::for_rm("http://127.0.0.1:8088").unwrap()).unwrap()
    }

    #[test]
    fn request_helpers_preserve_request_options_and_handle_root_paths() {
        let mut req = ApiRequest::new("yarn/apps");
        req.query = Some("states=RUNNING");
        req.bypass = true;
        req.if_none_match = Some("W/\"etag\"");
        req.range = Some("bytes=1-2");

        assert_eq!(req.group(), "yarn");
        let rest = req.rest();
        assert_eq!(rest.path, "apps");
        assert_eq!(rest.query, req.query);
        assert!(rest.bypass);
        assert_eq!(rest.if_none_match, req.if_none_match);
        assert_eq!(rest.range, req.range);

        let root = ApiRequest::new("");
        assert_eq!(root.group(), "");
        assert_eq!(root.rest().path, "");
        assert_eq!(ApiRequest::new("meta").rest().path, "");
    }

    #[tokio::test]
    async fn healthz_rejects_nested_resources() {
        let core = core();
        let error = dispatch(&core, ApiRequest::new("healthz/extra"))
            .await
            .err()
            .unwrap();

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "'/api/healthz/extra' does not exist");
    }

    #[tokio::test]
    async fn dispatch_reports_empty_and_unknown_groups() {
        let core = core();
        let empty = dispatch(&core, ApiRequest::new("")).await.err().unwrap();
        assert_eq!(empty.status, StatusCode::NOT_FOUND);
        assert_eq!(empty.message, "no /api resource requested");

        let unknown = dispatch(&core, ApiRequest::new("unknown/resource"))
            .await
            .err()
            .unwrap();
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);
        assert_eq!(unknown.message, "unknown API group '/api/unknown'");
    }
}
