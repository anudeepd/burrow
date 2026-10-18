//! Spark **source resolution** (contract §4): for one YARN application decide where its Spark REST/HTML
//! surface lives, and with which attempt id.
//!
//! ## What the live cluster actually does (verified; see `cluster/README.md` §3.3/§3.4)
//!
//! * **Running app** → the ResourceManager's web proxy: `GET {rm}/proxy/{appId}/api/v1/applications…`.
//!   With simple auth `WebAppProxyServlet.securityEnabled` is false, so there is **no** `proxyapproved`
//!   approval page and no `checked_<appId>` cookie — a plain GET reaches the driver (`GET
//!   {rm}/proxy/{appId}/` answered `200` with 35 KB of Spark UI HTML on the live cluster). (With Kerberos
//!   the approval handshake *would* be required; untested here, see the gap below.) The proxy strips
//!   `/proxy/{appId}` and forwards the remainder verbatim, so the whole Spark REST surface and the UI
//!   HTML are reachable through it. For a **finished** app the servlet instead redirects to the original
//!   tracking URL — and burrow never follows redirects (SSRF/credential hazard), which is the second
//!   reason history mode must go to the Spark History Server.
//! * **Finished app** → a configured Spark History Server (`--spark-history`,
//!   `spark.yarn.historyServer.address` discovered from `spark-defaults.conf`, or an operator-set address discovered
//!   from the live RM configuration).
//!   The SHS serves REST at the root (`/api/v1/…`) but its **HTML** pages under `/history/{appId}/…`.
//! * **Attempt ids exist only in history mode** (verified live): the running driver's application document
//!   reports `attempts[0]` **without** an `attemptId` (even for a cluster-mode YARN app — Spark fills the
//!   id in only when replaying the event log), and `…/applications/{id}/{attemptId}` is a **404** on the
//!   live driver. The SHS, by contrast, does report `attemptId: "1"` and *requires*
//!   `/api/v1/applications/{appId}/{attemptId}` for a cluster-mode app (`404` without it) while a
//!   client-mode app must omit the segment. We therefore append the segment iff an attempt id is known:
//!   `?attempt=N` always wins, otherwise it is read from the app document in history mode only — so
//!   `source.attempt` is `null` for a live proxy. (On the live driver both path shapes answer `200`; we
//!   use the bare one, which is also the only one that exists for client mode.)
//!
//! Resolution costs at most two cached reads (the RM app document at 1 s/60 s and, in history mode, the
//! SHS app document at 60 s) — there is no second cache layer.
//!
//! ## Gap (documented, not a silent failure)
//!
//! A tracking URL that points at a history server (path `/history/…`) is *detected* and reported, and
//! `--spark-history`/`spark.yarn.historyServer.address` is the supported way to make history mode
//! reachable: burrow can only fetch through configured upstreams, so a temporary URL derived from the
//! tracking URL cannot be used for fetching. In that case `mode` is `history` with `available:false`, a
//! `reason` naming the derived server and a `hint` to pass `--spark-history <url>`.

use std::sync::Arc;
use std::time::Duration;

use http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::cache::{CacheSource, Expect, Served, TtlPolicy};
use crate::core::{Core, GetSpec};
use crate::error::{ApiError, ErrorCode, UpstreamInfo};
use crate::upstream::Upstream;

/// TTL of the RM application document while the app can still change / once it is terminal.
const RM_APP_LIVE: Duration = Duration::from_secs(1);
const RM_APP_TERMINAL: Duration = Duration::from_secs(60);
/// TTL of the Spark app document we read the attempt id from (history mode).
const SPARK_APP_DOC: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Happening now: Spark's REST is proxied through the ResourceManager web proxy.
    LiveProxy,
    /// Finished: served by the Spark History Server.
    History,
    /// No Spark REST base is available (unknown app type, dead driver, no history server).
    None,
}

/// The synthesized `GET /api/spark/{appId}/source` payload (contract §4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub mode: Mode,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "sparkAppId")]
    pub spark_app_id: String,
    /// The Spark attempt id in use (`"1"`, `"2"`, …) or `None` when the app has no attempt segment.
    pub attempt: Option<String>,
    pub available: bool,
    pub reason: Option<String>,
    pub hint: Option<String>,
}

