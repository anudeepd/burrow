use std::process::Command;

fn isolated_burrow() -> Command {
    // Keep the CLI tests independent of user configuration while letting instrumented child
    // processes write their own LLVM profile alongside the test process.
    let profile = std::env::var_os("LLVM_PROFILE_FILE");
    let mut command = Command::new(env!("CARGO_BIN_EXE_burrow"));
    command.env_clear();
    if let Some(profile) = profile {
        command.env("LLVM_PROFILE_FILE", profile);
    }
    command
}

#[test]
fn help_starts_the_binary_and_lists_its_commands() {
    let output = isolated_burrow()
        .arg("--help")
        .output()
        .expect("run Burrow help");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Usage: burrow"));
    assert!(stdout.contains("serve"));
    assert!(stdout.contains("doctor"));
}

#[test]
fn main_returns_the_cli_error_exit_code_for_a_missing_config_file() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.toml");
    let output = isolated_burrow()
        .args(["--config"])
        .arg(&missing)
        .arg("doctor")
        .output()
        .expect("run Burrow with a missing config");

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("missing.toml"));
}

struct ChildGuard(Option<std::process::Child>);

impl ChildGuard {
    fn kill_and_collect(mut self) -> std::process::Output {
        let mut child = self.0.take().expect("child still running");
        let _ = child.kill();
        child.wait_with_output().expect("collect Burrow output")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn log_file_creates_parents_and_mirrors_logs_without_ansi() {
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("nested").join("burrow.log");
    let child = isolated_burrow()
        .arg("--log-file")
        .arg(&log_path)
        .args([
            "serve",
            "--bind",
            "127.0.0.1",
            "--port",
            "0",
            "--no-open",
            "--rm",
            "http://127.0.0.1:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("start Burrow serving");
    let guard = ChildGuard(Some(child));

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut log = String::new();
    while std::time::Instant::now() < deadline {
        log = std::fs::read_to_string(&log_path).unwrap_or_default();
        if log.contains("ResourceManager") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        log.contains("ResourceManager"),
        "log file missing the startup probe line: {log:?}"
    );

    let output = guard.kill_and_collect();
    log = std::fs::read_to_string(&log_path).unwrap();
    assert!(log_path.parent().unwrap().is_dir());
    assert!(log.contains("UNREACHABLE"), "log file: {log:?}");
    assert!(!log.contains('\x1b'), "log file contains ANSI: {log:?}");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("burrow "), "stdout: {stdout:?}");
    assert!(stdout.contains("ResourceManager"), "stdout: {stdout:?}");
}

#[test]
fn log_file_is_created_for_a_one_shot_command() {
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("doctor.log");

    let output = isolated_burrow()
        .arg("--log-file")
        .arg(&log_path)
        .args(["doctor", "--rm", "http://127.0.0.1:1"])
        .output()
        .expect("run Burrow doctor");

    assert_eq!(output.status.code(), Some(1));
    assert!(log_path.is_file(), "log file was not created");
}

#[test]
fn log_file_rejects_unwritable_paths_before_doctor_runs() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("blocked");
    std::fs::write(&blocked, "").unwrap();

    for path in [
        dir.path().to_path_buf(),
        blocked.join("nested.log"),
        std::path::PathBuf::from("/"),
    ] {
        let output = isolated_burrow()
            .arg("--log-file")
            .arg(&path)
            .arg("doctor")
            .output()
            .expect("run Burrow with a bad log path");

        assert_eq!(
            output.status.code(),
            Some(2),
            "path {path:?} did not fail fast: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("--log-file"), "path {path:?}: {stderr}");
    }
}
