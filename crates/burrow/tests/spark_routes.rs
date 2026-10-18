//! Route-level tests for `/api/spark/*` (contract §4) against a scriptable mock upstream — no JVM, no
//! live cluster. Covers the resolver (live / history / none, attempt override, RM down, SHS down,
//! tracking-URL derivation), the REST passthrough (path shape, verbatim query, TTL/cache, 304, error
//! envelope) and the DAG routes (HTML → JSON, skipped stage from the job page, REST fallback, 404s).

mod common;

use std::path::Path;

use burrow_core::config::Config;
use burrow_core::spark::dag;
use common::{Canned, Harness};
use serde_json::Value;

const APP: &str = "application_1_0001";

fn fixture(rel: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/spark")
        .join(rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn golden(rel: &str) -> Value {
    serde_json::from_slice(&fixture(rel)).expect("golden JSON")
}

/// Like [`Harness::config_for`] but with production TTLs, so cache/304 assertions are deterministic.
fn cfg(base: &str) -> Config {
    let mut c = Harness::config_for(base);
    c.cache.ttl_scale = 1.0;
    c
}

async fn rm_app(mock: &common::Mock, id: &str, state: &str, extra: &str) {
    mock.json(
        &format!("/ws/v1/cluster/apps/{id}"),
        &format!(r#"{{"app":{{"id":"{id}","state":"{state}","applicationType":"SPARK"{extra}}}}}"#),
    )
    .await;
}

/// A mock ResourceManager seeded with one app + its cached bodies for the given outer state.
async fn mock_with_app(state: &str) -> common::Mock {
    let mock = common::Mock::start().await;
    rm_app(&mock, APP, state, "").await;
    mock
}

// ------------------------------------------------------------------------------------------------
// Resolver
// ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn source_live_proxy_for_a_running_app() {
    let mock = mock_with_app("RUNNING").await;
    let h = Harness::start(cfg(&mock.base())).await;

    let r = h.get(&format!("/api/spark/{APP}/source")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("x-burrow-api").as_deref(), Some("1"));
    assert_eq!(r.cache(), "miss");
    assert_eq!(
        r.header("x-burrow-upstream").as_deref(),
        Some(mock.authority().as_str())
    );
    let j = r.json();
    assert_eq!(j["mode"], "live-proxy");
    assert_eq!(j["baseUrl"], format!("{}/proxy/{APP}", mock.base()));
    assert_eq!(j["sparkAppId"], APP);
    assert!(j["attempt"].is_null(), "{j}");
    assert_eq!(j["available"], true);
    assert!(j["reason"].is_null());
    println!("source(live): {j}");
}

#[tokio::test]
async fn source_history_appends_the_attempt_segment() {
    let mock = mock_with_app("FINISHED").await;
    // The Spark app document carries the attempt id that the SHS requires for cluster mode.
    mock.json(
        &format!("/api/v1/applications/{APP}"),
        &format!(
            r#"{{"id":"{APP}","name":"w","attempts":[{{"attemptId":"2","completed":true}}]}}"#
        ),
    )
    .await;
    mock.json(
        &format!("/api/v1/applications/{APP}/2/jobs"),
        r#"{"jobs":[{"jobId":0}]}"#,
    )
    .await;
    let mut c = cfg(&mock.base());
    c.spark_history = vec![mock.base().parse().unwrap()];
    let h = Harness::start(c).await;

    let j = h.get(&format!("/api/spark/{APP}/source")).await.json();
    assert_eq!(j["mode"], "history");
    assert_eq!(j["attempt"], "2");
    assert_eq!(j["available"], true);
    assert_eq!(j["baseUrl"], mock.base());
    println!("source(history): {j}");

    // The passthrough uses the attempt-segmented path.
    let r = h.get(&format!("/api/spark/{APP}/jobs")).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        mock.hits(&format!("/api/v1/applications/{APP}/2/jobs"))
            .await,
        1
    );
    assert_eq!(
        mock.hits(&format!("/api/v1/applications/{APP}/jobs")).await,
        0
    );
}

#[tokio::test]
async fn source_history_without_a_history_server_is_none_with_a_hint() {
    let mock = mock_with_app("FINISHED").await;
    let h = Harness::start(cfg(&mock.base())).await;

    let j = h.get(&format!("/api/spark/{APP}/source")).await.json();
    assert_eq!(j["mode"], "none");
    assert_eq!(j["available"], false);
    assert!(
        j["reason"]
            .as_str()
            .unwrap()
            .contains("no Spark History Server"),
        "{j}"
    );
    assert!(
        j["hint"].as_str().unwrap().contains("--spark-history"),
        "{j}"
    );

    // A passthrough on an unavailable source is the contract's `503 unavailable` + hint.
    let r = h.get(&format!("/api/spark/{APP}/jobs")).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.error_code(), "unavailable");
    assert!(r.json()["error"]["hint"].is_string());
    println!("unavailable envelope: {}", r.text());
}

