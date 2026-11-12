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

#[tokio::test]
async fn log_resolution_discovers_the_node_from_attempts_and_containers() {
    for via_containers in [false, true] {
        let mock = Mock::start().await;
        mock.seed_rm().await;
        seed_nodes(&mock).await;
        seed_app(&mock, "RUNNING").await;
        let attempt = if via_containers {
            r#"{"appAttempts":{"appAttempt":[{"appAttemptId":"appattempt_1791010984040_0005_000001"}]}}"#.to_string()
        } else {
            format!(
                r#"{{"appAttempts":{{"appAttempt":[{{"appAttemptId":"appattempt_1791010984040_0005_000001","containerId":"{CID}","nodeHttpAddress":"{}"}}]}}}}"#,
                mock.authority()
            )
        };
        mock.json(&format!("/ws/v1/cluster/apps/{APP}/appattempts"), &attempt)
            .await;
        if via_containers {
            mock.json(
                &format!(
                    "/ws/v1/cluster/apps/{APP}/appattempts/appattempt_1791010984040_0005_000001/containers"
                ),
                &format!(
                    r#"{{"containers":{{"container":[{{"id":"{CID}","nodeHttpAddress":"http://{}"}}]}}}}"#,
                    mock.authority()
                ),
            )
            .await;
        }
        seed_nm(&mock, "RUNNING").await;
        let h = Harness::start(logs_config(&mock)).await;
        let r = h
            .get(&format!("/api/logs/containers/{CID}?user={USER}"))
            .await;
        assert_eq!(r.status, 200, "{}", r.text());
        assert_eq!(r.json()["source"], "nm");
        assert_eq!(r.json()["node"], mock.authority());
        assert!(
            mock.hits_of_path(&format!("/ws/v1/cluster/apps/{APP}/appattempts"))
                .await
                >= 1
        );
        if via_containers {
            assert!(mock
                .hits_of_path(&format!(
                    "/ws/v1/cluster/apps/{APP}/appattempts/appattempt_1791010984040_0005_000001/containers"
                ))
                .await >= 1);
        } else {
            assert_eq!(
                mock.hits_of_path(&format!("/ws/v1/cluster/apps/{APP}/appattempts/"))
                    .await,
                0
            );
        }
    }
}

#[tokio::test]
async fn terminal_log_resolution_skips_failed_jhs_candidates_and_recovers() {
    let rm = Mock::start().await;
    let failed = Mock::start().await;
    let empty = Mock::start().await;
    let ready = Mock::start().await;
    rm.seed_rm().await;
    seed_nodes(&rm).await;
    seed_app(&rm, "FINISHED").await;
    let path = format!("/jobhistory/logs/{RPC}/{CID}/{CID}/{USER}/");
    failed
        .set(&path, Canned::new(503, "text/plain", "temporarily down"))
        .await;
    empty
        .set(
            &path,
            Canned::new(
                200,
                "text/html",
                "<html><body><h1>No logs available for this container</h1></body></html>",
            ),
        )
        .await;
    ready
        .set(&path, Canned::new(200, "text/html", jhs_listing_html()))
        .await;

    let mut config = Harness::config_for(&rm.base());
    config.jhs = [failed.base(), empty.base(), ready.base()]
        .into_iter()
        .map(|u| url::Url::parse(&u).unwrap())
        .collect();
    config.log_server_url = Some(format!("{}/jobhistory/logs", ready.base()));
    let h = Harness::start(config).await;
    let r = h.get(&listing_url(&rm)).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["source"], "jhs");
    assert_eq!(r.json()["files"].as_array().unwrap().len(), 2);
    assert_eq!(failed.hits_of_path(&path).await, 1);
    assert_eq!(empty.hits_of_path(&path).await, 1);
    assert_eq!(ready.hits_of_path(&path).await, 1);
    assert_eq!(rm.hits_of_path(&nm_base()).await, 0);
}

