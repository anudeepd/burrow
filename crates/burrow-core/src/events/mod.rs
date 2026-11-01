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
            forward_frames(ev_rx, out_tx, heartbeat).await;
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

async fn forward_frames(
    mut ev_rx: mpsc::Receiver<HubEvent>,
    out_tx: mpsc::Sender<Bytes>,
    heartbeat: Duration,
) {
    let mut hb = tokio::time::interval(heartbeat);
    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    hb.tick().await; // the first tick is immediate
    loop {
        tokio::select! {
            biased;
            ev = ev_rx.recv() => match ev {
                Some(HubEvent::Invalidate(inv)) => {
                    let data = serde_json::to_string(&inv).unwrap_or_else(|_| "{}".to_string());
                    if out_tx.send(sse_frame("invalidate", &data)).await.is_err() { break; }
                }
                None => break,
            },
            _ = hb.tick() => {
                if out_tx.send(Bytes::from_static(b": heartbeat\n\n")).await.is_err() { break; }
            }
            _ = out_tx.closed() => break,
        }
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
    update_topic_from_reply(state, reply).await;
}

async fn update_topic_from_reply(state: &Arc<TopicState>, reply: Reply) {
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

    fn core() -> Arc<Core> {
        Core::new(crate::config::Config::for_rm("http://127.0.0.1:8088").unwrap()).unwrap()
    }

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

    #[test]
    fn topic_state_broadcast_handles_full_and_closed_subscribers() {
        let state = Arc::new(TopicState::new(
            parse_topic("yarn/metrics").unwrap(),
            Duration::from_secs(1),
        ));
        let (tx, mut rx) = mpsc::channel(1);
        state.senders.lock().push(tx.clone());
        let event = HubEvent::Invalidate(Invalidate {
            topic: "yarn/metrics".into(),
            etag: "W/\"1\"".into(),
            at: 1,
        });
        state.broadcast(event.clone());
        state.broadcast(event.clone());
        assert!(rx.try_recv().is_ok());
        assert_eq!(state.senders.lock().len(), 1);
        drop(rx);
        state.broadcast(event);
        assert!(state.senders.lock().is_empty());

        let (tx, _rx) = mpsc::channel(1);
        state.subscribers.store(1, Ordering::Relaxed);
        state.senders.lock().push(tx.clone());
        drop(SubGuard {
            state: state.clone(),
            sender: tx,
        });
        assert_eq!(state.subscribers.load(Ordering::Relaxed), 0);
        assert!(state.senders.lock().is_empty());
        assert!(state.due());
    }

    #[tokio::test]
    async fn subscription_validates_caps_emits_hello_and_heartbeat() {
        let core = core();
        let hub = Hub::new();
        hub.set_heartbeat(Duration::from_millis(2));
        assert_eq!(hub.heartbeat(), Duration::from_millis(2));
        assert_eq!(
            hub.subscribe(&core, &[]).err().unwrap().status,
            http::StatusCode::BAD_REQUEST
        );
        let topic = parse_topic("yarn/metrics").unwrap();
        assert_eq!(
            hub.subscribe(&core, &[parse_topic("unknown/path").unwrap()])
                .err()
                .unwrap()
                .status,
            http::StatusCode::BAD_REQUEST
        );
        assert_eq!(
            hub.subscribe(&core, &vec![topic.clone(); MAX_TOPICS_PER_CONNECTION + 1])
                .err()
                .unwrap()
                .status,
            http::StatusCode::BAD_REQUEST
        );

        let sub = hub.subscribe(&core, &[topic.clone(), topic]).unwrap();
        assert_eq!(
            hub.stats(),
            HubStats {
                topics: 1,
                subscribers: 1
            }
        );
        let mut frames = sub.into_stream();
        let hello = tokio::time::timeout(Duration::from_millis(100), frames.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            std::str::from_utf8(&hello)
                .unwrap()
                .contains("event: hello")
        );
        let heartbeat = tokio::time::timeout(Duration::from_millis(100), frames.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(heartbeat, ": heartbeat\n\n");
        drop(frames);
        tokio::time::timeout(Duration::from_millis(100), async {
            while hub.subscriber_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(hub.subscriber_count(), 0);
        assert!(next_connection_id() < next_connection_id());
    }

    #[test]
    fn subscription_refuses_a_new_topic_after_the_process_wide_cap() {
        let core = core();
        let hub = Hub::new();
        {
            let mut topics = hub.inner.topics.lock();
            for i in 0..MAX_TOPICS {
                let topic = parse_topic(&format!("yarn/metrics?probe={i}")).unwrap();
                topics.insert(
                    topic.raw.clone(),
                    Arc::new(TopicState::new(topic, Duration::from_secs(1))),
                );
            }
        }

        let error = hub
            .subscribe(
                &core,
                &[parse_topic("yarn/metrics?probe=overflow").unwrap()],
            )
            .err()
            .expect("the process-wide cap must reject one more topic");
        assert_eq!(error.status, http::StatusCode::SERVICE_UNAVAILABLE);
        assert!(error.message.contains("maximum of 256 topics"));
        assert_eq!(hub.topic_count(), MAX_TOPICS);
    }

    #[tokio::test]
    async fn polling_healthz_tracks_baselines_changes_and_reply_hashes() {
        let core = core();
        let topic = parse_topic("healthz").unwrap();
        let state = Arc::new(TopicState::new(topic, Duration::from_millis(1)));
        let (tx, mut rx) = mpsc::channel(4);
        state.senders.lock().push(tx);
        poll_one(&core, &state).await;
        assert!(state.last_etag.lock().is_some());
        assert!(rx.try_recv().is_err()); // first response establishes the baseline
        poll_one(&core, &state).await;
        assert!(rx.try_recv().is_err()); // unchanged response is quiet
        *state.last_etag.lock() = Some("old-etag".into());
        poll_one(&core, &state).await;
        assert!(matches!(rx.try_recv(), Ok(HubEvent::Invalidate(_))));

        let failed = Reply::synthesized(http::StatusCode::BAD_GATEWAY, "text/plain", "down");
        assert_eq!(reply_hash(failed).await, None);
        let explicit = Reply {
            status: http::StatusCode::OK,
            content_type: None,
            extra: Default::default(),
            body: ReplyBody::Bytes(Bytes::from_static(b"ignored")),
            cache: None,
            upstream: None,
            age_ms: None,
            etag: Some("W/\"custom\"".into()),
        };
        assert_eq!(reply_hash(explicit).await.as_deref(), Some("W/\"custom\""));
        let streamed = Reply {
            status: http::StatusCode::OK,
            content_type: None,
            extra: Default::default(),
            body: ReplyBody::Stream {
                prefix: Bytes::from_static(b"a"),
                rest: stream::iter([
                    Ok(Bytes::from_static(b"b")),
                    Err(io::Error::other("stream ended")),
                    Ok(Bytes::from_static(b"ignored")),
                ])
                .boxed(),
            },
            cache: None,
            upstream: None,
            age_ms: None,
            etag: None,
        };
        assert_eq!(reply_hash(streamed).await, Some(weak_etag(b"ab")));

        let unknown = Arc::new(TopicState::new(
            Topic {
                raw: "unknown/resource".into(),
                path: "unknown/resource".into(),
                query: None,
            },
            Duration::from_secs(1),
        ));
        poll_one(&core, &unknown).await;
        assert!(unknown.last_etag.lock().is_none());
        update_topic_from_reply(
            &unknown,
            Reply::synthesized(http::StatusCode::BAD_GATEWAY, "text/plain", "offline"),
        )
        .await;
        assert!(unknown.last_etag.lock().is_none());
    }

    #[tokio::test]
    async fn frame_forwarder_stops_when_its_event_channel_closes() {
        let (event_tx, event_rx) = mpsc::channel(1);
        drop(event_tx);
        let (out_tx, mut out_rx) = mpsc::channel(1);
        forward_frames(event_rx, out_tx, Duration::from_secs(60)).await;
        assert!(out_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn disconnected_subscribers_stop_hello_heartbeat_and_invalidation_sends() {
        let topic = parse_topic("yarn/metrics").unwrap();

        let core_a = core();
        let hub = Hub::new();
        let sub = hub
            .subscribe(&core_a, std::slice::from_ref(&topic))
            .unwrap();
        drop(sub);
        tokio::task::yield_now().await;
        assert_eq!(hub.subscriber_count(), 0);

        let core_b = core();
        let hub = Hub::new();
        hub.set_heartbeat(Duration::from_millis(1));
        let sub = hub
            .subscribe(&core_b, std::slice::from_ref(&topic))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(sub);
        tokio::time::timeout(Duration::from_millis(100), async {
            while hub.subscriber_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let core_c = core();
        let hub = Hub::new();
        hub.set_heartbeat(Duration::from_secs(10));
        let sub = hub
            .subscribe(&core_c, std::slice::from_ref(&topic))
            .unwrap();
        let state = hub.inner.topics.lock()["yarn/metrics"].clone();
        hub.ensure_poller(&core_c); // the shared poller is started only once
        let mut frames = sub.into_stream();
        assert!(
            frames
                .next()
                .await
                .unwrap()
                .unwrap()
                .starts_with(b"event: hello")
        );
        drop(frames);
        state.broadcast(HubEvent::Invalidate(Invalidate {
            topic: "yarn/metrics".into(),
            etag: "W/\"change\"".into(),
            at: 1,
        }));
        tokio::time::timeout(Duration::from_millis(500), async {
            while hub.subscriber_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(core_c);
        tokio::time::sleep(TICK + Duration::from_millis(50)).await;
    }
}
