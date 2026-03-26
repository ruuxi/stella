use crate::setup;
use crate::state::*;
use serde::Serialize;
use std::process::{Command as StdCommand, Stdio};
use tauri::{AppHandle, Emitter, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    let result = setup::install_all(&mut installer, &state.context, &app).await;

    if result.is_ok() && installer.run_after_install && installer.can_launch {
        // Launch desktop
        if let Some(info) = setup::get_launch_info(&installer).await {
            let mut cmd = StdCommand::new(&info.command[0]);
            cmd.args(&info.command[1..])
                .current_dir(&info.cwd)
                .envs(&info.env)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let child = cmd.spawn();

            if let Ok(child) = child {
                let mut proc = state.desktop_process.lock().await;
                *proc = Some(child);
            }
        }
    }

    Ok(OkResult {
        ok: result.is_ok(),
    })
}

#[tauri::command]
pub async fn launch_desktop(state: State<'_, AppState>) -> Result<OkResult, String> {
    let installer = state.installer.lock().await;

    if let Some(info) = setup::get_launch_info(&installer).await {
        let mut cmd = StdCommand::new(&info.command[0]);
        cmd.args(&info.command[1..])
            .current_dir(&info.cwd)
            .envs(&info.env)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let child = cmd.spawn();

        match child {
            Ok(child) => {
                let mut proc = state.desktop_process.lock().await;
                *proc = Some(child);
                Ok(OkResult { ok: true })
            }
            Err(_) => Ok(OkResult { ok: false }),
        }
    } else {
        Ok(OkResult { ok: false })
    }
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
