//! `/api/logs/*` integration tests (contract §5) against the scriptable mock upstream.
//!
//! The mock speaks HTTP/1.1 over a real socket, so source resolution, the SSRF guard, byte windows and the
//! server-side follow tailer are exercised end to end through the production router.

mod common;

use std::time::Duration;

use burrow_core::config::Config;
use common::{Canned, Harness, Mock};
use futures_util::StreamExt;

const CID: &str = "container_1791010984040_0005_01_000001";
const APP: &str = "application_1791010984040_0005";
const USER: &str = "alice";
const RPC: &str = "127.0.0.1:8041";

fn nm_base() -> String {
    format!("/node/containerlogs/{CID}/{USER}/")
}

fn nm_listing_html() -> String {
    let base = nm_base();
    format!(
        r#"<!DOCTYPE html><html><body><h2>Local Logs:</h2>
<p><a href="{base}stdout/?start=-4096">stdout : Total file length is 5 bytes.</a></p>
<p><a href="{base}stderr/?start=-4096">stderr : Total file length is 0 bytes.</a></p>
</body></html>"#
    )
}

fn jhs_listing_html() -> String {
    r#"<html><body>
Log Type: stderr
Log Upload Time: Sat Oct 03 12:38:56 +0530 2026
Log Length: 1731
<pre>some stderr</pre>
Log Type: stdout
Log Upload Time: Sat Oct 03 12:38:56 +0530 2026
Log Length: 11
<pre>hello world</pre>
</body></html>"#
        .to_string()
}

async fn seed_nodes(mock: &Mock) {
    mock.set(
        "/ws/v1/cluster/nodes",
        Canned::json(format!(
            r#"{{"nodes":{{"node":[{{"id":"{RPC}","nodeHTTPAddress":"{}","nodeHostName":"127.0.0.1","state":"RUNNING"}}]}}}}"#,
            mock.authority()
        )),
    )
    .await;
}

