//! `/api/events` SSE hub tests (contract §6).
//!
//! Everything runs through the production router against the scriptable mock upstream: the poll cadence is
//! shortened by registering a `yarn/metrics` topic class with a 150 ms interval, and the cache is left at
//! its real TTL (`ttl_scale = 1.0`) so the "one fetch per resource" assertions mean something.

mod common;

use std::time::Duration;

use burrow_core::config::Config;
use burrow_core::topics::TopicClass;
use common::{Canned, Harness, Mock};
use futures_util::StreamExt;

const METRICS: &str = "/ws/v1/cluster/metrics";
const INTERVAL: Duration = Duration::from_millis(150);

fn config(mock: &Mock) -> Config {
    let mut cfg = Harness::config_for(&mock.base());
    // Real TTLs: `yarn/metrics` is 1 s, so a 150 ms poll cadence still coalesces on the cache.
    cfg.cache.ttl_scale = 1.0;
    cfg
}

fn fast_metrics(h: &Harness) {
    h.core.topics.register(TopicClass {
        prefix: "yarn/metrics",
        interval: INTERVAL,
    });
}

async fn wait_for<F, Fut>(what: &str, f: F, timeout: Duration)
where
    F: Fn() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Reads SSE frames incrementally off a live response.
struct Sse {
    stream: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>,
    >,
    buf: String,
}

impl Sse {
    async fn open(h: &Harness, path: &str) -> Sse {
        let resp = h
            .client
            .get(h.url(path))
            .header("host", h.addr())
            .send()
            .await
            .expect("sse request");
        assert_eq!(resp.status(), 200, "sse status");
        assert!(
            resp.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/event-stream"),
            "{:?}",
            resp.headers()
        );
        assert_eq!(resp.headers()["x-burrow-api"], "1");
        assert_eq!(resp.headers()["x-burrow-cache"], "bypass");
        Sse {
            stream: Box::pin(resp.bytes_stream()),
            buf: String::new(),
        }
    }

    async fn next_frame(&mut self, timeout: Duration) -> Option<String> {
        loop {
            if let Some(i) = self.buf.find("\n\n") {
                let frame = self.buf[..i].to_string();
                self.buf.drain(..i + 2);
                return Some(frame);
            }
            match tokio::time::timeout(timeout, self.stream.next()).await {
                Ok(Some(Ok(chunk))) => self.buf.push_str(&String::from_utf8_lossy(&chunk)),
                _ => return None,
            }
        }
    }
}

fn event_name(frame: &str) -> &str {
    frame
        .strip_prefix("event: ")
        .and_then(|f| f.split('\n').next())
        .unwrap_or("")
}

fn data_json(frame: &str) -> serde_json::Value {
    let data = frame
        .split_once("data: ")
        .map(|(_, d)| d.trim())
        .unwrap_or("{}");
    serde_json::from_str(data).unwrap_or_else(|e| panic!("bad data in {frame:?}: {e}"))
}

#[tokio::test]
async fn hello_then_one_poll_shared_with_a_plain_get() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(config(&mock)).await;
    fast_metrics(&h);

    let mut sse = Sse::open(&h, "/api/events?topics=yarn/metrics").await;
    let hello = sse.next_frame(Duration::from_secs(2)).await.expect("hello");
    assert_eq!(event_name(&hello), "hello");
    let data = data_json(&hello);
    assert_eq!(data["topics"], serde_json::json!(["yarn/metrics"]));
    assert!(data["serverTime"].as_u64().unwrap() > 1_700_000_000_000);

    let hits_before = mock.hits_of_path(METRICS).await;
    // Wait for the hub's first poll (it happens on the poller's first tick).
    wait_for(
        "the hub's first upstream poll",
        || async { mock.hits_of_path(METRICS).await > hits_before },
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(mock.hits_of_path(METRICS).await, hits_before + 1);

    // A browser GET for the same resource must be a cache hit: no second upstream fetch.
    let r = h.get("/api/yarn/metrics").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.cache(), "hit");
    assert_eq!(
        mock.hits_of_path(METRICS).await,
        hits_before + 1,
        "the hub poll and the GET share one upstream fetch"
    );
}

#[tokio::test]
async fn change_emits_exactly_one_invalidate_and_no_change_emits_none() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(config(&mock)).await;
    fast_metrics(&h);

    let mut sse = Sse::open(&h, "/api/events?topics=yarn/metrics").await;
    assert_eq!(
        event_name(&sse.next_frame(Duration::from_secs(2)).await.expect("hello")),
        "hello"
    );
    wait_for(
        "the baseline poll",
        || async { mock.hits_of_path(METRICS).await >= 1 },
        Duration::from_secs(3),
    )
    .await;

    // Several poll intervals with an unchanged body: nothing is emitted.
    assert!(
        sse.next_frame(Duration::from_millis(700)).await.is_none(),
        "an unchanged body must not produce an event"
    );

    // The resource changes upstream.
    mock.set(
        METRICS,
        Canned::json(r#"{"clusterMetrics":{"appsSubmitted":99}}"#),
    )
    .await;
    let frame = sse
        .next_frame(Duration::from_secs(5))
        .await
        .expect("invalidate");
    assert_eq!(event_name(&frame), "invalidate", "{frame}");
    let data = data_json(&frame);
    assert_eq!(data["topic"], "yarn/metrics");
    assert!(data["etag"].as_str().unwrap().starts_with("W/\""), "{data}");
    assert!(data["at"].as_u64().unwrap() > 1_700_000_000_000);

    // …and stays changed: no second event for the same body.
    assert!(
        sse.next_frame(Duration::from_millis(700)).await.is_none(),
        "one change ⇒ exactly one invalidate"
    );
}

