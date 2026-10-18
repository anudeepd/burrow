//! Thin layer over `reqwest`: TLS (rustls/ring, custom CA, insecure), header/credential injection,
//! request execution with a concurrency permit, bounded body buffering and error mapping.
//!
//! Upstream credentials (`--header`, `--token`, `user.name`, URL userinfo) are attached *here* and never
//! copied onto anything that goes back to the browser: [`UpResp`] only ever carries an allow-list of
//! response headers.

use std::path::Path;
use std::sync::{Arc, Once};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use http::StatusCode;
use http::header::{
    ACCEPT, ACCEPT_RANGES, AUTHORIZATION, CONTENT_RANGE, CONTENT_TYPE, HeaderMap, HeaderName,
    HeaderValue, LOCATION,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::config::ConfigError;
use crate::error::{ApiError, redact_url};

/// How much of the upstream body to hold in memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyMode {
    /// Buffer up to `cap` bytes; if the body is larger the result is [`UpBody::Stream`] carrying what was
    /// already read plus the remainder.
    Buffer { cap: usize },
    /// Never buffer: hand the stream to the caller immediately.
    Stream,
}

#[derive(Debug, Clone)]
pub struct FetchReq {
    /// Required for fleet upstreams (NodeManagers): `host:port`.
    pub authority: Option<String>,
    /// Starts with `/`; appended to the upstream base URL verbatim (query included).
    pub path_and_query: String,
    pub mode: BodyMode,
    pub accept: Option<&'static str>,
    /// Extra request headers (e.g. `Range`). Never browser credentials.
    pub headers: HeaderMap,
}

impl FetchReq {
    pub fn get(path_and_query: impl Into<String>, mode: BodyMode) -> Self {
        Self {
            authority: None,
            path_and_query: path_and_query.into(),
            mode,
            accept: None,
            headers: HeaderMap::new(),
        }
    }

    pub fn path(&self) -> &str {
        self.path_and_query
            .split_once('?')
            .map_or(self.path_and_query.as_str(), |(p, _)| p)
    }
}

pub enum UpBody {
    Full(Bytes),
    Stream {
        prefix: Bytes,
        rest: BoxStream<'static, std::io::Result<Bytes>>,
    },
}

pub struct UpResp {
    pub status: StatusCode,
    pub content_type: Option<HeaderValue>,
    /// Allow-listed passthrough headers (`content-range`, `accept-ranges`).
    pub extra: HeaderMap,
    pub body: UpBody,
    /// `host:port` of the endpoint that answered.
    pub served_by: Arc<str>,
    /// Upstream URL (credentials stripped, injected `user.name` not shown) for messages.
    pub url: String,
}

/// An upstream failure plus whether it happened while *connecting* (the only case that is safely retried).
#[derive(Debug, Clone)]
pub struct RawErr {
    pub api: ApiError,
    pub connect: bool,
}

pub struct HttpSettings {
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub headers: Vec<(String, String)>,
    pub token: Option<String>,
    pub user: Option<String>,
    pub ca_cert: Option<std::path::PathBuf>,
    pub insecure: bool,
}

pub struct HttpClient {
    client: reqwest::Client,
    headers: HeaderMap,
    user: Option<String>,
}

fn install_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Err(_) means another provider was installed first — fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn load_ca(path: &Path) -> Result<Vec<reqwest::Certificate>, ConfigError> {
    let pem = std::fs::read(path)
        .map_err(|e| ConfigError(format!("--ca-cert {}: {e}", path.display())))?;
    let certs = reqwest::Certificate::from_pem_bundle(&pem)
        .map_err(|e| ConfigError(format!("--ca-cert {}: not valid PEM: {e}", path.display())))?;
    if certs.is_empty() {
        return Err(ConfigError(format!(
            "--ca-cert {}: no certificates found",
            path.display()
        )));
    }
    Ok(certs)
}

impl HttpClient {
    pub fn new(s: &HttpSettings) -> Result<Arc<Self>, ConfigError> {
        install_crypto_provider();
        let mut b = reqwest::Client::builder()
            .connect_timeout(s.connect_timeout)
            .read_timeout(s.request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .pool_idle_timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(30))
            .tcp_nodelay(true)
            .no_proxy()
            .user_agent(concat!("burrow/", env!("CARGO_PKG_VERSION")));
        if let Some(ca) = &s.ca_cert {
            for c in load_ca(ca)? {
                b = b.add_root_certificate(c);
            }
        }
        if s.insecure {
            b = b.danger_accept_invalid_certs(true);
        }
        let client = b
            .build()
            .map_err(|e| ConfigError(format!("cannot build HTTP client: {e}")))?;
        let mut headers = HeaderMap::new();
        for (k, v) in &s.headers {
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|_| ConfigError(format!("invalid header name '{k}'")))?;
            let mut val = HeaderValue::from_str(v)
                .map_err(|_| ConfigError(format!("invalid value for header '{k}'")))?;
            val.set_sensitive(true);
            headers.append(name, val);
        }
        if let Some(t) = &s.token {
            let mut val = HeaderValue::from_str(&format!("Bearer {t}"))
                .map_err(|_| ConfigError("invalid --token".into()))?;
            val.set_sensitive(true);
            headers.insert(AUTHORIZATION, val);
        }
        Ok(Arc::new(Self {
            client,
            headers,
            user: s.user.clone(),
        }))
    }

    /// Add `user.name=…` (simple auth) unless the caller already supplied one.
    fn wire_url(&self, url: &str) -> String {
        match &self.user {
            Some(u) if !has_param(url, "user.name") => {
                let sep = if url.contains('?') { '&' } else { '?' };
                format!("{url}{sep}user.name={u}")
            }
            _ => url.to_string(),
        }
    }
}

