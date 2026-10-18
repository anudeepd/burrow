//! [`Reply`]: what the core hands to the HTTP layer. Transport-agnostic (no axum types).
//!
//! Conversions that protect the browser live here:
//! * non-2xx **HTML** from an upstream becomes the JSON error envelope (status unchanged);
//! * 2xx HTML is never forwarded as HTML (always `text/plain`), so an upstream page cannot execute
//!   script on our origin;
//! * only `content-type`, `content-range`, `accept-ranges` survive from the upstream response.

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use http::StatusCode;
use http::header::{HeaderMap, HeaderValue};
use serde::Serialize;

use crate::cache::{CacheSource, Expect, Served, etag_matches};
use crate::error::{ApiError, ErrorCode, UpstreamInfo};
use crate::html::{html_error_message, looks_like_html};
use crate::http::{UpBody, UpResp};

pub const JSON_CT: &str = "application/json";
pub const TEXT_CT: &str = "text/plain; charset=utf-8";

pub enum ReplyBody {
    Bytes(Bytes),
    Stream {
        prefix: Bytes,
        rest: BoxStream<'static, std::io::Result<Bytes>>,
    },
}

pub struct Reply {
    pub status: StatusCode,
    pub content_type: Option<HeaderValue>,
    pub extra: HeaderMap,
    pub body: ReplyBody,
    pub cache: Option<CacheSource>,
    /// `host:port` that served a miss (`x-burrow-upstream`); `None` for hits and stale.
    pub upstream: Option<String>,
    pub age_ms: Option<u64>,
    /// Weak ETag; only set for 2xx cached bodies.
    pub etag: Option<String>,
}

impl Reply {
    pub fn synthesized(
        status: StatusCode,
        content_type: &'static str,
        body: impl Into<Bytes>,
    ) -> Self {
        Self {
            status,
            content_type: Some(HeaderValue::from_static(content_type)),
            extra: HeaderMap::new(),
            body: ReplyBody::Bytes(body.into()),
            cache: None,
            upstream: None,
            age_ms: None,
            etag: None,
        }
    }

    pub fn json<T: Serialize>(value: &T) -> Self {
        let bytes = serde_json::to_vec(value).expect("reply serialises");
        Self::synthesized(StatusCode::OK, JSON_CT, bytes)
    }

    pub fn error_envelope(status: StatusCode, err: &ApiError) -> Self {
        Self::synthesized(status, JSON_CT, err.envelope_json())
    }

    /// Apply RFC 9110 `If-None-Match`: a matching weak ETag turns a 200 into an empty 304 (contract §1).
    /// Every header that would have accompanied the 200 is kept, so the browser can refresh its copy.
    pub fn conditional(mut self, if_none_match: Option<&str>) -> Self {
        let matched = self.status == StatusCode::OK
            && self
                .etag
                .as_deref()
                .is_some_and(|etag| if_none_match.is_some_and(|inm| etag_matches(inm, etag)));
        if matched {
            self.status = StatusCode::NOT_MODIFIED;
            self.content_type = None;
            self.extra = HeaderMap::new();
            self.body = ReplyBody::Bytes(Bytes::new());
        }
        self
    }
}

fn envelope_for_upstream(status: StatusCode, url: &str, body: &[u8]) -> ApiError {
    let code = if status == StatusCode::NOT_FOUND {
        ErrorCode::NotFound
    } else {
        ErrorCode::UpstreamStatus
    };
    let mut e = ApiError::new(status, code, html_error_message(body));
    e.upstream = Some(UpstreamInfo {
        url: url.to_string(),
        status: Some(status.as_u16()),
    });
    if matches!(status.as_u16(), 401 | 403) {
        e.hint =
            Some("the upstream requires authentication; try --user, --header or --token".into());
    }
    e
}

fn is_miss_like(s: CacheSource) -> bool {
    matches!(
        s,
        CacheSource::Miss | CacheSource::Coalesced | CacheSource::Bypass
    )
}

/// Apply content-type safety rules to a successful body.
fn safe_content_type(
    upstream: Option<HeaderValue>,
    body_probe: &[u8],
    expect: Expect,
    force_text: bool,
) -> Option<HeaderValue> {
    if force_text || looks_like_html(upstream.as_ref(), body_probe) {
        return Some(HeaderValue::from_static(TEXT_CT));
    }
    upstream.or_else(|| {
        Some(HeaderValue::from_static(match expect {
            Expect::Json => JSON_CT,
            Expect::Xml => "application/xml",
            Expect::Text | Expect::Any => TEXT_CT,
        }))
    })
}

impl Reply {
    pub async fn from_served(served: Served, expect: Expect, force_text: bool) -> Reply {
        match served {
            Served::Entry { entry, source } => {
                let ok = entry.status.is_success();
                let (content_type, body, etag) = if ok {
                    (
                        safe_content_type(
                            entry.content_type.clone(),
                            &entry.body,
                            expect,
                            force_text,
                        ),
                        entry.body.clone(),
                        Some(entry.etag.clone()),
                    )
                } else if looks_like_html(entry.content_type.as_ref(), &entry.body) {
                    let env = envelope_for_upstream(entry.status, &entry.url, &entry.body);
                    (
                        Some(HeaderValue::from_static(JSON_CT)),
                        env.envelope_json(),
                        None,
                    )
                } else {
                    (entry.content_type.clone(), entry.body.clone(), None)
                };
                Reply {
                    status: entry.status,
                    content_type,
                    extra: if ok {
                        entry.extra.clone()
                    } else {
                        HeaderMap::new()
                    },
                    body: ReplyBody::Bytes(body),
                    cache: Some(source),
                    upstream: is_miss_like(source).then(|| entry.served_by.to_string()),
                    age_ms: Some(entry.age().as_millis() as u64),
                    etag,
                }
            }
            Served::Stream { up, source } => {
                Self::from_stream(*up, source, expect, force_text).await
            }
        }
    }

    async fn from_stream(
        up: UpResp,
        source: CacheSource,
        expect: Expect,
        force_text: bool,
    ) -> Reply {
        let UpResp {
            status,
            content_type,
            extra,
            body,
            served_by,
            url,
        } = up;
        let (prefix, rest) = match body {
            UpBody::Full(b) => (b, futures_util::stream::empty().boxed()),
            UpBody::Stream { prefix, rest } => (prefix, rest),
        };
        let upstream = is_miss_like(source).then(|| served_by.to_string());
        if !status.is_success() {
            // Error bodies are small; read (bounded) so an HTML page can become an envelope.
            let mut buf = BytesMut::from(&prefix[..]);
            let mut rest = rest;
            while buf.len() < 64 * 1024 {
                match rest.next().await {
                    Some(Ok(c)) => buf.extend_from_slice(&c),
                    _ => break,
                }
            }
            let buf = buf.freeze();
            let (ct, body) = if looks_like_html(content_type.as_ref(), &buf) {
                (
                    Some(HeaderValue::from_static(JSON_CT)),
                    envelope_for_upstream(status, &url, &buf).envelope_json(),
                )
            } else {
                (content_type, buf)
            };
            return Reply {
                status,
                content_type: ct,
                extra: HeaderMap::new(),
                body: ReplyBody::Bytes(body),
                cache: Some(source),
                upstream,
                age_ms: None,
                etag: None,
            };
        }
        Reply {
            status,
            content_type: safe_content_type(content_type, &prefix, expect, force_text),
            extra,
            body: ReplyBody::Stream { prefix, rest },
            cache: Some(source),
            upstream,
            age_ms: None,
            etag: None,
        }
    }
}
