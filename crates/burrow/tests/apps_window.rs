//! `/api/yarn/apps?window=1` — preview, complete index, paging, filters, sorting and snapshot lifecycle.

mod common;

use std::time::Duration;

use common::{Canned, Harness, Mock};
use serde_json::{Value, json};

const PREVIEW_QUERY: &str = "/ws/v1/cluster/apps?deSelects=resourceRequests&limit=2";
const FULL_QUERY: &str = "/ws/v1/cluster/apps?deSelects=resourceRequests";

fn apps_body(count: usize) -> String {
    let apps: Vec<Value> = (1..=count)
        .map(|i| {
            json!({
                "id": format!("application_1_{i:04}"),
                "user": if i % 2 == 0 { "bob" } else { "alice" },
                "name": format!("job-{i:02}"),
                "queue": "root.default",
                "state": if i % 3 == 0 { "FINISHED" } else { "RUNNING" },
                "finalStatus": if i % 3 == 0 { "SUCCEEDED" } else { "UNDEFINED" },
                "applicationType": if i % 2 == 0 { "SPARK" } else { "MAPREDUCE" },
                "applicationTags": if i % 2 == 0 { "etl,nightly" } else { "" },
                "priority": 0,
                "startedTime": i,
                "launchTime": i,
                "finishedTime": if i % 3 == 0 { i + 100 } else { 0 },
                "runningContainers": 1,
                "allocatedVCores": 1,
                "allocatedMB": 1024,
                "reservedVCores": 0,
                "reservedMB": 0,
                "queueUsagePercentage": 1.5,
                "clusterUsagePercentage": 0.5,
                "progress": 50.0,
                "trackingUI": "ApplicationMaster",
                "customFutureField": {"kept": true}
            })
        })
        .collect();
    serde_json::to_string(&json!({ "apps": { "app": apps } })).unwrap()
}

fn config(mock: &Mock) -> burrow_core::config::Config {
    let mut cfg = Harness::config_for(&mock.base());
    cfg.apps_index.refresh_after = Duration::from_secs(5);
    cfg.apps_index.retry_after = Duration::from_millis(50);
    cfg.apps_index.idle_after = Duration::from_secs(60);
    cfg.apps_index.preview_ttl = Duration::from_millis(10);
    cfg
}

async fn wait_ready(harness: &Harness, path: &str) -> Value {
    for _ in 0..100 {
        let response = harness.get(path).await;
        assert_eq!(response.status, 200, "{}", response.text());
        let body = response.json();
        if body["window"]["ready"] == true {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the application index never became ready");
}

#[tokio::test]
async fn first_request_returns_a_bounded_preview_and_starts_the_index() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json(apps_body(10))).await;
    mock.set(FULL_QUERY, Canned::json(apps_body(10)).with_delay(400))
        .await;
    let harness = Harness::start(config(&mock)).await;

    let response = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    assert_eq!(body["window"]["ready"], false);
    assert_eq!(body["window"]["partial"], true);
    assert_eq!(body["window"]["offset"], 0);
    assert_eq!(body["window"]["limit"], 2);
    assert_eq!(body["window"]["filteredTotal"], 10);
    assert_eq!(body["window"]["total"], Value::Null);
    assert_eq!(body["apps"]["app"].as_array().unwrap().len(), 2);
    assert_eq!(body["apps"]["app"][0]["customFutureField"]["kept"], true);
    // default sort is -starttime: the two newest apps, not the first two in the mock body.
    assert_eq!(body["apps"]["app"][0]["id"], "application_1_0010");
    assert_eq!(body["apps"]["app"][1]["id"], "application_1_0009");
    assert!(
        mock.requests()
            .await
            .iter()
            .any(|line| line.contains(PREVIEW_QUERY)),
        "the preview request must carry limit/deSelects: {:?}",
        mock.requests().await
    );
}

