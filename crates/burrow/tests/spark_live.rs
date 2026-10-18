//! Live-cluster Spark test — **opt-in**. Skips unless `BURROW_LIVE=1` **and** `.cluster/endpoints.json`
//! exists. Run with:
//!
//! ```text
//! BURROW_LIVE=1 cargo test -p burrow --test spark_live -- --nocapture
//! ```
//!
//! What it proves, end to end against the real cluster:
//! 1. `/api/meta` describes the real Spark History Server;
//! 2. `/api/spark/{appId}/source` resolves a real Spark application (live RM web proxy when one is
//!    RUNNING, the History Server otherwise);
//! 3. the passthrough `/jobs` / `/stages` answers through that resolved base, and — for a finished app,
//!    whose data is immutable — is **byte-identical** to the same request made straight to the SHS
//!    (`Cache-Control: no-cache` on both sides);
//! 4. `/sql` lists executions when present and `/sql/{id}` returns a real plan, including Spark 2.4's
//!    HTML-only SQL UI;
//! 5. `/dag/jobs/{id}` returns a real RDD DAG parsed from the Spark UI HTML (never the HTML itself).
//!
//! SQL plan assertions select an app with SQL data when one exists; SQL-less apps still exercise the empty-list
//! response.
//!
//! If the cluster has no Spark app at all the test prints why and returns (it never fails for a missing
//! fixture — but it also never silently passes: the skip reason is explicit).

mod common;

use std::time::{Duration, Instant};

use common::Harness;
use serde_json::Value;

struct Live {
    rm: String,
    shs: Option<String>,
    hadoop_conf: Option<String>,
    spark_conf: Option<String>,
    hadoop: String,
}

