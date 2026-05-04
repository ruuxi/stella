use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::sync::Mutex;

// ── Step types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SetupStepId {
    Runtime,
    Parakeet,
    Payload,
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
}
