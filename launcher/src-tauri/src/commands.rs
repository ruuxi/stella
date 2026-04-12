use crate::setup;
use crate::state::*;
use serde::Serialize;
use std::path::Path;
use std::process::{Command as StdCommand, Stdio};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PID_FILE_NAME: &str = ".electron-dev-runner.pid";
#[cfg(target_os = "macos")]
const LAUNCHER_BUNDLE_ID: &str = "com.stella.launcher";

fn read_pid_file(install_path: &str) -> Option<u32> {
    let path = Path::new(install_path).join(PID_FILE_NAME);
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
        let _ = std::fs::remove_file(
            Path::new(install_path).join(PID_FILE_NAME),
        );
    }
}

fn spawn_detached(info: &LaunchInfo) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some(ok) = spawn_detached_disclaim(info) {
            return ok;
        }
    }

    let mut cmd = StdCommand::new(&info.command[0]);
    cmd.args(&info.command[1..])
        .current_dir(&info.cwd)
        .envs(&info.env)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    #[cfg(unix)]
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

/// Spawn with `posix_spawn` + `responsibility_spawnattrs_setdisclaim` so the
/// child becomes its own "responsible process" for macOS TCC. Without this,
/// TCC attributes permission prompts (microphone, camera, etc.) to the parent
/// launcher process, which silently prevents them from appearing.
#[cfg(target_os = "macos")]
fn spawn_detached_disclaim(info: &LaunchInfo) -> Option<bool> {
    use std::ffi::{c_char, c_int, CString};
    use std::ptr;

    type DisclaimFn = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

    let disclaim_fn: DisclaimFn = unsafe {
        let sym = libc::dlsym(
            libc::RTLD_DEFAULT,
            b"responsibility_spawnattrs_setdisclaim\0".as_ptr() as *const c_char,
        );
        if sym.is_null() {
            return None;
        }
        std::mem::transmute(sym)
    };

    let c_cmd: Vec<CString> = info
        .command
        .iter()
        .filter_map(|s| CString::new(s.as_str()).ok())
        .collect();
    if c_cmd.len() != info.command.len() {
        return None;
    }

    let mut argv_ptrs: Vec<*mut c_char> = c_cmd.iter().map(|s| s.as_ptr() as *mut c_char).collect();
    argv_ptrs.push(ptr::null_mut());

    let mut env_strs: Vec<String> = std::env::vars().map(|(k, v)| format!("{k}={v}")).collect();
    for (k, v) in &info.env {
        if let Some(pos) = env_strs.iter().position(|e| {
            e.starts_with(k) && e.as_bytes().get(k.len()) == Some(&b'=')
        }) {
            env_strs[pos] = format!("{k}={v}");
        } else {
            env_strs.push(format!("{k}={v}"));
        }
    }
    let c_env: Vec<CString> = env_strs
        .iter()
        .filter_map(|s| CString::new(s.as_str()).ok())
        .collect();
    let mut envp_ptrs: Vec<*mut c_char> =
        c_env.iter().map(|s| s.as_ptr() as *mut c_char).collect();
    envp_ptrs.push(ptr::null_mut());

    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
        libc::posix_spawnattr_init(&mut attr);

        const POSIX_SPAWN_SETSID: libc::c_short = 0x0400;
        libc::posix_spawnattr_setflags(&mut attr, POSIX_SPAWN_SETSID);

        disclaim_fn(&mut attr, 1);

        let mut file_actions: libc::posix_spawn_file_actions_t = std::mem::zeroed();
        libc::posix_spawn_file_actions_init(&mut file_actions);

        let dev_null = CString::new("/dev/null").unwrap();
        libc::posix_spawn_file_actions_addopen(
            &mut file_actions,
            libc::STDIN_FILENO,
            dev_null.as_ptr(),
            libc::O_RDONLY,
            0,
        );
        libc::posix_spawn_file_actions_addopen(
            &mut file_actions,
            libc::STDOUT_FILENO,
            dev_null.as_ptr(),
            libc::O_WRONLY,
            0,
        );
        libc::posix_spawn_file_actions_addopen(
            &mut file_actions,
            libc::STDERR_FILENO,
            dev_null.as_ptr(),
            libc::O_WRONLY,
            0,
        );

        let cwd = CString::new(info.cwd.as_str()).ok();
        if let Some(ref cwd) = cwd {
            libc::chdir(cwd.as_ptr());
        }

        let mut pid: libc::pid_t = 0;
        let ret = libc::posix_spawnp(
            &mut pid,
            c_cmd[0].as_ptr(),
            &file_actions,
            &attr,
            argv_ptrs.as_ptr(),
            envp_ptrs.as_ptr(),
        );

        libc::posix_spawn_file_actions_destroy(&mut file_actions);
        libc::posix_spawnattr_destroy(&mut attr);

        Some(ret == 0)
    }
}

pub fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }

    if let Some(window) = app.get_webview_window("main") {
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
        let _ = window.hide();
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
        installer.install_path.clone()
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
pub async fn start_install(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OkResult, String> {
    let mut installer = state.installer.lock().await;
    if state.context.dev_mode {
        setup::check_all(&mut installer, &state.context, &app).await;
        return Ok(OkResult { ok: false });
    }
    let result = setup::install_all(&mut installer, &state.context, &app).await;

    if result.is_ok() && installer.run_after_install && installer.can_launch {
        if let Some(info) = setup::get_launch_info(&installer).await {
            spawn_detached(&info);
        }
    }

    Ok(OkResult {
        ok: result.is_ok(),
    })
}

#[tauri::command]
pub async fn launch_desktop(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OkResult, String> {
    let installer = state.installer.lock().await;

    if is_desktop_alive(&installer.install_path) {
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

    Ok(OkResult {
        ok: result.is_ok(),
    })
}
