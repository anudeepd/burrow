//! The SSE hub behind `GET /api/events` (contract §6) — push invalidation, pull data.
//!
//! A **topic** is an API resource path without `/api/`, including its canonical query
//! (`yarn/apps?states=RUNNING`). The hub polls a topic **only while at least one subscriber exists**, at the
//! interval its [`crate::topics::TopicRegistry`] class assigns, and emits `invalidate` only when the body
//! hash changes. Polling goes through [`crate::api::dispatch`], so a hub poll and a browser GET for the same
//! resource share the same cache key and single flight: they never double-fetch.
//!
//! Wire format (contract §6):
//!
//! ```text
//! event: hello       data: {"serverTime":1767…,"topics":["…"]}
//! event: invalidate  data: {"topic":"yarn/metrics","etag":"W/\"…\"","at":1767…}
//! : heartbeat                                            (comment line every 15 s)
//! ```
//!
//! Limits: at most [`MAX_TOPICS_PER_CONNECTION`] topics per connection and [`MAX_TOPICS`] distinct topics
//! process-wide. Unknown topic classes are rejected up front (a topic that no class matches would otherwise
//! let a client drive arbitrary upstream load). Subscriptions are reference-counted: when the last subscriber
//! of a topic goes away, its next poll is its last.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::api::{self, ApiRequest};
use crate::cache::{canonical_query, weak_etag};
use crate::core::Core;
use crate::error::ApiError;
use crate::reply::{Reply, ReplyBody};

/// Contract §6: at most 64 topics per connection.
pub const MAX_TOPICS_PER_CONNECTION: usize = 64;
/// Process-wide cap on distinct polled topics (beyond this, new topics are refused rather than amplified).
pub const MAX_TOPICS: usize = 256;
/// Contract §6: a comment heartbeat every 15 s.
pub const HEARTBEAT: Duration = Duration::from_secs(15);
/// How often the poller wakes to look for topics that are due.
const TICK: Duration = Duration::from_millis(250);
/// How many topics may be polled concurrently.
const POLL_CONCURRENCY: usize = 8;
/// Per-topic broadcast buffer; invalidations are idempotent, so a slow client may drop some.
const EVENTS_BUF: usize = 32;
/// Per-connection frame buffer.
const FRAMES_BUF: usize = 64;
/// How much of a streamed reply body to hash before giving up on change detection.
const BODY_HASH_CAP: usize = 4 * 1024 * 1024;

/// One validated topic: `path[?canonicalQuery]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Topic {
    /// Canonical form, used as the subscription identity and echoed in events.
    pub raw: String,
    pub path: String,
    pub query: Option<String>,
}

