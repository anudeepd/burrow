//! Live apps-index verification — **opt-in**. Skips unless `BURROW_LIVE=1` **and**
//! `.cluster/endpoints.json` exists.
//!
//! Proves that the preview/index path agrees with the ResourceManager itself: the complete total, the
//! default `-starttime` order, pagination and server-side state filtering all come from the same real list.

mod common;

use std::time::Duration;

use common::Harness;
use serde_json::Value;

fn live_rm() -> Option<String> {
    if std::env::var("BURROW_LIVE").as_deref() != Ok("1") {
        eprintln!(
            "skipping live apps-index test: set BURROW_LIVE=1 to run it against the real cluster"
        );
        return None;
    }
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cluster/endpoints.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!(
            "skipping live apps-index test: {} is absent",
            path.display()
        );
        return None;
    };
    let cluster: Value = serde_json::from_str(&text).expect("endpoints.json");
    Some(
        cluster["rm"]["webapp"]
            .as_str()
            .expect("rm.webapp")
            .to_string(),
    )
}

fn apps_of(body: &Value) -> Vec<Value> {
    match body.get("apps").and_then(|apps| apps.get("app")) {
        Some(Value::Array(apps)) => apps.clone(),
        Some(app @ Value::Object(_)) => vec![app.clone()],
        _ => Vec::new(),
    }
}

#[tokio::test]
async fn the_index_matches_the_real_resource_manager() {
    let Some(rm) = live_rm() else {
        return;
    };
    let harness = Harness::start(Harness::config_for(&rm)).await;

    let mut window = Value::Null;
    for _ in 0..150 {
        let response = harness
            .get("/api/yarn/apps?window=1&offset=0&limit=10")
            .await;
        assert_eq!(response.status, 200, "{}", response.text());
        window = response.json();
        if window["window"]["ready"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(window["window"]["ready"], true, "the index never completed");

    let direct_body = reqwest::get(format!(
        "{rm}/ws/v1/cluster/apps?deSelects=resourceRequests"
    ))
    .await
    .expect("direct RM apps")
    .bytes()
    .await
    .expect("direct RM body");
    let direct: Value = serde_json::from_slice(&direct_body).expect("direct RM JSON");
    let mut expected = apps_of(&direct);
    expected.sort_by(|a, b| {
        let at = a["startedTime"].as_i64().unwrap_or(0);
        let bt = b["startedTime"].as_i64().unwrap_or(0);
        bt.cmp(&at).then_with(|| {
            a["id"]
                .as_str()
                .unwrap_or("")
                .cmp(b["id"].as_str().unwrap_or(""))
        })
    });

    assert_eq!(window["window"]["total"], expected.len());
    assert_eq!(window["window"]["filteredTotal"], expected.len());
    let window_apps = apps_of(&window);
    let ids: Vec<&str> = window_apps
        .iter()
        .map(|app| app["id"].as_str().unwrap())
        .collect();
    let expected_ids: Vec<&str> = expected
        .iter()
        .take(10)
        .map(|app| app["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, expected_ids);

    let finished = expected
        .iter()
        .filter(|app| app["state"].as_str() == Some("FINISHED"))
        .count();
    let filtered = harness
        .get("/api/yarn/apps?window=1&offset=0&limit=100&states=FINISHED")
        .await
        .json();
    assert_eq!(filtered["window"]["filteredTotal"], finished);
    assert_eq!(filtered["window"]["total"], expected.len());
    assert_eq!(filtered["window"]["facets"]["total"], expected.len());
    for app in apps_of(&filtered) {
        assert_eq!(app["state"], "FINISHED");
    }
}
