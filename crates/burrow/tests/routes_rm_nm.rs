//! The route tables themselves: RM daemon pages, the NodeManager passthrough with its SSRF guard,
//! and the allowlist/id-validation rules (§3).

mod common;

use common::{Canned, Harness, Mock};

#[tokio::test]
async fn rm_daemon_pages_are_proxied_with_their_own_rewrites() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    // conf and jmx live at the RM root, not under /ws/v1/cluster.
    let conf = h.get("/api/rm/conf").await;
    assert_eq!(conf.status, 200);
    assert!(conf.text().contains("<configuration>"));
    assert_eq!(
        mock.last_request().await.unwrap().split(' ').nth(1),
        Some("/conf")
    );

    let jmx = h.get("/api/rm/jmx").await;
    assert_eq!(jmx.status, 200);
    assert_eq!(jmx.json()["beans"], serde_json::json!([]));

    // `?format=json` promises JSON, so the upstream request asks for it.
    let conf_json = h.get("/api/rm/conf?format=json").await;
    assert_eq!(conf_json.status, 200);

    // stacks is plain text and cached separately from everything else.
    mock.set(
        "/stacks",
        Canned::new(200, "text/plain", "Thread-1\nThread-2\n"),
    )
    .await;
    let stacks = h.get("/api/rm/stacks").await;
    assert_eq!(stacks.status, 200);
    assert_eq!(stacks.text(), "Thread-1\nThread-2\n");

    // /logLevel mutates daemon state through GET: deliberately not exposed.
    let r = h.get("/api/rm/logLevel").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");
}

#[tokio::test]
async fn rm_logs_listing_is_synthesized_from_html() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let r = h.get("/api/rm/logs").await;
    assert_eq!(r.status, 200);
    assert!(
        r.header("content-type")
            .unwrap()
            .starts_with("application/json")
    );
    assert!(r.header("etag").unwrap().starts_with("W/\""));
    let j = r.json();
    let files = j["files"].as_array().unwrap();
    assert_eq!(files.len(), 1, "{j}");
    assert_eq!(files[0]["name"], "resourcemanager.log");
    assert_eq!(files[0]["size"], 135_064);
    assert_eq!(files[0]["isDir"], false);
    assert_eq!(
        files[0]["modified"], "Oct 3, 2026, 12:26:50 PM",
        "verbatim, zone-free"
    );
    assert_eq!(mock.hits_of_path("/logs/").await, 1);

    // The listing is cached like any other body.
    assert_eq!(h.get("/api/rm/logs").await.cache(), "hit");
}

#[tokio::test]
async fn rm_log_file_translates_offset_and_length_into_a_range_request() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    mock.set(
        "/logs/resourcemanager.log",
        Canned::new(206, "text/plain", "abc")
            .with_header("content-range", "bytes 0-2/12")
            .with_header("accept-ranges", "bytes"),
    )
    .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let r = h
        .get("/api/rm/logs/resourcemanager.log?offset=0&length=3")
        .await;
    assert_eq!(r.status, 206);
    assert_eq!(r.text(), "abc");
    assert_eq!(r.header("content-range").as_deref(), Some("bytes 0-2/12"));
    assert_eq!(r.header("accept-ranges").as_deref(), Some("bytes"));
    assert!(r.header("content-type").unwrap().starts_with("text/plain"));

    // offset/length are ours; the Range header is what reaches the daemon.
    let seen = mock.last_request().await.unwrap();
    assert!(seen.ends_with("/logs/resourcemanager.log"), "{seen}");

    // Bad windows are rejected before any upstream request.
    let before = mock.total_hits().await;
    for path in [
        "/api/rm/logs/resourcemanager.log?length=0",
        "/api/rm/logs/resourcemanager.log?offset=x",
        "/api/rm/logs/resourcemanager.log?offset=18446744073709551615&length=2",
        "/api/rm/logs/../etc/passwd",
        "/api/rm/logs/%2e%2e",
    ] {
        let r = h.get(path).await;
        assert!(r.status == 400 || r.status == 404, "{path} → {}", r.status);
    }
    assert_eq!(
        mock.total_hits().await,
        before,
        "rejected before touching the daemon"
    );
}

