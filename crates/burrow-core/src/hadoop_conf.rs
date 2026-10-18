//! Hadoop client-configuration auto-discovery (PLAN §6.1, lowest-but-one precedence layer).
//!
//! Reads `yarn-site.xml` (+ `core-site.xml`, `mapred-site.xml` when present) and `spark-defaults.conf`
//! and derives: RM web addresses (single or HA), `yarn.http.policy`, the log-server / JobHistory URL,
//! the timeline-service address and the Spark History Server address. Pure: all environment access is
//! funnelled through [`DiscoverInput`] so tests can point it at sample directories.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config::HttpPolicy;

const DEFAULT_CONF_DIR: &str = "/etc/hadoop/conf";

#[derive(Debug, Clone, Default)]
pub struct DiscoverInput {
    pub hadoop_conf_dir: Option<PathBuf>,
    pub yarn_conf_dir: Option<PathBuf>,
    pub spark_conf_dir: Option<PathBuf>,
    pub spark_home: Option<PathBuf>,
    /// Fallback directories searched after the env-provided ones (default: `/etc/hadoop/conf`).
    pub fallback_dirs: Vec<PathBuf>,
    /// Extra Spark conf dir fallbacks (default: `/etc/spark/conf`).
    pub spark_fallback_dirs: Vec<PathBuf>,
}

impl DiscoverInput {
    pub fn from_env() -> Self {
        let var = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Self {
            hadoop_conf_dir: var("HADOOP_CONF_DIR"),
            yarn_conf_dir: var("YARN_CONF_DIR"),
            spark_conf_dir: var("SPARK_CONF_DIR"),
            spark_home: var("SPARK_HOME"),
            fallback_dirs: vec![PathBuf::from(DEFAULT_CONF_DIR)],
            spark_fallback_dirs: vec![PathBuf::from("/etc/spark/conf")],
        }
    }

    fn hadoop_dirs(&self) -> Vec<PathBuf> {
        let mut v = Vec::new();
        v.extend(self.hadoop_conf_dir.clone());
        v.extend(self.yarn_conf_dir.clone());
        v.extend(self.fallback_dirs.iter().cloned());
        v
    }

    fn spark_dirs(&self, hadoop_dir: Option<&Path>) -> Vec<PathBuf> {
        let mut v = Vec::new();
        v.extend(self.spark_conf_dir.clone());
        if let Some(h) = &self.spark_home {
            v.push(h.join("conf"));
        }
        v.extend(self.spark_fallback_dirs.iter().cloned());
        v.extend(hadoop_dir.map(Path::to_path_buf));
        v
    }
}

#[derive(Debug, Clone, Default)]
pub struct HadoopDiscovery {
    /// Directory that supplied `yarn-site.xml` (None ⇒ nothing found).
    pub conf_dir: Option<PathBuf>,
    pub files: Vec<PathBuf>,
    /// RM base URLs in rm-ids order; one entry unless HA is enabled.
    pub rm_urls: Vec<String>,
    pub ha_enabled: bool,
    pub http_policy: Option<HttpPolicy>,
    pub log_server_url: Option<String>,
    pub jhs_url: Option<String>,
    pub timeline_url: Option<String>,
    pub spark_history: Option<String>,
    pub spark_conf_file: Option<PathBuf>,
    pub warnings: Vec<String>,
}

