//! ResourceManager HA pool.
//!
//! Algorithm (documented in `docs/architecture-backend.md`):
//!
//! 1. Candidates = endpoints not in backoff, ordered *remembered-active → non-standby → standby*.
//!    If every endpoint is in backoff the request fails fast (502) instead of hammering dead RMs.
//! 2. Try the first candidate. Outcomes:
//!    * transport error → record failure (exponential backoff), forget it as active; **connect errors**
//!      move on to the next candidate, other errors (timeouts) are returned without retry;
//!    * `3xx` (a standby RM redirecting to the active one) → mark it standby, jump to the configured RM
//!      whose authority matches `Location` (never to unknown hosts);
//!    * `503` with more than one RM configured → "not ready/standby", try the next candidate (the
//!      response is kept as a fallback in case nobody else is better);
//!    * `GET /ws/v1/cluster/info` → `haState` is read; `STANDBY` is only a fallback, `ACTIVE` is remembered;
//!    * any other answer is returned; for `/ws/v1/cluster/*` paths it also becomes the remembered active
//!      (a standby would have redirected).
//! 3. Only idempotent GETs ever flow through here, so retrying on connect errors is always safe.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use http::StatusCode;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::config::{HaConfig, Tuning, authority_of, url_string};
use crate::error::ApiError;
use crate::http::{BodyMode, Endpoint, FetchReq, HttpClient, RawErr, UpBody, UpResp};
use crate::upstream::{Health, backing_off_error};

const INFO_PATH: &str = "/ws/v1/cluster/info";
const CLUSTER_PREFIX: &str = "/ws/v1/cluster/";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum HaState {
    #[serde(rename = "ACTIVE")]
    Active,
    #[serde(rename = "STANDBY")]
    Standby,
    #[serde(rename = "OTHER")]
    Other,
}

impl HaState {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_uppercase().as_str() {
            "ACTIVE" => Self::Active,
            "STANDBY" => Self::Standby,
            _ => Self::Other,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "ACTIVE",
            Self::Standby => "STANDBY",
            Self::Other => "OTHER",
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct InfoEnvelope {
    #[serde(rename = "clusterInfo")]
    cluster_info: Option<ClusterInfo>,
}

#[derive(Debug, Default, Deserialize)]
struct ClusterInfo {
    #[serde(rename = "haState")]
    ha_state: Option<String>,
    #[serde(rename = "hadoopVersion")]
    hadoop_version: Option<String>,
    state: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct RmState {
    ha_state: Option<HaState>,
    hadoop_version: Option<String>,
    rm_state: Option<String>,
    health: Health,
}

#[derive(Default)]
struct PoolState {
    active: Option<usize>,
    nodes: Vec<RmState>,
}

/// Result of probing one RM directly.
#[derive(Debug, Clone, Serialize)]
pub struct RmProbe {
    pub url: String,
    pub reachable: bool,
    pub ha_state: Option<HaState>,
    pub hadoop_version: Option<String>,
    pub rm_state: Option<String>,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
}

pub struct RmPool {
    eps: Vec<Endpoint>,
    state: Mutex<PoolState>,
    ha: HaConfig,
}

enum Step {
    Done(UpResp),
    Redirect(Option<String>),
    Unavailable(UpResp),
    Err(RawErr),
}

impl RmPool {
    pub fn new(urls: &[url::Url], http: Arc<HttpClient>, tuning: &Tuning, ha: HaConfig) -> Self {
        let eps: Vec<Endpoint> = urls
            .iter()
            .map(|u| {
                Endpoint::new(
                    url_string(u),
                    authority_of(u),
                    http.clone(),
                    tuning.rm_concurrency,
                )
            })
            .collect();
        let state = PoolState {
            active: None,
            nodes: vec![RmState::default(); eps.len()],
        };
        Self {
            eps,
            state: Mutex::new(state),
            ha,
        }
    }

    pub fn len(&self) -> usize {
        self.eps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.eps.is_empty()
    }

    pub fn urls(&self) -> Vec<String> {
        self.eps.iter().map(|e| e.base.clone()).collect()
    }

    pub fn is_ha(&self) -> bool {
        self.eps.len() > 1
    }

    /// Base URL of the remembered active RM.
    pub fn active_url(&self) -> Option<String> {
        let st = self.state.lock();
        st.active.map(|i| self.eps[i].base.clone())
    }

    pub fn active_ha_state(&self) -> Option<HaState> {
        let st = self.state.lock();
        st.active.and_then(|i| st.nodes[i].ha_state)
    }

