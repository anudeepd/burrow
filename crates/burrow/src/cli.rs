//! CLI surface (PLAN §6.1): clap definitions, the layered config resolution, `serve` and `doctor`.
//!
//! Config precedence, highest first:
//! `flags` > `BURROW_*` > `--config` TOML > Hadoop conf auto-discovery > `http://localhost:8088`.
//! clap delivers flags and env in one layer, but each key remembers whether the value came from the
//! command line or the environment (via [`ArgMatches::value_source`]), so the banner and `doctor` can
//! say *why* a value was chosen.

use std::path::PathBuf;
use std::process::ExitCode;

use burrow_core::config::{
    self, Config, ConfigError, HeaderSpec, Layer, PartialConfig, StringList,
};
use burrow_core::core::Core;
use burrow_core::hadoop_conf::{self, DiscoverInput};
use burrow_core::http::{BodyMode, FetchReq};
use burrow_core::service_discovery::{self, DiscoveryReport, ServiceKind};
use clap::parser::ValueSource;
use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, Subcommand};

use crate::app;

#[derive(Parser, Debug)]
#[command(
    name = "burrow",
    version,
    about = "A modern UI for Apache Hadoop YARN and Spark-on-YARN — one read-only binary",
    disable_help_subcommand = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[command(flatten)]
    pub opts: Opts,
}

#[derive(Subcommand, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// Serve the API and the web UI (default)
    Serve,
    /// Probe configured services and discover endpoints advertised by the ResourceManager
    Doctor,
}

#[derive(clap::Args, Debug, Default)]
pub struct Opts {
    /// ResourceManager base URL (repeat for an HA pair, in `rm-ids` order)
    #[arg(
        long,
        global = true,
        env = "BURROW_RM",
        value_name = "URL",
        value_delimiter = ','
    )]
    pub rm: Vec<String>,

    /// Spark History Server base URL (repeat or comma-separate for failover)
    #[arg(
        long,
        global = true,
        env = "BURROW_SPARK_HISTORY",
        value_name = "URL",
        value_delimiter = ','
    )]
    pub spark_history: Vec<String>,

    /// JobHistory Server base URL (repeat or comma-separate for failover)
    #[arg(
        long,
        global = true,
        env = "BURROW_JHS",
        value_name = "URL",
        value_delimiter = ','
    )]
    pub jhs: Vec<String>,

    /// YARN timeline-service base URL
    #[arg(long, global = true, env = "BURROW_TIMELINE", value_name = "URL")]
    pub timeline: Option<String>,

    /// TOML config file (keys of the same names as the flags)
    #[arg(
        long,
        short = 'c',
        global = true,
        env = "BURROW_CONFIG",
        value_name = "FILE"
    )]
    pub config: Option<PathBuf>,

    /// Simple-auth user name, sent upstream as `user.name`
    #[arg(long, global = true, env = "BURROW_USER", value_name = "NAME")]
    pub user: Option<String>,

    /// Extra upstream request header, `Name: value` (repeatable)
    #[arg(long = "header", global = true, env = "BURROW_HEADER", value_name = "NAME:VALUE", value_parser = parse_header_arg)]
    pub header: Vec<(String, String)>,

    /// PEM bundle of extra trusted CAs for upstream TLS
    #[arg(long, global = true, env = "BURROW_CA_CERT", value_name = "FILE")]
    pub ca_cert: Option<PathBuf>,

    /// Skip TLS verification of upstreams (development only)
    #[arg(long, global = true, env = "BURROW_INSECURE")]
    pub insecure: bool,

    /// Bearer token sent as `Authorization` to every upstream
    #[arg(long, global = true, env = "BURROW_TOKEN", value_name = "TOKEN")]
    pub token: Option<String>,

    /// Extra accepted Host header value (repeatable; `*` allows any)
    #[arg(
        long = "allowed-host",
        global = true,
        env = "BURROW_ALLOWED_HOST",
        value_name = "HOST[:PORT]",
        value_delimiter = ','
    )]
    pub allowed_host: Vec<String>,

    /// Serve the web UI from this directory instead of the embedded assets
    #[arg(long, global = true, env = "BURROW_ASSETS_DIR", value_name = "DIR")]
    pub assets_dir: Option<PathBuf>,

    /// Serve everything under this path prefix (the SPA must be built with a matching base)
    #[arg(long, global = true, env = "BURROW_BASE_PATH", value_name = "/PREFIX")]
    pub base_path: Option<String>,

    /// Address to bind (default 127.0.0.1)
    #[arg(long, global = true, env = "BURROW_BIND", value_name = "IP")]
    pub bind: Option<String>,

    /// Port to bind (default 8787)
    #[arg(long, global = true, env = "BURROW_PORT", value_name = "PORT")]
    pub port: Option<u16>,

    /// Do not open a browser at startup
    #[arg(long, global = true, env = "BURROW_NO_OPEN")]
    pub no_open: bool,
}

