//! Shared test scaffolding: a scriptable upstream (a real TCP server, so request coalescing, keep-alive
//! and byte-level passthrough are exercised for real) plus a harness that runs the *production* router.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use burrow::app::{self, AppState};
use burrow::assets::Assets;
use burrow_core::config::Config;
use burrow_core::core::Core;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// One canned upstream response.
#[derive(Clone)]
pub struct Canned {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
    /// Delay before the response is written — used to keep a request "in flight" while other callers join.
    pub delay: Duration,
}

impl Canned {
    pub fn json(body: impl Into<Vec<u8>>) -> Self {
        Self::new(200, "application/json;charset=utf-8", body)
    }

    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            body: body.into(),
            headers: Vec::new(),
            delay: Duration::ZERO,
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    pub fn with_delay(mut self, ms: u64) -> Self {
        self.delay = Duration::from_millis(ms);
        self
    }
}

#[derive(Default)]
struct MockState {
    routes: HashMap<String, Canned>,
    /// path (with query) → number of requests served
    hits: HashMap<String, usize>,
    /// every request line seen, in order
    requests: Vec<String>,
    connections: usize,
}

/// A tiny HTTP/1.1 server: keep-alive, no chunking, deterministic bodies.
pub struct Mock {
    state: Arc<Mutex<MockState>>,
    addr: std::net::SocketAddr,
    port: u16,
    next: Arc<AtomicUsize>,
}

