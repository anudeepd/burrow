//! `burrow-core` — everything the backend does apart from speaking HTTP to the browser.
//!
//! Layout:
//! * [`config`] / [`hadoop_conf`] — layered configuration resolution and Hadoop-conf auto-discovery.
//! * [`http`] / [`upstream`] / [`rm_pool`] — upstream clients, health/backoff, RM HA failover.
//! * [`cache`] — single-flight TTL cache with stale-while-revalidate and weak ETags.
//! * [`api`] / [`routes`] — the transport-agnostic `/api` surface (see `docs/contracts/api.md`).
//! * [`reply`] / [`error`] / [`html`] — browser-safe response construction and the error envelope.
//! * [`topics`] — the SSE hub's topic registry (extension point, no I/O).
//!
//! The crate never depends on axum/hyper: the binary owns the HTTP layer and only translates.

pub mod api;
pub mod cache;
pub mod config;
pub mod core;
pub mod error;
pub mod events;
pub mod hadoop_conf;
pub mod html;
pub mod http;
pub mod logs;
pub mod reply;
pub mod rm_pool;
pub mod routes;
pub mod service_discovery;
pub mod spark;
pub mod topics;
pub mod upstream;
