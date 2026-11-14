//! Server-side applications index for `/api/yarn/apps?window=1`.
//!
//! Why this exists: the ResourceManager applies `limit` while it walks its app map (so a small preview is
//! fast), but it has no `offset`. Offset paging therefore has to be served from one complete snapshot. The
//! first request answers with a `limit` preview so the page paints immediately; the complete list is fetched
//! and parsed once in the background. Every later page, filter and sort is a cheap slice of that snapshot.
//!
//! The snapshot is an immutable `Arc<Snapshot>`: a refresh builds a new one off to the side and swaps it in
//! with a single lock, so a response can never mix rows from two different lists. App objects stay as the
//! upstream's raw JSON bytes (`RawValue`); only the fields needed for filtering/sorting are extracted into
//! `AppMeta`. Unknown/new fields therefore pass through unchanged and memory stays close to the wire size.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use url::form_urlencoded;

use crate::api::ApiRequest;
use crate::cache::{CacheSource, Expect, Served, TtlPolicy};
use crate::config::AppsIndexConfig;
use crate::core::{Core, GetSpec};
use crate::error::ApiError;
use crate::http::{UpBody, UpResp};
use crate::reply::Reply;
use crate::routes::table::query_param;

/// Default page size when the caller does not name one.
pub const DEFAULT_WINDOW_LIMIT: usize = 100;
/// Hard page-size cap: no browser request can make the backend serialise an unbounded window.
pub const MAX_WINDOW_LIMIT: usize = 1_000;

const YARN_APP_STATES: &[&str] = &[
    "NEW",
    "NEW_SAVING",
    "SUBMITTED",
    "ACCEPTED",
    "RUNNING",
    "FINISHED",
    "FAILED",
    "KILLED",
];
const ACTIVE_STATES: &[&str] = &["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING"];
const DEFAULT_SORT: &str = "-starttime";

/// One parsed `/api/yarn/apps?window=1` request.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowRequest {
    pub offset: usize,
    pub limit: usize,
    pub sort: Vec<SortSpec>,
    pub filters: AppFilters,
}

impl WindowRequest {
    pub fn parse(query: Option<&str>) -> Result<Self, ApiError> {
        let offset = parse_usize(query, "offset")?.unwrap_or(0);
        let limit = parse_usize(query, "limit")?
            .unwrap_or(DEFAULT_WINDOW_LIMIT)
            .clamp(1, MAX_WINDOW_LIMIT);
        let sort = parse_sort(query_param(query, "sort").as_deref());
        let filters = AppFilters::parse(query)?;
        Ok(Self {
            offset,
            limit,
            sort,
            filters,
        })
    }

    /// The upstream query for the fast preview. It asks for enough rows to cover `offset + limit`, capped
    /// at the configured preview ceiling. Filters RM understands exactly are pushed down; `name` is not
    /// (the UI does substring matching, the RM does exact matching).
    fn preview_query(&self, preview_max: usize) -> Option<String> {
        let wanted = self.offset.saturating_add(self.limit);
        if wanted == 0 || self.offset >= preview_max {
            return None;
        }
        let fetch = wanted.min(preview_max);
        let mut ser = form_urlencoded::Serializer::new(String::new());
        ser.append_pair("deSelects", "resourceRequests");
        ser.append_pair("limit", &fetch.to_string());
        if !self.filters.states.is_empty() {
            ser.append_pair("states", &self.filters.states.join(","));
        }
        if let Some(value) = &self.filters.final_status {
            ser.append_pair("finalStatus", value);
        }
        if let Some(value) = &self.filters.user {
            ser.append_pair("user", value);
        }
        if let Some(value) = &self.filters.queue {
            ser.append_pair("queue", value);
        }
        if let Some(value) = &self.filters.application_type {
            ser.append_pair("applicationTypes", value);
        }
        if let Some(value) = &self.filters.tag {
            ser.append_pair("applicationTags", value);
        }
        if let Some(value) = self.filters.started_after {
            ser.append_pair("startedTimeBegin", &value.to_string());
        }
        if let Some(value) = self.filters.started_before {
            ser.append_pair("startedTimeEnd", &value.to_string());
        }
        if let Some(value) = self.filters.finished_after {
            ser.append_pair("finishedTimeBegin", &value.to_string());
        }
        if let Some(value) = self.filters.finished_before {
            ser.append_pair("finishedTimeEnd", &value.to_string());
        }
        Some(ser.finish())
    }
}

fn parse_usize(query: Option<&str>, name: &str) -> Result<Option<usize>, ApiError> {
    let Some(raw) = query_param(query, name) else {
        return Ok(None);
    };
    raw.trim()
        .parse::<usize>()
        .map(Some)
        .map_err(|_| ApiError::bad_request(format!("{name} must be a non-negative integer")))
}

/// Filters shared by the preview path and the full snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppFilters {
    pub states: Vec<String>,
    pub final_status: Option<String>,
    pub user: Option<String>,
    pub queue: Option<String>,
    pub application_type: Option<String>,
    pub tag: Option<String>,
    pub name: Option<String>,
    pub started_after: Option<i64>,
    pub started_before: Option<i64>,
    pub finished_after: Option<i64>,
    pub finished_before: Option<i64>,
}

