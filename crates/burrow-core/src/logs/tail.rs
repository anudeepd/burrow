//! Server-side offset tailer behind `GET …/files/{name}/stream` (contract §5).
//!
//! The tailer polls the upstream in `[offset, offset+CHUNK)` windows with backoff, emits every newly
//! available window as a `chunk`, and stops when the source can no longer grow (the container is no longer
//! running) with an `eof`, or with an `error` when a cap is hit. It never buffers more than one chunk plus
//! the daemon's page chrome, and it stops as soon as the client goes away (the frame channel closes).
//!
//! Progress must be proven. A proxy or a default-tail page that ignores `start`/`end` returns the same bytes
//! for every offset; replaying those would append identical lines forever, so a repeated window (or bytes
//! past a page-reported file length) ends the stream instead of becoming a `chunk`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::core::Core;
use crate::logs::source::{self, LogLocation};

/// Bytes read from the upstream per poll.
pub const CHUNK: u64 = 256 * 1024;
/// Total bytes one follow connection may stream.
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Wall-clock cap on one follow connection.
pub const MAX_DURATION: Duration = Duration::from_secs(30 * 60);
/// Backoff between polls while the file is not growing.
const IDLE_MIN: Duration = Duration::from_millis(500);
const IDLE_MAX: Duration = Duration::from_secs(4);

