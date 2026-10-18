//! Route groups of the `/api` surface. Each group owns one module and one [`crate::routes::table::RouteTable`];
//! [`crate::api::dispatch`] is the only place that decides which group a request belongs to.

pub mod events;
pub mod logs;
pub mod meta;
pub mod nm;
pub mod rm;
pub mod spark;
pub mod table;
pub mod yarn;

use std::time::Duration;

use crate::cache::TtlPolicy;

/// Poll interval for an SSE topic path, derived from the very route table [`crate::api::dispatch`] resolves it
/// through — so a topic the SPA can fetch is a topic the hub can poll. A route's cache TTL is exactly "how long the
/// body stays fresh", i.e. the fastest interval at which an `invalidate` can be useful.
///
/// `None` = not a pollable API resource: unknown group or resource, or a stream (`TtlPolicy::None`). The SSE hub
/// uses this as the fallback for topics its own (tuned) class list does not name, which keeps the list from having
/// to be re-copied every time the SPA grows a query.
pub fn topic_interval(path: &str) -> Option<Duration> {
    let (group, rest) = path.split_once('/')?;
    let ttl = match group {
        "yarn" => yarn::table().lookup(rest)?.route.ttl,
        "rm" => rm::table().lookup(rest)?.route.ttl,
        // `nm/{host:port}/{resource}`: the authority itself is validated against the RM's node list on request.
        "nm" => {
            let (authority, resource) = rest.split_once('/')?;
            if !table::is_safe_segment(authority) {
                return None;
            }
            nm::table().lookup(resource)?.route.ttl
        }
        // `spark/{appId}/{sub-resource}`: the live-mode TTL (a history app is polled no faster). The suffix keeps its
        // leading slash — that is what the Spark table's patterns are anchored on.
        "spark" => {
            let i = rest.find('/')?;
            if !spark::is_app_id(&rest[..i]) {
                return None;
            }
            spark::topic_ttl(&rest[i..])?
        }
        _ => return None,
    };
    match ttl {
        TtlPolicy::Fixed(d) => Some(d),
        TtlPolicy::AppState { live, .. } => Some(live),
        TtlPolicy::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every topic the SPA actually subscribes to (grep `topicOf` under `web/src`) must be pollable, and a path the
    /// API does not serve must not be. This is the guard that was missing when `yarn/info` — the overview page's
    /// topic — made every SSE connection answer 400.
    #[test]
    fn topic_interval_covers_every_spa_topic() {
        for ok in [
            "yarn/info",
            "yarn/metrics",
            "yarn/scheduler",
            "yarn/scheduler-overview",
            "yarn/scheduler-conf",
            "yarn/scheduler/activities",
            "yarn/scheduler/app-activities/application_1_1",
            "yarn/apps",
            "yarn/apps/application_1_1",
            "yarn/appstatistics",
            "yarn/nodes",
            "yarn/nodes/node_1",
            "yarn/get-node-labels",
            "yarn/get-node-to-labels",
            "yarn/label-mappings",
            "yarn/resource-profiles",
            "yarn/resource-types",
            "yarn/containers/container_1_1_01_000001",
            "rm/conf",
            "rm/jmx",
            "rm/logs",
            "rm/stacks",
            "nm/127.0.0.1:8042/info",
            "nm/127.0.0.1:8042/containers",
            "spark/application_1_1/jobs",
            "spark/application_1_1/dag/jobs/0",
            "spark/application_1_1/source",
        ] {
            assert!(topic_interval(ok).is_some(), "{ok} must be pollable");
        }
        for bad in [
            "",
            "yarn",
            "yarn/nope",
            "rm/nope",
            "nm/127.0.0.1:8042/nope",
            "spark/application_1_1/nope",
            "spark/notanapp/jobs",
            "logs/x",
            "meta",
        ] {
            assert!(topic_interval(bad).is_none(), "{bad} must not be pollable");
        }
    }
}
