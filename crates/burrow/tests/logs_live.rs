//! Live-cluster log tests — **opt-in** (`BURROW_LIVE=1`, `.cluster/endpoints.json`).
//!
//! Proves contract §5 end to end against the real daemons: the NodeManager listing + ranged read + follow
//! for a *running* container, and the JobHistoryServer aggregated listing/read for a finished one.
//!
//! Run with: `BURROW_LIVE=1 cargo test -p burrow --test logs_live -- --nocapture`

mod common;

use std::time::Duration;

use burrow_core::config::Config;
use common::Harness;
use futures_util::StreamExt;

struct Live {
    rm: String,
    jhs: String,
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
        rm: cluster["rm"]["webapp"].as_str()?.to_string(),
        jhs: cluster["jobHistory"]["webapp"].as_str()?.to_string(),
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client")
}

async fn rm_json(rm: &str, path: &str) -> Option<serde_json::Value> {
    let resp = client()
        .get(format!("{rm}/ws/v1/cluster/{path}"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.bytes().await.ok()?;
    serde_json::from_slice(&body).ok()
}

/// One attempt's log coordinates.
#[derive(Clone)]
struct Attempt {
    app: String,
    container: String,
    node: String,
    user: String,
}

async fn attempt_of(rm: &str, app: &str) -> Option<Attempt> {
    let doc = rm_json(rm, &format!("apps/{app}/appattempts")).await?;
    let a = doc["appAttempts"]["appAttempt"].as_array()?.first()?;
    Some(Attempt {
        app: app.to_string(),
        container: a["containerId"].as_str()?.to_string(),
        node: a["nodeHttpAddress"].as_str()?.to_string(),
        user: {
            let detail = rm_json(rm, &format!("apps/{app}")).await?;
            detail["app"]["user"].as_str()?.to_string()
        },
    })
}

async fn apps_in_state(rm: &str, states: &str) -> Vec<String> {
    let Some(doc) = rm_json(rm, &format!("apps?states={states}")).await else {
        return Vec::new();
    };
    doc["apps"]["app"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn config(live: &Live) -> Config {
    let mut cfg = Config::for_rm(&live.rm).expect("config");
    cfg.jhs = vec![url::Url::parse(&live.jhs).expect("jhs url")];
    cfg.log_server_url = Some(format!("{}/jobhistory/logs", live.jhs));
    cfg.no_open = true;
    cfg
}

struct Sse {
    stream: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>,
    >,
    buf: String,
}

impl Sse {
    async fn open(h: &Harness, path: &str) -> Sse {
        let resp = h
            .client
            .get(h.url(path))
            .header("host", h.addr())
            .send()
            .await
            .expect("sse request");
        assert_eq!(resp.status(), 200);
        Sse {
            stream: Box::pin(resp.bytes_stream()),
            buf: String::new(),
        }
    }

    async fn next_frame(&mut self, timeout: Duration) -> Option<String> {
        loop {
            if let Some(i) = self.buf.find("\n\n") {
                let frame = self.buf[..i].to_string();
                self.buf.drain(..i + 2);
                return Some(frame);
            }
            match tokio::time::timeout(timeout, self.stream.next()).await {
                Ok(Some(Ok(chunk))) => self.buf.push_str(&String::from_utf8_lossy(&chunk)),
                _ => return None,
            }
        }
    }
}

#[tokio::test]
async fn live_logs_metadata_and_running_container() {
    let Some(live) = live() else { return };
    let h = Harness::start(config(&live)).await;

    // Capability flags are honest in this build.
    let meta = h.get("/api/meta").await.json();
    assert_eq!(meta["features"]["nodeLogs"], true, "{meta}");
    assert_eq!(meta["features"]["aggregatedLogs"], true, "{meta}");
    assert_eq!(meta["features"]["events"], true, "{meta}");
    eprintln!(
        "live: /api/meta features = {}",
        serde_json::to_string(&meta["features"]).unwrap()
    );

    let running = apps_in_state(&live.rm, "RUNNING").await;
    if running.is_empty() {
        eprintln!("skipping the NodeManager half: no RUNNING application on the cluster right now");
    } else {
        let attempt = attempt_of(&live.rm, &running[0]).await.expect("attempt");
        eprintln!(
            "live: running app {} container {} on {} (user {})",
            attempt.app, attempt.container, attempt.node, attempt.user
        );

        // --- listing -----------------------------------------------------------
        let r = h
            .get(&format!(
                "/api/logs/containers/{}?node={}&user={}&app={}",
                attempt.container, attempt.node, attempt.user, attempt.app
            ))
            .await;
        assert_eq!(r.status, 200, "{}", r.text());
        let j = r.json();
        assert_eq!(j["source"], "nm", "{j}");
        assert_eq!(j["node"], attempt.node);
        let files = j["files"].as_array().unwrap();
        assert!(!files.is_empty(), "a running container has local logs: {j}");
        let stdout = files
            .iter()
            .find(|f| f["name"] == "stdout")
            .unwrap_or_else(|| panic!("no stdout in {j}"));
        let size = stdout["size"].as_u64().unwrap();
        eprintln!(
            "live: nm listing source={} files={:?} stdout={size} bytes",
            j["source"],
            files
                .iter()
                .map(|f| f["name"].as_str().unwrap())
                .collect::<Vec<_>>()
        );

        // --- ranged read --------------------------------------------------------
        let want = size.min(200);
        let r = h
            .get(&format!(
                "/api/logs/containers/{}/files/stdout?node={}&user={}&app={}&offset=0&length={want}",
                attempt.container, attempt.node, attempt.user, attempt.app
            ))
            .await;
        assert_eq!(r.status, 200, "{}", r.text());
        assert_eq!(
            r.header("x-burrow-log-size").as_deref(),
            Some(size.to_string().as_str())
        );
        assert_eq!(r.header("x-burrow-log-start").as_deref(), Some("0"));
        assert_eq!(r.header("x-burrow-log-source").as_deref(), Some("nm"));
        eprintln!(
            "live: ranged read served {} bytes (window 0..{want} of {size})",
            r.body.len()
        );
        assert!(r.body.len() as u64 <= want + 8, "window is bounded");

        // --- follow -------------------------------------------------------------
        let t0 = std::time::Instant::now();
        let mut sse = Sse::open(
            &h,
            &format!(
                "/api/logs/containers/{}/files/stdout/stream?node={}&user={}&app={}&offset=0",
                attempt.container, attempt.node, attempt.user, attempt.app
            ),
        )
        .await;
        let frame = sse
            .next_frame(Duration::from_secs(20))
            .await
            .expect("first frame");
        eprintln!(
            "live: follow first frame after {} ms: {}",
            t0.elapsed().as_millis(),
            frame.chars().take(160).collect::<String>()
        );
        assert!(
            frame.starts_with("event: chunk") || frame.starts_with("event: eof"),
            "{frame}"
        );
        if let Some(rest) = frame.strip_prefix("event: chunk\ndata: ") {
            let data: serde_json::Value = serde_json::from_str(rest.trim()).expect("chunk json");
            assert_eq!(data["start"], 0);
            assert!(!data["text"].as_str().unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn live_large_aggregated_log_windows_and_follow() {
    let Some(live) = live() else { return };
    let h = Harness::start(config(&live)).await;

    let finished = apps_in_state(&live.rm, "FINISHED,FAILED,KILLED").await;
    // Pick the application whose aggregated listing has the largest file (the cluster's `big_log`).
    let mut best: Option<(Attempt, String, u64)> = None;
    for app in finished.iter().take(12) {
        let Some(attempt) = attempt_of(&live.rm, app).await else {
            continue;
        };
        let r = h
            .get(&format!(
                "/api/logs/containers/{}?node={}&user={}&app={}",
                attempt.container, attempt.node, attempt.user, attempt.app
            ))
            .await;
        if r.status != 200 {
            continue;
        }
        let j = r.json();
        if j["source"] != "jhs" {
            continue;
        }
        for f in j["files"].as_array().cloned().unwrap_or_default() {
            let size = f["size"].as_u64().unwrap_or(0);
            let name = f["name"].as_str().unwrap_or("").to_string();
            if best.as_ref().is_none_or(|(_, _, s)| size > *s) {
                best = Some((attempt.clone(), name, size));
            }
        }
    }
    let Some((attempt, name, total)) = best else {
        eprintln!("skipping: no aggregated log file found");
        return;
    };
    if total < 256 * 1024 {
        eprintln!("skipping: the largest aggregated file is only {total} bytes");
        return;
    }
    eprintln!(
        "live: largest aggregated file {} {} = {total} bytes ({})",
        attempt.app, name, attempt.container
    );

    let base = format!(
        "/api/logs/containers/{}/files/{name}?node={}&user={}&app={}",
        attempt.container, attempt.node, attempt.user, attempt.app
    );

    // A 256 KiB window in the middle of the file.
    let mid = total / 2;
    let t0 = std::time::Instant::now();
    let r = h.get(&format!("{base}&offset={mid}&length=262144")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        r.header("x-burrow-log-size").as_deref(),
        Some(total.to_string().as_str())
    );
    assert_eq!(
        r.header("x-burrow-log-start").as_deref(),
        Some(mid.to_string().as_str())
    );
    assert_eq!(
        r.header("x-burrow-log-end").as_deref(),
        Some((mid + 262144).to_string().as_str())
    );
    assert_eq!(r.header("x-burrow-log-source").as_deref(), Some("jhs"));
    eprintln!(
        "live: mid-file window served {} bytes in {} ms",
        r.body.len(),
        t0.elapsed().as_millis()
    );
    assert!(
        r.body.len() >= 250_000,
        "a 256 KiB window should come back whole"
    );

    // tail=1024
    let r = h.get(&format!("{base}&tail=1024")).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.header("x-burrow-log-start").as_deref(),
        Some((total - 1024).to_string().as_str())
    );
    assert_eq!(
        r.header("x-burrow-log-end").as_deref(),
        Some(total.to_string().as_str())
    );
    assert!(
        r.body.len() >= 1000,
        "tail window served {} bytes",
        r.body.len()
    );
    eprintln!("live: tail window served {} bytes", r.body.len());

    // Follow from near the end: one chunk, then eof (the application is finished).
    let mut sse = Sse::open(
        &h,
        &format!(
            "/api/logs/containers/{}/files/{name}/stream?node={}&user={}&app={}&offset={}",
            attempt.container,
            attempt.node,
            attempt.user,
            attempt.app,
            total - 100
        ),
    )
    .await;
    let t0 = std::time::Instant::now();
    let frame = sse
        .next_frame(Duration::from_secs(20))
        .await
        .expect("chunk");
    assert!(frame.starts_with("event: chunk"), "{frame}");
    let frame = sse.next_frame(Duration::from_secs(20)).await.expect("eof");
    assert_eq!(frame, "event: eof\ndata: {}");
    eprintln!(
        "live: follow from offset {} reached eof in {} ms",
        total - 100,
        t0.elapsed().as_millis()
    );
}

#[tokio::test]
async fn live_aggregated_logs_come_from_the_jobhistoryserver() {
    let Some(live) = live() else { return };
    let h = Harness::start(config(&live)).await;

    let finished = apps_in_state(&live.rm, "FINISHED,FAILED,KILLED").await;
    if finished.is_empty() {
        eprintln!("skipping: no finished application with aggregated logs yet");
        return;
    }
    let mut served = 0;
    for app in finished.iter().take(8) {
        let Some(attempt) = attempt_of(&live.rm, app).await else {
            continue;
        };
        let r = h
            .get(&format!(
                "/api/logs/containers/{}?node={}&user={}&app={}",
                attempt.container, attempt.node, attempt.user, attempt.app
            ))
            .await;
        if r.status != 200 {
            eprintln!("live: {app} → {} {}", r.status, r.text());
            continue;
        }
        let j = r.json();
        let files = j["files"].as_array().cloned().unwrap_or_default();
        eprintln!(
            "live: aggregated listing for {app}: source={} node={} files={:?}",
            j["source"],
            j["node"],
            files
                .iter()
                .map(|f| format!(
                    "{}({})",
                    f["name"].as_str().unwrap_or("?"),
                    f["size"].as_u64().unwrap_or(0)
                ))
                .collect::<Vec<_>>()
        );
        if j["source"] != "jhs" || files.is_empty() {
            continue;
        }
        let name = files
            .iter()
            .find(|f| f["name"] == "syslog")
            .or_else(|| files.iter().find(|f| f["name"] == "stdout"))
            .expect("a readable file");
        let name = name["name"].as_str().unwrap();
        let r = h
            .get(&format!(
                "/api/logs/containers/{}/files/{name}?node={}&user={}&app={}&offset=0&length=256",
                attempt.container, attempt.node, attempt.user, attempt.app
            ))
            .await;
        assert_eq!(r.status, 200, "{}", r.text());
        assert_eq!(r.header("x-burrow-log-source").as_deref(), Some("jhs"));
        let total: u64 = r.header("x-burrow-log-size").unwrap().parse().unwrap();
        eprintln!(
            "live: aggregated read {app}/{name}: {} bytes served of {total} total",
            r.body.len()
        );
        assert!(total > 0);
        served += 1;
        if served >= 2 {
            break;
        }
    }
    assert!(
        served > 0,
        "no aggregated log could be read; see the listing lines above"
    );
}