fn parse_header_arg(s: &str) -> Result<(String, String), String> {
    config::parse_header(s).map_err(|e| e.0)
}

/// Parse the process arguments (kept separate from [`run`] so tests can build a `Cli` by hand).
pub fn parse() -> (Cli, ArgMatches) {
    let matches = Cli::command().get_matches();
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());
    (cli, matches)
}

/// Assemble the configuration layers from the CLI, the optional TOML file and Hadoop discovery.
pub fn config_from(cli: &Cli, matches: &ArgMatches) -> Result<Config, ConfigError> {
    let source_of = |key: &'static str| -> String {
        // These config keys are plural, while their clap argument IDs are singular.
        let arg_id = match key {
            "headers" => "header",
            "allowed_hosts" => "allowed_host",
            _ => key,
        };
        match matches.value_source(arg_id) {
            Some(ValueSource::EnvVariable) => {
                let env_name = match key {
                    "headers" => "BURROW_HEADER",
                    "allowed_hosts" => "BURROW_ALLOWED_HOST",
                    _ => return format!("env BURROW_{}", key.to_ascii_uppercase()),
                };
                format!("env {env_name}")
            }
            _ => "flag".to_string(),
        }
    };

    let mut values = PartialConfig::default();
    let mut key_sources = std::collections::BTreeMap::new();
    let mut set = |key: &'static str, non_empty: bool| {
        key_sources.insert(key, source_of(key));
        non_empty
    };

    let opts = &cli.opts;
    if !opts.rm.is_empty() {
        values.rm = Some(opts.rm.clone());
        set("rm", true);
    }
    if !opts.spark_history.is_empty() {
        values.spark_history = Some(StringList::Many(opts.spark_history.clone()));
        set("spark_history", true);
    }
    if !opts.jhs.is_empty() {
        values.jhs = Some(StringList::Many(opts.jhs.clone()));
        set("jhs", true);
    }
    if opts.timeline.is_some() {
        values.timeline = opts.timeline.clone();
        set("timeline", true);
    }
    if opts.user.is_some() {
        values.user = opts.user.clone();
        set("user", true);
    }
    if !opts.header.is_empty() {
        values.headers = Some(HeaderSpec::List(
            opts.header
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect(),
        ));
        set("headers", true);
    }
    if opts.ca_cert.is_some() {
        values.ca_cert = opts.ca_cert.clone();
        set("ca_cert", true);
    }
    if opts.insecure {
        values.insecure = Some(true);
        set("insecure", true);
    }
    if opts.token.is_some() {
        values.token = opts.token.clone();
        set("token", true);
    }
    if !opts.allowed_host.is_empty() {
        values.allowed_hosts = Some(opts.allowed_host.clone());
        set("allowed_hosts", true);
    }
    if opts.assets_dir.is_some() {
        values.assets_dir = opts.assets_dir.clone();
        set("assets_dir", true);
    }
    if opts.base_path.is_some() {
        values.base_path = opts.base_path.clone();
        set("base_path", true);
    }
    if opts.bind.is_some() {
        values.bind = opts.bind.clone();
        set("bind", true);
    }
    if opts.port.is_some() {
        values.port = opts.port;
        set("port", true);
    }
    if opts.no_open {
        values.no_open = Some(true);
        set("no_open", true);
    }

    let mut layers = vec![Layer {
        name: "flag".into(),
        values,
        key_sources,
    }];
    if let Some(path) = &cli.opts.config {
        let text = std::fs::read_to_string(path)
            .map_err(|e| ConfigError(format!("--config {}: {e}", path.display())))?;
        layers.push(Layer::new(
            format!("config file {}", path.display()),
            PartialConfig::from_toml(&text)?,
        ));
    }
    config::resolve(layers, hadoop_conf::discover(&DiscoverInput::from_env()))
}