impl AppFilters {
    fn parse(query: Option<&str>) -> Result<Self, ApiError> {
        let states = query_param(query, "states")
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_ascii_uppercase())
                    .filter(|s| {
                        !s.is_empty() && s != "ALL" && YARN_APP_STATES.contains(&s.as_str())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let text = |name: &str| {
            query_param(query, name)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let final_status = text("final").map(|v| v.to_ascii_uppercase());
        Ok(Self {
            states,
            final_status,
            user: text("user"),
            queue: text("queue"),
            application_type: text("type"),
            tag: text("tag").map(|v| v.to_ascii_lowercase()),
            name: text("name"),
            started_after: parse_i64(query, "startedAfter")?,
            started_before: parse_i64(query, "startedBefore")?,
            finished_after: parse_i64(query, "finishedAfter")?,
            finished_before: parse_i64(query, "finishedBefore")?,
        })
    }

    fn matches(&self, app: &AppMeta) -> bool {
        if !self.states.is_empty() && !self.states.iter().any(|s| s == &app.state) {
            return false;
        }
        if let Some(final_status) = &self.final_status
            && &app.final_status != final_status
        {
            return false;
        }
        if let Some(user) = &self.user
            && &app.user != user
        {
            return false;
        }
        if let Some(queue) = &self.queue
            && &app.queue != queue
        {
            return false;
        }
        if let Some(application_type) = &self.application_type
            && &app.application_type != application_type
        {
            return false;
        }
        if let Some(tag) = &self.tag
            && !app
                .application_tags
                .split(',')
                .map(|t| t.trim().to_ascii_lowercase())
                .any(|t| t == *tag)
        {
            return false;
        }
        if let Some(needle) = &self.name {
            let needle = needle.to_ascii_lowercase();
            let hit = if needle.contains("application_") {
                app.id.to_ascii_lowercase().contains(&needle)
            } else {
                app.name.to_ascii_lowercase().contains(&needle)
            };
            if !hit {
                return false;
            }
        }
        let started_after = self.started_after.unwrap_or(0);
        let started_before = self.started_before.unwrap_or(i64::MAX);
        if app.started_time < started_after || app.started_time > started_before {
            return false;
        }
        let finished_after = self.finished_after.unwrap_or(0);
        let finished_before = self.finished_before.unwrap_or(i64::MAX);
        let has_finished_range =
            self.finished_after.is_some_and(|v| v > 0) || self.finished_before.is_some();
        !(has_finished_range
            && (app.finished_time < finished_after || app.finished_time > finished_before))
    }
}

fn parse_i64(query: Option<&str>, name: &str) -> Result<Option<i64>, ApiError> {
    let Some(raw) = query_param(query, name) else {
        return Ok(None);
    };
    raw.trim()
        .parse::<i64>()
        .map(Some)
        .map_err(|_| ApiError::bad_request(format!("{name} must be an integer")))
}

/// Sort columns exposed by the apps table. Unknown tokens are ignored, matching the UI's "stale URL"
/// behaviour; if none survive, `-starttime` is used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortField {
    Id,
    User,
    Name,
    Type,
    AppTag,
    Queue,
    Priority,
    StartTime,
    LaunchTime,
    FinishTime,
    State,
    FinalStatus,
    RunningContainers,
    AllocatedCpu,
    AllocatedMemory,
    AllocatedGpu,
    ReservedCpu,
    ReservedMemory,
    ReservedGpu,
    QueuePercentage,
    ClusterPercentage,
    Progress,
    Ui,
}

impl SortField {
    fn parse(token: &str) -> Option<Self> {
        Some(match token {
            "id" => Self::Id,
            "user" => Self::User,
            "name" => Self::Name,
            "type" => Self::Type,
            "apptag" => Self::AppTag,
            "queue" => Self::Queue,
            "priority" => Self::Priority,
            "starttime" => Self::StartTime,
            "IDlaunchtime" => Self::LaunchTime,
            "finishtime" => Self::FinishTime,
            "state" => Self::State,
            "finalstatus" => Self::FinalStatus,
            "runningcontainer" => Self::RunningContainers,
            "allocatedCpu" => Self::AllocatedCpu,
            "allocatedMemory" => Self::AllocatedMemory,
            "allocatedGpu" => Self::AllocatedGpu,
            "reservedCpu" => Self::ReservedCpu,
            "reservedMemory" => Self::ReservedMemory,
            "reservedGpu" => Self::ReservedGpu,
            "queuePercentage" => Self::QueuePercentage,
            "clusterPercentage" => Self::ClusterPercentage,
            "progress" => Self::Progress,
            "ui" => Self::Ui,
            _ => return None,
        })
    }

    fn compare(self, a: &AppMeta, b: &AppMeta) -> Ordering {
        match self {
            Self::Id => text_cmp(&a.id, &b.id),
            Self::User => text_cmp(&a.user, &b.user),
            Self::Name => text_cmp(&a.name, &b.name),
            Self::Type => text_cmp(&a.application_type, &b.application_type),
            Self::AppTag => text_cmp(&a.application_tags, &b.application_tags),
            Self::Queue => text_cmp(&a.queue, &b.queue),
            Self::State => text_cmp(&a.state, &b.state),
            Self::FinalStatus => text_cmp(&a.final_status, &b.final_status),
            Self::Ui => text_cmp(&a.tracking_ui, &b.tracking_ui),
            Self::Priority => num_cmp(a.priority, b.priority),
            Self::StartTime => int_cmp(a.started_time, b.started_time),
            Self::LaunchTime => int_cmp(a.launch_time, b.launch_time),
            Self::FinishTime => int_cmp(a.finished_time, b.finished_time),
            Self::RunningContainers => num_cmp(a.running_containers, b.running_containers),
            Self::AllocatedCpu => num_cmp(a.allocated_vcores, b.allocated_vcores),
            Self::AllocatedMemory => num_cmp(a.allocated_mb, b.allocated_mb),
            Self::AllocatedGpu => num_cmp(a.allocated_gpus, b.allocated_gpus),
            Self::ReservedCpu => num_cmp(a.reserved_vcores, b.reserved_vcores),
            Self::ReservedMemory => num_cmp(a.reserved_mb, b.reserved_mb),
            Self::ReservedGpu => num_cmp(a.reserved_gpus, b.reserved_gpus),
            Self::QueuePercentage => num_cmp(a.queue_usage_percentage, b.queue_usage_percentage),
            Self::ClusterPercentage => {
                num_cmp(a.cluster_usage_percentage, b.cluster_usage_percentage)
            }
            Self::Progress => num_cmp(a.progress, b.progress),
        }
    }
}

fn text_cmp(a: &str, b: &str) -> Ordering {
    a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase())
}

