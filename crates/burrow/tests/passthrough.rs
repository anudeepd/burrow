//! Passthrough fidelity and the request-level contract (§1): headers, error envelopes, verbs, Host.

mod common;

use common::{Canned, Harness, Mock};

#[tokio::test]
async fn json_body_is_forwarded_byte_for_byte() {
    let mock = Mock::start().await;
    let body = r#"{"clusterInfo":{"id":1,"haState":"ACTIVE","note":"üñïçøde + \n newline"}}"#;
    mock.set("/ws/v1/cluster/info", Canned::json(body)).await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let r = h.get("/api/yarn/info").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, body.as_bytes(), "body must not be re-serialised");
    assert_eq!(r.header("x-burrow-api").as_deref(), Some("1"));
    assert_eq!(r.cache(), "miss");
    assert_eq!(
        r.header("x-burrow-upstream").as_deref(),
        Some(mock.authority().as_str())
    );
    assert!(
        r.header("x-burrow-age").is_some(),
        "miss carries an age of 0"
    );
    assert!(r.header("etag").is_some_and(|e| e.starts_with("W/\"")));
    assert!(
        r.header("content-type")
            .is_some_and(|c| c.starts_with("application/json"))
    );
}

#[tokio::test]
async fn upstream_non_2xx_json_passes_through_with_its_own_status() {
    let mock = Mock::start().await;
    let body = r#"{"RemoteException":{"exception":"YarnException","message":"app not found"}}"#;
    mock.set(
        "/ws/v1/cluster/apps/application_1_9999",
        Canned::new(404, "application/json;charset=utf-8", body),
    )
    .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let r = h.get("/api/yarn/apps/application_1_9999").await;
    assert_eq!(r.status, 404);
    assert_eq!(
        r.body,
        body.as_bytes(),
        "the RM's own error body is untouched"
    );
    assert_eq!(r.cache(), "miss");
    assert!(r.header("x-burrow-upstream").is_some());
    assert!(
        !r.header("etag").is_some_and(|e| !e.is_empty()),
        "errors are not cacheable and get no ETag"
    );
}

#[tokio::test]
async fn upstream_html_error_page_becomes_the_json_envelope() {
    let mock = Mock::start().await;
    mock.set(
        "/ws/v1/cluster/apps/application_1_4242",
        Canned::new(
            404,
            "text/html;charset=iso-8859-1",
            "<html><head><title>Error 404 Not Found</title></head><body><h2>HTTP ERROR 404</h2><p>Problem accessing /ws/v1/cluster/apps/x. Reason: <pre>Not Found</pre></p></body></html>",
        ),
    )
    .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let r = h.get("/api/yarn/apps/application_1_4242").await;
    assert_eq!(r.status, 404, "status is the upstream's");
    assert!(
        r.header("content-type")
            .unwrap()
            .starts_with("application/json")
    );
    let j = r.json();
    assert_eq!(j["error"]["code"], "not_found");
    assert!(
        j["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Error 404 Not Found"),
        "{j}"
    );
    assert_eq!(j["error"]["upstream"]["status"], 404);
    assert!(
        j["error"]["upstream"]["url"]
            .as_str()
            .unwrap()
            .contains("/ws/v1/cluster/apps/")
    );
}

#[tokio::test]
async fn unreachable_upstream_is_502_upstream_unreachable() {
    // Keep the port reserved until the harness has bound its own port; otherwise the harness can
    // accidentally claim the just-released upstream port.
    let dead_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let dead = format!("http://{}", dead_listener.local_addr().unwrap());
    let h = Harness::start(Harness::config_for(&dead)).await;
    drop(dead_listener);
    let r = h.get("/api/yarn/info").await;
    assert_eq!(r.status, 502);
    assert_eq!(r.error_code(), "upstream_unreachable");
    assert!(
        r.json()["error"]["upstream"]["url"]
            .as_str()
            .unwrap()
            .contains("/ws/v1/cluster/info")
    );
    assert!(
        r.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cannot connect")
    );
}

