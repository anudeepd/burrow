//! `GET /api/system` — Burrow's own process health and runtime counters (contract §2.1).
//!
//! The payload is synthesized from three owners: [`crate::metrics::Metrics`] (process, requests, memory),
//! the SSE hub (open stream connections) and the cache (hit/miss counters and current usage). Nothing here
//! calls an upstream, so the answer is always local and cheap enough for the SPA's live polling cadence.

use std::sync::atomic::Ordering;

use serde::Serialize;

use crate::api::{ApiRequest, GroupFut};
use crate::cache::CacheSource;
use crate::core::Core;
use crate::error::ApiError;
use crate::metrics::SystemSnapshot;
use crate::reply::Reply;

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

pub async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    if !req.path.is_empty() {
        return Err(ApiError::not_found(format!(
            "'/api/system/{}' does not exist",
            req.path
        )));
    }

    let mut snapshot = core.metrics.snapshot();
    snapshot.clients.streams = core.events.connection_count();

    let stats = core.cache.stats();
    let (entries, bytes) = core.cache.usage();
    let body = SystemResponse {
        snapshot,
        cache: CacheSnapshot {
            entries,
            bytes,
            hits: stats.hits.load(Ordering::Relaxed),
            misses: stats.misses.load(Ordering::Relaxed),
            coalesced: stats.coalesced.load(Ordering::Relaxed),
            stale: stats.stale.load(Ordering::Relaxed),
            bypass: stats.bypass.load(Ordering::Relaxed),
            upstream_fetches: stats.upstream_fetches.load(Ordering::Relaxed),
        },
    };

    let mut reply = Reply::json(&body);
    reply.cache = Some(CacheSource::Bypass);
    Ok(reply)
}

#[derive(Serialize)]
struct SystemResponse {
    #[serde(flatten)]
    snapshot: SystemSnapshot,
    cache: CacheSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheSnapshot {
    entries: u64,
    bytes: u64,
    hits: u64,
    misses: u64,
    coalesced: u64,
    stale: u64,
    bypass: u64,
    upstream_fetches: u64,
}