/// `serve` or `doctor`; the exit code is the process's.
pub async fn run(cli: Cli, matches: ArgMatches) -> ExitCode {
    let cfg = match config_from(&cli, &matches) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("burrow: {e}");
            return ExitCode::from(2);
        }
    };
    let bootstrap = match Core::new(cfg.clone()) {
        Ok(core) => core,
        Err(e) => {
            eprintln!("burrow: {e}");
            return ExitCode::from(2);
        }
    };
    let runtime_discovery = service_discovery::discover(&bootstrap).await;
    drop(bootstrap);
    let cfg = apply_runtime_config(cfg, &runtime_discovery);
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => match app::serve(cfg).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("burrow: {e:#}");
                ExitCode::FAILURE
            }
        },
        Command::Doctor => doctor(cfg, runtime_discovery).await,
    }
}

/// Add operator-advertised runtime addresses after the configured endpoints, preserving their order.
/// Application tracking URLs stay suggestions only because apps can supply arbitrary hosts.
fn apply_runtime_config(mut cfg: Config, discovery: &DiscoveryReport) -> Config {
    let mut added = std::collections::BTreeSet::new();
    for candidate in discovery
        .candidates
        .iter()
        .filter(|candidate| candidate.operator_configured)
    {
        let (key, default_port) = match candidate.kind {
            ServiceKind::JobHistory => ("jhs", 19888),
            ServiceKind::SparkHistory => ("spark_history", 18080),
        };
        if cfg.source(key).contains("(disabled)") {
            continue;
        }
        let Ok(url) = config::parse_service_url(&candidate.url, false, Some(default_port)) else {
            continue;
        };
        let urls = match candidate.kind {
            ServiceKind::JobHistory => &mut cfg.jhs,
            ServiceKind::SparkHistory => &mut cfg.spark_history,
        };
        if urls.contains(&url) {
            continue;
        }
        urls.push(url);
        added.insert(key);
    }
    for key in added {
        let previous = cfg.source(key);
        let source = if previous == "default" {
            "ResourceManager runtime configuration".to_string()
        } else {
            format!("{previous}, ResourceManager runtime configuration")
        };
        cfg.sources.insert(key, source);
    }
    if let Some(log_server_url) = &discovery.log_server_url {
        cfg.log_server_url = Some(log_server_url.clone());
    }
    cfg
}

