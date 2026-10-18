//! Server-side offset tailer behind `GET …/files/{name}/stream` (contract §5).
//!
//! The tailer polls the upstream in `[offset, offset+CHUNK)` windows with backoff, emits every newly
//! available window as a `chunk`, and stops when the source can no longer grow (the container is no longer
//! running) with an `eof`, or with an `error` when a cap is hit. It never buffers more than one chunk plus
//! the daemon's page chrome, and it stops as soon as the client goes away (the frame channel closes).

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
    let mut offset = spec.start;
    let mut sent: u64 = 0;
    let mut backoff = IDLE_MIN;
    let deadline = Instant::now() + MAX_DURATION;
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
        if sent >= MAX_BYTES {
            let _ = tx
                .send(TailEvent::Failed {
                    code: "unavailable",
                    message: format!(
                        "the follow stream reached its {} MiB limit",
                        MAX_BYTES / (1024 * 1024)
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
                    let text = String::from_utf8_lossy(&w.text).into_owned();
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
