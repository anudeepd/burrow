//! Live-cluster test — **opt-in**. Skips unless `BURROW_LIVE=1` **and** `.cluster/endpoints.json` exists.
//!
//! This is the P3 "wire fidelity" proof for this slice: every proxied RM/NM resource must be
//! byte-identical to the same request made straight to the daemon (`Cache-Control: no-cache`, so nothing
//! on the burrow side can reshape it), and `/api/meta` must describe the real cluster.
//!
//! Run with: `BURROW_LIVE=1 cargo test -p burrow --test live_cluster -- --nocapture`

mod common;

use common::{Harness, TestResponse};

struct Live {
    /// `http://127.0.0.1:8088`
    rm: String,
    nodes: Vec<String>,
    hadoop: String,
    scheduler: String,
    /// The cluster's own config directories, so the real discovery path can be exercised.
    hadoop_conf: Option<String>,
    spark_conf: Option<String>,
}

fn live() -> Option<Live> {
    if std::env::var("BURROW_LIVE").as_deref() != Ok("1") {
        eprintln!("skipping live test: set BURROW_LIVE=1 to run it against the real cluster");
        return None;
    }
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cluster/endpoints.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("skipping live test: {} unreadable ({e})", path.display());
            return None;
        }
    };
    let cluster: serde_json::Value = serde_json::from_str(&text).expect("endpoints.json");
    Some(Live {
        rm: cluster["rm"]["webapp"]
            .as_str()
            .expect("rm.webapp")
            .to_string(),
        nodes: cluster["nodeManagers"]
            .as_array()
            .expect("nodeManagers")
            .iter()
            .filter_map(|n| n["http"].as_str().map(str::to_string))
            .collect(),
        hadoop: cluster["hadoopVersion"].as_str().unwrap_or("?").to_string(),
        scheduler: cluster["scheduler"].as_str().unwrap_or("?").to_string(),
        hadoop_conf: cluster["env"]["HADOOP_CONF_DIR"]
            .as_str()
            .map(str::to_string),
        spark_conf: cluster["env"]["SPARK_CONF_DIR"]
            .as_str()
            .map(str::to_string),
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn direct(rm: &str, path: &str) -> TestResponse {
    let resp = client()
        .get(format!("{rm}/ws/v1/cluster/{path}"))
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .expect("direct RM fetch");
    TestResponse {
        status: resp.status().as_u16(),
        headers: resp.headers().clone(),
        body: resp.bytes().await.expect("body").to_vec(),
    }
}

/// Compare key sets recursively so a failure says *which* key differs.
fn diff(a: &serde_json::Value, b: &serde_json::Value, path: &str, out: &mut Vec<String>) {
    match (a, b) {
        (serde_json::Value::Object(ma), serde_json::Value::Object(mb)) => {
            for (k, va) in ma {
                match mb.get(k) {
                    Some(vb) => diff(va, vb, &format!("{path}.{k}"), out),
                    None => out.push(format!("only in ours: {path}.{k}")),
                }
            }
            for k in mb.keys() {
                if !ma.contains_key(k) {
                    out.push(format!("only in direct: {path}.{k}"));
                }
            }
        }
        (serde_json::Value::Array(xa), serde_json::Value::Array(xb)) => {
            if xa.len() != xb.len() {
                out.push(format!("{path}: array length {} vs {}", xa.len(), xb.len()));
                return;
            }
            for (i, (va, vb)) in xa.iter().zip(xb).enumerate() {
                diff(va, vb, &format!("{path}[{i}]"), out);
            }
        }
        (x, y) if x != y => out.push(format!("{path}: {x} vs {y}")),
        _ => {}
    }
}

/// Recursively record `path:type` for every leaf (and `path[]` for arrays), so two JSON documents can be
/// compared structurally when their *values* legitimately change between fetches.
fn shape(value: &serde_json::Value, path: &str, out: &mut std::collections::BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                shape(child, &format!("{path}.{key}"), out);
            }
        }
        serde_json::Value::Array(items) => {
            out.insert(format!("{path}[]"));
            for (i, child) in items.iter().enumerate() {
                shape(child, &format!("{path}[{i}]"), out);
            }
        }
        other => {
            let kind = match other {
                serde_json::Value::Null => "null",
                serde_json::Value::Bool(_) => "bool",
                serde_json::Value::Number(_) => "number",
                serde_json::Value::String(_) => "string",
                _ => unreachable!(),
            };
            out.insert(format!("{path}:{kind}"));
        }
    }
}