#[tokio::test]
async fn unbounded_log_file_requests_stream_through_uncached() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let first = h.get("/api/rm/logs/resourcemanager.log").await;
    assert_eq!(first.status, 200);
    assert_eq!(first.text(), "line one\nline two\n");
    assert_eq!(first.cache(), "miss", "log files are never cached");
    let second = h.get("/api/rm/logs/resourcemanager.log").await;
    assert_eq!(second.cache(), "miss");
    assert_eq!(mock.hits_of_path("/logs/resourcemanager.log").await, 2);
}

#[tokio::test]
async fn node_manager_access_is_restricted_to_the_rm_node_list() {
    let nm = Mock::start().await;
    nm.json(
        "/ws/v1/node/info",
        r#"{"nodeInfo":{"nodeManagerVersion":"3.4.3","nodeHealthy":true}}"#,
    )
    .await;
    nm.json("/ws/v1/node/apps", r#"{"apps":{}}"#).await;
    nm.json("/ws/v1/node/containers", r#"{"containers":{}}"#)
        .await;

    let rm = Mock::start().await;
    rm.seed_rm().await;
    rm.json(
        "/ws/v1/cluster/nodes",
        &format!(
            r#"{{"nodes":{{"node":[{{"id":"127.0.0.1:1","nodeHTTPAddress":"{}","nodeHostName":"127.0.0.1","state":"RUNNING"}}]}}}}"#,
            nm.authority()
        ),
    )
    .await;
    let h = Harness::start(Harness::config_for(&rm.base())).await;

    let info = h.get(&format!("/api/nm/{}/info", nm.authority())).await;
    assert_eq!(info.status, 200, "{}", info.text());
    assert_eq!(info.json()["nodeInfo"]["nodeManagerVersion"], "3.4.3");
    assert_eq!(
        info.header("x-burrow-upstream").as_deref(),
        Some(nm.authority().as_str())
    );

    assert_eq!(
        h.get(&format!("/api/nm/{}/apps", nm.authority()))
            .await
            .status,
        200
    );
    assert_eq!(
        h.get(&format!("/api/nm/{}/containers", nm.authority()))
            .await
            .status,
        200
    );

    // A host the RM does not know is refused, whatever the shape, and never contacted.
    let before = nm.total_hits().await;
    for authority in ["evil.example.com:8042", "127.0.0.9:8042", "127.0.0.2:8041"] {
        let r = h.get(&format!("/api/nm/{authority}/info")).await;
        assert_eq!(r.status, 403, "{authority}");
        assert_eq!(r.error_code(), "forbidden");
        assert!(r.json()["error"]["hint"].is_string());
    }
    assert_eq!(nm.total_hits().await, before, "the guard contacts nothing");

    // Malformed authorities are a 400, and unknown resources inside the NM are a 404.
    let r = h.get("/api/nm/127.0.0.1/info").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), "bad_request");
    let r = h.get(&format!("/api/nm/{}/logs", nm.authority())).await;
    assert_eq!(r.status, 404);
    // Traversal can never escape the NM resource list (`..` is rejected by the route table; the
    // percent-encoded form survives URL normalisation and is rejected because `%` is not a valid id).
    // `%2e%2e` survives client-side URL normalisation and is rejected because `%` is not a valid id.
    let r = h
        .get(&format!(
            "/api/nm/{}/%2e%2e/%2e%2e/etc/passwd",
            nm.authority()
        ))
        .await;
    assert_eq!(r.status, 404, "{}", r.text());
    // The literal form never reaches the server through a URL client (it is normalised away), so prove
    // the server's own behaviour with a raw request line.
    let (status, body) = common::raw_get(
        &h.addr(),
        &format!("/api/nm/{}/../../../etc/passwd", nm.authority()),
        None,
    )
    .await;
    assert_eq!(status, 404, "{body}");
    let (status, _) = common::raw_get(&h.addr(), "/api/yarn/apps/../../etc/passwd", None).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn node_manager_guard_fails_closed_when_the_node_list_is_unavailable() {
    let nm = Mock::start().await;
    nm.json("/ws/v1/node/info", r#"{"nodeInfo":{}}"#).await;

    let rm = Mock::start().await;
    rm.seed_rm().await;
    rm.set(
        "/ws/v1/cluster/nodes",
        Canned::new(
            500,
            "application/json",
            r#"{"RemoteException":{"exception":"Boom"}}"#,
        ),
    )
    .await;
    let h = Harness::start(Harness::config_for(&rm.base())).await;

    let r = h.get(&format!("/api/nm/{}/info", nm.authority())).await;
    assert_eq!(
        r.status, 500,
        "the RM's own failure is what we can honestly report"
    );
    assert_eq!(nm.total_hits().await, 0, "fail closed: nothing is proxied");
}

#[tokio::test]
async fn node_manager_daemon_pages_are_rewritten() {
    let nm = Mock::start().await;
    nm.set("/conf", Canned::new(200, "text/xml", "<configuration/>"))
        .await;
    nm.set("/jmx", Canned::json(r#"{"beans":[]}"#)).await;

    let rm = Mock::start().await;
    rm.seed_rm().await;
    rm.json(
        "/ws/v1/cluster/nodes",
        &format!(
            r#"{{"nodes":{{"node":[{{"nodeHTTPAddress":"{}","nodeHostName":"127.0.0.1"}}]}}}}"#,
            nm.authority()
        ),
    )
    .await;
    let h = Harness::start(Harness::config_for(&rm.base())).await;

    let conf = h.get(&format!("/api/nm/{}/conf", nm.authority())).await;
    assert_eq!(conf.status, 200);
    assert_eq!(conf.text(), "<configuration/>");
    assert!(conf.header("content-type").unwrap().contains("xml"));
    let jmx = h.get(&format!("/api/nm/{}/jmx", nm.authority())).await;
    assert_eq!(jmx.status, 200);
    assert_eq!(mock_path(&nm).await, "/jmx");
}

async fn mock_path(mock: &Mock) -> String {
    mock.last_request()
        .await
        .map(|l| l.split(' ').nth(1).unwrap_or("").to_string())
        .unwrap_or_default()
}

#[tokio::test]
async fn yarn_allowlist_covers_the_inventory_and_rewrites_nothing() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let inventory = [
        "scheduler/activities",
        "scheduler/bulk-activities",
        "scheduler/app-activities/application_1_0001",
        "scheduler-conf",
        "scheduler-conf/version",
        "scheduler-overview",
        "appstatistics",
        "get-node-labels",
        "get-rm-node-labels",
        "nodes/127.0.0.2:8041/get-labels",
        "get-node-to-labels",
        "label-mappings",
        "resource-profiles",
        "resource-types",
        "userinfo",
        "containers/container_1_0001_01_000001",
        "apps/application_1_0001/appattempts",
        "apps/application_1_0001/appattempts/appattempt_1_0001_000001",
        "apps/application_1_0001/appattempts/appattempt_1_0001_000001/containers",
        "apps/application_1_0001/state",
        "apps/application_1_0001/queue",
        "apps/application_1_0001/timeouts",
        "apps/application_1_0001/timeouts/LIFETIME",
        "metrics?q=1",
    ];
    for path in inventory {
        mock.json(&format!("/ws/v1/cluster/{path}"), r#"{"ok":true}"#)
            .await;
    }
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    for path in inventory {
        let r = h.get(&format!("/api/yarn/{path}")).await;
        assert_eq!(r.status, 200, "{path} → {} {}", r.status, r.text());
        assert_eq!(r.json()["ok"], true, "{path}");
        assert_eq!(
            mock.last_request().await.unwrap().split(' ').nth(1),
            Some(format!("/ws/v1/cluster/{path}").as_str()),
            "{path} must map straight to /ws/v1/cluster/{path}"
        );
    }
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/state").await, 0);
}
