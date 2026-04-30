// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;
mod commands;
mod disk;
mod setup;
mod shell;
mod state;

use state::AppState;
use std::path::PathBuf;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

const LAUNCHER_UPDATE_INITIAL_DELAY_SECS: u64 = 5;
const LAUNCHER_UPDATE_POLL_SECS: u64 = 6 * 60 * 60;
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
            check_for_launcher_update(&app).await;
            tokio::time::sleep(std::time::Duration::from_secs(LAUNCHER_UPDATE_POLL_SECS)).await;
        }
    });
}

async fn check_for_launcher_update(app: &tauri::AppHandle) {
    let Ok(updater) = app.updater() else {
        return;
    };
    let Ok(Some(update)) = updater.check().await else {
        return;
    };

    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    let mut installer = app_state.installer.lock().await;
    if installer.launcher_update.available
        && installer.launcher_update.version.as_deref() == Some(update.version.as_str())
    {
        return;
    }
    installer.launcher_update.available = true;
    installer.launcher_update.version = Some(update.version.clone());
    installer.launcher_update.error = None;
    let _ = app.emit(
        "installer-state-update",
        serde_json::json!({ "state": &*installer }),
    );
}

fn main() {
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
            commands::apply_launcher_update,
            commands::show_launcher_window,
            commands::stop_desktop,
            commands::is_desktop_running,
            commands::open_install_location,
            commands::uninstall_stella,
        ])
        .on_window_event(|_window, _event| {})
        .run(tauri::generate_context!())
        .expect("error running stella launcher");
}