async fn seed_app(mock: &Mock, state: &str) {
    mock.json(
        &format!("/ws/v1/cluster/apps/{APP}"),
        &format!(r#"{{"app":{{"id":"{APP}","state":"{state}","user":"{USER}"}}}}"#),
    )
    .await;
}

async fn seed_nm(mock: &Mock, state: &str) {
    mock.set(
        &nm_base(),
        Canned::new(200, "text/html;charset=utf-8", nm_listing_html()),
    )
    .await;
    mock.json(
        &format!("/ws/v1/node/containers/{CID}"),
        &format!(r#"{{"container":{{"id":"{CID}","state":"{state}","user":"{USER}"}}}}"#),
    )
    .await;
}

fn logs_config(mock: &Mock) -> Config {
    let mut cfg = Harness::config_for(&mock.base());
    cfg.jhs = vec![url::Url::parse(&mock.base()).unwrap()];
    cfg.log_server_url = Some(format!("{}/jobhistory/logs", mock.base()));
    cfg
}

fn listing_url(mock: &Mock) -> String {
    format!(
        "/api/logs/containers/{CID}?node={}&user={USER}&app={APP}",
        mock.authority()
    )
}

#[tokio::test]
async fn nm_listing_ranged_read_and_tail() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "RUNNING").await;
    let h = Harness::start(logs_config(&mock)).await;

    // --- listing ---------------------------------------------------------------
    let r = h.get(&listing_url(&mock)).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let j = r.json();
    assert_eq!(j["source"], "nm");
    assert_eq!(j["node"], mock.authority());
    let files = j["files"].as_array().unwrap();
    assert_eq!(files.len(), 2, "{j}");
    assert_eq!(files[0]["name"], "stdout");
    assert_eq!(files[0]["size"], 5);
    assert_eq!(files[0]["lastModified"], serde_json::Value::Null);
    assert_eq!(files[1]["name"], "stderr");
    assert_eq!(files[1]["size"], 0);
    assert!(r.header("etag").unwrap().starts_with("W/\""));

    // The listing page is cached; a second call is a hit.
    let again = h.get(&listing_url(&mock)).await;
    assert_eq!(again.status, 200);
    assert_eq!(
        mock.hits_of_path(&nm_base()).await,
        1,
        "listing page fetched once"
    );

    // --- ranged read -----------------------------------------------------------
    mock.set(
        &format!("{}stdout/?start=0&end=5", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", "<pre>hello</pre>"),
    )
    .await;
    let r = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&offset=0&length=5",
            mock.authority()
        ))
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.text(), "hello");
    assert!(r.header("content-type").unwrap().starts_with("text/plain"));
    assert_eq!(r.header("x-burrow-log-size").as_deref(), Some("5"));
    assert_eq!(r.header("x-burrow-log-start").as_deref(), Some("0"));
    assert_eq!(r.header("x-burrow-log-end").as_deref(), Some("5"));
    assert_eq!(r.header("x-burrow-log-source").as_deref(), Some("nm"));
    assert_eq!(r.cache(), "bypass", "log bodies are never cached");

    // --- tail=N ----------------------------------------------------------------
    mock.set(
        &format!("{}stdout/?start=2&end=5", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", "<pre>llo</pre>"),
    )
    .await;
    let r = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&tail=3",
            mock.authority()
        ))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "llo");
    assert_eq!(r.header("x-burrow-log-start").as_deref(), Some("2"));
    assert_eq!(r.header("x-burrow-log-end").as_deref(), Some("5"));

    // --- offset beyond EOF -----------------------------------------------------
    mock.set(
        &format!("{}stdout/?start=5&end=5", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", "<pre></pre>"),
    )
    .await;
    let r = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&offset=500&length=10",
            mock.authority()
        ))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "");
    assert_eq!(r.header("x-burrow-log-start").as_deref(), Some("5"));
    assert_eq!(r.header("x-burrow-log-end").as_deref(), Some("5"));
    assert_eq!(r.header("x-burrow-log-size").as_deref(), Some("5"));

    // --- default window is the whole file when it is smaller than 1 MiB ---------
    let r = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}",
            mock.authority()
        ))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("x-burrow-log-start").as_deref(), Some("0"));
    assert_eq!(r.header("x-burrow-log-end").as_deref(), Some("5"));

    // --- an unknown file is a 404 with the available names ----------------------
    let r = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/nope?node={}&user={USER}",
            mock.authority()
        ))
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");
    assert!(
        r.json()["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("stdout")
    );

    // --- bad parameters are rejected before any upstream contact ----------------
    let before = mock.total_hits().await;
    for bad in [
        format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&offset=x",
            mock.authority()
        ),
        format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&length=0x",
            mock.authority()
        ),
        format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&tail=1&offset=2",
            mock.authority()
        ),
        "/api/logs/containers/not-a-container".to_string(),
    ] {
        let r = h.get(&bad).await;
        assert_eq!(r.status, 400, "{bad} → {}", r.text());
    }
    // `..` never reaches the server through an HTTP client (it normalises the path first), so send it raw.
    let (status, _) = common::raw_get(
        &h.addr(),
        &format!(
            "/api/logs/containers/{CID}/files/..?node={}&user={USER}",
            mock.authority()
        ),
        None,
    )
    .await;
    assert_eq!(status, 400, "a dot-only file name is rejected");
    assert_eq!(
        mock.total_hits().await,
        before,
        "rejected before touching upstreams"
    );
}

