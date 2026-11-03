//! Single-flight TTL cache with stale-while-revalidate-on-error.
//!
//! * **Key** = `(upstream id, path, canonical query)`; the canonical query sorts parameter *names* only
//!   (stable, values untouched). Upstream requests still carry the caller's query verbatim.
//! * **Single flight**: concurrent misses for one key share exactly one upstream fetch. The fetch runs in
//!   its own task, so a caller disconnecting never cancels it, and the entry is inserted into the cache
//!   *before* the in-flight record is removed (a late caller either sees the entry or joins the flight).
//! * **TTL** is decided per entry ([`TtlPolicy`]); terminal-state app details live longer than running ones.
//! * **SWR on error**: if a refresh fails (transport error or 5xx) and an entry younger than
//!   `max_stale` exists, it is served as `stale`. Entries never outlive `max_stale` in the store.
//! * **Memory bound**: the store is byte-weighted (moka); bodies above `max_body_bytes` are never
//!   buffered into it — the first caller streams them through, and the key is remembered as oversized.
//! * Only 2xx responses are cached. 4xx/5xx are shared with callers already waiting on the flight and
//!   then forgotten.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use http::StatusCode;
use http::header::{HeaderMap, HeaderValue};
use parking_lot::Mutex;
use serde::Deserialize;
use xxhash_rust::xxh3::xxh3_128;

use crate::config::CacheConfig;
use crate::error::ApiError;
use crate::html::looks_like_html;
use crate::http::{BodyMode, UpBody, UpResp};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TtlPolicy {
    /// Not cacheable and not coalesced; the body is streamed straight through.
    None,
    Fixed(Duration),
    /// Application detail: `live` while the app can still change, `terminal` once FINISHED/FAILED/KILLED.
    AppState {
        live: Duration,
        terminal: Duration,
    },
}

/// What the route promises the upstream returns (drives HTML-masquerading-as-JSON detection).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    Json,
    Text,
    Xml,
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheSource {
    Hit,
    Miss,
    Stale,
    Coalesced,
    Bypass,
}

impl CacheSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hit => "hit",
            Self::Miss => "miss",
            Self::Stale => "stale",
            Self::Coalesced => "coalesced",
            Self::Bypass => "bypass",
        }
    }
}

#[derive(Debug)]
pub struct Entry {
    pub status: StatusCode,
    pub content_type: Option<HeaderValue>,
    pub extra: HeaderMap,
    pub body: Bytes,
    pub etag: String,
    pub fetched_at: Instant,
    pub ttl: Duration,
    pub served_by: Arc<str>,
    pub url: String,
}

impl Entry {
    pub fn age(&self) -> Duration {
        self.fetched_at.elapsed()
    }

    fn fresh(&self) -> bool {
        self.age() < self.ttl
    }
}

pub enum Served {
    Entry {
        entry: Arc<Entry>,
        source: CacheSource,
    },
    /// Boxed: an `UpResp` is far bigger than an `Arc<Entry>`, and this value is moved once per request.
    Stream {
        up: Box<UpResp>,
        source: CacheSource,
    },
}

pub type Fetcher =
    Arc<dyn Fn(BodyMode) -> BoxFuture<'static, Result<UpResp, ApiError>> + Send + Sync>;

#[derive(Default)]
pub struct Stats {
    pub hits: AtomicU64,
    pub misses: AtomicU64,
    pub coalesced: AtomicU64,
    pub stale: AtomicU64,
    pub bypass: AtomicU64,
    pub upstream_fetches: AtomicU64,
}

#[derive(Clone)]
enum FlightOut {
    Entry(Arc<Entry>),
    Streamed(Arc<StreamSlot>),
    Err(Arc<ApiError>),
}

struct StreamSlot {
    up: Mutex<Option<UpResp>>,
}

type Flight = Shared<BoxFuture<'static, FlightOut>>;

struct Inner {
    cfg: CacheConfig,
    entries: moka::sync::Cache<Arc<str>, Arc<Entry>>,
    oversize: moka::sync::Cache<Arc<str>, ()>,
    inflight: Mutex<HashMap<Arc<str>, Flight>>,
    stats: Stats,
}

