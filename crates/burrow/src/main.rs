//! `burrow` entry point: parse arguments, initialise logging, run `serve` or `doctor`.

use std::process::ExitCode;

use tracing_subscriber::EnvFilter;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> ExitCode {
    let (cli, matches) = burrow::cli::parse();
    let filter = burrow::logging::resolve_env_filter(
        EnvFilter::try_from_env("BURROW_LOG"),
        EnvFilter::try_from_default_env,
    );
    if let Err(error) = burrow::logging::init(filter, cli.opts.log_file.as_deref()) {
        eprintln!("burrow: {error:#}");
        return ExitCode::from(2);
    }
    burrow::cli::run(cli, matches).await
}