#[tokio::test]
async fn nm_404_falls_back_to_the_jobhistoryserver() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    // No NM listing registered: the mock answers 404 for it.
    let jhs_base = format!("/jobhistory/logs/{RPC}/{CID}/{CID}/{USER}/");
    mock.set(
        &jhs_base,
        Canned::new(200, "text/html;charset=utf-8", jhs_listing_html()),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;

    let r = h.get(&listing_url(&mock)).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let j = r.json();
    assert_eq!(j["source"], "jhs");
    assert_eq!(j["node"], serde_json::Value::Null);
    let files = j["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0]["name"], "stderr");
    assert_eq!(files[0]["size"], 1731);
    assert_eq!(
        files[0]["lastModified"], 1_791_011_336_000u64,
        "the JobHistoryServer's upload time becomes epoch ms"
    );
    assert!(
        mock.hits_of_path(&nm_base()).await >= 1,
        "the NodeManager was tried first"
    );

    // The aggregated read goes to the JobHistoryServer path, with the trailing slash Hadoop needs.
    mock.set(
        &format!("{jhs_base}stdout/?start=0&end=11"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            "Log Length: 11\n<pre>hello world</pre>",
        ),
    )
    .await;
    let r = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&offset=0&length=11",
            mock.authority()
        ))
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.text(), "hello world");
    assert_eq!(r.header("x-burrow-log-source").as_deref(), Some("jhs"));
    assert_eq!(r.header("x-burrow-log-size").as_deref(), Some("11"));
}

#[tokio::test]
async fn nm_redirect_is_not_followed_and_falls_back_to_the_jobhistoryserver() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    mock.set(
        &nm_base(),
        Canned::new(307, "text/plain;charset=utf-8", "Redirecting to log server").with_header(
            "location",
            &format!("http://127.0.0.1:19888/jobhistory/logs/{RPC}/{CID}/{CID}/{USER}"),
        ),
    )
    .await;
    let jhs_base = format!("/jobhistory/logs/{RPC}/{CID}/{CID}/{USER}/");
    mock.set(
        &jhs_base,
        Canned::new(200, "text/html;charset=utf-8", jhs_listing_html()),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;

    let r = h.get(&listing_url(&mock)).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["source"], "jhs");
    assert_eq!(r.json()["files"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn no_source_is_an_unavailable_envelope_with_every_reason() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    // Neither an NM listing nor a JobHistoryServer is available (no `jhs` configured).
    let mut cfg = Harness::config_for(&mock.base());
    cfg.jhs.clear();
    cfg.log_server_url = None;
    let h = Harness::start(cfg).await;

    let r = h.get(&listing_url(&mock)).await;
    assert_eq!(r.status, 503, "{}", r.text());
    assert_eq!(r.error_code(), "unavailable");
    let hint = r.json()["error"]["hint"].as_str().unwrap().to_string();
    assert!(hint.contains("NodeManager"), "{hint}");
    assert!(hint.contains("JobHistoryServer"), "{hint}");
}

#[tokio::test]
async fn node_hint_must_be_a_cluster_nodemanager() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "RUNNING").await;
    let h = Harness::start(logs_config(&mock)).await;

    for (node, status) in [
        ("evil.example.com:8042", 403),
        ("127.0.0.9:8042", 403),
        ("not-a-host", 400),
    ] {
        let r = h
            .get(&format!(
                "/api/logs/containers/{CID}?node={node}&user={USER}&app={APP}"
            ))
            .await;
        assert_eq!(r.status, status, "{node} → {}", r.text());
    }
    // The NM was never contacted for a foreign host.
    assert_eq!(mock.hits_of_path(&nm_base()).await, 0);
}