#[tokio::test]
async fn log_resolution_handles_missing_metadata_nodes_and_empty_nm_listings() {
    for app_doc in ["not JSON", "{}", r#"{"app":42}"#] {
        let mock = Mock::start().await;
        mock.seed_rm().await;
        seed_nodes(&mock).await;
        mock.set(
            &format!("/ws/v1/cluster/apps/{APP}"),
            Canned::new(200, "application/json", app_doc),
        )
        .await;
        mock.set(
            &nm_base(),
            Canned::new(
                200,
                "text/html",
                "<html><body><h1>No logs available for this container</h1></body></html>",
            ),
        )
        .await;
        let h = Harness::start(logs_config(&mock)).await;
        let r = h
            .get(&format!(
                "/api/logs/containers/{CID}?node={}&user={USER}&app={APP}",
                mock.authority()
            ))
            .await;
        assert_eq!(r.status, 200, "{}", r.text());
        assert_eq!(r.json()["source"], "nm");
        assert!(r.json()["files"].as_array().unwrap().is_empty());
    }

    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_app(&mock, "RUNNING").await;
    let h = Harness::start(logs_config(&mock)).await;
    let no_node = h
        .get(&format!("/api/logs/containers/{CID}?user={USER}&app={APP}"))
        .await;
    assert_eq!(no_node.status, 503);
    assert!(
        no_node
            .text()
            .contains("cannot determine the container's node")
    );
    assert!(no_node.text().contains("cannot map the container's node"));

    let missing_container = Mock::start().await;
    missing_container.seed_rm().await;
    seed_app(&missing_container, "RUNNING").await;
    missing_container
        .json(
            &format!("/ws/v1/cluster/apps/{APP}/appattempts"),
            r#"{"appAttempts":{"appAttempt":[{"appAttemptId":"appattempt_1_1_000001"}]}}"#,
        )
        .await;
    let h = Harness::start(logs_config(&missing_container)).await;
    let no_container = h
        .get(&format!("/api/logs/containers/{CID}?user={USER}&app={APP}"))
        .await;
    assert_eq!(no_container.status, 503);
}

#[tokio::test]
async fn node_allowlist_failures_and_container_state_failures_are_safe() {
    let denied = Mock::start().await;
    seed_app(&denied, "RUNNING").await;
    denied
        .set(
            "/ws/v1/cluster/nodes",
            Canned::new(503, "text/plain", "node list unavailable"),
        )
        .await;
    let h = Harness::start(logs_config(&denied)).await;
    let failed = h.get(&listing_url(&denied)).await;
    assert_eq!(failed.status, 503);
    assert!(
        failed
            .text()
            .contains("cannot read the ResourceManager node list")
    );

    let huge = Mock::start().await;
    seed_app(&huge, "RUNNING").await;
    huge.set(
        "/ws/v1/cluster/nodes",
        Canned::new(200, "application/json", vec![b' '; 4096]),
    )
    .await;
    let mut config = logs_config(&huge);
    config.cache.max_body_bytes = 512;
    let h = Harness::start(config).await;
    let failed = h.get(&listing_url(&huge)).await;
    assert_eq!(failed.status, 500);
    assert!(failed.text().contains("node list was too large"));

    let mock = Mock::start().await;
    seed_app(&mock, "RUNNING").await;
    seed_nodes(&mock).await;
    let h = Harness::start(logs_config(&mock)).await;
    let loc = burrow_core::logs::source::LogLocation {
        kind: burrow_core::logs::source::LogSourceKind::Nm,
        base_path: nm_base(),
        node: Some(mock.authority()),
        upstream_url: None,
        user: USER.into(),
        container_id: CID.into(),
        files: Vec::new(),
    };
    mock.set(
        &format!("/ws/v1/node/containers/{CID}"),
        Canned::new(503, "application/json", "offline"),
    )
    .await;
    assert_eq!(
        burrow_core::logs::source::container_running(&h.core, &loc).await,
        Some(false)
    );
    mock.set(
        &format!("/ws/v1/node/containers/{CID}"),
        Canned::new(200, "application/json", "not JSON"),
    )
    .await;
    assert_eq!(
        burrow_core::logs::source::container_running(&h.core, &loc).await,
        None
    );
}

#[tokio::test]
async fn log_resolution_retries_nm_after_history_lookup_errors() {
    let rm = Mock::start().await;
    rm.seed_rm().await;
    seed_nodes(&rm).await;
    seed_app(&rm, "FINISHED").await;
    rm.set(&nm_base(), Canned::new(200, "text/html", nm_listing_html()))
        .await;

    let mut config = Harness::config_for(&rm.base());
    config.jhs = vec!["http://127.0.0.1:1".parse().unwrap()];
    config.log_server_url = Some("http://127.0.0.1:1/jobhistory/logs".into());
    let h = Harness::start(config).await;
    let r = h.get(&listing_url(&rm)).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["source"], "nm");
}