fn num_cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

fn int_cmp(a: i64, b: i64) -> Ordering {
    a.cmp(&b)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SortSpec {
    pub field: SortField,
    pub desc: bool,
}

fn parse_sort(raw: Option<&str>) -> Vec<SortSpec> {
    let mut out = Vec::new();
    for token in raw.unwrap_or(DEFAULT_SORT).split(',') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let (desc, name) = match token.strip_prefix('-') {
            Some(name) => (true, name),
            None => (false, token),
        };
        if let Some(field) = SortField::parse(name) {
            out.push(SortSpec { field, desc });
        }
    }
    if out.is_empty() {
        out.push(SortSpec {
            field: SortField::StartTime,
            desc: true,
        });
    }
    out
}

/// The fields the index needs. Values are extracted once when a snapshot is built; filtering and sorting
/// then never touch JSON.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppMeta {
    pub id: String,
    pub user: String,
    pub name: String,
    pub queue: String,
    pub state: String,
    pub final_status: String,
    pub application_type: String,
    pub application_tags: String,
    pub priority: f64,
    pub started_time: i64,
    pub launch_time: i64,
    pub finished_time: i64,
    pub running_containers: f64,
    pub allocated_vcores: f64,
    pub allocated_mb: f64,
    pub allocated_gpus: f64,
    pub reserved_vcores: f64,
    pub reserved_mb: f64,
    pub reserved_gpus: f64,
    pub queue_usage_percentage: f64,
    pub cluster_usage_percentage: f64,
    pub progress: f64,
    pub tracking_ui: String,
}

#[derive(Debug)]
pub struct AppEntry {
    pub raw: Box<RawValue>,
    pub meta: AppMeta,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetCount {
    pub value: String,
    pub count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub total: usize,
    pub by_state: BTreeMap<String, usize>,
    pub by_final: BTreeMap<String, usize>,
    pub active: usize,
    pub users: Vec<FacetCount>,
    pub queues: Vec<FacetCount>,
    pub types: Vec<FacetCount>,
    pub tags: Vec<FacetCount>,
}

fn compute_facets(entries: &[AppEntry]) -> Facets {
    let mut by_state = BTreeMap::new();
    let mut by_final = BTreeMap::new();
    let mut users: HashMap<String, usize> = HashMap::new();
    let mut queues: HashMap<String, usize> = HashMap::new();
    let mut types: HashMap<String, usize> = HashMap::new();
    let mut tags: HashMap<String, usize> = HashMap::new();
    let mut active = 0usize;
    for entry in entries {
        let app = &entry.meta;
        *by_state.entry(app.state.clone()).or_default() += 1;
        if !app.final_status.is_empty() {
            *by_final.entry(app.final_status.clone()).or_default() += 1;
        }
        if ACTIVE_STATES.contains(&app.state.as_str()) {
            active += 1;
        }
        *users.entry(app.user.clone()).or_default() += 1;
        *queues.entry(app.queue.clone()).or_default() += 1;
        if !app.application_type.is_empty() {
            *types.entry(app.application_type.clone()).or_default() += 1;
        }
        for tag in app.application_tags.split(',') {
            let tag = tag.trim();
            if !tag.is_empty() {
                *tags.entry(tag.to_string()).or_default() += 1;
            }
        }
    }
    Facets {
        total: entries.len(),
        by_state,
        by_final,
        active,
        users: to_facet_list(users),
        queues: to_facet_list(queues),
        types: to_facet_list(types),
        tags: to_facet_list(tags),
    }
}

fn to_facet_list(counts: HashMap<String, usize>) -> Vec<FacetCount> {
    let mut out: Vec<_> = counts
        .into_iter()
        .map(|(value, count)| FacetCount { value, count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value)));
    out
}

#[derive(Debug, Deserialize)]
struct AppsDoc<T> {
    #[serde(default)]
    apps: Option<AppsList<T>>,
}

#[derive(Debug, Deserialize)]
struct AppsList<T> {
    #[serde(default)]
    app: Option<T>,
}

/// Parse the RM's wrapped list. Individual apps that are not JSON objects (or have no id) are skipped:
/// one malformed row must not blank an otherwise usable 10k-app table.
///
/// Hadoop emits `app` as an array for N apps and as a bare object for one. Two concrete parses avoid
/// `#[serde(untagged)]` here: `RawValue` is not supported by serde's untagged content buffering, and a
/// `Value` round-trip would allocate a second full copy of the list.
pub fn parse_apps(body: &[u8]) -> Result<Vec<AppEntry>, ApiError> {
    let many: Result<AppsDoc<Vec<Box<RawValue>>>, _> = serde_json::from_slice(body);
    let raw = match many {
        Ok(doc) => doc.apps.and_then(|list| list.app).unwrap_or_default(),
        Err(_) => {
            let doc: AppsDoc<Box<RawValue>> = serde_json::from_slice(body).map_err(|e| {
                ApiError::internal(format!(
                    "the ResourceManager application list is not valid JSON: {e}"
                ))
            })?;
            doc.apps
                .and_then(|list| list.app)
                .map(|app| vec![app])
                .unwrap_or_default()
        }
    };
    let mut out = Vec::with_capacity(raw.len());
    for raw in raw {
        if let Some(meta) = parse_meta(&raw) {
            out.push(AppEntry { raw, meta });
        }
    }
    Ok(out)
}