#[tokio::test]
async fn query_is_forwarded_verbatim_but_the_cache_key_sorts_names() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let first = h
        .get("/api/yarn/apps?states=RUNNING,ACCEPTED&limit=5")
        .await;
    assert_eq!(first.status, 200);
    assert_eq!(first.cache(), "miss");
    let seen = mock.last_request().await.unwrap();
    assert!(
        seen.ends_with("/ws/v1/cluster/apps?states=RUNNING,ACCEPTED&limit=5"),
        "values and order untouched: {seen}"
    );

    // Same parameters, different order ⇒ same cache entry ⇒ no second upstream request.
    let second = h
        .get("/api/yarn/apps?limit=5&states=RUNNING,ACCEPTED")
        .await;
    assert_eq!(second.cache(), "hit");
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/apps").await, 1);

    // A different *value* is a different entry.
    let third = h.get("/api/yarn/apps?states=FAILED&limit=5").await;
    assert_eq!(third.cache(), "miss");
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/apps").await, 2);
}

#[tokio::test]
async fn browser_cannot_inject_the_effective_user_or_tokens() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let r = h
        .get("/api/yarn/apps?user.name=evil&doas=evil&delegation=d&token=t&%75ser%2Ename=evil&%64oAs=evil&delega%74ion=d&%74oken=t&states=RUNNING")
        .await;
    assert_eq!(r.status, 200);
    let seen = mock.last_request().await.unwrap();
    assert!(seen.ends_with("?states=RUNNING"), "{seen}");
    assert!(!seen.contains("evil"), "{seen}");
}

#[tokio::test]
async fn configured_user_is_added_upstream_and_never_leaks_to_the_browser() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let mut cfg = Harness::config_for(&mock.base());
    cfg.user = Some("alice".into());
    let h = Harness::start(cfg).await;

    let r = h.get("/api/yarn/apps?states=RUNNING").await;
    assert_eq!(r.status, 200);
    let seen = mock.last_request().await.unwrap();
    assert!(seen.contains("states=RUNNING&user.name=alice"), "{seen}");
    assert!(!r.text().contains("alice") || r.text().contains("\"user\""));
    assert!(!r.header("x-burrow-upstream").unwrap().contains("alice"));
}

#[tokio::test]
async fn configured_headers_go_upstream_only() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let mut cfg = Harness::config_for(&mock.base());
    cfg.headers = vec![("X-Cluster-Token".into(), "s3cret".into())];
    cfg.token = Some("bearer-abc".into());
    let h = Harness::start(cfg).await;

    h.get("/api/yarn/info").await;
    // The mock records only the request line, so assert through the response: nothing of ours leaks.
    let r = h.get("/api/yarn/info").await;
    for (name, value) in r.headers.iter() {
        let value = value.to_str().unwrap_or_default();
        assert!(!value.contains("s3cret"), "credential leaked in {name}");
        assert!(!value.contains("bearer-abc"), "credential leaked in {name}");
    }
}

