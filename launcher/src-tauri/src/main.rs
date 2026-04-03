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
use tokio::sync::Mutex;

fn main() {
    // Discord-style self-install: on first run from a non-installed location,
    // copy ourselves to %LocalAppData%\Stella, create shortcuts, and re-launch.
    if bootstrap::ensure_installed() {
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
        .setup(|app| {
            // Paths
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let default_install_path = home.join("Stella").to_string_lossy().to_string();

            let app_data = app.path().app_data_dir().unwrap_or_else(|_| {
                home.join(".stella-launcher")
            });
            let settings_file = app_data.join("installer-settings.json");

            // Create context and initial state
            let ctx = setup::create_context(default_install_path, settings_file);
            let initial_state =
                tauri::async_runtime::block_on(setup::create_initial_state(&ctx));

            let app_state = AppState {
                installer: Mutex::new(initial_state),
                context: ctx,
                desktop_process: Mutex::new(None),
            };

            app.manage(app_state);

            // System tray
            let open_item = MenuItem::with_id(app, "open", "Open Stella", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Stella")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "open" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            let state = app.state::<AppState>();
                            if let Ok(mut proc) = state.desktop_process.try_lock() {
                                if let Some(ref mut child) = *proc {
                                    let _ = child.kill();
                                }
                                *proc = None;
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
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
            commands::stop_desktop,
            commands::is_desktop_running,
            commands::open_install_location,
            commands::uninstall_stella,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let result = state.desktop_process.try_lock();
                if let Ok(mut proc) = result {
                    if let Some(ref mut child) = *proc {
                        let _ = child.kill();
                    }
                    *proc = None;
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error running stella launcher");
}
