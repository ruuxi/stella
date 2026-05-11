use crate::disk;
use crate::shell::run;
use crate::state::*;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// ── Constants ───────────────────────────────────────────────────────

const INSTALL_MANIFEST: &str = "stella-install.json";
const RELEASE_MANIFEST: &str = "stella-release.json";
const LAUNCH_SCRIPT_WIN: &str = "launch.cmd";
const LAUNCH_SCRIPT_UNIX: &str = "launch.sh";
const ENV_FILE_NAME: &str = ".env.local";
const ESTIMATED_INSTALL_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_ENV_FILE_CONTENTS: &str = "\
VITE_CONVEX_URL=https://benevolent-minnow-586.convex.cloud\n\
VITE_CONVEX_SITE_URL=https://cloud.stella.sh\n\
VITE_SITE_URL=https://stella.sh\n";

const GITHUB_REPO: &str = "ruuxi/stella";
const STELLA_GITHUB_REMOTE_URL: &str = "https://github.com/ruuxi/stella";
const DEFAULT_DESKTOP_RELEASE_MANIFEST_URL: &str =
    "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/desktop/current.json";
const DEFAULT_NATIVE_HELPERS_MANIFEST_URL: &str =
    "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers/current.json";
const INSTALL_DIR_NAME: &str = "stella";
const ELECTRON_USER_DATA_DIR_NAME: &str = "electron-user-data";

fn release_tarball_name() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "stella-desktop-win-x64.tar.zst"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "stella-desktop-darwin-arm64.tar.zst"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "stella-desktop-darwin-x64.tar.zst"
    } else {
        "stella-desktop-linux-x64.tar.zst"
    }
}

fn native_helpers_platform_dir() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn release_download_url(tag: &str) -> String {
    format!(
        "https://github.com/{GITHUB_REPO}/releases/download/{tag}/{}",
        release_tarball_name()
    )
}

/// Stable URL that always resolves to whatever GitHub marks as the latest non-prerelease release.
fn release_latest_download_url() -> String {
    format!(
        "https://github.com/{GITHUB_REPO}/releases/latest/download/{}",
        release_tarball_name()
    )
}

/// Get the newest `desktop-v*` release tag from GitHub (fallback when `releases/latest` is not a desktop release).
async fn latest_release_tag() -> Option<String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=100");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "stella-launcher")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let releases: Vec<serde_json::Value> = resp.json().await.ok()?;

    // Find the first release whose tag starts with "desktop-v"
    for release in &releases {
        if let Some(tag) = release["tag_name"].as_str() {
            if tag.starts_with("desktop-v") {
                return Some(tag.to_string());
            }
        }
    }

    // Fallback: any release with the right asset name
    let asset_name = release_tarball_name();
    for release in &releases {
        if let Some(assets) = release["assets"].as_array() {
            for asset in assets {
                if asset["name"].as_str() == Some(asset_name) {
                    return release["tag_name"].as_str().map(|s| s.to_string());
                }
            }
        }
    }

    None
}

// ── Path helpers ────────────────────────────────────────────────────

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn expand_home(p: &str) -> String {
    if p == "~" {
        home_dir().to_string_lossy().to_string()
    } else if let Some(rest) = p.strip_prefix("~/") {
        home_dir().join(rest).to_string_lossy().to_string()
    } else if let Some(rest) = p.strip_prefix("~\\") {
        home_dir().join(rest).to_string_lossy().to_string()
    } else {
        p.to_string()
    }
}

fn norm(p: &str) -> String {
    let expanded = expand_home(p.trim());
    match std::fs::canonicalize(&expanded) {
        Ok(canon) => {
            let s = canon.to_string_lossy().to_string();
            s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
        }
        Err(_) => {
            let pb = PathBuf::from(&expanded);
            if pb.is_absolute() {
                let s = pb.to_string_lossy().to_string();
                s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
            } else {
                std::env::current_dir()
                    .unwrap_or_default()
                    .join(&pb)
                    .to_string_lossy()
                    .to_string()
            }
        }
    }
}

fn install_dir_name_matches(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case(INSTALL_DIR_NAME))
        .unwrap_or(false)
}

fn resolve_install_path(input: &str) -> String {
    let normalized = norm(input);
    let normalized_path = Path::new(&normalized);
    if install_dir_name_matches(normalized_path) || looks_like_stella_install_dir(normalized_path) {
        normalized
    } else {
        norm(
            &PathBuf::from(&normalized)
                .join(INSTALL_DIR_NAME)
                .to_string_lossy(),
        )
    }
}

pub fn browse_directory_for_install_path(install_path: &str) -> String {
    let path = PathBuf::from(install_path);
    if install_dir_name_matches(&path) {
        if let Some(parent) = path.parent() {
            return parent.to_string_lossy().to_string();
        }
    }
    install_path.to_string()
}

fn looks_like_stella_install_dir(path: &Path) -> bool {
    path.join(INSTALL_MANIFEST).is_file()
        || path.join(RELEASE_MANIFEST).is_file()
        || looks_like_stella_source_tree(path)
}

fn looks_like_stella_source_tree(path: &Path) -> bool {
    let package_path = path.join("package.json");
    let Ok(raw) = std::fs::read_to_string(package_path) else {
        return false;
    };
    let Ok(package_json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let is_stella_package = package_json
        .get("name")
        .and_then(|value| value.as_str())
        .is_some_and(|name| name == "stella" || name == "stella-workspace");

    is_stella_package && path.join("desktop").is_dir() && path.join("runtime").is_dir()
}

fn is_directory_empty(path: &Path) -> bool {
    match std::fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

fn is_state_only_install_dir(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    let mut saw_state = false;
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let name = entry.file_name();
        let Ok(file_type) = entry.file_type() else {
            return false;
        };
        if name == "state" {
            if !file_type.is_dir() {
                return false;
            }
            saw_state = true;
            continue;
        }
        // Launcher/macOS-owned artifacts that are safe to allow alongside
        // preserved state after uninstall.
        if file_type.is_file()
            && (name == "stella-install.log"
                || name == ".DS_Store"
                || name == ".stella-desktop-download.tar.zst")
        {
            continue;
        }
        return false;
    }
    saw_state
}

pub fn is_uninstallable_install_path(install_path: &str) -> bool {
    let path = Path::new(install_path);
    path.is_dir() && (looks_like_stella_install_dir(path) || is_state_only_install_dir(path))
}

fn manifest_of(d: &str) -> PathBuf {
    Path::new(d).join(INSTALL_MANIFEST)
}
fn release_manifest_of(d: &str) -> PathBuf {
    Path::new(d).join(RELEASE_MANIFEST)
}
fn desktop_dir_of(d: &str) -> PathBuf {
    Path::new(d).join("desktop")
}
fn package_json_of(d: &str) -> PathBuf {
    Path::new(d).join("package.json")
}
fn node_modules_of(d: &str) -> PathBuf {
    Path::new(d).join("node_modules")
}
fn bun_executable_of() -> PathBuf {
    if cfg!(target_os = "windows") {
        home_dir().join(".bun").join("bin").join("bun.exe")
    } else {
        home_dir().join(".bun").join("bin").join("bun")
    }
}
fn bun_bin_dir() -> PathBuf {
    home_dir().join(".bun").join("bin")
}
fn path_separator() -> &'static str {
    if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    }
}
fn prepend_path_entry(entry: &Path, existing_path: &str) -> String {
    let entry = entry.to_string_lossy();
    if existing_path.is_empty() {
        entry.to_string()
    } else {
        format!("{entry}{}{existing_path}", path_separator())
    }
}
fn mac_screen_capture_permissions_dir_of(d: &str) -> PathBuf {
    node_modules_of(d).join("mac-screen-capture-permissions")
}
fn mac_screen_capture_permissions_binary_of(d: &str) -> PathBuf {
    mac_screen_capture_permissions_dir_of(d)
        .join("build")
        .join("Release")
        .join("screencapturepermissions.node")
}
fn launch_script_name() -> &'static str {
    if cfg!(target_os = "windows") {
        LAUNCH_SCRIPT_WIN
    } else {
        LAUNCH_SCRIPT_UNIX
    }
}
fn launch_script_of(d: &str) -> PathBuf {
    Path::new(d).join(launch_script_name())
}
fn env_file_of(d: &str) -> PathBuf {
    desktop_dir_of(d).join(ENV_FILE_NAME)
}
fn parakeet_cache_dir_of(d: &str) -> PathBuf {
    desktop_dir_of(d).join("resources").join("parakeet")
}
fn parakeet_helper_of(d: &str) -> PathBuf {
    desktop_dir_of(d)
        .join("native")
        .join("out")
        .join("darwin")
        .join("parakeet_transcriber")
}
fn dugite_git_root_of(d: &str) -> PathBuf {
    node_modules_of(d).join("dugite").join("git")
}
fn dugite_git_bin_of(d: &str) -> PathBuf {
    if cfg!(target_os = "windows") {
        dugite_git_root_of(d).join("cmd").join("git.exe")
    } else {
        dugite_git_root_of(d).join("bin").join("git")
    }
}
fn dugite_win32_subfolder() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "mingw64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "clangarm64"
    } else {
        "mingw32"
    }
}
fn dugite_git_bash_of(d: &str) -> PathBuf {
    if cfg!(target_os = "windows") {
        dugite_git_root_of(d)
            .join(dugite_win32_subfolder())
            .join("bin")
            .join("bash.exe")
    } else {
        dugite_git_root_of(d).join("bin").join("bash")
    }
}
fn dugite_git_exec_path_of(d: &str) -> PathBuf {
    let root = dugite_git_root_of(d);
    if cfg!(target_os = "windows") {
        root.join(dugite_win32_subfolder())
            .join("libexec")
            .join("git-core")
    } else {
        root.join("libexec").join("git-core")
    }
}
fn dugite_launch_env(install_dir: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let mut launch_path =
        prepend_path_entry(&bun_bin_dir(), &std::env::var("PATH").unwrap_or_default());
    let git_root = dugite_git_root_of(install_dir);
    if !git_root.exists() {
        env.insert("PATH".into(), launch_path);
        return env;
    }

    let git_root_str = git_root.to_string_lossy().to_string();
    env.insert("LOCAL_GIT_DIRECTORY".into(), git_root_str.clone());
    env.insert(
        "STELLA_GIT_BIN".into(),
        dugite_git_bin_of(install_dir).to_string_lossy().to_string(),
    );
    env.insert(
        "GIT_EXEC_PATH".into(),
        dugite_git_exec_path_of(install_dir)
            .to_string_lossy()
            .to_string(),
    );

    if cfg!(target_os = "windows") {
        let mingw_root = git_root.join(dugite_win32_subfolder());
        let path_prefix = format!(
            "{};{}",
            mingw_root.join("bin").to_string_lossy(),
            mingw_root.join("usr").join("bin").to_string_lossy()
        );
        launch_path = format!("{path_prefix};{launch_path}");
        env.insert("PATH".into(), launch_path);
        env.insert(
            "STELLA_GIT_BASH".into(),
            dugite_git_bash_of(install_dir)
                .to_string_lossy()
                .to_string(),
        );
    } else {
        launch_path = format!("{git_root_str}/bin:{launch_path}");
        env.insert("PATH".into(), launch_path);
        env.insert(
            "GIT_CONFIG_SYSTEM".into(),
            git_root
                .join("etc")
                .join("gitconfig")
                .to_string_lossy()
                .to_string(),
        );
        env.insert(
            "GIT_TEMPLATE_DIR".into(),
            git_root
                .join("share")
                .join("git-core")
                .join("templates")
                .to_string_lossy()
                .to_string(),
        );
    }

    env
}