/// `burrow doctor`: probe everything, print what the UI will be able to show, and fail (exit 1) only
/// when the ResourceManager — without which nothing works — is unreachable.
async fn doctor(cfg: Config, runtime_discovery: DiscoveryReport) -> ExitCode {
    let version = env!("CARGO_PKG_VERSION");
    println!("burrow {version} — doctor\n");
    println!("configuration");
    let list = |urls: &[url::Url]| {
        urls.iter()
            .map(config::url_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
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
                    .map(config::url_string)
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
            config::url_string(url),
            cfg.source("timeline")
        );
    } else {
        println!("  {:<17} not configured", "Timeline");
    }
    println!(
        "  http policy       {}   [{}]",
        cfg.http_policy.as_str(),
        if cfg.discovery.http_policy.is_some() {
            "hadoop conf"
        } else {
            "inferred from the RM URL"
        }
    );
    println!(
        "  log server        {}",
        cfg.log_server_url.as_deref().unwrap_or("not configured")
    );
    for warning in &cfg.discovery.warnings {
        println!("  warning           {warning}");
    }

    println!("\nruntime discovery");
    if runtime_discovery.candidates.is_empty() {
        println!("  no additional service addresses found");
    } else {
        for candidate in &runtime_discovery.candidates {
            let disabled = match candidate.kind {
                ServiceKind::JobHistory => cfg.source("jhs").contains("(disabled)"),
                ServiceKind::SparkHistory => cfg.source("spark_history").contains("(disabled)"),
            };
            println!(
                "  {:<15} {}  [{}]{}",
                candidate.kind.label(),
                candidate.url,
                candidate.evidence,
                if disabled && candidate.operator_configured {
                    " (ignored because this service is explicitly disabled)"
                } else if candidate.operator_configured {
                    " (included and probed below)"
                } else {
                    " (observed from app tracking; destination not contacted)"
                }
            );
        }
    }
    for warning in &runtime_discovery.warnings {
        println!("  warning           {warning}");
    }

    let core = match Core::new(cfg) {
        Ok(core) => core,
        Err(e) => {
            eprintln!("burrow: {e}");
            return ExitCode::from(2);
        }
    };

    println!("\nResourceManager");
    let probes = core.rm_pool().probe_all(false).await;
    let mut rm_ok = false;
    for p in &probes {
        let latency = p.latency_ms.map(|l| format!("{l} ms")).unwrap_or_default();
        if p.reachable {
            println!(
                "  {:<32} ok    {:<8} {:<12} {}",
                p.url,
                p.ha_state.map(|s| s.as_str()).unwrap_or("-"),
                p.hadoop_version.as_deref().unwrap_or("-"),
                latency
            );
            rm_ok = true;
        } else {
            println!(
                "  {:<32} DOWN  {}",
                p.url,
                p.error.as_deref().unwrap_or("unknown error")
            );
        }
    }

    println!("\nNodeManagers");
    match core.node_authorities().await {
        Ok(nodes) => {
            let mut nodes: Vec<&String> = nodes.iter().collect();
            nodes.sort();
            println!(
                "  {} in the RM node list: {}",
                nodes.len(),
                nodes
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let probes = futures_util::future::join_all(nodes.iter().map(|authority| {
                let core = core.clone();
                let authority = (*authority).clone();
                async move {
                    let req = FetchReq {
                        authority: Some(authority.clone()),
                        path_and_query: "/ws/v1/node/info".into(),
                        mode: BodyMode::Buffer { cap: 1 << 20 },
                        accept: Some("application/json"),
                        headers: http::HeaderMap::new(),
                    };
                    let probe = core.nm.fetch(&req).await;
                    (authority, probe)
                }
            }))
            .await;
            for (authority, probe) in probes {
                match probe {
                    Ok(up) if up.status.is_success() => {
                        let version = match &up.body {
                            burrow_core::http::UpBody::Full(b) => {
                                serde_json::from_slice::<serde_json::Value>(b)
                                    .ok()
                                    .and_then(|v| {
                                        v["nodeInfo"]["nodeManagerVersion"]
                                            .as_str()
                                            .map(str::to_string)
                                    })
                                    .unwrap_or_else(|| "-".into())
                            }
                            _ => "-".into(),
                        };
                        println!("  {authority:<32} ok    NodeManager {version}");
                    }
                    Ok(up) => println!("  {authority:<32} HTTP {}", up.status),
                    Err(e) => println!("  {authority:<32} DOWN  {}", e.message),
                }
            }
        }
        Err(e) => println!("  cannot read the node list: {}", e.message),
    }

    println!("\nservices");
    let (meta, _) = core.meta_document().await;
    for (name, svc) in meta["services"].as_object().into_iter().flatten() {
        if svc["configured"].as_bool() == Some(true) {
            if let Some(candidates) = svc["candidates"].as_array() {
                for (index, candidate) in candidates.iter().enumerate() {
                    println!(
                        "  {:<15} {:<28} {}",
                        if index == 0 { name.as_str() } else { "" },
                        candidate["url"].as_str().unwrap_or("-"),
                        if candidate["reachable"].as_bool() == Some(true) {
                            "reachable"
                        } else {
                            candidate["reason"].as_str().unwrap_or("unreachable")
                        }
                    );
                }
            } else {
                println!(
                    "  {name:<15} {:<28} {}",
                    svc["url"].as_str().unwrap_or("-"),
                    if svc["reachable"].as_bool() == Some(true) {
                        "reachable".to_string()
                    } else {
                        format!("unreachable: {}", svc["reason"].as_str().unwrap_or("?"))
                    }
                );
            }
        } else {
            println!("  {name:<15} not configured");
        }
    }
    println!(
        "\nyarn              scheduler={} · logServer={}",
        meta["yarn"]["scheduler"].as_str().unwrap_or("unknown"),
        meta["yarn"]["logServerUrl"].as_str().unwrap_or("none")
    );
    println!("\nfeatures (what this build can serve; services above are the environment)");
    for (name, value) in meta["features"].as_object().into_iter().flatten() {
        println!(
            "  {name:<16} {}",
            if value.as_bool() == Some(true) {
                "yes"
            } else {
                "no"
            }
        );
    }
    println!(
        "\n{cache} cached entries / {bytes} bytes in use",
        cache = core.cache.usage().0,
        bytes = core.cache.usage().1
    );

    if rm_ok {
        println!("\nOK");
        ExitCode::SUCCESS
    } else {
        println!("\nFAILED: no ResourceManager is reachable");
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        task::JoinHandle,
    };

    fn parse_cli(args: impl IntoIterator<Item = String>) -> (Cli, ArgMatches) {
        let mut command = Cli::command();
        for (id, env) in [
            ("rm", "BURROW_TEST_RM"),
            ("spark_history", "BURROW_TEST_SPARK_HISTORY"),
            ("jhs", "BURROW_TEST_JHS"),
            ("timeline", "BURROW_TEST_TIMELINE"),
            ("config", "BURROW_TEST_CONFIG"),
            ("user", "BURROW_TEST_USER"),
            ("header", "BURROW_TEST_HEADER"),
            ("ca_cert", "BURROW_TEST_CA_CERT"),
            ("insecure", "BURROW_TEST_INSECURE"),
            ("token", "BURROW_TEST_TOKEN"),
            ("allowed_host", "BURROW_TEST_ALLOWED_HOST"),
            ("assets_dir", "BURROW_TEST_ASSETS_DIR"),
            ("base_path", "BURROW_TEST_BASE_PATH"),
            ("bind", "BURROW_TEST_BIND"),
            ("port", "BURROW_TEST_PORT"),
            ("no_open", "BURROW_TEST_NO_OPEN"),
        ] {
            command = command.mut_arg(id, |arg| arg.env(env));
        }
        let matches = command.try_get_matches_from(args).unwrap();
        let cli = Cli::from_arg_matches(&matches).unwrap();
        (cli, matches)
    }

    fn candidate(
        kind: ServiceKind,
        url: &str,
        operator_configured: bool,
    ) -> service_discovery::ServiceCandidate {
        service_discovery::ServiceCandidate {
            kind,
            url: url.into(),
            evidence: "test evidence".into(),
            operator_configured,
        }
    }

    #[test]
    fn header_parser_preserves_colons_in_values_and_rejects_missing_names() {
        assert_eq!(
            parse_header_arg("X-Trace: first: second").unwrap(),
            ("X-Trace".into(), "first: second".into())
        );
        assert!(parse_header_arg(": value").is_err());
        assert!(parse_header_arg("missing-separator").is_err());
    }

    #[test]
    fn config_flags_override_toml_and_keep_each_layer_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("burrow.toml");
        std::fs::write(
            &path,
            r#"
rm = ["http://config-rm.example:8088"]
jhs = ["http://jhs.example:19888"]
spark_history = ""
timeline = ""
base_path = "/from-file"
"#,
        )
        .unwrap();
        let (cli, matches) = parse_cli(
            [
                "burrow",
                "--config",
                path.to_str().unwrap(),
                "--rm",
                "http://flag-rm.example:8089",
                "--base-path",
                "/from-flag",
                "doctor",
            ]
            .map(str::to_owned),
        );

        let config = config_from(&cli, &matches).unwrap();

        assert_eq!(config.rm_urls[0].host_str(), Some("flag-rm.example"));
        assert_eq!(config.rm_urls[0].port(), Some(8089));
        assert_eq!(config.jhs[0].host_str(), Some("jhs.example"));
        assert_eq!(config.base_path, "/from-flag");
        assert_eq!(config.source("rm"), "flag");
        assert!(config.source("jhs").starts_with("config file "));
        assert_eq!(config.source("base_path"), "flag");
    }

    #[test]
    fn config_flags_resolve_auth_assets_and_server_options() {
        let (cli, matches) = parse_cli(
            [
                "burrow",
                "--rm",
                "http://rm.example:8088",
                "--spark-history",
                "http://shs.example:18080",
                "--jhs",
                "http://jhs.example:19888",
                "--timeline",
                "http://timeline.example:8188",
                "--user",
                "alice",
                "--header",
                "X-Trace: first: second",
                "--ca-cert",
                "/tmp/test-ca.pem",
                "--insecure",
                "--token",
                "test-token",
                "--allowed-host",
                "example.com:8787",
                "--assets-dir",
                "/tmp/assets",
                "--base-path",
                "/burrow",
                "--bind",
                "127.0.0.1",
                "--port",
                "9000",
                "--no-open",
            ]
            .map(str::to_owned),
        );

        let config = config_from(&cli, &matches).unwrap();

        assert_eq!(config.spark_history[0].host_str(), Some("shs.example"));
        assert_eq!(config.jhs[0].host_str(), Some("jhs.example"));
        assert_eq!(
            config.timeline.as_ref().unwrap().host_str(),
            Some("timeline.example")
        );
        assert_eq!(config.user.as_deref(), Some("alice"));
        assert_eq!(
            config.headers,
            vec![("X-Trace".into(), "first: second".into())]
        );
        assert_eq!(
            config.ca_cert.as_deref(),
            Some(std::path::Path::new("/tmp/test-ca.pem"))
        );
        assert!(config.insecure);
        assert_eq!(config.token.as_deref(), Some("test-token"));
        assert_eq!(config.allowed_hosts, vec!["example.com:8787".to_string()]);
        assert_eq!(
            config.assets_dir.as_deref(),
            Some(std::path::Path::new("/tmp/assets"))
        );
        assert_eq!(config.base_path, "/burrow");
        assert_eq!(config.bind.to_string(), "127.0.0.1");
        assert_eq!(config.port, 9000);
        assert!(config.no_open);
        assert_eq!(config.source("headers"), "flag");
        assert_eq!(config.source("allowed_hosts"), "flag");
    }

    #[test]
    fn config_from_reports_a_missing_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("absent.toml");
        let (cli, matches) =
            parse_cli(["burrow", "--config", path.to_str().unwrap(), "doctor"].map(str::to_owned));

        let error = config_from(&cli, &matches).unwrap_err();

        assert!(error.0.contains("--config"));
        assert!(error.0.contains("absent.toml"));
    }

    #[test]
    fn runtime_discovery_adds_only_unique_operator_addresses() {
        let existing_jhs = "http://existing-jhs.example:19888";
        let mut config = Config::for_rm("http://rm.example:8088").unwrap();
        config
            .jhs
            .push(config::parse_service_url(existing_jhs, false, Some(19888)).unwrap());
        config.sources.insert("jhs", "flag".into());
        let report = DiscoveryReport {
            candidates: vec![
                candidate(ServiceKind::JobHistory, existing_jhs, true),
                candidate(
                    ServiceKind::JobHistory,
                    "http://new-jhs.example:19888",
                    true,
                ),
                candidate(
                    ServiceKind::JobHistory,
                    "http://new-jhs.example:19888",
                    true,
                ),
                candidate(ServiceKind::SparkHistory, "http://shs.example:18080", true),
                candidate(
                    ServiceKind::SparkHistory,
                    "https://app-suggestion.example",
                    false,
                ),
                candidate(ServiceKind::SparkHistory, "ftp://invalid.example", true),
            ],
            warnings: Vec::new(),
            log_server_url: Some("http://logs.example/proxy".into()),
        };

        let config = apply_runtime_config(config, &report);

        assert_eq!(config.jhs.len(), 2);
        assert_eq!(config.jhs[1].host_str(), Some("new-jhs.example"));
        assert_eq!(config.spark_history.len(), 1);
        assert_eq!(config.spark_history[0].host_str(), Some("shs.example"));
        assert_eq!(
            config.source("jhs"),
            "flag, ResourceManager runtime configuration"
        );
        assert_eq!(
            config.source("spark_history"),
            "ResourceManager runtime configuration"
        );
        assert_eq!(
            config.log_server_url.as_deref(),
            Some("http://logs.example/proxy")
        );

        let mut disabled = Config::for_rm("http://rm.example:8088").unwrap();
        disabled.sources.insert("jhs", "flag (disabled)".into());
        let disabled = apply_runtime_config(
            disabled,
            &DiscoveryReport {
                candidates: vec![candidate(
                    ServiceKind::JobHistory,
                    "http://new-jhs.example:19888",
                    true,
                )],
                ..DiscoveryReport::default()
            },
        );
        assert!(disabled.jhs.is_empty());
        assert_eq!(disabled.source("jhs"), "flag (disabled)");
    }

    struct MockRm {
        base: String,
        task: JoinHandle<()>,
    }

    impl MockRm {
        async fn start(reachable: bool) -> std::io::Result<Self> {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
            let addr = listener.local_addr().unwrap();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
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
                            .split('?')
                            .next()
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
                        let (status, body) = match path.as_str() {
                            "/conf" => (200, r#"{"properties":[]}"#),
                            "/ws/v1/cluster/apps" => (200, r#"{"apps":{"app":[]}}"#),
                            "/ws/v1/cluster/info" if reachable => (
                                200,
                                r#"{"clusterInfo":{"haState":"ACTIVE","hadoopVersion":"3.4.0","state":"STARTED"}}"#,
                            ),
                            "/ws/v1/cluster/info" => (503, "{}"),
                            "/ws/v1/cluster/nodes" => (200, r#"{"nodes":{"node":[]}}"#),
                            _ => (200, "{}"),
                        };
                        let wire = format!(
                            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = reader.get_mut().write_all(wire.as_bytes()).await;
                    });
                }
            });
            Ok(Self {
                base: format!("http://{addr}"),
                task,
            })
        }
    }

    impl Drop for MockRm {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[tokio::test]
    async fn doctor_exit_code_tracks_resource_manager_reachability() {
        for (reachable, expected) in [(true, ExitCode::SUCCESS), (false, ExitCode::FAILURE)] {
            let rm = match MockRm::start(reachable).await {
                Ok(rm) => rm,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
                Err(error) => panic!("could not start mock RM: {error}"),
            };
            let command = vec![
                "burrow".to_string(),
                "--rm".to_string(),
                rm.base.clone(),
                "--spark-history".to_string(),
                String::new(),
                "--jhs".to_string(),
                String::new(),
                "--timeline".to_string(),
                String::new(),
                "doctor".to_string(),
            ];
            let (cli, matches) = parse_cli(command);

            assert_eq!(run(cli, matches).await, expected);
        }
    }

    #[tokio::test]
    async fn run_returns_exit_two_for_a_missing_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.toml");
        let (cli, matches) = parse_cli(vec![
            "burrow".into(),
            "--config".into(),
            path.display().to_string(),
            "doctor".into(),
        ]);

        assert_eq!(run(cli, matches).await, ExitCode::from(2));
    }
}