#[derive(Debug)]
pub enum TailEvent {
    Chunk {
        start: u64,
        end: u64,
        text: String,
    },
    Eof,
    Failed {
        code: &'static str,
        message: String,
        hint: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct TailSpec {
    pub location: LogLocation,
    pub file: String,
    pub start: u64,
}

/// One SSE frame per contract §5 (`event: chunk|eof|error`, JSON data).
pub fn frame(ev: TailEvent) -> Bytes {
    match ev {
        TailEvent::Chunk { start, end, text } => {
            let data = serde_json::json!({ "start": start, "end": end, "text": text });
            crate::events::sse_frame("chunk", &data.to_string())
        }
        TailEvent::Eof => crate::events::sse_frame("eof", "{}"),
        TailEvent::Failed {
            code,
            message,
            hint,
        } => {
            let data =
                serde_json::json!({ "error": { "code": code, "message": message, "hint": hint } });
            crate::events::sse_frame("error", &data.to_string())
        }
    }
}

/// Start following `spec`. The returned receiver ends when the tailer finishes (or the client goes away).
pub fn follow(core: Arc<Core>, spec: TailSpec) -> (mpsc::Receiver<TailEvent>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(32);
    let handle = tokio::spawn(async move { run(core, spec, tx).await });
    (rx, handle)
}

async fn run(core: Arc<Core>, spec: TailSpec, tx: mpsc::Sender<TailEvent>) {
    run_with_limits(core, spec, tx, MAX_BYTES, Instant::now() + MAX_DURATION).await;
}

async fn run_with_limits(
    core: Arc<Core>,
    spec: TailSpec,
    tx: mpsc::Sender<TailEvent>,
    max_bytes: u64,
    deadline: Instant,
) {
    let mut offset = spec.start;
    let mut sent: u64 = 0;
    let mut backoff = IDLE_MIN;
    let mut last_window: Option<Bytes> = None;
    loop {
        if Instant::now() >= deadline {
            let _ = tx
                .send(TailEvent::Failed {
                    code: "unavailable",
                    message: format!(
                        "the follow stream reached its {} minute limit",
                        MAX_DURATION.as_secs() / 60
                    ),
                    hint: Some("reconnect to continue from ?offset=".to_string()),
                })
                .await;
            break;
        }
        if sent >= max_bytes {
            let _ = tx
                .send(TailEvent::Failed {
                    code: "unavailable",
                    message: format!(
                        "the follow stream reached its {} MiB limit",
                        max_bytes / (1024 * 1024)
                    ),
                    hint: Some("reconnect to continue from ?offset=".to_string()),
                })
                .await;
            break;
        }
        let end = offset.saturating_add(CHUNK);
        match source::read_window(&core, &spec.location, &spec.file, offset, end).await {
            Ok(w) => {
                if !w.text.is_empty() {
                    let n = w.text.len() as u64;
                    let running = source::container_running(&core, &spec.location).await;
                    // The JobHistoryServer reports the file's exact length and its aggregated file never
                    // grows. Bytes served for a read that starts at or past that length cannot be new
                    // output: the upstream ignored the byte range (a log proxy or a default-tail page does
                    // this). The NodeManager's listing size can lag a container that just stopped, so its
                    // total is left to the repeat check below.
                    if running == Some(false)
                        && matches!(spec.location.kind, source::LogSourceKind::Jhs)
                        && offset >= w.total
                    {
                        let _ = tx.send(TailEvent::Eof).await;
                        break;
                    }
                    // The same window offered again after the offset advanced is the other shape of the same
                    // failure: the source is not honoring the range, so it can never reach a real EOF. A
                    // full-size window from a log that is still running can legitimately repeat (a periodic
                    // log); a short window, or any repeat from a finished container, cannot.
                    let repeated = last_window.as_ref().is_some_and(|last| last == &w.text)
                        && (running == Some(false) || n < end.saturating_sub(offset));
                    if repeated {
                        if running == Some(false) {
                            let _ = tx.send(TailEvent::Eof).await;
                        } else {
                            let _ = tx
                                .send(TailEvent::Failed {
                                    code: "unavailable",
                                    message: "the log source stopped advancing".to_string(),
                                    hint: Some(
                                        "the upstream log page returned the same bytes for a later offset; \
                                         reload the log or download it to read the full file"
                                            .to_string(),
                                    ),
                                })
                                .await;
                        }
                        break;
                    }
                    let text = String::from_utf8_lossy(&w.text).into_owned();
                    last_window = Some(w.text.clone());
                    if tx
                        .send(TailEvent::Chunk {
                            start: offset,
                            end: offset + n,
                            text,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                    offset += n;
                    sent += n;
                    backoff = IDLE_MIN;
                    continue; // there may be more buffered upstream
                }
                // Nothing new. A finished container's file will never grow again.
                if source::container_running(&core, &spec.location).await != Some(true) {
                    let _ = tx.send(TailEvent::Eof).await;
                    break;
                }
            }
            Err(e) => {
                let _ = tx
                    .send(TailEvent::Failed {
                        code: e.code.as_str(),
                        message: e.message,
                        hint: e.hint,
                    })
                    .await;
                break;
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = tx.closed() => break,
        }
        backoff = (backoff * 2).min(IDLE_MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::logs::source::{LogFileEntry, LogSourceKind};

    fn spec() -> TailSpec {
        TailSpec {
            location: LogLocation {
                kind: LogSourceKind::Nm,
                base_path: "/node/containerlogs/container_1_2_1_1/user".into(),
                node: Some("127.0.0.1:8042".into()),
                upstream_url: None,
                user: "alice".into(),
                container_id: "container_1_2_1_1".into(),
                files: vec![LogFileEntry {
                    name: "stdout".into(),
                    size: 0,
                    last_modified: None,
                }],
            },
            file: "stdout".into(),
            start: 0,
        }
    }

    #[tokio::test]
    async fn tail_frames_encode_chunks_eof_and_errors() {
        let chunk = frame(TailEvent::Chunk {
            start: 4,
            end: 8,
            text: "data".into(),
        });
        let chunk = String::from_utf8(chunk.to_vec()).unwrap();
        assert!(chunk.starts_with("event: chunk\n"));
        assert!(chunk.contains("\"start\":4"));

        assert_eq!(frame(TailEvent::Eof), "event: eof\ndata: {}\n\n");
        let failed = frame(TailEvent::Failed {
            code: "unavailable",
            message: "stopped".into(),
            hint: Some("retry".into()),
        });
        let failed = String::from_utf8(failed.to_vec()).unwrap();
        assert!(failed.starts_with("event: error\n"));
        assert!(failed.contains("\"hint\":\"retry\""));
    }

    #[tokio::test]
    async fn tail_limits_and_source_errors_finish_the_receiver() {
        let cfg = Config::for_rm("http://127.0.0.1:0").unwrap();
        let core = Core::new(cfg).unwrap();

        let (tx, mut rx) = mpsc::channel(1);
        run_with_limits(
            core.clone(),
            spec(),
            tx,
            MAX_BYTES,
            Instant::now() - Duration::from_millis(1),
        )
        .await;
        assert!(
            matches!(rx.recv().await, Some(TailEvent::Failed { message, .. }) if message.contains("minute limit"))
        );

        let (tx, mut rx) = mpsc::channel(1);
        run_with_limits(
            core.clone(),
            spec(),
            tx,
            0,
            Instant::now() + Duration::from_secs(1),
        )
        .await;
        assert!(
            matches!(rx.recv().await, Some(TailEvent::Failed { message, .. }) if message.contains("0 MiB limit"))
        );

        let (tx, mut rx) = mpsc::channel(1);
        run_with_limits(
            core,
            spec(),
            tx,
            MAX_BYTES,
            Instant::now() + Duration::from_secs(1),
        )
        .await;
        assert!(matches!(rx.recv().await, Some(TailEvent::Failed { .. })));
        assert!(rx.recv().await.is_none());
    }
}
