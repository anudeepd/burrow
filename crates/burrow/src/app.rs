//! The HTTP layer: one axum router that serves `/api/*` from `burrow-core` and the embedded SPA
//! everywhere else, plus the process-level bits (bind, banner, graceful shutdown).
//!
//! Responsibilities kept here (and deliberately *not* in the core):
//! * turning an inbound request into a transport-agnostic [`ApiRequest`] (path/query/`If-None-Match`/
//!   `Cache-Control: no-cache`/`Range`) and the [`Reply`] back into an HTTP response, adding the
//!   `x-burrow-*` headers and the `304` decision;
//! * the Host-header allowlist, the security headers every response carries, and compression;
//! * static delivery from [`crate::assets`] with the SPA shell fallback.

use std::io::ErrorKind;
use std::net::IpAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use burrow_core::api::{self, ApiRequest};
use burrow_core::cache::CacheSource;
use burrow_core::config::Config;
use burrow_core::core::Core;
use burrow_core::error::ApiError;
use burrow_core::reply::{Reply, ReplyBody};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio::net::TcpListener;
use tower_http::compression::CompressionLayer;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::assets::{Asset, Assets, PLACEHOLDER_HTML};

/// Contract §7: applied to *every* response (API and static alike).
const CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
                   script-src 'self'; worker-src 'self' blob:; connect-src 'self'";

/// CSP for an HTML document that carries a per-response nonce.
///
/// TanStack Start writes inline `<script>` bootstrap tags into the prerendered shell (they seed
/// `window.$_TSR`, the router's hydration state) and reads the nonce back from
/// `<meta property="csp-nonce">` for anything it injects at runtime. Without a nonce every inline
/// script is blocked, `window.$_TSR` stays undefined, and hydration dies — so HTML is served
/// identity-encoded, rewritten per request, and compressed on the fly.
fn csp_with_nonce(nonce: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
         script-src 'self' 'nonce-{nonce}'; worker-src 'self' blob:; connect-src 'self'"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static(CSP))
}

