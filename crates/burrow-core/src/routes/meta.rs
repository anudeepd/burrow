//! `GET /api/meta` — the synthesized document the SPA boots from (contract §2).
//!
//! Everything expensive (RM probes, service probes, the scheduler class) runs under a short-lived
//! [`crate::core::Memo`] single-flight, so N tabs cost one round of probes per [`META_TTL`]. `now` is the
//! only field minted per request, which is what lets the SPA correct for clock skew.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{ApiRequest, GroupFut};
use crate::cache::{CacheSource, Expect, Served, TtlPolicy};
use crate::core::{Core, GetSpec};
use crate::error::ApiError;
use crate::reply::Reply;
use crate::rm_pool::{HaState, RmProbe};
use crate::upstream::Upstream;

const META_TTL: Duration = Duration::from_secs(5);
const SCHEDULER_PATH: &str = "/ws/v1/cluster/scheduler";

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

pub async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    if !req.path.is_empty() {
        return Err(ApiError::not_found(format!(
            "'/api/meta/{}' does not exist",
            req.path
        )));
    }
    let (doc, hit) = core.meta_document().await;
    let mut body = doc.as_ref().clone();
    body["now"] = json!(now_ms());
    let mut reply = Reply::json(&body);
    reply.cache = Some(if hit {
        CacheSource::Hit
    } else {
        CacheSource::Miss
    });
    reply.upstream = doc
        .get("rm")
        .and_then(|rm| rm.get("active"))
        .and_then(Value::as_str)
        .and_then(host_port);
    Ok(reply)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `http://host:port` → `host:port` for the `x-burrow-upstream` header.
fn host_port(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?;
    Some(match u.port_or_known_default() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    })
}

impl Core {
    /// The (memoized) `/api/meta` payload — everything except `now`.
    pub async fn meta_document(&self) -> (Arc<Value>, bool) {
        self.meta_memo
            .get_or_status("meta", META_TTL, || build_meta(self))
            .await
    }
}

async fn build_meta(core: &Core) -> Arc<Value> {
    let pool = core.rm_pool();
    let probes = pool.probe_all(false).await;
    let remembered = pool.active_url();
    let active = pick_active(&probes, remembered.as_deref());
    let reachable = probes.iter().any(|p| p.reachable);

    let timeline_candidates = core.timeline.iter().cloned().collect::<Vec<_>>();
    let (spark_history, jhs, timeline, scheduler) = tokio::join!(
        service_json(&core.spark_history),
        service_json(&core.jhs),
        service_json(&timeline_candidates),
        scheduler_kind(core),
    );

    let doc = json!({
        "name": "burrow",
        "version": env!("CARGO_PKG_VERSION"),
        "now": now_ms(),
        "readOnly": true,
        "rm": {
            "urls": pool.urls(),
            "active": active.map(|p| p.url.clone()),
            "haState": active.and_then(|p| p.ha_state).map(HaState::as_str),
            "hadoopVersion": active.and_then(|p| p.hadoop_version.clone()),
            "reachable": reachable,
        },
        "services": {
            "sparkHistory": spark_history,
            "jobHistory": jhs,
            "timeline": timeline,
        },
        "features": features(core),
        "yarn": {
            "logServerUrl": core.config.log_server_url,
            "httpPolicy": core.config.http_policy.as_str(),
            "scheduler": scheduler,
        },
    });
    Arc::new(doc)
}

/// Capability flags for **this build**. Each flips to `true` in the slice that implements the feature;
/// the *environment's* reachability is reported separately under `services`, so a flag being `false`
/// never hides the fact that a daemon is up.
fn features(core: &Core) -> Value {
    json!({
        // `/api/spark/*` (live RM web-proxy + Spark History passthrough) — Spark slice.
        "sparkLive": true,
        "sparkHistory": true,
        // `/api/logs/*` (NodeManager + aggregated JobHistoryServer logs) — logs slice.
        "aggregatedLogs": true,
        "nodeLogs": true,
        // The SSE hub sets this when it starts serving `/api/events`.
        "events": core.topics.is_enabled(),
        // Kerberos/SPNEGO is a stretch item and is not implemented.
        "kerberos": false,
    })
}

