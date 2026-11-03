//! Choosing *which* daemon serves a container's logs, and reading a byte window out of it.
//!
//! ## Resolution order (contract §5)
//!
//! 1. **NodeManager** — for a container the NodeManager still knows about (running, or finished but the
//!    application is still live). `GET {nm}/node/containerlogs/{containerId}/{user}`.
//! 2. **JobHistoryServer** — for a container whose application has left the NodeManager (or whose logs
//!    have been aggregated): `GET {jhs}/jobhistory/logs/{nodeId}/{containerId}/{containerId}/{user}`.
//!    The NodeManager itself redirects here (HTTP 307) when `yarn.log-aggregation-enable=true` and the
//!    application is gone; burrow refuses upstream redirects, so it recognises the terminal app state
//!    and asks the JobHistoryServer directly (see `crate::logs` for the live evidence).
//! 3. Otherwise an explicit `503 unavailable` with a hint naming every source that was tried and why it
//!    failed — never a silent empty listing.
//!
//! The NodeManager authority is taken from the browser hint only after it appears in the ResourceManager's
//! own node list (the same fail-closed SSRF guard as `routes/nm.rs`); the JobHistoryServer is always the
//! configured upstream, never a browser-supplied URL.

use std::sync::LazyLock;
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use http::StatusCode;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::cache::{CacheSource, Expect, Served, TtlPolicy};
use crate::core::{Core, GetSpec};
use crate::error::ApiError;
use crate::http::{UpBody, UpResp};
use crate::logs::page;
use crate::upstream::Upstream;

/// Hard cap on bytes returned by one read (contract §5, default 8 MiB).
pub const HARD_CAP: usize = 8 * 1024 * 1024;
/// Window when neither `offset` nor `length` is given (contract §5: first 1 MiB).
pub const DEFAULT_WINDOW: usize = 1024 * 1024;
/// TTL of the upstream *listing* page. Short: files appear and vanish as containers run and aggregate.
pub const LISTING_TTL: Duration = Duration::from_secs(2);
/// TTL of the ResourceManager lookups used to resolve a container (app state, attempts, nodes).
const RM_TTL: Duration = Duration::from_secs(2);
/// Slack added to the read cap so page chrome around the `<pre>` does not truncate the payload.
const READ_SLACK: usize = 512 * 1024;

static RE_CONTAINER: LazyLock<Regex> = LazyLock::new(|| {
    // Hadoop ContainerId includes an optional RM restart epoch in HA clusters.
    Regex::new(r"^container_(?:e\d+_)?(?P<ts>\d+)_(?P<seq>\d+)_\d+_\d+$").unwrap()
});
static RE_APP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^application_\d+_\d+$").unwrap());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSourceKind {
    Nm,
    Jhs,
}

impl LogSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nm => "nm",
            Self::Jhs => "jhs",
        }
    }
}

/// One log file as the SPA sees it (contract §5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileEntry {
    pub name: String,
    pub size: u64,
    /// Epoch milliseconds, when the source reports one. The NodeManager's local listing prints only a
    /// size, so `nm` entries carry `null` rather than an invented timestamp.
    pub last_modified: Option<i64>,
}

/// Where a container's logs are served from.
#[derive(Debug, Clone)]
pub struct LogLocation {
    pub kind: LogSourceKind,
    /// Upstream path up to (not including) the file name.
    pub base_path: String,
    /// NodeManager authority (`host:port`), when known.
    pub node: Option<String>,
    /// Selected JHS base URL, needed to keep the same server for the file read.
    pub upstream_url: Option<String>,
    pub user: String,
    pub container_id: String,
    pub files: Vec<LogFileEntry>,
}

impl LogLocation {
    pub fn file(&self, name: &str) -> Option<&LogFileEntry> {
        self.files.iter().find(|f| f.name == name)
    }

    /// Hadoop mounts both log pages with a trailing slash (`pajoin("/containerlogs", …, logType)` and the
    /// JobHistoryServer's `/jobhistory/logs/…/user/{file}/`); without it the JobHistoryServer silently
    /// answers with the *listing* page instead of the file, so the slash is part of the contract.
    pub fn file_path(&self, name: &str) -> String {
        format!("{}{name}/", self.base_path)
    }

    pub fn source(&self) -> &'static str {
        self.kind.as_str()
    }
}