pub fn discover(input: &DiscoverInput) -> HadoopDiscovery {
    let mut out = HadoopDiscovery::default();

    let dir = input
        .hadoop_dirs()
        .into_iter()
        .find(|d| d.join("yarn-site.xml").is_file());
    if let Some(dir) = &dir {
        let mut conf = Conf::default();
        // Later files override earlier ones: core < mapred < yarn (yarn-site wins on its own keys).
        for name in ["core-site.xml", "mapred-site.xml", "yarn-site.xml"] {
            let p = dir.join(name);
            if !p.is_file() {
                continue;
            }
            match std::fs::read_to_string(&p) {
                Ok(text) => match parse_site_xml(&text) {
                    Ok(props) => {
                        conf.props.extend(props);
                        out.files.push(p);
                    }
                    Err(e) => out
                        .warnings
                        .push(format!("{}: malformed XML ({e}); ignored", p.display())),
                },
                Err(e) => out
                    .warnings
                    .push(format!("{}: unreadable ({e}); ignored", p.display())),
            }
        }
        out.conf_dir = Some(dir.clone());
        derive_yarn(&conf, &mut out);
    }

    // spark-defaults.conf
    for d in input.spark_dirs(dir.as_deref()) {
        let p = d.join("spark-defaults.conf");
        if p.is_file() {
            match std::fs::read_to_string(&p) {
                Ok(text) => {
                    let props = parse_spark_defaults(&text);
                    if let Some(addr) = props.get("spark.yarn.historyServer.address") {
                        let tls = props
                            .get("spark.ssl.historyServer.enabled")
                            .or_else(|| props.get("spark.ssl.enabled"))
                            .is_some_and(|v| v.eq_ignore_ascii_case("true"));
                        out.spark_history = normalize_addr(addr, tls, 18080);
                        out.spark_conf_file = Some(p);
                        break;
                    }
                }
                Err(e) => out
                    .warnings
                    .push(format!("{}: unreadable ({e}); ignored", p.display())),
            }
        }
    }
    out
}

/// A flat Hadoop `Configuration` with `${var}` expansion.
#[derive(Default)]
struct Conf {
    props: HashMap<String, String>,
}

impl Conf {
    fn raw(&self, key: &str) -> Option<&str> {
        self.props
            .get(key)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    }

    /// Value with `${other.key}` substituted from this conf, then from the process env (Hadoop looks at
    /// system properties; env is the closest analogue). Depth-limited like Hadoop (20).
    fn get(&self, key: &str) -> Option<String> {
        self.raw(key).map(|v| self.expand(v, 0))
    }

    fn expand(&self, v: &str, depth: u8) -> String {
        if depth > 20 || !v.contains("${") {
            return v.to_string();
        }
        let mut out = String::with_capacity(v.len());
        let mut rest = v;
        while let Some(start) = rest.find("${") {
            out.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            match after.find('}') {
                Some(end) => {
                    let name = &after[..end];
                    let repl = self
                        .raw(name)
                        .map(|x| self.expand(x, depth + 1))
                        .or_else(|| std::env::var(name).ok());
                    match repl {
                        Some(r) => out.push_str(&r),
                        None => {
                            out.push_str("${");
                            out.push_str(name);
                            out.push('}');
                        }
                    }
                    rest = &after[end + 1..];
                }
                None => {
                    out.push_str(&rest[start..]);
                    rest = "";
                }
            }
        }
        out.push_str(rest);
        out
    }

    fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key).map(|v| v.eq_ignore_ascii_case("true"))
    }
}