#[tokio::test]
async fn source_derives_a_history_server_from_the_tracking_url() {
    let mock = common::Mock::start().await;
    rm_app(
        &mock,
        APP,
        "FINISHED",
        r#","trackingUrl":"http://shs.example:18080/history/application_1_0001/2/jobs/""#,
    )
    .await;
    let h = Harness::start(cfg(&mock.base())).await;

    let j = h.get(&format!("/api/spark/{APP}/source")).await.json();
    assert_eq!(j["mode"], "history");
    assert_eq!(j["baseUrl"], "http://shs.example:18080");
    assert_eq!(j["available"], false, "{j}");
    assert!(
        j["reason"]
            .as_str()
            .unwrap()
            .contains("http://shs.example:18080")
    );
    assert_eq!(j["hint"], "pass --spark-history http://shs.example:18080");
    println!("derived history: {j}");

    // The RM's own proxy tracking URL is not a history server.
    let mock2 = common::Mock::start().await;
    rm_app(
        &mock2,
        APP,
        "FINISHED",
        r#","trackingUrl":"http://rm.example:8088/proxy/application_1_0001/""#,
    )
    .await;
    let h2 = Harness::start(cfg(&mock2.base())).await;
    let j = h2.get(&format!("/api/spark/{APP}/source")).await.json();
    assert_eq!(j["mode"], "none");
}

#[tokio::test]
async fn source_pending_application_is_live_but_unavailable() {
    let mock = mock_with_app("ACCEPTED").await;
    let h = Harness::start(cfg(&mock.base())).await;

    let j = h.get(&format!("/api/spark/{APP}/source")).await.json();
    assert_eq!(j["mode"], "live-proxy");
    assert_eq!(j["available"], false);
    assert!(j["reason"].as_str().unwrap().contains("ACCEPTED"), "{j}");

    let r = h.get(&format!("/api/spark/{APP}/jobs")).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.error_code(), "unavailable");
}