// ── Validation ──────────────────────────────────────────────────────

fn location_error(p: &str) -> Option<String> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Some("Choose where Stella should be installed.".into());
    }
    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Some("Install location must be an absolute path.".into());
    }
    if let Ok(metadata) = std::fs::metadata(&pb) {
        if !metadata.is_dir() {
            return Some("Install location must be a folder.".into());
        }
        if !looks_like_stella_install_dir(&pb)
            && !is_directory_empty(&pb)
            && !is_state_only_install_dir(&pb)
        {
            return Some(format!(
                "Stella needs its own `{INSTALL_DIR_NAME}` folder. Choose a parent folder or an existing Stella install."
            ));
        }
    }
    None
}

// ── Helpers ─────────────────────────────────────────────────────────

async fn path_exists(p: &Path) -> bool {
    fs::metadata(p).await.is_ok()
}

async fn path_exists_str(p: &str) -> bool {
    path_exists(Path::new(p)).await
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDownloadManifest {
    schema_version: u32,
    tag: String,
    assets: HashMap<String, DesktopDownloadAsset>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDownloadAsset {
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHelpersManifest {
    schema_version: u32,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    commit: Option<String>,
    assets: HashMap<String, NativeHelpersAsset>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHelpersAsset {
    url: String,
    sha256: String,
    #[allow(dead_code)]
    size: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopReleaseManifest {
    schema_version: u32,
    tag: String,
    #[serde(default)]
    commit: Option<String>,
    #[allow(dead_code)]
    files: HashMap<String, ReleaseFileEntry>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ReleaseFileEntry {
    #[allow(dead_code)]
    sha256: String,
}

fn desktop_release_manifest_url() -> String {
    std::env::var("STELLA_DESKTOP_RELEASE_MANIFEST_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DESKTOP_RELEASE_MANIFEST_URL.to_string())
}

fn native_helpers_manifest_url() -> String {
    std::env::var("STELLA_NATIVE_HELPERS_MANIFEST_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_NATIVE_HELPERS_MANIFEST_URL.to_string())
}

fn desktop_platform_key() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else {
        "linux-x64"
    }
}

fn native_helpers_platform_key() -> &'static str {
    desktop_platform_key()
}

fn native_helpers_dir_of(install_dir: &str) -> PathBuf {
    desktop_dir_of(install_dir)
        .join("native")
        .join("out")
        .join(native_helpers_platform_dir())
}

fn normalize_sha256(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .find(|part| part.len() == 64 && part.chars().all(|char| char.is_ascii_hexdigit()))
        .map(|part| part.to_ascii_lowercase())
}

// ── Settings persistence ────────────────────────────────────────────

async fn read_settings(ctx: &InstallerContext) -> Settings {
    match fs::read_to_string(&ctx.settings_file_path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

async fn write_settings(ctx: &InstallerContext, state: &InstallerState) {
    let existing = read_settings(ctx).await;
    let settings = Settings {
        install_path: Some(state.install_path.clone()),
        installed_path: if state.installed {
            Some(state.install_path.clone())
        } else {
            existing.installed_path
        },
        run_after_install: Some(state.run_after_install),
    };
    if let Some(parent) = ctx.settings_file_path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    let json = serde_json::to_string_pretty(&settings).unwrap_or_default();
    let _ = fs::write(&ctx.settings_file_path, json).await;
}

// ── Launch script ───────────────────────────────────────────────────

async fn write_launch_script(install_dir: &str) -> String {
    let script_path = launch_script_of(install_dir);
    let launch_env = dugite_launch_env(install_dir);

    if cfg!(target_os = "windows") {
        let mut content = format!("@echo off\r\ncd /d \"{install_dir}\"\r\n");
        if let Some(git_path) = launch_env.get("STELLA_GIT_BIN") {
            content.push_str(&format!("set \"STELLA_GIT_BIN={git_path}\"\r\n"));
        }
        if let Some(bash_path) = launch_env.get("STELLA_GIT_BASH") {
            content.push_str(&format!("set \"STELLA_GIT_BASH={bash_path}\"\r\n"));
        }
        if let Some(git_dir) = launch_env.get("LOCAL_GIT_DIRECTORY") {
            content.push_str(&format!("set \"LOCAL_GIT_DIRECTORY={git_dir}\"\r\n"));
        }
        if let Some(git_exec_path) = launch_env.get("GIT_EXEC_PATH") {
            content.push_str(&format!("set \"GIT_EXEC_PATH={git_exec_path}\"\r\n"));
        }
        if let Some(path_value) = launch_env.get("PATH") {
            content.push_str(&format!("set \"PATH={path_value}\"\r\n"));
        }
        content.push_str("bun run electron:dev\r\n");
        let _ = fs::write(&script_path, content).await;
    } else {
        let mut content = format!("#!/bin/sh\ncd \"{install_dir}\"\n");
        if let Some(git_path) = launch_env.get("STELLA_GIT_BIN") {
            content.push_str(&format!("export STELLA_GIT_BIN=\"{git_path}\"\n"));
        }
        if let Some(bash_path) = launch_env.get("STELLA_GIT_BASH") {
            content.push_str(&format!("export STELLA_GIT_BASH=\"{bash_path}\"\n"));
        }
        if let Some(git_dir) = launch_env.get("LOCAL_GIT_DIRECTORY") {
            content.push_str(&format!("export LOCAL_GIT_DIRECTORY=\"{git_dir}\"\n"));
        }
        if let Some(git_exec_path) = launch_env.get("GIT_EXEC_PATH") {
            content.push_str(&format!("export GIT_EXEC_PATH=\"{git_exec_path}\"\n"));
        }
        if let Some(git_config_system) = launch_env.get("GIT_CONFIG_SYSTEM") {
            content.push_str(&format!(
                "export GIT_CONFIG_SYSTEM=\"{git_config_system}\"\n"
            ));
        }
        if let Some(git_template_dir) = launch_env.get("GIT_TEMPLATE_DIR") {
            content.push_str(&format!("export GIT_TEMPLATE_DIR=\"{git_template_dir}\"\n"));
        }
        if let Some(path_value) = launch_env.get("PATH") {
            content.push_str(&format!("export PATH=\"{path_value}\"\n"));
        }
        content.push_str("exec bun run electron:dev\n");
        let _ = fs::write(&script_path, &content).await;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&script_path).await {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&script_path, perms).await;
            }
        }
    }

    script_path.to_string_lossy().to_string()
}

async fn write_default_env_file(install_dir: &str) -> Result<(), String> {
    fs::write(env_file_of(install_dir), DEFAULT_ENV_FILE_CONTENTS)
        .await
        .map_err(|e| format!("Failed to write {ENV_FILE_NAME}: {e}"))
}

// ── Windows registry ────────────────────────────────────────────────

const REG_UNINSTALL: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Stella";

async fn write_registry(manifest: &Manifest) {
    if !cfg!(target_os = "windows") {
        return;
    }

    let size_kb = (ESTIMATED_INSTALL_BYTES / 1024).to_string();
    let launcher_exe = std::env::current_exe().ok();
    let display_icon = launcher_exe
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| manifest.launch_script.clone());
    let uninstall_string = launcher_exe
        .as_ref()
        .map(|path| {
            crate::bootstrap::windows_uninstall_command(
                path,
                Some(Path::new(&manifest.install_path)),
            )
        })
        .unwrap_or_else(|| manifest.launch_script.clone());
    let entries = vec![
        ("DisplayName", "REG_SZ", "Stella".to_string()),
        ("DisplayVersion", "REG_SZ", manifest.version.clone()),
        ("Publisher", "REG_SZ", "Stella".to_string()),
        ("InstallLocation", "REG_SZ", manifest.install_path.clone()),
        ("DisplayIcon", "REG_SZ", display_icon),
        ("UninstallString", "REG_SZ", uninstall_string),
        ("NoModify", "REG_DWORD", "1".to_string()),
        ("NoRepair", "REG_DWORD", "1".to_string()),
        ("EstimatedSize", "REG_DWORD", size_kb),
    ];

    for (name, reg_type, data) in entries {
        run(
            &[
                "reg",
                "add",
                REG_UNINSTALL,
                "/v",
                name,
                "/t",
                reg_type,
                "/d",
                &data,
                "/f",
            ],
            None,
        )
        .await;
    }
}

async fn remove_registry() {
    if cfg!(target_os = "windows") {
        run(&["reg", "delete", REG_UNINSTALL, "/f"], None).await;
    }
}

// ── Bun ─────────────────────────────────────────────────────────────

async fn bun_on_path() -> bool {
    if run(&["bun", "--version"], None).await.ok {
        return true;
    }

    // GUI apps don't inherit shell startup files, so keep the launcher process
    // PATH aligned with the Bun install location used by launch scripts.
    let bun_bin = bun_executable_of();

    if path_exists(&bun_bin).await {
        if let Some(bin_dir) = bun_bin.parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            std::env::set_var("PATH", prepend_path_entry(bin_dir, &current_path));
            return run(&["bun", "--version"], None).await.ok;
        }
    }

    false
}

async fn install_bun_globally() -> bool {
    if cfg!(target_os = "windows") {
        let result = run(
            &[
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "irm https://bun.sh/install.ps1 | iex",
            ],
            None,
        )
        .await;
        if !result.ok {
            return false;
        }
    } else {
        let result = run(
            &["bash", "-lc", "curl -fsSL https://bun.sh/install | bash"],
            None,
        )
        .await;
        if !result.ok {
            return false;
        }
    }

    bun_on_path().await
}

fn format_bytes_compact(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else if value >= MB {
        format!("{:.1} MB", value / MB)
    } else if value >= KB {
        format!("{:.1} KB", value / KB)
    } else {
        format!("{bytes} B")
    }
}

fn set_step_progress(
    state: &mut InstallerState,
    app: &AppHandle,
    id: &SetupStepId,
    detail: impl Into<String>,
    progress: Option<f64>,
) {
    if let Some(step) = state.steps.iter_mut().find(|s| &s.id == id) {
        step.detail = Some(detail.into());
        step.progress = progress.map(|value| value.clamp(0.0, 1.0));
    }
    emit_state_fast(state, app);
}

async fn install_payload_dependencies(
    install_dir: &str,
    state: &mut InstallerState,
    app: &AppHandle,
) -> Result<(), String> {
    let dir = Some(Path::new(install_dir));
    let result = run_bun_install_with_progress(install_dir, dir, state, app).await;
    if result.ok {
        ensure_electron_binary_installed(install_dir, state, app).await?;
        // This addon is optional at runtime: the desktop app already falls back to
        // Electron/native-helper permission checks when the native module is missing.
        if let Err(err) = ensure_mac_screen_capture_permissions_built(install_dir).await {
            log_install(
                install_dir,
                &format!(
                    "Optional mac-screen-capture-permissions build failed; continuing with fallbacks: {err}"
                ),
            )
            .await;
        }
        Ok(())
    } else {
        let mut output_sections = Vec::new();
        if !result.stderr.is_empty() {
            output_sections.push(format!("stderr:\n{}", result.stderr));
        }
        if !result.stdout.is_empty() {
            output_sections.push(format!("stdout:\n{}", result.stdout));
        }

        if !output_sections.is_empty() {
            log_install(
                install_dir,
                &format!(
                    "bun install --frozen-lockfile failed\n{}",
                    output_sections.join("\n\n")
                ),
            )
            .await;
        }

        let summary = if !result.stderr.is_empty() {
            result.stderr
        } else if !result.stdout.is_empty() {
            result.stdout
        } else {
            "bun install failed.".into()
        };

        Err(format!("bun install failed: {summary}"))
    }
}

async fn ensure_electron_binary_installed(
    install_dir: &str,
    state: &mut InstallerState,
    app: &AppHandle,
) -> Result<(), String> {
    set_step_progress(
        state,
        app,
        &SetupStepId::Payload,
        "Preparing Electron",
        Some(0.95),
    );
    log_install(install_dir, "Preparing Electron binary").await;

    let result = run(
        &["bun", "run", "electron:install"],
        Some(Path::new(install_dir)),
    )
    .await;
    if result.ok {
        return Ok(());
    }

    let summary = if !result.stderr.is_empty() {
        result.stderr
    } else if !result.stdout.is_empty() {
        result.stdout
    } else {
        "Electron binary install failed.".into()
    };
    log_install(
        install_dir,
        &format!("bun run electron:install failed\n{summary}"),
    )
    .await;
    Err(format!("Electron binary install failed: {summary}"))
}

async fn run_bun_install_with_progress(
    install_dir: &str,
    cwd: Option<&Path>,
    state: &mut InstallerState,
    app: &AppHandle,
) -> crate::shell::RunResult {
    let mut command = Command::new("bun");
    command
        .args(["install", "--frozen-lockfile"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("PATH", std::env::var("PATH").unwrap_or_default());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x08000000);
    }

    set_step_progress(
        state,
        app,
        &SetupStepId::Payload,
        "Installing dependencies with Bun",
        Some(0.82),
    );
    log_install(install_dir, "Installing desktop dependencies with Bun").await;

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return crate::shell::RunResult {
                ok: false,
                stdout: String::new(),
                stderr: "spawn failed".into(),
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stdout_line_tx = line_tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stdout_line_tx.send(line.clone());
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected.trim().to_string()
    });
    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = line_tx.send(line.clone());
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected.trim().to_string()
    });

    let mut tick_count: u64 = 0;
    let mut latest_line = String::new();
    let status = loop {
        while let Ok(line) = line_rx.try_recv() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                latest_line = trimmed.chars().take(120).collect();
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                tick_count += 1;
                let elapsed = tick_count * 2;
                let progress = 0.82 + (0.12 * (1.0 - (-(elapsed as f64) / 45.0).exp()));
                let detail = if latest_line.is_empty() {
                    format!("Installing dependencies with Bun ({elapsed}s)")
                } else {
                    format!("Bun: {latest_line}")
                };
                set_step_progress(state, app, &SetupStepId::Payload, detail, Some(progress));
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(err) => break Err(err),
        }
    };

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    match status {
        Ok(status) => crate::shell::RunResult {
            ok: status.success(),
            stdout,
            stderr,
        },
        Err(_) => crate::shell::RunResult {
            ok: false,
            stdout,
            stderr: if stderr.is_empty() {
                "spawn failed".into()
            } else {
                stderr
            },
        },
    }
}