/// A resolved location plus the cache provenance of the listing fetch that produced it.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub location: LogLocation,
    pub cache: CacheSource,
    pub upstream: Option<String>,
    pub age_ms: u64,
}

/// The browser-supplied hints of contract §5.
#[derive(Debug, Clone, Copy, Default)]
pub struct LogQuery<'a> {
    pub container_id: &'a str,
    pub node: Option<&'a str>,
    pub user: Option<&'a str>,
    pub app: Option<&'a str>,
}

pub fn is_container_id(s: &str) -> bool {
    RE_CONTAINER.is_match(s)
}

pub fn is_app_id(s: &str) -> bool {
    RE_APP.is_match(s)
}

/// `container_[e<epoch>_]<ts>_<seq>_<attempt>_<n>` → `application_<ts>_<seq>`.
pub fn app_of_container(cid: &str) -> Option<String> {
    let parts = RE_CONTAINER.captures(cid)?;
    Some(format!("application_{}_{}", &parts["ts"], &parts["seq"]))
}

/// The byte window a request asks for, clamped to the file and to [`HARD_CAP`].
pub fn window(
    total: u64,
    offset: Option<u64>,
    length: Option<u64>,
    tail: Option<u64>,
) -> Result<(u64, u64), ApiError> {
    if let Some(t) = tail {
        if offset.is_some() || length.is_some() {
            return Err(ApiError::bad_request(
                "tail= cannot be combined with offset/length",
            ));
        }
        let start = total.saturating_sub(t.min(HARD_CAP as u64));
        return Ok((start, total));
    }
    let start = offset.unwrap_or(0).min(total);
    let len = match length {
        Some(l) => l,
        None if offset.is_none() => DEFAULT_WINDOW as u64,
        None => HARD_CAP as u64,
    }
    .min(HARD_CAP as u64);
    Ok((start, start.saturating_add(len).min(total)))
}

// ---------------------------------------------------------------------------------------------
// ResourceManager lookups
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct AppDoc {
    app: Option<AppEntry>,
}

#[derive(Deserialize)]
struct AppEntry {
    state: Option<String>,
    user: Option<String>,
}

#[derive(Deserialize)]
struct AttemptsDoc {
    #[serde(rename = "appAttempts")]
    attempts: Option<AttemptsList>,
}

#[derive(Deserialize)]
struct AttemptsList {
    #[serde(rename = "appAttempt")]
    attempt: Option<Vec<AttemptEntry>>,
}

#[derive(Deserialize)]
struct AttemptEntry {
    #[serde(rename = "appAttemptId")]
    attempt_id: Option<String>,
    #[serde(rename = "containerId")]
    container_id: Option<String>,
    #[serde(rename = "nodeHttpAddress")]
    node_http: Option<String>,
}

#[derive(Deserialize)]
struct ContainersDoc {
    containers: Option<ContainersList>,
}

#[derive(Deserialize)]
struct ContainersList {
    container: Option<Vec<ContainerEntry>>,
}

#[derive(Deserialize)]
struct ContainerEntry {
    id: Option<String>,
    #[serde(rename = "nodeHttpAddress")]
    node_http: Option<String>,
}

#[derive(Deserialize)]
struct NodesDoc {
    nodes: Option<NodesList>,
}

#[derive(Deserialize)]
struct NodesList {
    node: Option<Vec<NodeEntry>>,
}

#[derive(Deserialize)]
struct NodeEntry {
    id: Option<String>,
    #[serde(rename = "nodeHTTPAddress")]
    node_http: Option<String>,
}

async fn rm_json(core: &Core, path: &str) -> Result<Option<serde_json::Value>, ApiError> {
    let page = fetch_raw(
        core,
        &core.rm,
        None,
        path,
        None,
        TtlPolicy::Fixed(RM_TTL),
        4 * 1024 * 1024,
    )
    .await;
    match page {
        Ok(p) if p.status.is_success() => Ok(serde_json::from_slice(&p.body).ok()),
        _ => Ok(None),
    }
}

async fn app_info(core: &Core, app: &str) -> Result<(Option<String>, Option<String>), ApiError> {
    let Some(doc) = rm_json(core, &format!("/ws/v1/cluster/apps/{app}")).await? else {
        return Ok((None, None));
    };
    let Ok(parsed) = serde_json::from_value::<AppDoc>(doc) else {
        return Ok((None, None));
    };
    let Some(app) = parsed.app else {
        return Ok((None, None));
    };
    Ok((app.state, app.user))
}