    /// Last known facts about every RM (no network).
    pub fn snapshot(&self) -> Vec<RmProbe> {
        let st = self.state.lock();
        self.eps
            .iter()
            .zip(st.nodes.iter())
            .map(|(e, n)| RmProbe {
                url: e.base.clone(),
                reachable: n.health.fails == 0 && n.health.last_ok.is_some(),
                ha_state: n.ha_state,
                hadoop_version: n.hadoop_version.clone(),
                rm_state: n.rm_state.clone(),
                error: n.health.last_error.clone(),
                latency_ms: None,
            })
            .collect()
    }

    fn candidates(&self, now: Instant, path_and_query: &str) -> Result<Vec<usize>, ApiError> {
        let st = self.state.lock();
        let mut avail: Vec<usize> = (0..self.eps.len())
            .filter(|&i| st.nodes[i].health.backoff_remaining(now).is_none())
            .collect();
        if avail.is_empty() {
            let (i, rem) = (0..self.eps.len())
                .filter_map(|i| st.nodes[i].health.backoff_remaining(now).map(|r| (i, r)))
                .min_by_key(|(_, r)| *r)
                .expect("pool is never empty");
            return Err(backing_off_error(
                &self.eps[i].display_url(path_and_query),
                rem,
                st.nodes[i].health.last_error.as_deref(),
                if self.eps.len() > 1 {
                    "every configured ResourceManager"
                } else {
                    &self.eps[i].authority
                },
            ));
        }
        avail.sort_by_key(|&i| {
            (
                st.active != Some(i),
                st.nodes[i].ha_state == Some(HaState::Standby),
            )
        });
        Ok(avail)
    }

    fn find_by_authority(&self, url: &str) -> Option<usize> {
        let u = url::Url::parse(url).ok()?;
        let a = authority_of(&u);
        self.eps
            .iter()
            .position(|e| e.authority.eq_ignore_ascii_case(&a))
    }

    fn mark_failure(&self, i: usize, err: &str) {
        let mut st = self.state.lock();
        st.nodes[i]
            .health
            .record_failure(Instant::now(), &self.ha, err);
        st.nodes[i].ha_state = None;
        if st.active == Some(i) {
            st.active = None;
        }
    }

    fn mark_alive(&self, i: usize) {
        self.state.lock().nodes[i].health.record_ok(Instant::now());
    }

    fn mark_standby(&self, i: usize) {
        let mut st = self.state.lock();
        st.nodes[i].ha_state = Some(HaState::Standby);
        if st.active == Some(i) {
            st.active = None;
        }
    }

    fn mark_active(&self, i: usize) {
        let mut st = self.state.lock();
        st.nodes[i].ha_state = Some(HaState::Active);
        st.active = Some(i);
    }

    async fn step(&self, i: usize, req: &FetchReq) -> Step {
        let ep = &self.eps[i];
        let att = match ep.attempt(req).await {
            Ok(a) => a,
            Err(e) => {
                self.mark_failure(i, &e.api.message);
                return Step::Err(e);
            }
        };
        self.mark_alive(i);
        let status = att.status;
        if status.is_redirection() {
            let target = att.location().and_then(|loc| {
                url::Url::parse(&att.url)
                    .ok()
                    .and_then(|base| base.join(loc).ok())
                    .map(|u| u.to_string())
            });
            return Step::Redirect(target);
        }
        if status == StatusCode::SERVICE_UNAVAILABLE && self.is_ha() {
            return match att.into_up(BodyMode::Buffer { cap: 64 * 1024 }).await {
                Ok(up) => Step::Unavailable(up),
                Err(e) => {
                    self.mark_failure(i, &e.api.message);
                    Step::Err(e)
                }
            };
        }
        match att.into_up(req.mode).await {
            Ok(up) => Step::Done(up),
            Err(e) => {
                self.mark_failure(i, &e.api.message);
                Step::Err(e)
            }
        }
    }

