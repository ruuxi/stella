use crate::setup;
use crate::state::*;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PID_FILE_NAME: &str = ".electron-dev-runner.pid";
#[cfg(target_os = "macos")]
const LAUNCHER_BUNDLE_ID: &str = "com.stella.launcher";

fn desktop_pid_file(install_path: &str) -> std::path::PathBuf {
    Path::new(install_path).join("desktop").join(PID_FILE_NAME)
}

fn read_pid_file(install_path: &str) -> Option<u32> {
    let path = desktop_pid_file(install_path);
    let raw = std::fs::read_to_string(&path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.get("pid")?.as_u64().map(|p| p as u32)
}

fn is_desktop_alive(install_path: &str) -> bool {
    read_pid_file(install_path).map_or(false, |pid| is_pid_alive(pid))
}

fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        // 259 is STILL_ACTIVE / STATUS_PENDING — the value GetExitCodeProcess
        // returns while the process is still running.
        const STILL_ACTIVE: u32 = 259;

        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut exit_code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut exit_code);
            CloseHandle(handle);
            ok != 0 && exit_code == STILL_ACTIVE
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

fn kill_pid_tree(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let mut cmd = StdCommand::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

pub fn stop_desktop_by_path(install_path: &str) {
    if let Some(pid) = read_pid_file(install_path) {
        if is_pid_alive(pid) {
            kill_pid_tree(pid);
        }
        let _ = std::fs::remove_file(desktop_pid_file(install_path));
    }
}

/// Spawn a background tokio task that watches the desktop dev runner's pid
/// file. Once the desktop is observed running and then exits, re-shows the
/// launcher window. Safe to call repeatedly: any prior watcher is aborted
/// first so we never run two in parallel.
///
/// We do this in Rust (not the renderer) because the renderer's webview is
/// suspended while the launcher window is hidden + in macOS Accessory
/// activation policy, so JS `setInterval` stops firing reliably.
///
/// `reached_running` is shared with the exit-waiter task so the failure
/// classifier knows whether the bootstrap ever succeeded (= post-startup
/// crash, surfaced as "Stella crashed") or never reached the running
/// state (= "Stella couldn't start", typically an agent-broken main file).
fn start_desktop_watcher(
    app: &AppHandle,
    install_path: String,
    reached_running: Arc<StdMutex<bool>>,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    if let Ok(mut guard) = state.desktop_watcher.lock() {
        if let Some(prev) = guard.take() {
            prev.abort();
        }
    }

    let app_for_task = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut saw_running = false;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let running = is_desktop_alive(&install_path);
            if running {
                if !saw_running {
                    saw_running = true;
                    if let Ok(mut flag) = reached_running.lock() {
                        *flag = true;
                    }
                }
                continue;
            }
            if saw_running {
                // Don't re-show the launcher here on a bad exit. The
                // `desktop-failure` event from the exit waiter will own
                // the show-and-render-recovery transition; this watcher
                // only handles the "Stella was running, user quit it
                // cleanly" case.
                if let Some(state) = app_for_task.try_state::<AppState>() {
                    let has_failure = state
                        .desktop_failure
                        .lock()
                        .ok()
                        .map(|f| f.is_some())
                        .unwrap_or(false);
                    if !has_failure {
                        show_main_window(&app_for_task);
                    }
                }
                break;
            }
        }

        if let Some(state) = app_for_task.try_state::<AppState>() {
            if let Ok(mut guard) = state.desktop_watcher.lock() {
                *guard = None;
            }
        }
    });

    if let Ok(mut guard) = state.desktop_watcher.lock() {
        *guard = Some(handle);
    };
}