/// Parse and validate a topic from the `?topics=` list.
pub fn parse_topic(raw: &str) -> Result<Topic, ApiError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(ApiError::bad_request("empty topic"));
    }
    let (path, query) = match raw.split_once('?') {
        Some((p, q)) => (p, Some(canonical_query(q))),
        None => (raw, None),
    };
    if path.is_empty() || path.starts_with('/') || path == "api" || path.starts_with("api/") {
        return Err(ApiError::bad_request(format!(
            "topic '{raw}' must be an API resource path without the /api/ prefix"
        )));
    }
    if path
        .split('/')
        .any(|s| !s.is_empty() && s.bytes().all(|b| b == b'.'))
    {
        return Err(ApiError::bad_request(format!(
            "topic '{raw}' is not a valid path"
        )));
    }
    let query = query.filter(|q| !q.is_empty());
    let raw = match &query {
        Some(q) => format!("{path}?{q}"),
        None => path.to_string(),
    };
    Ok(Topic {
        raw,
        path: path.to_string(),
        query,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct Invalidate {
    pub topic: String,
    pub etag: String,
    pub at: u64,
}

#[derive(Debug, Clone)]
pub enum HubEvent {
    Invalidate(Invalidate),
}

/// `event: X\ndata: Y\n\n` (contract §6 frame format; `Y` is JSON, so it never contains a raw newline).
pub fn sse_frame(event: &str, data: &str) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct TopicState {
    topic: Topic,
    interval: Duration,
    subscribers: AtomicUsize,
    senders: Mutex<Vec<mpsc::Sender<HubEvent>>>,
    last_etag: Mutex<Option<String>>,
    last_poll: Mutex<Instant>,
}

impl TopicState {
    fn new(topic: Topic, interval: Duration) -> Self {
        let now = Instant::now();
        Self {
            topic,
            interval,
            subscribers: AtomicUsize::new(0),
            senders: Mutex::new(Vec::new()),
            last_etag: Mutex::new(None),
            // Immediately due, so a fresh subscription gets a baseline on the next tick.
            last_poll: Mutex::new(now.checked_sub(interval).unwrap_or(now)),
        }
    }

    fn due(&self) -> bool {
        self.last_poll.lock().elapsed() >= self.interval
    }

    fn broadcast(&self, event: HubEvent) {
        let mut senders = self.senders.lock();
        senders.retain(|s| match s.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => true, // slow client: drop this invalidation
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }
}

/// Removes one subscriber from a topic when the connection ends.
struct SubGuard {
    state: Arc<TopicState>,
    sender: mpsc::Sender<HubEvent>,
}

impl Drop for SubGuard {
    fn drop(&mut self) {
        self.state.subscribers.fetch_sub(1, Ordering::Relaxed);
        self.state
            .senders
            .lock()
            .retain(|s| !s.same_channel(&self.sender));
    }
}

#[derive(Default)]
struct HubInner {
    topics: Mutex<HashMap<String, Arc<TopicState>>>,
    poller_started: AtomicBool,
    heartbeat: Mutex<Option<Duration>>,
}

/// The hub: one per [`Core`].
#[derive(Clone, Default)]
pub struct Hub {
    inner: Arc<HubInner>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Heartbeat override (tests use a short one so the timing can be observed).
    pub fn set_heartbeat(&self, every: Duration) {
        *self.inner.heartbeat.lock() = Some(every);
    }

    fn heartbeat(&self) -> Duration {
        self.inner.heartbeat.lock().unwrap_or(HEARTBEAT)
    }

    /// Distinct topics known to the hub (subscribed at least once).
    pub fn topic_count(&self) -> usize {
        self.inner.topics.lock().len()
    }

    /// Subscribers currently attached, across all topics.
    pub fn subscriber_count(&self) -> usize {
        self.inner
            .topics
            .lock()
            .values()
            .map(|t| t.subscribers.load(Ordering::Relaxed))
            .sum()
    }

    /// Subscribe `topics` and return the SSE frame stream for one connection.
    pub fn subscribe(&self, core: &Arc<Core>, topics: &[Topic]) -> Result<Subscription, ApiError> {
        if topics.is_empty() {
            return Err(ApiError::bad_request("at least one topic is required"));
        }
        if topics.len() > MAX_TOPICS_PER_CONNECTION {
            return Err(ApiError::bad_request(format!(
                "at most {MAX_TOPICS_PER_CONNECTION} topics per connection (got {})",
                topics.len()
            )));
        }

        // Validate every topic *before* touching the registry, so a rejected request cannot leave
        // subscriber-less topics behind consuming the process-wide cap.
        let mut unique: Vec<(Topic, Duration)> = Vec::new();
        for t in topics {
            if unique.iter().any(|(u, _)| u.raw == t.raw) {
                continue;
            }
            /* The class list is *tuning* (longest prefix wins); a topic the SPA can actually fetch is pollable even
            when the list does not name it, because the interval comes from the same route table `dispatch` uses.
            Keeping this a hand-copied list is what made `yarn/info` — the overview page's topic — answer 400. */
            let Some(interval) = core
                .topics
                .interval_for(&t.raw)
                .or_else(|| crate::routes::topic_interval(&t.path))
            else {
                return Err(ApiError::bad_request(format!(
                    "'{}' is not an API resource this server polls",
                    t.raw
                ))
                .with_hint(
                    "topics are API resource paths without /api/, e.g. yarn/metrics, \
                     yarn/apps?states=RUNNING, yarn/nodes, spark/<appId>/jobs",
                ));
            };
            unique.push((t.clone(), interval));
        }

        let mut states: Vec<Arc<TopicState>> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        {
            let mut map = self.inner.topics.lock();
            let fresh = unique
                .iter()
                .filter(|(t, _)| !map.contains_key(&t.raw))
                .count();
            if map.len() + fresh > MAX_TOPICS {
                return Err(ApiError::unavailable(format!(
                    "the events hub is already polling its maximum of {MAX_TOPICS} topics"
                )));
            }
            for (t, interval) in unique {
                let st = map
                    .entry(t.raw.clone())
                    .or_insert_with(|| Arc::new(TopicState::new(t.clone(), interval)))
                    .clone();
                names.push(t.raw);
                states.push(st);
            }
        }

        let (ev_tx, ev_rx) = mpsc::channel(EVENTS_BUF);
        let mut guards = Vec::with_capacity(states.len());
        for st in states {
            st.subscribers.fetch_add(1, Ordering::Relaxed);
            st.senders.lock().push(ev_tx.clone());
            guards.push(SubGuard {
                state: st,
                sender: ev_tx.clone(),
            });
        }

        self.ensure_poller(core);

        let (out_tx, out_rx) = mpsc::channel(FRAMES_BUF);
        let heartbeat = self.heartbeat();
        tokio::spawn(async move {
            let _guards = guards;
            let hello = serde_json::json!({ "serverTime": now_ms(), "topics": names });
            if out_tx
                .send(sse_frame("hello", &hello.to_string()))
                .await
                .is_err()
            {
                return;
            }
            let mut hb = tokio::time::interval(heartbeat);
            hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            hb.tick().await; // the first tick is immediate
            let mut ev_rx = ev_rx;
            loop {
                tokio::select! {
                    _ = out_tx.closed() => break,
                    _ = hb.tick() => {
                        if out_tx.send(Bytes::from_static(b": heartbeat\n\n")).await.is_err() {
                            break;
                        }
                    }
                    ev = ev_rx.recv() => match ev {
                        Some(HubEvent::Invalidate(inv)) => {
                            let data = serde_json::to_string(&inv).unwrap_or_else(|_| "{}".to_string());
                            if out_tx.send(sse_frame("invalidate", &data)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    },
                }
            }
        });
        Ok(Subscription { rx: out_rx })
    }

    fn ensure_poller(&self, core: &Arc<Core>) {
        if self.inner.poller_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak: Weak<Core> = Arc::downgrade(core);
        let inner = self.inner.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(TICK).await;
                let Some(core) = weak.upgrade() else {
                    break;
                };
                let due: Vec<Arc<TopicState>> = {
                    let map = inner.topics.lock();
                    map.values()
                        .filter(|t| t.subscribers.load(Ordering::Relaxed) > 0 && t.due())
                        .cloned()
                        .collect()
                };
                if due.is_empty() {
                    continue;
                }
                stream::iter(due.into_iter().map(|t| {
                    let core = core.clone();
                    async move { poll_one(&core, &t).await }
                }))
                .buffer_unordered(POLL_CONCURRENCY)
                .for_each(|()| async {})
                .await;
            }
        });
    }
}

/// One poll of one topic: dispatch through the shared cache, hash the body, emit on change.
async fn poll_one(core: &Arc<Core>, state: &Arc<TopicState>) {
    *state.last_poll.lock() = Instant::now();
    let req = ApiRequest {
        path: &state.topic.path,
        query: state.topic.query.as_deref(),
        bypass: false,
        if_none_match: None,
        range: None,
    };
    let Ok(reply) = api::dispatch(core, req).await else {
        return;
    };
    let Some(etag) = reply_hash(reply).await else {
        return; // errors are not invalidations
    };
    let mut last = state.last_etag.lock();
    if last.as_deref() == Some(etag.as_str()) {
        return;
    }
    let first = last.is_none();
    *last = Some(etag.clone());
    drop(last);
    if first {
        return; // the baseline is not a change
    }
    state.broadcast(HubEvent::Invalidate(Invalidate {
        topic: state.topic.raw.clone(),
        etag,
        at: now_ms(),
    }));
}

/// The weak ETag of a 2xx reply: the cache's own ETag when there is one, else a hash of the body.
async fn reply_hash(reply: Reply) -> Option<String> {
    if !reply.status.is_success() {
        return None;
    }
    if let Some(etag) = reply.etag {
        return Some(etag);
    }
    match reply.body {
        ReplyBody::Bytes(b) => Some(weak_etag(&b)),
        ReplyBody::Stream { prefix, rest } => {
            let mut buf = BytesMut::from(&prefix[..]);
            let mut rest = rest;
            while buf.len() < BODY_HASH_CAP {
                match rest.next().await {
                    Some(Ok(c)) => buf.extend_from_slice(&c),
                    _ => break,
                }
            }
            Some(weak_etag(&buf))
        }
    }
}

/// One connection's frame stream. Dropping it (client disconnect) ends the subscription promptly.
pub struct Subscription {
    rx: mpsc::Receiver<Bytes>,
}

impl Subscription {
    pub fn into_stream(self) -> BoxStream<'static, io::Result<Bytes>> {
        stream::unfold(self.rx, |mut rx| async move {
            rx.recv().await.map(|b| (Ok(b), rx))
        })
        .boxed()
    }
}

/// Counters used by tests and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HubStats {
    pub topics: usize,
    pub subscribers: usize,
}

