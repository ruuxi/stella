use std::path::Path;
use tokio::process::Command;

#[cfg(target_os = "windows")]
use tokio::process::CommandExt as _;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug)]
pub struct RunResult {
    pub ok: bool,
    #[allow(dead_code)]
    pub stdout: String,
    pub stderr: String,
}

pub async fn run(cmd: &[&str], cwd: Option<&Path>) -> RunResult {
    if cmd.is_empty() {
        return RunResult {
            ok: false,
            stdout: String::new(),
            stderr: "empty command".into(),
        };
    }

    let mut command = Command::new(cmd[0]);
    command.args(&cmd[1..]);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }

    // Inherit PATH modifications we may have made (e.g. adding bun)
    command.env("PATH", std::env::var("PATH").unwrap_or_default());

    // Hide console windows on Windows
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    match command.output().await {
        Ok(output) => RunResult {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Err(_) => RunResult {
            ok: false,
            stdout: String::new(),
            stderr: "spawn failed".into(),
        },
    }
}