/// Prefer a freshly observed ACTIVE RM over a remembered RM that has since become STANDBY.
fn pick_active<'a>(probes: &'a [RmProbe], remembered: Option<&str>) -> Option<&'a RmProbe> {
    probes
        .iter()
        .find(|p| p.reachable && p.ha_state == Some(HaState::Active))
        .or_else(|| remembered.and_then(|u| probes.iter().find(|p| p.reachable && p.url == u)))
        .or_else(|| probes.iter().find(|p| p.reachable))
}

/// `{"configured": false}` or `{configured, url, urls, reachable, candidates}`.
async fn service_json(ups: &[Arc<Upstream>]) -> Value {
    if ups.is_empty() {
        return json!({ "configured": false });
    }
    let probes = futures_util::future::join_all(ups.iter().map(|up| async move {
        let probe = up.probe().await;
        let mut candidate = json!({
            "url": probe.url,
            "reachable": probe.reachable,
        });
        if let Some(error) = probe.error {
            candidate["reason"] = json!(error);
        }
        candidate
    }))
    .await;
    let primary = probes
        .iter()
        .find(|p| p["reachable"].as_bool() == Some(true))
        .or_else(|| probes.first())
        .and_then(|p| p["url"].as_str())
        .unwrap_or_default();
    let mut result = json!({
        "configured": true,
        "url": primary,
        "urls": ups.iter().filter_map(|up| up.base_url()).collect::<Vec<_>>(),
        "reachable": probes.iter().any(|p| p["reachable"].as_bool() == Some(true)),
        "candidates": probes,
    });
    if result["reachable"].as_bool() == Some(false)
        && let Some(reason) = result["candidates"]
            .as_array()
            .and_then(|items| items.iter().find_map(|p| p["reason"].as_str()))
    {
        result["reason"] = json!(reason);
    }
    result
}

#[derive(Deserialize)]
struct SchedulerDoc {
    scheduler: Option<SchedulerBody>,
}

#[derive(Deserialize)]
struct SchedulerBody {
    #[serde(rename = "schedulerInfo")]
    info: Option<SchedulerInfo>,
}

#[derive(Deserialize)]
struct SchedulerInfo {
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// Scheduler class from the *cached* `/ws/v1/cluster/scheduler` document (never an extra upstream call).
async fn scheduler_kind(core: &Core) -> Option<&'static str> {
    let spec = GetSpec::new(
        SCHEDULER_PATH,
        TtlPolicy::Fixed(Duration::from_secs(3)),
        Expect::Json,
    );
    let body = match core.served(&core.rm, &spec).await.ok()? {
        Served::Entry { entry, .. } if entry.status.is_success() => entry.body.clone(),
        _ => return None,
    };
    let kind = serde_json::from_slice::<SchedulerDoc>(&body)
        .ok()?
        .scheduler?
        .info?
        .kind?;
    match kind.as_str() {
        "capacityScheduler" | "CapacityScheduler" => Some("capacity"),
        "fairScheduler" | "FairScheduler" => Some("fair"),
        "fifoScheduler" | "FifoScheduler" => Some("fifo"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduler_kind_mapping_is_exact() {
        let d: SchedulerDoc = serde_json::from_str(
            r#"{"scheduler":{"schedulerInfo":{"type":"capacityScheduler","capacity":100.0}}}"#,
        )
        .unwrap();
        assert_eq!(
            d.scheduler.unwrap().info.unwrap().kind.as_deref(),
            Some("capacityScheduler")
        );
        assert!(serde_json::from_str::<SchedulerDoc>(r#"{"scheduler":null}"#).is_ok());
    }

    #[test]
    fn host_port_strips_scheme_and_defaults() {
        assert_eq!(host_port("http://rm:8088").as_deref(), Some("rm:8088"));
        assert_eq!(host_port("https://rm/").as_deref(), Some("rm:443"));
        assert_eq!(host_port("nonsense"), None);
    }

    #[test]
    fn pick_active_tracks_failover_before_remembered_selection() {
        let p = |url: &str, state: Option<HaState>, reachable: bool| RmProbe {
            url: url.into(),
            reachable,
            ha_state: state,
            hadoop_version: None,
            rm_state: None,
            error: None,
            latency_ms: None,
        };
        let probes = vec![
            p("http://a", Some(HaState::Standby), true),
            p("http://b", Some(HaState::Active), true),
        ];
        assert_eq!(
            pick_active(&probes, Some("http://a")).unwrap().url,
            "http://b"
        );
        assert_eq!(pick_active(&probes, None).unwrap().url, "http://b");
        let down = vec![p("http://a", None, false)];
        assert!(pick_active(&down, None).is_none());
    }
}