async fn ensure_mac_screen_capture_permissions_built(install_dir: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }

    let module_dir = mac_screen_capture_permissions_dir_of(install_dir);
    if !path_exists(&module_dir).await {
        return Ok(());
    }

    let native_binary = mac_screen_capture_permissions_binary_of(install_dir);
    if path_exists(&native_binary).await {
        return Ok(());
    }

    let result = run(&["bun", "run", "native_build"], Some(module_dir.as_path())).await;
    if !result.ok {
        if result.stderr.is_empty() {
            return Err("mac-screen-capture-permissions native build failed.".into());
        }
        return Err(format!(
            "mac-screen-capture-permissions native build failed: {}",
            result.stderr
        ));
    }

    if path_exists(&native_binary).await {
        Ok(())
    } else {
        Err("mac-screen-capture-permissions native binary is still missing after build.".into())
    }
}

async fn ensure_parakeet_model_downloaded(install_dir: &str) -> Result<(), String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Ok(());
    }
    let helper = parakeet_helper_of(install_dir);
    if !path_exists(&helper).await {
        log_install(
            install_dir,
            "Skipping Parakeet model download because the local dictation helper is not present.",
        )
        .await;
        return Ok(());
    }
    let cache = parakeet_cache_dir_of(install_dir);
    fs::create_dir_all(&cache)
        .await
        .map_err(|e| format!("Failed to prepare Parakeet model cache: {e}"))?;
    log_install(install_dir, "Downloading local Parakeet dictation model").await;
    let helper_str = helper.to_string_lossy().to_string();
    let cache_str = cache.to_string_lossy().to_string();
    let result = run(
        &[&helper_str, "--download", "--cache-root", &cache_str],
        Some(desktop_dir_of(install_dir).as_path()),
    )
    .await;
    if result.ok {
        Ok(())
    } else {
        let detail = if result.stderr.is_empty() {
            result.stdout
        } else {
            result.stderr
        };
        Err(format!("Parakeet model download failed: {detail}"))
    }
}