/// 128 bits of OS randomness, hex-encoded — enough to make the nonce unguessable per response.
fn fresh_nonce() -> String {
    let mut buf = [0u8; 16];
    if getrandom::fill(&mut buf).is_err() {
        // Extremely unlikely; a time-seeded fallback is still better than a blocked page.
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        buf[..16].copy_from_slice(&t.to_le_bytes()[..16.min(size_of::<u128>())]);
    }
    let mut out = String::with_capacity(32);
    for b in buf {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Stamp inline scripts with `nonce`, and fill the prerendered `csp-nonce` meta tag.
fn inject_nonce(html: &str, nonce: &str) -> String {
    let mut with_scripts = String::with_capacity(html.len() + nonce.len() * 4);
    let mut cursor = 0;
    while let Some(relative_start) = html[cursor..].find("<script") {
        let start = cursor + relative_start;
        with_scripts.push_str(&html[cursor..start]);
        let Some(relative_end) = html[start..].find('>') else {
            with_scripts.push_str(&html[start..]);
            return with_scripts.replace("__BURROW_CSP_NONCE__", nonce);
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        let attrs = &tag["<script".len()..tag.len() - 1];
        let has_src = attrs
            .split_whitespace()
            .any(|attr| attr.starts_with("src="));
        let has_nonce = attrs
            .split_whitespace()
            .any(|attr| attr.starts_with("nonce="));
        if has_src || has_nonce {
            // Same-origin external scripts already match `script-src 'self'`; leaving their attributes alone keeps
            // the browser DOM identical to React's prerendered tree during hydration.
            with_scripts.push_str(tag);
        } else {
            with_scripts.push_str(&format!(
                "<script nonce=\"{nonce}\"{}",
                &tag["<script".len()..]
            ));
        }
        cursor = end;
    }
    with_scripts.push_str(&html[cursor..]);
    let with_scripts = with_scripts.replace("__BURROW_CSP_NONCE__", nonce);
    let meta = format!("<meta property=\"csp-nonce\" content=\"{nonce}\">");
    if with_scripts.contains("property=\"csp-nonce\"") {
        return with_scripts;
    }
    match with_scripts.find("<head>") {
        Some(i) => {
            let at = i + "<head>".len();
            let mut out = String::with_capacity(with_scripts.len() + meta.len() + 1);
            out.push_str(&with_scripts[..at]);
            out.push_str(&meta);
            out.push_str(&with_scripts[at..]);
            out
        }
        // No <head> (never for our shell): prepend, so the meta still precedes every script.
        None => format!("{meta}{with_scripts}"),
    }
}

fn hdr(name: &'static str) -> HeaderName {
    HeaderName::from_static(name)
}

/// What an inbound path means to us.
enum Route<'a> {
    /// `/api/<rest>` — `rest` has no leading slash.
    Api(&'a str),
    /// Anything else, relative to `--base-path` and with no leading slash.
    Static(&'a str),
}

pub struct AppState {
    pub core: Arc<Core>,
    pub assets: Arc<Assets>,
    pub guard: HostGuard,
    /// `""` or `"/prefix/"`.
    base_prefix: String,
}

impl AppState {
    pub fn new(core: Arc<Core>, assets: Assets) -> Self {
        let guard = HostGuard::new(&core.config);
        let base_prefix = if core.config.base_path.is_empty() {
            String::new()
        } else {
            format!("{}/", core.config.base_path)
        };
        Self {
            core,
            assets: Arc::new(assets),
            guard,
            base_prefix,
        }
    }

    fn route<'a>(&self, path: &'a str) -> Option<Route<'a>> {
        let rel = self.strip_base(path)?;
        if let Some(rest) = rel.strip_prefix("api/") {
            return Some(Route::Api(rest));
        }
        if rel == "api" {
            return Some(Route::Api(""));
        }
        Some(Route::Static(rel))
    }

    /// Strip `--base-path`; `None` when the request is outside it (⇒ 404).
    fn strip_base<'a>(&self, path: &'a str) -> Option<&'a str> {
        if self.base_prefix.is_empty() {
            return Some(path.strip_prefix('/').unwrap_or(path));
        }
        if path.trim_end_matches('/') == self.core.config.base_path {
            return Some("");
        }
        path.strip_prefix(self.base_prefix.as_str())
    }
}

/// Host-header allowlist: loopback, the bind address, or an explicit `--allowed-host` entry (which may
/// be `host`, `host:port`, or `*`). A missing Host (HTTP/1.0) is allowed — there is nothing to check.
pub struct HostGuard {
    entries: Vec<String>,
    any: bool,
    bind: String,
}

impl HostGuard {
    pub fn new(cfg: &Config) -> Self {
        Self {
            entries: cfg.allowed_hosts.clone(),
            any: cfg.allowed_hosts.iter().any(|h| h == "*"),
            bind: cfg.bind.to_string(),
        }
    }

    pub fn allows(&self, host_header: Option<&str>) -> bool {
        if self.any {
            return true;
        }
        let Some(raw) = host_header.map(str::trim).filter(|h| !h.is_empty()) else {
            return true;
        };
        let authority = raw.to_ascii_lowercase();
        let host = host_only(&authority);
        if host == "localhost" || host == self.bind {
            return true;
        }
        if host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()) {
            return true;
        }
        // An entry may be `host` (any port) or `host:port`; both match the host part of the header.
        self.entries
            .iter()
            .any(|e| e.as_str() == host || e.as_str() == authority || host_only(e) == host)
    }
}

fn host_only(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match authority.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') && p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => authority,
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .fallback(handle)
        .layer(middleware::from_fn_with_state(state.clone(), host_guard))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        // `if_not_present`: HTML responses set their own nonce-bearing CSP (see `shell`).
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
        .layer(CompressionLayer::new().compress_when(compressible))
        .with_state(state)
}

/// Compression must never touch a server-sent event stream: the encoder buffers until its window fills, so
/// a compressed SSE response would deliver nothing until the connection ends. Everything else is compressed
/// as before (tower-http's own content-type rules still apply).
fn compressible(
    _status: axum::http::StatusCode,
    _version: axum::http::Version,
    headers: &HeaderMap,
    _extensions: &axum::http::Extensions,
) -> bool {
    !headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            let ct = ct.trim_start().to_ascii_lowercase();
            ct.starts_with("text/event-stream")
        })
}

