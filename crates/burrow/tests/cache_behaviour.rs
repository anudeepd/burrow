//! Cache behaviour (§1, §6.3 of PLAN): coalescing, TTL, stale-while-revalidate, ETag/304, bypass,
//! query canonicalisation, body-size cap and the memory bound.

mod common;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::Request;
use burrow::app;
use common::{Canned, Harness, Mock, TestResponse};
use tower::ServiceExt;

async fn router_get(router: Router) -> TestResponse {
    let request = Request::builder()
        .uri("/api/yarn/metrics")
        .body(Body::empty())
        .expect("request");
    let response = router.oneshot(request).await.expect("router");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body")
        .to_vec();
    TestResponse {
        status,
        headers,
        body,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_hundred_concurrent_identical_requests_hit_the_upstream_exactly_once() {
    let mock = Mock::start().await;
    mock.set(
        "/ws/v1/cluster/metrics",
        Canned::json(r#"{"clusterMetrics":{"appsRunning":3}}"#).with_delay(250),
    )
    .await;
    // Keep the *real* TTL here (1 s for metrics): this test is about coalescing, and a 50 ms scaled TTL
    // would let a caller arriving late on a loaded machine legitimately start a fresh fetch.
    let mut cfg = Harness::config_for(&mock.base());
    cfg.cache.ttl_scale = 1.0;
    let h = Arc::new(Harness::start(cfg).await);

    // Traverse the production router in-process: 200 inbound TCP connections would test OS accept-queue limits,
    // not the single-flight cache behavior. The upstream remains a real local TCP server.
    let router = app::router(h.state.clone());
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..200 {
        let router = router.clone();
        set.spawn(async move { router_get(router).await });
    }
    let mut responses = Vec::new();
    while let Some(r) = set.join_next().await {
        responses.push(r.expect("task"));
    }

    assert_eq!(responses.len(), 200);
    for r in &responses {
        assert_eq!(r.status, 200, "{}", r.text());
        assert_eq!(r.json()["clusterMetrics"]["appsRunning"], 3);
    }
    assert_eq!(
        mock.total_hits().await,
        1,
        "200 callers ⇒ ONE upstream request"
    );
    let coalesced = responses
        .iter()
        .filter(|r| r.cache() == "coalesced")
        .count();
    let hits = responses.iter().filter(|r| r.cache() == "hit").count();
    let misses = responses.iter().filter(|r| r.cache() == "miss").count();
    assert_eq!(misses, 1, "exactly one caller leads the flight");
    // Everyone else either shared the in-flight fetch (coalesced) or, if the flight had already
    // completed by the time they got scheduled, read the fresh entry (hit) — never a second fetch.
    assert_eq!(coalesced + hits, 199, "no caller triggered its own fetch");
    assert!(coalesced >= 1, "the shared-flight path must be exercised");
    eprintln!("coalescing split: miss={misses} coalesced={coalesced} hit={hits}");
    // The mock's own connection count is small — the pool is reused, not stampeded.
    assert!(
        mock.connections().await <= 32,
        "connections={}",
        mock.connections().await
    );
}

#[tokio::test]
async fn ttl_expiry_refetches_and_hits_within_the_window() {
    let mock = Mock::start().await;
    mock.set("/ws/v1/cluster/metrics", Canned::json(r#"{"n":1}"#))
        .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    assert_eq!(h.get("/api/yarn/metrics").await.cache(), "miss");
    let hit = h.get("/api/yarn/metrics").await;
    assert_eq!(hit.cache(), "hit");
    assert_eq!(
        hit.header("x-burrow-upstream"),
        None,
        "a hit names no upstream"
    );
    let age: u64 = hit.header("x-burrow-age").unwrap().parse().unwrap();
    assert!(age < 1_000, "age={age}");

    // metrics TTL is 1 s, scaled to 50 ms by the harness.
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(h.get("/api/yarn/metrics").await.cache(), "miss");
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/metrics").await, 2);
}

#[tokio::test]
async fn terminal_app_details_live_longer_than_running_ones() {
    let mock = Mock::start().await;
    mock.json(
        "/ws/v1/cluster/apps/application_1_finished",
        r#"{"app":{"id":"application_1_finished","state":"FINISHED"}}"#,
    )
    .await;
    mock.json(
        "/ws/v1/cluster/apps/application_1_running",
        r#"{"app":{"id":"application_1_running","state":"RUNNING"}}"#,
    )
    .await;
    // Scale first, then make the two classes far apart so the difference is measurable.
    let mut cfg = Harness::config_for(&mock.base());
    cfg.cache.ttl_scale = 1.0;
    let core = burrow_core::core::Core::new(cfg).expect("core");
    let state = burrow::app::state_for(core, burrow::assets::Assets::embedded());
    let (port, handle) = burrow::app::serve_ephemeral(state).await.unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let get = |path: &str| {
        let client = client.clone();
        let url = format!("{base}/api/yarn/apps/{path}");
        async move {
            client
                .get(url)
                .send()
                .await
                .unwrap()
                .headers()
                .get("x-burrow-cache")
                .unwrap()
                .to_str()
                .unwrap()
                .to_string()
        }
    };
    assert_eq!(get("application_1_finished").await, "miss");
    assert_eq!(get("application_1_running").await, "miss");
    // 1.1 s later: a RUNNING app is stale (1 s), a FINISHED one is not (60 s).
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(
        get("application_1_finished").await,
        "hit",
        "finished apps cache for 60 s"
    );
    assert_eq!(
        get("application_1_running").await,
        "miss",
        "running apps refresh every second"
    );
    handle.abort();
}

#[tokio::test]
async fn upstream_error_serves_stale_when_available() {
    let mock = Mock::start().await;
    mock.set("/ws/v1/cluster/metrics", Canned::json(r#"{"n":"fresh"}"#))
        .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;
    assert_eq!(h.get("/api/yarn/metrics").await.cache(), "miss");

    // The RM starts failing after the entry expired.
    mock.set(
        "/ws/v1/cluster/metrics",
        Canned::new(
            500,
            "application/json",
            r#"{"RemoteException":{"exception":"Boom"}}"#,
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(120)).await;

    let r = h.get("/api/yarn/metrics").await;
    assert_eq!(r.status, 200, "stale data beats an error page");
    assert_eq!(r.json()["n"], "fresh");
    assert_eq!(r.cache(), "stale");
    assert_eq!(
        r.header("x-burrow-upstream"),
        None,
        "a stale body is served from memory"
    );
    assert_eq!(
        h.core
            .cache
            .stats()
            .stale
            .load(std::sync::atomic::Ordering::Relaxed),
        1
    );
}

#[tokio::test]
async fn stale_is_not_served_forever() {
    let mock = Mock::start().await;
    mock.set("/ws/v1/cluster/metrics", Canned::json(r#"{"n":"a"}"#))
        .await;
    let mut cfg = Harness::config_for(&mock.base());
    cfg.cache.max_stale = Duration::from_millis(60);
    let h = Harness::start(cfg).await;
    h.get("/api/yarn/metrics").await;

    mock.set(
        "/ws/v1/cluster/metrics",
        Canned::new(500, "application/json", "{}"),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let r = h.get("/api/yarn/metrics").await;
    assert_eq!(r.status, 500, "too old to be called stale");
    assert_eq!(r.cache(), "miss");
}

#[tokio::test]
async fn etag_revalidation_returns_an_empty_304() {
    let mock = Mock::start().await;
    mock.set(
        "/ws/v1/cluster/apps",
        Canned::json(r#"{"apps":{"app":[]}}"#),
    )
    .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let first = h.get("/api/yarn/apps").await;
    let etag = first.header("etag").expect("weak etag");
    assert!(etag.starts_with("W/\""));

    let revalidated = h
        .get_with("/api/yarn/apps", &[("If-None-Match", &etag)])
        .await;
    assert_eq!(revalidated.status, 304);
    assert!(revalidated.body.is_empty());
    assert_eq!(revalidated.header("etag").as_deref(), Some(etag.as_str()));
    assert_eq!(revalidated.cache(), "hit");
    assert!(revalidated.header("x-burrow-api").is_some());

    // A mismatching validator still gets the body.
    let fresh = h
        .get_with("/api/yarn/apps", &[("If-None-Match", "W/\"nope\"")])
        .await;
    assert_eq!(fresh.status, 200);
    assert!(!fresh.body.is_empty());

    // The upstream was contacted once: revalidation never leaves the box.
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/apps").await, 1);
}

#[tokio::test]
async fn no_cache_bypasses_and_refreshes_the_entry() {
    let mock = Mock::start().await;
    mock.set("/ws/v1/cluster/metrics", Canned::json(r#"{"n":1}"#))
        .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    for _ in 0..3 {
        let r = h
            .get_with("/api/yarn/metrics", &[("Cache-Control", "no-cache")])
            .await;
        assert_eq!(r.cache(), "bypass");
        assert_eq!(r.status, 200);
    }
    assert_eq!(
        mock.hits_of_path("/ws/v1/cluster/metrics").await,
        3,
        "bypass always reads through"
    );

    // The last bypass refreshed the entry, so a normal read is a plain hit.
    assert_eq!(h.get("/api/yarn/metrics").await.cache(), "hit");
}

#[tokio::test]
async fn oversized_bodies_are_streamed_and_never_cached() {
    let mock = Mock::start().await;
    // 8 KiB body, 1 KiB cache cap.
    let big: String = std::iter::repeat_n("0123456789abcdef", 512).collect();
    mock.set(
        "/ws/v1/cluster/metrics",
        Canned::json(format!(r#"{{"clusterMetrics":{{"blob":"{big}"}}}}"#)),
    )
    .await;
    let mut cfg = Harness::config_for(&mock.base());
    cfg.cache.max_body_bytes = 1024;
    let h = Harness::start(cfg).await;

    let first = h.get("/api/yarn/metrics").await;
    assert_eq!(first.status, 200);
    assert_eq!(
        first.json()["clusterMetrics"]["blob"],
        big,
        "the whole body still arrives"
    );
    assert_eq!(h.get("/api/yarn/metrics").await.cache(), "miss");
    assert_eq!(
        mock.hits_of_path("/ws/v1/cluster/metrics").await,
        2,
        "an oversized body is not kept, so it is fetched again"
    );
}

#[tokio::test]
async fn the_store_stays_within_its_byte_budget() {
    let mock = Mock::start().await;
    for i in 0..40 {
        mock.json(
            &format!("/ws/v1/cluster/apps/application_1_{i:04}"),
            &format!(
                r#"{{"app":{{"id":"application_1_{i:04}","pad":"{}"}}}}"#,
                "x".repeat(900)
            ),
        )
        .await;
    }
    let mut cfg = Harness::config_for(&mock.base());
    cfg.cache.max_bytes = 4 * 1024;
    let h = Harness::start(cfg).await;

    for i in 0..40 {
        let r = h.get(&format!("/api/yarn/apps/application_1_{i:04}")).await;
        assert_eq!(r.status, 200);
    }
    let (entries, bytes) = h.core.cache.usage();
    // 40 × ~1 KiB of bodies were fetched; the byte-weighted store must not hold them all.
    assert!(
        bytes < 32 * 1024,
        "weighted size {bytes} with a 4 KiB budget ({entries} entries)"
    );
}

#[tokio::test]
async fn canonical_query_key_ignores_parameter_order() {
    let mock = Mock::start().await;
    mock.json("/ws/v1/cluster/apps", r#"{"apps":{"app":[]}}"#)
        .await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    assert_eq!(
        h.get("/api/yarn/apps?states=RUNNING&limit=2").await.cache(),
        "miss"
    );
    assert_eq!(
        h.get("/api/yarn/apps?limit=2&states=RUNNING").await.cache(),
        "hit"
    );
    // `&&` and a trailing `&` are noise, not different resources.
    assert_eq!(
        h.get("/api/yarn/apps?limit=2&&states=RUNNING&")
            .await
            .cache(),
        "hit"
    );
    assert_eq!(mock.hits_of_path("/ws/v1/cluster/apps").await, 1);
}

#[tokio::test]
async fn cache_stats_are_counted() {
    let mock = Mock::start().await;
    mock.json("/ws/v1/cluster/metrics", r#"{"n":1}"#).await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;
    h.get("/api/yarn/metrics").await;
    h.get("/api/yarn/metrics").await;
    h.get_with("/api/yarn/metrics", &[("Cache-Control", "no-cache")])
        .await;
    let (hits, misses, coalesced, stale) = h.cache_stats();
    assert_eq!((hits, misses, coalesced, stale), (1, 1, 0, 0));
}