#[tokio::test]
async fn synthesized_endpoints() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let health = h.get("/api/healthz").await;
    assert_eq!(health.status, 200);
    assert_eq!(health.text(), "ok");
    assert_eq!(
        mock.total_hits().await,
        0,
        "healthz never touches an upstream"
    );
    assert!(
        health
            .header("content-type")
            .unwrap()
            .starts_with("text/plain")
    );

    let meta = h.get("/api/meta").await;
    assert_eq!(meta.status, 200);
    let j = meta.json();
    assert_eq!(j["name"], "burrow");
    assert_eq!(j["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(j["readOnly"], true);
    assert!(j["now"].as_u64().unwrap() > 1_600_000_000_000);
    assert_eq!(j["rm"]["urls"][0], mock.base());
    assert_eq!(j["rm"]["active"], mock.base());
    assert_eq!(j["rm"]["haState"], "ACTIVE");
    assert_eq!(j["rm"]["hadoopVersion"], "3.4.3");
    assert_eq!(j["rm"]["reachable"], true);
    assert_eq!(j["services"]["sparkHistory"]["configured"], false);
    assert_eq!(j["services"]["jobHistory"]["configured"], false);
    assert_eq!(j["services"]["timeline"]["configured"], false);
    assert_eq!(j["yarn"]["scheduler"], "capacity");
    assert_eq!(j["yarn"]["httpPolicy"], "HTTP_ONLY");
    assert_eq!(j["yarn"]["logServerUrl"], serde_json::Value::Null);
    // `features` describes *this build*: every documented key must be present and boolean, and the
    // ones whose slice is not implemented must never claim otherwise. (Slices flip their own flags to
    // `true` as they land, so this only pins the contract's shape plus the deliberate negatives.)
    let features = j["features"].as_object().unwrap();
    let mut keys: Vec<&str> = features.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "aggregatedLogs",
            "events",
            "kerberos",
            "nodeLogs",
            "sparkHistory",
            "sparkLive",
        ]
    );
    for (feature, value) in features {
        assert!(value.is_boolean(), "{feature} must be a boolean: {value}");
    }
    assert_eq!(
        features["kerberos"], false,
        "Kerberos is a disabled stretch item"
    );
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/info").await, 1);
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/scheduler").await, 1);
}

#[tokio::test]
async fn meta_configured_services_are_probed() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    mock.set("/", Canned::new(200, "text/html", "<html>history</html>"))
        .await;
    let mut cfg = Harness::config_for(&mock.base());
    cfg.spark_history = vec![mock.base().parse().unwrap()];
    let h = Harness::start(cfg).await;

    let j = h.get("/api/meta").await.json();
    assert_eq!(j["services"]["sparkHistory"]["configured"], true);
    assert_eq!(j["services"]["sparkHistory"]["url"], mock.base());
    assert_eq!(j["services"]["sparkHistory"]["reachable"], true);
    assert_eq!(j["services"]["jobHistory"]["configured"], false);

    // A dead history server is reported, not fatal.
    let dead_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let dead = format!("http://{}", dead_listener.local_addr().unwrap());
    let mut cfg = Harness::config_for(&mock.base());
    cfg.spark_history = vec![dead.parse().unwrap()];
    let h = Harness::start(cfg).await;
    drop(dead_listener);
    let j = h.get("/api/meta").await.json();
    assert_eq!(j["services"]["sparkHistory"]["reachable"], false);
    assert!(j["services"]["sparkHistory"]["reason"].is_string());
    assert_eq!(
        j["rm"]["reachable"], true,
        "a dead SHS does not affect the RM"
    );
}

#[tokio::test]
async fn unknown_api_groups_and_paths_are_404_not_found() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    for (path, needle) in [
        ("/api/nope", "unknown API group"),
        ("/api/wat", "unknown API group '/api/wat'"),
        ("/api/wat/thing", "unknown API group '/api/wat'"),
    ] {
        let r = h.get(path).await;
        assert_eq!(r.status, 404, "{path}");
        assert_eq!(r.error_code(), "not_found", "{path}");
        assert!(
            r.json()["error"]["message"]
                .as_str()
                .unwrap()
                .contains(needle),
            "{path}: {}",
            r.text()
        );
        assert_eq!(r.cache(), "bypass");
    }
    // Unknown resources inside a known group, including traversal attempts and bad ids.
    for path in [
        "/api/yarn/nope",
        "/api/yarn/apps/..",
        "/api/yarn/apps/application_1_1/../../etc/passwd",
        "/api/yarn/apps/%2e%2e",
        "/api/yarn/.",
        "/api/rm/logLevel",
        "/api/rm/nope",
    ] {
        let r = h.get(path).await;
        assert_eq!(r.status, 404, "{path} → {}", r.text());
        assert_eq!(r.error_code(), "not_found", "{path}");
    }
    assert_eq!(
        mock.total_hits().await,
        0,
        "no upstream request for rejected paths"
    );
}