fn derive_yarn(conf: &Conf, out: &mut HadoopDiscovery) {
    let policy = conf
        .get("yarn.http.policy")
        .and_then(|v| HttpPolicy::parse(&v));
    out.http_policy = policy;
    let https = policy == Some(HttpPolicy::HttpsOnly);

    let rm_addr = |suffix: &str, default_port: u16| -> Option<String> {
        let sfx = if suffix.is_empty() {
            String::new()
        } else {
            format!(".{suffix}")
        };
        let key = if https {
            format!("yarn.resourcemanager.webapp.https.address{sfx}")
        } else {
            format!("yarn.resourcemanager.webapp.address{sfx}")
        };
        if let Some(a) = conf.get(&key) {
            return normalize_addr(&a, https, default_port);
        }
        // No explicit address: Hadoop derives <hostname>:<default port>.
        let host_key = format!("yarn.resourcemanager.hostname{sfx}");
        conf.get(&host_key)
            .and_then(|h| normalize_addr(&format!("{h}:{default_port}"), https, default_port))
    };
    let default_port = if https { 8090 } else { 8088 };

    out.ha_enabled = conf
        .get_bool("yarn.resourcemanager.ha.enabled")
        .unwrap_or(false);
    if out.ha_enabled {
        let ids: Vec<String> = conf
            .get("yarn.resourcemanager.ha.rm-ids")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if ids.is_empty() {
            out.warnings.push(
                "yarn.resourcemanager.ha.enabled=true but ha.rm-ids is empty; falling back to the single-RM address"
                    .into(),
            );
        }
        for id in &ids {
            match rm_addr(id, default_port) {
                Some(u) => out.rm_urls.push(u),
                None => out.warnings.push(format!(
                    "HA rm-id '{id}' has neither yarn.resourcemanager.webapp.address.{id} nor hostname.{id}; skipped"
                )),
            }
        }
    }
    if out.rm_urls.is_empty() {
        if let Some(u) = rm_addr("", default_port) {
            out.rm_urls.push(u);
        } else if conf.raw("yarn.resourcemanager.hostname").is_none() {
            // Hadoop's own default is 0.0.0.0:8088 — i.e. "this machine".
            out.rm_urls.push(format!(
                "{}://localhost:{default_port}",
                if https { "https" } else { "http" }
            ));
        }
    }

    // Log server / JobHistory.
    if let Some(u) = conf.get("yarn.log.server.url") {
        if let Ok(parsed) = url::Url::parse(&u)
            && let Some(host) = parsed.host_str()
        {
            let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
            let prefix = parsed
                .path()
                .split_once("/jobhistory/")
                .map(|(prefix, _)| prefix)
                .unwrap_or("");
            out.jhs_url = Some(format!("{}://{host}{port}{prefix}", parsed.scheme()));
        }
        out.log_server_url = Some(u);
    }
    if out.jhs_url.is_none() {
        let key = if https {
            "mapreduce.jobhistory.webapp.https.address"
        } else {
            "mapreduce.jobhistory.webapp.address"
        };
        if let Some(a) = conf.get(key) {
            out.jhs_url = normalize_addr(&a, https, if https { 19890 } else { 19888 });
        }
    }

    // Timeline service (only when enabled).
    if conf
        .get_bool("yarn.timeline-service.enabled")
        .unwrap_or(false)
    {
        let key = if https {
            "yarn.timeline-service.webapp.https.address"
        } else {
            "yarn.timeline-service.webapp.address"
        };
        let port = if https { 8190 } else { 8188 };
        let addr = conf.get(key).or_else(|| {
            conf.get("yarn.timeline-service.hostname")
                .map(|h| format!("{h}:{port}"))
        });
        out.timeline_url = addr.and_then(|a| normalize_addr(&a, https, port));
    }
}

/// `host:port` / `host` / `scheme://host:port/prefix` → normalized service base URL, with wildcard binds mapped to localhost.
pub fn normalize_addr(addr: &str, https: bool, default_port: u16) -> Option<String> {
    let addr = addr.trim().trim_end_matches('/');
    if addr.is_empty() {
        return None;
    }
    let (scheme, rest) = match addr.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ((if https { "https" } else { "http" }).to_string(), addr),
    };
    let (authority, path) = rest
        .find('/')
        .map(|at| (&rest[..at], &rest[at..]))
        .unwrap_or((rest, ""));
    let (host, port) = split_host_port(authority);
    let host = match host {
        "0.0.0.0" | "[::]" | "::" | "" => "localhost",
        h => h,
    };
    let port = port.unwrap_or(default_port);
    Some(format!(
        "{scheme}://{host}:{port}{}",
        path.trim_end_matches('/')
    ))
}

fn split_host_port(s: &str) -> (&str, Option<u16>) {
    if let Some(stripped) = s.strip_prefix('[') {
        // [v6]:port
        if let Some(end) = stripped.find(']') {
            let host = &s[..end + 2];
            let port = s[end + 2..]
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok());
            return (host, port);
        }
    }
    match s.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h, p.parse::<u16>().ok()),
        _ => (s, None),
    }
}

