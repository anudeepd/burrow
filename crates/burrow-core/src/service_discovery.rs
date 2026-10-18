//! Bounded, read-only discovery of service addresses advertised by the configured ResourceManager.
//!
//! RM configuration is administrator-controlled and may be used as a candidate upstream. Application
//! tracking destinations are suggestions only: when an app link points through the RM proxy, discovery may
//! inspect the RM's Location header, but it never follows the destination or forwards credentials there.

use std::time::Duration;

use serde::Deserialize;

use crate::core::Core;
use crate::hadoop_conf::parse_site_xml;
use crate::http::{BodyMode, FetchReq, UpBody};

const CONFIG_PATH: &str = "/conf";
const APPS_PATH: &str = "/ws/v1/cluster/apps?states=FINISHED,FAILED,KILLED&limit=100";
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_PROXY_REDIRECT_CHECKS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceKind {
    JobHistory,
    SparkHistory,
}

impl ServiceKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::JobHistory => "JobHistory",
            Self::SparkHistory => "Spark History",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServiceCandidate {
    pub kind: ServiceKind,
    pub url: String,
    pub evidence: String,
    /// RM runtime configuration is set by the cluster operator and may be added to the active config.
    pub operator_configured: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DiscoveryReport {
    pub candidates: Vec<ServiceCandidate>,
    pub warnings: Vec<String>,
    pub log_server_url: Option<String>,
}

impl DiscoveryReport {
    pub fn merge(&mut self, candidate: ServiceCandidate) {
        if let Some(existing) = self
            .candidates
            .iter_mut()
            .find(|item| item.kind == candidate.kind && item.url == candidate.url)
        {
            if !existing.evidence.contains(&candidate.evidence) {
                existing.evidence.push_str("; ");
                existing.evidence.push_str(&candidate.evidence);
            }
            existing.operator_configured |= candidate.operator_configured;
        } else {
            self.candidates.push(candidate);
        }
    }
}

#[derive(Debug, Deserialize)]
struct ConfResponse {
    properties: Option<Vec<ConfProperty>>,
}

#[derive(Debug, Deserialize)]
struct ConfProperty {
    key: String,
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppsResponse {
    apps: Option<AppsList>,
}

#[derive(Debug, Deserialize)]
struct AppsList {
    app: Option<AppItems>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AppItems {
    Many(Vec<AppEntry>),
    One(AppEntry),
}

impl AppItems {
    fn into_vec(self) -> Vec<AppEntry> {
        match self {
            Self::Many(apps) => apps,
            Self::One(app) => vec![app],
        }
    }
}

#[derive(Debug, Deserialize)]
struct AppEntry {
    id: Option<String>,
    #[serde(rename = "applicationType")]
    application_type: Option<String>,
    #[serde(rename = "trackingUrl")]
    tracking_url: Option<String>,
}

/// Query the active RM for effective service settings and recent finished application tracking links.
/// App destinations are suggestions only; for RM-proxy links, inspect the RM's redirect without following it.
pub async fn discover(core: &Core) -> DiscoveryReport {
    let mut report = DiscoveryReport::default();

    // Bound startup discovery to one request timeout even when both RM endpoints are slow.
    let (conf_result, apps_result) =
        tokio::join!(rm_get(core, CONFIG_PATH), rm_get(core, APPS_PATH),);

    match conf_result {
        Ok(body) => match parse_conf(&body) {
            Ok(properties) => discover_properties(&properties, &mut report),
            Err(error) => report.warnings.push(format!(
                "cannot parse the ResourceManager configuration: {error}"
            )),
        },
        Err(error) => report.warnings.push(format!(
            "cannot read the ResourceManager configuration: {error}"
        )),
    }

    match apps_result {
        Ok(body) => match serde_json::from_slice::<AppsResponse>(&body) {
            Ok(doc) => {
                let mut proxy_checks = Vec::new();
                for app in doc
                    .apps
                    .into_iter()
                    .flat_map(|list| list.app)
                    .flat_map(AppItems::into_vec)
                {
                    let Some(tracking) = app.tracking_url.as_deref() else {
                        continue;
                    };
                    let app_id = app.id.as_deref().unwrap_or("unknown application");
                    let app_type = app
                        .application_type
                        .as_deref()
                        .unwrap_or("unknown application type");
                    if let Some(url) = spark_history_base_from_tracking(tracking) {
                        report.merge(ServiceCandidate {
                            kind: ServiceKind::SparkHistory,
                            url,
                            evidence: format!("tracking link for {app_id} ({app_type})"),
                            operator_configured: false,
                        });
                    }
                    if let Some(url) = job_history_base_from_tracking(tracking) {
                        report.merge(ServiceCandidate {
                            kind: ServiceKind::JobHistory,
                            url,
                            evidence: format!("tracking link for {app_id} ({app_type})"),
                            operator_configured: false,
                        });
                    }
                    if proxy_checks.len() < MAX_PROXY_REDIRECT_CHECKS
                        && let Some(path) = rm_proxy_path_from_tracking(tracking, app_id)
                    {
                        proxy_checks.push((app_id.to_string(), app_type.to_string(), path));
                    }
                }

                let redirects = futures_util::future::join_all(proxy_checks.into_iter().map(
                    |(app_id, app_type, path)| async move {
                        let result = tokio::time::timeout(
                            Duration::from_secs(4),
                            core.rm_pool().inspect_redirect(&path),
                        )
                        .await
                        .map_err(|_| "timed out".to_string())
                        .and_then(|result| result.map_err(|error| error.message));
                        (app_id, app_type, result)
                    },
                ))
                .await;
                for (app_id, app_type, result) in redirects {
                    match result {
                        Ok(Some(target)) => {
                            if let Some(url) = spark_history_base_from_tracking(&target) {
                                report.merge(ServiceCandidate {
                                    kind: ServiceKind::SparkHistory,
                                    url,
                                    evidence: format!(
                                        "ResourceManager redirect for {app_id} ({app_type})"
                                    ),
                                    operator_configured: false,
                                });
                            }
                            if let Some(url) = job_history_base_from_tracking(&target) {
                                report.merge(ServiceCandidate {
                                    kind: ServiceKind::JobHistory,
                                    url,
                                    evidence: format!(
                                        "ResourceManager redirect for {app_id} ({app_type})"
                                    ),
                                    operator_configured: false,
                                });
                            }
                        }
                        Ok(None) => {}
                        Err(error) => report.warnings.push(format!(
                            "cannot inspect the ResourceManager tracking redirect for {app_id}: {error}"
                        )),
                    }
                }
            }
            Err(error) => report.warnings.push(format!(
                "cannot parse the ResourceManager application list: {error}"
            )),
        },
        Err(error) => report.warnings.push(format!(
            "cannot read recent ResourceManager applications: {error}"
        )),
    }

    report
}

async fn rm_get(core: &Core, path: &str) -> Result<Vec<u8>, String> {
    let mut request = FetchReq::get(path, BodyMode::Buffer { cap: MAX_RESPONSE });
    request.accept = Some("application/json");
    let response = tokio::time::timeout(Duration::from_secs(8), core.rm.fetch(&request))
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|error| error.message)?;
    if !response.status.is_success() {
        return Err(format!("HTTP {}", response.status));
    }
    match response.body {
        UpBody::Full(body) => Ok(body.to_vec()),
        UpBody::Stream { .. } => Err("response exceeded the discovery size limit".into()),
    }
}

fn parse_conf(body: &[u8]) -> Result<std::collections::HashMap<String, String>, String> {
    if let Ok(doc) = serde_json::from_slice::<ConfResponse>(body) {
        return Ok(doc
            .properties
            .unwrap_or_default()
            .into_iter()
            .filter_map(|property| property.value.map(|value| (property.key, value)))
            .collect());
    }
    let text = std::str::from_utf8(body).map_err(|error| error.to_string())?;
    parse_site_xml(text)
}

fn discover_properties(
    properties: &std::collections::HashMap<String, String>,
    report: &mut DiscoveryReport,
) {
    if let Some(raw) = properties.get("yarn.log.server.url") {
        report.log_server_url = sanitized_base(raw);
        if let Some(url) = job_history_base_from_log_server(raw) {
            report.merge(ServiceCandidate {
                kind: ServiceKind::JobHistory,
                url,
                evidence: "ResourceManager effective yarn.log.server.url".into(),
                operator_configured: true,
            });
        }
    }

    if let Some(raw) = properties.get("spark.yarn.historyServer.address") {
        let tls = properties
            .get("spark.ssl.historyServer.enabled")
            .or_else(|| properties.get("spark.ssl.enabled"))
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        if let Some(url) = crate::hadoop_conf::normalize_addr(raw, tls, 18080) {
            report.merge(ServiceCandidate {
                kind: ServiceKind::SparkHistory,
                url,
                evidence: "ResourceManager effective Spark history setting".into(),
                operator_configured: true,
            });
        }
    }
}

/// `https://jhs.example/proxy/jobhistory/logs` → `https://jhs.example/proxy`.
fn job_history_base_from_log_server(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let path = url.path().to_string();
    if let Some(at) = path.find("/jobhistory/") {
        url.set_path(&path[..at]);
    } else if let Some(prefix) = path.strip_suffix("/jobhistory") {
        url.set_path(prefix);
    }
    url.set_query(None);
    url.set_fragment(None);
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    Some(crate::config::url_string(&url))
}

/// `https://jhs.example/proxy/jobhistory/job/job_1` → `https://jhs.example/proxy`.
fn job_history_base_from_tracking(raw: &str) -> Option<String> {
    base_before_marker(raw, "/jobhistory/")
}

/// `https://shs.example/prefix/history/application_1` → `https://shs.example/prefix`.
fn spark_history_base_from_tracking(raw: &str) -> Option<String> {
    base_before_marker(raw, "/history/")
}

fn rm_proxy_path_from_tracking(raw: &str, app_id: &str) -> Option<String> {
    if !crate::logs::source::is_app_id(app_id) {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let marker = format!("/proxy/{app_id}");
    let path = url.path();
    let at = path.rfind(&marker)?;
    let tail = &path[at + marker.len()..];
    if !tail.is_empty() && tail != "/" {
        return None;
    }
    Some(format!("{marker}/"))
}

fn base_before_marker(raw: &str, marker: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let path = url.path().to_string();
    let at = path.find(marker)?;
    url.set_path(&path[..at]);
    url.set_query(None);
    url.set_fragment(None);
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    Some(crate::config::url_string(&url))
}

fn sanitized_base(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_fragment(None);
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        task::JoinHandle,
    };

    #[derive(Clone)]
    struct TestResponse {
        status: u16,
        location: Option<String>,
        body: String,
    }

    impl TestResponse {
        fn json(status: u16, body: impl Into<String>) -> Self {
            Self {
                status,
                location: None,
                body: body.into(),
            }
        }

        fn redirect(location: impl Into<String>) -> Self {
            Self {
                status: 302,
                location: Some(location.into()),
                body: String::new(),
            }
        }
    }

    struct TestServer {
        base: String,
        requests: Arc<Mutex<Vec<String>>>,
        task: JoinHandle<()>,
    }

    impl TestServer {
        async fn start(handler: impl Fn(&str) -> TestResponse + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let request_log = requests.clone();
            let handler: Arc<dyn Fn(&str) -> TestResponse + Send + Sync> = Arc::new(handler);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
                    let requests = request_log.clone();
                    let handler = handler.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(stream);
                        let mut request_line = String::new();
                        if reader.read_line(&mut request_line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        let path = request_line
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or_default()
                            .to_string();
                        loop {
                            let mut header = String::new();
                            if reader.read_line(&mut header).await.unwrap_or(0) == 0
                                || header == "\r\n"
                            {
                                break;
                            }
                        }
                        requests.lock().unwrap().push(path.clone());
                        let response = handler(&path);
                        let reason = match response.status {
                            200 => "OK",
                            302 => "Found",
                            503 => "Service Unavailable",
                            _ => "Test Response",
                        };
                        let mut wire = format!(
                            "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                            response.status,
                            response.body.len()
                        );
                        if let Some(location) = response.location {
                            wire.push_str(&format!("Location: {location}\r\n"));
                        }
                        wire.push_str("\r\n");
                        wire.push_str(&response.body);
                        let _ = reader.get_mut().write_all(wire.as_bytes()).await;
                    });
                }
            });
            Self {
                base: format!("http://{addr}"),
                requests,
                task,
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[test]
    fn parses_json_and_xml_configuration_and_rejects_invalid_bytes() {
        let json = br#"{"properties":[{"key":"a","value":"one"},{"key":"missing","value":null}]}"#;
        assert_eq!(
            parse_conf(json).unwrap(),
            [("a".into(), "one".into())].into()
        );

        let xml = br#"<configuration><property><name>yarn.log.server.url</name><value>https://jhs.example/jobhistory/logs</value></property></configuration>"#;
        assert_eq!(
            parse_conf(xml).unwrap()["yarn.log.server.url"],
            "https://jhs.example/jobhistory/logs"
        );
        assert!(parse_conf(b"\xff").is_err());
        assert!(parse_conf(b"<configuration><property></wrong></configuration>").is_err());
    }

    #[test]
    fn app_items_accept_single_objects_and_arrays() {
        let single: AppItems = serde_json::from_str(
            r#"{"id":"application_1_0001","applicationType":"SPARK","trackingUrl":"https://shs/history/application_1_0001"}"#,
        )
        .unwrap();
        assert_eq!(single.into_vec().len(), 1);

        let many: AppItems =
            serde_json::from_str(r#"[{"id":"application_1_0001"},{"id":"application_1_0002"}]"#)
                .unwrap();
        assert_eq!(many.into_vec().len(), 2);
    }

    #[test]
    fn report_merge_keeps_unique_evidence_and_operator_provenance() {
        let mut report = DiscoveryReport::default();
        report.merge(ServiceCandidate {
            kind: ServiceKind::SparkHistory,
            url: "https://shs.example".into(),
            evidence: "app tracking link".into(),
            operator_configured: false,
        });
        report.merge(ServiceCandidate {
            kind: ServiceKind::SparkHistory,
            url: "https://shs.example".into(),
            evidence: "app tracking link".into(),
            operator_configured: false,
        });
        report.merge(ServiceCandidate {
            kind: ServiceKind::SparkHistory,
            url: "https://shs.example".into(),
            evidence: "RM configuration".into(),
            operator_configured: true,
        });

        assert_eq!(report.candidates.len(), 1);
        assert_eq!(
            report.candidates[0].evidence,
            "app tracking link; RM configuration"
        );
        assert!(report.candidates[0].operator_configured);
        assert_eq!(ServiceKind::JobHistory.label(), "JobHistory");
        assert_eq!(ServiceKind::SparkHistory.label(), "Spark History");
    }

    #[test]
    fn runtime_properties_respect_tls_precedence_and_safe_bases() {
        let mut props = std::collections::HashMap::from([
            (
                "yarn.log.server.url".to_string(),
                "https://user:secret@jhs.example/proxy/jobhistory/logs?token=x#frag".to_string(),
            ),
            (
                "spark.yarn.historyServer.address".to_string(),
                "shs.example:18080".to_string(),
            ),
            (
                "spark.ssl.historyServer.enabled".to_string(),
                "false".to_string(),
            ),
            ("spark.ssl.enabled".to_string(), "true".to_string()),
        ]);
        let mut report = DiscoveryReport::default();
        discover_properties(&props, &mut report);

        assert_eq!(
            report.log_server_url.as_deref(),
            Some("https://jhs.example/proxy/jobhistory/logs?token=x")
        );
        assert!(report.candidates.iter().any(|candidate| {
            candidate.kind == ServiceKind::JobHistory
                && candidate.url == "https://jhs.example/proxy"
                && candidate.operator_configured
        }));
        assert!(report.candidates.iter().any(|candidate| {
            candidate.kind == ServiceKind::SparkHistory
                && candidate.url == "http://shs.example:18080"
        }));

        props.insert(
            "spark.ssl.historyServer.enabled".to_string(),
            "TRUE".to_string(),
        );
        let mut tls_report = DiscoveryReport::default();
        discover_properties(&props, &mut tls_report);
        assert!(tls_report.candidates.iter().any(|candidate| {
            candidate.kind == ServiceKind::SparkHistory
                && candidate.url == "https://shs.example:18080"
        }));
    }

    #[test]
    fn tracking_parsers_strip_sensitive_url_parts_and_reject_unsafe_targets() {
        assert_eq!(
            job_history_base_from_log_server(
                "https://user:secret@jhs.example/proxy/jobhistory/logs?token=x#frag"
            )
            .as_deref(),
            Some("https://jhs.example/proxy")
        );
        assert_eq!(
            job_history_base_from_log_server("https://jhs.example/proxy/jobhistory").as_deref(),
            Some("https://jhs.example/proxy")
        );
        assert_eq!(
            job_history_base_from_tracking(
                "https://user:secret@jhs.example/proxy/jobhistory/job/application_1_0001?x=1#frag"
            )
            .as_deref(),
            Some("https://jhs.example/proxy")
        );
        assert_eq!(
            spark_history_base_from_tracking(
                "https://shs.example/prefix/history/application_1_0001"
            )
            .as_deref(),
            Some("https://shs.example/prefix")
        );
        assert_eq!(
            rm_proxy_path_from_tracking(
                "http://rm.example/proxy/application_1_0001",
                "application_1_0001"
            )
            .as_deref(),
            Some("/proxy/application_1_0001/")
        );
        assert_eq!(
            rm_proxy_path_from_tracking(
                "http://rm.example/proxy/application_1_0001/logs",
                "application_1_0001"
            ),
            None
        );
        assert_eq!(
            rm_proxy_path_from_tracking(
                "ftp://rm.example/proxy/application_1_0001",
                "application_1_0001"
            ),
            None
        );
        assert_eq!(sanitized_base("ftp://jhs.example/logs"), None);
        assert_eq!(
            sanitized_base("https://user:secret@jhs.example/logs?x=1#frag").as_deref(),
            Some("https://jhs.example/logs?x=1")
        );
    }

    #[tokio::test]
    async fn discovery_merges_rm_config_and_tracking_without_contacting_redirect_targets() {
        let external = TestServer::start(|_| TestResponse::json(200, "{}")).await;
        let external_base = external.base.clone();
        let apps = serde_json::json!({
            "apps": {
                "app": [
                    {
                        "id": "application_1_0001",
                        "applicationType": "SPARK",
                        "trackingUrl": "http://rm-proxy.invalid/proxy/application_1_0001"
                    },
                    {
                        "id": "application_1_0002",
                        "applicationType": "SPARK",
                        "trackingUrl": "http://rm-proxy.invalid/proxy/application_1_0002"
                    },
                    {
                        "id": "application_1_0003",
                        "applicationType": "MAPREDUCE",
                        "trackingUrl": "http://rm-proxy.invalid/proxy/application_1_0003"
                    },
                    {
                        "id": "application_1_0004",
                        "applicationType": "SPARK",
                        "trackingUrl": "http://rm-proxy.invalid/proxy/application_1_0004"
                    },
                    {
                        "id": "application_1_0005",
                        "applicationType": "MAPREDUCE",
                        "trackingUrl": "https://jhs.example/proxy/jobhistory/job/application_1_0005"
                    },
                    {
                        "id": "application_1_0006",
                        "applicationType": "SPARK",
                        "trackingUrl": "https://suggestion.example/prefix/history/application_1_0006?x=1#frag"
                    }
                ]
            }
        })
        .to_string();
        let conf = serde_json::json!({
            "properties": [
                {
                    "key": "yarn.log.server.url",
                    "value": "https://user:secret@jhs.example/proxy/jobhistory/logs?token=x#frag"
                },
                {
                    "key": "spark.yarn.historyServer.address",
                    "value": "shs.example:18080"
                },
                { "key": "spark.ssl.historyServer.enabled", "value": "true" },
                { "key": "spark.ssl.enabled", "value": "false" }
            ]
        })
        .to_string();
        let rm = TestServer::start(move |path| match path {
            CONFIG_PATH => TestResponse::json(200, conf.clone()),
            APPS_PATH => TestResponse::json(200, apps.clone()),
            "/proxy/application_1_0001/" => {
                TestResponse::redirect(format!("{external_base}/history/application_1_0001"))
            }
            "/proxy/application_1_0002/" => TestResponse::json(200, "{}"),
            "/proxy/application_1_0003/" => TestResponse::redirect(
                "http://jhs-redirect.example/proxy/jobhistory/job/application_1_0003",
            ),
            _ => TestResponse::json(404, "{}"),
        })
        .await;
        let core = crate::core::Core::new(Config::for_rm(&rm.base).unwrap()).unwrap();

        let report = discover(&core).await;

        assert!(report.warnings.is_empty());
        assert_eq!(
            report.log_server_url.as_deref(),
            Some("https://jhs.example/proxy/jobhistory/logs?token=x")
        );
        let configured_jhs = report
            .candidates
            .iter()
            .find(|candidate| {
                candidate.kind == ServiceKind::JobHistory
                    && candidate.url == "https://jhs.example/proxy"
            })
            .unwrap();
        assert!(configured_jhs.operator_configured);
        assert!(
            configured_jhs
                .evidence
                .contains("ResourceManager effective")
        );
        assert!(configured_jhs.evidence.contains("application_1_0005"));
        assert!(report.candidates.iter().any(|candidate| {
            candidate.kind == ServiceKind::SparkHistory
                && candidate.url == "https://shs.example:18080"
                && candidate.operator_configured
        }));
        assert!(report.candidates.iter().any(|candidate| {
            candidate.kind == ServiceKind::SparkHistory
                && candidate.url == external.base
                && candidate.evidence.contains("ResourceManager redirect")
        }));
        assert!(report.candidates.iter().any(|candidate| {
            candidate.kind == ServiceKind::JobHistory
                && candidate.url == "http://jhs-redirect.example/proxy"
                && candidate.evidence.contains("ResourceManager redirect")
        }));
        assert!(report.candidates.iter().any(|candidate| {
            candidate.kind == ServiceKind::SparkHistory
                && candidate.url == "https://suggestion.example/prefix"
                && !candidate.operator_configured
        }));

        let requests = rm.requests();
        assert!(requests.iter().any(|path| path == CONFIG_PATH));
        assert!(requests.iter().any(|path| path == APPS_PATH));
        let proxy_requests = requests
            .iter()
            .filter(|path| path.starts_with("/proxy/"))
            .collect::<Vec<_>>();
        assert_eq!(proxy_requests.len(), MAX_PROXY_REDIRECT_CHECKS);
        assert!(
            !proxy_requests
                .iter()
                .any(|path| path.contains("application_1_0004"))
        );
        assert!(external.requests().is_empty());
    }

    #[tokio::test]
    async fn discovery_reports_rm_status_and_bad_application_documents() {
        let rm = TestServer::start(|path| match path {
            CONFIG_PATH => TestResponse::json(503, "{}"),
            APPS_PATH => TestResponse::json(200, "not json"),
            _ => TestResponse::json(404, "{}"),
        })
        .await;
        let core = crate::core::Core::new(Config::for_rm(&rm.base).unwrap()).unwrap();

        let report = discover(&core).await;

        assert!(report.candidates.is_empty());
        assert!(report.warnings.iter().any(|warning| {
            warning.contains("cannot read the ResourceManager configuration: HTTP 503")
        }));
        assert!(
            report.warnings.iter().any(
                |warning| warning.contains("cannot parse the ResourceManager application list")
            )
        );
    }
}
