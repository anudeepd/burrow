use std::process::Command;

#[test]
fn help_starts_the_binary_and_lists_its_commands() {
    let output = Command::new(env!("CARGO_BIN_EXE_burrow"))
        .env_clear()
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
    let output = Command::new(env!("CARGO_BIN_EXE_burrow"))
        .env_clear()
        .args(["--config"])
        .arg(&missing)
        .arg("doctor")
        .output()
        .expect("run Burrow with a missing config");

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("missing.toml"));
}
