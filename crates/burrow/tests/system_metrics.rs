//! `GET /api/system` end to end through the production router: the client cookie, request counters and
//! the cache section of the payload (contract §2.1).

mod common;

use common::{Harness, Mock};
use serde_json::Value;

async fn harness() -> (Mock, Harness) {
    let mock = Mock::start().await;
    let harness = Harness::start(Harness::config_for(&mock.base())).await;
    (mock, harness)
}

fn cookie_id(response: &common::TestResponse) -> String {
    response
        .header("set-cookie")
        .expect("the first request is identified")
        .split(';')
        .next()
        .and_then(|pair| pair.split_once('='))
        .map(|(_, value)| value.to_string())
        .expect("a burrow_client cookie")
}

#[tokio::test]
async fn system_reports_process_clients_requests_and_cache() {
    let (_mock, harness) = harness().await;

    let first = harness.get("/api/system").await;
    assert_eq!(first.status, 200);
    assert_eq!(first.cache(), "bypass");
    let cookie = cookie_id(&first);

    let json = first.json();
    assert_eq!(json["process"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(json["process"]["pid"].is_u64());
    assert!(json["process"]["uptimeSeconds"].is_u64());
    assert!(json["process"]["startedAtMs"].is_u64());
    for key in ["rssBytes", "peakRssBytes", "virtualBytes"] {
        assert!(
            json["process"]["memory"][key].is_null() || json["process"]["memory"][key].is_u64(),
            "process.memory.{key} is a number or null"
        );
    }
    assert_eq!(json["clients"]["active"], 1);
    assert_eq!(json["clients"]["streams"], 0);
    assert_eq!(json["clients"]["windowSeconds"], 300);
    assert!(json["requests"]["total"].is_u64());
    assert!(json["requests"]["inFlight"].is_u64());
    for class in ["1xx", "2xx", "3xx", "4xx", "5xx"] {
        assert!(json["requests"]["byStatus"][class].is_u64());
    }
    assert!(json["requests"]["errorsLast15m"].is_u64());
    assert!(json["requests"]["p50Ms"].is_u64());
    assert!(json["requests"]["p95Ms"].is_u64());
    assert_eq!(json["requests"]["history"].as_array().unwrap().len(), 15);
    assert!(json["memoryHistory"].is_array());
    assert!(json["recentErrors"].is_array());
    for key in [
        "entries",
        "bytes",
        "hits",
        "misses",
        "coalesced",
        "stale",
        "bypass",
        "upstreamFetches",
    ] {
        assert!(json["cache"][key].is_u64(), "cache.{key} is a number");
    }

    let repeated = harness
        .get_with(
            "/api/system",
            &[("cookie", &format!("burrow_client={cookie}"))],
        )
        .await;
    assert_eq!(repeated.status, 200);
    assert!(
        repeated.header("set-cookie").is_none(),
        "a valid cookie is reused, not replaced"
    );
    assert_eq!(repeated.json()["clients"]["active"], 1);

    let post = harness
        .client
        .post(harness.url("/api/system"))
        .header("host", harness.addr())
        .send()
        .await
        .unwrap();
    assert_eq!(post.status().as_u16(), 405);

    let nested = harness.get("/api/system/nested").await;
    assert_eq!(nested.status, 404);

    let after = harness.get("/api/system").await;
    assert_eq!(after.status, 200);
    let json: Value = after.json();
    assert_eq!(json["requests"]["byStatus"]["4xx"], 2);
    let errors = json["recentErrors"].as_array().unwrap();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0]["status"], 404);
    assert_eq!(errors[0]["path"], "/api/system/nested");
    assert_eq!(errors[1]["status"], 405);
    assert_eq!(errors[1]["path"], "/api/system");
}
