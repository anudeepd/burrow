//! `GET /api/events?topics=…` — the SSE hub (contract §6).
//!
//! The route is thin: it parses and validates the topic list, asks the hub for a subscription and hands the
//! hub's frame stream to the HTTP layer as `text/event-stream`. Everything with lifetime (polling, change
//! detection, heartbeat, unsubscribe-on-disconnect) lives in [`crate::events`].

use bytes::Bytes;
use http::StatusCode;
use http::header::{HeaderMap, HeaderValue};

use crate::api::{ApiRequest, GroupFut};
use crate::cache::CacheSource;
use crate::core::Core;
use crate::error::ApiError;
use crate::events::{self, Topic};
use crate::reply::{Reply, ReplyBody};

pub const EVENT_STREAM_CT: &str = "text/event-stream; charset=utf-8";

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    if !req.path.is_empty() {
        return Err(ApiError::not_found(format!(
            "'/api/events/{}' does not exist",
            req.path
        )));
    }
    /* Split the **raw** value on the topic separator and decode each part: a comma *between* topics is literal while a
    comma inside a topic's query (`yarn/apps?…&states=NEW,NEW_SAVING,…`) arrives as `%2C`. Decoding first (the old
    behaviour) tore that states list apart and then rejected `NEW_SAVING` as an unknown topic class — a 400 on every
    connection that subscribed to a filtered apps list. */
    let raw = crate::routes::table::query_params_raw(req.query, "topics");
    if raw.iter().all(|p| p.trim().is_empty()) {
        return Err(ApiError::bad_request("?topics= is required")
            .with_hint("e.g. /api/events?topics=yarn/metrics,yarn/nodes"));
    }
    let topics = parse_topics(&raw)?;
    if topics.is_empty() {
        return Err(ApiError::bad_request(
            "?topics= must name at least one topic",
        ));
    }

    let shared = core.shared().ok_or_else(|| {
        ApiError::internal(
            "the events hub has no shared core handle (Core was not built by Core::new)",
        )
    })?;
    let subscription = core.events.subscribe(&shared, &topics)?;
    Ok(Reply {
        status: StatusCode::OK,
        content_type: Some(HeaderValue::from_static(EVENT_STREAM_CT)),
        extra: HeaderMap::new(),
        body: ReplyBody::Stream {
            prefix: Bytes::new(),
            rest: subscription.into_stream(),
        },
        cache: Some(CacheSource::Bypass),
        upstream: None,
        age_ms: None,
        etag: None,
    })
}

/// Parse the raw `?topics=` values into topics: literal commas separate topics, `%2C` belongs to a topic's query.
fn parse_topics(raw: &[String]) -> Result<Vec<Topic>, ApiError> {
    let mut topics: Vec<Topic> = Vec::new();
    for part in raw.iter().flat_map(|value| value.split(',')) {
        let part = crate::routes::table::percent_decode(part.trim());
        if part.is_empty() {
            continue;
        }
        topics.push(events::parse_topic(&part)?);
    }
    Ok(topics)
}

/// The value of `name` in a raw query string, percent-decoded.
pub use crate::routes::table::query_param;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_param_decodes() {
        assert_eq!(
            query_param(Some("topics=yarn/apps%3Fstates%3DRUNNING"), "topics").as_deref(),
            Some("yarn/apps?states=RUNNING")
        );
        assert_eq!(
            query_param(Some("a=1&topics=yarn/metrics"), "topics").as_deref(),
            Some("yarn/metrics")
        );
        assert_eq!(query_param(Some("a=1"), "topics"), None);
        assert_eq!(query_param(None, "topics"), None);
    }

    #[test]
    fn topics_split_before_decoding() {
        /* The client encodes each topic and joins them with literal commas, so a comma inside a query stays `%2C`.
        Decoding first (the old behaviour) tore `states=NEW,NEW_SAVING,RUNNING` apart and rejected `NEW_SAVING` as an
        unknown topic class — a 400 on every connection that subscribed to a filtered apps list. */
        let raw = vec![
            "yarn/apps%3FdeSelects%3DresourceRequests%26states%3DNEW%2CNEW_SAVING%2CRUNNING,yarn/metrics".to_string(),
        ];
        let topics = parse_topics(&raw).expect("parses");
        assert_eq!(topics.len(), 2);
        assert_eq!(topics[0].path, "yarn/apps");
        let query = topics[0].query.clone().expect("query kept");
        assert!(
            query.contains("states=NEW,NEW_SAVING,RUNNING"),
            "got {query}"
        );
        assert_eq!(topics[1].path, "yarn/metrics");
    }
}
