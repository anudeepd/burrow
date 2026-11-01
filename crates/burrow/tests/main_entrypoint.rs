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
