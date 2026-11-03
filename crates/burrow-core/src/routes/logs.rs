//! `GET /api/logs/*` — container logs (contract §5).
//!
//! * `containers/{containerId}?node&user&app` — synthesized JSON listing: which daemon serves the logs and
//!   the files it has (see [`crate::logs`]).
//! * `containers/{containerId}/files/{name}?offset&length&tail` — a byte window as `text/plain`, with the
//!   `x-burrow-log-*` headers. Never cached; the upstream page is parsed, never forwarded.
//! * `containers/{containerId}/files/{name}/stream?offset` — a server-side offset tailer as
//!   `text/event-stream` (`event: chunk|eof|error`).

use bytes::Bytes;
use futures_util::stream::{self, BoxStream, StreamExt};
use http::StatusCode;
use http::header::{HeaderMap, HeaderName, HeaderValue};

use crate::api::{ApiRequest, GroupFut};
use crate::cache::{CacheSource, weak_etag};
use crate::core::Core;
use crate::error::ApiError;
use crate::logs::{self, LogQuery, tail};
use crate::reply::{JSON_CT, Reply, ReplyBody, TEXT_CT};
use crate::routes::events::EVENT_STREAM_CT;
use crate::routes::table::{is_safe_segment, query_param};

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    let segs: Vec<&str> = req.path.split('/').collect();
    match segs.as_slice() {
        ["containers", cid] => listing(core, &req, cid).await,
        ["containers", cid, "files", name] => read(core, &req, cid, name).await,
        ["containers", cid, "files", name, "stream"] => stream(core, &req, cid, name).await,
        _ => Err(
            ApiError::not_found(format!("'/api/logs/{}' does not exist", req.path))
                .with_hint("try /api/logs/containers/{containerId}[/files/{name}[/stream]]"),
        ),
    }
}

fn hints(req: &ApiRequest<'_>) -> (Option<String>, Option<String>, Option<String>) {
    (
        query_param(req.query, "node"),
        query_param(req.query, "user"),
        query_param(req.query, "app"),
    )
}

async fn resolve(core: &Core, req: &ApiRequest<'_>, cid: &str) -> Result<logs::Resolved, ApiError> {
    if !logs::source::is_container_id(cid) {
        return Err(ApiError::bad_request(format!(
            "'{cid}' is not a container id"
        )));
    }
    let (node, user, app) = hints(req);
    logs::resolve(
        core,
        &LogQuery {
            container_id: cid,
            node: node.as_deref(),
            user: user.as_deref(),
            app: app.as_deref(),
        },
    )
    .await
}

async fn listing(core: &Core, req: &ApiRequest<'_>, cid: &str) -> Result<Reply, ApiError> {
    let resolved = resolve(core, req, cid).await?;
    let body = Bytes::from(
        serde_json::to_vec(&serde_json::json!({
            "source": resolved.location.source(),
            "node": resolved.location.node,
            "files": resolved.location.files,
        }))
        .expect("listing serialises"),
    );
    Ok(Reply {
        status: StatusCode::OK,
        content_type: Some(HeaderValue::from_static(JSON_CT)),
        extra: HeaderMap::new(),
        etag: Some(weak_etag(&body)),
        body: ReplyBody::Bytes(body),
        cache: Some(resolved.cache),
        upstream: resolved.upstream,
        age_ms: Some(resolved.age_ms),
    })
}

async fn read(core: &Core, req: &ApiRequest<'_>, cid: &str, name: &str) -> Result<Reply, ApiError> {
    let name = safe_file_name(name)?;
    // Validate the requested window before resolving sources, which may fetch the RM and NM.
    let offset = number(req, "offset")?;
    let length = number(req, "length")?;
    let tail = number(req, "tail")?;
    logs::window(0, offset, length, tail)?;
    let resolved = resolve(core, req, cid).await?;
    let loc = &resolved.location;
    let entry = loc
        .file(name)
        .ok_or_else(|| missing_file_error(loc, name, cid))?
        .clone();

    let (start, end) = logs::window(entry.size, offset, length, tail)?;

    let window = logs::source::read_window(core, loc, name, start, end).await?;
    let ended = query_param(req.query, "follow").as_deref() == Some("1")
        && logs::source::container_running(core, loc).await == Some(false);
    let mut extra = HeaderMap::new();
    let mut put = |k: &'static str, v: String| {
        if let Ok(value) = HeaderValue::from_str(&v) {
            extra.insert(HeaderName::from_static(k), value);
        }
    };
    put("x-burrow-log-size", window.total.to_string());
    put("x-burrow-log-start", window.start.to_string());
    put("x-burrow-log-end", window.end.to_string());
    put("x-burrow-log-source", loc.source().to_string());
    if ended {
        put("x-burrow-log-ended", "true".to_string());
    }

    Ok(Reply {
        status: StatusCode::OK,
        content_type: Some(HeaderValue::from_static(TEXT_CT)),
        extra,
        body: ReplyBody::Bytes(window.text),
        cache: Some(CacheSource::Bypass),
        upstream: None,
        age_ms: None,
        etag: None,
    })
}