#[derive(Clone)]
pub struct Cache {
    inner: Arc<Inner>,
}

struct FlightGuard {
    inner: Arc<Inner>,
    key: Arc<str>,
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        self.inner.inflight.lock().remove(&self.key);
    }
}

/// Canonical query: split on `&`, drop empty parts, stable-sort by parameter *name*, re-join.
pub fn canonical_query(q: &str) -> String {
    let mut parts: Vec<&str> = q.split('&').filter(|p| !p.is_empty()).collect();
    parts.sort_by(|a, b| {
        let na = a.split_once('=').map_or(*a, |(n, _)| n);
        let nb = b.split_once('=').map_or(*b, |(n, _)| n);
        na.cmp(nb)
    });
    parts.join("&")
}

pub fn cache_key(upstream: &str, path: &str, query: Option<&str>) -> String {
    match query.map(canonical_query).filter(|q| !q.is_empty()) {
        Some(q) => format!("{upstream}\n{path}?{q}"),
        None => format!("{upstream}\n{path}"),
    }
}

/// Weak ETag from a 128-bit xxh3 of the body.
pub fn weak_etag(body: &[u8]) -> String {
    format!("W/\"{:032x}\"", xxh3_128(body))
}

/// RFC 9110 weak comparison of `If-None-Match` against our ETag.
pub fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    let strip = |s: &str| s.trim().trim_start_matches("W/").to_string();
    let ours = strip(etag);
    if_none_match
        .split(',')
        .map(str::trim)
        .any(|t| t == "*" || strip(t) == ours)
}

#[derive(Deserialize)]
struct AppProbe {
    app: Option<AppState>,
}

#[derive(Deserialize)]
struct AppState {
    state: Option<String>,
}

fn is_terminal_app(body: &[u8]) -> bool {
    serde_json::from_slice::<AppProbe>(body)
        .ok()
        .and_then(|p| p.app)
        .and_then(|a| a.state)
        .is_some_and(|s| matches!(s.as_str(), "FINISHED" | "FAILED" | "KILLED"))
}

impl Cache {
    pub fn new(cfg: CacheConfig) -> Self {
        let entries = moka::sync::Cache::builder()
            .max_capacity(cfg.max_bytes)
            .weigher(|_k: &Arc<str>, v: &Arc<Entry>| {
                (v.body.len() + 512).min(u32::MAX as usize) as u32
            })
            .time_to_live(cfg.max_stale)
            .build();
        let oversize = moka::sync::Cache::builder()
            .max_capacity(4096)
            .time_to_live(Duration::from_secs(60))
            .build();
        Self {
            inner: Arc::new(Inner {
                cfg,
                entries,
                oversize,
                inflight: Mutex::new(HashMap::new()),
                stats: Stats::default(),
            }),
        }
    }

    pub fn stats(&self) -> &Stats {
        &self.inner.stats
    }

    pub fn config(&self) -> &CacheConfig {
        &self.inner.cfg
    }

    /// Number of entries and weighted bytes currently stored (approximate; moka is eventually consistent).
    pub fn usage(&self) -> (u64, u64) {
        self.inner.entries.run_pending_tasks();
        (
            self.inner.entries.entry_count(),
            self.inner.entries.weighted_size(),
        )
    }

    fn ttl_for(&self, policy: TtlPolicy, body: &[u8]) -> Duration {
        let scale = self.inner.cfg.ttl_scale;
        match policy {
            TtlPolicy::None => Duration::ZERO,
            TtlPolicy::Fixed(d) => d.mul_f64(scale),
            TtlPolicy::AppState { live, terminal } => {
                if is_terminal_app(body) {
                    terminal.mul_f64(scale)
                } else {
                    live.mul_f64(scale)
                }
            }
        }
    }

    /// Fetch `key` through the cache.
    pub async fn get(
        &self,
        key: &str,
        fetch: Fetcher,
        policy: TtlPolicy,
        expect: Expect,
        bypass: bool,
    ) -> Result<Served, ApiError> {
        self.get_inner(key, fetch, policy, expect, bypass, true)
            .await
    }