// ── Tarball download + extract ──────────────────────────────────────

async fn download_and_extract_release(
    install_dir: &str,
    state: &mut InstallerState,
    app: &AppHandle,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let latest_url = release_latest_download_url();
    log_install(install_dir, &format!("Downloading {latest_url}")).await;
    set_step_progress(
        state,
        app,
        &SetupStepId::Payload,
        "Resolving Stella release",
        Some(0.02),
    );

    let r2_asset = match resolve_r2_desktop_asset(&client, install_dir).await {
        Ok(asset) => Some(asset),
        Err(err) => {
            log_install(
                install_dir,
                &format!("R2 desktop manifest unavailable; falling back to GitHub: {err}"),
            )
            .await;
            None
        }
    };

    let (resp, expected_sha256, expected_size) = if let Some(asset) = r2_asset {
        set_step_progress(
            state,
            app,
            &SetupStepId::Payload,
            "Connecting to Stella downloads",
            Some(0.04),
        );
        let resp = client
            .get(&asset.url)
            .header("User-Agent", "stella-launcher")
            .send()
            .await
            .map_err(|e| format!("Download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Download failed: HTTP {}", resp.status()));
        }
        (resp, Some(asset.sha256), Some(asset.size))
    } else {
        set_step_progress(
            state,
            app,
            &SetupStepId::Payload,
            "Connecting to GitHub",
            Some(0.04),
        );
        let resp = client
            .get(&latest_url)
            .header("User-Agent", "stella-launcher")
            .send()
            .await
            .map_err(|e| format!("Download failed: {e}"))?;

        let resp = if resp.status().is_success() {
            resp
        } else if resp.status() == reqwest::StatusCode::NOT_FOUND {
            let tag = latest_release_tag()
                .await
                .ok_or("Could not find a desktop release. Check your internet connection.")?;
            let url = release_download_url(&tag);
            log_install(
                install_dir,
                &format!("Latest release had no desktop asset; using tag {tag}: {url}"),
            )
            .await;
            set_step_progress(
                state,
                app,
                &SetupStepId::Payload,
                "Finding the desktop release",
                Some(0.05),
            );
            let resp = client
                .get(&url)
                .header("User-Agent", "stella-launcher")
                .send()
                .await
                .map_err(|e| format!("Download failed: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("Download failed: HTTP {}", resp.status()));
            }
            resp
        } else {
            return Err(format!("Download failed: HTTP {}", resp.status()));
        };
        (resp, None, None)
    };

    let total_bytes = resp.content_length().or(expected_size);
    fs::create_dir_all(install_dir)
        .await
        .map_err(|e| format!("mkdir failed: {e}"))?;
    let archive_path = Path::new(install_dir).join(".stella-desktop-download.tar.zst");
    let mut archive_file = fs::File::create(&archive_path)
        .await
        .map_err(|e| format!("Failed to prepare download file: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut digest = Sha256::new();
    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap_or_else(std::time::Instant::now);

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                let _ = fs::remove_file(&archive_path).await;
                return Err(format!("Download failed: {err}"));
            }
        };
        downloaded += chunk.len() as u64;
        digest.update(&chunk);
        if let Err(err) = archive_file.write_all(&chunk).await {
            let _ = fs::remove_file(&archive_path).await;
            return Err(format!("Failed to write download file: {err}"));
        }

        if last_emit.elapsed() >= std::time::Duration::from_millis(300) {
            let detail = if let Some(total) = total_bytes {
                format!(
                    "Downloading Stella {} of {}",
                    format_bytes_compact(downloaded),
                    format_bytes_compact(total)
                )
            } else {
                format!("Downloading Stella {}", format_bytes_compact(downloaded))
            };
            let progress = total_bytes
                .filter(|total| *total > 0)
                .map(|total| 0.05 + ((downloaded as f64 / total as f64).min(1.0) * 0.65));
            set_step_progress(state, app, &SetupStepId::Payload, detail, progress);
            last_emit = std::time::Instant::now();
        }
    }
    if let Err(err) = archive_file.flush().await {
        let _ = fs::remove_file(&archive_path).await;
        return Err(format!("Failed to finish download file: {err}"));
    }
    drop(archive_file);

    if let Some(expected) = expected_sha256 {
        if let Err(err) = verify_sha256_digest(digest, &expected) {
            let _ = fs::remove_file(&archive_path).await;
            return Err(err);
        }
    }

    log_install(
        install_dir,
        &format!("Downloaded {downloaded} bytes, extracting..."),
    )
    .await;
    set_step_progress(
        state,
        app,
        &SetupStepId::Payload,
        "Extracting Stella",
        Some(0.72),
    );

    // Decompress zstd then untar — do in blocking task to avoid blocking async runtime
    let install_path = install_dir.to_string();
    let archive_path_for_extract = archive_path.clone();
    let extract_result = tokio::task::spawn_blocking(move || {
        let archive_file = std::fs::File::open(&archive_path_for_extract)
            .map_err(|e| format!("open archive failed: {e}"))?;
        let decoder =
            zstd::Decoder::new(archive_file).map_err(|e| format!("zstd decompress failed: {e}"))?;
        let mut archive = tar::Archive::new(decoder);

        std::fs::create_dir_all(&install_path).map_err(|e| format!("mkdir failed: {e}"))?;

        for entry in archive
            .entries()
            .map_err(|e| format!("tar read failed: {e}"))?
        {
            let mut entry = entry.map_err(|e| format!("tar entry read failed: {e}"))?;
            let relative_path = entry
                .path()
                .map_err(|e| format!("tar entry path failed: {e}"))?
                .to_path_buf();
            let is_state_entry = relative_path
                .components()
                .find_map(|component| match component {
                    std::path::Component::Normal(value) => Some(value == "state"),
                    _ => None,
                })
                .unwrap_or(false);
            let target_path = Path::new(&install_path).join(&relative_path);
            if is_state_entry && target_path.exists() {
                continue;
            }
            entry
                .unpack_in(&install_path)
                .map_err(|e| format!("tar extract failed: {e}"))?;
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Extract task failed: {e}"))
    .and_then(|result| result);
    let _ = fs::remove_file(&archive_path).await;
    extract_result?;

    log_install(install_dir, "Extraction complete").await;
    set_step_progress(
        state,
        app,
        &SetupStepId::Payload,
        "Stella files extracted",
        Some(0.8),
    );
    Ok(())
}

async fn download_and_extract_native_helpers(
    install_dir: &str,
    state: &mut InstallerState,
    app: &AppHandle,
) -> Result<(), String> {
    let platform = native_helpers_platform_key();
    let manifest_url = native_helpers_manifest_url();
    log_install(
        install_dir,
        &format!("Resolving native helpers manifest: {manifest_url}"),
    )
    .await;
    set_step_progress(
        state,
        app,
        &SetupStepId::NativeHelpers,
        "Looking up native helpers",
        Some(0.05),
    );

    let client = reqwest::Client::new();
    let manifest_text = fetch_required_text(&client, &manifest_url).await?;
    let manifest: NativeHelpersManifest = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("Native helpers manifest was invalid JSON: {e}"))?;
    if manifest.schema_version != 1 {
        return Err("Native helpers manifest schema is not supported.".into());
    }

    let asset = manifest.assets.get(platform).cloned().ok_or_else(|| {
        format!("Native helpers manifest did not include an asset for {platform}.")
    })?;

    log_install(
        install_dir,
        &format!(
            "Downloading native helpers ({}{}) from {}",
            manifest.sha.as_deref().unwrap_or("unknown"),
            manifest
                .commit
                .as_deref()
                .map(|c| format!(" / {c}"))
                .unwrap_or_default(),
            asset.url,
        ),
    )
    .await;
    set_step_progress(
        state,
        app,
        &SetupStepId::NativeHelpers,
        "Downloading native helpers",
        Some(0.15),
    );

    let resp = client
        .get(&asset.url)
        .header("User-Agent", "stella-launcher")
        .send()
        .await
        .map_err(|e| format!("Native helpers download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Native helpers download failed: HTTP {}",
            resp.status()
        ));
    }

    let total_bytes = resp.content_length();
    let archive_path = Path::new(install_dir).join(".stella-native-helpers-download.tar.zst");
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let mut archive_file = fs::File::create(&archive_path)
        .await
        .map_err(|e| format!("Failed to prepare native helpers download: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut digest = Sha256::new();
    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap_or_else(std::time::Instant::now);

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                let _ = fs::remove_file(&archive_path).await;
                return Err(format!("Native helpers download failed: {err}"));
            }
        };
        downloaded += chunk.len() as u64;
        digest.update(&chunk);
        if let Err(err) = archive_file.write_all(&chunk).await {
            let _ = fs::remove_file(&archive_path).await;
            return Err(format!("Failed to write native helpers download: {err}"));
        }
        if last_emit.elapsed() >= std::time::Duration::from_millis(300) {
            let detail = if let Some(total) = total_bytes {
                format!(
                    "Downloading native helpers {} of {}",
                    format_bytes_compact(downloaded),
                    format_bytes_compact(total)
                )
            } else {
                format!("Downloading native helpers {}", format_bytes_compact(downloaded))
            };
            let progress = total_bytes
                .filter(|total| *total > 0)
                .map(|total| 0.15 + ((downloaded as f64 / total as f64).min(1.0) * 0.55));
            set_step_progress(state, app, &SetupStepId::NativeHelpers, detail, progress);
            last_emit = std::time::Instant::now();
        }
    }
    if let Err(err) = archive_file.flush().await {
        let _ = fs::remove_file(&archive_path).await;
        return Err(format!("Failed to finish native helpers download: {err}"));
    }
    drop(archive_file);

    if let Err(err) = verify_sha256_digest(digest, &asset.sha256) {
        let _ = fs::remove_file(&archive_path).await;
        return Err(err);
    }

    set_step_progress(
        state,
        app,
        &SetupStepId::NativeHelpers,
        "Extracting native helpers",
        Some(0.78),
    );

    let helpers_dir = native_helpers_dir_of(install_dir);
    let helpers_dir_str = helpers_dir.to_string_lossy().to_string();
    let archive_path_for_extract = archive_path.clone();
    let extract_result = tokio::task::spawn_blocking(move || {
        let archive_file = std::fs::File::open(&archive_path_for_extract)
            .map_err(|e| format!("open native helpers archive failed: {e}"))?;
        let decoder = zstd::Decoder::new(archive_file)
            .map_err(|e| format!("native helpers zstd decompress failed: {e}"))?;
        let mut archive = tar::Archive::new(decoder);

        std::fs::create_dir_all(&helpers_dir_str)
            .map_err(|e| format!("mkdir native helpers dir failed: {e}"))?;
        // Wipe stale binaries — old contents may shadow renamed/removed helpers.
        if let Ok(entries) = std::fs::read_dir(&helpers_dir_str) {
            for entry in entries.flatten() {
                let _ = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    std::fs::remove_dir_all(entry.path())
                } else {
                    std::fs::remove_file(entry.path())
                };
            }
        }

        archive
            .unpack(&helpers_dir_str)
            .map_err(|e| format!("native helpers tar extract failed: {e}"))?;

        // Belt-and-suspenders: ensure exec bits on Unix. tar should preserve
        // them, but Rust's tar crate has historically lost them across some zstd
        // pipelines; explicitly walking the dir is cheap and idempotent.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fn chmod_recursive(path: &std::path::Path) -> std::io::Result<()> {
                if path.is_dir() {
                    for entry in std::fs::read_dir(path)? {
                        let entry = entry?;
                        chmod_recursive(&entry.path())?;
                    }
                } else if path.is_file() {
                    let mut perms = std::fs::metadata(path)?.permissions();
                    perms.set_mode(0o755);
                    std::fs::set_permissions(path, perms)?;
                }
                Ok(())
            }
            let _ = chmod_recursive(std::path::Path::new(&helpers_dir_str));
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Native helpers extract task failed: {e}"))
    .and_then(|result| result);
    let _ = fs::remove_file(&archive_path).await;
    extract_result?;

    log_install(install_dir, "Native helpers extracted").await;
    set_step_progress(
        state,
        app,
        &SetupStepId::NativeHelpers,
        "Native helpers ready",
        Some(0.95),
    );
    Ok(())
}