async fn stream(
    core: &Core,
    req: &ApiRequest<'_>,
    cid: &str,
    name: &str,
) -> Result<Reply, ApiError> {
    let name = safe_file_name(name)?;
    let offset = number(req, "offset")?.unwrap_or(0);
    let resolved = resolve(core, req, cid).await?;
    let loc = resolved.location;
    require_file(&loc, name, cid)?;
    let shared = core.shared();
    let (rx, _handle) = tail::follow(
        shared,
        tail::TailSpec {
            location: loc,
            file: name.to_string(),
            start: offset,
        },
    );
    let rest = tail_stream(rx);
    Ok(Reply {
        status: StatusCode::OK,
        content_type: Some(HeaderValue::from_static(EVENT_STREAM_CT)),
        extra: HeaderMap::new(),
        body: ReplyBody::Stream {
            prefix: Bytes::new(),
            rest,
        },
        cache: Some(CacheSource::Bypass),
        upstream: None,
        age_ms: None,
        etag: None,
    })
}

fn missing_file_error(loc: &logs::source::LogLocation, name: &str, cid: &str) -> ApiError {
    ApiError::not_found(format!("'{name}' is not a log file of {cid}")).with_hint(format!(
        "{} lists: {}",
        loc.source(),
        loc.files
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn require_file(loc: &logs::source::LogLocation, name: &str, cid: &str) -> Result<(), ApiError> {
    if loc.file(name).is_some() {
        Ok(())
    } else {
        Err(missing_file_error(loc, name, cid))
    }
}

fn tail_stream(
    rx: tokio::sync::mpsc::Receiver<tail::TailEvent>,
) -> BoxStream<'static, std::io::Result<Bytes>> {
    stream::unfold(Some(rx), |state| async move {
        let mut rx = state?;
        match rx.recv().await {
            Some(ev) => {
                let done = matches!(ev, tail::TailEvent::Eof | tail::TailEvent::Failed { .. });
                let frame = tail::frame(ev);
                Some((Ok(frame), if done { None } else { Some(rx) }))
            }
            None => None,
        }
    })
    .boxed()
}

/// A non-negative integer query parameter (`?offset=`, `?length=`, `?tail=`).
fn number(req: &ApiRequest<'_>, name: &str) -> Result<Option<u64>, ApiError> {
    match query_param(req.query, name) {
        None => Ok(None),
        Some(v) => v
            .parse::<u64>()
            .map(Some)
            .map_err(|_| ApiError::bad_request(format!("'{name}' must be a non-negative integer"))),
    }
}

/// Log file names are path segments: the route table's id class minus dot-only values, so a name can never
/// walk out of the container's log directory.
fn safe_file_name(name: &str) -> Result<&str, ApiError> {
    if !is_safe_segment(name) {
        return Err(ApiError::bad_request(format!(
            "'{name}' is not a log file name"
        )));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> std::sync::Arc<Core> {
        Core::new(crate::config::Config::for_rm("http://127.0.0.1:8088").unwrap()).unwrap()
    }

    #[tokio::test]
    async fn route_rejects_unknown_paths_and_container_ids() {
        let core = core();
        let unknown = get(&core, ApiRequest::new("unknown")).await.err().unwrap();
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);

        let invalid = get(&core, ApiRequest::new("containers/not-a-container"))
            .await
            .err()
            .unwrap();
        assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
        assert!(invalid.message.contains("is not a container id"));
    }

    #[test]
    fn file_names_and_numeric_windows_are_validated() {
        let invalid_name = safe_file_name("..").err().unwrap();
        assert_eq!(invalid_name.status, StatusCode::BAD_REQUEST);

        let invalid_number = number(
            &ApiRequest {
                query: Some("offset=abc"),
                ..ApiRequest::new("")
            },
            "offset",
        )
        .err()
        .unwrap();
        assert_eq!(invalid_number.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn missing_log_files_include_the_available_source_hint() {
        let location = logs::source::LogLocation {
            kind: logs::source::LogSourceKind::Nm,
            base_path: "/containerlogs/container_1_2_3/user/".into(),
            node: Some("nm:8042".into()),
            upstream_url: None,
            user: "user".into(),
            container_id: "container_1_2_3".into(),
            files: vec![logs::source::LogFileEntry {
                name: "stderr".into(),
                size: 0,
                last_modified: None,
            }],
        };
        let error = require_file(&location, "stdout", "container_1_2_3")
            .err()
            .unwrap();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert!(error.hint.unwrap().contains("stderr"));
        require_file(&location, "stderr", "container_1_2_3").unwrap();
    }

    #[tokio::test]
    async fn tail_stream_finishes_when_the_tail_channel_closes() {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        drop(tx);
        assert!(tail_stream(rx).next().await.is_none());
    }
}
