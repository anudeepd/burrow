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
                    if is_info && self.is_ha() {
                        if let UpBody::Full(body) = &up.body {
                            let info = serde_json::from_slice::<InfoEnvelope>(body)
                                .ok()
                                .and_then(|e| e.cluster_info);
                            if let Some(ci) = info {
                                self.absorb_info(i, &ci);
                                if ci.ha_state.as_deref().map(HaState::parse)
                                    == Some(HaState::Standby)
                                {
                                    fallback.get_or_insert(up);
                                    continue;
                                }
                            }
                        }
                    } else if is_cluster && up.status.is_success() {
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
