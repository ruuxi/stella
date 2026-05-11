// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;
mod commands;
mod disk;
mod protected_storage;
mod setup;
mod shell;
mod state;

use state::AppState;
use std::path::PathBuf;
use tauri::Emitter;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_updater::UpdaterExt;

const LAUNCHER_UPDATE_INITIAL_DELAY_SECS: u64 = 2;
const LAUNCHER_UPDATE_POLL_SECS: u64 = 15 * 60;
/// How long after the last successful launcher-update check to wait before
/// re-checking on window focus. Keeps the focus-triggered check from spamming
/// the updater endpoint when the user is rapidly switching windows.
const LAUNCHER_UPDATE_FOCUS_REFRESH_MS: u64 = 60_000;
use tokio::sync::Mutex;

fn cli_dev_path_override() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--dev-path" {
            let value = args.next()?.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
            return None;
        }
    }
    None
}

fn dev_path_override() -> Option<String> {
    let cli_override = cli_dev_path_override();
    if cli_override.is_some() {
        return cli_override;
    }

    let explicit = std::env::var("STELLA_LAUNCHER_DEV_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if explicit.is_some() {
        return explicit;
    }

    let enabled = std::env::var("STELLA_LAUNCHER_DEV")
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes"
        })
        .unwrap_or(false);
    if !enabled {
        return None;
    }

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    Some(repo_root.to_string_lossy().to_string())
}

fn schedule_launcher_update_check(app: tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(
            LAUNCHER_UPDATE_INITIAL_DELAY_SECS,
        ))
        .await;

        loop {
            let _ = check_for_launcher_update(&app, false).await;
            tokio::time::sleep(std::time::Duration::from_secs(LAUNCHER_UPDATE_POLL_SECS)).await;
        }
    });
}

pub async fn check_for_launcher_update(
    app: &tauri::AppHandle,
    surface_errors: bool,
) -> Result<bool, String> {
    let Some(app_state) = app.try_state::<AppState>() else {
        return Err("Launcher state is not ready.".into());
    };

    {
        let mut installer = app_state.installer.lock().await;
        installer.launcher_update.checking = true;
        if surface_errors {
            installer.launcher_update.error = None;
        }
        let _ = app.emit(
            "installer-state-update",
            serde_json::json!({ "state": &*installer }),
        );
    }

    let result: Result<Option<String>, String> = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let maybe_update = updater.check().await.map_err(|e| e.to_string())?;
        Ok(maybe_update.map(|update| update.version.clone()))
    }
    .await;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut installer = app_state.installer.lock().await;
    installer.launcher_update.checking = false;
    installer.launcher_update.last_checked_at_ms = now_ms;

    let outcome = match result {
        Ok(Some(version)) => {
            installer.launcher_update.available = true;
            installer.launcher_update.version = Some(version);
            installer.launcher_update.error = None;
            Ok(true)
        }
        Ok(None) => {
            installer.launcher_update.available = false;
            installer.launcher_update.version = None;
            installer.launcher_update.error = None;
            Ok(false)
        }
        Err(err) => {
            if surface_errors {
                installer.launcher_update.error = Some(err.clone());
            }
            Err(err)
        }
    };

    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );

    outcome
}

fn main() {
    if protected_storage::maybe_handle_cli() {
        return;
    }
    if std::env::args().any(|arg| arg == "--stella-protected-storage") {
        std::process::exit(1);
    }

    if bootstrap::maybe_handle_uninstall() {
        return;
    }

    let dev_install_path = dev_path_override();

    // Discord-style self-install: on first run from a non-installed location,
    // copy ourselves to %LocalAppData%\Stella, create shortcuts, and re-launch.
    if dev_install_path.is_none() && bootstrap::ensure_installed() {
        return;
    }

    // Ensure WebView2 is installed (downloads bootstrapper if missing)
    if !bootstrap::ensure_webview2() {
        eprintln!("Failed to install WebView2 runtime. Please install it manually from https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            // Paths
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let default_install_path = dev_install_path
                .clone()
                .unwrap_or_else(|| home.join("stella").to_string_lossy().to_string());

            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| home.join(".stella-launcher"));
            let settings_file = if dev_install_path.is_some() {
                app_data.join("installer-settings.dev.json")
            } else {
                app_data.join("installer-settings.json")
            };

            // Create context and initial state
            let ctx = setup::create_context(
                default_install_path,
                settings_file,
                dev_install_path.is_some(),
            );
            let initial_state = tauri::async_runtime::block_on(setup::create_initial_state(&ctx));

            let app_state = AppState {
                installer: Mutex::new(initial_state),
                context: ctx,
                desktop_watcher: std::sync::Mutex::new(None),
            };

            app.manage(app_state);

            if dev_install_path.is_none() {
                schedule_launcher_update_check(app.handle().clone());
            }

            // System tray
            let open_item = MenuItem::with_id(app, "open", "Open Stella", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new().menu(&menu).tooltip("Stella");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        commands::show_main_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_installer_state,
            commands::browse_install_location,
            commands::set_install_location,
            commands::set_run_after_install,
            commands::start_install,
            commands::launch_desktop,
            commands::check_launcher_update,
            commands::apply_launcher_update,
            commands::show_launcher_window,
            commands::stop_desktop,
            commands::is_desktop_running,
            commands::open_install_location,
            commands::uninstall_stella,
            commands::full_reset_stella,
        ])
        .on_window_event(|window, event| {
            if cfg!(debug_assertions) {
                return;
            }
            if let tauri::WindowEvent::Focused(true) = event {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let Some(app_state) = app.try_state::<AppState>() else {
                        return;
                    };
                    // Throttle: only re-check if it's been a while since the
                    // last successful check. Prevents focus thrashing from
                    // hammering the updater endpoint.
                    let should_check = {
                        let installer = app_state.installer.lock().await;
                        if installer.launcher_update.checking
                            || installer.launcher_update.installing
                        {
                            false
                        } else {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            installer.launcher_update.last_checked_at_ms == 0
                                || now_ms.saturating_sub(
                                    installer.launcher_update.last_checked_at_ms,
                                ) >= LAUNCHER_UPDATE_FOCUS_REFRESH_MS
                        }
                    };
                    if should_check {
                        let _ = check_for_launcher_update(&app, false).await;
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error running stella launcher");
}