    pub async fn fetch(&self, req: &FetchReq) -> Result<UpResp, ApiError> {
        let is_info = req.path().ends_with(INFO_PATH);
        let is_cluster = req.path().contains(CLUSTER_PREFIX);
        let order = self.candidates(Instant::now(), &req.path_and_query)?;
        let n = self.eps.len();
        let mut tried = vec![false; n];
        let mut queue: VecDeque<usize> = order.into();
        let mut last_err: Option<ApiError> = None;
        let mut fallback: Option<UpResp> = None;
        let mut redirect_note: Option<String> = None;

        while let Some(i) = queue.pop_front() {
            if std::mem::replace(&mut tried[i], true) {
                continue;
            }
            match self.step(i, req).await {
                Step::Done(up) => {
                    let inspect_info = is_info && self.is_ha();
                    let info = inspect_info
                        .then(|| match &up.body {
                            UpBody::Full(body) => serde_json::from_slice::<InfoEnvelope>(body)
                                .ok()
                                .and_then(|e| e.cluster_info),
                            UpBody::Stream { .. } => None,
                        })
                        .flatten();
                    if let Some(ci) = info {
                        self.absorb_info(i, &ci);
                        if ci.ha_state.as_deref().map(HaState::parse) == Some(HaState::Standby) {
                            fallback.get_or_insert(up);
                            continue;
                        }
                    } else if !inspect_info && is_cluster && up.status.is_success() {
                        self.mark_active(i);
                    }
                    return Ok(up);
                }
                Step::Redirect(target) => {
                    self.mark_standby(i);
                    match target.as_deref().and_then(|t| self.find_by_authority(t)) {
                        Some(j) if !tried[j] => queue.push_front(j),
                        Some(_) => {}
                        None => {
                            redirect_note = Some(format!(
                                "{} redirected to {}, which is not one of the configured ResourceManagers",
                                self.eps[i].authority,
                                target.unwrap_or_else(|| "(no Location)".into())
                            ));
                        }
                    }
                }
                Step::Unavailable(up) => {
                    self.mark_standby(i);
                    fallback.get_or_insert(up);
                }
                Step::Err(raw) => {
                    let connect = raw.connect;
                    last_err = Some(raw.api);
                    if !connect {
                        // Request may have reached the RM: do not replay it elsewhere.
                        break;
                    }
                }
            }
        }

        if let Some(f) = fallback {
            return Ok(f);
        }
        if let Some(e) = last_err {
            return Err(e);
        }
        let url = self.eps[0].display_url(&req.path_and_query);
        let msg =
            redirect_note.unwrap_or_else(|| "no ResourceManager could serve the request".into());
        Err(ApiError::upstream_status(
            StatusCode::BAD_GATEWAY,
            url,
            StatusCode::TEMPORARY_REDIRECT.as_u16(),
            msg,
        )
        .with_hint("pass every ResourceManager of the HA pair with repeated --rm flags"))
    }

    /// Inspect a redirect returned by a path on the configured RM, without following an external target.
    /// HA redirects between configured RMs are followed internally so the returned Location is from the active RM.
    pub(crate) async fn inspect_redirect(&self, path: &str) -> Result<Option<String>, ApiError> {
        let req = FetchReq::get(path, BodyMode::Buffer { cap: 64 * 1024 });
        let order = self.candidates(Instant::now(), &req.path_and_query)?;
        let mut tried = vec![false; self.eps.len()];
        let mut queue: VecDeque<usize> = order.into();
        let mut last_err: Option<ApiError> = None;
        let mut fallback: Option<UpResp> = None;

        while let Some(i) = queue.pop_front() {
            if std::mem::replace(&mut tried[i], true) {
                continue;
            }
            match self.step(i, &req).await {
                Step::Done(_) => return Ok(None),
                Step::Redirect(target) => {
                    let Some(target) = target else {
                        return Ok(None);
                    };
                    if url::Url::parse(&target).is_ok_and(|url| {
                        url.path().contains("/jobhistory/") || url.path().contains("/history/")
                    }) {
                        return Ok(Some(target));
                    }
                    if let Some(j) = self.find_by_authority(&target).filter(|j| *j != i) {
                        self.mark_standby(i);
                        if !tried[j] {
                            queue.push_front(j);
                        }
                    } else {
                        // This is only observed and returned to the caller; it is never contacted here.
                        return Ok(Some(target));
                    }
                }
                Step::Unavailable(up) => {
                    self.mark_standby(i);
                    fallback.get_or_insert(up);
                }
                Step::Err(raw) => {
                    let connect = raw.connect;
                    last_err = Some(raw.api);
                    if !connect {
                        break;
                    }
                }
            }
        }

        if fallback.is_some() {
            return Ok(None);
        }
        match last_err {
            Some(error) => Err(error),
            None => Ok(None),
        }
    }

