//! The burrow error model: every non-2xx that *burrow itself* produces is an [`ApiError`], which
//! serialises to the envelope documented in `docs/contracts/api.md` §1.

use bytes::Bytes;
use http::StatusCode;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UpstreamUnreachable,
    UpstreamStatus,
    NotFound,
    BadRequest,
    Forbidden,
    Unavailable,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UpstreamUnreachable => "upstream_unreachable",
            Self::UpstreamStatus => "upstream_status",
            Self::NotFound => "not_found",
            Self::BadRequest => "bad_request",
            Self::Forbidden => "forbidden",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UpstreamInfo {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: ErrorCode,
    pub message: String,
    pub upstream: Option<UpstreamInfo>,
    pub hint: Option<String>,
}

#[derive(Serialize)]
struct Envelope<'a> {
    error: EnvelopeBody<'a>,
}

#[derive(Serialize)]
struct EnvelopeBody<'a> {
    code: &'static str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<&'a UpstreamInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'a str>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            upstream: None,
            hint: None,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, ErrorCode::BadRequest, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, ErrorCode::Forbidden, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            message,
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Internal,
            message,
        )
    }

    pub fn unreachable(url: impl Into<String>, message: impl Into<String>) -> Self {
        let mut e = Self::new(
            StatusCode::BAD_GATEWAY,
            ErrorCode::UpstreamUnreachable,
            message,
        );
        e.upstream = Some(UpstreamInfo {
            url: url.into(),
            status: None,
        });
        e
    }

    /// An upstream answered, but with something we cannot pass through (HTML, redirect to a stranger).
    pub fn upstream_status(
        status: StatusCode,
        url: impl Into<String>,
        upstream_status: u16,
        message: impl Into<String>,
    ) -> Self {
        let mut e = Self::new(status, ErrorCode::UpstreamStatus, message);
        e.upstream = Some(UpstreamInfo {
            url: url.into(),
            status: Some(upstream_status),
        });
        e
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn envelope_json(&self) -> Bytes {
        let env = Envelope {
            error: EnvelopeBody {
                code: self.code.as_str(),
                message: &self.message,
                upstream: self.upstream.as_ref(),
                hint: self.hint.as_deref(),
            },
        };
        Bytes::from(serde_json::to_vec(&env).expect("envelope serialises"))
    }
}

/// Strip credentials from a URL before it is shown to anybody.
pub fn redact_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut u) => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.to_string()
        }
        Err(_) => url.to_string(),
    }
}