impl Hub {
    pub fn stats(&self) -> HubStats {
        HubStats {
            topics: self.topic_count(),
            subscribers: self.subscriber_count(),
        }
    }
}

/// Monotonic id source for tests that need to name connections.
static CONN_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn next_connection_id() -> u64 {
    CONN_SEQ.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_canonical_and_validated() {
        let t = parse_topic("yarn/apps?states=RUNNING&limit=5").unwrap();
        assert_eq!(t.raw, "yarn/apps?limit=5&states=RUNNING");
        assert_eq!(t.path, "yarn/apps");
        assert_eq!(t.query.as_deref(), Some("limit=5&states=RUNNING"));
        assert_eq!(parse_topic("yarn/metrics").unwrap().raw, "yarn/metrics");
        assert_eq!(parse_topic("yarn/metrics?").unwrap().query, None);
        for bad in ["", "/api/yarn", "api/yarn", "yarn/..", "../x", "yarn/."] {
            assert!(parse_topic(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn frames_are_sse() {
        let f = sse_frame("invalidate", "{\"topic\":\"yarn/metrics\"}");
        assert_eq!(
            std::str::from_utf8(&f).unwrap(),
            "event: invalidate\ndata: {\"topic\":\"yarn/metrics\"}\n\n"
        );
    }
}