    fn absorb_info(&self, i: usize, ci: &ClusterInfo) {
        let ha = ci.ha_state.as_deref().map(HaState::parse);
        let mut st = self.state.lock();
        st.nodes[i].ha_state = ha;
        st.nodes[i].hadoop_version = ci.hadoop_version.clone();
        st.nodes[i].rm_state = ci.state.clone();
        match ha {
            Some(HaState::Active) => st.active = Some(i),
            Some(_) if st.active == Some(i) => st.active = None,
            _ => {}
        }
    }

    /// Probe RM `i`'s `/ws/v1/cluster/info` directly. Unless `force`, an RM in backoff is not contacted.
    pub async fn probe(&self, i: usize, force: bool) -> RmProbe {
        let ep = &self.eps[i];
        let url = ep.base.clone();
        if !force {
            let st = self.state.lock();
            if let Some(rem) = st.nodes[i].health.backoff_remaining(Instant::now()) {
                return RmProbe {
                    url,
                    reachable: false,
                    ha_state: None,
                    hadoop_version: None,
                    rm_state: None,
                    error: Some(format!(
                        "backing off for {:.1}s after: {}",
                        rem.as_secs_f32(),
                        st.nodes[i].health.last_error.as_deref().unwrap_or("error")
                    )),
                    latency_ms: None,
                };
            }
        }
        let mut req = FetchReq::get(INFO_PATH, BodyMode::Buffer { cap: 1 << 20 });
        req.accept = Some("application/json");
        let t0 = Instant::now();
        let fail = |msg: String, latency: Option<u64>| RmProbe {
            url: url.clone(),
            reachable: false,
            ha_state: None,
            hadoop_version: None,
            rm_state: None,
            error: Some(msg),
            latency_ms: latency,
        };
        let att = match ep.attempt(&req).await {
            Ok(a) => a,
            Err(e) => {
                self.mark_failure(i, &e.api.message);
                return fail(e.api.message, None);
            }
        };
        self.mark_alive(i);
        let status = att.status;
        let up = match att.into_up(req.mode).await {
            Ok(u) => u,
            Err(e) => {
                self.mark_failure(i, &e.api.message);
                return fail(e.api.message, None);
            }
        };
        let latency = t0.elapsed().as_millis() as u64;
        if status.is_redirection() {
            self.mark_standby(i);
            return RmProbe {
                url,
                reachable: true,
                ha_state: Some(HaState::Standby),
                hadoop_version: None,
                rm_state: None,
                error: None,
                latency_ms: Some(latency),
            };
        }
        if !status.is_success() {
            return fail(format!("HTTP {status} from {INFO_PATH}"), Some(latency));
        }
        let ci = match &up.body {
            UpBody::Full(b) => serde_json::from_slice::<InfoEnvelope>(b)
                .ok()
                .and_then(|e| e.cluster_info),
            UpBody::Stream { .. } => None,
        };
        let Some(ci) = ci else {
            return fail(
                format!(
                    "{INFO_PATH} did not return a clusterInfo JSON document (is this a ResourceManager?)"
                ),
                Some(latency),
            );
        };
        self.absorb_info(i, &ci);
        RmProbe {
            url,
            reachable: true,
            ha_state: ci.ha_state.as_deref().map(HaState::parse),
            hadoop_version: ci.hadoop_version,
            rm_state: ci.state,
            error: None,
            latency_ms: Some(latency),
        }
    }

