//! The upstream abstraction. Every remote service burrow talks to is an [`Upstream`] of some
//! [`UpstreamKind`]; the cache and route layers only ever call [`Upstream::fetch`].
//!
//! * `Rm` — an [`RmPool`] (HA aware).
//! * `Nm` — a fleet of NodeManagers addressed per request by `host:port`.
//! * `SparkHistory`, `Jhs`, `Timeline` (and later others) — one [`Single`] endpoint.
//!
//! New upstream kinds plug in by adding a variant to [`UpstreamKind`] and constructing an `Upstream`
//! in [`crate::core::Core::new`]; nothing in the cache/route machinery needs to change.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::{HaConfig, Tuning, authority_of, url_string};
use crate::error::ApiError;
use crate::http::{BodyMode, Endpoint, FetchReq, HttpClient, RawErr, UpResp};
use crate::rm_pool::RmPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpstreamKind {
    Rm,
    Nm,
    SparkHistory,
    Jhs,
    Timeline,
}

impl UpstreamKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Rm => "ResourceManager",
            Self::Nm => "NodeManager",
            Self::SparkHistory => "Spark History Server",
            Self::Jhs => "JobHistory Server",
            Self::Timeline => "Timeline Service",
        }
    }
}

/// Consecutive-failure tracker with exponential backoff.
#[derive(Debug, Clone, Default)]
pub struct Health {
    pub fails: u32,
    pub down_until: Option<Instant>,
    pub last_error: Option<String>,
    pub last_ok: Option<Instant>,
}

impl Health {
    /// Time left in the backoff window, if any.
    pub fn backoff_remaining(&self, now: Instant) -> Option<Duration> {
        self.down_until
            .and_then(|t| t.checked_duration_since(now))
            .filter(|d| !d.is_zero())
    }

    pub fn record_failure(&mut self, now: Instant, cfg: &HaConfig, error: &str) {
        self.fails = self.fails.saturating_add(1);
        let exp = self.fails.saturating_sub(1).min(16);
        let wait = cfg
            .backoff_base
            .saturating_mul(1u32 << exp)
            .min(cfg.backoff_max);
        self.down_until = Some(now + wait);
        self.last_error = Some(error.to_string());
    }

    pub fn record_ok(&mut self, now: Instant) {
        self.fails = 0;
        self.down_until = None;
        self.last_error = None;
        self.last_ok = Some(now);
    }
}

/// One liveness probe of an upstream endpoint (used by `/api/meta` and `doctor`).
#[derive(Debug, Clone, Serialize)]
pub struct UpstreamProbe {
    pub url: String,
    pub reachable: bool,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
}

pub(crate) fn backing_off_error(
    url: &str,
    remaining: Duration,
    last: Option<&str>,
    what: &str,
) -> ApiError {
    ApiError::unreachable(
        url,
        format!(
            "{what} is unreachable (backing off for another {:.1}s){}",
            remaining.as_secs_f32(),
            last.map(|l| format!("; last error: {l}"))
                .unwrap_or_default()
        ),
    )
}

/// A single-endpoint upstream with health tracking.
pub struct Single {
    pub ep: Endpoint,
    health: Mutex<Health>,
    ha: HaConfig,
}

impl Single {
    pub fn new(url: &url::Url, http: Arc<HttpClient>, concurrency: usize, ha: HaConfig) -> Self {
        Self {
            ep: Endpoint::new(url_string(url), authority_of(url), http, concurrency),
            health: Mutex::new(Health::default()),
            ha,
        }
    }

    pub fn health(&self) -> Health {
        self.health.lock().clone()
    }

    /// Liveness probe: *any* HTTP answer counts as reachable (a 404 or a redirect still proves the daemon
    /// is there). Not attempted while the endpoint is backing off, so a flapping daemon is not hammered.
    pub async fn probe(&self, path: &str) -> UpstreamProbe {
        let url = self.ep.base.clone();
        let now = Instant::now();
        let (remaining, last) = {
            let health = self.health.lock();
            (health.backoff_remaining(now), health.last_error.clone())
        };
        if let Some(remaining) = remaining {
            return UpstreamProbe {
                url,
                reachable: false,
                error: Some(format!(
                    "backing off for another {:.1}s{}",
                    remaining.as_secs_f32(),
                    last.map(|l| format!(" after: {l}")).unwrap_or_default()
                )),
                latency_ms: None,
            };
        }
        let req = FetchReq::get(path, BodyMode::Buffer { cap: 64 * 1024 });
        let t0 = Instant::now();
        match self.ep.attempt(&req).await {
            Ok(att) => {
                // The body is irrelevant to liveness; dropping the response closes that connection.
                drop(att);
                self.health.lock().record_ok(Instant::now());
                UpstreamProbe {
                    url,
                    reachable: true,
                    error: None,
                    latency_ms: Some(t0.elapsed().as_millis() as u64),
                }
            }
            Err(e) => {
                self.health
                    .lock()
                    .record_failure(Instant::now(), &self.ha, &e.api.message);
                UpstreamProbe {
                    url,
                    reachable: false,
                    error: Some(e.api.message),
                    latency_ms: None,
                }
            }
        }
    }