async fn host_guard(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if state.guard.allows(host.as_deref()) {
        return next.run(req).await;
    }
    let is_api = matches!(state.route(req.uri().path()), Some(Route::Api(_)));
    let msg = format!(
        "the Host header '{}' is not allowed; start burrow with --allowed-host {}:{} or use \
         http://localhost:{}",
        host.as_deref().unwrap_or("?"),
        host.as_deref().unwrap_or("this-host"),
        local_port(&state),
        local_port(&state)
    );
    if is_api {
        api_error(ApiError::forbidden(msg))
    } else {
        plain(
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            msg.into_bytes(),
        )
    }
}

fn local_port(state: &AppState) -> u16 {
    state.core.config.port
}

async fn handle(State(state): State<Arc<AppState>>, req: Request<Body>) -> Response {
    if req.method() != Method::GET {
        let mut resp = plain(
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain; charset=utf-8",
            b"burrow is read-only: use GET".to_vec(),
        );
        resp.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET"));
        return resp;
    }
    let (parts, _body) = req.into_parts();
    match state.route(parts.uri.path()) {
        None => plain(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            format!(
                "404: '{}' is outside --base-path {}",
                parts.uri.path(),
                state.core.config.base_path
            )
            .into_bytes(),
        ),
        Some(Route::Api(path)) => {
            let headers = &parts.headers;
            let if_none_match = headers
                .get(header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok());
            let request = ApiRequest {
                path,
                query: parts.uri.query(),
                bypass: wants_no_cache(headers),
                if_none_match,
                range: headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
            };
            match api::dispatch(&state.core, request).await {
                Ok(reply) => api_response(reply, if_none_match),
                Err(err) => api_error(err),
            }
        }
        Some(Route::Static(rel)) => static_response(&state, &parts.headers, rel),
    }
}

/// `Cache-Control: no-cache` (the parity harness's hard-reload) ⇒ read through, no cache, no coalescing.
fn wants_no_cache(headers: &HeaderMap) -> bool {
    headers
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',').any(|d| {
                d.trim().eq_ignore_ascii_case("no-cache")
                    || d.trim().eq_ignore_ascii_case("no-store")
            })
        })
}

fn body_of(body: ReplyBody) -> Body {
    match body {
        ReplyBody::Bytes(b) => Body::from(b),
        ReplyBody::Stream { prefix, rest } => {
            let first =
                futures_util::stream::iter(std::iter::once(Ok::<Bytes, std::io::Error>(prefix)));
            Body::from_stream(first.chain(rest))
        }
    }
}

/// [`Reply`] → HTTP, adding every `x-burrow-*` header from contract §1.
fn api_response(reply: Reply, if_none_match: Option<&str>) -> Response {
    let reply = reply.conditional(if_none_match);
    let mut out = Response::new(body_of(reply.body));
    *out.status_mut() = reply.status;
    let h = out.headers_mut();
    h.insert(hdr("x-burrow-api"), HeaderValue::from_static("1"));
    h.insert(
        hdr("x-burrow-cache"),
        HeaderValue::from_static(reply.cache.unwrap_or(CacheSource::Bypass).as_str()),
    );
    if let Some(up) = &reply.upstream
        && let Ok(v) = HeaderValue::from_str(up)
    {
        h.insert(hdr("x-burrow-upstream"), v);
    }
    if let Some(age) = reply.age_ms
        && let Ok(v) = HeaderValue::from_str(&age.to_string())
    {
        h.insert(hdr("x-burrow-age"), v);
    }
    if let Some(ct) = &reply.content_type {
        h.insert(header::CONTENT_TYPE, ct.clone());
    }
    for (name, value) in reply.extra.iter() {
        h.insert(name.clone(), value.clone());
    }
    if let Some(etag) = &reply.etag
        && let Ok(v) = HeaderValue::from_str(etag)
    {
        h.insert(header::ETAG, v);
    }
    // The browser may keep the bytes but must revalidate: our ETag turns the revalidation into a 304.
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    out
}

