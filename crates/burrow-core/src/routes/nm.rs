//! `GET /api/nm/{host:port}/{path}` — NodeManager passthrough (contract §3).
//!
//! **SSRF guard**: the authority must appear in the RM's own node list, fetched through the normal cache
//! (`/ws/v1/cluster/nodes`), so a browser can only ever reach a host the cluster itself advertises. If the
//! node list cannot be read, the request fails: the guard is fail-closed.
//!
//! Node REST resources are addressed as `/ws/v1/node/{path}`; the daemon pages `conf` and `jmx` are served
//! straight off the NodeManager's web UI.

use std::sync::LazyLock;

use regex::Regex;

use crate::api::{ApiRequest, GroupFut};
use crate::cache::Expect;
use crate::core::{Core, GetSpec};
use crate::error::ApiError;
use crate::reply::Reply;
use crate::routes::table::{ID, Route, RouteTable, rewrite, route, secs};

pub static ROUTES: &[Route] = &[
    route("info", secs(3), Expect::Json),
    route("apps", secs(2), Expect::Json),
    route("apps/{id}", secs(2), Expect::Json),
    route("containers", secs(2), Expect::Json),
    route("containers/{id}", secs(2), Expect::Json),
    // Daemon pages, addressed like the RM's.
    rewrite("conf", "/conf", secs(60), Expect::Any),
    rewrite("jmx", "/jmx", secs(1), Expect::Json),
];

static TABLE: LazyLock<RouteTable> = LazyLock::new(|| RouteTable::new("/ws/v1/node/", ROUTES));

pub fn table() -> &'static RouteTable {
    &TABLE
}

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

/// Normalise a NodeManager authority to the contract's `host:port`.
///
/// The RM is not self-consistent: `AppAttemptInfo.nodeHttpAddress` is `host:port`, while
/// `ContainerInfo.nodeHttpAddress` is a full URL (`http://127.0.0.3:8042`). Both forms are accepted here and
/// reduced to `host:port`, which is what the RM's own node list is matched against. Anything with a path,
/// query or fragment left over is rejected.
pub fn normalize_authority(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    // Scheme prefixes are matched case-insensitively (`HTTP://` is a legal URL scheme spelling).
    let hostport = ["http://", "https://"]
        .iter()
        .find_map(|p| {
            trimmed
                .get(..p.len())
                .filter(|head| head.eq_ignore_ascii_case(p))
                .map(|_| &trimmed[p.len()..])
        })
        .unwrap_or(trimmed);
    if hostport.is_empty()
        || hostport.contains('/')
        || hostport.contains('?')
        || hostport.contains('#')
        || !valid_authority(hostport)
    {
        return None;
    }
    Some(hostport.to_ascii_lowercase())
}

/// `host`, `host:port`, `[v6]:port` — shape only; membership in the RM node list is the real guard.
pub fn valid_authority(a: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r"^(?:\[[0-9A-Fa-f:.]+\]|{ID}):(\d{{1,5}})$")).expect("constant regex")
    });
    match RE.captures(a) {
        Some(c) => c[1].parse::<u16>().is_ok_and(|p| p > 0),
        None => false,
    }
}

pub async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    let Some((authority, path)) = req.path.split_once('/') else {
        return Err(ApiError::not_found(
            "expected /api/nm/{host:port}/{resource}",
        ));
    };
    let Some(authority) = normalize_authority(authority) else {
        return Err(ApiError::bad_request(format!(
            "'{authority}' is not a host:port"
        )));
    };
    if !core.node_authorities().await?.contains(&authority) {
        return Err(ApiError::forbidden(format!(
            "{authority} is not a NodeManager of this cluster"
        ))
        .with_hint(
            "only hosts the ResourceManager reports under /ws/v1/cluster/nodes may be reached",
        ));
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    let Some(r) = table().lookup(path) else {
        return Err(ApiError::not_found(format!(
            "'{path}' is not an exposed NodeManager resource"
        )));
    };
    // Hadoop's configuration servlet chooses JSON by Accept, not the format query alone.
    // Match the RM daemon route so callers receive the format requested on every NodeManager.
    let expect = if path == "conf"
        && req.query.is_some_and(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .any(|(key, value)| key == "format" && value == "json")
        }) {
        Expect::Json
    } else {
        r.route.expect
    };
    let mut spec = GetSpec::new(&r.upstream_path, r.route.ttl, expect);
    spec.authority = Some(&authority);
    spec.query = req.query;
    spec.bypass = req.bypass;
    core.reply(&core.nm, &spec).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_shape() {
        assert!(valid_authority("127.0.0.2:8042"));
        assert!(valid_authority("host.example.com:8042"));
        assert!(valid_authority("[::1]:8042"));
        assert!(!valid_authority("127.0.0.2"));
        assert!(!valid_authority("127.0.0.2:0"));
        assert!(!valid_authority("127.0.0.2:99999"));
        assert!(!valid_authority("127.0.0.2:8042/x"));
        assert!(!valid_authority("evil.com@127.0.0.2:8042"));
        assert!(!valid_authority(""));
    }

    #[test]
    fn node_routes_are_allowlisted() {
        assert_eq!(
            table()
                .lookup("containers/container_1_1_01_000001")
                .unwrap()
                .upstream_path,
            "/ws/v1/node/containers/container_1_1_01_000001"
        );
        assert_eq!(table().lookup("conf").unwrap().upstream_path, "/conf");
        assert!(table().lookup("logs").is_none());
        assert!(table().lookup("../../etc/passwd").is_none());
    }
}