#[tokio::test]
async fn node_authority_without_an_rpc_id_cannot_be_used_for_aggregated_logs() {
    let mock = Mock::start().await;
    seed_app(&mock, "FINISHED").await;
    mock.json(
        "/ws/v1/cluster/nodes",
        &format!(
            r#"{{"nodes":{{"node":[{{"nodeHTTPAddress":"{}"}}]}}}}"#,
            mock.authority()
        ),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;
    let r = h.get(&listing_url(&mock)).await;
    assert_eq!(r.status, 503, "{}", r.text());
    assert!(r.text().contains("cannot map the container's node"));
}

#[tokio::test]
async fn terminal_log_resolution_reports_all_failed_sources() {
    let mock = Mock::start().await;
    let jhs = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "FINISHED").await;
    jhs.set(
        &format!("/jobhistory/logs/{RPC}/{CID}/{CID}/{USER}/"),
        Canned::new(503, "text/plain", "JHS maintenance"),
    )
    .await;
    let mut config = Harness::config_for(&mock.base());
    config.jhs = vec![url::Url::parse(&jhs.base()).unwrap()];
    config.log_server_url = Some(format!("{}/jobhistory/logs", jhs.base()));
    let h = Harness::start(config).await;
    let r = h.get(&listing_url(&mock)).await;
    assert_eq!(r.status, 503, "{}", r.text());
    assert!(r.text().contains("JobHistoryServer candidates failed"));
    assert!(r.text().contains("NodeManager"));
}

#[tokio::test]
async fn log_reads_translate_upstream_failures_and_use_listing_size_as_fallback() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "RUNNING").await;
    let h = Harness::start(logs_config(&mock)).await;

    mock.set(
        &format!("{}stdout/?start=0&end=5", nm_base()),
        Canned::new(502, "text/plain", "nm read failed"),
    )
    .await;
    let failed = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&offset=0&length=5",
            mock.authority()
        ))
        .await;
    assert_eq!(failed.status, 502);
    assert_eq!(failed.error_code(), "upstream_status");

    mock.set(
        &format!("{}stdout/?start=0&end=5", nm_base()),
        Canned::new(
            200,
            "text/html",
            "<html><body>Cannot find this log file</body></html>",
        ),
    )
    .await;
    let missing = h
        .get(&format!(
            "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&offset=0&length=5",
            mock.authority()
        ))
        .await;
    assert_eq!(missing.status, 404);
    assert!(missing.text().contains("Cannot find this log"));

    mock.set(
        &format!("{}stdout/?start=2&end=4", nm_base()),
        Canned::new(200, "text/html", "<pre>ll</pre>"),
    )
    .await;
    let window = burrow_core::logs::source::read_window(
        &h.core,
        &burrow_core::logs::source::LogLocation {
            kind: burrow_core::logs::source::LogSourceKind::Nm,
            base_path: nm_base(),
            node: Some(mock.authority()),
            upstream_url: None,
            user: USER.into(),
            container_id: CID.into(),
            files: Vec::new(),
        },
        "stdout",
        2,
        4,
    )
    .await
    .unwrap();
    assert_eq!(window.text, "ll");
    assert_eq!(window.total, 4, "the requested end is the last fallback");
}

