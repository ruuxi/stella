//! Self-install bootstrap — Discord/Spotify-style.
//!
//! On first run, the exe copies itself to a permanent location,
//! creates shortcuts, registers for uninstall, and re-launches from the installed path.
//! Also ensures WebView2 is installed on Windows before the Tauri app starts.

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Spawn a command with console window hidden on Windows.
fn silent_cmd(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Where the launcher lives once installed.
fn install_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join("AppData")
                .join("Local")
                .to_string_lossy()
                .to_string()
        });
        PathBuf::from(local_app_data).join("Stella")
    } else {
        dirs::data_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".stella"))
            .join("Stella")
    }
}

fn installed_exe_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "Stella.exe"
    } else {
        "Stella"
    };
    install_dir().join(name)
}

fn is_running_from_install_dir() -> bool {
    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };

    let target = installed_exe_path();

    let current = std::fs::canonicalize(&current_exe).unwrap_or(current_exe);
    let target = std::fs::canonicalize(&target).unwrap_or(target);

    current == target
}

/// Check if we need to self-install. If so, install and re-launch.
/// Returns `true` if the current process should exit (re-launch happened).
pub fn ensure_installed() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }

    if is_running_from_install_dir() {
        return false;
    }

    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };

    let target_dir = install_dir();
    let target_exe = installed_exe_path();

    if std::fs::create_dir_all(&target_dir).is_err() {
        return false;
    }

    if std::fs::copy(&current_exe, &target_exe).is_err() {
        return false;
    }

    create_shortcuts(&target_exe, &target_dir);
    register_uninstall(&target_exe, &target_dir);

    let _ = Command::new(&target_exe).spawn();

    true
}

/// Ensure WebView2 runtime is installed. Downloads and installs if missing.
pub fn ensure_webview2() -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        if is_webview2_installed() {
            return true;
        }

        let temp_dir = std::env::temp_dir();
        let bootstrapper_path = temp_dir.join("MicrosoftEdgeWebview2Setup.exe");

        let download_url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
        let result = silent_cmd("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Invoke-WebRequest -Uri '{}' -OutFile '{}'",
                    download_url,
                    bootstrapper_path.to_string_lossy()
                ),
            ])
            .output();

        if result.is_err() || !bootstrapper_path.exists() {
            return false;
        }

        // Run bootstrapper silently
        let install_result = silent_cmd(&bootstrapper_path.to_string_lossy())
            .args(["/silent", "/install"])
            .status();

        let _ = std::fs::remove_file(&bootstrapper_path);

        match install_result {
            Ok(status) => status.success() || is_webview2_installed(),
            Err(_) => false,
        }
    }
}

#[cfg(target_os = "windows")]
fn is_webview2_installed() -> bool {
    let reg_paths = [
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];

    for reg_path in &reg_paths {
        let result = silent_cmd("reg")
            .args(["query", reg_path, "/v", "pv"])
            .output();

        if let Ok(output) = result {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.contains("pv") && !stdout.contains("0.0.0.0") {
                    return true;
                }
            }
        }
    }

    false
}

fn create_shortcuts(exe_path: &Path, _working_dir: &Path) {
    #[cfg(target_os = "windows")]
    {
        let exe_str = exe_path.to_string_lossy();
        let home = dirs::home_dir().unwrap_or_default();

        let desktop_lnk = home.join("Desktop").join("Stella.lnk");
        create_win_lnk(&desktop_lnk, &exe_str);

        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
            home.join("AppData").join("Roaming").to_string_lossy().to_string()
        });
        let start_menu_dir = PathBuf::from(&appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        let _ = std::fs::create_dir_all(&start_menu_dir);
        let start_menu_lnk = start_menu_dir.join("Stella.lnk");
        create_win_lnk(&start_menu_lnk, &exe_str);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = exe_path;
    }
}

#[cfg(target_os = "windows")]
fn create_win_lnk(lnk_path: &Path, target: &str) {
    let esc = |s: &str| s.replace('\'', "''");
    let ps = format!(
        "$w = New-Object -ComObject WScript.Shell; \
         $s = $w.CreateShortcut('{}'); \
         $s.TargetPath = '{}'; \
         $s.Description = 'Stella AI Assistant'; \
         $s.Save()",
        esc(&lnk_path.to_string_lossy()),
        esc(target),
    );
    let _ = silent_cmd("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .output();
}

fn register_uninstall(exe_path: &Path, install_dir: &Path) {
    #[cfg(target_os = "windows")]
    {
        let reg_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Stella";
        let exe_str = exe_path.to_string_lossy().to_string();
        let dir_str = install_dir.to_string_lossy().to_string();

        let entries: &[(&str, &str, &str)] = &[
            ("DisplayName", "REG_SZ", "Stella"),
            ("DisplayVersion", "REG_SZ", "0.0.1"),
            ("Publisher", "REG_SZ", "Stella"),
            ("InstallLocation", "REG_SZ", &dir_str),
            ("DisplayIcon", "REG_SZ", &exe_str),
            ("UninstallString", "REG_SZ", &exe_str),
            ("NoModify", "REG_DWORD", "1"),
            ("NoRepair", "REG_DWORD", "1"),
        ];

        for (name, reg_type, data) in entries {
            let _ = silent_cmd("reg")
                .args(["add", reg_key, "/v", name, "/t", reg_type, "/d", data, "/f"])
                .output();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (exe_path, install_dir);
    }
}
