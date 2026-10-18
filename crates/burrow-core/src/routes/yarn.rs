//! `GET /api/yarn/{path}` ⇒ `{rm}/ws/v1/cluster/{path}`.
//!
//! The table below is *the* allowlist. To expose another RM REST resource, add one line.

use std::sync::LazyLock;
use std::time::Duration;

use crate::api::{ApiRequest, GroupFut};
use crate::cache::{Expect::Json, TtlPolicy};
use crate::core::{Core, GetSpec};
use crate::error::ApiError;
use crate::reply::Reply;
use crate::routes::table::{Route, RouteTable, millis, route, secs};

pub static ROUTES: &[Route] = &[
    route("info", secs(2), Json),
    route("metrics", secs(1), Json),
    route("scheduler", secs(3), Json),
    route("scheduler-overview", secs(1), Json),
    route("scheduler/activities", secs(1), Json),
    route("scheduler/bulk-activities", secs(1), Json),
    // Per-application scheduler activities (the real path on RM 3.x; `apps/{id}/appactivities` is not
    // served by Hadoop 3.4.3 — verified live).
    route("scheduler/app-activities/{id}", secs(1), Json),
    route("scheduler-conf", secs(10), Json),
    route("scheduler-conf/version", secs(10), Json),
    route("apps", secs(2), Json),
    // 1 s while the app can still change, 60 s once FINISHED/FAILED/KILLED.
    route(
        "apps/{id}",
        TtlPolicy::AppState {
            live: Duration::from_secs(1),
            terminal: Duration::from_secs(60),
        },
        Json,
    ),
    route("apps/{id}/appattempts", secs(2), Json),
    // Single attempt: AM host/rpcPort, tracking URL, diagnostics (the list entries carry none of them).
    route("apps/{id}/appattempts/{id}", secs(2), Json),
    route("apps/{id}/appattempts/{id}/containers", secs(2), Json),
    route("apps/{id}/appattempts/{id}/containers/{id}", secs(2), Json),
    route(
        "apps/{id}/(?:state|priority|queue|timeout|timeouts|statistics|appactivities|activities)",
        millis(1500),
        Json,
    ),
    route("apps/{id}/timeouts/{id}", secs(2), Json),
    route("appstatistics", secs(2), Json),
    route("nodes", secs(3), Json),
    route("nodes/{id}", secs(3), Json),
    route("nodes/{id}/get-labels", secs(5), Json),
    route("get-node-labels", secs(5), Json),
    route("get-rm-node-labels", secs(5), Json),
    route("get-node-to-labels", secs(5), Json),
    route("label-mappings", secs(5), Json),
    route("resource-profiles", secs(60), Json),
    route("resource-types", secs(60), Json),
    route("userinfo", secs(5), Json),
    route("containers/{id}", secs(2), Json),
];

static TABLE: LazyLock<RouteTable> = LazyLock::new(|| RouteTable::new("/ws/v1/cluster/", ROUTES));

pub fn table() -> &'static RouteTable {
    &TABLE
}

pub fn route_fn<'a>(core: &'a Core, req: ApiRequest<'a>) -> GroupFut<'a> {
    Box::pin(get(core, req))
}

pub async fn get(core: &Core, req: ApiRequest<'_>) -> Result<Reply, ApiError> {
    // Hadoop's own clients send collection URLs both ways (`…/containers` and `…/containers/`), and the RM
    // answers 200 for both; normalise before matching so we do not invent a 404 the upstream would not.
    let path = req.path.strip_suffix('/').unwrap_or(req.path);
    let Some(r) = table().lookup(path) else {
        return Err(ApiError::not_found(format!(
            "'{}' is not an exposed ResourceManager resource",
            req.path
        )));
    };
    let mut spec = GetSpec::new(&r.upstream_path, r.route.ttl, r.route.expect);
    spec.query = req.query;
    spec.bypass = req.bypass;
    core.rm_reply(&spec).await
}
