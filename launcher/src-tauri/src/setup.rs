use crate::disk;
use crate::shell::run;
use crate::state::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::fs;

// ── Constants ───────────────────────────────────────────────────────

const INSTALL_MANIFEST: &str = "stella-install.json";
const LAUNCH_SCRIPT_WIN: &str = "launch.cmd";
const LAUNCH_SCRIPT_UNIX: &str = "launch.sh";
const ESTIMATED_INSTALL_BYTES: u64 = 1024 * 1024 * 1024; // 1 GB
const APP_VERSION: &str = "0.0.1";
const STELLA_REPO_URL: &str = "https://github.com/ruuxi/stella.git";
const STELLA_BROWSER_GITHUB_REPO: &str = "vercel-labs/stella-browser";

const DESKTOP_ENV_LOCAL: &str = "VITE_CONVEX_URL=https://impartial-crab-34.convex.cloud\n\
VITE_CONVEX_SITE_URL=https://impartial-crab-34.convex.site\n\
VITE_SITE_URL=http://localhost:5714\n\
VITE_TWITCH_EMOTE_TWITCH_ID=40934651\n";

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
        Ok(canon) => canon.to_string_lossy().to_string(),
        Err(_) => {
            // Path doesn't exist yet — just resolve as absolute
            let pb = PathBuf::from(&expanded);
            if pb.is_absolute() {
                // Strip UNC prefix on Windows
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
fn env_local_of(d: &str) -> PathBuf {
    Path::new(d).join(".env.local")
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
fn stella_browser_root_of(d: &str) -> PathBuf {
    Path::new(d).join("stella-browser")
}
fn stella_browser_wrapper_of(d: &str) -> PathBuf {
    stella_browser_root_of(d).join("bin").join("stella-browser.js")
}
fn stella_browser_cargo_toml_of(d: &str) -> PathBuf {
    stella_browser_root_of(d).join("cli").join("Cargo.toml")
}

fn stella_browser_binary_name() -> Option<String> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        return None;
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        return None;
    };

    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };

    Some(format!("stella-browser-{os}-{arch}{ext}"))
}

fn stella_browser_binary_of(d: &str) -> Option<PathBuf> {
    stella_browser_binary_name()
        .map(|name| stella_browser_root_of(d).join("bin").join(name))
}

async fn read_stella_browser_version(desktop_dir: &str) -> Option<String> {
    let cargo_toml = fs::read_to_string(stella_browser_cargo_toml_of(desktop_dir))
        .await
        .ok()?;
    let re = regex_lite::Regex::new(r#"^\s*version\s*=\s*"([^"]+)""#).ok()?;
    for line in cargo_toml.lines() {
        if let Some(cap) = re.captures(line) {
            return cap.get(1).map(|m| m.as_str().to_string());
        }
    }
    None
}

async fn ensure_executable(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(p).await {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(p, perms).await;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = p;
    }
}

async fn verify_stella_browser_binary(desktop_dir: &str, expected_version: Option<&str>) -> bool {
    let wrapper = stella_browser_wrapper_of(desktop_dir);
    let binary = match stella_browser_binary_of(desktop_dir) {
        Some(b) => b,
        None => return false,
    };

    if !path_exists(&wrapper).await || !path_exists(&binary).await {
        return false;
    }

    ensure_executable(&binary).await;

    let result = run(
        &["bun", "stella-browser/bin/stella-browser.js", "--version"],
        Some(Path::new(desktop_dir)),
    )
    .await;

    if !result.ok {
        return false;
    }

    if let Some(ver) = expected_version {
        if !result.stdout.contains(ver) {
            return false;
        }
    }

    true
}

async fn download_stella_browser_binary(desktop_dir: &str, version: &str) -> bool {
    let binary_name = match stella_browser_binary_name() {
        Some(n) => n,
        None => return false,
    };
    let binary_path = match stella_browser_binary_of(desktop_dir) {
        Some(p) => p,
        None => return false,
    };

    let url = format!(
        "https://github.com/{STELLA_BROWSER_GITHUB_REPO}/releases/download/v{version}/{binary_name}"
    );

    let response = match reqwest::get(&url).await {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };

    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(_) => return false,
    };

    if let Some(parent) = binary_path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }

    if fs::write(&binary_path, &bytes).await.is_err() {
        return false;
    }

    ensure_executable(&binary_path).await;
    true
}