/// Through the proxy with `no-cache` (the parity harness's own contract for hard reads).
async fn proxy(h: &Harness, resource: &str) -> TestResponse {
    h.get_with(
        &format!("/api/yarn/{resource}"),
        &[("Cache-Control", "no-cache")],
    )
    .await
}

/// One fetch each way, for the STRICT bucket in the test body.
async fn parity(h: &Harness, rm: &str, resource: &str) -> (u16, usize, bool) {
    let mut last = None;
    for attempt in 0..2 {
        let ours = h
            .get_with(
                &format!("/api/yarn/{resource}"),
                &[("Cache-Control", "no-cache")],
            )
            .await;
        let theirs = direct(rm, resource).await;
        assert_eq!(
            ours.header("x-burrow-api").as_deref(),
            Some("1"),
            "{resource}"
        );
        assert_eq!(
            ours.header("x-burrow-cache").as_deref(),
            Some("bypass"),
            "{resource} was sent with no-cache, so it must bypass"
        );
        if ours.status == theirs.status && ours.body == theirs.body {
            if ours.status == 200 {
                let a: serde_json::Value = serde_json::from_slice(&ours.body).expect("ours json");
                let b: serde_json::Value =
                    serde_json::from_slice(&theirs.body).expect("their json");
                let mut problems = Vec::new();
                diff(&a, &b, resource, &mut problems);
                assert!(
                    problems.is_empty(),
                    "{resource}: byte-identical but structurally different: {problems:?}"
                );
            }
            return (ours.status, ours.body.len(), attempt == 1);
        }
        last = Some((ours, theirs));
    }
    let (ours, theirs) = last.expect("two attempts");
    panic!(
        "/api/yarn/{resource}: repeatable mismatch\n  ours:   {} {}\n  direct: {} {}",
        ours.status,
        String::from_utf8_lossy(&ours.body[..ours.body.len().min(400)]),
        theirs.status,
        String::from_utf8_lossy(&theirs.body[..theirs.body.len().min(400)]),
    );
}

/// Parity for the endpoints the RM stamps with the *request time* (`{wrapper}.timestamp` / `dateTime`).
///
/// Those can never be byte-identical between two fetches, and on a cluster with running apps the reported
/// activity content moves too. So: strip the daemon's own clock fields and compare the rest exactly; if the
/// daemon itself answered differently twice, retry once and finally require identical key/type shape.
/// Returns `(bytes, how)` where `how` describes the strength of the proof.
async fn volatile_parity(h: &Harness, rm: &str, resource: &str, wrapper: &str) -> (usize, String) {
    let strip = |body: &[u8]| {
        let mut v: serde_json::Value = serde_json::from_slice(body).expect("json");
        if let Some(inner) = v[wrapper].as_object_mut() {
            inner.remove("timestamp");
            inner.remove("dateTime");
        }
        v
    };
    let shape_of = |v: &serde_json::Value| {
        let mut out = std::collections::BTreeSet::new();
        shape(v, "root", &mut out);
        out
    };
    let mut moved = None;
    for attempt in 0..2 {
        let first = direct(rm, resource).await;
        let ours = proxy(h, resource).await;
        let second = direct(rm, resource).await;
        assert_eq!(ours.status, first.status, "{resource}");
        assert_eq!(
            ours.header("x-burrow-cache").as_deref(),
            Some("bypass"),
            "{resource} was sent with no-cache"
        );
        let (ours_v, first_v, second_v) =
            (strip(&ours.body), strip(&first.body), strip(&second.body));
        let mut problems = Vec::new();
        diff(&ours_v, &first_v, resource, &mut problems);
        if problems.is_empty() {
            return (
                first.body.len(),
                if attempt == 1 {
                    "identical field-for-field (after a retry; only the daemon's own timestamp differs)"
                        .to_string()
                } else {
                    "identical field-for-field (only the daemon's own timestamp differs)"
                        .to_string()
                },
            );
        }
        if first_v != second_v {
            moved = Some((first.body.len(), ours_v, first_v, second_v));
            continue;
        }
        panic!("{resource}: differs from a daemon that answered identically twice: {problems:?}");
    }
    let (len, ours_v, first_v, second_v) = moved.expect("two attempts");
    let (os, s1, s2) = (shape_of(&ours_v), shape_of(&first_v), shape_of(&second_v));
    assert!(
        os == s1 || os == s2,
        "{resource}: key/type shape differs\n ours:   {os:?}\n direct: {s1:?}"
    );
    (
        len,
        "identical key/type shape (the RM's activity content moved between fetches; timestamps differ by construction)"
            .to_string(),
    )
}