fn has_param(url: &str, name: &str) -> bool {
    url.split_once('?')
        .is_some_and(|(_, q)| q.split('&').any(|p| p.split('=').next() == Some(name)))
}

/// A response whose headers have arrived; the body is still on the wire. Holds the concurrency permit.
pub struct Attempt {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub url: String,
    pub served_by: Arc<str>,
    resp: reqwest::Response,
    permit: OwnedSemaphorePermit,
}

impl Attempt {
    pub fn location(&self) -> Option<&str> {
        self.headers.get(LOCATION).and_then(|v| v.to_str().ok())
    }

    /// Read the body according to `mode`.
    pub async fn into_up(self, mode: BodyMode) -> Result<UpResp, RawErr> {
        let Attempt {
            status,
            headers,
            url,
            served_by,
            resp,
            permit,
        } = self;
        let content_type = headers.get(CONTENT_TYPE).cloned();
        let mut extra = HeaderMap::new();
        for name in [CONTENT_RANGE, ACCEPT_RANGES] {
            if let Some(v) = headers.get(&name) {
                extra.insert(name, v.clone());
            }
        }
        let body = match mode {
            BodyMode::Stream => UpBody::Stream {
                prefix: Bytes::new(),
                rest: guard_stream(resp.bytes_stream(), permit),
            },
            BodyMode::Buffer { cap } => {
                // Fast reject by declared length.
                let declared = resp.content_length();
                let mut stream = resp.bytes_stream();
                let mut buf = BytesMut::with_capacity(
                    declared.map_or(8 * 1024, |l| (l as usize).min(cap).min(1 << 20)),
                );
                let mut overflow = false;
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| map_err(&e, &url))?;
                    buf.extend_from_slice(&chunk);
                    if buf.len() > cap {
                        overflow = true;
                        break;
                    }
                }
                if overflow {
                    UpBody::Stream {
                        prefix: buf.freeze(),
                        rest: guard_stream(stream, permit),
                    }
                } else {
                    drop(permit);
                    UpBody::Full(buf.freeze())
                }
            }
        };
        Ok(UpResp {
            status,
            content_type,
            extra,
            body,
            served_by,
            url,
        })
    }
}

fn guard_stream(
    s: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
    permit: OwnedSemaphorePermit,
) -> BoxStream<'static, std::io::Result<Bytes>> {
    s.map(move |c| {
        let _held = &permit;
        c.map_err(std::io::Error::other)
    })
    .boxed()
}

/// One upstream address with its own pooled connections and a concurrency cap.
pub struct Endpoint {
    pub base: String,
    pub authority: Arc<str>,
    http: Arc<HttpClient>,
    sem: Arc<Semaphore>,
}

impl Endpoint {
    pub fn new(base: String, authority: String, http: Arc<HttpClient>, concurrency: usize) -> Self {
        Self {
            base,
            authority: authority.into(),
            http,
            sem: Arc::new(Semaphore::new(concurrency.max(1))),
        }
    }

    pub fn display_url(&self, path_and_query: &str) -> String {
        redact_url(&format!("{}{}", self.base, path_and_query))
    }

    /// Send the request and wait for response *headers*.
    pub async fn attempt(&self, req: &FetchReq) -> Result<Attempt, RawErr> {
        let url = self.display_url(&req.path_and_query);
        let permit = self.sem.clone().acquire_owned().await.map_err(|_| RawErr {
            api: ApiError::internal("upstream limiter closed"),
            connect: false,
        })?;
        let wire = self
            .http
            .wire_url(&format!("{}{}", self.base, req.path_and_query));
        let mut rb = self.http.client.get(&wire);
        for (k, v) in &self.http.headers {
            rb = rb.header(k, v);
        }
        for (k, v) in &req.headers {
            rb = rb.header(k, v);
        }
        if let Some(a) = req.accept {
            rb = rb.header(ACCEPT, a);
        }
        let resp = rb.send().await.map_err(|e| map_err(&e, &url))?;
        Ok(Attempt {
            status: resp.status(),
            headers: resp.headers().clone(),
            url,
            served_by: self.authority.clone(),
            resp,
            permit,
        })
    }
}

/// reqwest's top-level Display embeds the full request URL (which may carry `user.name`); build the
/// message from the source chain instead and drop hyper's "client error (Connect)" noise.
fn error_text(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut parts: Vec<String> = Vec::new();
    let mut cur = e.source();
    while let Some(c) = cur {
        let m = c.to_string();
        if !m.starts_with("client error (") && !parts.iter().any(|p| p.contains(&m)) {
            parts.push(m);
        }
        cur = c.source();
    }
    if parts.is_empty() {
        let mut s = e.to_string();
        if let Some(u) = e.url() {
            s = s.replace(u.as_str(), "<url>");
        }
        return s;
    }
    parts.join(": ")
}

pub fn map_err(e: &reqwest::Error, url: &str) -> RawErr {
    let connect = e.is_connect();
    let what = if e.is_timeout() {
        "timed out talking to"
    } else if connect {
        "cannot connect to"
    } else {
        "request failed for"
    };
    RawErr {
        api: ApiError::unreachable(
            url,
            format!("{what} {}: {}", display_host(url), error_text(e)),
        ),
        connect,
    }
}

fn display_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|u| {
            let host = u.host_str().unwrap_or("?").to_string();
            match u.port() {
                Some(p) => format!("{host}:{p}"),
                None => host,
            }
        })
        .unwrap_or_else(|| url.to_string())
}