async fn ensure_stella_browser_runtime(desktop_dir: &str) -> bool {
    let version = match read_stella_browser_version(desktop_dir).await {
        Some(v) => v,
        None => return false,
    };

    if verify_stella_browser_binary(desktop_dir, Some(&version)).await {
        return true;
    }

    if !download_stella_browser_binary(desktop_dir, &version).await {
        return false;
    }

    verify_stella_browser_binary(desktop_dir, Some(&version)).await
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

    // Check if it's a drive root
    if let Some(parent) = pb.parent() {
        if parent.as_os_str().is_empty() || pb == PathBuf::from(pb.ancestors().last().unwrap_or(&pb))
        {
            return Some("Choose a folder, not the root of a drive.".into());
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

    if cfg!(target_os = "windows") {
        let content = format!(
            "@echo off\r\ncd /d \"{install_dir}\"\r\nbun run electron:dev\r\n"
        );
        let _ = fs::write(&script_path, content).await;
    } else {
        let content = format!(
            "#!/bin/sh\ncd \"{install_dir}\"\nexec bun run electron:dev\n"
        );
        let _ = fs::write(&script_path, &content).await;
        ensure_executable(&script_path).await;
    }

    script_path.to_string_lossy().to_string()
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
            &[
                "reg", "add", REG_UNINSTALL, "/v", name, "/t", reg_type, "/d", data, "/f",
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

// ── Git ─────────────────────────────────────────────────────────────

async fn git_on_path() -> bool {
    run(&["git", "--version"], None).await.ok
}

async fn install_git() -> bool {
    if cfg!(target_os = "windows") {
        // Try winget first
        let winget_available = run(&["winget", "--version"], None).await.ok;

        if winget_available {
            let result = run(
                &[
                    "winget", "install", "Git.Git",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
                None,
            )
            .await;

            if result.ok {
                add_git_to_path();
                if git_on_path().await {
                    return true;
                }
            }
        }

        // Fallback: download Git for Windows installer directly
        let temp_dir = std::env::temp_dir();
        let installer_path = temp_dir.join("Git-installer.exe");
        let download_url = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe";

        let download = run(
            &[
                "powershell", "-NoProfile", "-NonInteractive", "-Command",
                &format!(
                    "Invoke-WebRequest -Uri '{}' -OutFile '{}'",
                    download_url,
                    installer_path.to_string_lossy()
                ),
            ],
            None,
        )
        .await;

        if !download.ok || !path_exists(&installer_path).await {
            return false;
        }

        // Run installer silently
        let install = run(
            &[
                &installer_path.to_string_lossy(),
                "/VERYSILENT",
                "/NORESTART",
                "/NOCANCEL",
                "/SP-",
                "/CLOSEAPPLICATIONS",
                "/RESTARTAPPLICATIONS",
            ],
            None,
        )
        .await;

        // Clean up installer
        let _ = tokio::fs::remove_file(&installer_path).await;

        if !install.ok {
            return false;
        }

        add_git_to_path();
        git_on_path().await
    } else {
        // On macOS, `git` triggers Xcode CLI tools install automatically.
        let result = run(&["git", "--version"], None).await;
        if result.ok {
            return true;
        }

        // Try brew on macOS
        if cfg!(target_os = "macos") {
            return run(&["brew", "install", "git"], None).await.ok && git_on_path().await;
        }

        false
    }
}

fn add_git_to_path() {
    let git_paths = [
        r"C:\Program Files\Git\cmd",
        r"C:\Program Files (x86)\Git\cmd",
    ];
    let current_path = std::env::var("PATH").unwrap_or_default();
    for gp in &git_paths {
        if std::path::Path::new(gp).exists() && !current_path.contains(gp) {
            std::env::set_var("PATH", format!("{gp};{current_path}"));
            break;
        }
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

// ── Runtime (git + bun) ─────────────────────────────────────────────

async fn check_runtime() -> bool {
    git_on_path().await && bun_on_path().await
}

async fn install_runtime() -> bool {
    // Install git if missing
    if !git_on_path().await && !install_git().await {
        return false;
    }

    // Install bun if missing
    if !bun_on_path().await && !install_bun_globally().await {
        return false;
    }

    true
}

// ── Native prebuilds ────────────────────────────────────────────────

/// Copy prebuilt native .node binaries from the repo's native-prebuilds/
/// directory into the correct node_modules locations.
async fn install_native_prebuilds(install_dir: &str) {
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        return;
    };

    let prebuilds_dir = Path::new(install_dir).join("native-prebuilds");
    let platform_dir = format!("{platform}-{arch}");

    // better-sqlite3
    let src = prebuilds_dir
        .join("better-sqlite3")
        .join(&platform_dir)
        .join("better_sqlite3.node");
    let dest_dir = Path::new(install_dir)
        .join("node_modules")
        .join("better-sqlite3")
        .join("build")
        .join("Release");

    if path_exists(&src).await {
        let _ = fs::create_dir_all(&dest_dir).await;
        let dest = dest_dir.join("better_sqlite3.node");
        if fs::copy(&src, &dest).await.is_ok() {
            log_install(install_dir, &format!(
                "Installed prebuilt better-sqlite3 for {platform_dir}"
            )).await;
        }
    }
}

// ── Step infrastructure ─────────────────────────────────────────────

struct StepDef {
    id: SetupStepId,
    label: &'static str,
}

fn build_step_defs() -> Vec<StepDef> {
    let mut steps = vec![
        StepDef { id: SetupStepId::Runtime, label: "Checking system requirements" },
        StepDef { id: SetupStepId::Prepare, label: "Preparing install location" },
        StepDef { id: SetupStepId::Payload, label: "Installing Stella" },
        StepDef { id: SetupStepId::Deps, label: "Installing dependencies" },
        StepDef { id: SetupStepId::Env, label: "Configuring environment" },
        StepDef { id: SetupStepId::Browser, label: "Provisioning Stella Browser" },
    ];

    steps.push(StepDef { id: SetupStepId::Finalize, label: "Finishing up" });
    steps
}

async fn check_step(id: &SetupStepId, state: &InstallerState) -> bool {
    let dir = &state.install_path;
    match id {
        SetupStepId::Runtime => check_runtime().await,
        SetupStepId::Prepare => path_exists_str(dir).await,
        SetupStepId::Payload => path_exists(&package_json_of(dir)).await,
        SetupStepId::Deps => path_exists(&node_modules_of(dir)).await,
        SetupStepId::Env => path_exists(&env_local_of(dir)).await,
        SetupStepId::Browser => {
            if !path_exists(&stella_browser_wrapper_of(dir)).await {
                return true; // Skip if no wrapper present
            }
            verify_stella_browser_binary(dir, read_stella_browser_version(dir).await.as_deref())
                .await
        }
        SetupStepId::Shortcuts => true, // Handled by NSIS installer
        SetupStepId::Finalize => path_exists(&manifest_of(dir)).await,
    }
}

/// Write a line to the install log file.
async fn log_install(dir: &str, msg: &str) {
    let log_path = Path::new(dir).join("stella-install.log");
    let timestamp = chrono_now();
    let line = format!("[{timestamp}] {msg}\n");
    // Append to log file
    if let Ok(mut contents) = fs::read_to_string(&log_path).await {
        contents.push_str(&line);
        let _ = fs::write(&log_path, contents).await;
    } else {
        let _ = fs::write(&log_path, &line).await;
    }
}

async fn install_step(id: &SetupStepId, state: &InstallerState) -> Result<(), String> {
    let dir = &state.install_path;
    match id {
        SetupStepId::Runtime => {
            if install_runtime().await {
                Ok(())
            } else {
                Err("Failed to install git and/or bun. Check internet connection.".into())
            }
        }
        SetupStepId::Prepare => {
            fs::create_dir_all(dir).await.map_err(|e| format!("mkdir failed: {e}"))?;
            Ok(())
        }
        SetupStepId::Payload => {
            let _ = fs::create_dir_all(dir).await;
            let tmp_clone = format!("{dir}/.clone-tmp");

            let clone = run(
                &[
                    "git", "clone", "--depth", "1", "--filter=blob:none",
                    "--sparse", STELLA_REPO_URL, &tmp_clone,
                ],
                None,
            )
            .await;
            if !clone.ok {
                log_install(dir, &format!("git clone failed: {}", clone.stderr)).await;
                return Err(format!("git clone failed: {}", clone.stderr));
            }

            let sparse = run(
                &["git", "sparse-checkout", "set", "desktop"],
                Some(Path::new(&tmp_clone)),
            )
            .await;
            if !sparse.ok {
                log_install(dir, &format!("sparse-checkout failed: {}", sparse.stderr)).await;
                return Err(format!("sparse-checkout failed: {}", sparse.stderr));
            }

            let desktop_tmp = PathBuf::from(&tmp_clone).join("desktop");
            if let Ok(mut entries) = fs::read_dir(&desktop_tmp).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let src = entry.path();
                    let dest = PathBuf::from(dir).join(entry.file_name());
                    if cfg!(target_os = "windows") {
                        run(
                            &[
                                "cmd", "/c", "move", "/Y",
                                &src.to_string_lossy(),
                                &dest.to_string_lossy(),
                            ],
                            None,
                        )
                        .await;
                    } else {
                        run(
                            &[
                                "mv", "-f",
                                &src.to_string_lossy(),
                                &dest.to_string_lossy(),
                            ],
                            None,
                        )
                        .await;
                    }
                }
            }

            let _ = fs::remove_dir_all(&tmp_clone).await;
            if path_exists(&package_json_of(dir)).await {
                Ok(())
            } else {
                Err("package.json not found after clone".into())
            }
        }
        SetupStepId::Deps => {
            if !path_exists(&package_json_of(dir)).await {
                return Ok(());
            }

            // Install deps but skip postinstall scripts (electron-rebuild needs
            // Python + MSVC build tools that won't exist on a clean machine).
            let result = run(&["bun", "install", "--ignore-scripts"], Some(Path::new(dir))).await;
            if !result.ok {
                log_install(dir, &format!("bun install stdout: {}", result.stdout)).await;
                log_install(dir, &format!("bun install stderr: {}", result.stderr)).await;
                return Err(format!("bun install failed: {}", result.stderr));
            }

            // Electron uses a postinstall to download its binary — run it explicitly.
            let electron_install = run(
                &["bun", "node_modules/electron/install.js"],
                Some(Path::new(dir)),
            ).await;
            if !electron_install.ok {
                log_install(dir, &format!("electron install: {}", electron_install.stderr)).await;
                return Err(format!("Failed to download Electron binary: {}", electron_install.stderr));
            }

            // Copy prebuilt native modules into place.
            // The repo ships prebuilt binaries in native-prebuilds/ so we don't
            // need Python/MSVC on the target machine.
            install_native_prebuilds(dir).await;

            // Try running the full postinstall (electron-rebuild) — will succeed
            // on dev machines with build tools, silently skipped on clean machines.
            let postinstall = run(
                &["bun", "run", "postinstall"],
                Some(Path::new(dir)),
            ).await;
            if !postinstall.ok {
                log_install(dir, "postinstall skipped (no build tools) — using prebuilt native modules").await;
            }

            Ok(())
        }
        SetupStepId::Env => {
            fs::write(env_local_of(dir), DESKTOP_ENV_LOCAL)
                .await
                .map_err(|e| format!("write .env.local failed: {e}"))?;
            Ok(())
        }
        SetupStepId::Browser => {
            if !path_exists(&stella_browser_wrapper_of(dir)).await {
                return Ok(());
            }
            if ensure_stella_browser_runtime(dir).await {
                Ok(())
            } else {
                Err("Failed to download stella-browser binary".into())
            }
        }
        SetupStepId::Shortcuts => Ok(()),
        SetupStepId::Finalize => {
            let script_path = write_launch_script(dir).await;

            let manifest = Manifest {
                version: APP_VERSION.into(),
                platform: std::env::consts::OS.into(),
                installed_at: chrono_now(),
                install_path: dir.clone(),
                launch_script: script_path,
                shortcuts: HashMap::new(),
            };

            let json = serde_json::to_string_pretty(&manifest).unwrap_or_default();
            if fs::write(manifest_of(dir), json).await.is_err() {
                return Err("Failed to write install manifest".into());
            }

            write_registry(&manifest).await;
            Ok(())
        }
    }
}

fn chrono_now() -> String {
    // Simple ISO timestamp without chrono dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Return as unix timestamp string — good enough
    format!("{secs}")
}

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
    let used = disk::dir_size(&state.install_path).await;
    let avail = disk::available_bytes(&state.install_path).await;
    let remaining = ctx.required_bytes.saturating_sub(used);

    state.disk = DiskInfo {
        required_bytes: ctx.required_bytes,
        available_bytes: avail,
        used_bytes: used,
        enough_space: avail.map_or(true, |a| a >= remaining),
    };

    state.install_path_error = location_error(&state.install_path);

    let has_repo = path_exists(&package_json_of(&state.install_path)).await;
    let has_deps = path_exists(&node_modules_of(&state.install_path)).await;
    let browser_ok = verify_stella_browser_binary(
        &state.install_path,
        read_stella_browser_version(&state.install_path)
            .await
            .as_deref(),
    )
    .await;

    state.can_launch = has_repo && has_deps && browser_ok;
}

/// Full state refresh — expensive (walks install dir, checks binaries).
/// Only call at start/end of check_all and install_all.
async fn emit_state_full(state: &mut InstallerState, ctx: &InstallerContext, app: &AppHandle) {
    refresh_derived(state, ctx).await;
    let _ = app.emit("installer-state-update", serde_json::json!({ "state": &*state }));
}

/// Lightweight emit — just pushes current state to the frontend without
/// recalculating disk usage or verifying binaries. Used for step progress updates.
fn emit_state_fast(state: &InstallerState, app: &AppHandle) {
    let _ = app.emit("installer-state-update", serde_json::json!({ "state": state }));
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
        if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
            step.status = SetupStepStatus::Checking;
            step.detail = Some("Checking...".into());
        }
        emit_state_fast(state, app);

        let ok = check_step(&def.id, state).await;

        if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
            step.status = if ok {
                SetupStepStatus::Skipped
            } else {
                SetupStepStatus::Pending
            };
            step.detail = if ok {
                Some("Already done".into())
            } else {
                None
            };
        }
        emit_state_fast(state, app);

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
    // Full refresh only at the end
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
        let msg = "Not enough free disk space for this installation.".to_string();
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

        let label = def.label.to_string();

        if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
            step.status = SetupStepStatus::Installing;
            step.detail = Some(format!("{label}..."));
        }
        emit_state_fast(state, app);

        let result = install_step(&def.id, state).await;

        if let Err(err) = result {
            log_install(&state.install_path, &format!("Step '{}' failed: {}", label, err)).await;
            let detail = format!("Could not complete: {}. {}", label.to_lowercase(), err);
            if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
                step.status = SetupStepStatus::Error;
                step.detail = Some(detail.clone());
            }
            state.phase = InstallerPhase::Error;
            state.error_message = Some(detail.clone());
            emit_state_fast(state, app);
            return Err(detail);
        }

        if let Some(step) = state.steps.iter_mut().find(|s| s.id == def.id) {
            step.status = SetupStepStatus::Done;
            step.detail = Some("Done".into());
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
    let has_repo = path_exists(&package_json_of(dir)).await;
    let has_deps = path_exists(&node_modules_of(dir)).await;

    if !has_repo || !has_deps {
        return None;
    }

    let browser_ok = verify_stella_browser_binary(
        dir,
        read_stella_browser_version(dir).await.as_deref(),
    )
    .await;

    if !browser_ok {
        return None;
    }

    Some(LaunchInfo {
        command: vec!["bun".into(), "run".into(), "electron:dev".into()],
        cwd: dir.clone(),
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