    pub async fn fetch(&self, req: &FetchReq) -> Result<UpResp, ApiError> {
        fetch_endpoint(&self.ep, &self.health, &self.ha, req)
            .await
            .map_err(|e| e.api)
    }
}

/// Shared single-endpoint fetch: backoff gate → attempt → refuse redirects → read body.
async fn fetch_endpoint(
    ep: &Endpoint,
    health: &Mutex<Health>,
    ha: &HaConfig,
    req: &FetchReq,
) -> Result<UpResp, RawErr> {
    let now = Instant::now();
    {
        let h = health.lock();
        if let Some(rem) = h.backoff_remaining(now) {
            return Err(RawErr {
                api: backing_off_error(
                    &ep.display_url(&req.path_and_query),
                    rem,
                    h.last_error.as_deref(),
                    &ep.authority,
                ),
                connect: false,
            });
        }
    }
    let att = match ep.attempt(req).await {
        Ok(a) => a,
        Err(e) => {
            health
                .lock()
                .record_failure(Instant::now(), ha, &e.api.message);
            return Err(e);
        }
    };
    health.lock().record_ok(Instant::now());
    if att.status.is_redirection() {
        // Redirects from non-RM upstreams are never followed (SSRF / credential-forwarding hazard) and
        // never forwarded (the Location would leak an internal address).
        return Err(RawErr {
            api: ApiError::upstream_status(
                http::StatusCode::BAD_GATEWAY,
                att.url.clone(),
                att.status.as_u16(),
                format!(
                    "{} answered with a redirect, which burrow does not follow",
                    att.served_by
                ),
            ),
            connect: false,
        });
    }
    att.into_up(req.mode).await
}

/// One NodeManager: its endpoint plus its health/backoff state.
type NodeSlot = Arc<(Endpoint, Mutex<Health>)>;

/// NodeManagers (or any set of hosts decided per request). Callers MUST have authorised the authority.
pub struct Fleet {
    http: Arc<HttpClient>,
    scheme: &'static str,
    concurrency: usize,
    ha: HaConfig,
    nodes: Mutex<HashMap<String, NodeSlot>>,
}

impl Fleet {
    pub fn new(
        http: Arc<HttpClient>,
        scheme: &'static str,
        concurrency: usize,
        ha: HaConfig,
    ) -> Self {
        Self {
            http,
            scheme,
            concurrency,
            ha,
            nodes: Mutex::new(HashMap::new()),
        }
    }

    fn node(&self, authority: &str) -> NodeSlot {
        let key = authority.to_ascii_lowercase();
        let mut m = self.nodes.lock();
        m.entry(key.clone())
            .or_insert_with(|| {
                Arc::new((
                    Endpoint::new(
                        format!("{}://{key}", self.scheme),
                        key.clone(),
                        self.http.clone(),
                        self.concurrency,
                    ),
                    Mutex::new(Health::default()),
                ))
            })
            .clone()
    }

    pub async fn fetch(&self, req: &FetchReq) -> Result<UpResp, ApiError> {
        let Some(a) = &req.authority else {
            return Err(ApiError::internal("fleet fetch without authority"));
        };
        let n = self.node(a);
        fetch_endpoint(&n.0, &n.1, &self.ha, req)
            .await
            .map_err(|e| e.api)
    }
}

pub enum Inner {
    Single(Single),
    Rm(RmPool),
    Fleet(Fleet),
}

pub struct Upstream {
    pub kind: UpstreamKind,
    pub inner: Inner,
}