fn api_error(err: ApiError) -> Response {
    if err.status.is_server_error() {
        tracing::warn!(
            status = err.status.as_u16(),
            code = err.code.as_str(),
            upstream = err.upstream.as_ref().map(|u| u.url.as_str()).unwrap_or("-"),
            "{}",
            err.message
        );
    }
    let reply = Reply::error_envelope(err.status, &err);
    api_response(reply, None)
}

fn plain(status: StatusCode, content_type: &'static str, body: Vec<u8>) -> Response {
    let mut out = Response::new(Body::from(body));
    *out.status_mut() = status;
    out.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    out
}

fn static_response(state: &AppState, headers: &HeaderMap, rel: &str) -> Response {
    let accept = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok());
    if rel.is_empty() || rel == "index.html" || rel == "_shell.html" {
        return shell(state, accept);
    }
    if let Some(asset) = state.assets.get(rel, accept) {
        return file_response(asset);
    }
    if looks_like_static_file(rel) {
        return plain(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            format!("404: no static asset '{rel}'").into_bytes(),
        );
    }
    // SPA deep link: the router owns everything that is not a file.
    shell(state, accept)
}

fn shell(state: &AppState, _accept: Option<&str>) -> Response {
    // Identity bytes on purpose: the shell carries inline bootstrap scripts, so it is rewritten with
    // a fresh nonce per response (and compressed on the fly by the router's compression layer).
    match state.assets.shell(None) {
        Some(asset) => html_response(asset),
        None => {
            let mut out = plain(
                StatusCode::SERVICE_UNAVAILABLE,
                "text/html; charset=utf-8",
                PLACEHOLDER_HTML.as_bytes().to_vec(),
            );
            out.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            out
        }
    }
}

/// Rewrite an HTML asset with a per-response CSP nonce and serve it uncompressed (the compression
/// layer handles the wire encoding, so the nonce is never stale inside a cached `.br`/`.gz`).
fn html_response(asset: Asset) -> Response {
    let nonce = fresh_nonce();
    let html = match asset.bytes {
        std::borrow::Cow::Borrowed(b) => String::from_utf8_lossy(b).into_owned(),
        std::borrow::Cow::Owned(v) => String::from_utf8_lossy(&v).into_owned(),
    };
    let mut out = Response::new(Body::from(inject_nonce(&html, &nonce)));
    let h = out.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    h.insert(header::CONTENT_SECURITY_POLICY, csp_with_nonce(&nonce));
    // The shell must never be cached: it names content-hashed assets and carries a per-response nonce.
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    out
}

fn file_response(asset: Asset) -> Response {
    let bytes = match asset.bytes {
        std::borrow::Cow::Borrowed(b) => Bytes::from_static(b),
        std::borrow::Cow::Owned(v) => Bytes::from(v),
    };
    let mut out = Response::new(Body::from(bytes));
    let h = out.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&asset.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    if let Some(encoding) = asset.encoding {
        h.insert(
            header::CONTENT_ENCODING,
            HeaderValue::from_static(encoding.http()),
        );
    }
    h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    h.insert(
        header::CACHE_CONTROL,
        if asset.immutable {
            HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
            HeaderValue::from_static("no-cache")
        },
    );
    out
}