/// Spawn a tokio task that owns the spawned desktop child and waits on
/// its exit. Non-zero exit becomes a `desktop-failure` event with the
/// captured log tail and best-guess "what would undoing the latest
/// self-mod commit roll back" summary, plus the launcher window is
/// re-shown so the renderer can render the recovery view.
fn start_desktop_exit_waiter(
    app: &AppHandle,
    install_path: String,
    log_path: PathBuf,
    mut child: std::process::Child,
    reached_running: Arc<StdMutex<bool>>,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    if let Ok(mut guard) = state.desktop_exit_waiter.lock() {
        if let Some(prev) = guard.take() {
            prev.abort();
        }
    }

    let app_for_task = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        // `Child::wait` is sync; bounce to a blocking task so we don't
        // park the tokio worker for the duration of the desktop session.
        let status =
            tauri::async_runtime::spawn_blocking(move || child.wait()).await;
        let exit_code: i32 = match status {
            Ok(Ok(s)) => {
                if let Some(code) = s.code() {
                    code
                } else if !s.success() {
                    1
                } else {
                    0
                }
            }
            Ok(Err(_)) | Err(_) => 1,
        };

        if exit_code == 0 {
            // Clean exit -- the watcher above (or the desktop UI quit
            // path) is responsible for re-showing the launcher.
            if let Some(state) = app_for_task.try_state::<AppState>() {
                if let Ok(mut guard) = state.desktop_exit_waiter.lock() {
                    *guard = None;
                }
            }
            return;
        }

        let reached = reached_running
            .lock()
            .ok()
            .map(|flag| *flag)
            .unwrap_or(false);
        let log_tail = read_log_tail(&log_path, LAUNCH_LOG_TAIL_LINES);
        let revertable_commit = latest_revertable_commit(&install_path);
        let failure = DesktopFailure {
            exit_code,
            log_tail,
            reached_running: reached,
            log_path: log_path.to_string_lossy().to_string(),
            revertable_commit,
        };

        if let Some(state) = app_for_task.try_state::<AppState>() {
            if let Ok(mut guard) = state.desktop_failure.lock() {
                *guard = Some(failure.clone());
            }
            if let Ok(mut guard) = state.desktop_exit_waiter.lock() {
                *guard = None;
            }
        }
        let _ = app_for_task.emit("desktop-failure", failure);
        show_main_window(&app_for_task);
    });

    if let Ok(mut guard) = state.desktop_exit_waiter.lock() {
        *guard = Some(handle);
    };
}

fn spawn_detached(info: &LaunchInfo) -> bool {
    let mut cmd = StdCommand::new(&info.command[0]);
    cmd.args(&info.command[1..])
        .current_dir(&info.cwd)
        .envs(&info.env)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    cmd.spawn().is_ok()
}

const LAUNCH_LOG_NAME: &str = ".stella-launch.log";
const LAUNCH_LOG_TAIL_LINES: usize = 200;
const STELLA_CONVERSATION_TRAILER: &str = "Stella-Conversation:";

fn launch_log_path(install_path: &str) -> PathBuf {
    Path::new(install_path).join(LAUNCH_LOG_NAME)
}

/// Spawn `bun run electron:dev` while keeping the child handle so the
/// launcher can detect non-zero exits, but still detach the underlying
/// process group so quitting the launcher leaves Stella running. stdout
/// and stderr are merged into a rolling log file under the install root.
///
/// Returns `(child_pid, log_path)` on success. The launcher then spins
/// up a tokio task to wait on the child handle and emit a recovery
/// event if it exits non-zero.
fn spawn_tracked(info: &LaunchInfo) -> std::io::Result<(std::process::Child, PathBuf)> {
    let log_path = launch_log_path(&info.cwd);
    // Truncate the log on each new launch so the recovery view shows only
    // the failure that triggered it, not stale lines from a previous run.
    let stdout_log = std::fs::File::create(&log_path)?;
    let stderr_log = stdout_log.try_clone()?;

    let mut cmd = StdCommand::new(&info.command[0]);
    cmd.args(&info.command[1..])
        .current_dir(&info.cwd)
        .envs(&info.env)
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // setsid detaches the child into its own process group so SIGTERM
        // to the launcher doesn't cascade. We still hold the Child handle
        // for `wait()`, which works across groups.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let child = cmd.spawn()?;
    Ok((child, log_path))
}

