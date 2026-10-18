//! [`Core`]: the shared state of the backend — configuration, upstreams, cache, topic registry — and the
//! one entry point every route uses to read through the cache: [`Core::served`] / [`Core::reply`].

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use http::header::{HeaderMap, HeaderName, HeaderValue, RANGE};
use parking_lot::Mutex;

use crate::cache::{Cache, Expect, Fetcher, Served, TtlPolicy, cache_key};
use crate::config::{Config, ConfigError};
use crate::error::ApiError;
use crate::events::Hub;
use crate::http::{BodyMode, FetchReq, HttpClient, HttpSettings};
use crate::reply::Reply;
use crate::rm_pool::RmPool;
use crate::topics::TopicRegistry;
use crate::upstream::{Fleet, Upstream, UpstreamKind};

/// One upstream GET through the cache.
#[derive(Debug, Clone)]
pub struct GetSpec<'a> {
    /// `host:port` for fleet upstreams (NodeManagers); `None` otherwise.
    pub authority: Option<&'a str>,
    /// Upstream path, e.g. `/ws/v1/cluster/apps`.
    pub path: &'a str,
    /// Raw query from the browser (sanitised here; forwarded verbatim otherwise).
    pub query: Option<&'a str>,
    pub ttl: TtlPolicy,
    pub expect: Expect,
    pub bypass: bool,
    /// Browser `Range` header; makes the request uncached and streamed.
    pub range: Option<&'a str>,
    /// Always label a successful body `text/plain` (logs, stacks).
    pub force_text: bool,
}

impl<'a> GetSpec<'a> {
    pub fn new(path: &'a str, ttl: TtlPolicy, expect: Expect) -> Self {
        Self {
            authority: None,
            path,
            query: None,
            ttl,
            expect,
            bypass: false,
            range: None,
            force_text: false,
        }
    }
}

/// Query parameters a browser must never be able to inject into an upstream request: they would let it
/// pick the effective user (simple auth) or smuggle delegation tokens.
const FORBIDDEN_PARAMS: &[&str] = &["user.name", "doas", "delegation", "token"];

pub fn sanitize_query(q: &str) -> String {
    q.split('&')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let raw_name = p.split_once('=').map_or(*p, |(n, _)| n);
            // Servlet query parsing decodes parameter names too. Preserve allowed values verbatim,
            // but never let percent encoding bypass the configured-identity boundary.
            let name = crate::routes::table::percent_decode(raw_name).to_ascii_lowercase();
            !FORBIDDEN_PARAMS.contains(&name.as_str())
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// One memo slot: the value plus when it was computed, behind an async lock so one computation is shared.
type MemoSlot<T> = Arc<tokio::sync::Mutex<Option<(Instant, T)>>>;

/// Time-bounded memo whose compute step runs under a per-key async lock, so concurrent callers share one
/// computation (used for `/api/meta` probes, which are not cacheable bodies).
pub struct Memo<T: Clone> {
    slots: Mutex<HashMap<String, MemoSlot<T>>>,
}

impl<T: Clone> Default for Memo<T> {
    fn default() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }
}

impl<T: Clone> Memo<T> {
    pub async fn get_or<F, Fut>(&self, key: &str, ttl: Duration, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.get_or_status(key, ttl, f).await.0
    }

    /// Like [`Memo::get_or`], but also reports whether the memoized value was reused (`true` = hit).
    pub async fn get_or_status<F, Fut>(&self, key: &str, ttl: Duration, f: F) -> (T, bool)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let slot = self
            .slots
            .lock()
            .entry(key.to_string())
            .or_default()
            .clone();
        let mut guard = slot.lock().await;
        if let Some((at, v)) = guard.as_ref()
            && at.elapsed() < ttl
        {
            return (v.clone(), true);
        }
        let v = f().await;
        *guard = Some((Instant::now(), v.clone()));
        (v, false)
    }
}