#[tokio::test]
async fn node_hint_accepts_the_url_form_the_rm_uses_in_container_payloads() {
    // ContainerInfo.nodeHttpAddress is a full URL ("http://127.0.0.2:8042") while AppAttemptInfo's is "host:port".
    // The SPA forwards whichever it has, so both forms must resolve to the same NodeManager.
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "RUNNING").await;
    let h = Harness::start(logs_config(&mock)).await;

    for form in [
        mock.authority().to_string(),
        format!("http://{}", mock.authority()),
        format!("https://{}/", mock.authority()),
        format!("HTTP://{}", mock.authority()),
    ] {
        let r = h
            .get(&format!(
                "/api/logs/containers/{CID}?node={form}&user={USER}&app={APP}"
            ))
            .await;
        assert_eq!(r.status, 200, "{form} → {}", r.text());
        assert_eq!(r.json()["node"], mock.authority(), "{form}");
    }
    // A URL with a path is still rejected, and no foreign host is ever contacted.
    let r = h
        .get(&format!(
            "/api/logs/containers/{CID}?node=http://{}/ws/v1/node&user={USER}&app={APP}",
            mock.authority()
        ))
        .await;
    assert_eq!(r.status, 400, "{}", r.text());
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
        Sse {
            stream: Box::pin(resp.bytes_stream()),
            buf: String::new(),
        }
    }

    /// Next complete frame, or `None` on timeout/EOF.
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
async fn follow_stream_reports_growth_then_eof() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "RUNNING").await;
    mock.set(
        &format!("{}stdout/?start=0&end=262144", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", "<pre>hello</pre>"),
    )
    .await;
    let empty = || Canned::new(200, "text/html;charset=utf-8", "<pre></pre>");
    mock.set(&format!("{}stdout/?start=5&end=262149", nm_base()), empty())
        .await;
    mock.set(
        &format!("{}stdout/?start=11&end=262155", nm_base()),
        empty(),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;

    let mut sse = Sse::open(
        &h,
        &format!(
            "/api/logs/containers/{CID}/files/stdout/stream?node={}&user={USER}&offset=0",
            mock.authority()
        ),
    )
    .await;

    let f = sse
        .next_frame(Duration::from_secs(5))
        .await
        .expect("first chunk");
    assert!(f.starts_with("event: chunk"), "{f}");
    assert!(f.contains("\"start\":0"), "{f}");
    assert!(f.contains("\"end\":5"), "{f}");
    assert!(f.contains("hello"), "{f}");

    // The file grows while we are following it.
    mock.set(
        &format!("{}stdout/?start=5&end=262149", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", "<pre> world</pre>"),
    )
    .await;
    let f = sse
        .next_frame(Duration::from_secs(5))
        .await
        .expect("second chunk");
    assert!(f.contains("\"start\":5") && f.contains("\"end\":11"), "{f}");
    assert!(f.contains(" world"), "{f}");

    // The container finishes: the next idle poll emits eof and the stream ends.
    mock.json(
        &format!("/ws/v1/node/containers/{CID}"),
        &format!(r#"{{"container":{{"id":"{CID}","state":"COMPLETE","user":"{USER}"}}}}"#),
    )
    .await;
    let f = sse.next_frame(Duration::from_secs(5)).await.expect("eof");
    assert_eq!(f, "event: eof\ndata: {}");
    assert!(
        sse.next_frame(Duration::from_secs(1)).await.is_none(),
        "stream ends after eof"
    );
}

#[tokio::test]
async fn follow_stream_of_an_aggregated_log_replays_then_eofs() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "FINISHED").await;
    let jhs_base = format!("/jobhistory/logs/{RPC}/{CID}/{CID}/{USER}/");
    mock.set(
        &jhs_base,
        Canned::new(200, "text/html;charset=utf-8", jhs_listing_html()),
    )
    .await;
    mock.set(
        &format!("{jhs_base}stdout/?start=0&end=262144"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            "Log Length: 11\n<pre>hello world</pre>",
        ),
    )
    .await;
    mock.set(
        &format!("{jhs_base}stdout/?start=11&end=262155"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            "Log Length: 11\n<pre></pre>",
        ),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;

    let mut sse = Sse::open(
        &h,
        &format!(
            "/api/logs/containers/{CID}/files/stdout/stream?node={}&user={USER}&offset=0",
            mock.authority()
        ),
    )
    .await;
    let f = sse.next_frame(Duration::from_secs(5)).await.expect("chunk");
    assert!(f.contains("hello world"), "{f}");
    let f = sse.next_frame(Duration::from_secs(5)).await.expect("eof");
    assert_eq!(f, "event: eof\ndata: {}");
    // A terminal application is served by the JobHistoryServer, not the NodeManager.
    assert_eq!(mock.hits_of_path(&nm_base()).await, 0);
}