/// Parse a Hadoop `*-site.xml` into name → value (last definition wins).
pub fn parse_site_xml(text: &str) -> Result<HashMap<String, String>, String> {
    use quick_xml::Reader;
    use quick_xml::events::Event;

    #[derive(PartialEq)]
    enum Field {
        None,
        Name,
        Value,
        Other,
    }

    let mut reader = Reader::from_str(text);
    let mut props = HashMap::new();
    let mut in_property = false;
    let mut field = Field::None;
    let mut name = String::new();
    let mut value = String::new();
    let mut saw_root = false;

    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => match e.name().into_inner() {
                "configuration" => saw_root = true,
                "property" => {
                    in_property = true;
                    name.clear();
                    value.clear();
                }
                "name" if in_property => field = Field::Name,
                "value" if in_property => field = Field::Value,
                _ if in_property => field = Field::Other,
                _ => {}
            },
            Event::End(e) => match e.name().into_inner() {
                "property" => {
                    if in_property && !name.trim().is_empty() {
                        props.insert(name.trim().to_string(), value.clone());
                    }
                    in_property = false;
                    field = Field::None;
                }
                "name" | "value" => field = Field::None,
                _ if in_property => field = Field::None,
                _ => {}
            },
            Event::Text(t) if in_property => {
                let s = t.xml10_content();
                match field {
                    Field::Name => name.push_str(&s),
                    Field::Value => value.push_str(&s),
                    _ => {}
                }
            }
            Event::CData(t) if in_property => {
                let s = t.xml10_content();
                match field {
                    Field::Name => name.push_str(&s),
                    Field::Value => value.push_str(&s),
                    _ => {}
                }
            }
            Event::GeneralRef(r) if in_property => {
                let s = if let Ok(Some(c)) = r.resolve_char_ref() {
                    c.to_string()
                } else {
                    match &*r {
                        "amp" => "&".into(),
                        "lt" => "<".into(),
                        "gt" => ">".into(),
                        "quot" => "\"".into(),
                        "apos" => "'".into(),
                        other => format!("&{other};"),
                    }
                };
                match field {
                    Field::Name => name.push_str(&s),
                    Field::Value => value.push_str(&s),
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !saw_root {
        return Err("no <configuration> root element".into());
    }
    Ok(props)
}

/// Parse `spark-defaults.conf`: `key value` or `key=value` per line, `#` comments.
pub fn parse_spark_defaults(text: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let split = line.find(|c: char| c.is_whitespace() || c == '=');
        if let Some(i) = split {
            let key = line[..i].trim();
            let val = line[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
            if !key.is_empty() {
                m.insert(key.to_string(), val.trim().to_string());
            }
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn site(props: &[(&str, &str)]) -> String {
        let mut s = String::from("<?xml version=\"1.0\"?>\n<configuration>\n");
        for (k, v) in props {
            s.push_str(&format!(
                "  <property><name>{k}</name><value>{v}</value></property>\n"
            ));
        }
        s.push_str("</configuration>\n");
        s
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("burrow-hconf-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn input(dir: &Path) -> DiscoverInput {
        DiscoverInput {
            hadoop_conf_dir: Some(dir.to_path_buf()),
            ..Default::default()
        }
    }

    #[test]
    fn single_rm_hostname_and_explicit_address() {
        let d = tmpdir("single");
        write(
            &d,
            "yarn-site.xml",
            &site(&[("yarn.resourcemanager.hostname", "rm.example.com")]),
        );
        let r = discover(&input(&d));
        assert_eq!(r.rm_urls, vec!["http://rm.example.com:8088"]);
        assert!(!r.ha_enabled);

        write(
            &d,
            "yarn-site.xml",
            &site(&[
                ("yarn.resourcemanager.hostname", "rm.example.com"),
                (
                    "yarn.resourcemanager.webapp.address",
                    "${yarn.resourcemanager.hostname}:9099",
                ),
            ]),
        );
        let r = discover(&input(&d));
        assert_eq!(r.rm_urls, vec!["http://rm.example.com:9099"]);
    }

    #[test]
    fn wildcard_and_missing_default_to_localhost() {
        let d = tmpdir("wild");
        write(
            &d,
            "yarn-site.xml",
            &site(&[("yarn.resourcemanager.webapp.address", "0.0.0.0:8088")]),
        );
        assert_eq!(discover(&input(&d)).rm_urls, vec!["http://localhost:8088"]);
        write(&d, "yarn-site.xml", &site(&[]));
        assert_eq!(discover(&input(&d)).rm_urls, vec!["http://localhost:8088"]);
    }

    #[test]
    fn ha_rm_ids_in_order() {
        let d = tmpdir("ha");
        write(
            &d,
            "yarn-site.xml",
            &site(&[
                ("yarn.resourcemanager.ha.enabled", "true"),
                ("yarn.resourcemanager.ha.rm-ids", "rm2, rm1"),
                (
                    "yarn.resourcemanager.webapp.address.rm1",
                    "rm1.example.com:8088",
                ),
                ("yarn.resourcemanager.hostname.rm2", "rm2.example.com"),
                ("yarn.resourcemanager.webapp.address", "ignored:1"),
            ]),
        );
        let r = discover(&input(&d));
        assert!(r.ha_enabled);
        assert_eq!(
            r.rm_urls,
            vec!["http://rm2.example.com:8088", "http://rm1.example.com:8088"]
        );
    }

    #[test]
    fn ha_missing_id_address_warns() {
        let d = tmpdir("ha-missing");
        write(
            &d,
            "yarn-site.xml",
            &site(&[
                ("yarn.resourcemanager.ha.enabled", "true"),
                ("yarn.resourcemanager.ha.rm-ids", "rm1,rm2"),
                ("yarn.resourcemanager.webapp.address.rm1", "a:1"),
            ]),
        );
        let r = discover(&input(&d));
        assert_eq!(r.rm_urls, vec!["http://a:1"]);
        assert!(r.warnings.iter().any(|w| w.contains("rm2")));
    }

    #[test]
    fn https_policy_uses_https_addresses_and_ports() {
        let d = tmpdir("https");
        write(
            &d,
            "yarn-site.xml",
            &site(&[
                ("yarn.http.policy", "HTTPS_ONLY"),
                ("yarn.resourcemanager.hostname", "secure.example.com"),
                (
                    "yarn.log.server.url",
                    "https://jhs.example.com:19890/jobhistory/logs",
                ),
                ("yarn.timeline-service.enabled", "true"),
                ("yarn.timeline-service.hostname", "ats.example.com"),
            ]),
        );
        let r = discover(&input(&d));
        assert_eq!(r.http_policy, Some(HttpPolicy::HttpsOnly));
        assert_eq!(r.rm_urls, vec!["https://secure.example.com:8090"]);
        assert_eq!(r.jhs_url.as_deref(), Some("https://jhs.example.com:19890"));
        assert_eq!(
            r.log_server_url.as_deref(),
            Some("https://jhs.example.com:19890/jobhistory/logs")
        );
        assert_eq!(
            r.timeline_url.as_deref(),
            Some("https://ats.example.com:8190")
        );
    }

    #[test]
    fn mapred_site_provides_jhs_and_entities_decode() {
        let d = tmpdir("mapred");
        write(
            &d,
            "yarn-site.xml",
            &site(&[("yarn.resourcemanager.hostname", "r")]),
        );
        write(
            &d,
            "mapred-site.xml",
            &site(&[("mapreduce.jobhistory.webapp.address", "jhs:19888")]),
        );
        assert_eq!(
            discover(&input(&d)).jhs_url.as_deref(),
            Some("http://jhs:19888")
        );

        let props = parse_site_xml(
            "<configuration><property><name>a</name><value>x&amp;y&lt;<![CDATA[z]]></value></property></configuration>",
        )
        .unwrap();
        assert_eq!(props["a"], "x&y<z");
    }

    #[test]
    fn spark_defaults_history_address() {
        let d = tmpdir("spark");
        let s = tmpdir("spark-conf");
        write(&d, "yarn-site.xml", &site(&[]));
        write(
            &s,
            "spark-defaults.conf",
            "# comment\nspark.master yarn\nspark.yarn.historyServer.address   shs.example.com:18080\n",
        );
        let mut i = input(&d);
        i.spark_conf_dir = Some(s);
        let r = discover(&i);
        assert_eq!(
            r.spark_history.as_deref(),
            Some("http://shs.example.com:18080")
        );

        let m = parse_spark_defaults("a=b\nc   d e\n  # x\n");
        assert_eq!(m["a"], "b");
        assert_eq!(m["c"], "d e");
    }

    #[test]
    fn malformed_xml_is_a_warning_not_a_failure() {
        let d = tmpdir("bad");
        write(
            &d,
            "yarn-site.xml",
            "<configuration><property></wrong></configuration>",
        );
        let r = discover(&input(&d));
        assert!(r.warnings.iter().any(|w| w.contains("malformed")));
    }

    #[test]
    fn no_conf_dir_yields_nothing() {
        let r = discover(&DiscoverInput::default());
        assert!(r.conf_dir.is_none());
        assert!(r.rm_urls.is_empty());
    }
}
