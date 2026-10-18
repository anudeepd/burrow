//! `burrow` entry point: initialise logging, parse arguments, run `serve` or `doctor`.

use std::process::ExitCode;

use tracing_subscriber::EnvFilter;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> ExitCode {
    // `BURROW_LOG` (or RUST_LOG) wins; the default keeps request noise out but shows warnings.
    let filter = resolve_env_filter(
        EnvFilter::try_from_env("BURROW_LOG"),
        EnvFilter::try_from_default_env,
    );
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();

    let (cli, matches) = burrow::cli::parse();
    burrow::cli::run(cli, matches).await
}

fn resolve_env_filter<E>(
    burrow_log: Result<EnvFilter, E>,
    fallback: impl FnOnce() -> Result<EnvFilter, E>,
) -> EnvFilter {
    burrow_log
        .or_else(|_| fallback())
        .unwrap_or_else(|_| EnvFilter::new("info"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burrow_log_wins_without_evaluating_the_fallback() {
        let mut fallback_called = false;
        let filter = resolve_env_filter(Ok(EnvFilter::new("debug")), || {
            fallback_called = true;
            Err(())
        });

        assert_eq!(filter.to_string(), "debug");
        assert!(!fallback_called);
    }

    #[test]
    fn fallback_and_info_default_cover_invalid_filters() {
        let fallback = resolve_env_filter(Err(()), || Ok(EnvFilter::new("warn")));
        assert_eq!(fallback.to_string(), "warn");

        let default = resolve_env_filter::<()>(Err(()), || Err(()));
        assert_eq!(default.to_string(), "info");
    }
}