fn parse_meta(raw: &RawValue) -> Option<AppMeta> {
    let value: serde_json::Value =
        serde_json::from_str(raw.get()).unwrap_or(serde_json::Value::Null);
    let obj = value.as_object()?;
    let text = |key: &str| {
        obj.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let number = |key: &str| {
        obj.get(key)
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0)
    };
    let integer = |key: &str| {
        obj.get(key)
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0)
    };
    let id = text("id");
    if id.is_empty() {
        return None;
    }
    Some(AppMeta {
        id,
        user: text("user"),
        name: text("name"),
        queue: text("queue"),
        state: text("state"),
        final_status: text("finalStatus"),
        application_type: text("applicationType"),
        application_tags: text("applicationTags"),
        priority: number("priority"),
        started_time: integer("startedTime"),
        launch_time: integer("launchTime"),
        finished_time: integer("finishedTime"),
        running_containers: number("runningContainers"),
        allocated_vcores: number("allocatedVCores"),
        allocated_mb: number("allocatedMB"),
        allocated_gpus: number("allocatedGpus"),
        reserved_vcores: number("reservedVCores"),
        reserved_mb: number("reservedMB"),
        reserved_gpus: number("reservedGpus"),
        queue_usage_percentage: number("queueUsagePercentage"),
        cluster_usage_percentage: number("clusterUsagePercentage"),
        progress: number("progress"),
        tracking_ui: text("trackingUI"),
    })
}

#[derive(Debug)]
struct Snapshot {
    apps: Vec<AppEntry>,
    facets: Facets,
    fetched_at: Instant,
    version: u64,
}

struct Inner {
    snapshot: Option<Arc<Snapshot>>,
    loading: bool,
    last_attempt: Option<Instant>,
    last_error: Option<String>,
    version: u64,
    last_access: Instant,
}

/// The shared index. `Core` owns one behind an `Arc` so the refresh task can hold it independently.
pub struct AppsIndex {
    cfg: AppsIndexConfig,
    inner: Mutex<Inner>,
}

impl AppsIndex {
    pub fn new(cfg: AppsIndexConfig) -> Self {
        Self {
            cfg,
            inner: Mutex::new(Inner {
                snapshot: None,
                loading: false,
                last_attempt: None,
                last_error: None,
                version: 0,
                last_access: Instant::now(),
            }),
        }
    }

    /// Serve one window. Always returns quickly when a snapshot exists; the cold path asks the RM for a
    /// bounded preview first and leaves the full fetch to a background task.
    pub async fn window(
        self: &Arc<Self>,
        core: &Core,
        req: ApiRequest<'_>,
    ) -> Result<Reply, ApiError> {
        let window = WindowRequest::parse(req.query)?;
        let snapshot = {
            let mut inner = self.inner.lock();
            inner.last_access = Instant::now();
            if inner
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.fetched_at.elapsed() >= self.cfg.idle_after)
            {
                inner.snapshot = None;
            }
            let stale = inner.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.fetched_at.elapsed() >= self.cfg.refresh_after
                    || inner.last_error.is_some()
            });
            (inner.snapshot.clone(), stale, inner.last_error.clone())
        };
        let reply = match snapshot {
            (Some(snapshot), stale, error) => {
                snapshot_reply(&window, &snapshot, self.cfg.refresh_after, stale, error)
            }
            (None, _, _) => self.preview_reply(core, &window).await?,
        };
        self.maybe_refresh(core);
        Ok(reply)
    }

    fn maybe_refresh(self: &Arc<Self>, core: &Core) {
        let now = Instant::now();
        let mut inner = self.inner.lock();
        let due = match &inner.snapshot {
            Some(snapshot) => now.duration_since(snapshot.fetched_at) >= self.cfg.refresh_after,
            None => true,
        };
        if !due || inner.loading {
            return;
        }
        if inner
            .last_attempt
            .is_some_and(|attempt| now.duration_since(attempt) < self.cfg.retry_after)
        {
            return;
        }
        let core = core.shared();
        inner.loading = true;
        inner.last_attempt = Some(now);
        let index = self.clone();
        tokio::spawn(async move {
            index.refresh(core).await;
        });
    }

    async fn refresh(self: Arc<Self>, core: Arc<Core>) {
        let result = fetch_full_list(&core, &self.cfg).await;
        let mut inner = self.inner.lock();
        inner.loading = false;
        match result {
            Ok(apps) => {
                let facets = compute_facets(&apps);
                inner.version += 1;
                inner.snapshot = Some(Arc::new(Snapshot {
                    apps,
                    facets,
                    fetched_at: Instant::now(),
                    version: inner.version,
                }));
                inner.last_error = None;
            }
            Err(error) => {
                inner.last_error = Some(error.message.clone());
            }
        }
    }

    async fn preview_reply(&self, core: &Core, window: &WindowRequest) -> Result<Reply, ApiError> {
        let Some(query) = window.preview_query(self.cfg.preview_max) else {
            return Ok(window_reply(
                Vec::new(),
                WindowMeta::partial(
                    window,
                    window.offset.saturating_add(window.limit),
                    Some(self.cfg.retry_after),
                    None,
                ),
            ));
        };
        let mut spec = GetSpec::new(
            "/ws/v1/cluster/apps",
            TtlPolicy::Fixed(self.cfg.preview_ttl),
            Expect::Json,
        );
        spec.query = Some(&query);
        let served = core.served(&core.rm, &spec).await?;
        let body = served_body(served, self.cfg.max_body_bytes).await?;
        let entries = parse_apps(&body)?;
        let mut matched: Vec<&AppEntry> = entries
            .iter()
            .filter(|entry| window.filters.matches(&entry.meta))
            .collect();
        sort_entries(&mut matched, &window.sort);
        let filtered_total = preview_total(window.offset, window.limit, matched.len());
        let page = matched
            .iter()
            .skip(window.offset)
            .take(window.limit)
            .map(|entry| entry.raw.as_ref())
            .collect::<Vec<_>>();
        let facets = compute_facets(&entries);
        let mut meta = WindowMeta::partial(
            window,
            filtered_total,
            Some(self.cfg.retry_after),
            Some(facets),
        );
        meta.age_ms = 0;
        Ok(window_reply(page, meta))
    }
}