#[tokio::test]
async fn heartbeat_is_a_comment_line() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(config(&mock)).await;
    fast_metrics(&h);
    h.core.events.set_heartbeat(Duration::from_millis(120));

    let mut sse = Sse::open(&h, "/api/events?topics=yarn/metrics").await;
    assert_eq!(
        event_name(&sse.next_frame(Duration::from_secs(2)).await.expect("hello")),
        "hello"
    );
    let frame = sse
        .next_frame(Duration::from_secs(2))
        .await
        .expect("heartbeat");
    assert_eq!(frame, ": heartbeat");
}

#[tokio::test]
async fn sixty_four_topics_per_connection_and_no_more() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(config(&mock)).await;

    let many = |n: usize| {
        (1..=n)
            .map(|i| format!("yarn/apps?k={i}"))
            .collect::<Vec<_>>()
            .join(",")
    };

    let r = h.get(&format!("/api/events?topics={}", many(65))).await;
    assert_eq!(r.status, 400, "{}", r.text());
    assert_eq!(r.error_code(), "bad_request");
    assert!(
        r.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("64")
    );

    // 64 is accepted: headers arrive, then we drop the connection.
    let resp = h
        .client
        .get(h.url(&format!("/api/events?topics={}", many(64))))
        .header("host", h.addr())
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200);
    drop(resp);
}

#[tokio::test]
async fn unknown_topics_are_rejected() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(config(&mock)).await;

    for topic in ["meta", "api/yarn/metrics", "/yarn/metrics", "nope/x"] {
        let r = h.get(&format!("/api/events?topics={topic}")).await;
        assert_eq!(r.status, 400, "{topic} → {}", r.text());
        assert_eq!(r.error_code(), "bad_request");
    }
    let r = h.get("/api/events").await;
    assert_eq!(r.status, 400);
    assert!(
        r.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("topics")
    );

    // `?topics=` may be repeated as well as comma-separated.
    let resp = h
        .client
        .get(h.url("/api/events?topics=yarn/metrics&topics=yarn/nodes"))
        .header("host", h.addr())
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn sse_is_not_compressed_even_when_the_client_accepts_gzip() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(config(&mock)).await;
    fast_metrics(&h);
    h.core.events.set_heartbeat(Duration::from_millis(120));

    let resp = h
        .client
        .get(h.url("/api/events?topics=yarn/metrics"))
        .header("host", h.addr())
        .header("accept-encoding", "gzip, br, zstd")
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200);
    assert!(
        resp.headers().get("content-encoding").is_none(),
        "an SSE stream must never be compressed: the encoder would buffer it until the end \
         (headers: {:?})",
        resp.headers()
    );
    let mut sse = Sse {
        stream: Box::pin(resp.bytes_stream()),
        buf: String::new(),
    };
    assert_eq!(
        event_name(&sse.next_frame(Duration::from_secs(2)).await.expect("hello")),
        "hello"
    );
    assert_eq!(
        sse.next_frame(Duration::from_secs(2))
            .await
            .expect("heartbeat"),
        ": heartbeat",
        "frames still arrive one by one"
    );
}

#[tokio::test]
async fn disconnecting_stops_the_polling() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(config(&mock)).await;
    fast_metrics(&h);

    let mut sse = Sse::open(&h, "/api/events?topics=yarn/metrics").await;
    assert_eq!(
        event_name(&sse.next_frame(Duration::from_secs(2)).await.expect("hello")),
        "hello"
    );
    wait_for(
        "the baseline poll",
        || async { mock.hits_of_path(METRICS).await >= 1 },
        Duration::from_secs(3),
    )
    .await;

    drop(sse);
    // Give the connection task a moment to notice the closed frame channel.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let after_disconnect = mock.hits_of_path(METRICS).await;
    // Well past the 1 s TTL: a still-running poller would have to refetch at least once.
    tokio::time::sleep(Duration::from_millis(1600)).await;
    assert_eq!(
        mock.hits_of_path(METRICS).await,
        after_disconnect,
        "a topic with no subscribers must not be polled"
    );
    wait_for(
        "the subscription to be released",
        || async { h.core.events.subscriber_count() == 0 },
        Duration::from_secs(2),
    )
    .await;
}