async fn remove_install_files_preserving_state(install_path: &str) -> Result<(), String> {
    let electron_user_data_path = Path::new(install_path)
        .join("state")
        .join(ELECTRON_USER_DATA_DIR_NAME);
    if path_exists(&electron_user_data_path).await {
        fs::remove_dir_all(&electron_user_data_path)
            .await
            .map_err(|e| format!("Failed to remove Stella app startup data: {e}"))?;
    }

    let mut entries = fs::read_dir(install_path)
        .await
        .map_err(|e| format!("Failed to read Stella install directory: {e}"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read Stella install entry: {e}"))?
    {
        if entry.file_name() == "state" {
            continue;
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| format!("Failed to inspect Stella install entry: {e}"))?;
        if file_type.is_dir() {
            fs::remove_dir_all(&path)
                .await
                .map_err(|e| format!("Failed to remove Stella directory: {e}"))?;
        } else {
            fs::remove_file(&path)
                .await
                .map_err(|e| format!("Failed to remove Stella file: {e}"))?;
        }
    }
    Ok(())
}

async fn fetch_required_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .header("User-Agent", "stella-launcher")
        .send()
        .await
        .map_err(|e| format!("Request failed for {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Request failed for {url}: HTTP {}",
            response.status()
        ));
    }
    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body from {url}: {e}"))
}

fn sha256_digest_hex(digest: Sha256) -> String {
    let hash = digest.finalize();
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn verify_sha256_digest(digest: Sha256, expected: &str) -> Result<(), String> {
    let normalized = normalize_sha256(expected)
        .ok_or_else(|| "Release checksum metadata was invalid.".to_string())?;
    let actual = sha256_digest_hex(digest);
    if actual == normalized {
        Ok(())
    } else {
        Err("Release checksum did not match the downloaded archive.".into())
    }
}

async fn resolve_r2_desktop_asset(
    client: &reqwest::Client,
    install_dir: &str,
) -> Result<DesktopDownloadAsset, String> {
    let manifest_url = desktop_release_manifest_url();
    log_install(
        install_dir,
        &format!("Resolving desktop release manifest: {manifest_url}"),
    )
    .await;
    let manifest_text = fetch_required_text(client, &manifest_url).await?;
    let manifest: DesktopDownloadManifest = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("Desktop release manifest was invalid JSON: {e}"))?;
    if manifest.schema_version != 1 {
        return Err("Desktop release manifest schema is not supported.".into());
    }
    let platform = desktop_platform_key();
    let asset = manifest.assets.get(platform).cloned().ok_or_else(|| {
        format!("Desktop release manifest did not include an asset for {platform}.")
    })?;
    log_install(
        install_dir,
        &format!(
            "Resolved desktop release {} for {platform}: {}",
            manifest.tag, asset.url
        ),
    )
    .await;
    Ok(asset)
}

async fn read_release_manifest_at(path: &Path) -> Result<DesktopReleaseManifest, String> {
    let raw = fs::read_to_string(path)
        .await
        .map_err(|e| format!("Failed to read release manifest: {e}"))?;
    let manifest = serde_json::from_str::<DesktopReleaseManifest>(&raw)
        .map_err(|e| format!("Release manifest was invalid JSON: {e}"))?;
    if manifest.schema_version != 1 {
        return Err("Release manifest schema is not supported.".into());
    }
    Ok(manifest)
}

async fn read_release_manifest(install_dir: &str) -> Result<DesktopReleaseManifest, String> {
    read_release_manifest_at(&release_manifest_of(install_dir)).await
}

// ── Git init for self-mod ───────────────────────────────────────────