impl Upstream {
    pub fn single(
        kind: UpstreamKind,
        url: &url::Url,
        http: Arc<HttpClient>,
        tuning: &Tuning,
        ha: HaConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            kind,
            inner: Inner::Single(Single::new(url, http, tuning.other_concurrency, ha)),
        })
    }

    pub fn rm(pool: RmPool) -> Arc<Self> {
        Arc::new(Self {
            kind: UpstreamKind::Rm,
            inner: Inner::Rm(pool),
        })
    }

    pub fn fleet(fleet: Fleet) -> Arc<Self> {
        Arc::new(Self {
            kind: UpstreamKind::Nm,
            inner: Inner::Fleet(fleet),
        })
    }

    /// Cache-key identity: one logical RM no matter which HA member serves; one id per NodeManager.
    pub fn cache_id(&self, authority: Option<&str>) -> String {
        match &self.inner {
            Inner::Single(s) => format!("{:?}@{}", self.kind, s.ep.authority),
            Inner::Rm(_) => "rm".to_string(),
            Inner::Fleet(_) => format!(
                "nm@{}",
                authority.map(str::to_ascii_lowercase).unwrap_or_default()
            ),
        }
    }

    pub async fn fetch(&self, req: &FetchReq) -> Result<UpResp, ApiError> {
        match &self.inner {
            Inner::Single(s) => s.fetch(req).await,
            Inner::Rm(p) => p.fetch(req).await,
            Inner::Fleet(f) => f.fetch(req).await,
        }
    }

    /// Liveness probe of the upstream as a whole (see [`Single::probe`]).
    pub async fn probe(&self) -> UpstreamProbe {
        match &self.inner {
            Inner::Single(s) => s.probe("/").await,
            Inner::Rm(p) => {
                let probes = p.probe_all(false).await;
                let best = probes
                    .iter()
                    .find(|q| q.reachable && q.ha_state == Some(crate::rm_pool::HaState::Active))
                    .or_else(|| probes.iter().find(|q| q.reachable));
                match best {
                    Some(q) => UpstreamProbe {
                        url: q.url.clone(),
                        reachable: true,
                        error: None,
                        latency_ms: q.latency_ms,
                    },
                    None => UpstreamProbe {
                        url: p.urls().join(", "),
                        reachable: false,
                        error: Some(
                            probes
                                .first()
                                .and_then(|q| q.error.clone())
                                .unwrap_or_else(|| "no ResourceManager answered".into()),
                        ),
                        latency_ms: None,
                    },
                }
            }
            Inner::Fleet(_) => UpstreamProbe {
                url: "node fleet".into(),
                reachable: true,
                error: Some("NodeManagers are probed per node".into()),
                latency_ms: None,
            },
        }
    }

    pub fn as_rm(&self) -> Option<&RmPool> {
        match &self.inner {
            Inner::Rm(p) => Some(p),
            _ => None,
        }
    }

    pub fn as_single(&self) -> Option<&Single> {
        match &self.inner {
            Inner::Single(s) => Some(s),
            _ => None,
        }
    }

    /// Base URL of a single-endpoint upstream.
    pub fn base_url(&self) -> Option<&str> {
        self.as_single().map(|s| s.ep.base.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::HttpSettings;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    fn http() -> Arc<HttpClient> {
        HttpClient::new(&HttpSettings {
            connect_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_millis(200),
            headers: Vec::new(),
            token: None,
            user: None,
            ca_cert: None,
            insecure: false,
        })
        .unwrap()
    }

    async fn server(response: &'static [u8]) -> (url::Url, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 && line != "\r\n" {
                line.clear();
            }
            reader.get_mut().write_all(response).await.unwrap();
        });
        (url::Url::parse(&format!("http://{address}")).unwrap(), task)
    }

    fn ok_response() -> &'static [u8] {
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
    }

    #[test]
    fn upstream_kind_labels_are_stable() {
        assert_eq!(UpstreamKind::Rm.label(), "ResourceManager");
        assert_eq!(UpstreamKind::Nm.label(), "NodeManager");
        assert_eq!(UpstreamKind::SparkHistory.label(), "Spark History Server");
        assert_eq!(UpstreamKind::Jhs.label(), "JobHistory Server");
        assert_eq!(UpstreamKind::Timeline.label(), "Timeline Service");
    }

    #[tokio::test]
    async fn single_probes_any_http_response_and_skips_a_backing_off_endpoint() {
        let (url, task) =
            server(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        let single = Single::new(&url, http(), 1, HaConfig::default());
        let probe = single.probe("/").await;
        assert!(probe.reachable);
        assert!(probe.error.is_none());
        assert!(probe.latency_ms.is_some());
        assert!(single.health().last_ok.is_some());
        task.await.unwrap();

        let mut down = Single::new(&url, http(), 1, HaConfig::default());
        down.health
            .get_mut()
            .record_failure(Instant::now(), &down.ha, "offline");
        let probe = down.probe("/").await;
        assert!(!probe.reachable);
        assert!(probe.error.unwrap().contains("after: offline"));
        assert!(probe.latency_ms.is_none());
    }

    #[tokio::test]
    async fn single_fetch_refuses_redirects_and_short_circuits_backoff() {
        let (url, task) = server(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        let single = Single::new(&url, http(), 1, HaConfig::default());
        let error = single
            .fetch(&FetchReq::get("/secret", BodyMode::Stream))
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, http::StatusCode::BAD_GATEWAY);
        assert!(error.message.contains("does not follow"));
        assert_eq!(
            single.health().fails,
            0,
            "the HTTP redirect proves the service is alive"
        );
        task.await.unwrap();

        single
            .health
            .lock()
            .record_failure(Instant::now(), &single.ha, "recent failure");
        let error = single
            .fetch(&FetchReq::get("/again", BodyMode::Stream))
            .await
            .err()
            .unwrap();
        assert!(error.message.contains("backing off"));
        assert!(error.message.contains("recent failure"));
    }

    #[tokio::test]
    async fn fleet_and_upstream_wrappers_cover_each_inner_variant() {
        let (url, task) = server(ok_response()).await;
        let client = http();
        let fleet = Fleet::new(client.clone(), "http", 2, HaConfig::default());
        let missing = fleet
            .fetch(&FetchReq::get("/info", BodyMode::Buffer { cap: 8 }))
            .await
            .err()
            .unwrap();
        assert_eq!(missing.code, crate::error::ErrorCode::Internal);

        let mut req = FetchReq::get("/info", BodyMode::Buffer { cap: 8 });
        let authority = crate::config::authority_of(&url);
        req.authority = Some(authority.to_ascii_uppercase());
        let up = fleet.fetch(&req).await.unwrap();
        assert_eq!(up.served_by.as_ref(), authority);
        task.await.unwrap();

        let wrapped_fleet =
            Upstream::fleet(Fleet::new(client.clone(), "http", 1, HaConfig::default()));
        assert_eq!(wrapped_fleet.cache_id(None), "nm@");
        assert_eq!(wrapped_fleet.cache_id(Some("NODE:8042")), "nm@node:8042");
        assert!(wrapped_fleet.as_rm().is_none());
        assert!(wrapped_fleet.as_single().is_none());
        let fleet_probe = wrapped_fleet.probe().await;
        assert!(fleet_probe.reachable);
        assert!(fleet_probe.error.unwrap().contains("per node"));

        let (single_url, task) = server(ok_response()).await;
        let tuning = Tuning::default();
        let wrapped_single = Upstream::single(
            UpstreamKind::Timeline,
            &single_url,
            client.clone(),
            &tuning,
            HaConfig::default(),
        );
        assert_eq!(
            wrapped_single.cache_id(None),
            format!("Timeline@{}", crate::config::authority_of(&single_url))
        );
        assert_eq!(
            wrapped_single.base_url(),
            Some(single_url.as_str().trim_end_matches('/'))
        );
        assert!(wrapped_single.as_single().is_some());
        let up = wrapped_single
            .fetch(&FetchReq::get("/", BodyMode::Buffer { cap: 8 }))
            .await
            .unwrap();
        assert!(up.status.is_success());
        task.await.unwrap();

        let (rm_url, task) = server(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 78\r\nConnection: close\r\n\r\n{\"clusterInfo\":{\"haState\":\"ACTIVE\",\"hadoopVersion\":\"3.4.0\",\"state\":\"STARTED\"}}").await;
        let pool = RmPool::new(&[rm_url.clone()], client, &tuning, HaConfig::default());
        let wrapped_rm = Upstream::rm(pool);
        assert_eq!(wrapped_rm.cache_id(None), "rm");
        assert!(wrapped_rm.as_rm().is_some());
        let probe = wrapped_rm.probe().await;
        assert!(probe.reachable);
        assert_eq!(probe.url, rm_url.as_str().trim_end_matches('/'));
        task.await.unwrap();

        let empty = Upstream::rm(RmPool::new(&[], http(), &tuning, HaConfig::default()));
        let unavailable = empty.probe().await;
        assert!(!unavailable.reachable);
        assert_eq!(unavailable.url, "");
        assert_eq!(
            unavailable.error.as_deref(),
            Some("no ResourceManager answered")
        );
    }
}
