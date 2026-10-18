//! ResourceManager HA: standby→active following, failover on connect errors, and the deliberate refusal
//! to replay a request that may already have reached an RM.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use burrow_core::config::{Config, Layer, PartialConfig, resolve};
use burrow_core::hadoop_conf::HadoopDiscovery;
use common::{Canned, Harness, Mock};

fn ha_config(urls: &[String]) -> Config {
    let values = PartialConfig {
        rm: Some(urls.to_vec()),
        ..Default::default()
    };
    let mut cfg =
        resolve(vec![Layer::new("test", values)], HadoopDiscovery::default()).expect("ha config");
    cfg.cache.ttl_scale = 0.05;
    cfg.no_open = true;
    cfg
}

const APP_MARKER_RM2: &str = r#"{"apps":{"app":[{"id":"from-rm2"}]}}"#;

/// A listener that accepts and immediately closes, counting connections.
async fn black_hole() -> (String, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::Relaxed);
            drop(stream);
        }
    });
    (format!("http://127.0.0.1:{port}"), count)
}

/// A port nothing listens on.
async fn dead_port() -> (tokio::net::TcpListener, String) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (listener, url)
}

#[tokio::test]
async fn a_standby_rm_redirects_us_to_the_active_one_and_we_remember_it() {
    let rm1 = Mock::start().await;
    let rm2 = Mock::start().await;

    // A standby RM redirects everywhere; the active one answers.
    rm1.set(
        "/ws/v1/cluster/info",
        Canned::json(r#"{"clusterInfo":{"haState":"STANDBY"}}"#)
            .with_header("location", &format!("{}/ws/v1/cluster/info", rm2.base()))
            .with_status(307),
    )
    .await;
    rm1.set(
        "/ws/v1/cluster/apps",
        Canned::json("{}")
            .with_header("location", &format!("{}/ws/v1/cluster/apps", rm2.base()))
            .with_status(307),
    )
    .await;
    rm2.json(
        "/ws/v1/cluster/info",
        r#"{"clusterInfo":{"haState":"ACTIVE","hadoopVersion":"3.4.3"}}"#,
    )
    .await;
    rm2.json("/ws/v1/cluster/apps", APP_MARKER_RM2).await;

    let h = Harness::start(ha_config(&[rm1.base(), rm2.base()])).await;

    let info = h.get("/api/yarn/info").await;
    assert_eq!(info.status, 200, "{}", info.text());
    assert_eq!(info.json()["clusterInfo"]["haState"], "ACTIVE");
    assert_eq!(
        info.header("x-burrow-upstream").as_deref(),
        Some(rm2.authority().as_str())
    );
    assert_eq!(rm1.hits_of_path("/ws/v1/cluster/info").await, 1);

    // The active RM is remembered: the next request goes straight to it.
    let apps = h.get("/api/yarn/apps").await;
    assert_eq!(apps.status, 200);
    assert_eq!(apps.json()["apps"]["app"][0]["id"], "from-rm2");
    assert_eq!(
        rm1.hits_of_path("/ws/v1/cluster/apps").await,
        0,
        "no standby round-trip"
    );
    assert_eq!(rm2.hits_of_path("/ws/v1/cluster/apps").await, 1);
    assert_eq!(
        h.core.rm_pool().active_url().as_deref(),
        Some(rm2.base().as_str())
    );
}

#[tokio::test]
async fn a_200_with_ha_state_standby_is_only_a_fallback() {
    // Some deployments answer 200 on the standby with haState STANDBY instead of redirecting.
    let rm1 = Mock::start().await;
    let rm2 = Mock::start().await;
    rm1.json(
        "/ws/v1/cluster/info",
        r#"{"clusterInfo":{"haState":"STANDBY"}}"#,
    )
    .await;
    rm2.json(
        "/ws/v1/cluster/info",
        r#"{"clusterInfo":{"haState":"ACTIVE","hadoopVersion":"3.4.3"}}"#,
    )
    .await;

    let h = Harness::start(ha_config(&[rm1.base(), rm2.base()])).await;
    let info = h.get("/api/yarn/info").await;
    assert_eq!(info.status, 200);
    assert_eq!(info.json()["clusterInfo"]["haState"], "ACTIVE");
    assert_eq!(
        info.header("x-burrow-upstream").as_deref(),
        Some(rm2.authority().as_str())
    );

    let (_, _active, ha_state, version, reachable) = {
        let (doc, _) = h.core.meta_document().await;
        (
            doc["rm"]["urls"].clone(),
            doc["rm"]["active"].clone(),
            doc["rm"]["haState"].clone(),
            doc["rm"]["hadoopVersion"].clone(),
            doc["rm"]["reachable"].clone(),
        )
    };
    assert_eq!(ha_state, "ACTIVE");
    assert_eq!(version, "3.4.3");
    assert_eq!(reachable, true);
}

#[tokio::test]
async fn a_connect_error_fails_over_to_the_next_rm() {
    let (dead_listener, dead) = dead_port().await;
    let rm2 = Mock::start().await;
    rm2.json(
        "/ws/v1/cluster/info",
        r#"{"clusterInfo":{"haState":"ACTIVE","hadoopVersion":"3.4.3"}}"#,
    )
    .await;

    let h = Harness::start(ha_config(&[dead, rm2.base()])).await;
    drop(dead_listener);
    let info = h.get("/api/yarn/info").await;
    assert_eq!(
        info.status, 200,
        "a dead RM first in the list must not fail the request"
    );
    assert_eq!(
        info.header("x-burrow-upstream").as_deref(),
        Some(rm2.authority().as_str())
    );
}

#[tokio::test]
async fn a_response_that_dies_mid_flight_is_not_replayed_on_another_rm() {
    // The request may have reached the RM, so GETs are only retried on *connect* errors.
    let (hole, connections) = black_hole().await;
    let rm2 = Mock::start().await;
    rm2.json("/ws/v1/cluster/apps", APP_MARKER_RM2).await;

    let h = Harness::start(ha_config(&[hole, rm2.base()])).await;
    let r = h.get("/api/yarn/apps").await;
    assert_eq!(r.status, 502, "{}", r.text());
    assert_eq!(r.error_code(), "upstream_unreachable");
    assert_eq!(
        connections.load(Ordering::Relaxed),
        1,
        "one attempt, not two"
    );
    assert_eq!(
        rm2.hits_of_path("/ws/v1/cluster/apps").await,
        0,
        "no replay on another RM"
    );
}

#[tokio::test]
async fn every_rm_down_is_a_502_and_then_we_back_off() {
    let (dead_listener, dead) = dead_port().await;
    let h = Harness::start(ha_config(&[dead])).await;
    drop(dead_listener);

    let first = h.get("/api/yarn/info").await;
    assert_eq!(first.status, 502);
    assert_eq!(first.error_code(), "upstream_unreachable");
    assert!(
        first.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cannot connect"),
        "{}",
        first.text()
    );

    let second = h.get("/api/yarn/info").await;
    assert_eq!(second.status, 502);
    assert!(
        second.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("backing off"),
        "a failed RM must not be hammered: {}",
        second.text()
    );
}

#[tokio::test]
async fn the_rm_list_is_the_configured_order_and_duplicates_collapse() {
    let rm1 = Mock::start().await;
    rm1.seed_rm().await;
    let cfg = ha_config(&[rm1.base(), rm1.base()]);
    assert_eq!(cfg.rm_urls.len(), 1, "duplicate --rm values collapse");
    let h = Harness::start(cfg).await;
    assert_eq!(h.core.rm_pool().len(), 1);
    assert!(!h.core.rm_pool().is_ha());
    assert_eq!(h.get("/api/yarn/info").await.status, 200);
}