    #[cfg(test)]
    async fn get_after_initial_miss(
        &self,
        key: &str,
        fetch: Fetcher,
        policy: TtlPolicy,
        expect: Expect,
        bypass: bool,
    ) -> Result<Served, ApiError> {
        self.get_inner(key, fetch, policy, expect, bypass, false)
            .await
    }

    async fn get_inner(
        &self,
        key: &str,
        fetch: Fetcher,
        policy: TtlPolicy,
        expect: Expect,
        bypass: bool,
        check_fresh_first: bool,
    ) -> Result<Served, ApiError> {
        let inner = &self.inner;
        let stats = &inner.stats;
        let direct_source = if bypass {
            CacheSource::Bypass
        } else {
            CacheSource::Miss
        };

        if policy == TtlPolicy::None {
            stats.upstream_fetches.fetch_add(1, Ordering::Relaxed);
            let up = fetch(BodyMode::Stream).await?;
            return Ok(Served::Stream {
                up: Box::new(up),
                source: direct_source,
            });
        }

        let key: Arc<str> = key.into();
        if inner.oversize.contains_key(&key) {
            stats.upstream_fetches.fetch_add(1, Ordering::Relaxed);
            let up = fetch(BodyMode::Stream).await?;
            return Ok(Served::Stream {
                up: Box::new(up),
                source: direct_source,
            });
        }

        let cached = inner.entries.get(&key);
        if check_fresh_first
            && !bypass
            && let Some(e) = &cached
            && e.fresh()
        {
            stats.hits.fetch_add(1, Ordering::Relaxed);
            return Ok(Served::Entry {
                entry: e.clone(),
                source: CacheSource::Hit,
            });
        }

        let (flight, leader) =
            match self.flight_or_hit(key.clone(), fetch.clone(), policy, expect, bypass) {
                Ok(flight) => flight,
                Err(hit) => return Ok(hit),
            };

        let source = match (bypass, leader) {
            (true, _) => CacheSource::Bypass,
            (false, true) => CacheSource::Miss,
            (false, false) => CacheSource::Coalesced,
        };
        match source {
            CacheSource::Bypass => stats.bypass.fetch_add(1, Ordering::Relaxed),
            CacheSource::Miss => stats.misses.fetch_add(1, Ordering::Relaxed),
            _ => stats.coalesced.fetch_add(1, Ordering::Relaxed),
        };

        let stale = |cached: &Option<Arc<Entry>>| -> Option<Arc<Entry>> {
            if bypass {
                return None;
            }
            cached
                .as_ref()
                .filter(|e| e.age() <= inner.cfg.max_stale)
                .cloned()
        };

        match flight.await {
            FlightOut::Entry(e) => {
                if e.status.is_server_error()
                    && let Some(s) = stale(&cached)
                {
                    stats.stale.fetch_add(1, Ordering::Relaxed);
                    return Ok(Served::Entry {
                        entry: s,
                        source: CacheSource::Stale,
                    });
                }
                Ok(Served::Entry { entry: e, source })
            }
            FlightOut::Err(err) => {
                if let Some(s) = stale(&cached) {
                    stats.stale.fetch_add(1, Ordering::Relaxed);
                    return Ok(Served::Entry {
                        entry: s,
                        source: CacheSource::Stale,
                    });
                }
                Err((*err).clone())
            }
            FlightOut::Streamed(slot) => {
                let taken = slot.up.lock().take();
                let up = match taken {
                    Some(up) => up,
                    None => {
                        stats.upstream_fetches.fetch_add(1, Ordering::Relaxed);
                        fetch(BodyMode::Stream).await?
                    }
                };
                Ok(Served::Stream {
                    up: Box::new(up),
                    source,
                })
            }
        }
    }

    fn fresh_hit(&self, key: &str, bypass: bool) -> Option<Served> {
        if !bypass
            && let Some(entry) = self.inner.entries.get(key)
            && entry.fresh()
        {
            self.inner.stats.hits.fetch_add(1, Ordering::Relaxed);
            Some(Served::Entry {
                entry,
                source: CacheSource::Hit,
            })
        } else {
            None
        }
    }