/// Builds a fresh local git repo at the install root with **real upstream
/// history attached**. The flow is:
///
/// 1. `git init` + add `origin` pointing at the public Stella repo.
/// 2. `git fetch --filter=blob:none origin <installCommit>` — pulls every
///    commit's metadata back to the root, but skips file blobs (they get
///    lazy-fetched on demand by `git show`/`git diff`). Typically <30 MB.
/// 3. `git reset --mixed <installCommit>` — moves HEAD to the real upstream
///    SHA the tarball was built from. The working tree (already on disk
///    from the tarball) matches that commit byte-for-byte because the
///    release workflow now uses `git archive HEAD` to produce it, modulo
///    the synthetic `stella-release.json`.
/// 4. `git add -A && git commit --allow-empty -m "Stella install baseline"`
///    — captures the synthetic file (and any tiny tarball-vs-commit drift)
///    as the user's first local commit on top of upstream history.
///
/// The result is a local repo with full upstream history where self-mod
/// commits accrue on top of a real upstream SHA — so the install-update
/// agent can `git fetch origin <newer>` + `git merge` and let git do the
/// three-way merge work properly.
async fn init_git_repo(install_dir: &str) {
    let git_dir = Path::new(install_dir).join(".git");
    if path_exists(&git_dir).await {
        return; // Already has a git repo
    }

    let git_bin = dugite_git_bin_of(install_dir);
    if !path_exists(&git_bin).await {
        return;
    }

    let env = dugite_launch_env(install_dir);
    let cwd = PathBuf::from(install_dir);
    let install_commit = read_release_manifest(install_dir)
        .await
        .ok()
        .and_then(|m| m.commit);

    let run_git = |args: Vec<String>| {
        let git_bin = git_bin.clone();
        let cwd = cwd.clone();
        let env = env.clone();
        async move {
            let mut cmd = Command::new(&git_bin);
            cmd.args(&args).current_dir(&cwd).envs(&env);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            cmd.output().await
        }
    };

    let _ = run_git(vec!["--version".into()]).await;
    let _ = run_git(vec!["init".into()]).await;
    let _ = run_git(vec![
        "remote".into(),
        "add".into(),
        "origin".into(),
        STELLA_GITHUB_REMOTE_URL.into(),
    ])
    .await;

    let baseline_message = match &install_commit {
        Some(commit) if !commit.is_empty() => {
            // Lazy partial fetch: pull all commit/tree metadata back to root
            // for the tarball's commit, but skip file blobs (loaded on
            // demand by `git show`/`git diff` when the install-update agent
            // actually inspects them).
            let fetch_result = run_git(vec![
                "fetch".into(),
                "--filter=blob:none".into(),
                "--no-tags".into(),
                "origin".into(),
                commit.clone(),
            ])
            .await;

            let fetched_ok = fetch_result
                .as_ref()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if fetched_ok {
                // Move HEAD to the real upstream SHA without touching the
                // working tree (which already has the upstream files from
                // the tarball). `--mixed` updates the index, so any drift
                // (e.g., the synthetic stella-release.json) shows as
                // staged changes for the baseline commit below.
                let _ = run_git(vec!["reset".into(), "--mixed".into(), commit.clone()]).await;
                "Stella install baseline".to_string()
            } else {
                // Network problem at install time: fall back to a
                // synthetic-root repo. The install-update agent will
                // self-heal by fetching at update time.
                "start".to_string()
            }
        }
        _ => "start".to_string(),
    };

    let _ = run_git(vec!["add".into(), "-A".into()]).await;
    let _ = run_git(vec![
        "-c".into(),
        "user.name=Stella".into(),
        "-c".into(),
        "user.email=install@stella.local".into(),
        "commit".into(),
        "--allow-empty".into(),
        "-m".into(),
        baseline_message,
    ])
    .await;

    // Capture the local baseline commit SHA so the install-update agent
    // has a stable boundary marker between user-local commits and
    // upstream history (everything reachable from HEAD~1 is upstream).
    if let Ok(output) = run_git(vec!["rev-parse".into(), "HEAD".into()]).await {
        if output.status.success() {
            let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !sha.is_empty() {
                let _ = update_manifest_install_base_commit(install_dir, &sha).await;
            }
        }
    }
}

async fn update_manifest_install_base_commit(install_dir: &str, sha: &str) -> Result<(), String> {
    let manifest_path = manifest_of(install_dir);
    let raw = fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| format!("Failed to read install manifest: {e}"))?;
    let mut manifest: Manifest = serde_json::from_str(&raw)
        .map_err(|e| format!("Install manifest was invalid JSON: {e}"))?;
    manifest.desktop_install_base_commit = Some(sha.to_string());
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize install manifest: {e}"))?;
    fs::write(&manifest_path, json)
        .await
        .map_err(|e| format!("Failed to persist install manifest: {e}"))
}

fn schedule_git_repo_init(install_dir: String) {
    tokio::spawn(async move {
        init_git_repo(&install_dir).await;
    });
}

// ── Logging ─────────────────────────────────────────────────────────

async fn log_install(dir: &str, msg: &str) {
    let log_path = Path::new(dir).join("stella-install.log");
    let timestamp = chrono_now();
    let line = format!("[{timestamp}] {msg}\n");
    if let Ok(mut contents) = fs::read_to_string(&log_path).await {
        contents.push_str(&line);
        let _ = fs::write(&log_path, contents).await;
    } else {
        let _ = fs::create_dir_all(dir).await;
        let _ = fs::write(&log_path, &line).await;
    }
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_secs().to_string()
}

// ── Step infrastructure ─────────────────────────────────────────────

struct StepDef {
    id: SetupStepId,
    label: &'static str,
}

fn build_step_defs() -> Vec<StepDef> {
    vec![
        StepDef {
            id: SetupStepId::Runtime,
            label: "Setting up",
        },
        StepDef {
            id: SetupStepId::Payload,
            label: "Downloading Stella",
        },
        StepDef {
            id: SetupStepId::NativeHelpers,
            label: "Installing native helpers",
        },
        StepDef {
            id: SetupStepId::Parakeet,
            label: "Preparing local dictation",
        },
        StepDef {
            id: SetupStepId::Finalize,
            label: "Finishing up",
        },
    ]
}

async fn check_step(id: &SetupStepId, state: &InstallerState) -> bool {
    let dir = &state.install_path;
    match id {
        SetupStepId::Runtime => bun_on_path().await,
        SetupStepId::Payload => payload_step_complete(dir).await,
        SetupStepId::NativeHelpers => native_helpers_step_complete(dir).await,
        SetupStepId::Parakeet => parakeet_step_complete(dir).await,
        SetupStepId::Finalize => {
            if state.dev_mode {
                true
            } else {
                path_exists(&manifest_of(dir)).await
            }
        }
        _ => true,
    }
}

async fn payload_step_complete(dir: &str) -> bool {
    if !path_exists(&node_modules_of(dir)).await {
        return false;
    }
    if !looks_like_stella_source_tree(Path::new(dir)) {
        return false;
    }
    let Ok(manifest) = read_release_manifest(dir).await else {
        return false;
    };
    if manifest.files.is_empty() {
        return false;
    }
    for relative_path in manifest.files.keys() {
        if !path_exists(&Path::new(dir).join(relative_path)).await {
            return false;
        }
    }
    true
}

async fn native_helpers_step_complete(dir: &str) -> bool {
    let helpers_dir = native_helpers_dir_of(dir);
    if !path_exists(&helpers_dir).await {
        return false;
    }
    // Sentinel: pick a binary that ships on every supported platform.
    let sentinel = if cfg!(target_os = "windows") {
        helpers_dir.join("window_info.exe")
    } else {
        helpers_dir.join("window_info")
    };
    path_exists(&sentinel).await
}

async fn parakeet_step_complete(dir: &str) -> bool {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return true;
    }
    if !path_exists(&parakeet_helper_of(dir)).await {
        // Helper hasn't been delivered yet (payload + native helpers still to
        // run), so report not-complete to allow the parakeet step to run later.
        return native_helpers_step_complete(dir).await
            && payload_step_complete(dir).await;
    }
    path_exists(&parakeet_cache_dir_of(dir).join("FluidAudio")).await
        || path_exists(&parakeet_cache_dir_of(dir).join("fluidaudio")).await
}

async fn install_step(
    id: &SetupStepId,
    state: &mut InstallerState,
    app: &AppHandle,
) -> Result<(), String> {
    let dir = state.install_path.clone();
    match id {
        SetupStepId::Runtime => {
            if bun_on_path().await {
                return Ok(());
            }
            if install_bun_globally().await {
                Ok(())
            } else {
                Err("Failed to install Bun runtime. Check your internet connection.".into())
            }
        }
        SetupStepId::Payload => {
            let _ = fs::create_dir_all(&dir).await;
            download_and_extract_release(&dir, state, app).await?;
            write_default_env_file(&dir).await?;
            set_step_progress(
                state,
                app,
                &SetupStepId::Payload,
                "Writing app configuration",
                Some(0.81),
            );
            install_payload_dependencies(&dir, state, app).await?;
            Ok(())
        }
        SetupStepId::NativeHelpers => {
            download_and_extract_native_helpers(&dir, state, app).await
        }
        SetupStepId::Parakeet => {
            if let Err(err) = ensure_parakeet_model_downloaded(&dir).await {
                let warning = format!(
                    "Local dictation setup was skipped. Stella will still work, but on-device dictation may be unavailable. ({err})"
                );
                log_install(&dir, &format!("Parakeet install warning: {warning}")).await;
                state.warning_message = Some(warning);
            }
            Ok(())
        }
        SetupStepId::Finalize => {
            let script_path = write_launch_script(&dir).await;
            let release_manifest = read_release_manifest(&dir).await.ok();

            // Init git repo for self-mod in the background so install completion
            // does not wait on indexing tens of thousands of extracted files.

            let manifest = Manifest {
                version: env!("CARGO_PKG_VERSION").into(),
                desktop_release_tag: release_manifest
                    .as_ref()
                    .map(|manifest| manifest.tag.clone()),
                desktop_archive_sha256: None,
                desktop_release_commit: release_manifest
                    .as_ref()
                    .and_then(|manifest| manifest.commit.clone()),
                desktop_install_base_commit: None,
                platform: std::env::consts::OS.into(),
                installed_at: chrono_now(),
                install_path: dir.clone(),
                launch_script: script_path,
                shortcuts: HashMap::new(),
            };

            let json = serde_json::to_string_pretty(&manifest).unwrap_or_default();
            fs::write(manifest_of(&dir), json)
                .await
                .map_err(|e| format!("Failed to write manifest: {e}"))?;

            schedule_git_repo_init(dir.clone());

            write_registry(&manifest).await;
            Ok(())
        }
        _ => Ok(()),
    }
}

