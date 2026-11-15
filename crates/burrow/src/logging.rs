//! Tracing subscriber construction: the console filter plus an optional mirror log file.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::anyhow;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// `BURROW_LOG` (or RUST_LOG) wins; the default keeps request noise out but shows warnings.
pub fn resolve_env_filter<E>(
    burrow_log: Result<EnvFilter, E>,
    fallback: impl FnOnce() -> Result<EnvFilter, E>,
) -> EnvFilter {
    burrow_log
        .or_else(|_| fallback())
        .unwrap_or_else(|_| EnvFilter::new("info"))
}

/// Append-only log file that rotates to a single `.1` backup once it would cross its cap.
///
/// Rotation happens before a write that would exceed the cap, so each formatted tracing event
/// lands whole in one file for regular-file writes.
struct RotatingFile {
    path: PathBuf,
    file: File,
    written: u64,
    max_bytes: u64,
}

impl RotatingFile {
    fn new(path: PathBuf, max_bytes: u64) -> io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata()?.len();
        Ok(Self {
            path,
            file,
            written,
            max_bytes,
        })
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        let backup = backup_path(&self.path);
        match std::fs::remove_file(&backup) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        std::fs::rename(&self.path, &backup)?;
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        self.written = 0;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written.saturating_add(buf.len() as u64) > self.max_bytes {
            self.rotate()?;
        }
        let n = self.file.write(buf)?;
        self.written = self.written.saturating_add(n as u64);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let mut backup = path.as_os_str().to_owned();
    backup.push(".1");
    PathBuf::from(backup)
}

fn open_log_file(path: &Path) -> io::Result<RotatingFile> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    RotatingFile::new(path.to_path_buf(), MAX_LOG_BYTES)
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

    fn writer(dir: &tempfile::TempDir, max_bytes: u64) -> RotatingFile {
        RotatingFile::new(dir.path().join("burrow.log"), max_bytes).unwrap()
    }

    fn path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("burrow.log")
    }

    #[test]
    fn writes_up_to_the_cap_then_rotates_before_crossing_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = writer(&dir, 4);

        log.write_all(b"aaaa").unwrap();
        assert!(!backup_path(&path(&dir)).exists());

        log.write_all(b"b").unwrap();
        log.flush().unwrap();

        assert_eq!(std::fs::read(backup_path(&path(&dir))).unwrap(), b"aaaa");
        assert_eq!(std::fs::read(path(&dir)).unwrap(), b"b");
    }

    #[test]
    fn a_second_rotation_replaces_the_first_backup() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = writer(&dir, 4);

        log.write_all(b"aaaa").unwrap();
        log.write_all(b"b").unwrap();
        assert_eq!(std::fs::read(backup_path(&path(&dir))).unwrap(), b"aaaa");

        log.write_all(b"ccc").unwrap();
        log.write_all(b"d").unwrap();

        assert_eq!(std::fs::read(backup_path(&path(&dir))).unwrap(), b"bccc");
        assert_eq!(std::fs::read(path(&dir)).unwrap(), b"d");
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries.len(), 2, "unexpected files: {entries:?}");
    }

    #[test]
    fn existing_content_counts_toward_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(&dir), b"old").unwrap();

        let mut log = writer(&dir, 4);
        assert_eq!(log.written, 3);

        log.write_all(b"xy").unwrap();

        assert_eq!(std::fs::read(backup_path(&path(&dir))).unwrap(), b"old");
        assert_eq!(std::fs::read(path(&dir)).unwrap(), b"xy");
    }

    #[test]
    fn a_failed_backup_removal_leaves_the_current_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = writer(&dir, 4);
        log.write_all(b"aaaa").unwrap();
        std::fs::create_dir(backup_path(&path(&dir))).unwrap();

        let error = log.write_all(b"b").unwrap_err();

        assert!(!error.to_string().is_empty());
        assert_eq!(std::fs::read(path(&dir)).unwrap(), b"aaaa");
        assert!(backup_path(&path(&dir)).is_dir());
    }
}