#[tokio::test]
async fn source_unknown_application_is_404_and_non_spark_is_none() {
    let mock = common::Mock::start().await;
    let h = Harness::start(cfg(&mock.base())).await;

    let r = h.get(&format!("/api/spark/{APP}/source")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");
    assert_eq!(
        r.json()["error"]["upstream"]["status"],
        404,
        "the RM origin is named in the envelope"
    );

    // A MAPREDUCE app has no Spark surface.
    let mock2 = common::Mock::start().await;
    mock2
        .json(
            &format!("/ws/v1/cluster/apps/{APP}"),
            r#"{"app":{"id":"application_1_0001","state":"FINISHED","applicationType":"MAPREDUCE"}}"#,
        )
        .await;
    let h2 = Harness::start(cfg(&mock2.base())).await;
    let j = h2.get(&format!("/api/spark/{APP}/source")).await.json();
    assert_eq!(j["mode"], "none");
    assert!(j["reason"].as_str().unwrap().contains("MAPREDUCE"), "{j}");
}

#[tokio::test]
async fn resourcemanager_down_is_502() {
    let h = Harness::start(cfg("http://127.0.0.1:1")).await;
    let r = h.get(&format!("/api/spark/{APP}/source")).await;
    assert_eq!(r.status, 502, "{}", r.text());
    assert_eq!(r.error_code(), "upstream_unreachable");
}

#[tokio::test]
async fn history_server_down_is_502_on_passthrough() {
    let mock = mock_with_app("FINISHED").await;
    let mut c = cfg(&mock.base());
    c.spark_history = vec!["http://127.0.0.1:1".parse().unwrap()];
    let h = Harness::start(c).await;

    // The app is finished and a history server is configured, so a source *is* resolved.
    let j = h.get(&format!("/api/spark/{APP}/source")).await.json();
    assert_eq!(j["mode"], "history");
    assert_eq!(j["available"], true);
    assert!(j["attempt"].is_null(), "{j}");

    let r = h.get(&format!("/api/spark/{APP}/jobs")).await;
    assert_eq!(r.status, 502, "{}", r.text());
    assert_eq!(r.error_code(), "upstream_unreachable");
}

#[tokio::test]
async fn resolution_reads_the_resourcemanager_app_document_once_per_ttl() {
    let mock = mock_with_app("RUNNING").await;
    mock.json(
        &format!("/proxy/{APP}/api/v1/applications/{APP}/jobs"),
        r#"{"jobs":[]}"#,
    )
    .await;
    let h = Harness::start(cfg(&mock.base())).await;

    for _ in 0..3 {
        assert_eq!(h.get(&format!("/api/spark/{APP}/jobs")).await.status, 200);
    }
    assert_eq!(
        mock.hits(&format!("/ws/v1/cluster/apps/{APP}")).await,
        1,
        "the RM application document must be resolved once and reused"
    );
    assert_eq!(
        mock.hits(&format!("/proxy/{APP}/api/v1/applications/{APP}/jobs"))
            .await,
        1,
        "the passthrough body must be cached"
    );
}

// ------------------------------------------------------------------------------------------------
// Passthrough
// ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn passthrough_forwards_the_query_verbatim_and_strips_attempt() {
    let mock = mock_with_app("RUNNING").await;
    mock.json(
        &format!("/proxy/{APP}/api/v1/applications/{APP}/stages"),
        r#"{"stages":[]}"#,
    )
    .await;
    mock.json(
        &format!("/proxy/{APP}/api/v1/applications/{APP}/2/jobs"),
        r#"{"jobs":[]}"#,
    )
    .await;
    let h = Harness::start(cfg(&mock.base())).await;

    assert_eq!(
        h.get(&format!(
            "/api/spark/{APP}/stages?status=COMPLETE&details=true&quantiles=0.1,0.5"
        ))
        .await
        .status,
        200
    );
    assert_eq!(
        mock.hits(&format!(
            "/proxy/{APP}/api/v1/applications/{APP}/stages?status=COMPLETE&details=true&quantiles=0.1,0.5"
        )).await,
        1
    );

    // `attempt` is ours: it must not reach Spark, and it selects the attempt-segmented path.
    assert_eq!(
        h.get(&format!("/api/spark/{APP}/jobs?status=running&attempt=2"))
            .await
            .status,
        200
    );
    assert_eq!(
        mock.hits(&format!(
            "/proxy/{APP}/api/v1/applications/{APP}/2/jobs?status=running"
        ))
        .await,
        1
    );
}

