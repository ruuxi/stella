use crate::disk;
use crate::shell::run;
use crate::state::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::process::Command;

// ── Constants ───────────────────────────────────────────────────────

const INSTALL_MANIFEST: &str = "stella-install.json";
const LAUNCH_SCRIPT_WIN: &str = "launch.cmd";
const LAUNCH_SCRIPT_UNIX: &str = "launch.sh";
const ENV_FILE_NAME: &str = ".env.local";
const ESTIMATED_INSTALL_BYTES: u64 = 512 * 1024 * 1024; // 512 MB
const APP_VERSION: &str = "0.0.1";
const DEFAULT_ENV_FILE_CONTENTS: &str = "\
VITE_CONVEX_URL=https://impartial-crab-34.convex.cloud\n\
VITE_CONVEX_SITE_URL=https://cloud.stella.sh\n\
VITE_SITE_URL=https://stella.sh\n\
VITE_TWITCH_EMOTE_TWITCH_ID=40934651\n";

const GITHUB_REPO: &str = "ruuxi/stella";

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

fn release_download_url(tag: &str) -> String {
    format!(
        "https://github.com/{GITHUB_REPO}/releases/download/{tag}/{}",
        release_tarball_name()
    )
}

/// Get the latest desktop release tag from GitHub.
async fn latest_release_tag() -> Option<String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=10");
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