impl Mock {
    pub async fn start() -> Mock {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock");
        let addr = listener.local_addr().expect("addr");
        let state = Arc::new(Mutex::new(MockState::default()));
        let state_for_task = state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                {
                    let mut s = state_for_task.lock().await;
                    s.connections += 1;
                }
                let state = state_for_task.clone();
                tokio::spawn(async move {
                    let _ = serve_conn(stream, state).await;
                });
            }
        });
        Mock {
            state,
            addr,
            port: addr.port(),
            next: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn addr(&self) -> std::net::SocketAddr {
        self.addr
    }

    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn authority(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// Register a response for `path_and_query` (or for a bare path, which matches any query).
    pub async fn set(&self, path: &str, canned: Canned) -> &Self {
        self.state
            .lock()
            .await
            .routes
            .insert(path.to_string(), canned);
        self
    }

    pub async fn json(&self, path: &str, body: &str) -> &Self {
        self.set(path, Canned::json(body)).await
    }

    /// Remove everything: routes, hit counts and the request log.
    pub async fn reset(&self) {
        let mut s = self.state.lock().await;
        s.routes.clear();
        s.hits.clear();
        s.requests.clear();
    }

    /// Hits for an exact `path?query` (`""` = bare path with no query).
    pub async fn hits(&self, path: &str) -> usize {
        *self.state.lock().await.hits.get(path).unwrap_or(&0)
    }

    /// Total hits across every path.
    pub async fn total_hits(&self) -> usize {
        self.state.lock().await.hits.values().sum()
    }

    /// Hits for a bare path, any query.
    pub async fn hits_of_path(&self, path: &str) -> usize {
        self.state
            .lock()
            .await
            .hits
            .iter()
            .filter(|(k, _)| k.split('?').next() == Some(path))
            .map(|(_, v)| *v)
            .sum()
    }

    pub async fn requests(&self) -> Vec<String> {
        self.state.lock().await.requests.clone()
    }

    pub async fn last_request(&self) -> Option<String> {
        self.state.lock().await.requests.last().cloned()
    }

    pub async fn connections(&self) -> usize {
        self.state.lock().await.connections
    }

    /// Convenience: a plausible ResourceManager (info with `haState`, a node list, a scheduler, an app).
    pub async fn seed_rm(&self) -> &Self {
        self.json(
            "/ws/v1/cluster/info",
            r#"{"clusterInfo":{"id":1,"state":"STARTED","haState":"ACTIVE","hadoopVersion":"3.4.3","resourceManagerVersion":"3.4.3"}}"#,
        )
        .await;
        self.json(
            "/ws/v1/cluster/metrics",
            r#"{"clusterMetrics":{"appsSubmitted":7}}"#,
        )
        .await;
        self.json(
            "/ws/v1/cluster/nodes",
            r#"{"nodes":{"node":[{"id":"127.0.0.2:8041","nodeHTTPAddress":"127.0.0.2:8042","nodeHostName":"127.0.0.2","state":"RUNNING"}]}}"#,
        )
        .await;
        self.json(
            "/ws/v1/cluster/scheduler",
            r#"{"scheduler":{"schedulerInfo":{"type":"capacityScheduler","capacity":100.0}}}"#,
        )
        .await;
        self.json(
            "/ws/v1/cluster/apps",
            r#"{"apps":{"app":[{"id":"application_1_0001","state":"RUNNING"}]}}"#,
        )
        .await;
        self.json(
            "/ws/v1/cluster/apps/application_1_0001",
            r#"{"app":{"id":"application_1_0001","state":"RUNNING"}}"#,
        )
        .await;
        self.json(
            "/ws/v1/cluster/nodes/127.0.0.2:8041",
            r#"{"node":{"id":"127.0.0.2:8041"}}"#,
        )
        .await;
        self.json(
            "/conf",
            "<configuration><property><name>a</name><value>1</value></property></configuration>",
        )
        .await;
        self.json("/jmx", r#"{"beans":[]}"#).await;
        self.set(
            "/logs/",
            Canned::new(
                200,
                "text/html;charset=utf-8",
                r#"<!DOCTYPE html><html><head><title>Directory: /logs/</title></head><body>
<table class="listing"><thead><tr><th class="name">Name</th></tr></thead><tbody>
<tr><td class="name"><a href="/logs/resourcemanager.log">resourcemanager.log&nbsp;</a></td><td class="lastmodified">Oct 3, 2026, 12:26:50 PM&nbsp;</td><td class="size">135,064 bytes&nbsp;</td></tr>
</tbody></table></body></html>"#,
            ),
        )
        .await;
        self.set(
            "/logs/resourcemanager.log",
            Canned::new(200, "text/plain", "line one\nline two\n"),
        )
        .await;
        self
    }

    fn next_conn_id(&self) -> usize {
        self.next.fetch_add(1, Ordering::Relaxed)
    }
}

async fn serve_conn(stream: TcpStream, state: Arc<Mutex<MockState>>) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    // Connection id is irrelevant to the responses; it exists so the mock can be observed per connection.
    let _id = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(()); // client closed
        }
        let line = line.trim_end().to_string();
        if line.is_empty() {
            continue;
        }
        // headers (ignored, but must be consumed)
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).await? == 0 {
                return Ok(());
            }
            if header == "\r\n" || header == "\n" {
                break;
            }
        }
        let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
        let (canned, delay) = {
            let mut s = state.lock().await;
            s.requests.push(format!("{line} -> {target}"));
            *s.hits.entry(target.clone()).or_insert(0) += 1;
            let bare = target.split('?').next().unwrap_or("").to_string();
            let canned = s
                .routes
                .get(&target)
                .or_else(|| s.routes.get(&bare))
                .cloned();
            match canned {
                Some(c) => {
                    let delay = c.delay;
                    (c, delay)
                }
                None => (
                    Canned::new(
                        404,
                        "application/json;charset=utf-8",
                        format!(
                            r#"{{"RemoteException":{{"exception":"NotFound","path":"{target}"}}}}"#
                        ),
                    ),
                    Duration::ZERO,
                ),
            }
        };
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let mut out = Vec::new();
        let reason = match canned.status {
            200 => "OK",
            206 => "Partial Content",
            301 => "Moved Permanently",
            307 => "Temporary Redirect",
            400 => "Bad Request",
            403 => "Forbidden",
            404 => "Not Found",
            500 => "Internal Server Error",
            503 => "Service Unavailable",
            _ => "Unknown",
        };
        out.extend_from_slice(format!("HTTP/1.1 {} {}\r\n", canned.status, reason).as_bytes());
        out.extend_from_slice(format!("content-type: {}\r\n", canned.content_type).as_bytes());
        out.extend_from_slice(format!("content-length: {}\r\n", canned.body.len()).as_bytes());
        for (name, value) in &canned.headers {
            out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        out.extend_from_slice(b"connection: keep-alive\r\n\r\n");
        out.extend_from_slice(&canned.body);
        write_half.write_all(&out).await?;
        write_half.flush().await?;
    }
}