/// A missing *file* is a 404; a missing route is the SPA shell.
fn looks_like_static_file(rel: &str) -> bool {
    const STATIC_EXT: &[&str] = &[
        "js", "mjs", "css", "map", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif",
        "ico", "woff", "woff2", "ttf", "otf", "txt", "xml", "wasm", "mp4", "webm", "br", "gz",
    ];
    if rel.starts_with("assets/") {
        return true;
    }
    rel.rsplit('/')
        .next()
        .and_then(|file| file.rsplit_once('.'))
        .is_some_and(|(_, ext)| STATIC_EXT.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Bind `--port`, falling back to the next free port unless the port was given explicitly.
async fn bind(cfg: &Config) -> anyhow::Result<(TcpListener, u16, bool)> {
    let attempts = if cfg.port_explicit { 1 } else { 20 };
    let mut tried = Vec::new();
    for offset in 0..attempts {
        let Some(port) = cfg.port.checked_add(offset) else {
            break;
        };
        match TcpListener::bind((cfg.bind, port)).await {
            Ok(listener) => {
                let actual_port = listener.local_addr()?.port();
                return Ok((listener, actual_port, offset > 0));
            }
            Err(e) if e.kind() == ErrorKind::AddrInUse => tried.push(port),
            Err(e) => {
                return Err(
                    anyhow::Error::new(e).context(format!("cannot bind {}:{port}", cfg.bind))
                );
            }
        }
    }
    anyhow::bail!(
        "port(s) {} already in use on {} — pass --port to pick another one",
        tried
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        cfg.bind
    )
}

/// URL a human should open: wildcard binds are reported as loopback.
fn display_url(cfg: &Config, port: u16) -> String {
    let host = match cfg.bind {
        IpAddr::V4(v4) if v4.is_unspecified() => "127.0.0.1".to_string(),
        IpAddr::V6(v6) if v6.is_unspecified() => "[::1]".to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
        other => other.to_string(),
    };
    format!("http://{host}:{port}{}", cfg.base_path)
}

/// Bind, banner, open the browser and serve until Ctrl-C/SIGTERM.
pub async fn serve(cfg: Config) -> anyhow::Result<()> {
    let assets = Assets::from_config(&cfg);
    let shell = assets.has_shell();
    let assets_origin = assets.origin().to_string();
    let core = Core::new(cfg)?;
    let state = Arc::new(AppState::new(core, assets));
    let (listener, port, moved) = bind(&state.core.config).await?;
    let url = display_url(&state.core.config, port);
    if moved {
        println!(
            "burrow: port {} was in use; listening on {port} instead",
            state.core.config.port
        );
    }
    print_banner(&state, &url, &assets_origin, shell);
    if !state.core.config.no_open {
        open_browser(&url);
    }
    let probe_state = state.clone();
    tokio::spawn(async move { print_cluster(&probe_state, "  ").await });

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    println!("\nburrow: stopped");
    Ok(())
}

fn open_browser(url: &str) {
    match webbrowser::open(url) {
        Ok(()) => {}
        Err(e) => {
            println!("  (could not open a browser: {e}; open {url} yourself, or pass --no-open)")
        }
    }
}

fn print_banner(state: &AppState, url: &str, assets_origin: &str, shell: bool) {
    let cfg = &state.core.config;
    let list = |urls: &[url::Url]| {
        urls.iter()
            .map(burrow_core::config::url_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    println!("burrow {}  ·  {url}", env!("CARGO_PKG_VERSION"));
    println!(
        "  ResourceManager   {}   [{}]",
        list(&cfg.rm_urls),
        cfg.source("rm")
    );
    for (key, label, urls) in [
        (
            "spark_history",
            "Spark History",
            cfg.spark_history.as_slice(),
        ),
        ("jhs", "JobHistory", cfg.jhs.as_slice()),
    ] {
        if urls.is_empty() {
            println!("  {label:<17} not configured");
        } else {
            println!(
                "  {label:<17} {}   [{}]",
                urls.iter()
                    .map(burrow_core::config::url_string)
                    .collect::<Vec<_>>()
                    .join(", "),
                cfg.source(key)
            );
        }
    }
    if let Some(url) = &cfg.timeline {
        println!(
            "  {:<17} {}   [{}]",
            "Timeline",
            burrow_core::config::url_string(url),
            cfg.source("timeline")
        );
    } else {
        println!("  {:<17} not configured", "Timeline");
    }
    let mut auth = Vec::new();
    if let Some(user) = &cfg.user {
        auth.push(format!("user.name={user}"));
    }
    if cfg.token.is_some() {
        auth.push("bearer token".into());
    }
    if !cfg.headers.is_empty() {
        auth.push(format!("{} custom header(s)", cfg.headers.len()));
    }
    if cfg.insecure {
        auth.push("TLS verification off".into());
    }
    if let Some(ca) = &cfg.ca_cert {
        auth.push(format!("CA {}", ca.display()));
    }
    if !auth.is_empty() {
        println!("  auth              {}", auth.join(", "));
    }
    println!(
        "  cache             {} MiB bodies ≤ {} MiB · stale ≤ {}s · {}",
        cfg.cache.max_bytes / (1024 * 1024),
        cfg.cache.max_body_bytes / (1024 * 1024),
        cfg.cache.max_stale.as_secs(),
        if cfg.base_path.is_empty() {
            "no base path".to_string()
        } else {
            format!("base path {}", cfg.base_path)
        }
    );
    if shell {
        println!("  assets            {assets_origin}");
    } else {
        println!(
            "  assets            {assets_origin} — no SPA shell; serving the 'assets not built' page"
        );
    }
    for warning in &cfg.discovery.warnings {
        println!("  warning           {warning}");
    }
    println!("  read-only · press Ctrl-C to stop");
}

/// One-line cluster summary used by both the startup banner and `doctor` (memoized, so a SPA's first
/// `/api/meta` pays nothing for it).
pub async fn cluster_summary(core: &Core) -> String {
    let (doc, _) = core.meta_document().await;
    let rm = &doc["rm"];
    let reachable = rm["reachable"].as_bool().unwrap_or(false);
    let urls = rm["urls"]
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(|u| u.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    if !reachable {
        let services = doc["services"]
            .as_object()
            .map(|o| {
                o.iter()
                    .filter(|(_, v)| v["configured"].as_bool() == Some(true))
                    .map(|(k, v)| {
                        format!(
                            "{k}={}",
                            if v["reachable"].as_bool() == Some(true) {
                                "reachable"
                            } else {
                                "unreachable"
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        return format!("ResourceManager {urls} UNREACHABLE (services: {services})");
    }
    format!(
        "ResourceManager {} · {} · Hadoop {} · scheduler {}",
        rm["active"].as_str().unwrap_or(&urls),
        rm["haState"].as_str().unwrap_or("(ha state unknown)"),
        rm["hadoopVersion"].as_str().unwrap_or("(unknown version)"),
        doc["yarn"]["scheduler"].as_str().unwrap_or("unknown")
    )
}

async fn print_cluster(state: &AppState, indent: &str) {
    let summary = cluster_summary(&state.core).await;
    if summary.contains("UNREACHABLE") {
        tracing::warn!("{indent}{summary}");
    } else {
        tracing::info!("{indent}{summary}");
    }
    if let serde_json::Value::Object(services) = &state.core.meta_document().await.0["services"] {
        for (name, svc) in services {
            if svc["configured"].as_bool() == Some(true) {
                tracing::info!(
                    "{indent}{name}: {} ({})",
                    svc["url"].as_str().unwrap_or("-"),
                    if svc["reachable"].as_bool() == Some(true) {
                        "reachable"
                    } else {
                        svc["reason"].as_str().unwrap_or("unreachable")
                    }
                );
            }
        }
    }
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    return;
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// The address a test harness should talk to (used by integration tests).
pub fn state_for(core: Arc<Core>, assets: Assets) -> Arc<AppState> {
    Arc::new(AppState::new(core, assets))
}

/// Bind an ephemeral loopback port and serve `state` on it. Returns the bound port; the server runs
/// until the returned handle is dropped.
pub async fn serve_ephemeral(
    state: Arc<AppState>,
) -> std::io::Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind((IpAddr::from([127, 0, 0, 1]), 0)).await?;
    let port = listener.local_addr()?.port();
    let app = router(state);
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::debug!("test server stopped: {e}");
        }
    });
    Ok((port, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use burrow_core::cache::CacheSource;
    use futures_util::stream;
    use std::time::Duration;

    #[test]
    fn nonce_injection_handles_inline_external_existing_and_malformed_scripts() {
        let html = inject_nonce(
            "<head><script>boot()</script><script src=\"app.js\"></script><script nonce=\"old\">keep()</script></head>",
            "nonce-value",
        );
        assert!(html.contains("<script nonce=\"nonce-value\">boot()</script>"));
        assert!(html.contains("<script src=\"app.js\"></script>"));
        assert!(html.contains("<script nonce=\"old\">keep()</script>"));
        assert!(html.contains("<meta property=\"csp-nonce\" content=\"nonce-value\">"));

        let existing = inject_nonce(
            "<head><meta property=\"csp-nonce\" content=\"old\"></head>",
            "new",
        );
        assert_eq!(existing.matches("property=\"csp-nonce\"").count(), 1);
        let no_head = inject_nonce("<main>app</main>", "nonce-value");
        assert!(no_head.starts_with("<meta property=\"csp-nonce\" content=\"nonce-value\">"));
        let malformed = inject_nonce("<script __BURROW_CSP_NONCE__", "nonce-value");
        assert_eq!(malformed, "<script nonce-value");
        assert_eq!(
            csp_with_nonce("nonce-value")
                .to_str()
                .unwrap()
                .contains("nonce-nonce-value"),
            true
        );
        assert_eq!(fresh_nonce().len(), 32);
    }

    #[test]
    fn host_guard_accepts_local_and_allowlisted_authorities() {
        let mut cfg = Config::for_rm("http://rm.example:8088").unwrap();
        cfg.allowed_hosts = vec!["dashboard.example".into(), "other.example:9443".into()];
        let guard = HostGuard::new(&cfg);
        for host in [
            None,
            Some(""),
            Some("localhost"),
            Some("localhost:8787"),
            Some("127.0.0.1:8787"),
            Some("dashboard.example"),
            Some("dashboard.example:9000"),
            Some("other.example:9443"),
        ] {
            assert!(guard.allows(host), "expected host {host:?} to be allowed");
        }
        assert!(!guard.allows(Some("attacker.example")));
        assert_eq!(host_only("[::1]:8787"), "::1");
        assert_eq!(host_only("rm.example:8088"), "rm.example");
        assert_eq!(host_only("rm.example:not-a-port"), "rm.example:not-a-port");

        cfg.allowed_hosts = vec!["*".into()];
        assert!(HostGuard::new(&cfg).allows(Some("anything.example")));
    }

    #[test]
    fn app_state_routes_api_and_static_paths_under_an_optional_base_path() {
        let cfg = Config::for_rm("http://rm.example:8088").unwrap();
        let core = Core::new(cfg).unwrap();
        let state = AppState::new(core, Assets::embedded());
        assert!(matches!(
            state.route("/api/healthz"),
            Some(Route::Api("healthz"))
        ));
        assert!(matches!(state.route("/api"), Some(Route::Api(""))));
        assert!(matches!(state.route("/apps"), Some(Route::Static("apps"))));
        assert_eq!(state.strip_base("/apps"), Some("apps"));

        let mut cfg = Config::for_rm("http://rm.example:8088").unwrap();
        cfg.base_path = "/burrow".into();
        let core = Core::new(cfg).unwrap();
        let state = AppState::new(core, Assets::embedded());
        assert_eq!(state.strip_base("/burrow"), Some(""));
        assert_eq!(state.strip_base("/burrow/"), Some(""));
        assert!(matches!(
            state.route("/burrow/api/meta"),
            Some(Route::Api("meta"))
        ));
        assert!(matches!(
            state.route("/burrow/apps"),
            Some(Route::Static("apps"))
        ));
        assert!(state.route("/outside/apps").is_none());
    }

    #[test]
    fn cache_and_asset_helpers_cover_protocol_variants() {
        let mut headers = HeaderMap::new();
        assert!(!wants_no_cache(&headers));
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("max-age=0, No-Cache"),
        );
        assert!(wants_no_cache(&headers));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        assert!(wants_no_cache(&headers));
        headers.remove(header::CACHE_CONTROL);

        assert!(compressible(
            StatusCode::OK,
            axum::http::Version::HTTP_11,
            &headers,
            &Default::default()
        ));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("Text/Event-Stream; charset=utf-8"),
        );
        assert!(!compressible(
            StatusCode::OK,
            axum::http::Version::HTTP_11,
            &headers,
            &Default::default()
        ));

        for path in [
            "assets/app.js",
            "app.MJS",
            "theme.CSS",
            "data.json",
            "font.woff2",
            "movie.webm",
        ] {
            assert!(looks_like_static_file(path), "expected {path} to be a file");
        }
        for path in ["apps/42", "nested/no-extension", "app.jsx"] {
            assert!(
                !looks_like_static_file(path),
                "expected {path} to be a route"
            );
        }
    }

    #[test]
    fn api_response_stamps_headers_and_preserves_conditional_304_metadata() {
        let mut reply = Reply::synthesized(StatusCode::OK, "application/json", b"{}".to_vec());
        reply.cache = Some(CacheSource::Hit);
        reply.upstream = Some("rm.example:8088".into());
        reply.age_ms = Some(17);
        reply.etag = Some("W/\"abc\"".into());
        reply
            .extra
            .insert("x-extra", HeaderValue::from_static("value"));

        let response = api_response(reply, Some("W/\"abc\""));
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()["x-burrow-api"], "1");
        assert_eq!(response.headers()["x-burrow-cache"], "hit");
        assert_eq!(response.headers()["x-burrow-upstream"], "rm.example:8088");
        assert_eq!(response.headers()["x-burrow-age"], "17");
        assert_eq!(response.headers()[header::ETAG], "W/\"abc\"");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        assert!(response.headers().get("x-extra").is_none());

        let error = api_error(ApiError::forbidden("not allowed"));
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert_eq!(error.headers()["x-burrow-cache"], "bypass");
    }

    #[tokio::test]
    async fn body_of_chains_a_stream_prefix_with_its_remaining_chunks() {
        let rest = stream::iter([
            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"tail")),
            Ok(Bytes::from_static(b"!")),
        ])
        .boxed();
        let body = body_of(ReplyBody::Stream {
            prefix: Bytes::from_static(b"head"),
            rest,
        });
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        assert_eq!(bytes, "headtail!");
    }

    #[test]
    fn display_url_formats_wildcard_and_ipv6_binds() {
        let mut cfg = Config::for_rm("http://rm.example:8088").unwrap();
        cfg.base_path = "/burrow".into();
        cfg.bind = "0.0.0.0".parse().unwrap();
        assert_eq!(display_url(&cfg, 8787), "http://127.0.0.1:8787/burrow");
        cfg.bind = "::".parse().unwrap();
        assert_eq!(display_url(&cfg, 8787), "http://[::1]:8787/burrow");
        cfg.bind = "2001:db8::1".parse().unwrap();
        assert_eq!(display_url(&cfg, 8787), "http://[2001:db8::1]:8787/burrow");
    }

    #[tokio::test]
    async fn bind_uses_ephemeral_ports_and_reports_explicit_port_conflicts() {
        let mut cfg = Config::for_rm("http://rm.example:8088").unwrap();
        cfg.bind = "127.0.0.1".parse().unwrap();
        cfg.port = 0;
        cfg.port_explicit = true;
        let (listener, port, moved) = match bind(&cfg).await {
            Ok(bound) => bound,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == ErrorKind::PermissionDenied) =>
            {
                // Some sandboxed runners prohibit opening loopback sockets entirely.
                return;
            }
            Err(error) => panic!("unexpected bind failure: {error:#}"),
        };
        assert_ne!(port, 0);
        assert!(!moved);
        drop(listener);

        let occupied = TcpListener::bind((cfg.bind, 0)).await.unwrap();
        cfg.port = occupied.local_addr().unwrap().port();
        assert!(bind(&cfg).await.is_err());
        cfg.port_explicit = false;
        let (fallback, fallback_port, moved) = bind(&cfg).await.unwrap();
        assert!(moved);
        assert!(fallback_port > cfg.port);
        drop(fallback);
        drop(occupied);
    }

    #[tokio::test]
    async fn cluster_summary_describes_an_unreachable_resource_manager() {
        let mut cfg = Config::for_rm("http://127.0.0.1:0").unwrap();
        cfg.tuning.connect_timeout = Duration::from_millis(1);
        cfg.tuning.request_timeout = Duration::from_millis(5);
        let core = Core::new(cfg).unwrap();
        let summary = cluster_summary(&core).await;
        assert!(summary.contains("ResourceManager http://127.0.0.1:0 UNREACHABLE"));
        assert!(summary.contains("services: "));
    }
}