#[tokio::test]
async fn live_passthrough_is_byte_identical_to_the_real_resourcemanager() {
    let Some(live) = live() else { return };

    // Build the configuration the way the CLI does: no flags, so everything comes from Hadoop conf
    // auto-discovery in the cluster's own config directories.
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
    println!(
        "discovery from {}: rm={:?} jhs={:?} sparkHistory={:?} policy={:?} warnings={:?}",
        live.hadoop_conf.as_deref().unwrap_or("-"),
        discovery.rm_urls,
        discovery.jhs_url,
        discovery.spark_history,
        discovery.http_policy,
        discovery.warnings
    );
    let mut cfg =
        burrow_core::config::resolve(vec![], discovery).expect("resolve from hadoop conf");
    assert_eq!(
        cfg.rm_urls
            .first()
            .map(|u| u.to_string().trim_end_matches('/').to_string()),
        Some(live.rm.clone()),
        "auto-discovery must find the running ResourceManager"
    );
    assert!(
        !cfg.jhs.is_empty(),
        "yarn.log.server.url must be discovered"
    );
    assert!(
        !cfg.spark_history.is_empty(),
        "spark.yarn.historyServer.address must be discovered"
    );
    cfg.cache.ttl_scale = 1.0;
    cfg.no_open = true;
    let h = Harness::start(cfg).await;

    // 1. `/api/meta` describes the real cluster.
    let m = h.get("/api/meta").await.json();
    assert_eq!(m["rm"]["urls"][0], live.rm);
    assert_eq!(m["rm"]["reachable"], true, "{m}");
    assert_eq!(m["rm"]["haState"], "ACTIVE");
    assert_eq!(m["rm"]["hadoopVersion"], live.hadoop);
    assert_eq!(m["yarn"]["httpPolicy"], "HTTP_ONLY");
    assert_eq!(m["yarn"]["scheduler"], live.scheduler);
    assert!(m["services"]["jobHistory"]["configured"].as_bool().unwrap());
    assert!(
        m["services"]["sparkHistory"]["configured"]
            .as_bool()
            .unwrap()
    );
    println!("meta: {}", serde_json::to_string_pretty(&m).unwrap());

    // 2. Wire fidelity. Three strengths of proof, depending on how much the live cluster moves
    //    (the frontend slice is running Spark apps against this cluster while we compare):
    //    * STRICT   — byte-identical AND structurally deep-equal, `no-cache` on both sides, retried once
    //                 because the cluster can change between the two fetches.
    //    * APP LIST — keyed by application id, so apps appearing/disappearing mid-comparison cannot
    //                 masquerade as a difference: every app that did *not* change between two direct
    //                 fetches must be byte-identical through the proxy, and the proxy may never add an
    //                 app the daemon never reported.
    //    * VOLATILE — compared twice against the daemon; only if the daemon answered identically both
    //                 times must the proxy match byte-for-byte.
    const STRICT: &[&str] = &[
        "info",
        "metrics",
        "nodes",
        "scheduler",
        "scheduler-overview",
        "scheduler-conf",
        "get-node-labels",
        "get-node-to-labels",
        "label-mappings",
        "resource-types",
        "resource-profiles",
        "userinfo",
        "appstatistics",
    ];
    const APP_LISTS: &[&str] = &["apps", "apps?states=RUNNING"];
    const VOLATILE: &[&str] = &["scheduler/activities"];

    let mut retried = Vec::new();
    for resource in STRICT {
        let mut last = None;
        let mut done = false;
        for attempt in 0..2 {
            let ours = proxy(&h, resource).await;
            let theirs = direct(&live.rm, resource).await;
            // A 2xx body has to be byte-identical. A non-2xx only has to agree on the status: an HTML
            // error page is deliberately turned into the documented JSON envelope (status preserved),
            // because an upstream page must never be forwarded as HTML on our origin.
            let agrees =
                ours.status == theirs.status && (ours.status != 200 || ours.body == theirs.body);
            if agrees {
                if attempt == 1 {
                    retried.push(*resource);
                }
                let their_type = theirs.header("content-type").unwrap_or_default();
                if ours.status == 200 {
                    let a: serde_json::Value = serde_json::from_slice(&ours.body).expect("json");
                    let b: serde_json::Value = serde_json::from_slice(&theirs.body).expect("json");
                    let mut problems = Vec::new();
                    diff(&a, &b, resource, &mut problems);
                    assert!(problems.is_empty(), "{resource}: {problems:?}");
                    println!(
                        "/api/yarn/{resource}: 200, {} bytes byte-identical + deep-equal ✔",
                        ours.body.len()
                    );
                } else if their_type.contains("html") {
                    let j = ours.json();
                    let expected = if ours.status == 404 {
                        "not_found"
                    } else {
                        "upstream_status"
                    };
                    assert_eq!(j["error"]["code"], expected, "{resource}: {}", ours.text());
                    assert_eq!(j["error"]["upstream"]["status"], ours.status);
                    assert!(
                        j["error"]["upstream"]["url"]
                            .as_str()
                            .unwrap()
                            .contains(resource.split('?').next().unwrap())
                    );
                    println!(
                        "/api/yarn/{resource}: {} (RM sent HTML) → JSON envelope, status preserved, upstream named ✔",
                        ours.status
                    );
                } else {
                    assert_eq!(
                        ours.body, theirs.body,
                        "{resource}: non-2xx JSON must pass through byte-for-byte"
                    );
                    println!(
                        "/api/yarn/{resource}: {}, {} bytes byte-identical (non-2xx passthrough) ✔",
                        ours.status,
                        ours.body.len()
                    );
                }
                done = true;
                break;
            }
            last = Some((ours, theirs));
        }
        if !done {
            let (ours, theirs) = last.expect("two attempts");
            panic!(
                "/api/yarn/{resource}: repeatable mismatch\n  ours:   {} {}\n  direct: {} {}",
                ours.status,
                String::from_utf8_lossy(&ours.body[..ours.body.len().min(300)]),
                theirs.status,
                String::from_utf8_lossy(&theirs.body[..theirs.body.len().min(300)]),
            );
        }
    }

    for resource in APP_LISTS {
        let first_fetch = direct(&live.rm, resource).await;
        let ours = proxy(&h, resource).await;
        let second_fetch = direct(&live.rm, resource).await;
        assert_eq!(ours.status, first_fetch.status, "{resource}");
        assert_eq!(
            ours.header("x-burrow-cache").as_deref(),
            Some("bypass"),
            "{resource} was sent with no-cache"
        );
        let by_id = |body: &[u8]| -> std::collections::BTreeMap<String, serde_json::Value> {
            let v: serde_json::Value = serde_json::from_slice(body).expect("json");
            v["apps"]["app"]
                .as_array()
                .map(|apps| {
                    apps.iter()
                        .filter_map(|a| Some((a["id"].as_str()?.to_string(), a.clone())))
                        .collect()
                })
                .unwrap_or_default()
        };
        let (ours_apps, first, second) = (
            by_id(&ours.body),
            by_id(&first_fetch.body),
            by_id(&second_fetch.body),
        );
        let mut stable = 0;
        for (id, app) in &first {
            if second.get(id) != Some(app) {
                continue; // the cluster changed this app between the two direct fetches
            }
            stable += 1;
            assert_eq!(
                ours_apps.get(id),
                Some(app),
                "{resource}: app {id} differs through the proxy"
            );
        }
        for id in ours_apps.keys() {
            assert!(
                first.contains_key(id) || second.contains_key(id),
                "{resource}: the proxy returned an app the RM never did: {id}"
            );
        }
        let churn = first
            .keys()
            .filter(|id| second.get(*id) != first.get(*id))
            .count();
        // RUNNING apps change their progress every second, so values may churn entirely; the key/type
        // *shape* of a given application must still be exactly what the daemon produced.
        let shape_of = |app: &serde_json::Value| {
            let mut out = std::collections::BTreeSet::new();
            shape(app, "app", &mut out);
            out
        };
        let mut checked = 0;
        for (id, app) in &ours_apps {
            let reference = first
                .get(id)
                .or_else(|| second.get(id))
                .unwrap_or_else(|| panic!("{resource}: id checked above"));
            assert_eq!(
                &shape_of(reference),
                &shape_of(app),
                "{resource}: app {id} has a different key/type shape through the proxy"
            );
            checked += 1;
        }
        println!(
            "/api/yarn/{resource}: {} apps via proxy / {} direct · {stable} unchanged apps byte-identical · {checked} app shapes identical (key paths + types) · cluster churn {churn} app(s) ✔",
            ours_apps.len(),
            first.len()
        );
    }

    for resource in VOLATILE {
        let (len, how) = volatile_parity(&h, &live.rm, resource, "activities").await;
        println!("/api/yarn/{resource}: {len} bytes, {how} ✔");
    }
    println!(
        "resources that needed a retry (the cluster changed between the two fetches): {retried:?}"
    );

    // 3. Real app detail, attempts and the per-application scheduler activities. A terminal app is
    //    preferred: a RUNNING app's `progress` legitimately moves between two fetches.
    let apps: serde_json::Value = h.get("/api/yarn/apps").await.json();
    let all = apps["apps"]["app"].as_array().cloned().unwrap_or_default();
    let pick = all
        .iter()
        .find(|a| matches!(a["state"].as_str(), Some("FINISHED" | "FAILED" | "KILLED")))
        .or_else(|| all.first());
    if let Some(app) = pick {
        let id = app["id"].as_str().unwrap().to_string();
        println!("app {id} ({})", app["state"].as_str().unwrap_or("?"));
        for resource in [format!("apps/{id}"), format!("apps/{id}/appattempts")] {
            let (status, len, _) = parity(&h, &live.rm, &resource).await;
            println!("/api/yarn/{resource}: {status}, {len} bytes byte-identical ✔");
        }

        // The four `apps/{id}/…` sub-resources RM 3.4.3 really serves. (My first reading of these was a
        // false 404: the app id came from a previous RM incarnation, because the RM forgets apps when it
        // restarts. ClusterInfra2 re-measured them as 200; this pins the corrected claim.)
        for sub in ["state", "priority", "queue", "timeouts"] {
            let resource = format!("apps/{id}/{sub}");
            let (status, len, _) = parity(&h, &live.rm, &resource).await;
            assert_eq!(status, 200, "{resource} is served by RM 3.4.3");
            println!("/api/yarn/{resource}: {status}, {len} bytes byte-identical ✔");
        }
        // …while these three really are gone, and are passed through as the envelope with the status kept.
        for sub in ["statistics", "appactivities", "activities"] {
            let resource = format!("apps/{id}/{sub}");
            let r = proxy(&h, &resource).await;
            assert_eq!(r.status, 404, "{resource}: {}", r.text());
            assert_eq!(r.error_code(), "not_found");
            assert_eq!(r.json()["error"]["upstream"]["status"], 404);
            println!("/api/yarn/{resource}: 404 from the RM → JSON envelope, status preserved ✔");
        }

        // `/scheduler/app-activities/{id}` embeds the *request time* in `appActivities.timestamp`.
        let resource = format!("scheduler/app-activities/{id}");
        let (len, how) = volatile_parity(&h, &live.rm, &resource, "appActivities").await;
        println!("/api/yarn/{resource}: 200, {len} bytes, {how} ✔");
    } else {
        println!("no applications on the cluster; skipping app detail");
    }

    // 4. RM daemon pages: the synthesized log listing, the JSON config and a byte-range window.
    let logs = h.get("/api/rm/logs").await;
    assert_eq!(logs.status, 200, "{}", logs.text());
    let files = logs.json()["files"].as_array().unwrap().len();
    assert!(files > 0, "the RM logs directory must list something");
    assert_eq!(logs.header("x-burrow-cache").as_deref(), Some("miss"));
    println!(
        "rm/logs: {files} entries, first = {}",
        logs.json()["files"][0]
    );

    let conf = h.get("/api/rm/conf?format=json").await;
    assert_eq!(conf.status, 200);
    let properties = conf.json()["properties"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0);
    assert!(
        properties > 0,
        "format=json must return the RM's configuration"
    );
    println!("rm/conf?format=json: {properties} properties ✔");

    let name = logs.json()["files"][0]["name"]
        .as_str()
        .unwrap()
        .to_string();
    let window = h
        .get(&format!("/api/rm/logs/{name}?offset=0&length=64"))
        .await;
    assert_eq!(window.status, 206, "{}", window.text());
    assert_eq!(window.body.len(), 64);
    assert!(window.header("content-range").is_some());
    println!(
        "rm/logs/{name}?offset=0&length=64: 206, 64 bytes, content-range {} ✔",
        window.header("content-range").unwrap()
    );

    let jmx = h
        .get("/api/rm/jmx?qry=Hadoop:service=ResourceManager,name=ClusterMetrics")
        .await;
    assert_eq!(jmx.status, 200, "{}", jmx.text());
    assert!(
        jmx.json()["beans"]
            .as_array()
            .is_some_and(|b| !b.is_empty())
    );
    println!(
        "rm/jmx (ClusterMetrics): {} bean(s) ✔",
        jmx.json()["beans"].as_array().unwrap().len()
    );

    // 5. NodeManager passthrough through the SSRF guard, against every real node.
    for authority in &live.nodes {
        let info = h.get(&format!("/api/nm/{authority}/info")).await;
        assert_eq!(info.status, 200, "{authority}: {}", info.text());
        let direct_nm = client()
            .get(format!("http://{authority}/ws/v1/node/info"))
            .header("Cache-Control", "no-cache")
            .send()
            .await
            .expect("direct NM fetch");
        let direct_body = direct_nm.bytes().await.unwrap();
        assert_eq!(info.body, direct_body, "{authority}: body differs");
        println!(
            "{authority} /ws/v1/node/info: {} bytes byte-identical ✔ (NodeManager {})",
            info.body.len(),
            info.json()["nodeInfo"]["nodeManagerVersion"]
        );
        let conf = h
            .get_with(
                &format!("/api/nm/{authority}/conf?format=json"),
                &[("Cache-Control", "no-cache")],
            )
            .await;
        let direct_conf = client()
            .get(format!("http://{authority}/conf?format=json"))
            .header("Accept", "application/json")
            .send()
            .await
            .expect("direct NM JSON configuration");
        assert_eq!(conf.status, 200, "{authority}: {}", conf.text());
        assert!(conf.json()["properties"].is_array());
        assert_eq!(conf.body, direct_conf.bytes().await.unwrap());
        println!("{authority} /conf?format=json: JSON byte-identical ✔");
    }
    let denied = h.get("/api/nm/example.com:8042/info").await;
    assert_eq!(denied.status, 403);
    println!("SSRF guard on the live cluster: example.com:8042 → 403 ✔");

    // 6. Coalescing and caching against the real RM.
    let first = h.get("/api/yarn/metrics").await;
    assert_eq!(first.status, 200);
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..50 {
        let url = h.url("/api/yarn/metrics");
        let client = h.client.clone();
        set.spawn(async move {
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
        });
    }
    let mut caches = Vec::new();
    while let Some(r) = set.join_next().await {
        caches.push(r.unwrap());
    }
    let fetches = caches.iter().filter(|c| c.as_str() == "miss").count();
    assert_eq!(fetches, 0, "warm entry ⇒ every caller is a hit: {caches:?}");
    println!(
        "50 concurrent /api/yarn/metrics on the live RM: {} hits, 0 upstream fetches ✔",
        caches.len()
    );

    // 7. ETag revalidation against live data.
    let etag = h.get("/api/yarn/info").await.header("etag").expect("etag");
    let revalidated = h
        .get_with("/api/yarn/info", &[("If-None-Match", &etag)])
        .await;
    assert_eq!(revalidated.status, 304);
    assert!(revalidated.body.is_empty());
    println!("If-None-Match → 304, empty body ✔");
}