// ── State management ────────────────────────────────────────────────

fn sync_step_list(state: &mut InstallerState) {
    let defs = build_step_defs();
    let mut new_steps = Vec::new();
    for def in &defs {
        if let Some(existing) = state.steps.iter().find(|s| s.id == def.id) {
            new_steps.push(existing.clone());
        } else {
            new_steps.push(SetupStep {
                id: def.id.clone(),
                label: def.label.to_string(),
                status: SetupStepStatus::Pending,
                detail: None,
                progress: None,
            });
        }
    }
    state.steps = new_steps;
}

async fn refresh_derived(state: &mut InstallerState, ctx: &InstallerContext) {
    let avail = disk::available_bytes(&state.install_path).await;

    state.disk = DiskInfo {
        required_bytes: ctx.required_bytes,
        available_bytes: avail,
        used_bytes: 0, // Skip expensive dir walk
        enough_space: avail.map_or(true, |a| a >= ctx.required_bytes),
    };

    state.install_path_error = location_error(&state.install_path);

    let has_manifest = path_exists(&manifest_of(&state.install_path)).await;
    let has_payload = payload_step_complete(&state.install_path).await;
    let has_native_helpers = native_helpers_step_complete(&state.install_path).await;
    state.can_launch = if state.dev_mode {
        looks_like_stella_source_tree(Path::new(&state.install_path))
            && path_exists(&node_modules_of(&state.install_path)).await
    } else {
        has_manifest && has_payload && has_native_helpers
    };
    state.warning_message = None;
}

fn emit_state_fast(state: &InstallerState, app: &AppHandle) {
    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": state }),
    );
}

async fn emit_state_full(state: &mut InstallerState, ctx: &InstallerContext, app: &AppHandle) {
    refresh_derived(state, ctx).await;
    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*state }),
    );
}

// ── Public API ──────────────────────────────────────────────────────

pub fn create_context(
    default_install_path: String,
    settings_file_path: PathBuf,
    dev_mode: bool,
) -> InstallerContext {
    InstallerContext {
        default_install_path,
        settings_file_path,
        required_bytes: ESTIMATED_INSTALL_BYTES,
        dev_mode,
    }
}

pub async fn create_initial_state(ctx: &InstallerContext) -> InstallerState {
    let settings = read_settings(ctx).await;
    let install_path = if ctx.dev_mode {
        norm(&ctx.default_install_path)
    } else {
        resolve_install_path(
            settings
                .installed_path
                .as_deref()
                .or(settings.install_path.as_deref())
                .unwrap_or(&ctx.default_install_path),
        )
    };

    let mut state = InstallerState {
        steps: vec![],
        phase: InstallerPhase::Checking,
        error_message: None,
        warning_message: None,
        install_path,
        default_install_path: ctx.default_install_path.clone(),
        dev_mode: ctx.dev_mode,
        install_path_locked: ctx.dev_mode,
        install_path_error: None,
        run_after_install: settings.run_after_install.unwrap_or(true),
        can_launch: false,
        installed: false,
        launcher_update: LauncherUpdateInfo::default(),
        disk: DiskInfo {
            required_bytes: ctx.required_bytes,
            available_bytes: None,
            used_bytes: 0,
            enough_space: true,
        },
    };

    refresh_derived(&mut state, ctx).await;
    sync_step_list(&mut state);
    state
}

pub async fn set_install_path(
    state: &mut InstallerState,
    ctx: &InstallerContext,
    install_path: &str,
) {
    if ctx.dev_mode {
        state.install_path = norm(&ctx.default_install_path);
        state.error_message = None;
        state.warning_message = None;
        return;
    }
    state.install_path = resolve_install_path(install_path);
    state.error_message = None;
    state.warning_message = None;
    write_settings(ctx, state).await;
}

pub async fn set_run_after_install(
    state: &mut InstallerState,
    ctx: &InstallerContext,
    value: bool,
) {
    if ctx.dev_mode {
        state.run_after_install = true;
        return;
    }
    state.run_after_install = value;
    write_settings(ctx, state).await;
}

pub async fn check_all(state: &mut InstallerState, ctx: &InstallerContext, app: &AppHandle) {
    state.phase = InstallerPhase::Checking;
    state.error_message = None;
    state.warning_message = None;
    sync_step_list(state);
    emit_state_fast(state, app);

    let defs = build_step_defs();
    let mut all_done = true;

    for def in &defs {
        let ok = check_step(&def.id, state).await;

        if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
            step.status = if ok {
                SetupStepStatus::Skipped
            } else {
                SetupStepStatus::Pending
            };
            step.detail = None;
            step.progress = None;
        }

        if !ok {
            all_done = false;
        }
    }

    state.installed = all_done;
    state.phase = if all_done {
        InstallerPhase::Complete
    } else {
        InstallerPhase::Ready
    };
    emit_state_full(state, ctx, app).await;
}

pub async fn install_all(
    state: &mut InstallerState,
    ctx: &InstallerContext,
    app: &AppHandle,
) -> Result<(), String> {
    refresh_derived(state, ctx).await;

    if let Some(err) = &state.install_path_error {
        let msg = err.clone();
        state.phase = InstallerPhase::Error;
        state.error_message = Some(msg.clone());
        emit_state_fast(state, app);
        return Err(msg);
    }

    if !state.disk.enough_space {
        let msg = "Not enough free disk space.".to_string();
        state.phase = InstallerPhase::Error;
        state.error_message = Some(msg.clone());
        emit_state_fast(state, app);
        return Err(msg);
    }

    sync_step_list(state);
    state.phase = InstallerPhase::Installing;
    state.error_message = None;
    state.warning_message = None;
    emit_state_fast(state, app);

    let defs = build_step_defs();

    for def in &defs {
        let should_skip = state
            .steps
            .iter()
            .find(|s| s.id == def.id)
            .map_or(false, |s| {
                s.status == SetupStepStatus::Skipped || s.status == SetupStepStatus::Done
            });

        if should_skip {
            continue;
        }

        if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
            step.status = SetupStepStatus::Installing;
            step.detail = Some(def.label.to_string());
            step.progress = None;
        }
        emit_state_fast(state, app);

        let result = install_step(&def.id, state, app).await;

        if let Err(err) = result {
            log_install(
                &state.install_path,
                &format!("Step '{}' failed: {}", def.label, err),
            )
            .await;
            if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
                step.status = SetupStepStatus::Error;
                step.detail = Some(err.clone());
            }
            state.phase = InstallerPhase::Error;
            state.error_message = Some(err.clone());
            emit_state_fast(state, app);
            return Err(err);
        }

        if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
            step.status = SetupStepStatus::Done;
            step.progress = None;
        }
        emit_state_fast(state, app);
    }

    state.installed = true;
    state.phase = InstallerPhase::Complete;
    write_settings(ctx, state).await;
    emit_state_full(state, ctx, app).await;

    Ok(())
}

pub async fn get_launch_info(state: &InstallerState) -> Option<LaunchInfo> {
    let dir = &state.install_path;
    if !path_exists(&package_json_of(dir)).await {
        return None;
    }

    let mut env = dugite_launch_env(dir);
    if let Ok(exe) = std::env::current_exe() {
        env.insert(
            "STELLA_LAUNCHER_PROTECTED_STORAGE_BIN".into(),
            exe.to_string_lossy().to_string(),
        );
    }
    env.insert("STELLA_LAUNCHER_MANAGED_RUNTIME".into(), "1".into());

    Some(LaunchInfo {
        command: vec!["bun".into(), "run".into(), "electron:dev".into()],
        cwd: dir.clone(),
        env,
    })
}