    fn flight_or_hit(
        &self,
        key: Arc<str>,
        fetch: Fetcher,
        policy: TtlPolicy,
        expect: Expect,
        bypass: bool,
    ) -> Result<(Flight, bool), Served> {
        let mut map = self.inner.inflight.lock();
        if let Some(flight) = map.get(&key) {
            return Ok((flight.clone(), false));
        }
        // The entry is stored before the flight record is removed, so re-checking while holding the
        // map lock closes the window between our first look and now.
        if let Some(hit) = self.fresh_hit(&key, bypass) {
            return Err(hit);
        }
        let flight = self.spawn_flight(key.clone(), fetch, policy, expect);
        map.insert(key, flight.clone());
        Ok((flight, true))
    }

    fn spawn_flight(
        &self,
        key: Arc<str>,
        fetch: Fetcher,
        policy: TtlPolicy,
        expect: Expect,
    ) -> Flight {
        let this = self.clone();
        let handle = tokio::spawn(async move {
            let inner = this.inner.clone();
            let _guard = FlightGuard {
                inner: inner.clone(),
                key: key.clone(),
            };
            inner.stats.upstream_fetches.fetch_add(1, Ordering::Relaxed);
            let cap = inner.cfg.max_body_bytes;
            match fetch(BodyMode::Buffer { cap }).await {
                Err(e) => FlightOut::Err(Arc::new(e)),
                Ok(UpResp {
                    status,
                    content_type,
                    extra,
                    body,
                    served_by,
                    url,
                }) => match body {
                    UpBody::Stream { prefix, rest } => {
                        inner.oversize.insert(key.clone(), ());
                        FlightOut::Streamed(Arc::new(StreamSlot {
                            up: Mutex::new(Some(UpResp {
                                status,
                                content_type,
                                extra,
                                body: UpBody::Stream { prefix, rest },
                                served_by,
                                url,
                            })),
                        }))
                    }
                    UpBody::Full(body) => {
                        if status.is_success()
                            && expect == Expect::Json
                            && looks_like_html(content_type.as_ref(), &body)
                        {
                            return FlightOut::Err(Arc::new(
                                ApiError::upstream_status(
                                    StatusCode::BAD_GATEWAY,
                                    url,
                                    status.as_u16(),
                                    "expected JSON but the upstream returned an HTML page",
                                )
                                .with_hint(
                                    "a login page or proxy error page is in the way; check --user/--header/--token or the upstream URL",
                                ),
                            ));
                        }
                        let ttl = if status.is_success() {
                            this.ttl_for(policy, &body)
                        } else {
                            Duration::ZERO
                        };
                        let entry = Arc::new(Entry {
                            status,
                            content_type,
                            extra,
                            etag: weak_etag(&body),
                            body,
                            fetched_at: Instant::now(),
                            ttl,
                            served_by,
                            url,
                        });
                        if !ttl.is_zero() {
                            inner.entries.insert(key.clone(), entry.clone());
                        }
                        FlightOut::Entry(entry)
                    }
                },
            }
        });
        async move {
            match handle.await {
                Ok(o) => o,
                Err(e) => FlightOut::Err(Arc::new(ApiError::internal(format!(
                    "upstream fetch task failed: {e}"
                )))),
            }
        }
        .boxed()
        .shared()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use std::sync::atomic::AtomicUsize;

    fn response(status: StatusCode, body: UpBody) -> UpResp {
        UpResp {
            status,
            content_type: None,
            extra: HeaderMap::new(),
            body,
            served_by: Arc::from("rm.example:8088"),
            url: "http://rm.example:8088/test".into(),
        }
    }

    fn full_fetcher(status: StatusCode, bytes: &'static [u8]) -> Fetcher {
        Arc::new(move |_| {
            let up = response(status, UpBody::Full(Bytes::from_static(bytes)));
            async move { Ok(up) }.boxed()
        })
    }

    fn stream_fetcher(calls: Arc<AtomicUsize>) -> Fetcher {
        Arc::new(move |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            let up = response(
                StatusCode::OK,
                UpBody::Stream {
                    prefix: Bytes::from_static(b"prefix"),
                    rest: futures_util::stream::empty().boxed(),
                },
            );
            async move { Ok(up) }.boxed()
        })
    }