#[tokio::test]
async fn complete_index_serves_offsets_filters_sort_and_facets() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json(apps_body(10))).await;
    // The readiness poll asks for offset 2 + limit 2 while the index is still warming.
    mock.set(
        "/ws/v1/cluster/apps?deSelects=resourceRequests&limit=4",
        Canned::json(apps_body(10)),
    )
    .await;
    mock.set(FULL_QUERY, Canned::json(apps_body(10))).await;
    let harness = Harness::start(config(&mock)).await;

    // Trigger the index.
    harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    let path = "/api/yarn/apps?window=1&offset=2&limit=2";
    let body = wait_ready(&harness, path).await;
    assert_eq!(body["window"]["partial"], false);
    assert_eq!(body["window"]["total"], 10);
    assert_eq!(body["window"]["filteredTotal"], 10);
    // newest first: 10, 9, 8, 7; offset 2 => 8, 7.
    assert_eq!(body["apps"]["app"][0]["id"], "application_1_0008");
    assert_eq!(body["apps"]["app"][1]["id"], "application_1_0007");
    assert_eq!(body["window"]["facets"]["total"], 10);
    assert_eq!(body["window"]["facets"]["byState"]["RUNNING"], 7);
    assert_eq!(body["window"]["facets"]["byState"]["FINISHED"], 3);
    assert_eq!(body["window"]["facets"]["active"], 7);

    // Filters are exact and global; sort is applied before paging.
    let filtered = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=100&states=FINISHED&sort=name")
        .await
        .json();
    assert_eq!(filtered["window"]["filteredTotal"], 3);
    let ids: Vec<&str> = filtered["apps"]["app"]
        .as_array()
        .unwrap()
        .iter()
        .map(|app| app["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "application_1_0003",
            "application_1_0006",
            "application_1_0009"
        ]
    );

    // Name uses the same substring rule as the UI, not the RM's exact match.
    let named = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=100&name=JOB-0")
        .await
        .json();
    assert_eq!(named["window"]["filteredTotal"], 9);

    // Offset past the end is just an empty page with the exact total.
    let empty = harness
        .get("/api/yarn/apps?window=1&offset=99&limit=5")
        .await
        .json();
    assert_eq!(empty["window"]["filteredTotal"], 10);
    assert_eq!(empty["apps"], Value::Null);
}

#[tokio::test]
async fn preview_above_the_cap_never_touches_the_upstream_and_signals_retry() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json(apps_body(10))).await;
    mock.set(FULL_QUERY, Canned::json(apps_body(10))).await;
    let mut cfg = config(&mock);
    cfg.apps_index.preview_max = 4;
    let harness = Harness::start(cfg).await;

    let body = harness
        .get("/api/yarn/apps?window=1&offset=10&limit=5")
        .await
        .json();
    assert_eq!(body["window"]["ready"], false);
    assert_eq!(body["window"]["filteredTotal"], 15);
    assert_eq!(body["window"]["retryAfterMs"], 50);
    assert_eq!(body["apps"], Value::Null);
}

#[tokio::test]
async fn invalid_window_parameters_are_rejected_before_the_upstream() {
    let mock = Mock::start().await;
    let harness = Harness::start(config(&mock)).await;
    for query in [
        "window=1&offset=x",
        "window=1&limit=-1",
        "window=1&startedAfter=not-a-number",
        "window=1&finishedBefore=no",
    ] {
        let response = harness.get(&format!("/api/yarn/apps?{query}")).await;
        assert_eq!(response.status, 400, "{query}: {}", response.text());
        assert_eq!(response.error_code(), "bad_request");
    }
    assert_eq!(mock.total_hits().await, 0);
}

#[tokio::test]
async fn a_failed_refresh_keeps_serving_the_last_snapshot_as_stale() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json(apps_body(10))).await;
    mock.set(FULL_QUERY, Canned::json(apps_body(10))).await;
    let mut cfg = config(&mock);
    cfg.apps_index.refresh_after = Duration::from_millis(40);
    // No stale-while-revalidate fallback: this test exercises the index's own stale snapshot handling.
    cfg.cache.max_stale = Duration::from_millis(1);
    let harness = Harness::start(cfg).await;

    harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    wait_ready(&harness, "/api/yarn/apps?window=1&offset=0&limit=2").await;

    // Break the upstream and let the snapshot age past its refresh window.
    mock.set(FULL_QUERY, Canned::json("{}").with_status(503))
        .await;
    tokio::time::sleep(Duration::from_millis(80)).await;

    let stale = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    assert_eq!(stale.status, 200, "{}", stale.text());
    let body = stale.json();
    assert_eq!(body["window"]["ready"], true);
    assert_eq!(body["window"]["stale"], true);
    assert_eq!(body["window"]["total"], 10);
    assert_eq!(stale.cache(), "stale");

    // The failed refresh is retried on a later request, then reported without dropping the snapshot.
    let mut later = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await
        .json();
    for _ in 0..50 {
        if later["window"]["refreshError"].is_string() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        later = harness
            .get("/api/yarn/apps?window=1&offset=0&limit=2")
            .await
            .json();
    }
    assert_eq!(later["window"]["ready"], true);
    assert_eq!(later["window"]["total"], 10);
    assert!(later["window"]["refreshError"].is_string());
}