#[tokio::test]
async fn tail_stops_cleanly_when_its_receiver_is_dropped() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "RUNNING").await;
    mock.set(
        &format!("{}stdout/?start=0&end=262144", nm_base()),
        Canned::new(200, "text/html", "<pre>chunk</pre>"),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;
    let (rx, task) = burrow_core::logs::tail::follow(
        h.core.clone(),
        burrow_core::logs::tail::TailSpec {
            location: burrow_core::logs::source::LogLocation {
                kind: burrow_core::logs::source::LogSourceKind::Nm,
                base_path: nm_base(),
                node: Some(mock.authority()),
                upstream_url: None,
                user: USER.into(),
                container_id: CID.into(),
                files: Vec::new(),
            },
            file: "stdout".into(),
            start: 0,
        },
    );
    drop(rx);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("tail exits after its receiver is dropped")
        .expect("tail task completes");
    assert_eq!(mock.hits_of_path(&format!("{}stdout/", nm_base())).await, 1);
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
async fn follow_window_reports_when_nm_container_is_finished() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "COMPLETE").await;
    mock.set(
        &format!("{}stdout/?start=0&end=5", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", "<pre>hello</pre>"),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;
    let base = format!(
        "/api/logs/containers/{CID}/files/stdout?node={}&user={USER}&offset=0&length=5",
        mock.authority()
    );

    let followed = h.get(&format!("{base}&follow=1")).await;
    assert_eq!(followed.status, 200, "{}", followed.text());
    assert_eq!(followed.text(), "hello");
    assert_eq!(
        followed.header("x-burrow-log-ended").as_deref(),
        Some("true")
    );

    let ordinary = h.get(&base).await;
    assert_eq!(ordinary.status, 200, "{}", ordinary.text());
    assert_eq!(ordinary.header("x-burrow-log-ended"), None);
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
async fn follow_stream_stops_when_a_finished_source_ignores_the_range() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "FINISHED").await;
    let jhs_base = format!("/jobhistory/logs/{RPC}/{CID}/{CID}/{USER}/");
    mock.set(
        &jhs_base,
        Canned::new(
            200,
            "text/html;charset=utf-8",
            "<html><body>Log Type: stdout\nLog Upload Time: Sat Oct 03 12:38:56 +0530 2026\nLog Length: 5\n<pre>hello</pre></body></html>",
        ),
    )
    .await;
    // Any request returns the same 4-byte tail: a log proxy or default-tail page that ignores start/end.
    mock.set(
        &format!("{jhs_base}stdout/"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            "<p>Showing 4 bytes of 5 total.</p><pre>tail</pre>",
        ),
    )
    .await;
    let h = Harness::start(logs_config(&mock)).await;

    // The client holds the whole 5-byte file, so a conforming source would answer this with nothing.
    // The broken source answers with bytes it already served; the stream must not append them.
    let mut sse = Sse::open(
        &h,
        &format!(
            "/api/logs/containers/{CID}/files/stdout/stream?node={}&user={USER}&offset=5",
            mock.authority()
        ),
    )
    .await;
    let f = sse
        .next_frame(Duration::from_secs(2))
        .await
        .expect("eof frame");
    assert_eq!(f, "event: eof\ndata: {}");
    assert!(
        sse.next_frame(Duration::from_secs(1)).await.is_none(),
        "the stream ends instead of replaying the fixed window"
    );

    // From the start, the first window is emitted once; the repeated window ends the stream instead of
    // being appended again and again.
    let mut sse = Sse::open(
        &h,
        &format!(
            "/api/logs/containers/{CID}/files/stdout/stream?node={}&user={USER}&offset=0",
            mock.authority()
        ),
    )
    .await;
    let f = sse
        .next_frame(Duration::from_secs(2))
        .await
        .expect("first chunk");
    assert!(f.starts_with("event: chunk"), "{f}");
    assert!(f.contains("tail"), "{f}");
    let f = sse
        .next_frame(Duration::from_secs(2))
        .await
        .expect("eof after the repeated window");
    assert_eq!(f, "event: eof\ndata: {}");
    assert!(sse.next_frame(Duration::from_secs(1)).await.is_none());
}

#[tokio::test]
async fn follow_stream_stops_when_a_running_source_repeats_a_full_window() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    seed_nodes(&mock).await;
    seed_app(&mock, "RUNNING").await;
    seed_nm(&mock, "RUNNING").await;
    let window = "x".repeat(256 * 1024);
    let page = format!("<pre>{window}</pre>");
    // The same full-size window for every offset: the source ignores start/end.
    mock.set(
        &format!("{}stdout/?start=0&end=262144", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", page.as_str()),
    )
    .await;
    mock.set(
        &format!("{}stdout/?start=262144&end=524288", nm_base()),
        Canned::new(200, "text/html;charset=utf-8", page.as_str()),
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
    assert!(f.contains("\"end\":262144"), "{f}");

    let f = sse
        .next_frame(Duration::from_secs(5))
        .await
        .expect("stall error");
    assert!(f.starts_with("event: error"), "{f}");
    assert!(f.contains("stopped advancing"), "{f}");
    assert!(sse.next_frame(Duration::from_secs(1)).await.is_none());
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