    #[test]
    fn canonical_query_sorts_names_only() {
        assert_eq!(canonical_query("b=2&a=1"), "a=1&b=2");
        assert_eq!(
            canonical_query("states=RUNNING,ACCEPTED&limit=5"),
            "limit=5&states=RUNNING,ACCEPTED"
        );
        // values untouched, same-name params keep their relative order
        assert_eq!(canonical_query("z=B&a=Y&z=A"), "a=Y&z=B&z=A");
        assert_eq!(canonical_query("&&a=1&"), "a=1");
        assert_eq!(canonical_query("flag&a=1"), "a=1&flag");
        assert_eq!(canonical_query(""), "");
    }

    #[test]
    fn key_shape() {
        assert_eq!(cache_key("rm", "/p", None), "rm\n/p");
        assert_eq!(cache_key("rm", "/p", Some("")), "rm\n/p");
        assert_eq!(cache_key("rm", "/p", Some("b=1&a=2")), "rm\n/p?a=2&b=1");
    }

    #[test]
    fn etag_compare() {
        let e = weak_etag(b"hello");
        assert!(e.starts_with("W/\""));
        assert!(etag_matches(&e, &e));
        assert!(etag_matches(&format!("\"x\", {e}"), &e));
        assert!(etag_matches("*", &e));
        assert!(etag_matches(&e.replace("W/", ""), &e));
        assert!(!etag_matches("W/\"nope\"", &e));
        assert_ne!(weak_etag(b"a"), weak_etag(b"b"));
    }