#[tokio::test]
async fn passthrough_caches_and_revalidates_with_304() {
    let mock = mock_with_app("RUNNING").await;
    mock.json(
        &format!("/proxy/{APP}/api/v1/applications/{APP}/executors"),
        r#"{"executors":[{"id":"driver"}]}"#,
    )
    .await;
    let h = Harness::start(cfg(&mock.base())).await;
    let url = format!("/api/spark/{APP}/executors");

    let first = h.get(&url).await;
    assert_eq!(first.status, 200);
    assert_eq!(first.cache(), "miss");
    assert_eq!(first.json()["executors"][0]["id"], "driver");
    let etag = first.header("etag").expect("etag on a cacheable body");
    assert!(etag.starts_with("W/"), "{etag}");
    assert!(
        first
            .header("x-burrow-age")
            .is_some_and(|age| age.parse::<u64>().is_ok()),
        "a fetched response carries its measured age, which can advance before delivery"
    );

    let second = h.get(&url).await;
    assert_eq!(second.status, 200);
    assert_eq!(second.cache(), "hit");
    assert_eq!(second.header("etag").as_deref(), Some(etag.as_str()));

    let revalidated = h.get_with(&url, &[("if-none-match", &etag)]).await;
    assert_eq!(revalidated.status, 304);
    assert!(revalidated.body.is_empty());

    // `Cache-Control: no-cache` bypasses (and refreshes).
    let bypass = h.get_with(&url, &[("cache-control", "no-cache")]).await;
    assert_eq!(bypass.cache(), "bypass");
    assert_eq!(bypass.status, 200);
}

