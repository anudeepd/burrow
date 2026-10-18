//! Live-cluster SSE hub test — **opt-in** (`BURROW_LIVE=1`, `.cluster/endpoints.json`).
//!
//! Proves contract §6 against the real ResourceManager: the hub polls `yarn/metrics` only because a
//! subscriber exists, and that poll lands in the *shared* cache (a plain GET right afterwards is a hit).
//!
//! Run with: `BURROW_LIVE=1 cargo test -p burrow --test events_live -- --nocapture`

mod common;

use std::time::Duration;

use burrow_core::config::Config;
use common::Harness;
use futures_util::StreamExt;

fn live_rm() -> Option<String> {
    if std::env::var("BURROW_LIVE").as_deref() != Ok("1") {
        eprintln!("skipping live test: set BURROW_LIVE=1 to run it against the real cluster");
        return None;
    }
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cluster/endpoints.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("skipping live test: {} unreadable ({e})", path.display());
            return None;
        }
    };
    let cluster: serde_json::Value = serde_json::from_str(&text).expect("endpoints.json");
    Some(cluster["rm"]["webapp"].as_str()?.to_string())
}

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
        assert_eq!(resp.status(), 200);
        assert!(
            resp.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/event-stream")
        );
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

#[tokio::test]
async fn live_events_stream_polls_the_shared_cache() {
    let Some(rm) = live_rm() else { return };
    let mut cfg = Config::for_rm(&rm).expect("config");
    cfg.no_open = true;
    let h = Harness::start(cfg).await;

    // A plain GET first: this is the cache entry the hub must then reuse.
    let cold = h.get("/api/yarn/metrics").await;
    assert_eq!(cold.status, 200);
    eprintln!(
        "live: cold /api/yarn/metrics → x-burrow-cache={}",
        cold.cache()
    );

    let mut sse = Sse::open(&h, "/api/events?topics=yarn/metrics").await;
    let hello = sse.next_frame(Duration::from_secs(5)).await.expect("hello");
    assert!(hello.starts_with("event: hello"), "{hello}");
    eprintln!("live: {}", hello.replace('\n', " | "));

    // Wait for the hub's first poll (1 s cadence, 250 ms tick), then GET inside the 1 s TTL.
    tokio::time::sleep(Duration::from_millis(700)).await;
    let warm = h.get("/api/yarn/metrics").await;
    eprintln!(
        "live: GET after the hub poll → x-burrow-cache={} x-burrow-age={:?}",
        warm.cache(),
        warm.header("x-burrow-age")
    );
    assert_eq!(
        warm.cache(),
        "hit",
        "the hub's poll and the GET share one cache entry"
    );

    // The stream stays live: within 20 s we get either a real invalidation or the 15 s heartbeat.
    let frame = sse
        .next_frame(Duration::from_secs(20))
        .await
        .expect("a frame within 20s");
    let kind = frame.lines().next().unwrap_or("");
    eprintln!("live: next frame: {}", frame.replace('\n', " | "));
    assert!(
        kind == ": heartbeat" || kind == "event: invalidate",
        "unexpected frame: {frame}"
    );
    if kind == "event: invalidate" {
        let data: serde_json::Value =
            serde_json::from_str(frame.split_once("data: ").unwrap().1.trim()).unwrap();
        assert_eq!(data["topic"], "yarn/metrics");
        assert!(data["etag"].as_str().unwrap().starts_with("W/\""));
        assert!(data["at"].as_u64().unwrap() > 1_700_000_000_000);
    }
}