fn manifest_of(d: &str) -> PathBuf {
    Path::new(d).join(INSTALL_MANIFEST)
}
fn package_json_of(d: &str) -> PathBuf {
    Path::new(d).join("package.json")
}
fn node_modules_of(d: &str) -> PathBuf {
    Path::new(d).join("node_modules")
}
fn launch_script_name() -> &'static str {
    if cfg!(target_os = "windows") { LAUNCH_SCRIPT_WIN } else { LAUNCH_SCRIPT_UNIX }
}
fn launch_script_of(d: &str) -> PathBuf {
    Path::new(d).join(launch_script_name())
}
fn env_file_of(d: &str) -> PathBuf {
    Path::new(d).join(ENV_FILE_NAME)
}
fn dugite_git_root_of(d: &str) -> PathBuf {
    Path::new(d).join("node_modules").join("dugite").join("git")
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
    let git_root = dugite_git_root_of(install_dir);
    if !git_root.exists() {
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
        dugite_git_exec_path_of(install_dir).to_string_lossy().to_string(),
    );

    let existing_path = std::env::var("PATH").unwrap_or_default();
    if cfg!(target_os = "windows") {
        let mingw_root = git_root.join(dugite_win32_subfolder());
        let path_prefix = format!(
            "{};{}",
            mingw_root.join("bin").to_string_lossy(),
            mingw_root.join("usr").join("bin").to_string_lossy()
        );
        env.insert("PATH".into(), format!("{path_prefix};{existing_path}"));
        env.insert(
            "STELLA_GIT_BASH".into(),
            dugite_git_bash_of(install_dir).to_string_lossy().to_string(),
        );
    } else {
        env.insert("PATH".into(), format!("{git_root_str}/bin:{existing_path}"));
        env.insert(
            "GIT_CONFIG_SYSTEM".into(),
            git_root.join("etc").join("gitconfig").to_string_lossy().to_string(),
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
    None
}

// ── Helpers ─────────────────────────────────────────────────────────

async fn path_exists(p: &Path) -> bool {
    fs::metadata(p).await.is_ok()
}

async fn path_exists_str(p: &str) -> bool {
    path_exists(Path::new(p)).await
}

// ── Settings persistence ────────────────────────────────────────────

async fn read_settings(ctx: &InstallerContext) -> Settings {
    match fs::read_to_string(&ctx.settings_file_path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

async fn write_settings(ctx: &InstallerContext, state: &InstallerState) {
    let settings = Settings {
        install_path: Some(state.install_path.clone()),
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
            content.push_str(&format!("export GIT_CONFIG_SYSTEM=\"{git_config_system}\"\n"));
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

const REG_UNINSTALL: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Stella";

async fn write_registry(manifest: &Manifest) {
    if !cfg!(target_os = "windows") {
        return;
    }

    let size_kb = (ESTIMATED_INSTALL_BYTES / 1024).to_string();
    let entries: &[(&str, &str, &str)] = &[
        ("DisplayName", "REG_SZ", "Stella"),
        ("DisplayVersion", "REG_SZ", &manifest.version),
        ("Publisher", "REG_SZ", "Stella"),
        ("InstallLocation", "REG_SZ", &manifest.install_path),
        ("DisplayIcon", "REG_SZ", &manifest.launch_script),
        ("UninstallString", "REG_SZ", &manifest.launch_script),
        ("NoModify", "REG_DWORD", "1"),
        ("NoRepair", "REG_DWORD", "1"),
        ("EstimatedSize", "REG_DWORD", &size_kb),
    ];

    for (name, reg_type, data) in entries {
        run(
            &["reg", "add", REG_UNINSTALL, "/v", name, "/t", reg_type, "/d", data, "/f"],
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
    run(&["bun", "--version"], None).await.ok
}

async fn install_bun_globally() -> bool {
    if cfg!(target_os = "windows") {
        let result = run(
            &[
                "powershell", "-NoProfile", "-NonInteractive", "-Command",
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

    if bun_on_path().await {
        return true;
    }

    // Bun was installed but not on PATH yet — add it
    let bun_bin = if cfg!(target_os = "windows") {
        home_dir().join(".bun").join("bin").join("bun.exe")
    } else {
        home_dir().join(".bun").join("bin").join("bun")
    };

    if path_exists(&bun_bin).await {
        if let Some(bin_dir) = bun_bin.parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
            std::env::set_var(
                "PATH",
                format!("{}{sep}{current_path}", bin_dir.to_string_lossy()),
            );
            return bun_on_path().await;
        }
    }

    false
}

async fn install_payload_dependencies(install_dir: &str) -> Result<(), String> {
    let dir = Some(Path::new(install_dir));
    let result = run(&["bun", "install", "--frozen-lockfile"], dir).await;
    if result.ok {
        Ok(())
    } else if result.stderr.is_empty() {
        Err("bun install failed.".into())
    } else {
        Err(format!("bun install failed: {}", result.stderr))
    }
}

// ── Tarball download + extract ──────────────────────────────────────

async fn download_and_extract_release(install_dir: &str) -> Result<(), String> {
    let tag = latest_release_tag()
        .await
        .ok_or("Could not find a desktop release. Check your internet connection.")?;

    let url = release_download_url(&tag);
    log_install(install_dir, &format!("Downloading {url}")).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "stella-launcher")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    log_install(install_dir, &format!("Downloaded {} bytes, extracting...", bytes.len())).await;

    // Decompress zstd then untar — do in blocking task to avoid blocking async runtime
    let install_path = install_dir.to_string();
    tokio::task::spawn_blocking(move || {
        let decoder = zstd::Decoder::new(std::io::Cursor::new(&bytes))
            .map_err(|e| format!("zstd decompress failed: {e}"))?;
        let mut archive = tar::Archive::new(decoder);

        std::fs::create_dir_all(&install_path)
            .map_err(|e| format!("mkdir failed: {e}"))?;

        archive
            .unpack(&install_path)
            .map_err(|e| format!("tar extract failed: {e}"))?;

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Extract task failed: {e}"))??;

    log_install(install_dir, "Extraction complete").await;
    Ok(())
}

// ── Git init for self-mod ───────────────────────────────────────────

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

    let mut version_command = Command::new(&git_bin);
    version_command.args(["--version"]).current_dir(&cwd).envs(&env);
    #[cfg(target_os = "windows")]
    version_command.creation_flags(0x08000000);
    let _ = version_command.output().await;

    let mut init_command = Command::new(&git_bin);
    init_command.args(["init"]).current_dir(&cwd).envs(&env);
    #[cfg(target_os = "windows")]
    init_command.creation_flags(0x08000000);
    let _ = init_command.output().await;

    let mut add_command = Command::new(&git_bin);
    add_command.args(["add", "-A"]).current_dir(&cwd).envs(&env);
    #[cfg(target_os = "windows")]
    add_command.creation_flags(0x08000000);
    let _ = add_command.output().await;

    let mut commit_command = Command::new(&git_bin);
    commit_command
        .args(["commit", "-m", "initial stella install"])
        .current_dir(&cwd)
        .envs(&env);
    #[cfg(target_os = "windows")]
    commit_command.creation_flags(0x08000000);
    let _ = commit_command.output().await;
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
        StepDef { id: SetupStepId::Runtime, label: "Setting up" },
        StepDef { id: SetupStepId::Payload, label: "Downloading Stella" },
        StepDef { id: SetupStepId::Finalize, label: "Finishing up" },
    ]
}

async fn check_step(id: &SetupStepId, state: &InstallerState) -> bool {
    let dir = &state.install_path;
    match id {
        SetupStepId::Runtime => bun_on_path().await,
        SetupStepId::Payload => {
            path_exists(&package_json_of(dir)).await
                && path_exists(&node_modules_of(dir)).await
        }
        SetupStepId::Finalize => path_exists(&manifest_of(dir)).await,
        _ => true,
    }
}

async fn install_step(id: &SetupStepId, state: &InstallerState) -> Result<(), String> {
    let dir = &state.install_path;
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
            let _ = fs::create_dir_all(dir).await;
            download_and_extract_release(dir).await?;
            write_default_env_file(dir).await?;
            log_install(dir, "Installing desktop dependencies with Bun").await;
            install_payload_dependencies(dir).await?;
            Ok(())
        }
        SetupStepId::Finalize => {
            let script_path = write_launch_script(dir).await;

            // Init git repo for self-mod in the background so install completion
            // does not wait on indexing tens of thousands of extracted files.
            schedule_git_repo_init(dir.clone());

            let manifest = Manifest {
                version: APP_VERSION.into(),
                platform: std::env::consts::OS.into(),
                installed_at: chrono_now(),
                install_path: dir.clone(),
                launch_script: script_path,
                shortcuts: HashMap::new(),
            };

            let json = serde_json::to_string_pretty(&manifest).unwrap_or_default();
            fs::write(manifest_of(dir), json)
                .await
                .map_err(|e| format!("Failed to write manifest: {e}"))?;

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
    let has_pkg = path_exists(&package_json_of(&state.install_path)).await;
    state.can_launch = has_manifest && has_pkg;
}

fn emit_state_fast(state: &InstallerState, app: &AppHandle) {
    let _ = app.emit("installer-state-update", serde_json::json!({ "state": state }));
}

async fn emit_state_full(state: &mut InstallerState, ctx: &InstallerContext, app: &AppHandle) {
    refresh_derived(state, ctx).await;
    let _ = app.emit("installer-state-update", serde_json::json!({ "state": &*state }));
}

// ── Public API ──────────────────────────────────────────────────────

pub fn create_context(default_install_path: String, settings_file_path: PathBuf) -> InstallerContext {
    InstallerContext {
        default_install_path,
        settings_file_path,
        required_bytes: ESTIMATED_INSTALL_BYTES,
    }
}

pub async fn create_initial_state(ctx: &InstallerContext) -> InstallerState {
    let settings = read_settings(ctx).await;
    let install_path = norm(
        settings
            .install_path
            .as_deref()
            .unwrap_or(&ctx.default_install_path),
    );

    let mut state = InstallerState {
        steps: vec![],
        phase: InstallerPhase::Checking,
        error_message: None,
        install_path,
        default_install_path: ctx.default_install_path.clone(),
        install_path_error: None,
        run_after_install: settings.run_after_install.unwrap_or(true),
        can_launch: false,
        installed: false,
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
    state.install_path = norm(install_path);
    state.error_message = None;
    write_settings(ctx, state).await;
}

pub async fn set_run_after_install(
    state: &mut InstallerState,
    ctx: &InstallerContext,
    value: bool,
) {
    state.run_after_install = value;
    write_settings(ctx, state).await;
}

pub async fn check_all(
    state: &mut InstallerState,
    ctx: &InstallerContext,
    app: &AppHandle,
) {
    state.phase = InstallerPhase::Checking;
    state.error_message = None;
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
        }
        emit_state_fast(state, app);

        let result = install_step(&def.id, state).await;

        if let Err(err) = result {
            log_install(&state.install_path, &format!("Step '{}' failed: {}", def.label, err)).await;
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

    Some(LaunchInfo {
        command: vec!["bun".into(), "run".into(), "electron:dev".into()],
        cwd: dir.clone(),
        env: dugite_launch_env(dir),
    })
}

pub async fn uninstall(state: &mut InstallerState) -> Result<(), String> {
    remove_registry().await;

    if path_exists_str(&state.install_path).await {
        fs::remove_dir_all(&state.install_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    state.installed = false;
    state.phase = InstallerPhase::Ready;
    state.steps.clear();
    sync_step_list(state);

    Ok(())
}
