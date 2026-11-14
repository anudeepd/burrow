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

fn non_empty_path(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.filter(|v| !v.is_empty()).map(PathBuf::from)
}

impl DiscoverInput {
    pub fn from_env() -> Self {
        Self {
            hadoop_conf_dir: non_empty_path(std::env::var_os("HADOOP_CONF_DIR")),
            yarn_conf_dir: non_empty_path(std::env::var_os("YARN_CONF_DIR")),
            spark_conf_dir: non_empty_path(std::env::var_os("SPARK_CONF_DIR")),
            spark_home: non_empty_path(std::env::var_os("SPARK_HOME")),
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
    discover_with_reader(input, |path| std::fs::read_to_string(path))
}

fn discover_with_reader(
    input: &DiscoverInput,
    read_to_string: impl Fn(&Path) -> std::io::Result<String>,
) -> HadoopDiscovery {
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
            match read_to_string(&p) {
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
            match read_to_string(&p) {
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
        } else {
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
            "<configuration><property><name>a</name><value>x&amp;y&lt;<![CDATA[z]]></value><extra><![CDATA[ignored]]>&unknown;</extra></property></configuration>",
        )
        .unwrap();
        assert_eq!(props["a"], "x&y<z");

        let fields = parse_site_xml(
            "<other><ignored/></other><configuration><other><ignored/></other><property><name><![CDATA[a]]></name><value>one<![CDATA[ two]]>&amp;three</value><extra>x</extra></property></configuration>",
        )
        .unwrap();
        assert_eq!(fields.get("a").map(String::as_str), Some("one two&three"));
    }

    #[test]
    fn env_paths_ignore_empty_values() {
        assert_eq!(
            non_empty_path(Some(std::ffi::OsString::from("/opt/hadoop/conf"))),
            Some(PathBuf::from("/opt/hadoop/conf"))
        );
        assert_eq!(non_empty_path(Some(std::ffi::OsString::new())), None);
        assert_eq!(non_empty_path(None), None);
    }

    #[test]
    fn spark_defaults_history_tls_falls_back_to_the_global_spark_setting() {
        let d = tmpdir("spark-tls");
        let s = tmpdir("spark-tls-conf");
        write(&d, "yarn-site.xml", &site(&[]));
        write(
            &s,
            "spark-defaults.conf",
            "spark.yarn.historyServer.address shs.example.com:18080\nspark.ssl.enabled true\n",
        );
        let mut i = input(&d);
        i.spark_conf_dir = Some(s);
        assert_eq!(
            discover(&i).spark_history.as_deref(),
            Some("https://shs.example.com:18080")
        );
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

        let m = parse_spark_defaults("a=b\nc   d e\n  # x\n = ignored\norphan\n");
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
    fn unreadable_configuration_files_are_skipped_with_warnings() {
        let hadoop = tmpdir("unreadable-hadoop");
        let spark = tmpdir("unreadable-spark");
        write(&hadoop, "yarn-site.xml", &site(&[]));
        write(&hadoop, "core-site.xml", &site(&[("test.key", "value")]));
        write(
            &spark,
            "spark-defaults.conf",
            "spark.yarn.historyServer.address shs:18080",
        );
        let mut input = input(&hadoop);
        input.spark_conf_dir = Some(spark);

        let report = discover_with_reader(&input, |path| {
            if path
                .file_name()
                .is_some_and(|name| name == "yarn-site.xml" || name == "spark-defaults.conf")
            {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                std::fs::read_to_string(path)
            }
        });

        assert_eq!(report.warnings.len(), 2);
        assert!(
            report
                .warnings
                .iter()
                .all(|warning| warning.contains("unreadable"))
        );
        assert!(report.spark_history.is_none());
    }

    #[test]
    fn no_conf_dir_yields_nothing() {
        let r = discover(&DiscoverInput::default());
        assert!(r.conf_dir.is_none());
        assert!(r.rm_urls.is_empty());
    }

    #[test]
    fn spark_home_and_yarn_conf_are_discovery_sources() {
        let yarn = tmpdir("yarn-env");
        write(&yarn, "yarn-site.xml", &site(&[]));
        let spark_home = tmpdir("spark-home");
        std::fs::create_dir_all(spark_home.join("conf")).unwrap();
        write(
            &spark_home.join("conf"),
            "spark-defaults.conf",
            "spark.yarn.historyServer.address shs.example:18080",
        );
        let input = DiscoverInput {
            yarn_conf_dir: Some(yarn.clone()),
            spark_home: Some(spark_home.clone()),
            fallback_dirs: vec![],
            spark_fallback_dirs: vec![],
            ..Default::default()
        };
        let found = discover(&input);
        assert_eq!(found.conf_dir.as_deref(), Some(yarn.as_path()));
        assert_eq!(
            found.spark_history.as_deref(),
            Some("http://shs.example:18080")
        );
        assert_eq!(
            found.spark_conf_file.as_deref(),
            Some(spark_home.join("conf/spark-defaults.conf").as_path())
        );
    }

    #[test]
    fn spark_defaults_without_a_history_address_are_ignored() {
        let hadoop = tmpdir("spark-no-address-hadoop");
        let spark = tmpdir("spark-no-address-config");
        write(&hadoop, "yarn-site.xml", &site(&[]));
        write(&spark, "spark-defaults.conf", "spark.master yarn\n");
        let mut input = input(&hadoop);
        input.spark_conf_dir = Some(spark);
        assert!(discover(&input).spark_history.is_none());
    }

    #[test]
    fn conf_expansion_preserves_unresolved_tokens_and_stops_after_depth_limit() {
        let conf = Conf::default();
        assert_eq!(
            conf.expand("before-${missing}-after ${open", 0),
            "before-${missing}-after ${open"
        );

        let mut conf = Conf::default();
        for depth in 0..22 {
            conf.props
                .insert(format!("k{depth}"), format!("${{k{}}}", depth + 1));
        }
        conf.props.insert("k22".into(), "done".into());
        let expanded = conf.expand("${k0}", 0);
        assert!(
            expanded.contains("${k"),
            "depth limit prevents unbounded expansion: {expanded}"
        );
    }

    #[test]
    fn hadoop_derivation_handles_empty_ha_ids_jobhistory_prefixes_and_timeline() {
        let mut conf = Conf::default();
        conf.props
            .insert("yarn.resourcemanager.ha.enabled".into(), "true".into());
        conf.props.insert(
            "yarn.log.server.url".into(),
            "https://jhs.example:19890/proxy/jobhistory/logs".into(),
        );
        conf.props.insert(
            "mapreduce.jobhistory.webapp.https.address".into(),
            "jhs-web.example".into(),
        );
        conf.props
            .insert("yarn.timeline-service.enabled".into(), "true".into());
        conf.props.insert(
            "yarn.timeline-service.webapp.https.address".into(),
            "[2001:db8::1]:8199".into(),
        );
        conf.props
            .insert("yarn.http.policy".into(), "HTTPS_ONLY".into());
        let mut found = HadoopDiscovery::default();
        derive_yarn(&conf, &mut found);

        assert!(found.ha_enabled);
        assert_eq!(found.rm_urls, vec!["https://localhost:8090"]);
        assert!(
            found
                .warnings
                .iter()
                .any(|warning| warning.contains("ha.rm-ids is empty"))
        );
        assert_eq!(
            found.log_server_url.as_deref(),
            Some("https://jhs.example:19890/proxy/jobhistory/logs")
        );
        assert_eq!(
            found.jhs_url.as_deref(),
            Some("https://jhs.example:19890/proxy")
        );
        assert_eq!(
            found.timeline_url.as_deref(),
            Some("https://[2001:db8::1]:8199")
        );

        let mut defaults = Conf::default();
        defaults.props.insert(
            "mapreduce.jobhistory.webapp.address".into(),
            "jhs-default.example".into(),
        );
        defaults
            .props
            .insert("yarn.timeline-service.enabled".into(), "true".into());
        let mut derived = HadoopDiscovery::default();
        derive_yarn(&defaults, &mut derived);
        assert_eq!(derived.rm_urls, vec!["http://localhost:8088"]);
        assert_eq!(
            derived.jhs_url.as_deref(),
            Some("http://jhs-default.example:19888")
        );
        assert!(derived.timeline_url.is_none());

        let mut malformed_log = Conf::default();
        malformed_log
            .props
            .insert("yarn.log.server.url".into(), "file:///var/logs".into());
        malformed_log.props.insert(
            "mapreduce.jobhistory.webapp.address".into(),
            "jhs-from-webapp.example".into(),
        );
        let mut malformed_found = HadoopDiscovery::default();
        derive_yarn(&malformed_log, &mut malformed_found);
        assert_eq!(
            malformed_found.jhs_url.as_deref(),
            Some("http://jhs-from-webapp.example:19888")
        );

        let mut https_jhs = Conf::default();
        https_jhs
            .props
            .insert("yarn.http.policy".into(), "HTTPS_ONLY".into());
        https_jhs.props.insert(
            "mapreduce.jobhistory.webapp.https.address".into(),
            "jhs-secure.example".into(),
        );
        let mut secure_found = HadoopDiscovery::default();
        derive_yarn(&https_jhs, &mut secure_found);
        assert_eq!(
            secure_found.jhs_url.as_deref(),
            Some("https://jhs-secure.example:19890")
        );
    }

    #[test]
    fn xml_and_address_parsers_cover_entities_malformed_roots_and_ipv6() {
        assert!(
            parse_site_xml("<not-configuration/>")
                .unwrap_err()
                .contains("no <configuration>")
        );
        let props = parse_site_xml(
            "<configuration><property><name> escaped </name><description>ignored</description><value>&gt;&quot;&apos;&#65;&unknown;</value></property><property><name>a&amp;b</name><value>value</value></property><property><name></name><value>skip</value></property></configuration>",
        ).unwrap();
        assert_eq!(props["escaped"], ">\"'A&unknown;");
        assert_eq!(props["a&b"], "value");
        assert_eq!(
            normalize_addr("  HTTPS://[2001:db8::2]/prefix/  ", false, 443).as_deref(),
            Some("https://[2001:db8::2]:443/prefix")
        );
        assert_eq!(normalize_addr("", false, 80), None);
        assert_eq!(
            split_host_port("[2001:db8::1]:8042"),
            ("[2001:db8::1]", Some(8042))
        );
        assert_eq!(split_host_port("[broken"), ("[broken", None));
        assert_eq!(split_host_port("host:notaport"), ("host", None));
        assert_eq!(split_host_port("2001:db8::1"), ("2001:db8::1", None));
    }
}
