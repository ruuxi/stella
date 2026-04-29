use crate::setup;
use crate::state::*;
use serde::Serialize;
use std::path::Path;
use std::process::{Command as StdCommand, Stdio};
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
    #[cfg(not(unix))]
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
    #[cfg(not(unix))]
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
            if spawn_detached(&info) {
                hide_main_window(&app);
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

    if is_desktop_alive(&installer.install_path) {
        hide_main_window(&app);
        return Ok(OkResult { ok: true });
    }

    if let Some(info) = setup::get_launch_info(&installer).await {
        let ok = spawn_detached(&info);
        if ok {
            hide_main_window(&app);
        }
        Ok(OkResult { ok })
    } else {
        Ok(OkResult { ok: false })
    }
}

#[tauri::command]
pub async fn check_for_update(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OkResult, String> {
    let current_tag = {
        let mut installer = state.installer.lock().await;
        if state.context.dev_mode || !installer.installed {
            return Ok(OkResult { ok: true });
        }

        installer.update.status = UpdateStatus::Checking;
        installer.update.message = Some("Checking for updates...".into());
        installer.update.conflicts.clear();
        let current_tag = installer.update.current_tag.clone();
        let _ = app.emit(
            "installer-state-update",
            serde_json::json!({ "state": &*installer }),
        );
        current_tag
    };

    let latest_tag = setup::latest_desktop_release_tag().await;

    let mut installer = state.installer.lock().await;
    let result = match latest_tag {
        Ok(latest_tag) => {
            installer.update.latest_tag = Some(latest_tag.clone());
            if current_tag.is_none() {
                installer.update.status = UpdateStatus::Idle;
                installer.update.message = Some(
                    "Stella is installed, but this install does not have release metadata yet."
                        .into(),
                );
            } else if current_tag.as_deref() == Some(latest_tag.as_str()) {
                installer.update.status = UpdateStatus::Idle;
                installer.update.message = Some("Stella is up to date.".into());
            } else {
                installer.update.status = UpdateStatus::Available;
                installer.update.message = Some(format!("Update {latest_tag} is available."));
            }
            Ok(())
        }
        Err(err) => {
            installer.update.status = UpdateStatus::Error;
            installer.update.message = Some(err.clone());
            Err(err)
        }
    };
    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );
    Ok(OkResult { ok: result.is_ok() })
}

#[tauri::command]
pub async fn apply_update(state: State<'_, AppState>, app: AppHandle) -> Result<OkResult, String> {
    let mut installer = state.installer.lock().await;
    let result = setup::apply_update(&mut installer, &state.context, &app).await;
    Ok(OkResult { ok: result.is_ok() })
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
    }

    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );

    Ok(OkResult { ok: result.is_ok() })
}
