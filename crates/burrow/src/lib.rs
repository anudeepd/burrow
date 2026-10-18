//! `burrow` — the binary crate: CLI, HTTP layer and embedded web assets.
//!
//! Everything that does not need a socket lives in `burrow-core`; this crate owns
//! * [`cli`] — argument parsing and the layered configuration resolution,
//! * [`app`] — the axum router, the `x-burrow-*` response contract, static delivery, serve loop,
//! * [`assets`] — embedded (or `--assets-dir`) SPA files with precompressed variants.
//!
//! Exposed as a library so the integration tests in `tests/` can drive the very same router.

pub mod app;
pub mod assets;
pub mod cli;

pub use burrow_core as core;