#[tokio::test]
async fn trailing_slash_collection_paths_match_like_hadoop_clients_expect() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    // Hadoop's own clients and UIs request collection URLs with and without a trailing slash; the RM
    // answers 200 for both, so burrow must not invent a 404 for the slashed form.
    for path in [
        "/api/yarn/apps/",
        "/api/yarn/apps/application_1_0001/",
        "/api/yarn/nodes/",
        "/api/yarn/nodes/127.0.0.2:8041/",
        "/api/yarn/metrics/",
    ] {
        let r = h.get(path).await;
        assert_eq!(r.status, 200, "{path} → {}", r.text());
    }
    // The upstream sees the resource without the slash (one canonical form, one cache entry).
    // `requests()` reports request lines ("GET <path> HTTP/1.1 -> <path>"), so match on the target path.
    let reqs = mock.requests().await;
    assert!(
        reqs.iter().any(|r| r.ends_with("-> /ws/v1/cluster/nodes")),
        "upstream path should be normalised: {reqs:?}"
    );
    assert!(
        !reqs
            .iter()
            .any(|r| r.rsplit("-> ").next().is_some_and(|p| p.ends_with('/'))),
        "no upstream request should keep the trailing slash: {reqs:?}"
    );
    // …while a slash does not smuggle anything past the allowlist.
    let r = h.get("/api/yarn/nope/").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");
}

#[tokio::test]
async fn only_get_is_allowed() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;
    let resp = h
        .client
        .post(h.url("/api/meta"))
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 405);
    assert_eq!(resp.headers().get("allow").unwrap(), "GET");
}

#[tokio::test]
async fn host_header_allowlist() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    // loopback is always fine
    let ok = h.get("/api/healthz").await;
    assert_eq!(ok.status, 200);
    let bad = h
        .client
        .get(h.url("/api/healthz"))
        .header("host", "evil.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status().as_u16(), 403);

    // an explicitly allowed non-loopback name (with or without the port) is accepted
    let h = Harness::start_with(
        Harness::config_for(&mock.base()),
        burrow::assets::Assets::embedded(),
        Some(vec!["burrow.internal:8787".into()]),
    )
    .await;
    for host in ["burrow.internal:8787", "burrow.internal"] {
        let r = h
            .client
            .get(h.url("/api/healthz"))
            .header("host", host)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 200, "host {host}");
    }
    let r = h
        .client
        .get(h.url("/api/healthz"))
        .header("host", "other.internal:8787")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 403);

    // `*` disables the check
    let h = Harness::start_with(
        Harness::config_for(&mock.base()),
        burrow::assets::Assets::embedded(),
        Some(vec!["*".into()]),
    )
    .await;
    let r = h
        .client
        .get(h.url("/api/healthz"))
        .header("host", "anything.at.all")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
}

#[tokio::test]
async fn security_headers_are_on_every_response() {
    let mock = Mock::start().await;
    mock.seed_rm().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    for path in ["/api/healthz", "/api/yarn/info", "/api/nope", "/"] {
        let r = h.get(path).await;
        assert_eq!(
            r.header("x-content-type-options").as_deref(),
            Some("nosniff"),
            "{path}"
        );
        assert_eq!(
            r.header("referrer-policy").as_deref(),
            Some("no-referrer"),
            "{path}"
        );
        let csp = r.header("content-security-policy").expect(path);
        assert!(csp.contains("default-src 'self'"), "{path}: {csp}");
        assert!(csp.contains("script-src 'self'"), "{path}: {csp}");
        assert!(
            r.header("access-control-allow-origin").is_none(),
            "no CORS on {path}"
        );
    }
}