pub struct Core {
    pub config: Arc<Config>,
    pub cache: Cache,
    pub rm: Arc<Upstream>,
    pub nm: Arc<Upstream>,
    pub spark_history: Vec<Arc<Upstream>>,
    pub jhs: Vec<Arc<Upstream>>,
    pub timeline: Option<Arc<Upstream>>,
    pub topics: TopicRegistry,
    /// The SSE hub behind `/api/events` (contract §6).
    pub events: Hub,
    pub(crate) meta_memo: Memo<Arc<serde_json::Value>>,
    pub(crate) node_set: Mutex<Option<(String, Arc<std::collections::HashSet<String>>)>>,
    /// A weak handle to self, so long-lived tasks (the SSE poller, log tailers) can own the state they
    /// poll without keeping the `Core` alive.
    self_ref: OnceLock<Weak<Core>>,
}

impl Core {
    pub fn new(config: Config) -> Result<Arc<Self>, ConfigError> {
        let http = HttpClient::new(&HttpSettings {
            connect_timeout: config.tuning.connect_timeout,
            request_timeout: config.tuning.request_timeout,
            headers: config.headers.clone(),
            token: config.token.clone(),
            user: config.user.clone(),
            ca_cert: config.ca_cert.clone(),
            insecure: config.insecure,
        })?;
        let rm = Upstream::rm(RmPool::new(
            &config.rm_urls,
            http.clone(),
            &config.tuning,
            config.ha.clone(),
        ));
        let nm = Upstream::fleet(Fleet::new(
            http.clone(),
            config.http_policy.node_scheme(),
            config.tuning.nm_concurrency,
            config.ha.clone(),
        ));
        let singles = |kind, urls: &[url::Url]| {
            urls.iter()
                .map(|u| Upstream::single(kind, u, http.clone(), &config.tuning, config.ha.clone()))
                .collect::<Vec<_>>()
        };
        let spark_history = singles(UpstreamKind::SparkHistory, &config.spark_history);
        let jhs = singles(UpstreamKind::Jhs, &config.jhs);
        let timeline = config.timeline.as_ref().map(|u| {
            Upstream::single(
                UpstreamKind::Timeline,
                u,
                http.clone(),
                &config.tuning,
                config.ha.clone(),
            )
        });
        let topics = TopicRegistry::new();
        topics.register_defaults();
        // The hub is wired in this build, so `/api/meta` reports `features.events = true`.
        topics.set_enabled(true);
        let core = Arc::new(Self {
            cache: Cache::new(config.cache.clone()),
            config: Arc::new(config),
            rm,
            nm,
            spark_history,
            jhs,
            timeline,
            topics,
            events: Hub::new(),
            meta_memo: Memo::default(),
            node_set: Mutex::new(None),
            self_ref: OnceLock::new(),
        });
        let _ = core.self_ref.set(Arc::downgrade(&core));
        Ok(core)
    }

    /// A strong handle to this `Core` when it was built by [`Core::new`]. Long-lived tasks (the SSE hub's
    /// poller, a log tailer) need it to keep polling after the request that started them has returned.
    pub fn shared(&self) -> Option<Arc<Core>> {
        self.self_ref.get().and_then(Weak::upgrade)
    }

    pub fn rm_pool(&self) -> &RmPool {
        self.rm.as_rm().expect("rm upstream is always an RmPool")
    }

    /// Read `spec` from `up` through the cache.
    pub async fn served(&self, up: &Arc<Upstream>, spec: &GetSpec<'_>) -> Result<Served, ApiError> {
        let query = spec.query.map(sanitize_query).filter(|q| !q.is_empty());
        let path_and_query = match &query {
            Some(q) => format!("{}?{q}", spec.path),
            None => spec.path.to_string(),
        };
        let mut headers = HeaderMap::new();
        if let Some(r) = spec.range {
            let v = HeaderValue::from_str(r)
                .map_err(|_| ApiError::bad_request("invalid Range header"))?;
            headers.insert(RANGE, v);
        }
        let ttl = if spec.range.is_some() {
            TtlPolicy::None
        } else {
            spec.ttl
        };
        let key = cache_key(&up.cache_id(spec.authority), spec.path, query.as_deref());
        let req = FetchReq {
            authority: spec.authority.map(str::to_string),
            path_and_query,
            mode: BodyMode::Stream, // replaced per call by the cache
            accept: match spec.expect {
                Expect::Json => Some("application/json"),
                _ => None,
            },
            headers,
        };
        let upc = up.clone();
        let fetcher: Fetcher = Arc::new(move |mode| {
            let up = upc.clone();
            let mut r = req.clone();
            r.mode = mode;
            Box::pin(async move { up.fetch(&r).await })
        });
        self.cache
            .get(&key, fetcher, ttl, spec.expect, spec.bypass)
            .await
    }