#[tokio::test]
async fn unknown_sub_resource_and_bad_attempt_are_envelopes() {
    let mock = mock_with_app("RUNNING").await;
    let h = Harness::start(cfg(&mock.base())).await;

    let r = h.get(&format!("/api/spark/{APP}/logs")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");
    assert_eq!(r.header("x-burrow-api").as_deref(), Some("1"));

    let r = h.get(&format!("/api/spark/{APP}/jobs?attempt=nope")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.error_code(), "bad_request");

    let r = h.get("/api/spark/not_an_app_id/jobs").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");

    // Traversal attempts never reach the table (there is no path here at all).
    let (status, _) = common::raw_get(&h.addr(), &format!("/api/spark/{APP}/../jobs"), None).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn spark_semantic_404_passes_through_with_its_status() {
    let mock = mock_with_app("RUNNING").await;
    mock.set(
        &format!("/proxy/{APP}/api/v1/applications/{APP}/storage/rdd/9999"),
        Canned::new(404, "text/plain", "no rdd found w/ id 9999"),
    )
    .await;
    let h = Harness::start(cfg(&mock.base())).await;

    let r = h.get(&format!("/api/spark/{APP}/storage/rdd/9999")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.text(), "no rdd found w/ id 9999");
}

#[tokio::test]
async fn spark_jetty_error_page_becomes_the_json_envelope() {
    let mock = mock_with_app("RUNNING").await;
    mock.set(
        &format!("/proxy/{APP}/api/v1/applications/{APP}/stages/1/0/taskList"),
        Canned::new(
            404,
            "text/html;charset=iso-8859-1",
            "<html><head><title>Error 404 Not Found</title></head><body><h2>HTTP ERROR 404</h2></body></html>",
        ),
    )
    .await;
    let h = Harness::start(cfg(&mock.base())).await;

    let r = h
        .get(&format!(
            "/api/spark/{APP}/stages/1/0/taskList?sortBy=DURATION"
        ))
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");
    assert_eq!(
        r.header("content-type").as_deref(),
        Some("application/json")
    );
}

// ------------------------------------------------------------------------------------------------
// DAG routes
// ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn dag_job_parses_the_page_and_never_forwards_html() {
    let mock = mock_with_app("FINISHED").await;
    let mut c = cfg(&mock.base());
    c.spark_history = vec![mock.base().parse().unwrap()];
    // No attemptId in the app document: client-mode shape, so the SHS paths have no attempt segment.
    mock.json(
        &format!("/api/v1/applications/{APP}"),
        &format!(r#"{{"id":"{APP}","name":"w","attempts":[{{"completed":true}}]}}"#),
    )
    .await;
    mock.set(
        &format!("/history/{APP}/jobs/job/?id=1"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            fixture("4.2.0/rdd-wordcount/html/final.job-1.html"),
        ),
    )
    .await;
    let h = Harness::start(c).await;

    let r = h.get(&format!("/api/spark/{APP}/dag/jobs/1")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        r.header("content-type").as_deref(),
        Some("application/json")
    );
    let body = r.text();
    assert!(
        !body.contains("dag-viz-metadata") && !body.contains("<html"),
        "raw HTML must never be forwarded"
    );
    assert_eq!(r.json(), golden("4.2.0/rdd-wordcount/dag-job-1.json"));
    assert!(r.header("etag").is_some());

    // A matching If-None-Match revalidates the derived JSON.
    let etag = r.header("etag").unwrap();
    let again = h
        .get_with(
            &format!("/api/spark/{APP}/dag/jobs/1"),
            &[("if-none-match", &etag)],
        )
        .await;
    assert_eq!(again.status, 304);
}

#[tokio::test]
async fn dag_skipped_stage_comes_from_the_enclosing_job_page() {
    let mock = mock_with_app("FINISHED").await;
    let mut c = cfg(&mock.base());
    c.spark_history = vec![mock.base().parse().unwrap()];
    mock.json(
        &format!("/api/v1/applications/{APP}"),
        &format!(r#"{{"id":"{APP}","attempts":[{{"completed":true}}]}}"#),
    )
    .await;
    // The skipped stage's own page is a placeholder (no graph) …
    mock.set(
        &format!("/history/{APP}/stages/stage/?id=3&attempt=0"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            fixture("4.2.0/sql-cache-union/html/final.stage-3-0.html"),
        ),
    )
    .await;
    // … while REST agrees it is SKIPPED, and the /jobs list names the jobs containing it.
    mock.json(
        &format!("/api/v1/applications/{APP}/stages/3/0"),
        r#"{"stageId":3,"attemptId":0,"status":"SKIPPED","rddIds":[3,2,1,0]}"#,
    )
    .await;
    mock.json(
        &format!("/api/v1/applications/{APP}/jobs"),
        r#"[{"jobId":7,"stageIds":[9,10]},{"jobId":2,"stageIds":[3,4]}]"#,
    )
    .await;
    mock.set(
        &format!("/history/{APP}/jobs/job/?id=2"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            fixture("4.2.0/sql-cache-union/html/final.job-2.html"),
        ),
    )
    .await;
    let h = Harness::start(c).await;

    let r = h.get(&format!("/api/spark/{APP}/dag/stages/3/0")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let j = r.json();
    assert_eq!(j["kind"], "stage");
    assert_eq!(j["granularity"], "rdd");
    assert_eq!(j["stages"].as_array().unwrap().len(), 1);
    assert_eq!(j["stages"][0]["stageId"], 3);
    assert_eq!(j["stages"][0]["skipped"], true);
    assert!(!j["stages"][0]["nodes"].as_array().unwrap().is_empty());
    assert_eq!(j["edges"][0]["fromStage"], 3);
    assert_eq!(j["edges"][0]["toStage"], 4);
    // The stage slice equals the stage 3 of the job-2 golden.
    let job = golden("4.2.0/sql-cache-union/dag-job-2.json");
    assert_eq!(j["stages"][0], job["stages"][0]);
    assert_eq!(
        mock.hits(&format!("/history/{APP}/jobs/job/?id=7")).await,
        0
    );
    println!(
        "skipped stage DAG: {}",
        serde_json::to_string(&j["stages"][0]).unwrap()
    );
}

#[tokio::test]
async fn dag_job_falls_back_to_rest_when_the_page_has_no_graph() {
    let mock = mock_with_app("FINISHED").await;
    let mut c = cfg(&mock.base());
    c.spark_history = vec![mock.base().parse().unwrap()];
    mock.json(
        &format!("/api/v1/applications/{APP}"),
        &format!(r#"{{"id":"{APP}","attempts":[{{"completed":true}}]}}"#),
    )
    .await;
    // A live race: the page has no `#dag-viz-metadata`.
    mock.set(
        &format!("/history/{APP}/jobs/job/?id=2"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            "<html><body><span id=\"job-dag-viz\"></span></body></html>",
        ),
    )
    .await;
    let job = fixture("4.2.0/sql-cache-union/rest/final.job-2.json");
    let stages = fixture("4.2.0/sql-cache-union/rest/final.stages.json");
    mock.set(
        &format!("/api/v1/applications/{APP}/jobs/2"),
        Canned::new(200, "application/json", job.clone()),
    )
    .await;
    mock.set(
        &format!("/api/v1/applications/{APP}/stages"),
        Canned::new(200, "application/json", stages.clone()),
    )
    .await;
    let h = Harness::start(c).await;

    let r = h.get(&format!("/api/spark/{APP}/dag/jobs/2")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let j = r.json();
    assert_eq!(j["granularity"], "stage");
    assert_eq!(j["edgesInferred"], true);
    assert_eq!(j["jobId"], 2);

    // Exactly the reference fallback, computed from the same REST documents.
    let job: Value = serde_json::from_slice(&job).unwrap();
    let stages: Vec<Value> = serde_json::from_slice(&stages).unwrap();
    let expected = serde_json::to_value(dag::rest_fallback_dag(&job, &stages)).unwrap();
    assert_eq!(j, expected);
    println!(
        "fallback DAG: {} stages, {} inferred edges",
        j["stages"].as_array().unwrap().len(),
        j["edges"].as_array().unwrap().len()
    );
}

#[tokio::test]
async fn dag_unknown_job_and_stage_are_404() {
    let mock = mock_with_app("FINISHED").await;
    let mut c = cfg(&mock.base());
    c.spark_history = vec![mock.base().parse().unwrap()];
    mock.json(
        &format!("/api/v1/applications/{APP}"),
        &format!(r#"{{"id":"{APP}","attempts":[{{"completed":true}}]}}"#),
    )
    .await;
    mock.set(
        &format!("/history/{APP}/jobs/job/?id=9999"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            fixture("4.2.0/rdd-wordcount/html/final.job-9999.html"),
        ),
    )
    .await;
    mock.set(
        &format!("/history/{APP}/stages/stage/?id=9999&attempt=0"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            fixture("4.2.0/rdd-wordcount/html/final.stage-9999-0.html"),
        ),
    )
    .await;
    let h = Harness::start(c).await;

    let r = h.get(&format!("/api/spark/{APP}/dag/jobs/9999")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");
    assert!(r.json()["error"]["hint"].is_string());

    let r = h.get(&format!("/api/spark/{APP}/dag/stages/9999/0")).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.error_code(), "not_found");

    // Malformed ids are the client's bug, not a Spark miss.
    assert_eq!(
        h.get(&format!("/api/spark/{APP}/dag/jobs/x")).await.status,
        400
    );
    assert_eq!(
        h.get(&format!("/api/spark/{APP}/dag/stages/1"))
            .await
            .status,
        404
    );
    assert_eq!(h.get(&format!("/api/spark/{APP}/dag")).await.status, 404);
}

#[tokio::test]
async fn dag_uses_the_rest_fallback_for_a_live_stage_with_no_graph() {
    let mock = mock_with_app("RUNNING").await;
    mock.set(
        &format!("/proxy/{APP}/stages/stage/?id=4&attempt=0"),
        Canned::new(
            200,
            "text/html;charset=utf-8",
            "<html><body><span id=\"stage-dag-viz\"></span></body></html>",
        ),
    )
    .await;
    mock.json(
        &format!("/proxy/{APP}/api/v1/applications/{APP}/stages/4/0"),
        r#"{"stageId":4,"attemptId":0,"status":"ACTIVE","rddIds":[9,8]}"#,
    )
    .await;
    let h = Harness::start(cfg(&mock.base())).await;

    let j = h
        .get(&format!("/api/spark/{APP}/dag/stages/4/0"))
        .await
        .json();
    assert_eq!(j["kind"], "stage");
    assert_eq!(j["granularity"], "stage");
    assert_eq!(j["edgesInferred"], true);
    assert_eq!(j["stages"][0]["stageId"], 4);
    assert_eq!(j["stages"][0]["status"], "ACTIVE");
    assert_eq!(j["stages"][0]["rddIds"], serde_json::json!([8, 9]));
    assert_eq!(j["edges"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn dag_on_an_unavailable_source_is_503() {
    let mock = mock_with_app("FINISHED").await;
    let h = Harness::start(cfg(&mock.base())).await;

    let r = h.get(&format!("/api/spark/{APP}/dag/jobs/0")).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.error_code(), "unavailable");
    assert!(r.json()["error"]["hint"].is_string());
}

#[tokio::test]
async fn application_route_maps_to_the_bare_application_document() {
    let mock = mock_with_app("FINISHED").await;
    let mut c = cfg(&mock.base());
    c.spark_history = vec![mock.base().parse().unwrap()];
    mock.json(
        &format!("/api/v1/applications/{APP}"),
        &format!(
            r#"{{"id":"{APP}","name":"w","attempts":[{{"attemptId":"1","completed":true}}]}}"#
        ),
    )
    .await;
    let h = Harness::start(c).await;

    let r = h.get(&format!("/api/spark/{APP}/application")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["id"], APP);
    // Spark has no `/application` sub-path *and* the attempt-scoped path is a narrower document, so the
    // route must fetch the bare application document — with or without an attempt override. That path is
    // also what the resolver reads to find the attempt id, so exactly one upstream fetch happens.
    assert_eq!(mock.hits(&format!("/api/v1/applications/{APP}")).await, 1);
    assert_eq!(
        mock.hits(&format!("/api/v1/applications/{APP}/1/application"))
            .await,
        0
    );
    assert_eq!(mock.hits(&format!("/api/v1/applications/{APP}/1")).await, 0);

    let again = h
        .get(&format!("/api/spark/{APP}/application?attempt=9"))
        .await;
    assert_eq!(again.status, 200, "{}", again.text());
    assert_eq!(again.json()["id"], APP);
}

#[tokio::test]
async fn spark_24_sql_rest_404_uses_the_html_execution_and_plan_adapter() {
    let mock = mock_with_app("RUNNING").await;
    let proxy = format!("/proxy/{APP}");
    mock.json(
        &format!("{proxy}/api/v1/applications/{APP}"),
        &format!(
            r#"{{"id":"{APP}","attempts":[{{"completed":false,"appSparkVersion":"2.4.0"}}]}}"#
        ),
    )
    .await;
    mock.set(
        &format!("{proxy}/api/v1/applications/{APP}/sql"),
        Canned::new(404, "text/plain", "Unknown resource: sql"),
    )
    .await;
    mock.set(
        &format!("{proxy}/SQL/"),
        Canned::new(200, "text/html", fixture("2.4.0/sql-demo/sql.html")),
    )
    .await;
    mock.set(
        &format!("{proxy}/SQL/execution/"),
        Canned::new(200, "text/html", fixture("2.4.0/sql-demo/execution-2.html")),
    )
    .await;

    let h = Harness::start(cfg(&mock.base())).await;
    let list = h.get(&format!("/api/spark/{APP}/sql")).await;
    assert_eq!(list.status, 200, "{}", list.text());
    let list_json = list.json();
    assert_eq!(list_json.as_array().unwrap().len(), 3);
    let execution = list_json
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == 2)
        .unwrap();
    assert_eq!(execution["status"], "COMPLETED");
    assert_eq!(execution["successJobIds"].as_array().unwrap().len(), 3);
    assert_eq!(mock.hits(&format!("{proxy}/SQL/")).await, 1);

    let detail = h.get(&format!("/api/spark/{APP}/sql/2")).await;
    assert_eq!(detail.status, 200, "{}", detail.text());
    let detail_json = detail.json();
    assert_eq!(detail_json["id"], 2);
    assert!(
        detail_json["planDescription"]
            .as_str()
            .is_some_and(|plan| plan.contains("== Physical Plan =="))
    );
    assert!(detail_json["nodes"].as_array().unwrap().len() >= 15);
    assert!(detail_json["edges"].as_array().unwrap().len() >= 12);
    assert!(
        detail_json["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["nodeName"] == "BroadcastHashJoin")
    );
    assert_eq!(mock.hits(&format!("{proxy}/SQL/execution/?id=2")).await, 1);
}
