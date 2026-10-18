//! Resolved runtime configuration and the layered resolution described in PLAN §6.1:
//! flags > `BURROW_*` env > `--config` TOML > Hadoop conf auto-discovery > `http://localhost:8088`.
//!
//! The CLI (clap) delivers flags and env as one or two [`Layer`]s; the TOML file is another; Hadoop
//! discovery and the built-in default are handled here. Every resolved key remembers which layer it came
//! from (`Config::sources`) so `doctor` and the startup banner can say why a value was chosen.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::hadoop_conf::HadoopDiscovery;

pub const DEFAULT_RM: &str = "http://localhost:8088";
pub const DEFAULT_PORT: u16 = 8787;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(pub String);

fn err<T>(msg: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(msg.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum HttpPolicy {
    #[serde(rename = "HTTP_ONLY")]
    HttpOnly,
    #[serde(rename = "HTTPS_ONLY")]
    HttpsOnly,
    #[serde(rename = "HTTP_AND_HTTPS")]
    HttpAndHttps,
}

impl HttpPolicy {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "HTTP_ONLY" => Some(Self::HttpOnly),
            "HTTPS_ONLY" => Some(Self::HttpsOnly),
            "HTTP_AND_HTTPS" => Some(Self::HttpAndHttps),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::HttpOnly => "HTTP_ONLY",
            Self::HttpsOnly => "HTTPS_ONLY",
            Self::HttpAndHttps => "HTTP_AND_HTTPS",
        }
    }

    /// Scheme to use when talking to NodeManager web ports.
    pub fn node_scheme(self) -> &'static str {
        if self == Self::HttpsOnly {
            "https"
        } else {
            "http"
        }
    }
}

/// Headers in the TOML file may be a list (`["K: V"]`) or a table (`{K = "V"}`).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum HeaderSpec {
    List(Vec<String>),
    Map(BTreeMap<String, String>),
}

/// A TOML service address may stay a string for backward compatibility or be repeated as an array.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum StringList {
    One(String),
    Many(Vec<String>),
}

impl StringList {
    fn into_vec(self) -> Vec<String> {
        match self {
            Self::One(value) => vec![value],
            Self::Many(values) => values,
        }
    }
}

impl HeaderSpec {
    fn into_pairs(self) -> Result<Vec<(String, String)>, ConfigError> {
        match self {
            HeaderSpec::List(l) => l.iter().map(|s| parse_header(s)).collect(),
            HeaderSpec::Map(m) => Ok(m.into_iter().collect()),
        }
    }
}

/// One layer of optional settings. Used for CLI flags, env and the TOML file alike.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct PartialConfig {
    pub rm: Option<Vec<String>>,
    pub spark_history: Option<StringList>,
    pub jhs: Option<StringList>,
    pub timeline: Option<String>,
    pub bind: Option<String>,
    pub port: Option<u16>,
    pub no_open: Option<bool>,
    pub user: Option<String>,
    pub headers: Option<HeaderSpec>,
    pub ca_cert: Option<PathBuf>,
    pub insecure: Option<bool>,
    pub token: Option<String>,
    pub allowed_hosts: Option<Vec<String>>,
    pub assets_dir: Option<PathBuf>,
    pub base_path: Option<String>,
    pub connect_timeout_secs: Option<u64>,
    pub request_timeout_secs: Option<u64>,
    pub max_concurrency: Option<usize>,
    pub cache_max_bytes: Option<u64>,
}

impl PartialConfig {
    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        toml::from_str(text).map_err(|e| ConfigError(format!("invalid config file: {e}")))
    }
}

#[derive(Debug, Clone)]
pub struct Layer {
    pub name: String,
    pub values: PartialConfig,
    /// Per-key refinement of the layer name (e.g. CLI delivers both "flag" and "env" in one layer).
    pub key_sources: BTreeMap<&'static str, String>,
}

impl Layer {
    pub fn new(name: impl Into<String>, values: PartialConfig) -> Self {
        Self {
            name: name.into(),
            values,
            key_sources: BTreeMap::new(),
        }
    }

    fn source_of(&self, key: &'static str) -> String {
        self.key_sources
            .get(key)
            .cloned()
            .unwrap_or_else(|| self.name.clone())
    }
}