/// A resolved Spark base: where to fetch, and which path prefixes to use.
#[derive(Clone)]
pub struct Resolved {
    pub source: Source,
    /// The upstream to fetch through: the RM (live proxy) or the Spark History Server.
    pub upstream: Option<Arc<Upstream>>,
    /// REST prefix: `/proxy/{appId}/api/v1/applications/{appId}[/{attempt}]` or
    /// `/api/v1/applications/{appId}[/{attempt}]`.
    pub rest_prefix: String,
    /// HTML prefix (no trailing slash): `/proxy/{appId}` or `/history/{appId}[/{attempt}]`.
    pub html_prefix: String,
    /// The **bare** application document (`id`, `name`, `attempts[]`). Spark serves it without an attempt
    /// segment for both live and history; with one, `/applications/{id}/{attempt}` is a *narrower*
    /// attempt object (verified against the SHS). `/application` must therefore use this path.
    pub app_path: String,
    /// Cache source of the RM app-document read that drove this resolution.
    pub cache: CacheSource,
    /// `host:port` of the ResourceManager that served that read (`x-burrow-upstream` on a miss).
    pub served_by: Option<String>,
}

impl Resolved {
    /// The upstream for a request, or the `503 unavailable` the contract asks for when there is none.
    pub fn upstream_or_unavailable(&self) -> Result<&Arc<Upstream>, ApiError> {
        match (&self.upstream, self.source.available) {
            (Some(up), true) => Ok(up),
            _ => Err(unavailable_error(&self.source)),
        }
    }

    /// `{rest_prefix}{suffix}` (`suffix` starts with `/`).
    pub fn rest_path(&self, suffix: &str) -> String {
        format!("{}{suffix}", self.rest_prefix)
    }

    /// `{html_prefix}/{page}` (`page` has no leading slash, e.g. `jobs/job/`).
    pub fn html_path(&self, page: &str) -> String {
        format!("{}/{page}", self.html_prefix)
    }
}