/// A global counter so every harness gets its own upstream identity.
static HARNESS_ID: AtomicUsize = AtomicUsize::new(0);

/// The burrow server under test: real `Core`, real router, real socket.
pub struct Harness {
    pub core: Arc<Core>,
    pub state: Arc<AppState>,
    pub base: String,
    pub client: reqwest::Client,
    handle: tokio::task::JoinHandle<()>,
    _port: u16,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl Harness {
    /// Serve `cfg` on an ephemeral loopback port, exactly as `serve` would (including
    /// `--assets-dir`).
    pub async fn start(cfg: Config) -> Harness {
        let assets = Assets::from_config(&cfg);
        Self::start_with(cfg, assets, None).await
    }

    /// Serve `cfg` with the given assets, optionally overriding the host allowlist.
    pub async fn start_with(
        cfg: Config,
        assets: Assets,
        allowed_hosts: Option<Vec<String>>,
    ) -> Harness {
        let mut cfg = cfg;
        if let Some(hosts) = allowed_hosts {
            cfg.allowed_hosts = hosts;
        }
        let core = Core::new(cfg).expect("config");
        let state = app::state_for(core.clone(), assets);
        let (port, handle) = app::serve_ephemeral(state.clone()).await.expect("serve");
        Harness {
            core,
            state,
            base: format!("http://127.0.0.1:{port}"),
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("test client"),
            handle,
            _port: port,
        }
    }

    /// Config for one mock upstream, tuned for fast tests.
    pub fn config_for(base: &str) -> Config {
        let mut cfg = Config::for_rm(base).expect("config");
        // Keep TTLs honest in shape but short in wall-clock so tests stay fast.
        cfg.cache.ttl_scale = 0.05;
        cfg.tuning.connect_timeout = Duration::from_secs(2);
        cfg.tuning.request_timeout = Duration::from_secs(5);
        cfg.no_open = true;
        cfg
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// `127.0.0.1:port` of the test server, for raw-socket requests.
    pub fn addr(&self) -> String {
        self.base.trim_start_matches("http://").to_string()
    }

    pub async fn get(&self, path: &str) -> TestResponse {
        self.get_with(path, &[]).await
    }

    pub async fn get_with(&self, path: &str, headers: &[(&str, &str)]) -> TestResponse {
        let mut req = self
            .client
            .get(self.url(path))
            .header("host", format!("127.0.0.1:{}", self._port));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = req.send().await.expect("request");
        TestResponse::from_reqwest(resp).await
    }

    /// Total upstream requests the harness's RM mock has seen (only meaningful with one RM).
    pub fn cache_stats(&self) -> (u64, u64, u64, u64) {
        let s = self.core.cache.stats();
        (
            s.hits.load(Ordering::Relaxed),
            s.misses.load(Ordering::Relaxed),
            s.coalesced.load(Ordering::Relaxed),
            s.stale.load(Ordering::Relaxed),
        )
    }
}

/// Send a request line verbatim over a raw socket: client libraries rewrite `..` before it ever reaches
/// the server, so this is the only way to test what the server does with a traversal attempt.
pub async fn raw_get(addr: &str, target: &str, host: Option<&str>) -> (u16, String) {
    use tokio::io::AsyncReadExt;
    let mut socket = TcpStream::connect(addr).await.expect("connect test server");
    let request = format!(
        "GET {target} HTTP/1.1\r\nhost: {}\r\nconnection: close\r\n\r\n",
        host.unwrap_or(addr)
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    socket.flush().await.unwrap();
    let mut buf = Vec::new();
    socket.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

pub struct TestResponse {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

impl TestResponse {
    async fn from_reqwest(resp: reqwest::Response) -> Self {
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let body = resp.bytes().await.expect("body").to_vec();
        Self {
            status,
            headers,
            body,
        }
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", self.text()))
    }

    pub fn cache(&self) -> String {
        self.header("x-burrow-cache").unwrap_or_default()
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }
}