    /// [`Core::served`] converted to a browser-safe [`Reply`].
    pub async fn reply(&self, up: &Arc<Upstream>, spec: &GetSpec<'_>) -> Result<Reply, ApiError> {
        let served = self.served(up, spec).await?;
        Ok(Reply::from_served(served, spec.expect, spec.force_text).await)
    }

    /// Convenience: GET from the RM.
    pub async fn rm_reply(&self, spec: &GetSpec<'_>) -> Result<Reply, ApiError> {
        self.reply(&self.rm, spec).await
    }
}

/// Header names as `HeaderName` constants used by routes.
pub fn header(name: &'static str) -> HeaderName {
    HeaderName::from_static(name)
}

/// How long the RM's node list is reused as the NodeManager allow-set ([`Core::node_authorities`]).
const NODE_SET_TTL: Duration = Duration::from_secs(10);

#[derive(serde::Deserialize)]
struct NodesDoc {
    nodes: Option<NodesList>,
}

#[derive(serde::Deserialize)]
struct NodesList {
    node: Option<Vec<NodeEntry>>,
}

#[derive(serde::Deserialize)]
struct NodeEntry {
    id: Option<String>,
    #[serde(rename = "nodeHTTPAddress")]
    http: Option<String>,
}

impl Core {
    /// The authoritative set of NodeManager authorities (`host:port`, lowercased) the browser is allowed
    /// to address, read from the RM's own node list. This is the NodeManager SSRF guard's only source of
    /// truth: an authority absent from it is never contacted. Cached by body ETag, so after the RM list
    /// changes only the first request re-parses.
    pub async fn node_authorities(
        &self,
    ) -> Result<Arc<std::collections::HashSet<String>>, ApiError> {
        let spec = GetSpec::new(
            "/ws/v1/cluster/nodes",
            TtlPolicy::Fixed(NODE_SET_TTL),
            Expect::Json,
        );
        let (body, etag) = match self.served(&self.rm, &spec).await? {
            Served::Entry { entry, .. } if entry.status.is_success() => {
                (entry.body.clone(), entry.etag.clone())
            }
            Served::Entry { entry, .. } => {
                return Err(ApiError::upstream_status(
                    entry.status,
                    entry.url.clone(),
                    entry.status.as_u16(),
                    "cannot read the ResourceManager node list, so no NodeManager can be authorised",
                )
                .with_hint("the node list is the SSRF guard's allow-set; fix the ResourceManager first"));
            }
            Served::Stream { .. } => {
                return Err(ApiError::internal(
                    "the ResourceManager node list was too large to parse",
                ));
            }
        };
        let cached = self.node_set.lock();
        if let Some((cached_etag, set)) = cached.as_ref()
            && *cached_etag == etag
        {
            return Ok(set.clone());
        }
        let set = Arc::new(parse_node_authorities(&body));
        drop(cached);
        *self.node_set.lock() = Some((etag, set.clone()));
        Ok(set)
    }
}

fn parse_node_authorities(body: &[u8]) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let Ok(doc) = serde_json::from_slice::<NodesDoc>(body) else {
        return set;
    };
    for node in doc.nodes.and_then(|l| l.node).unwrap_or_default() {
        // `nodeHTTPAddress` is the web UI address we may proxy to. `id` (host:RPC-port) is only a
        // fallback for old responses that omit the HTTP address — never a second allowed port.
        for authority in [node.http, node.id].into_iter().flatten() {
            let authority = authority.trim().to_ascii_lowercase();
            if !authority.is_empty() {
                set.insert(authority);
                break;
            }
        }
    }
    set
}