/// `503 unavailable` with the resolution's `reason`/`hint` (contract §1 envelope).
pub fn unavailable_error(source: &Source) -> ApiError {
    let reason = source.reason.clone().unwrap_or_else(|| {
        format!(
            "no Spark REST base is available for {}",
            source.spark_app_id
        )
    });
    let mut err = ApiError::unavailable(reason);
    err.hint = Some(source.hint.clone().unwrap_or_else(|| {
        "check the application state; a finished application needs a Spark History Server (--spark-history)"
            .into()
    }));
    err
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StateClass {
    Live,
    Pending,
    Terminal,
    Unknown,
}

fn classify_state(state: &str) -> StateClass {
    match state.trim().to_ascii_uppercase().as_str() {
        "NEW" | "NEW_SAVING" | "SUBMITTED" | "ACCEPTED" => StateClass::Pending,
        "RUNNING" => StateClass::Live,
        "FINISHED" | "FAILED" | "KILLED" => StateClass::Terminal,
        _ => StateClass::Unknown,
    }
}

#[derive(Debug, Deserialize, Default)]
struct RmAppDoc {
    app: Option<RmApp>,
}

#[derive(Debug, Deserialize, Default)]
struct RmApp {
    state: Option<String>,
    #[serde(rename = "trackingUrl")]
    tracking_url: Option<String>,
    #[serde(rename = "applicationType")]
    application_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SparkAppDoc {
    #[serde(default)]
    attempts: Vec<SparkAttempt>,
}

#[derive(Debug, Deserialize)]
struct SparkAttempt {
    #[serde(rename = "attemptId")]
    attempt_id: Option<String>,
}

enum DocOutcome {
    Attempt(Option<String>),
    Missing,
    Unknown,
}

/// Resolve `app_id` (an `application_<ts>_<n>`), optionally overriding the Spark attempt id.
pub async fn resolve(
    core: &Core,
    app_id: &str,
    attempt_override: Option<&str>,
) -> Result<Resolved, ApiError> {
    let (app, cache, served_by) = rm_app(core, app_id).await?;
    let state = app.state.clone().unwrap_or_default();
    let spark_app_id = app_id.to_string();
    let seg = |attempt: &Option<String>| {
        attempt
            .as_deref()
            .filter(|a| !a.is_empty())
            .map(|a| format!("/{a}"))
            .unwrap_or_default()
    };

    // A non-Spark application has no Spark surface at all: say so instead of proxying a 404.
    if let Some(kind) = app.application_type.as_deref()
        && !kind.to_ascii_uppercase().contains("SPARK")
    {
        return Ok(unavailable(
            Source {
                mode: Mode::None,
                base_url: None,
                spark_app_id,
                attempt: attempt_override.map(str::to_string),
                available: false,
                reason: Some(format!(
                    "{app_id} is a {kind} application, not a Spark application"
                )),
                hint: Some("the Spark API only applies to applications of type SPARK".into()),
            },
            cache,
        ));
    }

    match classify_state(&state) {
        StateClass::Terminal => {
            resolve_history(
                core,
                app,
                app_id,
                spark_app_id,
                attempt_override,
                cache,
                served_by,
            )
            .await
        }
        StateClass::Pending => {
            let rm_base = rm_base(core)?;
            let attempt = attempt_override.map(str::to_string);
            Ok(Resolved {
                source: Source {
                    mode: Mode::LiveProxy,
                    base_url: Some(format!("{rm_base}/proxy/{app_id}")),
                    spark_app_id: spark_app_id.clone(),
                    attempt: attempt.clone(),
                    available: false,
                    reason: Some(format!(
                        "application {app_id} is {state}: its Spark driver web UI is not running yet"
                    )),
                    hint: Some(
                        "the RM proxy serves a Spark UI only once the application is RUNNING"
                            .into(),
                    ),
                },
                upstream: Some(core.rm.clone()),
                rest_prefix: format!(
                    "/proxy/{app_id}/api/v1/applications/{spark_app_id}{}",
                    seg(&attempt)
                ),
                html_prefix: format!("/proxy/{app_id}"),
                app_path: format!("/proxy/{app_id}/api/v1/applications/{spark_app_id}"),
                cache,
                served_by: Some(served_by),
            })
        }
        // RUNNING, and anything we cannot classify (be optimistic: the proxy will tell the truth).
        StateClass::Live | StateClass::Unknown => {
            let rm_base = rm_base(core)?;
            let attempt = attempt_override.map(str::to_string);
            Ok(Resolved {
                source: Source {
                    mode: Mode::LiveProxy,
                    base_url: Some(format!("{rm_base}/proxy/{app_id}")),
                    spark_app_id: spark_app_id.clone(),
                    attempt: attempt.clone(),
                    available: true,
                    reason: None,
                    hint: None,
                },
                upstream: Some(core.rm.clone()),
                rest_prefix: format!(
                    "/proxy/{app_id}/api/v1/applications/{spark_app_id}{}",
                    seg(&attempt)
                ),
                // The driver UI lives directly behind the proxy; the attempt segment is REST-only.
                html_prefix: format!("/proxy/{app_id}"),
                app_path: format!("/proxy/{app_id}/api/v1/applications/{spark_app_id}"),
                cache,
                served_by: Some(served_by),
            })
        }
    }
}

async fn resolve_history(
    core: &Core,
    app: RmApp,
    app_id: &str,
    spark_app_id: String,
    attempt_override: Option<&str>,
    cache: CacheSource,
    served_by: String,
) -> Result<Resolved, ApiError> {
    let derived = app
        .tracking_url
        .as_deref()
        .and_then(history_base_from_tracking);

    if core.spark_history.is_empty() {
        let (reason, hint) = match &derived {
            Some(d) => (
                format!(
                    "{app_id} is finished and its tracking URL refers to the Spark History Server at {d}, but no Spark History Server is configured in burrow"
                ),
                format!("pass --spark-history {d}"),
            ),
            None => (
                format!(
                    "{app_id} is finished and no Spark History Server is configured, so its Spark REST surface is gone"
                ),
                "start the Spark History Server (spark.yarn.historyServer.address) or pass --spark-history"
                    .into(),
            ),
        };
        return Ok(unavailable(
            Source {
                mode: if derived.is_some() {
                    Mode::History
                } else {
                    Mode::None
                },
                base_url: derived,
                spark_app_id,
                attempt: attempt_override.map(str::to_string),
                available: false,
                reason: Some(reason),
                hint: Some(hint),
            },
            cache,
        ));
    }

    let prefix = format!("/api/v1/applications/{app_id}");
    let mut selected: Option<(Arc<Upstream>, Option<String>)> = None;
    let mut fallback: Option<Arc<Upstream>> = None;
    for up in &core.spark_history {
        match spark_attempt_doc(core, up, &prefix).await {
            DocOutcome::Attempt(attempt) => {
                selected = Some((up.clone(), attempt));
                break;
            }
            DocOutcome::Missing => {}
            DocOutcome::Unknown => {
                fallback.get_or_insert_with(|| up.clone());
            }
        }
    }
    if selected.is_none()
        && let Some(up) = fallback
    {
        selected = Some((up, None));
    }
    let Some((configured, discovered_attempt)) = selected else {
        let base = core
            .spark_history
            .first()
            .and_then(|up| up.base_url())
            .map(str::to_string);
        return Ok(unavailable(
            Source {
                mode: Mode::History,
                base_url: base,
                spark_app_id,
                attempt: attempt_override.map(str::to_string),
                available: false,
                reason: Some(format!(
                    "none of the configured Spark History Servers has application {app_id}"
                )),
                hint: Some(
                    "check the configured --spark-history addresses and the Spark event-log retention"
                        .into(),
                ),
            },
            cache,
        ));
    };
    let base = configured.base_url().unwrap_or_default().to_string();
    let attempt = attempt_override.map(str::to_string).or(discovered_attempt);
    let seg = attempt
        .as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("/{a}"))
        .unwrap_or_default();
    Ok(Resolved {
        source: Source {
            mode: Mode::History,
            base_url: Some(base),
            spark_app_id: spark_app_id.clone(),
            attempt: attempt.clone(),
            available: true,
            reason: None,
            hint: None,
        },
        upstream: Some(configured),
        rest_prefix: format!("/api/v1/applications/{spark_app_id}{seg}"),
        html_prefix: format!("/history/{spark_app_id}{seg}"),
        app_path: format!("/api/v1/applications/{spark_app_id}"),
        cache,
        served_by: Some(served_by),
    })
}

fn unavailable(source: Source, cache: CacheSource) -> Resolved {
    Resolved {
        source,
        upstream: None,
        rest_prefix: String::new(),
        html_prefix: String::new(),
        app_path: String::new(),
        cache,
        served_by: None,
    }
}

/// Base URL of the remembered active RM, else the first configured one.
fn rm_base(core: &Core) -> Result<String, ApiError> {
    core.rm_pool()
        .active_url()
        .or_else(|| core.rm_pool().urls().into_iter().next())
        .ok_or_else(|| ApiError::internal("no ResourceManager is configured"))
}

/// Cache policy of the RM application document the synthesized `/source` route resolves through: 1 s while the app is
/// live, 60 s once it is terminal. The SSE hub polls a `spark/{appId}/source` topic at the live interval.
pub fn source_ttl() -> TtlPolicy {
    TtlPolicy::AppState {
        live: RM_APP_LIVE,
        terminal: RM_APP_TERMINAL,
    }
}

/// The RM's application document, through the cache (`AppState` TTL: 1 s while live, 60 s terminal).
async fn rm_app(core: &Core, app_id: &str) -> Result<(RmApp, CacheSource, String), ApiError> {
    let path = format!("/ws/v1/cluster/apps/{app_id}");
    let spec = GetSpec::new(&path, source_ttl(), Expect::Json);
    let (entry, source) = match core.served(&core.rm, &spec).await? {
        Served::Entry { entry, source } => (entry, source),
        Served::Stream { .. } => {
            return Err(ApiError::internal(
                "the ResourceManager application document was too large to read",
            ));
        }
    };
    if !entry.status.is_success() {
        let missing = entry.status == StatusCode::NOT_FOUND;
        let code = if missing {
            ErrorCode::NotFound
        } else {
            ErrorCode::UpstreamStatus
        };
        let message = if missing {
            format!("no YARN application {app_id} in the ResourceManager")
        } else {
            format!(
                "the ResourceManager answered {} for application {app_id}",
                entry.status.as_u16()
            )
        };
        let mut err = ApiError::new(entry.status, code, message);
        err.upstream = Some(UpstreamInfo {
            url: entry.url.clone(),
            status: Some(entry.status.as_u16()),
        });
        if missing {
            err.hint = Some(
                "the ResourceManager forgets finished applications only after its own retention window"
                    .into(),
            );
        }
        return Err(err);
    }
    let doc: RmAppDoc = serde_json::from_slice(&entry.body).map_err(|e| {
        ApiError::internal(format!(
            "cannot parse the ResourceManager application document for {app_id}: {e}"
        ))
    })?;
    let app = doc.app.ok_or_else(|| {
        ApiError::not_found(format!(
            "the ResourceManager returned no application object for {app_id}"
        ))
    })?;
    Ok((app, source, entry.served_by.to_string()))
}

/// Read the Spark attempt id from the app document (never an error: it is an optimisation for path shape).
async fn spark_attempt_doc(core: &Core, up: &Arc<Upstream>, prefix: &str) -> DocOutcome {
    let spec = GetSpec::new(prefix, TtlPolicy::Fixed(SPARK_APP_DOC), Expect::Json);
    let body = match core.served(up, &spec).await {
        Ok(Served::Entry { entry, .. }) if entry.status.is_success() => entry.body.clone(),
        Ok(Served::Entry { entry, .. }) if entry.status == StatusCode::NOT_FOUND => {
            return DocOutcome::Missing;
        }
        _ => return DocOutcome::Unknown,
    };
    match serde_json::from_slice::<SparkAppDoc>(&body) {
        Ok(doc) => DocOutcome::Attempt(
            doc.attempts
                .first()
                .and_then(|a| a.attempt_id.clone())
                .filter(|a| !a.is_empty()),
        ),
        Err(_) => DocOutcome::Unknown,
    }
}

/// `http://shs:8080/history/application_1_1/1/jobs/` → `http://shs:8080` (any base path preserved).
pub fn history_base_from_tracking(tracking: &str) -> Option<String> {
    let u = url::Url::parse(tracking).ok()?;
    let marker = "/history/";
    let at = u.path().find(marker)?;
    let mut base = format!("{}://{}", u.scheme(), u.host_str()?);
    if let Some(port) = u.port() {
        base.push(':');
        base.push_str(&port.to_string());
    }
    let prefix = &u.path()[..at];
    if !prefix.is_empty() && prefix != "/" {
        base.push_str(prefix);
    }
    Some(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_classification_matches_yarn() {
        assert_eq!(classify_state("RUNNING"), StateClass::Live);
        assert_eq!(classify_state("running"), StateClass::Live);
        for s in ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED"] {
            assert_eq!(classify_state(s), StateClass::Pending);
        }
        for s in ["FINISHED", "FAILED", "KILLED"] {
            assert_eq!(classify_state(s), StateClass::Terminal);
        }
        assert_eq!(classify_state(""), StateClass::Unknown);
        assert_eq!(classify_state("SOMETHING_NEW"), StateClass::Unknown);
    }

    #[test]
    fn tracking_url_derives_a_history_base() {
        assert_eq!(
            history_base_from_tracking("http://shs:18080/history/application_1_1/1/jobs/")
                .as_deref(),
            Some("http://shs:18080")
        );
        assert_eq!(
            history_base_from_tracking("https://shs.example.com:8443/history/application_1_1/")
                .as_deref(),
            Some("https://shs.example.com:8443")
        );
        // A reverse-proxied SHS keeps its base path.
        assert_eq!(
            history_base_from_tracking("http://edge/spark/history/application_1_1/").as_deref(),
            Some("http://edge/spark")
        );
        // The RM's own proxy/UI tracking URL is not a history server.
        assert_eq!(
            history_base_from_tracking("http://rm:8088/proxy/application_1_1/"),
            None
        );
        assert_eq!(
            history_base_from_tracking("http://rm:8088/cluster/app/application_1_1"),
            None
        );
        assert_eq!(history_base_from_tracking("not a url"), None);
    }

    #[test]
    fn mode_and_source_serialise_to_the_contract_spelling() {
        let s = Source {
            mode: Mode::LiveProxy,
            base_url: Some("http://rm:8088/proxy/application_1_1".into()),
            spark_app_id: "application_1_1".into(),
            attempt: None,
            available: true,
            reason: None,
            hint: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["mode"], "live-proxy");
        assert_eq!(v["sparkAppId"], "application_1_1");
        assert_eq!(v["baseUrl"], "http://rm:8088/proxy/application_1_1");
        assert!(v["attempt"].is_null());
        assert_eq!(serde_json::to_value(Mode::History).unwrap(), "history");
        assert_eq!(serde_json::to_value(Mode::None).unwrap(), "none");
    }

    #[test]
    fn unavailable_error_carries_a_hint() {
        let s = Source {
            mode: Mode::None,
            base_url: None,
            spark_app_id: "application_1_1".into(),
            attempt: None,
            available: false,
            reason: Some("no history server".into()),
            hint: None,
        };
        let err = unavailable_error(&s);
        assert_eq!(err.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.code, ErrorCode::Unavailable);
        assert_eq!(err.message, "no history server");
        assert!(err.hint.is_some());
    }
}