#[tokio::test]
async fn an_idle_snapshot_is_dropped_and_rebuilt_from_a_preview() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json(apps_body(10))).await;
    mock.set(FULL_QUERY, Canned::json(apps_body(10))).await;
    let mut cfg = config(&mock);
    cfg.apps_index.idle_after = Duration::from_millis(30);
    let harness = Harness::start(cfg).await;

    harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    wait_ready(&harness, "/api/yarn/apps?window=1&offset=0&limit=2").await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let replayed = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await
        .json();
    assert_eq!(replayed["window"]["ready"], false);
    assert_eq!(replayed["window"]["partial"], true);
}

#[tokio::test]
async fn preview_upstream_errors_are_returned_before_any_index_exists() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::new(503, "application/json", "{}"))
        .await;
    let harness = Harness::start(config(&mock)).await;

    let response = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    assert_eq!(response.status, 503, "{}", response.text());
    assert_eq!(response.error_code(), "upstream_status");
}

#[tokio::test]
async fn a_malformed_full_body_leaves_the_preview_path_usable() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json(apps_body(10))).await;
    mock.set(FULL_QUERY, Canned::json("not json")).await;
    let harness = Harness::start(config(&mock)).await;

    let first = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await
        .json();
    assert_eq!(first["window"]["ready"], false);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let second = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await
        .json();
    assert_eq!(second["window"]["ready"], false);
    assert_eq!(second["apps"]["app"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn an_unreachable_preview_returns_an_upstream_error() {
    let mut cfg = Harness::config_for("http://127.0.0.1:1");
    cfg.apps_index.refresh_after = Duration::from_secs(5);
    cfg.apps_index.retry_after = Duration::from_millis(50);
    let harness = Harness::start(cfg).await;
    let response = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    assert_eq!(response.status, 502, "{}", response.text());
    assert_eq!(response.error_code(), "upstream_unreachable");
}

#[tokio::test]
async fn an_invalid_preview_body_is_reported_as_an_internal_error() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json("not json")).await;
    let harness = Harness::start(config(&mock)).await;
    let response = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await;
    assert_eq!(response.status, 500, "{}", response.text());
    assert_eq!(response.error_code(), "internal");
}

#[tokio::test]
async fn a_transport_failure_during_the_background_refresh_keeps_the_preview() {
    let mock = Mock::start().await;
    mock.set(PREVIEW_QUERY, Canned::json(apps_body(10))).await;
    mock.set(FULL_QUERY, Canned::json(apps_body(10)).with_close())
        .await;
    let harness = Harness::start(config(&mock)).await;

    let first = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=2")
        .await
        .json();
    assert_eq!(first["window"]["ready"], false);
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(10)).await;
        let again = harness
            .get("/api/yarn/apps?window=1&offset=0&limit=2")
            .await
            .json();
        assert_eq!(again["window"]["ready"], false);
    }
    assert!(
        mock.hits_of_path(FULL_QUERY.split('?').next().unwrap())
            .await
            > 0
    );
}

#[tokio::test]
async fn the_non_window_path_remains_a_verbatim_passthrough() {
    let mock = Mock::start().await;
    mock.set("/ws/v1/cluster/apps", Canned::json(apps_body(10)))
        .await;
    let harness = Harness::start(config(&mock)).await;

    let response = harness.get("/api/yarn/apps").await;
    assert_eq!(response.status, 200);
    let body = response.json();
    assert!(body.get("window").is_none());
    assert_eq!(body["apps"]["app"].as_array().unwrap().len(), 10);
}