fn live() -> Option<Live> {
    if std::env::var("BURROW_LIVE").as_deref() != Ok("1") {
        eprintln!("skipping live spark test: set BURROW_LIVE=1 to run it against the real cluster");
        return None;
    }
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cluster/endpoints.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "skipping live spark test: {} unreadable ({e})",
                path.display()
            );
            return None;
        }
    };
    let c: Value = serde_json::from_str(&text).expect("endpoints.json");
    Some(Live {
        rm: c["rm"]["webapp"].as_str().expect("rm.webapp").to_string(),
        shs: c["sparkHistory"]["webapp"].as_str().map(str::to_string),
        hadoop_conf: c["env"]["HADOOP_CONF_DIR"].as_str().map(str::to_string),
        spark_conf: c["env"]["SPARK_CONF_DIR"].as_str().map(str::to_string),
        hadoop: c["hadoopVersion"].as_str().unwrap_or("?").to_string(),
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("client")
}

async fn direct_bytes(url: &str) -> (u16, Vec<u8>) {
    let r = client()
        .get(url)
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .unwrap_or_else(|e| panic!("direct fetch {url}: {e}"));
    let status = r.status().as_u16();
    (status, r.bytes().await.expect("body").to_vec())
}

/// Top-level array length + the key set of its first element (a *stable* comparison for live data).
fn shape(v: &Value) -> (usize, Vec<String>) {
    let arr = v.as_array().cloned().unwrap_or_default();
    let mut keys: Vec<String> = arr
        .first()
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    keys.sort();
    (arr.len(), keys)
}

async fn wait_for_sql_plan(h: &Harness, app: &str) -> (i64, Value, Value) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let list = h.get(&format!("/api/spark/{app}/sql")).await;
        let last = if list.status == 200 {
            let rows = list.json();
            if let Some(id) = rows
                .as_array()
                .and_then(|items| items.iter().find_map(|item| item["id"].as_i64()))
            {
                let detail = h
                    .get(&format!(
                        "/api/spark/{app}/sql/{id}?details=true&planDescription=true"
                    ))
                    .await;
                if detail.status == 200 {
                    let detail = detail.json();
                    if detail["nodes"]
                        .as_array()
                        .is_some_and(|nodes| !nodes.is_empty())
                    {
                        return (id, rows, detail);
                    }
                    format!("SQL execution {id} has no plan nodes: {detail}")
                } else {
                    format!(
                        "SQL execution {id} returned {}: {}",
                        detail.status,
                        detail.text()
                    )
                }
            } else {
                format!("SQL list has no executions: {rows}")
            }
        } else {
            format!("SQL list returned {}: {}", list.status, list.text())
        };
        if Instant::now() >= deadline {
            panic!("Spark app {app} did not expose a SQL plan within 30s; last response: {last}");
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn live_spark_source_passthrough_and_dag() {
    let Some(live) = live() else { return };

    // The configuration the CLI would build: no flags, everything from the cluster's own Hadoop conf.
    let mut input = burrow_core::hadoop_conf::DiscoverInput {
        hadoop_conf_dir: live.hadoop_conf.as_ref().map(Into::into),
        spark_conf_dir: live.spark_conf.as_ref().map(Into::into),
        ..Default::default()
    };
    input.yarn_conf_dir = None;
    input.spark_home = None;
    input.fallback_dirs.clear();
    input.spark_fallback_dirs.clear();
    let discovery = burrow_core::hadoop_conf::discover(&input);
    let mut cfg = burrow_core::config::resolve(vec![], discovery).expect("resolve");
    cfg.cache.ttl_scale = 1.0;
    cfg.no_open = true;
    let h = Harness::start(cfg).await;

    let m = h.get("/api/meta").await.json();
    assert_eq!(m["rm"]["reachable"], true, "{m}");
    assert_eq!(m["rm"]["hadoopVersion"], live.hadoop);
    assert_eq!(m["features"]["sparkLive"], true);
    assert_eq!(m["features"]["sparkHistory"], true);
    println!(
        "meta: rm={} sparkHistory={} configured={} reachable={}",
        m["rm"]["active"],
        m["services"]["sparkHistory"]["url"],
        m["services"]["sparkHistory"]["configured"],
        m["services"]["sparkHistory"]["reachable"]
    );
    assert_eq!(m["services"]["sparkHistory"]["configured"], true);

    // Pick an application: a RUNNING Spark app first (live RM proxy), else a finished one the SHS knows.
    let (_, apps_body) = direct_bytes(&format!(
        "{}/ws/v1/cluster/apps?states=RUNNING,FINISHED,FAILED,KILLED",
        live.rm
    ))
    .await;
    let apps: Value = serde_json::from_slice(&apps_body).expect("RM apps");
    let is_spark = |a: &Value| {
        a["applicationType"]
            .as_str()
            .unwrap_or("")
            .to_uppercase()
            .contains("SPARK")
    };
    let list: Vec<Value> = apps["apps"]["app"].as_array().cloned().unwrap_or_default();
    let running = list
        .iter()
        .find(|a| a["state"] == "RUNNING" && is_spark(a))
        .map(|a| a["id"].as_str().unwrap().to_string());
    let finished = list
        .iter()
        .find(|a| is_spark(a) && a["state"] == "FINISHED")
        .map(|a| a["id"].as_str().unwrap().to_string());

    let (app, expect_live) = match (running, finished) {
        (Some(r), _) => (r, true),
        (None, Some(f)) => (f, false),
        (None, None) => {
            eprintln!(
                "skipping live spark test: the cluster has no SPARK application ({} apps total); \
                 `cluster/cluster.py submit long_running` leaves one RUNNING",
                list.len()
            );
            return;
        }
    };
    println!(
        "chosen app {app} ({})",
        if expect_live {
            "RUNNING → live proxy"
        } else {
            "FINISHED → history server"
        }
    );

    // 1. source
    let source = h.get(&format!("/api/spark/{app}/source")).await.json();
    println!("source: {source}");
    assert_eq!(source["sparkAppId"], app);
    assert_eq!(source["available"], true, "{source}");
    if expect_live {
        assert_eq!(source["mode"], "live-proxy", "{source}");
        assert_eq!(source["baseUrl"], format!("{}/proxy/{app}", live.rm));
    } else {
        assert_eq!(source["mode"], "history", "{source}");
    }
    let rest_base = if expect_live {
        format!("{}/proxy/{app}/api/v1/applications/{app}", live.rm)
    } else {
        let attempt = source["attempt"]
            .as_str()
            .map(|a| format!("/{a}"))
            .unwrap_or_default();
        format!(
            "{}/api/v1/applications/{app}{attempt}",
            live.shs.clone().expect("SHS webapp")
        )
    };

    // 2. passthrough: /jobs and /stages must answer, and match the direct upstream.
    let jobs = h.get(&format!("/api/spark/{app}/jobs")).await;
    println!(
        "jobs: status={} cache={} ct={:?} body[..240]={}",
        jobs.status,
        jobs.cache(),
        jobs.header("content-type"),
        &jobs.text()[..jobs.text().len().min(240)]
    );
    assert_eq!(jobs.status, 200, "{}", jobs.text());
    let jobs_json = jobs.json();
    assert!(jobs_json.is_array(), "{jobs_json}");

    let (direct_status, direct_body) = direct_bytes(&format!("{rest_base}/jobs")).await;
    assert_eq!(direct_status, 200);
    if !expect_live {
        assert_eq!(
            jobs.body, direct_body,
            "history-mode passthrough must be byte-identical to the SHS"
        );
        println!(
            "history passthrough: byte-identical ({} bytes)",
            jobs.body.len()
        );
    } else {
        let direct_json: Value = serde_json::from_slice(&direct_body).expect("direct jobs");
        assert_eq!(
            shape(&jobs_json),
            shape(&direct_json),
            "live job list shape"
        );
        println!(
            "live passthrough: key shape matches the RM proxy ({} jobs)",
            jobs_json.as_array().unwrap().len()
        );
    }

    // The application document must work from the history server alone (contract §4): Spark serves it at
    // the bare `/api/v1/applications/{id}`, *not* at an `/application` sub-path.
    let app_doc = h.get(&format!("/api/spark/{app}/application")).await;
    assert_eq!(app_doc.status, 200, "{}", app_doc.text());
    let ad = app_doc.json();
    assert_eq!(ad["id"], app);
    assert!(
        ad["attempts"].as_array().is_some_and(|a| !a.is_empty()),
        "the application document must include attempts[]: {ad}"
    );
    println!(
        "application: id={} name={} attempts={}",
        ad["id"],
        ad["name"],
        ad["attempts"].as_array().unwrap().len()
    );
    let mut sql_app = None;
    for state in ["RUNNING", "FINISHED"] {
        for candidate in &list {
            if candidate["state"] != state || !is_spark(candidate) {
                continue;
            }
            let Some(candidate_id) = candidate["id"].as_str() else {
                continue;
            };
            let executions = h.get(&format!("/api/spark/{candidate_id}/sql")).await;
            if executions.status == 200
                && executions
                    .json()
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty())
            {
                sql_app = Some(candidate_id.to_string());
                break;
            }
        }
        if sql_app.is_some() {
            break;
        }
    }
    if let Some(sql_app) = sql_app {
        let (sql_id, sql_rows, sql_detail) = wait_for_sql_plan(&h, &sql_app).await;
        assert_eq!(sql_detail["id"], sql_id);
        assert!(
            sql_rows
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"].as_i64() == Some(sql_id)),
            "execution {sql_id} was not in the SQL list: {sql_rows}"
        );
        let sql_nodes = sql_detail["nodes"].as_array().unwrap();
        let sql_edges = sql_detail["edges"].as_array().unwrap();
        assert!(!sql_edges.is_empty(), "SQL plan has no edges: {sql_detail}");
        println!(
            "sql app {sql_app} execution {sql_id}: {} nodes, {} edges",
            sql_nodes.len(),
            sql_edges.len()
        );
    } else {
        let sql_list = h.get(&format!("/api/spark/{app}/sql")).await;
        assert_eq!(sql_list.status, 200, "{}", sql_list.text());
        let sql_list = sql_list.json();
        assert!(
            sql_list.as_array().is_some_and(|rows| rows.is_empty())
                || sql_list.as_object().is_some_and(|rows| rows.is_empty()),
            "no SQL-enabled app was found, but {app} returned SQL data: {sql_list}"
        );
        println!("sql: no SQL executions in the cluster; execution-plan check skipped");
    }

    let stages = h.get(&format!("/api/spark/{app}/stages")).await;
    println!(
        "stages: status={} bytes={}",
        stages.status,
        stages.body.len()
    );
    assert_eq!(stages.status, 200, "{}", stages.text());
    assert!(stages.json().is_array());

    // 3. a real job DAG, parsed from the job page HTML the resolver points at.
    let job_id = jobs_json
        .as_array()
        .and_then(|a| a.iter().find_map(|j| j["jobId"].as_i64()));
    let Some(job_id) = job_id else {
        eprintln!("skipping DAG part: application {app} has no jobs");
        return;
    };
    let dag = h.get(&format!("/api/spark/{app}/dag/jobs/{job_id}")).await;
    println!(
        "dag/jobs/{job_id}: status={} cache={} ct={:?} bytes={}",
        dag.status,
        dag.cache(),
        dag.header("content-type"),
        dag.body.len()
    );
    assert_eq!(dag.status, 200, "{}", dag.text());
    assert_eq!(
        dag.header("content-type").as_deref(),
        Some("application/json")
    );
    let dag_json = dag.json();
    assert_eq!(dag_json["kind"], "job");
    assert_eq!(dag_json["granularity"], "rdd");
    assert!(
        !dag.text().contains("dag-viz-metadata"),
        "the UI HTML must never be forwarded"
    );
    println!(
        "dag summary: {} stages, {} nodes, {} cross-stage edges, edgesInferred={}",
        dag_json["stages"].as_array().unwrap().len(),
        dag_json["stages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["nodes"].as_array().map(Vec::len).unwrap_or(0))
            .sum::<usize>(),
        dag_json["edges"].as_array().unwrap().len(),
        dag_json["edgesInferred"]
    );
    println!(
        "dag: {}",
        serde_json::to_string(&dag_json)
            .unwrap()
            .chars()
            .take(400)
            .collect::<String>()
    );
    // Every stage of the job must have a stable id and a label; skipped stages are included.
    assert!(dag_json["stages"].as_array().unwrap().iter().all(|s| {
        s["stageId"].is_number() && s["label"].is_string() && s["skipped"].is_boolean()
    }));

    // 4. one stage DAG from the same job.
    let stage = jobs_json["0"]["stageIds"]
        .as_array()
        .and_then(|ids| ids.first())
        .and_then(Value::as_i64)
        .or_else(|| {
            dag_json["stages"]
                .as_array()
                .and_then(|s| s.first())
                .and_then(|s| s["stageId"].as_i64())
        });
    if let Some(stage_id) = stage {
        let attempt = dag_json["stages"]
            .as_array()
            .and_then(|s| s.iter().find(|s| s["stageId"].as_i64() == Some(stage_id)))
            .and_then(|s| s["attempt"].as_i64())
            .unwrap_or(0);
        let sdag = h
            .get(&format!("/api/spark/{app}/dag/stages/{stage_id}/{attempt}"))
            .await;
        println!(
            "dag/stages/{stage_id}/{attempt}: status={} granularity={} stages={}",
            sdag.status,
            sdag.json()["granularity"],
            sdag.json()["stages"].as_array().map(Vec::len).unwrap_or(0)
        );
        assert_eq!(sdag.status, 200, "{}", sdag.text());
        assert_eq!(sdag.json()["kind"], "stage");
        assert_eq!(sdag.json()["stages"].as_array().unwrap().len(), 1);
    }
}