fn preview_total(offset: usize, limit: usize, matched: usize) -> usize {
    if offset == 0 {
        matched
    } else {
        matched.max(offset.saturating_add(limit))
    }
}

fn sort_entries(entries: &mut [&AppEntry], sort: &[SortSpec]) {
    entries.sort_by(|a, b| {
        for spec in sort {
            let ord = spec.field.compare(&a.meta, &b.meta);
            if ord != Ordering::Equal {
                return if spec.desc { ord.reverse() } else { ord };
            }
        }
        a.meta.id.cmp(&b.meta.id)
    });
}

async fn fetch_full_list(core: &Core, cfg: &AppsIndexConfig) -> Result<Vec<AppEntry>, ApiError> {
    let mut spec = GetSpec::new(
        "/ws/v1/cluster/apps",
        TtlPolicy::Fixed(cfg.refresh_after),
        Expect::Json,
    );
    spec.query = Some("deSelects=resourceRequests");
    let served = core.served(&core.rm, &spec).await?;
    let body = served_body(served, cfg.max_body_bytes).await?;
    parse_apps(&body)
}

async fn served_body(served: Served, cap: usize) -> Result<Bytes, ApiError> {
    match served {
        Served::Entry { entry, .. } => {
            if !entry.status.is_success() {
                return Err(ApiError::upstream_status(
                    entry.status,
                    entry.url.clone(),
                    entry.status.as_u16(),
                    "the ResourceManager rejected the application list request",
                ));
            }
            Ok(entry.body.clone())
        }
        Served::Stream { up, .. } => {
            let UpResp {
                status, body, url, ..
            } = *up;
            if !status.is_success() {
                return Err(ApiError::upstream_status(
                    status,
                    url,
                    status.as_u16(),
                    "the ResourceManager rejected the application list request",
                ));
            }
            match body {
                UpBody::Full(bytes) => Ok(bytes),
                UpBody::Stream { prefix, mut rest } => {
                    let mut out = BytesMut::from(&prefix[..]);
                    while let Some(chunk) = rest.next().await {
                        let chunk = chunk.map_err(|e| {
                            ApiError::internal(format!("reading the application list failed: {e}"))
                        })?;
                        if out.len().saturating_add(chunk.len()) > cap {
                            return Err(ApiError::internal(
                                "the ResourceManager application list is too large to index",
                            ));
                        }
                        out.extend_from_slice(&chunk);
                    }
                    Ok(out.freeze())
                }
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowMeta {
    offset: usize,
    limit: usize,
    total: Option<usize>,
    filtered_total: usize,
    ready: bool,
    partial: bool,
    stale: bool,
    version: u64,
    age_ms: u64,
    retry_after_ms: Option<u64>,
    refresh_error: Option<String>,
    facets: Facets,
}

impl WindowMeta {
    fn partial(
        window: &WindowRequest,
        filtered_total: usize,
        retry_after: Option<Duration>,
        facets: Option<Facets>,
    ) -> Self {
        Self {
            offset: window.offset,
            limit: window.limit,
            total: None,
            filtered_total,
            ready: false,
            partial: true,
            stale: false,
            version: 0,
            age_ms: 0,
            retry_after_ms: retry_after.map(|d| d.as_millis().min(u64::MAX as u128) as u64),
            refresh_error: None,
            facets: facets.unwrap_or_default(),
        }
    }
}

fn snapshot_reply(
    window: &WindowRequest,
    snapshot: &Snapshot,
    refresh_after: Duration,
    stale: bool,
    refresh_error: Option<String>,
) -> Reply {
    let mut matched: Vec<&AppEntry> = snapshot
        .apps
        .iter()
        .filter(|entry| window.filters.matches(&entry.meta))
        .collect();
    sort_entries(&mut matched, &window.sort);
    let page = matched
        .iter()
        .skip(window.offset)
        .take(window.limit)
        .map(|entry| entry.raw.as_ref())
        .collect::<Vec<_>>();
    let age = snapshot.fetched_at.elapsed();
    let meta = WindowMeta {
        offset: window.offset,
        limit: window.limit,
        total: Some(snapshot.apps.len()),
        filtered_total: matched.len(),
        ready: true,
        partial: false,
        stale: stale || age >= refresh_after,
        version: snapshot.version,
        age_ms: age.as_millis().min(u64::MAX as u128) as u64,
        retry_after_ms: None,
        refresh_error,
        facets: snapshot.facets.clone(),
    };
    let mut reply = window_reply(page, meta);
    reply.cache = Some(if stale || age >= refresh_after {
        CacheSource::Stale
    } else {
        CacheSource::Hit
    });
    reply
}

fn window_reply(apps: Vec<&RawValue>, meta: WindowMeta) -> Reply {
    #[derive(Serialize)]
    struct AppsBlock<'a> {
        app: Vec<&'a RawValue>,
    }
    #[derive(Serialize)]
    struct Response<'a> {
        apps: Option<AppsBlock<'a>>,
        window: &'a WindowMeta,
    }
    let response = Response {
        apps: if apps.is_empty() {
            None
        } else {
            Some(AppsBlock { app: apps })
        },
        window: &meta,
    };
    let mut reply = Reply::json(&response);
    reply.cache = Some(CacheSource::Miss);
    reply
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::StatusCode;

    fn meta(id: &str) -> AppMeta {
        AppMeta {
            id: id.to_string(),
            user: "alice".into(),
            name: format!("job-{id}"),
            queue: "root.default".into(),
            state: "RUNNING".into(),
            final_status: "UNDEFINED".into(),
            application_type: "SPARK".into(),
            application_tags: "etl, nightly".into(),
            priority: 0.0,
            started_time: 100,
            launch_time: 110,
            finished_time: 0,
            running_containers: 2.0,
            allocated_vcores: 2.0,
            allocated_mb: 1024.0,
            allocated_gpus: -1.0,
            reserved_vcores: 0.0,
            reserved_mb: 0.0,
            reserved_gpus: 0.0,
            queue_usage_percentage: 10.0,
            cluster_usage_percentage: 5.0,
            progress: 50.0,
            tracking_ui: "ApplicationMaster".into(),
        }
    }

    fn entry(id: &str) -> AppEntry {
        AppEntry {
            raw: RawValue::from_string(format!(r#"{{"id":"{id}"}}"#)).unwrap(),
            meta: meta(id),
        }
    }

    #[test]
    fn parses_window_parameters_and_ignores_unknown_sort_columns() {
        let request = WindowRequest::parse(Some(
            "window=1&offset=12&limit=7&sort=unknown,-name&states=RUNNING,ALSO_BAD,ALL&final=failed&user=alice&queue=root.default&type=SPARK&tag=ETL&name=job&startedAfter=1&startedBefore=2&finishedAfter=3&finishedBefore=4",
        ))
        .unwrap();
        assert_eq!(request.offset, 12);
        assert_eq!(request.limit, 7);
        assert_eq!(
            request.sort,
            vec![SortSpec {
                field: SortField::Name,
                desc: true
            }]
        );
        assert_eq!(request.filters.states, vec!["RUNNING"]);
        assert_eq!(request.filters.final_status.as_deref(), Some("FAILED"));
        assert_eq!(request.filters.tag.as_deref(), Some("etl"));
        assert_eq!(request.filters.started_after, Some(1));
        assert_eq!(request.filters.started_before, Some(2));
        assert_eq!(request.filters.finished_after, Some(3));
        assert_eq!(request.filters.finished_before, Some(4));
    }

    #[test]
    fn defaults_and_invalid_parameters() {
        let request = WindowRequest::parse(None).unwrap();
        assert_eq!(request.offset, 0);
        assert_eq!(request.limit, DEFAULT_WINDOW_LIMIT);
        assert_eq!(
            request.sort,
            vec![SortSpec {
                field: SortField::StartTime,
                desc: true
            }]
        );
        assert!(WindowRequest::parse(Some("offset=nope")).is_err());
        assert!(WindowRequest::parse(Some("limit=-1")).is_err());
        for invalid in [
            "startedAfter=nope",
            "startedBefore=nope",
            "finishedAfter=nope",
            "finishedBefore=nope",
        ] {
            assert!(WindowRequest::parse(Some(invalid)).is_err(), "{invalid}");
        }
        assert_eq!(WindowRequest::parse(Some("limit=0")).unwrap().limit, 1);
        assert_eq!(
            WindowRequest::parse(Some("limit=999999")).unwrap().limit,
            MAX_WINDOW_LIMIT
        );
        assert!(parse_sort(Some(",,,")).len() == 1);
    }

    #[test]
    fn every_sort_token_parses_and_unknown_tokens_are_ignored() {
        for (token, field) in [
            ("id", SortField::Id),
            ("user", SortField::User),
            ("name", SortField::Name),
            ("type", SortField::Type),
            ("apptag", SortField::AppTag),
            ("queue", SortField::Queue),
            ("priority", SortField::Priority),
            ("starttime", SortField::StartTime),
            ("IDlaunchtime", SortField::LaunchTime),
            ("finishtime", SortField::FinishTime),
            ("state", SortField::State),
            ("finalstatus", SortField::FinalStatus),
            ("runningcontainer", SortField::RunningContainers),
            ("allocatedCpu", SortField::AllocatedCpu),
            ("allocatedMemory", SortField::AllocatedMemory),
            ("allocatedGpu", SortField::AllocatedGpu),
            ("reservedCpu", SortField::ReservedCpu),
            ("reservedMemory", SortField::ReservedMemory),
            ("reservedGpu", SortField::ReservedGpu),
            ("queuePercentage", SortField::QueuePercentage),
            ("clusterPercentage", SortField::ClusterPercentage),
            ("progress", SortField::Progress),
            ("ui", SortField::Ui),
        ] {
            assert_eq!(SortField::parse(token), Some(field), "{token}");
        }
        assert_eq!(SortField::parse("blacklisted"), None);
    }

    #[test]
    fn preview_query_pushes_down_only_exact_rm_filters() {
        let request = WindowRequest::parse(Some(
            "offset=10&limit=20&states=RUNNING,FINISHED&final=SUCCEEDED&user=alice&queue=q&type=SPARK&tag=etl&name=job&startedAfter=1&startedBefore=2&finishedAfter=3&finishedBefore=4",
        ))
        .unwrap();
        let query = request.preview_query(1_000).unwrap();
        for part in [
            "deSelects=resourceRequests",
            "limit=30",
            "states=RUNNING%2CFINISHED",
            "finalStatus=SUCCEEDED",
            "user=alice",
            "queue=q",
            "applicationTypes=SPARK",
            "applicationTags=etl",
            "startedTimeBegin=1",
            "startedTimeEnd=2",
            "finishedTimeBegin=3",
            "finishedTimeEnd=4",
        ] {
            assert!(query.contains(part), "missing {part} in {query}");
        }
        assert!(!query.contains("name="));
        assert!(request.preview_query(10).is_none());
    }

    #[test]
    fn filters_match_every_field() {
        let app = meta("application_1_1");
        let matching = AppFilters {
            states: vec!["RUNNING".into()],
            final_status: Some("UNDEFINED".into()),
            user: Some("alice".into()),
            queue: Some("root.default".into()),
            application_type: Some("SPARK".into()),
            tag: Some("etl".into()),
            name: Some("JOB-application".into()),
            started_after: Some(100),
            started_before: Some(100),
            finished_after: None,
            finished_before: None,
        };
        assert!(matching.matches(&app));
        assert!(
            !AppFilters {
                states: vec!["FAILED".into()],
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                final_status: Some("FAILED".into()),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                user: Some("bob".into()),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                queue: Some("root.other".into()),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                application_type: Some("MAPREDUCE".into()),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                tag: Some("other".into()),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                name: Some("nope".into()),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            AppFilters {
                name: Some("application_1_1".into()),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                started_after: Some(101),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                started_before: Some(99),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                finished_after: Some(1),
                ..matching.clone()
            }
            .matches(&app)
        );
        assert!(
            !AppFilters {
                finished_before: Some(1),
                ..matching.clone()
            }
            .matches(&AppMeta {
                finished_time: 2,
                ..app.clone()
            })
        );
        assert!(
            AppFilters {
                finished_before: Some(1),
                ..AppFilters::default()
            }
            .matches(&AppMeta {
                finished_time: 0,
                ..app.clone()
            })
        );
    }

    #[test]
    fn preview_total_keeps_the_top_page_exact_and_reserves_deep_offsets() {
        assert_eq!(preview_total(0, 100, 2), 2);
        assert_eq!(preview_total(50, 100, 2), 150);
        assert_eq!(preview_total(usize::MAX, 2, 1), usize::MAX);
    }

    #[test]
    fn sorts_every_column_in_both_directions_and_breaks_ties_by_id() {
        let a = entry("application_1_0001");
        let mut b = entry("application_1_0002");
        b.meta.user = "zzz".into();
        b.meta.name = "zzz".into();
        b.meta.queue = "zzz".into();
        b.meta.state = "zzz".into();
        b.meta.final_status = "zzz".into();
        b.meta.application_type = "zzz".into();
        b.meta.application_tags = "zzz".into();
        b.meta.tracking_ui = "zzz".into();
        b.meta.priority = 9_999.0;
        b.meta.started_time = 9_999;
        b.meta.launch_time = 9_999;
        b.meta.finished_time = 9_999;
        b.meta.running_containers = 9_999.0;
        b.meta.allocated_vcores = 9_999.0;
        b.meta.allocated_mb = 9_999.0;
        b.meta.allocated_gpus = 9_999.0;
        b.meta.reserved_vcores = 9_999.0;
        b.meta.reserved_mb = 9_999.0;
        b.meta.reserved_gpus = 9_999.0;
        b.meta.queue_usage_percentage = 9_999.0;
        b.meta.cluster_usage_percentage = 9_999.0;
        b.meta.progress = 9_999.0;
        let mut entries = vec![&a, &b];
        for field in [
            SortField::Id,
            SortField::User,
            SortField::Name,
            SortField::Type,
            SortField::AppTag,
            SortField::Queue,
            SortField::Priority,
            SortField::StartTime,
            SortField::LaunchTime,
            SortField::FinishTime,
            SortField::State,
            SortField::FinalStatus,
            SortField::RunningContainers,
            SortField::AllocatedCpu,
            SortField::AllocatedMemory,
            SortField::AllocatedGpu,
            SortField::ReservedCpu,
            SortField::ReservedMemory,
            SortField::ReservedGpu,
            SortField::QueuePercentage,
            SortField::ClusterPercentage,
            SortField::Progress,
            SortField::Ui,
        ] {
            sort_entries(&mut entries, &[SortSpec { field, desc: false }]);
            assert_eq!(entries[0].meta.id, "application_1_0001");
            sort_entries(&mut entries, &[SortSpec { field, desc: true }]);
            assert_eq!(entries[0].meta.id, "application_1_0002");
        }
        let mut equal = vec![&a, &b];
        sort_entries(
            &mut equal,
            &[SortSpec {
                field: SortField::User,
                desc: false,
            }],
        );
        assert_eq!(equal[0].meta.id, "application_1_0001");
    }

    #[test]
    fn equal_sort_keys_fall_back_to_the_application_id() {
        let later = entry("application_1_0002");
        let earlier = entry("application_1_0001");
        let mut entries = vec![&later, &earlier];
        sort_entries(
            &mut entries,
            &[SortSpec {
                field: SortField::User,
                desc: false,
            }],
        );
        assert_eq!(entries[0].meta.id, "application_1_0001");
        assert_eq!(entries[1].meta.id, "application_1_0002");
    }

    #[test]
    fn facets_skip_empty_optional_values_and_whitespace_tags() {
        let mut app = entry("application_1_0001");
        app.meta.final_status = String::new();
        app.meta.application_type = String::new();
        app.meta.application_tags = " , ".into();
        let facets = compute_facets(&[app]);
        assert!(facets.by_final.is_empty());
        assert!(facets.types.is_empty());
        assert!(facets.tags.is_empty());
    }

    #[test]
    fn parse_meta_accepts_fractional_timestamps_and_rejects_non_objects() {
        let raw = RawValue::from_string(
            r#"{"id":"application_1_1","startedTime":1.9,"launchTime":null}"#.to_string(),
        )
        .unwrap();
        let parsed = parse_meta(&raw).unwrap();
        assert_eq!(parsed.started_time, 1);
        assert_eq!(parsed.launch_time, 0);
        let raw = RawValue::from_string("[1]".to_string()).unwrap();
        assert!(parse_meta(&raw).is_none());
    }

    #[test]
    fn facets_group_and_sort_counts() {
        let mut a = entry("application_1_0001");
        a.meta.user = "bob".into();
        a.meta.state = "FAILED".into();
        a.meta.final_status = "FAILED".into();
        a.meta.application_tags = "b,a".into();
        a.meta.application_type = "MAPREDUCE".into();
        let b = entry("application_1_0002");
        let facets = compute_facets(&[a, b]);
        assert_eq!(facets.total, 2);
        assert_eq!(facets.by_state["RUNNING"], 1);
        assert_eq!(facets.by_state["FAILED"], 1);
        assert_eq!(facets.by_final["UNDEFINED"], 1);
        assert_eq!(facets.by_final["FAILED"], 1);
        assert_eq!(facets.active, 1);
        assert_eq!(facets.tags.len(), 4);
        assert_eq!(facets.users.len(), 2);
        assert_eq!(facets.queues.len(), 1);
        assert_eq!(facets.types.len(), 2);
        assert_eq!(facets.types[0].count, 1);
    }

    #[test]
    fn parses_null_single_and_malformed_application_lists() {
        assert!(parse_apps(br#"{"apps":null}"#).unwrap().is_empty());
        assert!(parse_apps(br#"{}"#).unwrap().is_empty());
        assert_eq!(
            parse_apps(
                br#"{"apps":{"app":{"id":"application_1_1","user":"a","state":"RUNNING"}}}"#
            )
            .unwrap()
            .len(),
            1
        );
        let entries =
            parse_apps(br#"{"apps":{"app":[{"id":"a"},{"user":"no-id"},[],"nope",{"id":"b"}]}}"#)
                .unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| e.meta.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(parse_apps(b"not json").is_err());
    }

    #[test]
    fn numeric_and_text_helpers_handle_missing_or_nan_values() {
        assert_eq!(num_cmp(f64::NAN, 1.0), Ordering::Equal);
        assert_eq!(text_cmp("ABC", "abc"), Ordering::Equal);
        assert_eq!(SortField::parse("id"), Some(SortField::Id));
        assert_eq!(SortField::parse("nope"), None);
    }

    fn entry_with(status: StatusCode, body: &'static [u8]) -> Served {
        Served::Entry {
            entry: Arc::new(crate::cache::Entry {
                status,
                content_type: None,
                extra: Default::default(),
                body: Bytes::from_static(body),
                etag: String::new(),
                fetched_at: Instant::now(),
                ttl: Duration::from_secs(1),
                served_by: Arc::from("rm"),
                url: "http://rm/ws/v1/cluster/apps".into(),
            }),
            source: CacheSource::Miss,
        }
    }

    #[tokio::test]
    async fn served_body_reads_entries_and_streams_and_rejects_errors() {
        let body = served_body(entry_with(StatusCode::OK, b"hello"), 10)
            .await
            .unwrap();
        assert_eq!(body, Bytes::from_static(b"hello"));
        let err = served_body(entry_with(StatusCode::BAD_GATEWAY, b""), 10)
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_GATEWAY);

        let prefix = Bytes::from_static(b"head");
        let rest = futures_util::stream::iter([
            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"-")),
            Ok(Bytes::from_static(b"tail")),
        ])
        .boxed();
        let body = served_body(
            Served::Stream {
                up: Box::new(UpResp {
                    status: StatusCode::OK,
                    content_type: None,
                    extra: Default::default(),
                    body: UpBody::Stream { prefix, rest },
                    served_by: Arc::from("rm"),
                    url: "http://rm/ws/v1/cluster/apps".into(),
                }),
                source: CacheSource::Miss,
            },
            100,
        )
        .await
        .unwrap();
        assert_eq!(body, Bytes::from_static(b"head-tail"));

        let body = served_body(
            Served::Stream {
                up: Box::new(UpResp {
                    status: StatusCode::OK,
                    content_type: None,
                    extra: Default::default(),
                    body: UpBody::Full(Bytes::from_static(b"full")),
                    served_by: Arc::from("rm"),
                    url: "http://rm/ws/v1/cluster/apps".into(),
                }),
                source: CacheSource::Miss,
            },
            100,
        )
        .await
        .unwrap();
        assert_eq!(body, Bytes::from_static(b"full"));

        let err = served_body(
            Served::Stream {
                up: Box::new(UpResp {
                    status: StatusCode::BAD_GATEWAY,
                    content_type: None,
                    extra: Default::default(),
                    body: UpBody::Full(Bytes::new()),
                    served_by: Arc::from("rm"),
                    url: "http://rm/ws/v1/cluster/apps".into(),
                }),
                source: CacheSource::Miss,
            },
            100,
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_GATEWAY);

        let rest = futures_util::stream::iter([Err::<Bytes, std::io::Error>(
            std::io::Error::other("boom"),
        )])
        .boxed();
        let err = served_body(
            Served::Stream {
                up: Box::new(UpResp {
                    status: StatusCode::OK,
                    content_type: None,
                    extra: Default::default(),
                    body: UpBody::Stream {
                        prefix: Bytes::new(),
                        rest,
                    },
                    served_by: Arc::from("rm"),
                    url: "http://rm/ws/v1/cluster/apps".into(),
                }),
                source: CacheSource::Miss,
            },
            100,
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::INTERNAL_SERVER_ERROR);

        let rest = futures_util::stream::iter([Ok::<Bytes, std::io::Error>(Bytes::from_static(
            b"too-large",
        ))])
        .boxed();
        let err = served_body(
            Served::Stream {
                up: Box::new(UpResp {
                    status: StatusCode::OK,
                    content_type: None,
                    extra: Default::default(),
                    body: UpBody::Stream {
                        prefix: Bytes::new(),
                        rest,
                    },
                    served_by: Arc::from("rm"),
                    url: "http://rm/ws/v1/cluster/apps".into(),
                }),
                source: CacheSource::Miss,
            },
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}
