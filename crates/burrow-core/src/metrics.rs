//! Process-wide runtime counters behind `GET /api/system` (contract §2.1).
//!
//! One [`Metrics`] per [`crate::core::Core`]. The HTTP layer records every response through the middleware in
//! `burrow::app`, the SSE hub supplies live stream connections, and the cache supplies its own counters. This
//! module owns only in-memory history: nothing here is persisted or exported.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;

/// How long a client identity stays "active" after its last request.
pub const CLIENT_WINDOW: Duration = Duration::from_secs(300);
/// Rolling latency window (contract: the last 512 non-streaming responses).
const DURATION_RING: usize = 512;
/// Minute buckets retained; persistence is only needed for the last 15, the rest are slack for late records.
const MINUTE_BUCKETS: usize = 30;
/// History length in one-minute buckets.
const HISTORY_MINUTES: usize = 15;
/// Memory samples older than this are dropped.
const MEMORY_WINDOW_MS: u64 = 15 * 60 * 1000;
/// At most one memory sample per this interval.
const MEMORY_SAMPLE_EVERY: Duration = Duration::from_secs(5);
/// Recent failures retained, newest first.
const FAILURE_RING: usize = 20;
/// Stored failure paths are capped so a hostile URL cannot grow the ring without bound.
const PATH_MAX_CHARS: usize = 200;

const MINUTE_MS: u64 = 60_000;

/// One memory reading: resident set and virtual memory, both in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryInfo {
    pub rss_bytes: u64,
    pub virtual_bytes: u64,
}

/// A request-tracking guard: dropping it decrements the in-flight count.
pub struct InFlightGuard {
    in_flight: Arc<AtomicUsize>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

struct MinuteBucket {
    at_ms: u64,
    requests: u64,
    /// 5xx only: a 4xx is the caller's bad request, not a Burrow failure.
    errors: u64,
}

struct MemorySample {
    at_ms: u64,
    rss_bytes: u64,
}

struct Failure {
    at_ms: u64,
    method: String,
    path: String,
    status: u16,
    duration_ms: u64,
}

struct Inner {
    started: Instant,
    started_at_ms: u64,
    total: u64,
    by_status: [u64; 5],
    durations: VecDeque<u64>,
    minutes: VecDeque<MinuteBucket>,
    memory_history: VecDeque<MemorySample>,
    last_memory_at: Option<Instant>,
    peak_rss: Option<u64>,
    clients: HashMap<String, Instant>,
    failures: VecDeque<Failure>,
}

pub struct Metrics {
    inner: Mutex<Inner>,
    in_flight: Arc<AtomicUsize>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        Self::new_at(Instant::now(), now_ms())
    }