    #[test]
    fn terminal_state_detection() {
        assert!(is_terminal_app(br#"{"app":{"id":"x","state":"FINISHED"}}"#));
        assert!(is_terminal_app(br#"{"app":{"state":"KILLED"}}"#));
        assert!(!is_terminal_app(br#"{"app":{"state":"RUNNING"}}"#));
        assert!(!is_terminal_app(b"not json"));
    }

    #[tokio::test]
    async fn ttl_fresh_hit_and_stale_refresh_paths_are_accounted_for() {
        let cfg = CacheConfig {
            ttl_scale: 0.5,
            ..CacheConfig::default()
        };
        let cache = Cache::new(cfg);
        assert_eq!(cache.config().ttl_scale, 0.5);
        assert_eq!(cache.ttl_for(TtlPolicy::None, b""), Duration::ZERO);
        assert_eq!(
            cache.ttl_for(TtlPolicy::Fixed(Duration::from_secs(4)), b""),
            Duration::from_secs(2)
        );
        let app_ttl = TtlPolicy::AppState {
            live: Duration::from_secs(2),
            terminal: Duration::from_secs(10),
        };
        assert_eq!(
            cache.ttl_for(app_ttl, br#"{"app":{"state":"RUNNING"}}"#),
            Duration::from_secs(1)
        );
        assert_eq!(
            cache.ttl_for(app_ttl, br#"{"app":{"state":"FINISHED"}}"#),
            Duration::from_secs(5)
        );

        let first = cache
            .get(
                "fresh",
                full_fetcher(StatusCode::OK, b"fresh"),
                TtlPolicy::Fixed(Duration::from_secs(60)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            first,
            Served::Entry {
                source: CacheSource::Miss,
                ..
            }
        ));
        let hit = cache
            .get(
                "fresh",
                full_fetcher(StatusCode::OK, b"unused"),
                TtlPolicy::Fixed(Duration::from_secs(60)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            hit,
            Served::Entry {
                source: CacheSource::Hit,
                ..
            }
        ));
        let rechecked = cache
            .get_after_initial_miss(
                "fresh",
                full_fetcher(StatusCode::OK, b"unused"),
                TtlPolicy::Fixed(Duration::from_secs(60)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            rechecked,
            Served::Entry {
                source: CacheSource::Hit,
                ..
            }
        ));

        let stale_key = "stale";
        cache
            .get(
                stale_key,
                full_fetcher(StatusCode::OK, b"cached"),
                TtlPolicy::Fixed(Duration::from_millis(1)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        let stale = cache
            .get(
                stale_key,
                full_fetcher(StatusCode::SERVICE_UNAVAILABLE, b"down"),
                TtlPolicy::Fixed(Duration::from_millis(1)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            stale,
            Served::Entry {
                source: CacheSource::Stale,
                ..
            }
        ));
        assert_eq!(cache.stats().hits.load(Ordering::Relaxed), 2);
        assert_eq!(cache.stats().stale.load(Ordering::Relaxed), 1);
        assert!(cache.usage().0 >= 1);

        assert!(matches!(
            cache.fresh_hit("fresh", false),
            Some(Served::Entry { .. })
        ));
        assert!(cache.fresh_hit("fresh", true).is_none());

        cache
            .get(
                "stale-transport-error",
                full_fetcher(StatusCode::OK, b"kept on transport error"),
                TtlPolicy::Fixed(Duration::from_millis(1)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        let failed_fetch: Fetcher = Arc::new(|_| {
            async {
                Err(ApiError::unreachable(
                    "http://rm.example:8088",
                    "connection refused",
                ))
            }
            .boxed()
        });
        let stale = cache
            .get(
                "stale-transport-error",
                failed_fetch,
                TtlPolicy::Fixed(Duration::from_millis(1)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            stale,
            Served::Entry {
                source: CacheSource::Stale,
                ..
            }
        ));
        assert_eq!(cache.stats().stale.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn concurrent_stream_waiters_refetch_after_the_first_takes_the_stream() {
        let cache = Cache::new(CacheConfig::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let fetch: Fetcher = {
            let calls = calls.clone();
            Arc::new(move |_| {
                calls.fetch_add(1, Ordering::Relaxed);
                async {
                    tokio::task::yield_now().await;
                    Ok(response(
                        StatusCode::OK,
                        UpBody::Stream {
                            prefix: Bytes::from_static(b"large"),
                            rest: futures_util::stream::empty().boxed(),
                        },
                    ))
                }
                .boxed()
            })
        };
        let policy = TtlPolicy::Fixed(Duration::from_secs(30));
        let (first, second) = tokio::join!(
            cache.get("shared-stream", fetch.clone(), policy, Expect::Any, false),
            cache.get("shared-stream", fetch, policy, Expect::Any, false),
        );
        assert!(matches!(first.unwrap(), Served::Stream { .. }));
        assert!(matches!(second.unwrap(), Served::Stream { .. }));
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn a_panicking_fetch_task_is_returned_as_an_internal_error() {
        let cache = Cache::new(CacheConfig::default());
        let panic_fetch: Fetcher = Arc::new(|_| async { panic!("simulated task failure") }.boxed());
        let error = cache
            .get(
                "panicking-fetch",
                panic_fetch,
                TtlPolicy::Fixed(Duration::from_secs(1)),
                Expect::Any,
                false,
            )
            .await
            .err()
            .expect("a failed spawned fetch is returned to its caller");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.message.contains("upstream fetch task failed"));
    }

    #[tokio::test]
    async fn uncached_oversize_and_html_as_json_use_stream_and_error_paths() {
        let cache = Cache::new(CacheConfig::default());
        let none = cache
            .get(
                "none",
                full_fetcher(StatusCode::OK, b"direct"),
                TtlPolicy::None,
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            none,
            Served::Stream {
                source: CacheSource::Miss,
                ..
            }
        ));

        let calls = Arc::new(AtomicUsize::new(0));
        let fetch = stream_fetcher(calls.clone());
        let first = cache
            .get(
                "large",
                fetch.clone(),
                TtlPolicy::Fixed(Duration::from_secs(30)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            first,
            Served::Stream {
                source: CacheSource::Miss,
                ..
            }
        ));
        let second = cache
            .get(
                "large",
                fetch,
                TtlPolicy::Fixed(Duration::from_secs(30)),
                Expect::Any,
                false,
            )
            .await
            .unwrap();
        assert!(matches!(
            second,
            Served::Stream {
                source: CacheSource::Miss,
                ..
            }
        ));
        assert_eq!(calls.load(Ordering::Relaxed), 2);

        let html = cache
            .get(
                "html-json",
                full_fetcher(StatusCode::OK, b"<html><title>login</title></html>"),
                TtlPolicy::Fixed(Duration::from_secs(30)),
                Expect::Json,
                false,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(html.status, StatusCode::BAD_GATEWAY);
        assert!(html.message.contains("expected JSON"));
    }
}