    /// Probe every RM concurrently.
    pub async fn probe_all(&self, force: bool) -> Vec<RmProbe> {
        let futs = (0..self.eps.len()).map(|i| self.probe(i, force));
        futures_util::future::join_all(futs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    fn core(urls: &[&str]) -> Arc<crate::core::Core> {
        let mut config = Config::for_rm("http://127.0.0.1:8088").unwrap();
        config.rm_urls = urls.iter().map(|u| url::Url::parse(u).unwrap()).collect();
        config.ha.backoff_base = std::time::Duration::from_secs(10);
        config.ha.backoff_max = std::time::Duration::from_secs(10);
        crate::core::Core::new(config).unwrap()
    }

    #[test]
    fn ha_state_and_pool_snapshots_follow_active_standby_and_failure_changes() {
        assert_eq!(HaState::parse(" active "), HaState::Active);
        assert_eq!(HaState::parse("STANDBY"), HaState::Standby);
        assert_eq!(HaState::parse("something"), HaState::Other);
        assert_eq!(HaState::Active.as_str(), "ACTIVE");
        assert_eq!(HaState::Standby.as_str(), "STANDBY");
        assert_eq!(HaState::Other.as_str(), "OTHER");

        let core = core(&["http://one.example:8088", "http://two.example:8088"]);
        let pool = core.rm_pool();
        assert_eq!(pool.len(), 2);
        assert!(!pool.is_empty());
        assert!(pool.is_ha());
        assert_eq!(pool.urls().len(), 2);
        assert_eq!(pool.active_url(), None);
        assert_eq!(pool.active_ha_state(), None);
        assert!(pool.snapshot().iter().all(|p| !p.reachable));
        assert_eq!(
            pool.candidates(Instant::now(), "/test").unwrap(),
            vec![0, 1]
        );
        assert_eq!(pool.find_by_authority("not a URL"), None);
        assert_eq!(
            pool.find_by_authority("http://missing.example:8088/x"),
            None
        );
        assert_eq!(pool.find_by_authority("http://TWO.example:8088/x"), Some(1));

        pool.mark_standby(0);
        assert_eq!(
            pool.candidates(Instant::now(), "/test").unwrap(),
            vec![1, 0]
        );
        pool.mark_active(0);
        assert_eq!(
            pool.active_url().as_deref(),
            Some("http://one.example:8088")
        );
        assert_eq!(pool.active_ha_state(), Some(HaState::Active));
        pool.mark_standby(0);
        assert_eq!(pool.active_url(), None);
        pool.mark_active(0);
        pool.absorb_info(
            0,
            &ClusterInfo {
                ha_state: Some("STANDBY".into()),
                hadoop_version: Some("3.4.3".into()),
                state: Some("RUNNING".into()),
            },
        );
        assert_eq!(pool.active_url(), None);
        assert_eq!(pool.snapshot()[0].hadoop_version.as_deref(), Some("3.4.3"));
        assert_eq!(pool.snapshot()[0].rm_state.as_deref(), Some("RUNNING"));
        assert_eq!(pool.active_ha_state(), None);
        pool.absorb_info(
            1,
            &ClusterInfo {
                ha_state: Some("ACTIVE".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            pool.active_url().as_deref(),
            Some("http://two.example:8088")
        );
        pool.absorb_info(
            0,
            &ClusterInfo {
                ha_state: Some("OTHER".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            pool.active_url().as_deref(),
            Some("http://two.example:8088")
        );

        pool.mark_failure(1, "connection refused");
        assert_eq!(pool.candidates(Instant::now(), "/test").unwrap(), vec![0]);
        let snap = pool.snapshot();
        assert!(!snap[1].reachable);
        assert_eq!(snap[1].error.as_deref(), Some("connection refused"));
        assert!(pool.candidates(Instant::now(), "/test").is_ok());
    }

    #[tokio::test]
    async fn an_empty_pool_and_backoff_probes_report_consistent_status() {
        let empty = core(&[]);
        assert_eq!(empty.rm_pool().len(), 0);
        assert!(empty.rm_pool().is_empty());
        assert!(!empty.rm_pool().is_ha());
        assert!(empty.rm_pool().urls().is_empty());
        assert!(empty.rm_pool().snapshot().is_empty());

        let core = core(&["http://127.0.0.1:0"]);
        let pool = core.rm_pool();
        pool.mark_failure(0, "offline");
        let error = pool
            .candidates(Instant::now(), "/ws/v1/cluster/apps")
            .unwrap_err();
        assert!(error.message.contains("backing off"));
        assert!(error.message.contains("offline"));
        assert!(error.message.contains("127.0.0.1:0"));
        let probe = pool.probe(0, false).await;
        assert!(!probe.reachable);
        assert!(probe.error.unwrap().contains("offline"));
        let all = pool.probe_all(false).await;
        assert_eq!(all.len(), 1);
        assert!(!all[0].reachable);
        let forced = pool.probe(0, true).await;
        assert!(!forced.reachable);
        assert!(forced.error.unwrap().contains("cannot connect"));
    }

    struct TestRm {
        base: String,
        task: Option<tokio::task::JoinHandle<()>>,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
    }

    impl TestRm {
        async fn start(status: u16, location: Option<String>, body: &'static str) -> Self {
            Self::start_with_length(status, location, body, body.len()).await
        }

        async fn start_truncated(status: u16, body: &'static str) -> Self {
            Self::start_with_length(status, None, body, body.len() + 32).await
        }

        async fn start_with_length(
            status: u16,
            location: Option<String>,
            body: &'static str,
            content_length: usize,
        ) -> Self {
            Self::start_shared_location(
                status,
                Arc::new(Mutex::new(location)),
                body,
                content_length,
            )
            .await
        }

        async fn start_dynamic(
            status: u16,
            body: &'static str,
        ) -> (Self, Arc<Mutex<Option<String>>>) {
            let location = Arc::new(Mutex::new(None));
            let rm = Self::start_shared_location(status, location.clone(), body, body.len()).await;
            (rm, location)
        }

        async fn start_shared_location(
            status: u16,
            location: Arc<Mutex<Option<String>>>,
            body: &'static str,
            content_length: usize,
        ) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let (stop, mut stop_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                loop {
                    let accepted = tokio::select! {
                        _ = &mut stop_rx => break,
                        accepted = listener.accept() => accepted,
                    };
                    let (stream, _) = accepted.expect("test listener remains available");
                    let location = location.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(stream);
                        let mut line = String::new();
                        while reader.read_line(&mut line).await.unwrap_or(0) > 0 && line != "\r\n" {
                            line.clear();
                        }
                        let location = location
                            .lock()
                            .clone()
                            .as_deref()
                            .map(|value| format!("Location: {value}\r\n"))
                            .unwrap_or_default();
                        let wire = format!(
                            "HTTP/1.1 {status} Test Response\r\nContent-Type: application/json\r\nContent-Length: {content_length}\r\n{location}Connection: close\r\n\r\n{body}"
                        );
                        let _ = reader.get_mut().write_all(wire.as_bytes()).await;
                    });
                }
            });
            Self {
                base,
                task: Some(task),
                stop: Some(stop),
            }
        }

        async fn shutdown(mut self) {
            self.stop
                .take()
                .expect("test RM has a stop sender")
                .send(())
                .expect("test RM task is listening");
            self.task.take().expect("test RM has a task").await.unwrap();
        }
    }

    impl Drop for TestRm {
        fn drop(&mut self) {
            if let Some(task) = &self.task {
                task.abort();
            }
        }
    }

    fn pool(urls: &[&str]) -> Arc<crate::core::Core> {
        core(urls)
    }

    fn info(state: &str) -> &'static str {
        match state {
            "ACTIVE" => {
                r#"{"clusterInfo":{"haState":"ACTIVE","hadoopVersion":"3.4.0","state":"STARTED"}}"#
            }
            "STANDBY" => {
                r#"{"clusterInfo":{"haState":"STANDBY","hadoopVersion":"3.4.0","state":"STARTED"}}"#
            }
            _ => r#"{"clusterInfo":{"haState":"OTHER","state":"INITIALIZING"}}"#,
        }
    }

    #[tokio::test]
    async fn fetch_follows_only_configured_redirects_and_remembers_active_rm() {
        let active = TestRm::start(200, None, info("ACTIVE")).await;
        let standby =
            TestRm::start(307, Some(format!("{}/ws/v1/cluster/info", active.base)), "").await;
        let core = pool(&[&standby.base, &active.base]);
        let mut req = FetchReq::get(INFO_PATH, BodyMode::Buffer { cap: 1024 });
        req.accept = Some("application/json");
        let up = core.rm_pool().fetch(&req).await.unwrap();
        assert_eq!(up.status, StatusCode::OK);
        assert_eq!(
            core.rm_pool().active_url().as_deref(),
            Some(active.base.as_str())
        );
        assert_eq!(core.rm_pool().active_ha_state(), Some(HaState::Active));

        let ordinary = TestRm::start(200, None, "{}").await;
        let ordinary_core = pool(&[&ordinary.base]);
        let reply = ordinary_core
            .rm_pool()
            .fetch(&FetchReq::get(
                "/ws/v1/cluster/apps",
                BodyMode::Buffer { cap: 100 },
            ))
            .await
            .unwrap();
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            ordinary_core.rm_pool().active_url().as_deref(),
            Some(ordinary.base.as_str())
        );

        let standby_one = TestRm::start(200, None, info("STANDBY")).await;
        let active_two = TestRm::start(200, None, info("ACTIVE")).await;
        let standby_core = pool(&[&standby_one.base, &active_two.base]);
        standby_core.rm_pool().fetch(&req).await.unwrap();
        assert_eq!(
            standby_core.rm_pool().active_url().as_deref(),
            Some(active_two.base.as_str())
        );

        let streamed = standby_core
            .rm_pool()
            .fetch(&FetchReq::get(INFO_PATH, BodyMode::Stream))
            .await
            .unwrap();
        assert!(matches!(streamed.body, UpBody::Stream { .. }));
    }