#[derive(Debug, Clone)]
pub struct Tuning {
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    /// Max simultaneous in-flight requests per RM endpoint.
    pub rm_concurrency: usize,
    /// Max simultaneous in-flight requests per NodeManager.
    pub nm_concurrency: usize,
    /// Max simultaneous in-flight requests to any other upstream (SHS, JHS, timeline…).
    pub other_concurrency: usize,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(3),
            request_timeout: Duration::from_secs(20),
            rm_concurrency: 16,
            nm_concurrency: 4,
            other_concurrency: 8,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CacheConfig {
    /// Total bytes of cached bodies kept in memory.
    pub max_bytes: u64,
    /// Largest body that is buffered & cached; bigger responses are streamed through uncached.
    pub max_body_bytes: usize,
    /// Upper bound on how old a body may be when served as `stale` after an upstream failure.
    pub max_stale: Duration,
    /// Multiplier on every table TTL. 1.0 in production; tests shrink it.
    pub ttl_scale: f64,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            max_bytes: 128 * 1024 * 1024,
            max_body_bytes: 32 * 1024 * 1024,
            max_stale: Duration::from_secs(300),
            ttl_scale: 1.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct HaConfig {
    pub backoff_base: Duration,
    pub backoff_max: Duration,
}

impl Default for HaConfig {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(15),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub rm_urls: Vec<Url>,
    pub spark_history: Vec<Url>,
    pub jhs: Vec<Url>,
    pub timeline: Option<Url>,
    pub bind: IpAddr,
    pub port: u16,
    pub port_explicit: bool,
    pub no_open: bool,
    pub user: Option<String>,
    pub headers: Vec<(String, String)>,
    pub ca_cert: Option<PathBuf>,
    pub insecure: bool,
    pub token: Option<String>,
    pub allowed_hosts: Vec<String>,
    pub assets_dir: Option<PathBuf>,
    /// `""` (root) or `/prefix` without trailing slash.
    pub base_path: String,
    pub http_policy: HttpPolicy,
    pub log_server_url: Option<String>,
    pub tuning: Tuning,
    pub cache: CacheConfig,
    pub ha: HaConfig,
    /// key → human-readable provenance (`flag`, `env`, `config file`, `hadoop conf (…)`, `default`).
    pub sources: BTreeMap<&'static str, String>,
    pub discovery: HadoopDiscovery,
}

impl Config {
    /// A minimal config for one RM — used by tests and embedding.
    pub fn for_rm(rm: &str) -> Result<Self, ConfigError> {
        let values = PartialConfig {
            rm: Some(vec![rm.to_string()]),
            ..Default::default()
        };
        resolve(vec![Layer::new("api", values)], HadoopDiscovery::default())
    }

    pub fn source(&self, key: &'static str) -> &str {
        self.sources
            .get(key)
            .map(String::as_str)
            .unwrap_or("default")
    }
}

/// Resolve layers (highest priority first) + Hadoop discovery + defaults into a [`Config`].
pub fn resolve(layers: Vec<Layer>, hadoop: HadoopDiscovery) -> Result<Config, ConfigError> {
    let mut sources: BTreeMap<&'static str, String> = BTreeMap::new();

    // pick the first layer that sets a key
    macro_rules! pick {
        ($key:literal, $field:ident) => {
            layers
                .iter()
                .find_map(|l| l.values.$field.clone().map(|v| (v, l.source_of($key))))
        };
    }
    let hadoop_name = hadoop
        .conf_dir
        .as_ref()
        .map(|d| format!("hadoop conf ({})", d.display()))
        .unwrap_or_else(|| "hadoop conf".into());

    // --- RM urls ---------------------------------------------------------------------------------
    let (rm_raw, rm_src, from_hadoop_rm): (Vec<String>, String, bool) = match pick!("rm", rm) {
        Some((v, s)) if !v.is_empty() => (v, s, false),
        _ if !hadoop.rm_urls.is_empty() => (hadoop.rm_urls.clone(), hadoop_name.clone(), true),
        _ => (vec![DEFAULT_RM.to_string()], "default".into(), false),
    };
    let _ = from_hadoop_rm;
    sources.insert("rm", rm_src);
    let mut rm_urls = Vec::new();
    for raw in &rm_raw {
        let u = parse_service_url(raw, false, Some(8088))
            .map_err(|e| ConfigError(format!("invalid --rm '{raw}': {e}")))?;
        if !rm_urls.contains(&u) {
            rm_urls.push(u);
        }
    }

    // --- optional services -------------------------------------------------------------------------
    let mut service = |key: &'static str,
                       picked: Option<(Vec<String>, String)>,
                       discovered: Option<&String>,
                       default_port: u16|
     -> Result<Vec<Url>, ConfigError> {
        let (raws, src) = match picked {
            Some(p) => p,
            None => match discovered {
                Some(d) => (vec![d.clone()], hadoop_name.clone()),
                None => return Ok(Vec::new()),
            },
        };
        if raws.iter().all(|raw| raw.trim().is_empty()) {
            // An explicit empty value or empty list disables the service (e.g. `--jhs ""`).
            sources.insert(key, format!("{src} (disabled)"));
            return Ok(Vec::new());
        }
        sources.insert(key, src);
        let mut urls = Vec::new();
        for raw in raws {
            if raw.trim().is_empty() {
                return err(format!("empty URL in {key} address list"));
            }
            let url = parse_service_url(&raw, false, Some(default_port))
                .map_err(|e| ConfigError(format!("invalid {key} URL '{raw}': {e}")))?;
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
        Ok(urls)
    };
    let list = |picked: Option<(StringList, String)>| {
        picked.map(|(values, source)| (values.into_vec(), source))
    };
    let spark_history = service(
        "spark_history",
        list(pick!("spark_history", spark_history)),
        hadoop.spark_history.as_ref(),
        18080,
    )?;
    let jhs = service(
        "jhs",
        list(pick!("jhs", jhs)),
        hadoop.jhs_url.as_ref(),
        19888,
    )?;
    let timeline = service(
        "timeline",
        pick!("timeline", timeline).map(|(value, source)| (vec![value], source)),
        hadoop.timeline_url.as_ref(),
        8188,
    )?
    .into_iter()
    .next();

    // --- server ------------------------------------------------------------------------------------
    let bind = match pick!("bind", bind) {
        Some((b, s)) => {
            sources.insert("bind", s);
            parse_bind(&b)?
        }
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    let (port, port_explicit) = match pick!("port", port) {
        Some((p, s)) => {
            sources.insert("port", s);
            (p, true)
        }
        None => (DEFAULT_PORT, false),
    };
    let no_open = pick!("no_open", no_open).map(|(v, _)| v).unwrap_or(false);

    // --- auth / TLS ------------------------------------------------------------------------------------
    let user = pick!("user", user).map(|(v, s)| {
        sources.insert("user", s);
        v
    });
    if let Some(u) = &user
        && (u.is_empty() || u.chars().any(|c| c.is_control() || "&=?#% /".contains(c)))
    {
        return err("--user must be a plain user name");
    }
    let headers = match pick!("headers", headers) {
        Some((h, s)) => {
            sources.insert("headers", s);
            h.into_pairs()?
        }
        None => Vec::new(),
    };
    for (k, v) in &headers {
        http::HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| ConfigError(format!("invalid header name '{k}'")))?;
        http::HeaderValue::from_str(v)
            .map_err(|_| ConfigError(format!("invalid value for header '{k}'")))?;
    }
    let ca_cert = pick!("ca_cert", ca_cert).map(|(v, s)| {
        sources.insert("ca_cert", s);
        v
    });
    let insecure = pick!("insecure", insecure).map(|(v, _)| v).unwrap_or(false);
    let token = pick!("token", token).map(|(v, _)| v);
    if let Some(t) = &token
        && http::HeaderValue::from_str(&format!("Bearer {t}")).is_err()
    {
        return err("--token contains characters that cannot appear in an HTTP header");
    }

    let allowed_hosts = pick!("allowed_hosts", allowed_hosts)
        .map(|(v, s)| {
            sources.insert("allowed_hosts", s);
            v
        })
        .unwrap_or_default()
        .into_iter()
        .map(|h| normalize_allowed_host(&h))
        .collect::<Result<Vec<_>, _>>()?;

    let assets_dir = pick!("assets_dir", assets_dir).map(|(v, s)| {
        sources.insert("assets_dir", s);
        v
    });
    let base_path = match pick!("base_path", base_path) {
        Some((b, s)) => {
            sources.insert("base_path", s);
            normalize_base_path(&b)?
        }
        None => String::new(),
    };

    // yarn.http.policy: conf wins; otherwise infer from the first RM URL's scheme.
    let http_policy = hadoop.http_policy.unwrap_or_else(|| {
        if rm_urls.first().is_some_and(|u| u.scheme() == "https") {
            HttpPolicy::HttpsOnly
        } else {
            HttpPolicy::HttpOnly
        }
    });

    let mut tuning = Tuning::default();
    if let Some((s, _)) = pick!("connect_timeout_secs", connect_timeout_secs) {
        tuning.connect_timeout = Duration::from_secs(s.max(1));
    }
    if let Some((s, _)) = pick!("request_timeout_secs", request_timeout_secs) {
        tuning.request_timeout = Duration::from_secs(s.max(1));
    }
    if let Some((n, _)) = pick!("max_concurrency", max_concurrency) {
        let n = n.max(1);
        tuning.rm_concurrency = n;
        tuning.nm_concurrency = n;
        tuning.other_concurrency = n;
    }
    let mut cache = CacheConfig::default();
    if let Some((n, _)) = pick!("cache_max_bytes", cache_max_bytes) {
        cache.max_bytes = n.max(1024 * 1024);
    }

    Ok(Config {
        rm_urls,
        spark_history,
        jhs,
        timeline,
        bind,
        port,
        port_explicit,
        no_open,
        user,
        headers,
        ca_cert,
        insecure,
        token,
        allowed_hosts,
        assets_dir,
        base_path,
        http_policy,
        log_server_url: hadoop.log_server_url.clone(),
        tuning,
        cache,
        ha: HaConfig::default(),
        sources,
        discovery: hadoop,
    })
}

/// `K: V` or `K:V` → pair. Header values may legitimately contain `:`.
pub fn parse_header(s: &str) -> Result<(String, String), ConfigError> {
    match s.split_once(':') {
        Some((k, v)) if !k.trim().is_empty() => Ok((k.trim().to_string(), v.trim().to_string())),
        _ => err(format!("invalid header '{s}': expected 'Name: value'")),
    }
}

/// Parse a service URL. Bare `host`/`host:port` get a scheme (`https` if `https_default`) and, if no
/// port was given and `default_port` is set, that port. Returns it without trailing slash.
pub fn parse_service_url(
    raw: &str,
    https_default: bool,
    default_port: Option<u16>,
) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty URL".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("{}://{raw}", if https_default { "https" } else { "http" })
    };
    let mut u = Url::parse(&with_scheme).map_err(|e| e.to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme '{}'", u.scheme()));
    }
    if u.host_str().is_none() {
        return Err("missing host".into());
    }
    if u.query().is_some() || u.fragment().is_some() {
        return Err("must not contain a query string or fragment".into());
    }
    if u.port().is_none()
        && !raw.contains("://")
        && let Some(p) = default_port
    {
        let _ = u.set_port(Some(p));
    }
    let path = u.path().trim_end_matches('/').to_string();
    u.set_path(&path);
    Ok(u)
}

/// URL → `host:port` (port defaulted from scheme) — the identity we use for upstreams.
pub fn authority_of(u: &Url) -> String {
    let host = u.host_str().unwrap_or("?");
    match u.port_or_known_default() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

/// URL without a trailing slash, for display / JSON.
pub fn url_string(u: &Url) -> String {
    u.as_str().trim_end_matches('/').to_string()
}

fn parse_bind(s: &str) -> Result<IpAddr, ConfigError> {
    let s = s.trim();
    if s.eq_ignore_ascii_case("localhost") {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    s.trim_matches(|c| c == '[' || c == ']')
        .parse::<IpAddr>()
        .map_err(|_| {
            ConfigError(format!(
                "--bind '{s}' is not an IP address (use e.g. 127.0.0.1, 0.0.0.0, ::1)"
            ))
        })
}

/// Allowed Host header entries: lowercase `host`, `host:port`, `[v6]`, or `*`.
fn normalize_allowed_host(s: &str) -> Result<String, ConfigError> {
    let s = s.trim().to_ascii_lowercase();
    let s = s
        .strip_prefix("http://")
        .or_else(|| s.strip_prefix("https://"))
        .unwrap_or(&s)
        .trim_end_matches('/')
        .to_string();
    if s.is_empty() || s.contains('/') || s.contains(char::is_whitespace) {
        return err(format!("invalid --allowed-host '{s}'"));
    }
    Ok(s)
}

/// `--base-path`: `""`/`/` ⇒ root, else `/a/b` (no trailing slash, no `//`, URL-safe characters only).
pub fn normalize_base_path(s: &str) -> Result<String, ConfigError> {
    let t = s.trim();
    if t.is_empty() || t == "/" {
        return Ok(String::new());
    }
    if !t.starts_with('/') {
        return err(format!("--base-path '{t}' must start with '/'"));
    }
    let t = t.trim_end_matches('/');
    if t.contains("//")
        || t.split('/').any(|seg| seg == "." || seg == "..")
        || !t
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~/".contains(c))
    {
        return err(format!(
            "--base-path '{t}' may only contain letters, digits and - . _ ~ / (no empty or dot segments)"
        ));
    }
    Ok(t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn layer(name: &str, f: impl FnOnce(&mut PartialConfig)) -> Layer {
        let mut p = PartialConfig::default();
        f(&mut p);
        Layer::new(name, p)
    }

    fn hadoop(rm: &[&str]) -> HadoopDiscovery {
        HadoopDiscovery {
            conf_dir: Some(Path::new("/etc/hadoop/conf").into()),
            rm_urls: rm.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn precedence_flag_over_file_over_hadoop_over_default() {
        let flag = layer("flag", |p| p.rm = Some(vec!["flaghost:1".into()]));
        let file = layer("config file", |p| p.rm = Some(vec!["filehost:2".into()]));
        let h = hadoop(&["http://hadoophost:3"]);

        let c = resolve(vec![flag.clone(), file.clone()], h.clone()).unwrap();
        assert_eq!(url_string(&c.rm_urls[0]), "http://flaghost:1");
        assert_eq!(c.source("rm"), "flag");

        let c = resolve(vec![file], h.clone()).unwrap();
        assert_eq!(url_string(&c.rm_urls[0]), "http://filehost:2");
        assert_eq!(c.source("rm"), "config file");

        let c = resolve(vec![], h).unwrap();
        assert_eq!(url_string(&c.rm_urls[0]), "http://hadoophost:3");
        assert!(c.source("rm").starts_with("hadoop conf"));

        let c = resolve(vec![], HadoopDiscovery::default()).unwrap();
        assert_eq!(url_string(&c.rm_urls[0]), "http://localhost:8088");
        assert_eq!(c.source("rm"), "default");
        assert_eq!(c.port, DEFAULT_PORT);
        assert!(!c.port_explicit);
        assert_eq!(c.bind, IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn explicit_empty_disables_discovered_service() {
        let mut h = hadoop(&[]);
        h.jhs_url = Some("http://jhs:19888".into());
        let c = resolve(vec![], h.clone()).unwrap();
        assert_eq!(c.jhs.len(), 1);
        let c = resolve(
            vec![layer("flag", |p| {
                p.jhs = Some(StringList::One(String::new()))
            })],
            h,
        )
        .unwrap();
        assert!(c.jhs.is_empty());
    }

    #[test]
    fn http_policy_inferred_from_rm_scheme() {
        let c = Config::for_rm("https://rm:8090").unwrap();
        assert_eq!(c.http_policy, HttpPolicy::HttpsOnly);
        let c = Config::for_rm("rm:8088").unwrap();
        assert_eq!(c.http_policy, HttpPolicy::HttpOnly);
    }

    #[test]
    fn toml_parse_and_unknown_key_rejected() {
        let p = PartialConfig::from_toml(
            "rm = [\"a:1\", \"b:2\"]\nport = 9000\n[headers]\nX-Test = \"1\"\n",
        );
        assert!(matches!(p.unwrap().headers, Some(HeaderSpec::Map(_))));
        let p = PartialConfig::from_toml(
            "rm = [\"a:1\", \"b:2\"]\nport = 9000\nheaders = [\"X-A: b: c\"]\n",
        )
        .unwrap();
        let c = resolve(
            vec![Layer::new("config file", p)],
            HadoopDiscovery::default(),
        )
        .unwrap();
        assert_eq!(c.rm_urls.len(), 2);
        assert_eq!(c.port, 9000);
        assert!(c.port_explicit);
        assert_eq!(c.headers, vec![("X-A".to_string(), "b: c".to_string())]);
        assert!(PartialConfig::from_toml("bogus = 1").is_err());
    }

    #[test]
    fn base_path_validation() {
        assert_eq!(normalize_base_path("/").unwrap(), "");
        assert_eq!(normalize_base_path("/burrow/").unwrap(), "/burrow");
        assert!(normalize_base_path("yarn").is_err());
        assert!(normalize_base_path("/a//b").is_err());
        assert!(normalize_base_path("/a/../b").is_err());
        assert!(normalize_base_path("/a b").is_err());
    }

    #[test]
    fn url_and_bind_validation() {
        assert!(parse_service_url("ftp://x", false, None).is_err());
        assert!(parse_service_url("http://x/?q=1", false, None).is_err());
        assert_eq!(
            url_string(&parse_service_url("host", false, Some(8088)).unwrap()),
            "http://host:8088"
        );
        assert_eq!(
            url_string(&parse_service_url("https://gw/rm/", false, None).unwrap()),
            "https://gw/rm"
        );
        assert!(parse_bind("not-an-ip").is_err());
        assert_eq!(parse_bind("::1").unwrap().to_string(), "::1");
        assert!(parse_header("nocolon").is_err());
    }
}