fn is_terminal_state(state: &str) -> bool {
    matches!(state, "FINISHED" | "FAILED" | "KILLED")
}

/// The `nodeHttpAddress` of the container, looked up through the application's attempts and (for a live
/// application) their container lists.
async fn node_for_container(core: &Core, app: &str, cid: &str) -> Result<Option<String>, ApiError> {
    let Some(doc) = rm_json(core, &format!("/ws/v1/cluster/apps/{app}/appattempts")).await? else {
        return Ok(None);
    };
    let attempts = serde_json::from_value::<AttemptsDoc>(doc)
        .ok()
        .and_then(|d| d.attempts)
        .and_then(|l| l.attempt)
        .unwrap_or_default();
    for a in &attempts {
        if a.container_id.as_deref() == Some(cid)
            && let Some(http) = a
                .node_http
                .as_deref()
                .and_then(crate::routes::nm::normalize_authority)
        {
            return Ok(Some(http));
        }
    }
    for a in &attempts {
        let Some(attempt_id) = a.attempt_id.as_deref() else {
            continue;
        };
        let path = format!("/ws/v1/cluster/apps/{app}/appattempts/{attempt_id}/containers");
        let Some(doc) = rm_json(core, &path).await? else {
            continue;
        };
        let containers = serde_json::from_value::<ContainersDoc>(doc)
            .ok()
            .and_then(|d| d.containers)
            .and_then(|l| l.container)
            .unwrap_or_default();
        for c in containers {
            let Some(http) = (c.id.as_deref() == Some(cid))
                .then_some(c.node_http.as_deref())
                .flatten()
                .and_then(crate::routes::nm::normalize_authority)
            else {
                continue;
            };
            return Ok(Some(http));
        }
    }
    Ok(None)
}

/// Map a NodeManager HTTP authority (`host:8042`) to the ResourceManager's node id (`host:8041`), which is
/// the key the JobHistoryServer's aggregated-log URL is built from.
async fn rpc_id_for(core: &Core, authority: &str) -> Result<Option<String>, ApiError> {
    let Some(doc) = rm_json(core, "/ws/v1/cluster/nodes").await? else {
        return Ok(None);
    };
    let nodes = serde_json::from_value::<NodesDoc>(doc)
        .ok()
        .and_then(|d| d.nodes)
        .and_then(|l| l.node)
        .unwrap_or_default();
    let want = authority.to_ascii_lowercase();
    Ok(nodes
        .into_iter()
        .find(|n| {
            n.node_http
                .as_deref()
                .is_some_and(|h| h.to_ascii_lowercase() == want)
        })
        .and_then(|n| n.id)
        .map(|id| id.to_ascii_lowercase()))
}

// ---------------------------------------------------------------------------------------------
// Upstream fetches
// ---------------------------------------------------------------------------------------------

struct RawPage {
    status: StatusCode,
    body: Bytes,
    source: CacheSource,
    served_by: String,
    age_ms: u64,
}