    #[tokio::test]
    async fn fetch_returns_only_a_safe_fallback_for_unready_or_unknown_redirects() {
        let first = TestRm::start(503, None, "standby").await;
        let second = TestRm::start(503, None, "also standby").await;
        let core = pool(&[&first.base, &second.base]);
        let reply = core
            .rm_pool()
            .fetch(&FetchReq::get("/apps", BodyMode::Buffer { cap: 100 }))
            .await
            .unwrap();
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            core.rm_pool()
                .snapshot()
                .iter()
                .filter(|p| p.ha_state == Some(HaState::Standby))
                .count(),
            2
        );

        let outside = TestRm::start(
            307,
            Some("http://other.example:8088/ws/v1/cluster/apps".into()),
            "",
        )
        .await;
        let core = pool(&[&outside.base]);
        let error = core
            .rm_pool()
            .fetch(&FetchReq::get("/ws/v1/cluster/apps", BodyMode::Stream))
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert!(error.message.contains("not one of the configured"));
        assert!(error.hint.unwrap().contains("every ResourceManager"));

        let no_location = TestRm::start(302, None, "").await;
        let core = pool(&[&no_location.base]);
        let error = core
            .rm_pool()
            .fetch(&FetchReq::get("/apps", BodyMode::Buffer { cap: 100 }))
            .await
            .err()
            .expect("a redirect without Location cannot serve the request");
        assert!(error.message.contains("(no Location)"));