pub async fn uninstall(state: &mut InstallerState) -> Result<(), String> {
    if path_exists_str(&state.install_path).await {
        if !is_uninstallable_install_path(&state.install_path) {
            let msg =
                "Refusing to remove a folder that does not look like a Stella install.".to_string();
            state.phase = InstallerPhase::Error;
            state.error_message = Some(msg.clone());
            return Err(msg);
        }
        remove_install_files_preserving_state(&state.install_path).await?;
    }

    remove_registry().await;

    state.installed = false;
    state.phase = InstallerPhase::Ready;
    state.error_message = None;
    state.steps.clear();
    state.warning_message = None;
    sync_step_list(state);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("stella-launcher-{label}-{unique}"));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_install_shape(path: &Path) {
        fs::create_dir_all(path.join("desktop")).expect("create desktop dir");
        fs::create_dir_all(path.join("runtime")).expect("create runtime dir");
        fs::write(path.join("package.json"), r#"{"name":"stella"}"#).expect("write package");
    }

    fn write_release_manifest(path: &Path, files: &[&str]) {
        let files_json = files
            .iter()
            .map(|file| format!(r#""{file}":{{"sha256":"abc"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        fs::write(
            path.join(RELEASE_MANIFEST),
            format!(r#"{{"schemaVersion":1,"tag":"desktop-v0.0.1","files":{{{files_json}}}}}"#),
        )
        .expect("write release manifest");
    }

    fn write_generic_package_shape(path: &Path) {
        fs::write(path.join("package.json"), r#"{"name":"other-app"}"#).expect("write package");
    }

    #[test]
    fn resolve_install_path_adds_stella_folder_for_parent_paths() {
        let dir = TestDir::new("parent");
        let resolved = resolve_install_path(&dir.path.to_string_lossy());
        let resolved_path = PathBuf::from(&resolved);
        assert_eq!(
            resolved_path.file_name().and_then(|value| value.to_str()),
            Some(INSTALL_DIR_NAME)
        );
        assert_eq!(
            norm(
                &resolved_path
                    .parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
            ),
            norm(&dir.path.to_string_lossy())
        );
    }

    #[test]
    fn resolve_install_path_preserves_existing_install_dirs() {
        let dir = TestDir::new("existing-install");
        write_install_shape(&dir.path);

        let resolved = resolve_install_path(&dir.path.to_string_lossy());
        assert_eq!(resolved, norm(&dir.path.to_string_lossy()));
    }

    #[test]
    fn location_error_rejects_nonempty_unmanaged_dirs() {
        let dir = TestDir::new("unmanaged");
        fs::write(dir.path.join("notes.txt"), "hello\n").expect("write unmanaged file");

        let error = location_error(&dir.path.to_string_lossy()).expect("expected location error");
        assert!(error.contains("own"));
        assert!(error.contains(INSTALL_DIR_NAME));
    }

    #[test]
    fn location_error_rejects_generic_package_dirs() {
        let dir = TestDir::new("generic-package");
        write_generic_package_shape(&dir.path);

        let error = location_error(&dir.path.to_string_lossy()).expect("expected location error");
        assert!(error.contains("own"));
        assert!(error.contains(INSTALL_DIR_NAME));
    }

    #[test]
    fn location_error_allows_state_only_install_dirs() {
        let dir = TestDir::new("state-only");
        fs::create_dir_all(dir.path.join("state")).expect("create state dir");
        fs::write(dir.path.join("state").join("stella.sqlite"), "db").expect("write state file");

        assert_eq!(location_error(&dir.path.to_string_lossy()), None);
    }

    #[test]
    fn location_error_allows_state_only_install_dirs_with_benign_leftovers() {
        let dir = TestDir::new("state-only-leftovers");
        fs::create_dir_all(dir.path.join("state")).expect("create state dir");
        fs::write(dir.path.join("state").join("stella.sqlite"), "db").expect("write state file");
        fs::write(dir.path.join(".DS_Store"), "").expect("write ds store");
        fs::write(dir.path.join("stella-install.log"), "log").expect("write log");
        fs::write(dir.path.join(".stella-desktop-download.tar.zst"), "")
            .expect("write temp archive");

        assert_eq!(location_error(&dir.path.to_string_lossy()), None);
    }

    #[test]
    fn uninstallable_install_path_requires_stella_shape() {
        let dir = TestDir::new("uninstallable");
        assert!(!is_uninstallable_install_path(&dir.path.to_string_lossy()));

        write_install_shape(&dir.path);
        assert!(is_uninstallable_install_path(&dir.path.to_string_lossy()));
    }

    #[test]
    fn uninstallable_install_path_rejects_generic_package_dirs() {
        let dir = TestDir::new("generic-uninstallable");
        write_generic_package_shape(&dir.path);

        assert!(!is_uninstallable_install_path(&dir.path.to_string_lossy()));
    }

    #[test]
    fn uninstallable_install_path_allows_state_only_stella_dirs() {
        let dir = TestDir::new("uninstallable-state-only");
        fs::create_dir_all(dir.path.join("state")).expect("create state dir");
        fs::write(dir.path.join("state").join("stella.sqlite"), "db").expect("write state file");

        assert!(is_uninstallable_install_path(&dir.path.to_string_lossy()));
    }

    #[test]
    fn uninstallable_install_path_allows_state_only_stella_dirs_with_benign_leftovers() {
        let dir = TestDir::new("uninstallable-state-only-leftovers");
        fs::create_dir_all(dir.path.join("state")).expect("create state dir");
        fs::write(dir.path.join("state").join("stella.sqlite"), "db").expect("write state file");
        fs::write(dir.path.join(".DS_Store"), "").expect("write ds store");
        fs::write(dir.path.join("stella-install.log"), "log").expect("write log");
        fs::write(dir.path.join(".stella-desktop-download.tar.zst"), "")
            .expect("write temp archive");

        assert!(is_uninstallable_install_path(&dir.path.to_string_lossy()));
    }

    #[test]
    fn launch_env_prepends_bun_bin_even_without_dugite() {
        let dir = TestDir::new("launch-env");
        let env = dugite_launch_env(&dir.path.to_string_lossy());
        let path = env.get("PATH").expect("PATH env");
        assert!(path.starts_with(&bun_bin_dir().to_string_lossy().to_string()));
    }

    #[test]
    fn payload_completion_rejects_missing_manifest_files() {
        let dir = TestDir::new("partial-payload");
        write_install_shape(&dir.path);
        fs::create_dir_all(dir.path.join("node_modules")).expect("create node_modules");
        write_release_manifest(&dir.path, &["desktop/package.json", "runtime/missing.txt"]);
        fs::write(dir.path.join("desktop").join("package.json"), "{}").expect("write desktop file");

        let complete =
            tauri::async_runtime::block_on(payload_step_complete(&dir.path.to_string_lossy()));

        assert!(!complete);
    }

    #[test]
    fn payload_completion_accepts_manifest_files_and_dependencies() {
        let dir = TestDir::new("complete-payload");
        write_install_shape(&dir.path);
        fs::create_dir_all(dir.path.join("node_modules")).expect("create node_modules");
        fs::write(dir.path.join("desktop").join("package.json"), "{}").expect("write desktop file");
        fs::write(dir.path.join("runtime").join("package.json"), "{}").expect("write runtime file");
        write_release_manifest(&dir.path, &["desktop/package.json", "runtime/package.json"]);

        let complete =
            tauri::async_runtime::block_on(payload_step_complete(&dir.path.to_string_lossy()));

        assert!(complete);
    }

    #[test]
    fn parakeet_step_stays_pending_before_payload_is_installed() {
        let dir = TestDir::new("parakeet-before-payload");
        fs::create_dir_all(dir.path.join("state")).expect("create state dir");

        let complete =
            tauri::async_runtime::block_on(parakeet_step_complete(&dir.path.to_string_lossy()));

        assert_eq!(
            complete,
            !cfg!(all(target_os = "macos", target_arch = "aarch64"))
        );
    }

    #[test]
    fn parakeet_step_skips_missing_helper_after_payload_is_installed() {
        let dir = TestDir::new("parakeet-no-helper");
        write_install_shape(&dir.path);
        fs::create_dir_all(dir.path.join("node_modules")).expect("create node_modules");
        fs::write(dir.path.join("desktop").join("package.json"), "{}").expect("write desktop file");
        fs::write(dir.path.join("runtime").join("package.json"), "{}").expect("write runtime file");
        write_release_manifest(&dir.path, &["desktop/package.json", "runtime/package.json"]);

        let complete =
            tauri::async_runtime::block_on(parakeet_step_complete(&dir.path.to_string_lossy()));

        assert!(complete);
    }

    #[test]
    fn remove_install_files_preserving_state_keeps_state_only() {
        let dir = TestDir::new("preserve-state");
        write_install_shape(&dir.path);
        fs::create_dir_all(dir.path.join("state")).expect("create state dir");
        fs::create_dir_all(
            dir.path
                .join("state")
                .join(ELECTRON_USER_DATA_DIR_NAME)
                .join("session-data"),
        )
        .expect("create electron user data dir");
        fs::write(dir.path.join("state").join("stella.sqlite"), "db").expect("write state file");
        fs::write(
            dir.path
                .join("state")
                .join(ELECTRON_USER_DATA_DIR_NAME)
                .join("Local Storage"),
            "local storage",
        )
        .expect("write electron user data file");
        fs::write(dir.path.join("launch.sh"), "#!/bin/sh\n").expect("write launch script");

        tauri::async_runtime::block_on(remove_install_files_preserving_state(
            &dir.path.to_string_lossy(),
        ))
        .expect("remove install files");

        assert!(dir.path.exists());
        assert!(dir.path.join("state").join("stella.sqlite").exists());
        assert!(!dir
            .path
            .join("state")
            .join(ELECTRON_USER_DATA_DIR_NAME)
            .exists());
        assert!(!dir.path.join("desktop").exists());
        assert!(!dir.path.join("package.json").exists());
        assert!(!dir.path.join("launch.sh").exists());
    }
}