async fn read_up(up: UpResp, cap: usize) -> Bytes {
    match up.body {
        UpBody::Full(b) => b,
        UpBody::Stream { prefix, rest } => {
            let mut buf = BytesMut::from(&prefix[..]);
            let mut rest = rest;
            while buf.len() < cap {
                match rest.next().await {
                    Some(Ok(c)) => buf.extend_from_slice(&c),
                    _ => break,
                }
            }
            buf.freeze()
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn fetch_raw(
    core: &Core,
    up: &std::sync::Arc<Upstream>,
    authority: Option<&str>,
    path: &str,
    query: Option<&str>,
    ttl: TtlPolicy,
    cap: usize,
) -> Result<RawPage, ApiError> {
    let mut spec = GetSpec::new(path, ttl, Expect::Any);
    spec.authority = authority;
    spec.query = query;
    match core.served(up, &spec).await? {
        Served::Entry { entry, source } => Ok(RawPage {
            status: entry.status,
            body: entry.body.clone(),
            source,
            served_by: entry.served_by.to_string(),
            age_ms: entry.age().as_millis() as u64,
        }),
        Served::Stream { up, source } => {
            let up = *up;
            let served_by = up.served_by.to_string();
            let status = up.status;
            Ok(RawPage {
                status,
                body: read_up(up, cap).await,
                source,
                served_by,
                age_ms: 0,
            })
        }
    }
}

/// The JobHistoryServer path for aggregated logs, with a proxy base path removed when the selected
/// upstream already includes it.
fn jhs_prefix(core: &Core, jhs: &Upstream) -> String {
    let log_path = core
        .config
        .log_server_url
        .as_deref()
        .and_then(|u| url::Url::parse(u).ok())
        .map(|u| u.path().trim_end_matches('/').to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "/jobhistory/logs".to_string());
    let base_path = jhs
        .base_url()
        .and_then(|u| url::Url::parse(u).ok())
        .map(|u| u.path().trim_end_matches('/').to_string())
        .unwrap_or_default();
    let path = if base_path.is_empty() {
        log_path.as_str()
    } else {
        log_path
            .strip_prefix(&base_path)
            .filter(|rest| rest.is_empty() || rest.starts_with('/'))
            .unwrap_or(&log_path)
    };
    if path.is_empty() {
        "/jobhistory/logs".into()
    } else {
        path.to_string()
    }
}

fn files_from(listed: Vec<page::ListedFile>) -> Vec<LogFileEntry> {
    listed
        .into_iter()
        .map(|f| LogFileEntry {
            name: f.name,
            size: f.size,
            last_modified: f.modified.map(|s| s * 1000),
        })
        .collect()
}

async fn try_nm(core: &Core, authority: &str, cid: &str, user: &str) -> Result<Resolved, String> {
    let base_path = format!("/node/containerlogs/{cid}/{user}/");
    let page = fetch_raw(
        core,
        &core.nm,
        Some(authority),
        &base_path,
        None,
        TtlPolicy::Fixed(LISTING_TTL),
        4 * 1024 * 1024,
    )
    .await
    .map_err(|e| format!("NodeManager {authority}: {}", e.message))?;
    if !page.status.is_success() {
        return Err(format!(
            "NodeManager {authority} answered {} (the container is no longer in its context, or the logs \
             have been aggregated)",
            page.status.as_u16()
        ));
    }
    let html = String::from_utf8_lossy(&page.body).into_owned();
    let files = if let Some(reason) = page::no_logs_reason(&html) {
        let _ = reason;
        Vec::new()
    } else {
        files_from(page::nm_listing(&html))
    };
    Ok(Resolved {
        location: LogLocation {
            kind: LogSourceKind::Nm,
            base_path,
            node: Some(authority.to_string()),
            upstream_url: None,
            user: user.to_string(),
            container_id: cid.to_string(),
            files,
        },
        cache: page.source,
        upstream: Some(page.served_by),
        age_ms: page.age_ms,
    })
}

async fn try_jhs(core: &Core, node_rpc: &str, cid: &str, user: &str) -> Result<Resolved, String> {
    if core.jhs.is_empty() {
        return Err("JobHistoryServer is not configured".to_string());
    }
    let mut errors = Vec::new();
    for jhs in &core.jhs {
        let base_path = format!("{}/{node_rpc}/{cid}/{cid}/{user}/", jhs_prefix(core, jhs));
        let page = match fetch_raw(
            core,
            jhs,
            None,
            &base_path,
            None,
            TtlPolicy::Fixed(LISTING_TTL),
            4 * 1024 * 1024,
        )
        .await
        {
            Ok(page) => page,
            Err(e) => {
                errors.push(format!(
                    "{}: {}",
                    jhs.base_url().unwrap_or("JHS"),
                    e.message
                ));
                continue;
            }
        };
        if !page.status.is_success() {
            errors.push(format!(
                "{} answered {} for aggregated logs",
                page.served_by,
                page.status.as_u16()
            ));
            continue;
        }
        let html = String::from_utf8_lossy(&page.body).into_owned();
        if let Some(reason) = page::no_logs_reason(&html) {
            errors.push(format!("{}: {reason}", page.served_by));
            continue;
        }
        return Ok(Resolved {
            location: LogLocation {
                kind: LogSourceKind::Jhs,
                base_path,
                node: None,
                upstream_url: jhs.base_url().map(str::to_string),
                user: user.to_string(),
                container_id: cid.to_string(),
                files: files_from(page::jhs_listing(&html)),
            },
            cache: page.source,
            upstream: Some(page.served_by),
            age_ms: page.age_ms,
        });
    }
    Err(format!(
        "JobHistoryServer candidates failed: {}",
        errors.join("; ")
    ))
}

/// Pick the best source for `q.container_id` and list its files.
pub async fn resolve(core: &Core, q: &LogQuery<'_>) -> Result<Resolved, ApiError> {
    if !is_container_id(q.container_id) {
        return Err(ApiError::bad_request(format!(
            "'{}' is not a container id",
            q.container_id
        )));
    }
    let app = match q.app.map(str::to_string) {
        Some(a) if is_app_id(&a) => a,
        Some(a) => {
            return Err(ApiError::bad_request(format!(
                "'{a}' is not an application id"
            )));
        }
        None => app_of_container(q.container_id)
            .expect("a validated container id always includes its application id"),
    };

    let (app_state, app_user) = app_info(core, &app).await?;
    let user = match q.user.map(str::to_string).or(app_user) {
        Some(u) if !u.is_empty() => u,
        _ => {
            return Err(ApiError::bad_request(
                "cannot determine the log owner: pass ?user=",
            )
            .with_hint(
                "the ResourceManager does not know this application (or ?app= was not given); the log URL \
                 carries the owning user",
            ));
        }
    };

    // NodeManager authority: a hint only counts once the RM's own node list contains it (fail-closed).
    let authority = match q.node {
        Some(n) => {
            // `?node=` may arrive as `host:port` or as the URL form the RM puts in ContainerInfo; both normalise.
            let Some(n) = crate::routes::nm::normalize_authority(n) else {
                return Err(ApiError::bad_request(format!("'{n}' is not a host:port")));
            };
            if !core.node_authorities().await?.contains(&n) {
                return Err(ApiError::forbidden(format!(
                    "{n} is not a NodeManager of this cluster"
                ))
                .with_hint(
                    "only hosts the ResourceManager reports under /ws/v1/cluster/nodes may be reached",
                ));
            }
            Some(n)
        }
        None => node_for_container(core, &app, q.container_id).await?,
    };

    let terminal = app_state.as_deref().is_some_and(is_terminal_state);
    let node_rpc = match &authority {
        Some(a) => rpc_id_for(core, a).await?,
        None => None,
    };

    // Terminal applications are served by the JobHistoryServer (the NodeManager redirects there); live
    // ones by their NodeManager. The first source that answers wins; the other is only tried on failure.
    let mut reasons = Vec::new();
    let try_order: [&str; 2] = if terminal && node_rpc.is_some() {
        ["jhs", "nm"]
    } else {
        ["nm", "jhs"]
    };
    for which in try_order {
        let outcome = match which {
            "nm" => match &authority {
                Some(a) => Some(try_nm(core, a, q.container_id, &user).await),
                None => {
                    reasons.push(
                        "nm: cannot determine the container's node (pass ?node=host:port)"
                            .to_string(),
                    );
                    None
                }
            },
            _ => match &node_rpc {
                Some(rpc) => Some(try_jhs(core, rpc, q.container_id, &user).await),
                None => {
                    reasons.push(
                        "jhs: cannot map the container's node to a ResourceManager node id"
                            .to_string(),
                    );
                    None
                }
            },
        };
        match outcome {
            Some(Ok(resolved)) => return Ok(resolved),
            Some(Err(e)) => reasons.push(format!("{which}: {e}")),
            None => {}
        }
    }

    let cid = q.container_id;
    Err(ApiError::unavailable(format!(
        "no log source could serve {cid}"
    ))
    .with_hint(format!(
        "tried — {}; pass ?node=host:port and ?user=… (and ?app=…) so the right daemon can be addressed",
        reasons.join("; ")
    )))
}

/// One byte window of one log file, decoded UTF-8-lossily.
#[derive(Debug, Clone)]
pub struct Window {
    pub start: u64,
    pub end: u64,
    pub total: u64,
    pub text: Bytes,
}

/// Read `[start, end)` of `name` from the resolved source.
pub async fn read_window(
    core: &Core,
    loc: &LogLocation,
    name: &str,
    start: u64,
    end: u64,
) -> Result<Window, ApiError> {
    let path = loc.file_path(name);
    let query = format!("start={start}&end={end}");
    let up = upstream_for(core, loc)?;
    let page = fetch_raw(
        core,
        &up,
        loc.node.as_deref(),
        &path,
        Some(&query),
        TtlPolicy::None,
        (end.saturating_sub(start) as usize).saturating_add(READ_SLACK),
    )
    .await?;
    if !page.status.is_success() {
        return Err(ApiError::upstream_status(
            page.status,
            format!("{}{path}?{query}", page.served_by),
            page.status.as_u16(),
            format!(
                "{} answered {} for {name}",
                loc.source(),
                page.status.as_u16()
            ),
        ));
    }
    let html = String::from_utf8_lossy(&page.body).into_owned();
    if let Some(reason) = page::read_error(&html) {
        return Err(ApiError::not_found(format!("{name}: {reason}")));
    }
    let text = page::log_text(&html);
    let total = page::page_total_len(&html)
        .or_else(|| loc.file(name).map(|f| f.size))
        .unwrap_or(end);
    Ok(Window {
        start,
        end,
        total,
        text: Bytes::from(text),
    })
}

/// Whether the container is still running, as far as the NodeManager knows. `None` when unknown (the
/// NodeManager no longer tracks it, which means it has finished).
pub async fn container_running(core: &Core, loc: &LogLocation) -> Option<bool> {
    if loc.kind == LogSourceKind::Jhs {
        return Some(false);
    }
    let authority = loc.node.as_deref()?;
    let path = format!("/ws/v1/node/containers/{}", loc.container_id);
    let page = fetch_raw(
        core,
        &core.nm,
        Some(authority),
        &path,
        None,
        TtlPolicy::Fixed(RM_TTL),
        256 * 1024,
    )
    .await
    .ok()?;
    if !page.status.is_success() {
        return Some(false);
    }
    let doc: serde_json::Value = serde_json::from_slice(&page.body).ok()?;
    let state = doc
        .get("container")?
        .get("state")?
        .as_str()?
        .to_ascii_uppercase();
    Some(matches!(
        state.as_str(),
        "RUNNING" | "NEW" | "LOCALIZING" | "SCHEDULED"
    ))
}

fn upstream_for(core: &Core, loc: &LogLocation) -> Result<std::sync::Arc<Upstream>, ApiError> {
    match loc.kind {
        LogSourceKind::Nm => Ok(core.nm.clone()),
        LogSourceKind::Jhs => core
            .jhs
            .iter()
            .find(|up| loc.upstream_url.as_deref() == up.base_url())
            .or_else(|| core.jhs.first())
            .cloned()
            .ok_or_else(|| {
                ApiError::unavailable("the JobHistoryServer is not configured")
                    .with_hint("pass --jhs http://host:19888 (or set yarn.log.server.url)")
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    fn core() -> Arc<Core> {
        let mut config = crate::config::Config::for_rm("http://127.0.0.1:0").unwrap();
        config.tuning.connect_timeout = Duration::from_millis(1);
        config.tuning.request_timeout = Duration::from_millis(1);
        Core::new(config).unwrap()
    }

    fn location(
        kind: LogSourceKind,
        node: Option<&str>,
        upstream_url: Option<&str>,
    ) -> LogLocation {
        LogLocation {
            kind,
            base_path: "/logs/".into(),
            node: node.map(str::to_string),
            upstream_url: upstream_url.map(str::to_string),
            user: "alice".into(),
            container_id: "container_1_2_3_4".into(),
            files: Vec::new(),
        }
    }

    async fn rm_with_responses(
        responses: Vec<(&'static str, &'static str)>,
    ) -> (Arc<Core>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            for (expected_path, body) in responses {
                let (stream, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(stream);
                let mut request_line = String::new();
                reader.read_line(&mut request_line).await.unwrap();
                let path = request_line
                    .split_whitespace()
                    .nth(1)
                    .expect("HTTP request has a path");
                assert_eq!(path, expected_path);
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).await.unwrap();
                    if header == "\r\n" {
                        break;
                    }
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                reader
                    .get_mut()
                    .write_all(response.as_bytes())
                    .await
                    .unwrap();
            }
        });
        let core = Core::new(crate::config::Config::for_rm(&format!("http://{address}")).unwrap())
            .unwrap();
        (core, task)
    }

    #[test]
    fn container_and_app_ids() {
        assert!(is_container_id("container_1791010984040_0005_01_000001"));
        assert!(is_container_id(
            "container_e17_1791010984040_0005_01_000001"
        ));
        assert!(!is_container_id("container_1_1_01"));
        assert!(!is_container_id(
            "container_1791010984040_0005_01_000001/../x"
        ));
        assert_eq!(
            app_of_container("container_1791010984040_0005_01_000001").as_deref(),
            Some("application_1791010984040_0005")
        );
        assert_eq!(
            app_of_container("container_e17_1791010984040_0005_01_000001").as_deref(),
            Some("application_1791010984040_0005")
        );
        assert_eq!(app_of_container("container_e_bad_id"), None);
        assert!(is_app_id("application_1791010984040_0005"));
        assert!(!is_app_id("application_x"));
    }

    #[test]
    fn window_math() {
        // first 1 MiB by default
        assert_eq!(window(5_000_000, None, None, None).unwrap(), (0, 1_048_576));
        // explicit offset+length, clamped to EOF
        assert_eq!(window(100, Some(90), Some(50), None).unwrap(), (90, 100));
        // offset without length reads to the cap
        assert_eq!(window(100, Some(10), None, None).unwrap(), (10, 100));
        // tail
        assert_eq!(window(100, None, None, Some(10)).unwrap(), (90, 100));
        assert_eq!(window(5, None, None, Some(10)).unwrap(), (0, 5));
        // offset beyond EOF collapses to an empty window at EOF
        assert_eq!(window(100, Some(500), Some(10), None).unwrap(), (100, 100));
        // the cap clamps length
        assert_eq!(
            window(u64::MAX, Some(0), Some(u64::MAX), None).unwrap(),
            (0, HARD_CAP as u64)
        );
        assert!(window(10, Some(1), None, Some(2)).is_err());
    }

    #[test]
    fn terminal_states() {
        for s in ["FINISHED", "FAILED", "KILLED"] {
            assert!(is_terminal_state(s));
        }
        assert!(!is_terminal_state("RUNNING"));
        assert!(!is_terminal_state("ACCEPTED"));
    }

    #[tokio::test]
    async fn raw_page_helpers_and_source_metadata_cover_fallbacks() {
        let full = UpResp {
            status: StatusCode::OK,
            content_type: None,
            extra: Default::default(),
            body: UpBody::Full(Bytes::from_static(b"full")),
            served_by: "rm".into(),
            url: "http://rm/test".into(),
        };
        assert_eq!(read_up(full, 2).await, "full");
        let stream = UpResp {
            status: StatusCode::OK,
            content_type: None,
            extra: Default::default(),
            body: UpBody::Stream {
                prefix: Bytes::from_static(b"p"),
                rest: futures_util::stream::iter([
                    Ok(Bytes::from_static(b"abc")),
                    Err(std::io::Error::other("broken stream")),
                    Ok(Bytes::from_static(b"ignored")),
                ])
                .boxed(),
            },
            served_by: "rm".into(),
            url: "http://rm/test".into(),
        };
        assert_eq!(read_up(stream, 4).await, "pabc");

        let files = files_from(vec![page::ListedFile {
            name: "stdout".into(),
            size: 8,
            modified: Some(12),
        }]);
        assert_eq!(files[0].name, "stdout");
        assert_eq!(files[0].last_modified, Some(12_000));

        let mut config = crate::config::Config::for_rm("http://127.0.0.1:0").unwrap();
        config.jhs = vec![
            url::Url::parse("http://jhs.example:19888/").unwrap(),
            url::Url::parse("http://jhs.example:19888/proxy").unwrap(),
        ];
        config.log_server_url = Some("http://jhs.example:19888/proxy/jobhistory/logs/".into());
        let core = Core::new(config).unwrap();
        assert_eq!(jhs_prefix(&core, &core.jhs[1]), "/jobhistory/logs");
        assert_eq!(jhs_prefix(&core, &core.jhs[0]), "/proxy/jobhistory/logs");
        let mut same_path = crate::config::Config::for_rm("http://127.0.0.1:0").unwrap();
        same_path.jhs = vec![url::Url::parse("http://jhs.example:19888/proxy").unwrap()];
        same_path.log_server_url = Some("http://jhs.example:19888/proxy/".into());
        let same_path = Core::new(same_path).unwrap();
        assert_eq!(
            jhs_prefix(&same_path, &same_path.jhs[0]),
            "/jobhistory/logs"
        );
        let err = upstream_for(&core, &location(LogSourceKind::Jhs, None, Some("other"))).unwrap();
        assert_eq!(err.base_url(), Some("http://jhs.example:19888"));
        let missing =
            Core::new(crate::config::Config::for_rm("http://127.0.0.1:0").unwrap()).unwrap();
        let err = upstream_for(&missing, &location(LogSourceKind::Jhs, None, None))
            .err()
            .expect("missing JHS should be unavailable");
        assert_eq!(err.status, http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            container_running(&core, &location(LogSourceKind::Jhs, None, None)).await,
            Some(false)
        );
        assert_eq!(
            container_running(&core, &location(LogSourceKind::Nm, None, None)).await,
            None
        );

        assert_eq!(rpc_id_for(&missing, "nm.example:8042").await.unwrap(), None);
    }

    #[tokio::test]
    async fn attempt_lookup_skips_unusable_direct_nodes_and_uses_container_records() {
        let cid = "container_1_2_3_4";
        let (core, server) = rm_with_responses(vec![(
            "/ws/v1/cluster/apps/application_1_2/appattempts",
            r#"{"appAttempts":{"appAttempt":[{"containerId":"container_1_2_3_4","nodeHttpAddress":"nm.example:8042"}]}}"#,
        )])
        .await;
        assert_eq!(
            node_for_container(&core, "application_1_2", cid)
                .await
                .unwrap()
                .as_deref(),
            Some("nm.example:8042")
        );
        server.await.unwrap();

        let (core, server) = rm_with_responses(vec![
            (
                "/ws/v1/cluster/apps/application_1_2/appattempts",
                r#"{"appAttempts":{"appAttempt":[{"appAttemptId":"appattempt_1_2_000001","containerId":"container_1_2_3_4","nodeHttpAddress":"bad address"}]}}"#,
            ),
            (
                "/ws/v1/cluster/apps/application_1_2/appattempts/appattempt_1_2_000001/containers",
                r#"{"containers":{"container":[{"id":"container_1_2_3_5","nodeHttpAddress":"other.example:8042"},{"id":"container_1_2_3_4","nodeHttpAddress":"bad address"},{"id":"container_1_2_3_4","nodeHttpAddress":"nm.example:8042"}]}}"#,
            ),
        ])
        .await;
        assert_eq!(
            node_for_container(&core, "application_1_2", cid)
                .await
                .unwrap()
                .as_deref(),
            Some("nm.example:8042")
        );
        server.await.unwrap();

        let (core, server) = rm_with_responses(vec![(
            "/ws/v1/cluster/apps/application_1_2/appattempts",
            r#"{"appAttempts":{"appAttempt":[{"containerId":"container_1_2_3_4","nodeHttpAddress":"bad address"}]}}"#,
        )])
        .await;
        assert_eq!(
            node_for_container(&core, "application_1_2", cid)
                .await
                .unwrap(),
            None
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn log_resolution_rejects_bad_hints_and_missing_owners() {
        let core = core();
        let invalid_container = resolve(
            &core,
            &LogQuery {
                container_id: "not-a-container",
                ..Default::default()
            },
        )
        .await
        .err()
        .unwrap();
        assert_eq!(invalid_container.status, StatusCode::BAD_REQUEST);

        let invalid_app = resolve(
            &core,
            &LogQuery {
                container_id: "container_1_2_3_4",
                app: Some("not-an-app"),
                user: Some("alice"),
                ..Default::default()
            },
        )
        .await
        .err()
        .unwrap();
        assert!(invalid_app.message.contains("is not an application id"));

        let missing_user = resolve(
            &core,
            &LogQuery {
                container_id: "container_1_2_3_4",
                ..Default::default()
            },
        )
        .await
        .err()
        .unwrap();
        assert!(
            missing_user
                .message
                .contains("cannot determine the log owner")
        );

        let invalid_node = resolve(
            &core,
            &LogQuery {
                container_id: "container_1_2_3_4",
                user: Some("alice"),
                node: Some("not a host"),
                ..Default::default()
            },
        )
        .await
        .err()
        .unwrap();
        assert!(invalid_node.message.contains("is not a host:port"));
    }
}
