//! Tracing subscriber construction: the console filter plus an optional mirror log file.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::Mutex;

use anyhow::anyhow;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// `BURROW_LOG` (or RUST_LOG) wins; the default keeps request noise out but shows warnings.
pub fn resolve_env_filter<E>(
    burrow_log: Result<EnvFilter, E>,
    fallback: impl FnOnce() -> Result<EnvFilter, E>,
) -> EnvFilter {
    burrow_log
        .or_else(|_| fallback())
        .unwrap_or_else(|_| EnvFilter::new("info"))
}

fn open_log_file(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Install the global subscriber: console output always, plus `log_file` when given.
pub fn init(filter: EnvFilter, log_file: Option<&Path>) -> anyhow::Result<()> {
    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false));

    match log_file {
        Some(path) => {
            let file =
                open_log_file(path).map_err(|e| anyhow!("--log-file {}: {e}", path.display()))?;
            subscriber
                .with(
                    fmt::layer()
                        .with_target(false)
                        .with_ansi(false)
                        .with_writer(Mutex::new(file)),
                )
                .init();
        }
        None => subscriber.init(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burrow_log_wins_without_evaluating_the_fallback() {
        let filter =
            resolve_env_filter(Ok(EnvFilter::new("debug")), EnvFilter::try_from_default_env);

        assert_eq!(filter.to_string(), "debug");
    }

    #[test]
    fn fallback_and_info_default_cover_invalid_filters() {
        let fallback = resolve_env_filter(Err(()), || Ok(EnvFilter::new("warn")));
        assert_eq!(fallback.to_string(), "warn");

        let default = resolve_env_filter::<()>(Err(()), || Err(()));
        assert_eq!(default.to_string(), "info");

        let mut fallback_called = false;
        let default = resolve_env_filter::<()>(Err(()), || {
            fallback_called = true;
            Err(())
        });
        assert_eq!(default.to_string(), "info");
        assert!(fallback_called);
    }
}