    /// Deterministic constructor for tests.
    fn new_at(started: Instant, started_at_ms: u64) -> Self {
        Self {
            inner: Mutex::new(Inner {
                started,
                started_at_ms,
                total: 0,
                by_status: [0; 5],
                durations: VecDeque::new(),
                minutes: VecDeque::new(),
                memory_history: VecDeque::new(),
                last_memory_at: None,
                peak_rss: None,
                clients: HashMap::new(),
                failures: VecDeque::new(),
            }),
            in_flight: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Marks one request in flight; the returned guard decrements the count when dropped.
    pub fn in_flight(&self) -> InFlightGuard {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        InFlightGuard {
            in_flight: self.in_flight.clone(),
        }
    }

    pub fn record_request(
        &self,
        method: &str,
        path: &str,
        status: u16,
        duration: Duration,
        is_stream: bool,
    ) {
        self.record_request_at(now_ms(), method, path, status, duration, is_stream);
    }

    fn record_request_at(
        &self,
        at_ms: u64,
        method: &str,
        path: &str,
        status: u16,
        duration: Duration,
        is_stream: bool,
    ) {
        let duration_ms = duration.as_millis() as u64;
        let mut inner = self.inner.lock();
        inner.total += 1;
        let class = status as usize / 100;
        if (1..=inner.by_status.len()).contains(&class) {
            inner.by_status[class - 1] += 1;
        }
        if !is_stream {
            inner.durations.push_back(duration_ms);
            if inner.durations.len() > DURATION_RING {
                inner.durations.pop_front();
            }
        }

        let minute = at_ms / MINUTE_MS * MINUTE_MS;
        match inner.minutes.iter().position(|b| b.at_ms == minute) {
            Some(i) => {
                inner.minutes[i].requests += 1;
                if status >= 500 {
                    inner.minutes[i].errors += 1;
                }
            }
            None => {
                inner.minutes.push_back(MinuteBucket {
                    at_ms: minute,
                    requests: 1,
                    errors: u64::from(status >= 500),
                });
                inner.minutes.make_contiguous().sort_by_key(|b| b.at_ms);
                while inner.minutes.len() > MINUTE_BUCKETS {
                    inner.minutes.pop_front();
                }
            }
        }

        if status >= 400 {
            inner.failures.push_back(Failure {
                at_ms,
                method: method.to_string(),
                path: path.chars().take(PATH_MAX_CHARS).collect(),
                status,
                duration_ms,
            });
            while inner.failures.len() > FAILURE_RING {
                inner.failures.pop_front();
            }
        }
    }

    pub fn record_client(&self, id: &str) {
        self.record_client_at(id, Instant::now());
    }

    fn record_client_at(&self, id: &str, at: Instant) {
        self.inner.lock().clients.insert(id.to_string(), at);
    }

    pub fn snapshot(&self) -> SystemSnapshot {
        let memory = memory_stats::memory_stats().map(|m| MemoryInfo {
            rss_bytes: m.physical_mem as u64,
            virtual_bytes: m.virtual_mem as u64,
        });
        self.snapshot_at(Instant::now(), now_ms(), memory)
    }

    fn snapshot_at(&self, now: Instant, now_ms: u64, memory: Option<MemoryInfo>) -> SystemSnapshot {
        let mut inner = self.inner.lock();
        inner
            .clients
            .retain(|_, seen| now.saturating_duration_since(*seen) <= CLIENT_WINDOW);

        if let Some(m) = memory {
            if inner
                .last_memory_at
                .is_none_or(|last| now.saturating_duration_since(last) >= MEMORY_SAMPLE_EVERY)
            {
                inner.memory_history.push_back(MemorySample {
                    at_ms: now_ms,
                    rss_bytes: m.rss_bytes,
                });
                inner.last_memory_at = Some(now);
                while inner
                    .memory_history
                    .front()
                    .is_some_and(|s| now_ms.saturating_sub(s.at_ms) > MEMORY_WINDOW_MS)
                {
                    inner.memory_history.pop_front();
                }
            }
            inner.peak_rss = Some(inner.peak_rss.map_or(m.rss_bytes, |p| p.max(m.rss_bytes)));
        }

        let history = history_at(&inner.minutes, now_ms);
        let errors_last_15m = history.iter().map(|h| h.errors).sum();

        let mut durations: Vec<u64> = inner.durations.iter().copied().collect();
        durations.sort_unstable();

        let memory_history = inner
            .memory_history
            .iter()
            .map(|s| MemoryPoint {
                at_ms: s.at_ms,
                rss_bytes: s.rss_bytes,
            })
            .collect();
        let recent_errors = inner
            .failures
            .iter()
            .rev()
            .map(|f| RecentError {
                at_ms: f.at_ms,
                method: f.method.clone(),
                path: f.path.clone(),
                status: f.status,
                duration_ms: f.duration_ms,
            })
            .collect();
        let active = inner.clients.len();
        let in_flight = self.in_flight.load(Ordering::Relaxed);

        SystemSnapshot {
            process: ProcessSnapshot {
                version: env!("CARGO_PKG_VERSION"),
                pid: std::process::id(),
                uptime_seconds: now.saturating_duration_since(inner.started).as_secs(),
                started_at_ms: inner.started_at_ms,
                memory: MemorySnapshot {
                    rss_bytes: memory.map(|m| m.rss_bytes),
                    peak_rss_bytes: inner.peak_rss,
                    virtual_bytes: memory.map(|m| m.virtual_bytes),
                },
            },
            clients: ClientsSnapshot {
                active,
                streams: 0,
                window_seconds: CLIENT_WINDOW.as_secs(),
            },
            requests: RequestsSnapshot {
                total: inner.total,
                in_flight,
                by_status: StatusCounts {
                    one_xx: inner.by_status[0],
                    two_xx: inner.by_status[1],
                    three_xx: inner.by_status[2],
                    four_xx: inner.by_status[3],
                    five_xx: inner.by_status[4],
                },
                errors_last_15m,
                p50_ms: percentile(&durations, 50),
                p95_ms: percentile(&durations, 95),
                history,
            },
            memory_history,
            recent_errors,
        }
    }
}

/// The 15 most recent one-minute buckets, oldest first, with empty minutes filled in.
fn history_at(minutes: &VecDeque<MinuteBucket>, now_ms: u64) -> Vec<HistoryPoint> {
    let current = now_ms / MINUTE_MS * MINUTE_MS;
    let first = current.saturating_sub((HISTORY_MINUTES as u64 - 1) * MINUTE_MS);
    (0..HISTORY_MINUTES as u64)
        .map(|i| {
            let at_ms = first + i * MINUTE_MS;
            let bucket = minutes.iter().find(|b| b.at_ms == at_ms);
            HistoryPoint {
                at_ms,
                requests: bucket.map_or(0, |b| b.requests),
                errors: bucket.map_or(0, |b| b.errors),
            }
        })
        .collect()
}

/// Nearest-rank percentile over an ascending slice.
fn percentile(sorted: &[u64], p: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p * sorted.len()).div_ceil(100);
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize)]
pub struct SystemSnapshot {
    pub process: ProcessSnapshot,
    pub clients: ClientsSnapshot,
    pub requests: RequestsSnapshot,
    #[serde(rename = "memoryHistory")]
    pub memory_history: Vec<MemoryPoint>,
    #[serde(rename = "recentErrors")]
    pub recent_errors: Vec<RecentError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub version: &'static str,
    pub pid: u32,
    pub uptime_seconds: u64,
    pub started_at_ms: u64,
    pub memory: MemorySnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub rss_bytes: Option<u64>,
    pub peak_rss_bytes: Option<u64>,
    pub virtual_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientsSnapshot {
    pub active: usize,
    pub streams: usize,
    pub window_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestsSnapshot {
    pub total: u64,
    pub in_flight: usize,
    pub by_status: StatusCounts,
    pub errors_last_15m: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub history: Vec<HistoryPoint>,
}

#[derive(Debug, Serialize)]
pub struct StatusCounts {
    #[serde(rename = "1xx")]
    pub one_xx: u64,
    #[serde(rename = "2xx")]
    pub two_xx: u64,
    #[serde(rename = "3xx")]
    pub three_xx: u64,
    #[serde(rename = "4xx")]
    pub four_xx: u64,
    #[serde(rename = "5xx")]
    pub five_xx: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub at_ms: u64,
    pub requests: u64,
    pub errors: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPoint {
    pub at_ms: u64,
    pub rss_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentError {
    pub at_ms: u64,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics() -> Metrics {
        Metrics::new_at(Instant::now(), 1_000)
    }

    #[test]
    fn status_classes_count_every_response() {
        let m = metrics();
        m.record_request("GET", "/a", 100, Duration::from_millis(1), false);
        m.record_request("GET", "/a", 204, Duration::from_millis(1), false);
        m.record_request("GET", "/a", 304, Duration::from_millis(1), false);
        m.record_request("GET", "/a", 404, Duration::from_millis(1), false);
        m.record_request("GET", "/a", 502, Duration::from_millis(1), false);

        let snapshot = m.snapshot_at(Instant::now(), now_ms(), None);
        assert_eq!(snapshot.requests.total, 5);
        assert_eq!(
            [
                snapshot.requests.by_status.one_xx,
                snapshot.requests.by_status.two_xx,
                snapshot.requests.by_status.three_xx,
                snapshot.requests.by_status.four_xx,
                snapshot.requests.by_status.five_xx,
            ],
            [1, 1, 1, 1, 1]
        );
    }

    #[test]
    fn errors_last_15m_counts_server_failures_only() {
        let m = metrics();
        m.record_request("GET", "/missing", 404, Duration::from_millis(3), false);
        m.record_request("GET", "/api/apps", 502, Duration::from_millis(12), false);

        let snapshot = m.snapshot_at(Instant::now(), now_ms(), None);
        assert_eq!(snapshot.requests.by_status.four_xx, 1);
        assert_eq!(snapshot.requests.by_status.five_xx, 1);
        assert_eq!(snapshot.requests.errors_last_15m, 1);
        assert_eq!(snapshot.recent_errors.len(), 2);
        assert_eq!(snapshot.recent_errors[0].status, 502);
        assert_eq!(snapshot.recent_errors[1].status, 404);
    }

    #[test]
    fn history_fills_empty_minutes_oldest_first() {
        let m = metrics();
        let minute = 1_700_000_000_000 / MINUTE_MS * MINUTE_MS;
        m.record_request_at(minute, "GET", "/a", 200, Duration::from_millis(1), false);
        m.record_request_at(minute, "GET", "/a", 500, Duration::from_millis(1), false);

        let snapshot = m.snapshot_at(Instant::now(), minute + 3 * MINUTE_MS, None);
        let history = &snapshot.requests.history;
        assert_eq!(history.len(), 15);
        assert_eq!(history[0].at_ms, minute - 11 * MINUTE_MS);
        assert_eq!(history[14].at_ms, minute + 3 * MINUTE_MS);
        assert_eq!(history[11].requests, 2);
        assert_eq!(history[11].errors, 1);
        assert_eq!(history[12].requests, 0);
        assert_eq!(snapshot.requests.errors_last_15m, 1);
    }

    #[test]
    fn minute_buckets_are_bounded_and_history_keeps_the_newest() {
        let m = metrics();
        let base = 1_700_000_000_000 / MINUTE_MS * MINUTE_MS;
        for i in 0..31 {
            m.record_request_at(
                base + i * MINUTE_MS,
                "GET",
                "/a",
                200,
                Duration::from_millis(1),
                false,
            );
        }

        let snapshot = m.snapshot_at(Instant::now(), base + 30 * MINUTE_MS, None);
        let history = &snapshot.requests.history;
        assert_eq!(history.len(), 15);
        assert_eq!(history[0].at_ms, base + 16 * MINUTE_MS);
        assert!(history.iter().all(|h| h.requests == 1));
    }

    #[test]
    fn percentiles_use_nearest_rank() {
        let m = metrics();
        for ms in 1..=100 {
            m.record_request("GET", "/a", 200, Duration::from_millis(ms), false);
        }
        let snapshot = m.snapshot_at(Instant::now(), now_ms(), None);
        assert_eq!(snapshot.requests.p50_ms, 50);
        assert_eq!(snapshot.requests.p95_ms, 95);

        let empty = metrics();
        let snapshot = empty.snapshot_at(Instant::now(), now_ms(), None);
        assert_eq!(snapshot.requests.p50_ms, 0);
        assert_eq!(snapshot.requests.p95_ms, 0);
    }

    #[test]
    fn duration_ring_keeps_the_newest_512() {
        let m = metrics();
        for ms in 1..=DURATION_RING as u64 + 1 {
            m.record_request("GET", "/a", 200, Duration::from_millis(ms), false);
        }

        let snapshot = m.snapshot_at(Instant::now(), now_ms(), None);
        assert_eq!(snapshot.requests.p50_ms, 257);
        assert_eq!(snapshot.requests.p95_ms, 488);
    }

    #[test]
    fn streams_are_counted_but_excluded_from_latency() {
        let m = metrics();
        m.record_request("GET", "/fast", 200, Duration::from_millis(3), false);
        m.record_request("GET", "/events", 200, Duration::from_secs(60), true);

        let snapshot = m.snapshot_at(Instant::now(), now_ms(), None);
        assert_eq!(snapshot.requests.total, 2);
        assert_eq!(snapshot.requests.p50_ms, 3);
        assert_eq!(snapshot.requests.p95_ms, 3);
    }

    #[test]
    fn clients_prune_at_the_window_boundary() {
        let m = metrics();
        let now = Instant::now();
        m.record_client_at("a", now);

        let kept = m.snapshot_at(now + CLIENT_WINDOW, now_ms(), None);
        assert_eq!(kept.clients.active, 1);
        assert_eq!(kept.clients.window_seconds, 300);

        let pruned = m.snapshot_at(
            now + CLIENT_WINDOW + Duration::from_millis(1),
            now_ms(),
            None,
        );
        assert_eq!(pruned.clients.active, 0);
    }

    #[test]
    fn failures_keep_the_newest_twenty_and_truncate_paths() {
        let m = metrics();
        let long_path = "x".repeat(250);
        for i in 0..25 {
            m.record_request(
                "GET",
                &long_path,
                500 + i % 10,
                Duration::from_millis(1),
                false,
            );
        }
        let snapshot = m.snapshot_at(Instant::now(), now_ms(), None);
        assert_eq!(snapshot.recent_errors.len(), 20);
        assert_eq!(snapshot.recent_errors[0].path.len(), PATH_MAX_CHARS);
        assert_eq!(snapshot.recent_errors[0].status, 504);
        assert_eq!(snapshot.recent_errors[19].status, 505);
    }

    #[test]
    fn memory_samples_throttle_prune_and_track_the_peak() {
        let m = metrics();
        let now = Instant::now();
        let at = 1_700_000_000_000;

        let first = m.snapshot_at(
            now,
            at,
            Some(MemoryInfo {
                rss_bytes: 100,
                virtual_bytes: 200,
            }),
        );
        assert_eq!(first.process.memory.rss_bytes, Some(100));
        assert_eq!(first.process.memory.peak_rss_bytes, Some(100));
        assert_eq!(first.process.memory.virtual_bytes, Some(200));
        assert_eq!(first.memory_history.len(), 1);

        let throttled = m.snapshot_at(
            now + Duration::from_secs(1),
            at + 1_000,
            Some(MemoryInfo {
                rss_bytes: 80,
                virtual_bytes: 200,
            }),
        );
        assert_eq!(throttled.process.memory.rss_bytes, Some(80));
        assert_eq!(throttled.process.memory.peak_rss_bytes, Some(100));
        assert_eq!(throttled.memory_history.len(), 1);

        let sampled = m.snapshot_at(
            now + MEMORY_SAMPLE_EVERY,
            at + 5_000,
            Some(MemoryInfo {
                rss_bytes: 150,
                virtual_bytes: 300,
            }),
        );
        assert_eq!(sampled.process.memory.peak_rss_bytes, Some(150));
        assert_eq!(sampled.memory_history.len(), 2);

        let pruned = m.snapshot_at(
            now + Duration::from_secs(16 * 60),
            at + MEMORY_WINDOW_MS + 60_000,
            Some(MemoryInfo {
                rss_bytes: 120,
                virtual_bytes: 300,
            }),
        );
        assert_eq!(pruned.memory_history.len(), 1);
        assert_eq!(pruned.memory_history[0].rss_bytes, 120);
    }

    #[test]
    fn empty_snapshot_reports_zeroes_and_no_memory() {
        let m = Metrics::default();
        let snapshot = m.snapshot_at(Instant::now(), now_ms(), None);

        assert_eq!(snapshot.process.version, "0.2.3");
        assert_eq!(snapshot.process.pid, std::process::id());
        assert!(snapshot.process.started_at_ms > 0);
        assert_eq!(snapshot.process.memory.rss_bytes, None);
        assert_eq!(snapshot.process.memory.peak_rss_bytes, None);
        assert_eq!(snapshot.process.memory.virtual_bytes, None);
        assert_eq!(snapshot.clients.active, 0);
        assert_eq!(snapshot.clients.streams, 0);
        assert_eq!(snapshot.requests.total, 0);
        assert_eq!(snapshot.requests.in_flight, 0);
        assert_eq!(snapshot.requests.history.len(), 15);
        assert!(snapshot.requests.history.iter().all(|h| h.requests == 0));
        assert!(snapshot.memory_history.is_empty());
        assert!(snapshot.recent_errors.is_empty());
    }

    #[test]
    fn in_flight_guard_counts_up_and_down() {
        let m = metrics();
        assert_eq!(
            m.snapshot_at(Instant::now(), now_ms(), None)
                .requests
                .in_flight,
            0
        );
        let guard = m.in_flight();
        assert_eq!(
            m.snapshot_at(Instant::now(), now_ms(), None)
                .requests
                .in_flight,
            1
        );
        drop(guard);
        assert_eq!(
            m.snapshot_at(Instant::now(), now_ms(), None)
                .requests
                .in_flight,
            0
        );
    }

    #[test]
    fn uptime_uses_the_injected_start() {
        let now = Instant::now();
        let m = Metrics::new_at(now - Duration::from_secs(42), 7);
        let snapshot = m.snapshot_at(now, now_ms(), None);
        assert_eq!(snapshot.process.uptime_seconds, 42);
    }
}