fn read_log_tail(log_path: &Path, line_limit: usize) -> String {
    let Ok(file) = std::fs::File::open(log_path) else {
        return String::new();
    };
    let reader = BufReader::new(file);
    let mut tail: VecDeque<String> = VecDeque::with_capacity(line_limit);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if tail.len() == line_limit {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    tail.into_iter().collect::<Vec<_>>().join("\n")
}

/// Inspect the most recent commit on the install repo. Returns a
/// summary only when the commit looks like an agent-authored self-mod
/// (i.e., its message contains a `Stella-Conversation:` trailer). When
/// the latest commit is something else (a manual user edit, the install
/// base commit, etc.) the launcher should NOT offer to roll it back, so
/// we return `None` and the recovery view hides the undo button.
fn latest_revertable_commit(install_path: &str) -> Option<RevertableCommit> {
    let env = setup::dugite_launch_env(install_path);
    let git_bin = env.get("STELLA_GIT_BIN")?.clone();
    let mut cmd = StdCommand::new(&git_bin);
    cmd.current_dir(install_path)
        .envs(&env)
        .args(["log", "-1", "--format=%h%n%s%n%B", "HEAD"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut parts = raw.splitn(3, '\n');
    let short_sha = parts.next()?.trim().to_string();
    let subject = parts.next()?.trim().to_string();
    let body = parts.next().unwrap_or("");
    if !body.contains(STELLA_CONVERSATION_TRAILER) {
        return None;
    }
    Some(RevertableCommit { short_sha, subject })
}

pub fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
        let _ = app.set_dock_visibility(true);
        let _ = app.show();
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = StdCommand::new("osascript")
            .args([
                "-e",
                &format!("tell application id \"{LAUNCHER_BUNDLE_ID}\" to activate"),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(true);
        let _ = window.hide();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app.set_dock_visibility(false);
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }
}

#[derive(Serialize)]
pub struct OkResult {
    pub ok: bool,
}

#[tauri::command]
pub async fn get_installer_state(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<InstallerState, String> {
    let mut installer = state.installer.lock().await;
    let ctx = &state.context;

    setup::check_all(&mut installer, ctx, &app).await;

    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );

    Ok(installer.clone())
}

#[tauri::command]
pub async fn browse_install_location(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<InstallerState, String> {
    if state.context.dev_mode {
        let installer = state.installer.lock().await;
        return Ok(installer.clone());
    }
    use tauri_plugin_dialog::DialogExt;

    let current_path = {
        let installer = state.installer.lock().await;
        setup::browse_directory_for_install_path(&installer.install_path)
    };

    let selected = app
        .dialog()
        .file()
        .set_directory(&current_path)
        .blocking_pick_folder();

    if let Some(folder) = selected {
        let path_str = folder.to_string();
        let mut installer = state.installer.lock().await;
        setup::set_install_path(&mut installer, &state.context, &path_str).await;
        setup::check_all(&mut installer, &state.context, &app).await;

        let _ = app.emit(
            "installer-state-update",
            serde_json::json!({ "state": &*installer }),
        );
        Ok(installer.clone())
    } else {
        let installer = state.installer.lock().await;
        Ok(installer.clone())
    }
}

#[tauri::command]
pub async fn set_install_location(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<InstallerState, String> {
    let mut installer = state.installer.lock().await;
    if state.context.dev_mode {
        setup::check_all(&mut installer, &state.context, &app).await;
        let _ = app.emit(
            "installer-state-update",
            serde_json::json!({ "state": &*installer }),
        );
        return Ok(installer.clone());
    }
    setup::set_install_path(&mut installer, &state.context, &path).await;
    setup::check_all(&mut installer, &state.context, &app).await;

    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );
    Ok(installer.clone())
}

#[tauri::command]
pub async fn set_run_after_install(
    state: State<'_, AppState>,
    app: AppHandle,
    value: bool,
) -> Result<InstallerState, String> {
    let mut installer = state.installer.lock().await;
    setup::set_run_after_install(&mut installer, &state.context, value).await;
    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );
    Ok(installer.clone())
}

#[tauri::command]
pub async fn start_install(state: State<'_, AppState>, app: AppHandle) -> Result<OkResult, String> {
    let mut installer = state.installer.lock().await;
    if state.context.dev_mode {
        setup::check_all(&mut installer, &state.context, &app).await;
        return Ok(OkResult { ok: false });
    }
    let result = setup::install_all(&mut installer, &state.context, &app).await;

    if result.is_ok() && installer.run_after_install && installer.can_launch {
        if let Some(info) = setup::get_launch_info(&installer).await {
            // Match the manual `launch_desktop` path: tracked spawn so
            // a startup failure surfaces the recovery view instead of
            // silently leaving the launcher hidden.
            match spawn_tracked(&info) {
                Ok((child, log_path)) => {
                    let reached = Arc::new(StdMutex::new(false));
                    start_desktop_watcher(
                        &app,
                        installer.install_path.clone(),
                        Arc::clone(&reached),
                    );
                    start_desktop_exit_waiter(
                        &app,
                        installer.install_path.clone(),
                        log_path,
                        child,
                        reached,
                    );
                    hide_main_window(&app);
                }
                Err(_) => {
                    // Fall back to the legacy detached spawn if the
                    // tracked one fails (e.g., couldn't open the log
                    // file). Better to launch without a recovery net
                    // than to fail the post-install hand-off entirely.
                    if spawn_detached(&info) {
                        let reached = Arc::new(StdMutex::new(false));
                        start_desktop_watcher(
                            &app,
                            installer.install_path.clone(),
                            reached,
                        );
                        hide_main_window(&app);
                    }
                }
            }
        }
    }

    Ok(OkResult { ok: result.is_ok() })
}

#[tauri::command]
pub async fn launch_desktop(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OkResult, String> {
    let installer = state.installer.lock().await;

    // Clear any stale failure from the previous attempt so the renderer
    // doesn't bounce back into the recovery view if this attempt
    // succeeds.
    if let Ok(mut guard) = state.desktop_failure.lock() {
        *guard = None;
    }

    if is_desktop_alive(&installer.install_path) {
        let reached = Arc::new(StdMutex::new(true));
        start_desktop_watcher(&app, installer.install_path.clone(), reached);
        hide_main_window(&app);
        return Ok(OkResult { ok: true });
    }

    if let Some(info) = setup::get_launch_info(&installer).await {
        match spawn_tracked(&info) {
            Ok((child, log_path)) => {
                let reached = Arc::new(StdMutex::new(false));
                start_desktop_watcher(
                    &app,
                    installer.install_path.clone(),
                    Arc::clone(&reached),
                );
                start_desktop_exit_waiter(
                    &app,
                    installer.install_path.clone(),
                    log_path,
                    child,
                    reached,
                );
                hide_main_window(&app);
                Ok(OkResult { ok: true })
            }
            Err(err) => {
                // Spawn itself failed (bun missing on PATH, install
                // path moved, etc.). Surface as a synthetic failure
                // event so the recovery view can render the same way.
                let log_path = launch_log_path(&installer.install_path);
                let failure = DesktopFailure {
                    exit_code: 1,
                    log_tail: format!("Failed to spawn desktop: {err}"),
                    reached_running: false,
                    log_path: log_path.to_string_lossy().to_string(),
                    revertable_commit: latest_revertable_commit(
                        &installer.install_path,
                    ),
                };
                if let Ok(mut guard) = state.desktop_failure.lock() {
                    *guard = Some(failure.clone());
                }
                let _ = app.emit("desktop-failure", failure);
                show_main_window(&app);
                Ok(OkResult { ok: false })
            }
        }
    } else {
        Ok(OkResult { ok: false })
    }
}

/// Returns the most recent desktop startup/runtime failure if any, or
/// `null` if the last launch is healthy. Lets the renderer rehydrate
/// the recovery view after a hot reload.
#[tauri::command]
pub async fn get_desktop_failure(
    state: State<'_, AppState>,
) -> Result<Option<DesktopFailure>, String> {
    Ok(state
        .desktop_failure
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(None))
}

/// Clears the captured desktop failure. Called from the renderer when
/// the user dismisses the recovery view ("Try again" → relaunch flow
/// already clears it inside `launch_desktop`).
#[tauri::command]
pub async fn clear_desktop_failure(
    state: State<'_, AppState>,
) -> Result<OkResult, String> {
    if let Ok(mut guard) = state.desktop_failure.lock() {
        *guard = None;
    }
    Ok(OkResult { ok: true })
}

/// Roll back the most recent self-mod commit on the install repo, then
/// rebuild the desktop's dist-electron output so the launcher can spawn
/// a clean copy on the next attempt. The launcher does NOT relaunch
/// automatically -- the renderer drives that via `launch_desktop` so
/// the recovery UI can show progress.
///
/// Refuses to revert if the latest commit isn't an agent-authored
/// self-mod (no `Stella-Conversation:` trailer); in that case the
/// renderer should hide the undo button and surface "Reinstall Stella"
/// as the next step instead.
#[tauri::command]
pub async fn revert_last_self_mod(
    state: State<'_, AppState>,
) -> Result<OkResult, String> {
    let install_path = {
        let installer = state.installer.lock().await;
        installer.install_path.clone()
    };

    let revertable = latest_revertable_commit(&install_path).ok_or_else(|| {
        "The latest commit isn't a Stella self-mod, so there's nothing safe to roll back automatically. Reinstall Stella to start fresh.".to_string()
    })?;

    let env = setup::dugite_launch_env(&install_path);
    let git_bin = env
        .get("STELLA_GIT_BIN")
        .cloned()
        .ok_or_else(|| "Bundled git not found.".to_string())?;

    let install_path_for_blocking = install_path.clone();
    let env_for_blocking = env.clone();
    let _ = revertable; // referenced in the error path above; blocking task does the actual reset
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = StdCommand::new(&git_bin);
        cmd.current_dir(&install_path_for_blocking)
            .envs(&env_for_blocking)
            .args(["reset", "--hard", "HEAD~1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).to_string();
        return Err(if stderr.is_empty() {
            "Failed to revert the last Stella update.".to_string()
        } else {
            stderr
        });
    }

    Ok(OkResult { ok: true })
}

#[tauri::command]
pub async fn check_launcher_update(app: AppHandle) -> Result<bool, String> {
    crate::check_for_launcher_update(&app, true).await
}

#[tauri::command]
pub async fn apply_launcher_update(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OkResult, String> {
    use tauri_plugin_updater::UpdaterExt;

    {
        let mut installer = state.installer.lock().await;
        installer.launcher_update.installing = true;
        installer.launcher_update.error = None;
        let _ = app.emit(
            "installer-state-update",
            serde_json::json!({ "state": &*installer }),
        );
    }

    let result: Result<(), String> = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No launcher update available.".to_string())?;
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            app.request_restart();
            Ok(OkResult { ok: true })
        }
        Err(err) => {
            let mut installer = state.installer.lock().await;
            installer.launcher_update.installing = false;
            installer.launcher_update.error = Some(err.clone());
            let _ = app.emit(
                "installer-state-update",
                serde_json::json!({ "state": &*installer }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn show_launcher_window(app: AppHandle) -> Result<OkResult, String> {
    show_main_window(&app);
    Ok(OkResult { ok: true })
}

#[tauri::command]
pub async fn stop_desktop(state: State<'_, AppState>) -> Result<OkResult, String> {
    let installer = state.installer.lock().await;
    stop_desktop_by_path(&installer.install_path);
    Ok(OkResult { ok: true })
}

#[tauri::command]
pub async fn is_desktop_running(state: State<'_, AppState>) -> Result<bool, String> {
    let installer = state.installer.lock().await;
    Ok(is_desktop_alive(&installer.install_path))
}

#[tauri::command]
pub async fn open_install_location(state: State<'_, AppState>) -> Result<OkResult, String> {
    let installer = state.installer.lock().await;
    let path = installer.install_path.clone();
    drop(installer);

    match open::that(&path) {
        Ok(_) => Ok(OkResult { ok: true }),
        Err(_) => Ok(OkResult { ok: false }),
    }
}

#[tauri::command]
pub async fn uninstall_stella(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OkResult, String> {
    if state.context.dev_mode {
        return Ok(OkResult { ok: false });
    }
    let mut installer = state.installer.lock().await;
    let result = setup::uninstall(&mut installer).await;

    if result.is_ok() {
        setup::check_all(&mut installer, &state.context, &app).await;
    } else if let Err(err) = &result {
        installer.phase = InstallerPhase::Error;
        installer.error_message = Some(err.clone());
    }

    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );

    Ok(OkResult { ok: result.is_ok() })
}

#[tauri::command]
pub async fn full_reset_stella(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OkResult, String> {
    if state.context.dev_mode {
        return Ok(OkResult { ok: false });
    }
    let mut installer = state.installer.lock().await;
    let result = setup::full_reset(&mut installer).await;

    if result.is_ok() {
        setup::check_all(&mut installer, &state.context, &app).await;
    } else if let Err(err) = &result {
        installer.phase = InstallerPhase::Error;
        installer.error_message = Some(err.clone());
    }

    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );

    Ok(OkResult { ok: result.is_ok() })
}
