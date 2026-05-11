use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex;

// ── Desktop startup failure ─────────────────────────────────────────

/// Captured when `bun run electron:dev` exits with a non-zero status. The
/// launcher surfaces this as a recovery view (Try again / Undo last
/// Stella update) instead of silently re-showing its install/launch UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFailure {
    /// Process exit code (or 1 if the OS reported a signal/no code).
    pub exit_code: i32,
    /// Last ~200 lines of merged stdout/stderr from the spawned dev runner.
    /// Surfaced in the launcher's "Show details" expander.
    pub log_tail: String,
    /// Whether the desktop pid file ever existed during this launch attempt.
    /// `false` = bootstrap-time crash (main.ts threw on import, vite died,
    /// etc.); `true` = post-startup crash (renderer reload tripped over a
    /// broken module, worker fell over, etc.).
    pub reached_running: bool,
    /// Absolute path to the full launch log file. Surfaced so the user can
    /// open it for the full trace if the tail isn't enough.
    pub log_path: String,
    /// Subject of the latest commit on the install repo at the time of the
    /// failure, plus its short SHA. Surfaced so the user can see *what* is
    /// being reverted before clicking "Undo Stella's last update". `None`
    /// when the latest commit isn't an agent-authored self-mod commit
    /// (i.e., no `Stella-Conversation:` trailer) -- in that case the launcher
    /// hides the undo button rather than rolling back unrelated work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revertable_commit: Option<RevertableCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertableCommit {
    pub short_sha: String,
    pub subject: String,
}

// ── Step types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SetupStepId {
    Runtime,
    Parakeet,
    Payload,
    NativeHelpers,
    Deps,
    Env,
    Browser,
    Shortcuts,
    Finalize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SetupStepStatus {
    Pending,
    Checking,
    Installing,
    Done,
    Skipped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupStep {
    pub id: SetupStepId,
    pub label: String,
    pub status: SetupStepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

// ── Installer state ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallerPhase {
    Checking,
    Ready,
    Installing,
    Updating,
    Complete,
    Error,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateInfo {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub checking: bool,
    pub installing: bool,
    pub last_checked_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub required_bytes: u64,
    pub available_bytes: Option<u64>,
    pub used_bytes: u64,
    pub enough_space: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerState {
    pub steps: Vec<SetupStep>,
    pub phase: InstallerPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning_message: Option<String>,
    pub install_path: String,
    pub default_install_path: String,
    pub dev_mode: bool,
    pub install_path_locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_path_error: Option<String>,
    pub run_after_install: bool,
    pub can_launch: bool,
    pub installed: bool,
    pub launcher_update: LauncherUpdateInfo,
    pub disk: DiskInfo,
}

// ── Context ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct InstallerContext {
    pub default_install_path: String,
    pub settings_file_path: PathBuf,
    pub required_bytes: u64,
    pub dev_mode: bool,
}

// ── Settings persistence ────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub install_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
    pub run_after_install: Option<bool>,
}

// ── Install manifest ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_release_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_archive_sha256: Option<String>,
    /// Upstream GitHub commit SHA the tarball was built from. Updated by the
    /// install-update agent after each successful manual update.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub desktop_release_commit: Option<String>,
    /// SHA of the local `start` commit created by `init_git_repo` immediately
    /// after extraction. Stable reference even after self-mod commits accumulate.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub desktop_install_base_commit: Option<String>,
    pub platform: String,
    pub installed_at: String,
    pub install_path: String,
    pub launch_script: String,
    pub shortcuts: std::collections::HashMap<String, String>,
}

// ── Launch info ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LaunchInfo {
    pub command: Vec<String>,
    pub cwd: String,
    pub env: std::collections::HashMap<String, String>,
}

// ── Managed app state ───────────────────────────────────────────────

pub struct AppState {
    pub installer: Mutex<InstallerState>,
    pub context: InstallerContext,
    /// Background tokio task that watches the desktop pid file and re-shows
    /// the launcher window when the desktop exits. Held here so a second
    /// `launch_desktop` doesn't spawn duplicate watchers, and so the previous
    /// watcher can be aborted on relaunch / app exit.
    pub desktop_watcher: StdMutex<Option<JoinHandle<()>>>,
    /// Background tokio task that owns the spawned `bun run electron:dev`
    /// child handle and waits on its exit. Replaces the old fully-detached
    /// spawn so the launcher can detect non-zero exits and surface a
    /// recovery view. Kept on the state so a second `launch_desktop` can
    /// abort the previous waiter (the old spawn is already orphaned via
    /// `setsid`, so the previous Stella process keeps running independently).
    pub desktop_exit_waiter: StdMutex<Option<JoinHandle<()>>>,
    /// Most recently captured desktop startup/runtime failure. Surfaced in
    /// the launcher window via the `desktop-failure` Tauri event and read
    /// by the renderer to render the recovery view.
    pub desktop_failure: StdMutex<Option<DesktopFailure>>,
}