        let one = TestRm::start(200, None, info("ACTIVE")).await;
        let two = TestRm::start(200, None, info("ACTIVE")).await;
        let core = pool(&[&one.base, &two.base]);
        core.rm_pool().mark_failure(0, "down one");
        core.rm_pool().mark_failure(1, "down two");
        let error = core
            .rm_pool()
            .fetch(&FetchReq::get("/apps", BodyMode::Buffer { cap: 100 }))
            .await
            .err()
            .expect("all endpoints are in backoff");
        assert!(error.message.contains("backing off"));
        assert!(error.message.contains("every configured ResourceManager"));
    }

    #[tokio::test]
    async fn inspect_redirect_only_returns_observed_history_or_external_locations() {
        let history = TestRm::start(
            307,
            Some("http://jhs.example:19888/jobhistory/logs/node/container/user".into()),
            "",
        )
        .await;
        let core = pool(&[&history.base]);
        let observed = core
            .rm_pool()
            .inspect_redirect("/tracking")
            .await
            .unwrap()
            .unwrap();
        assert!(observed.contains("/jobhistory/logs/"));

        let external = TestRm::start(307, Some("http://outside.example/path".into()), "").await;
        let core = pool(&[&external.base]);
        assert_eq!(
            core.rm_pool()
                .inspect_redirect("/tracking")
                .await
                .unwrap()
                .as_deref(),
            Some("http://outside.example/path")
        );

        let regular = TestRm::start(200, None, "{}").await;
        let core = pool(&[&regular.base]);
        assert_eq!(
            core.rm_pool().inspect_redirect("/tracking").await.unwrap(),
            None
        );

        let reachable = TestRm::start(200, None, "{}").await;
        let core = pool(&["http://127.0.0.1:0", &reachable.base]);
        assert_eq!(
            core.rm_pool().inspect_redirect("/tracking").await.unwrap(),
            None
        );

        let standby1 = TestRm::start(503, None, "{}").await;
        let standby2 = TestRm::start(503, None, "{}").await;
        let core = pool(&[&standby1.base, &standby2.base]);
        assert_eq!(
            core.rm_pool().inspect_redirect("/tracking").await.unwrap(),
            None
        );
        TestRm::start(200, None, "{}").await.shutdown().await;

        let history = TestRm::start(
            302,
            Some("http://jhs.example:19888/jobhistory/logs".into()),
            "",
        )
        .await;
        let active = TestRm::start(302, Some(history.base.clone()), "").await;
        let core = pool(&[&active.base, &history.base]);
        assert_eq!(
            core.rm_pool()
                .inspect_redirect("/tracking")
                .await
                .unwrap()
                .as_deref(),
            Some("http://jhs.example:19888/jobhistory/logs")
        );

        let no_location = TestRm::start(302, None, "").await;
        let core = pool(&[&no_location.base]);
        assert_eq!(
            core.rm_pool().inspect_redirect("/tracking").await.unwrap(),
            None
        );

        let fallback = TestRm::start(503, None, "").await;
        let other = TestRm::start(200, None, "{}").await;
        let core = pool(&[&fallback.base, &other.base]);
        assert_eq!(
            core.rm_pool().inspect_redirect("/tracking").await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn direct_probes_cover_redirect_http_json_backoff_and_forced_retry() {
        let redirect = TestRm::start(302, Some("http://active.example:8088/".into()), "").await;
        let core = pool(&[&redirect.base]);
        let probe = core.rm_pool().probe(0, false).await;
        assert!(probe.reachable);
        assert_eq!(probe.ha_state, Some(HaState::Standby));

        let failure = TestRm::start(500, None, "error").await;
        let core = pool(&[&failure.base]);
        let probe = core.rm_pool().probe(0, false).await;
        assert!(!probe.reachable);
        assert!(probe.error.unwrap().contains("HTTP 500"));

        let invalid = TestRm::start(200, None, "not json").await;
        let core = pool(&[&invalid.base]);
        let probe = core.rm_pool().probe(0, false).await;
        assert!(!probe.reachable);
        assert!(
            probe
                .error
                .unwrap()
                .contains("did not return a clusterInfo")
        );

        let good = TestRm::start(200, None, info("OTHER")).await;
        let core = pool(&[&good.base]);
        let probe = core.rm_pool().probe(0, false).await;
        assert!(probe.reachable);
        assert_eq!(probe.ha_state, Some(HaState::Other));
        assert_eq!(probe.rm_state.as_deref(), Some("INITIALIZING"));
        assert_eq!(
            core.rm_pool().snapshot()[0].rm_state.as_deref(),
            Some("INITIALIZING")
        );

        core.rm_pool().mark_failure(0, "backoff");
        assert!(
            core.rm_pool()
                .probe(0, false)
                .await
                .error
                .unwrap()
                .contains("backoff")
        );
        let forced = core.rm_pool().probe(0, true).await;
        assert!(forced.reachable);
    }

    #[tokio::test]
    async fn truncated_bodies_and_redirect_cycles_are_reported_without_replay() {
        let unavailable = TestRm::start_truncated(503, "standby").await;
        let backup = TestRm::start(200, None, "ok").await;
        let ha = pool(&[&unavailable.base, &backup.base]);
        let error = ha
            .rm_pool()
            .fetch(&FetchReq::get("/apps", BodyMode::Buffer { cap: 100 }))
            .await
            .err()
            .expect("a truncated standby response is an upstream failure");
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);

        let truncated = TestRm::start_truncated(200, "partial").await;
        let other = TestRm::start(200, None, "ok").await;
        let core = pool(&[&truncated.base, &other.base]);
        assert!(
            core.rm_pool()
                .fetch(&FetchReq::get("/apps", BodyMode::Buffer { cap: 100 }))
                .await
                .is_err()
        );
        assert!(
            pool(&[&truncated.base])
                .rm_pool()
                .inspect_redirect("/tracking")
                .await
                .is_err()
        );
        assert!(
            !pool(&[&truncated.base])
                .rm_pool()
                .probe(0, true)
                .await
                .reachable
        );

        let large_body: &'static str = Box::leak("x".repeat((1 << 20) + 1).into_boxed_str());
        let large = TestRm::start(200, None, large_body).await;
        assert!(
            !pool(&[&large.base])
                .rm_pool()
                .probe(0, true)
                .await
                .reachable
        );

        let (first, first_location) = TestRm::start_dynamic(302, "").await;
        let (second, second_location) = TestRm::start_dynamic(302, "").await;
        *first_location.lock() = Some(format!("{}/next", second.base));
        *second_location.lock() = Some(format!("{}/next", first.base));
        let cycle = pool(&[&first.base, &second.base]);
        let error = cycle
            .rm_pool()
            .fetch(&FetchReq::get("/cycle", BodyMode::Buffer { cap: 100 }))
            .await
            .err()
            .expect("a redirect cycle has no serving RM");
        assert!(error.message.contains("no ResourceManager could serve"));
        assert!(cycle.rm_pool().inspect_redirect("/cycle").await.is_ok());

        let (self_redirect, location) = TestRm::start_dynamic(302, "").await;
        *location.lock() = Some(format!("{}/again", self_redirect.base));
        let core = pool(&[&self_redirect.base]);
        assert!(
            core.rm_pool()
                .fetch(&FetchReq::get("/self", BodyMode::Buffer { cap: 10 }))
                .await
                .is_err()
        );
    }
}
