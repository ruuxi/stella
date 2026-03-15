use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct DetectedBrowser {
    pub name: &'static str,
    pub executable_path: PathBuf,
    pub profile_dir: PathBuf,
    pub process_name: &'static str,
}

struct BrowserCandidate {
    name: &'static str,
    process_name: &'static str,
    win_exe: Option<&'static str>,
    win_profile: Option<Vec<String>>,
    mac_exe: Option<&'static str>,
    mac_profile: Option<Vec<String>>,
    linux_exe: Option<&'static str>,
    linux_profile: Option<Vec<String>>,
}

fn browser_candidates() -> Vec<BrowserCandidate> {
    vec![
        BrowserCandidate {
            name: "Chrome",
            process_name: "chrome",
            win_exe: Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            win_profile: Some(vec!["Google".into(), "Chrome".into(), "User Data".into()]),
            mac_exe: Some("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            mac_profile: Some(vec![
                "Library".into(),
                "Application Support".into(),
                "Google Chrome".into(),
            ]),
            linux_exe: Some("/usr/bin/google-chrome"),
            linux_profile: Some(vec![".config".into(), "google-chrome".into()]),
        },
        BrowserCandidate {
            name: "Edge",
            process_name: "msedge",
            win_exe: Some(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            win_profile: Some(vec!["Microsoft".into(), "Edge".into(), "User Data".into()]),
            mac_exe: Some("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            mac_profile: Some(vec![
                "Library".into(),
                "Application Support".into(),
                "Microsoft Edge".into(),
            ]),
            linux_exe: Some("/usr/bin/microsoft-edge"),
            linux_profile: Some(vec![".config".into(), "microsoft-edge".into()]),
        },
        BrowserCandidate {
            name: "Brave",
            process_name: "brave",
            win_exe: Some(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
            win_profile: Some(vec![
                "BraveSoftware".into(),
                "Brave-Browser".into(),
                "User Data".into(),
            ]),
            mac_exe: Some("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
            mac_profile: Some(vec![
                "Library".into(),
                "Application Support".into(),
                "BraveSoftware".into(),
                "Brave-Browser".into(),
            ]),
            linux_exe: Some("/usr/bin/brave-browser"),
            linux_profile: Some(vec![
                ".config".into(),
                "BraveSoftware".into(),
                "Brave-Browser".into(),
            ]),
        },
        BrowserCandidate {
            name: "Vivaldi",
            process_name: "vivaldi",
            win_exe: None,
            win_profile: Some(vec!["Vivaldi".into(), "User Data".into()]),
            mac_exe: Some("/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"),
            mac_profile: Some(vec![
                "Library".into(),
                "Application Support".into(),
                "Vivaldi".into(),
            ]),
            linux_exe: Some("/usr/bin/vivaldi"),
            linux_profile: Some(vec![".config".into(), "vivaldi".into()]),
        },
        BrowserCandidate {
            name: "Arc",
            process_name: "Arc",
            win_exe: None,
            win_profile: None,
            mac_exe: Some("/Applications/Arc.app/Contents/MacOS/Arc"),
            mac_profile: Some(vec![
                "Library".into(),
                "Application Support".into(),
                "Arc".into(),
                "User Data".into(),
            ]),
            linux_exe: None,
            linux_profile: None,
        },
    ]
}

pub fn detect_default_browser() -> Option<DetectedBrowser> {
    let installed = detect_browsers();
    if installed.is_empty() {
        return None;
    }

    for browser in &installed {
        if is_browser_running(browser) {
            return Some(browser.clone());
        }
    }

    installed.into_iter().next()
}

pub fn find_extension_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(home) = std::env::var("STELLA_BROWSER_HOME") {
        candidates.push(PathBuf::from(home).join("extension"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("extension"));
            candidates.push(dir.join("../extension"));
            candidates.push(dir.join("../../extension"));
            candidates.push(dir.join("../../../extension"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("extension"));
        candidates.push(cwd.join("../extension"));
    }

    candidates
        .into_iter()
        .find(|path| path.exists() && path.is_dir())
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
}

pub async fn relaunch_for_extension_bridge(extra_args: &[String]) -> Result<DetectedBrowser, String> {
    let extra_args = extra_args.to_vec();
    tokio::task::spawn_blocking(move || relaunch_for_extension_bridge_blocking(&extra_args))
        .await
        .map_err(|e| format!("Browser relaunch task failed: {}", e))?
}

fn relaunch_for_extension_bridge_blocking(extra_args: &[String]) -> Result<DetectedBrowser, String> {
    let detected = detect_default_browser().ok_or_else(|| {
        "No Chromium browser found. Install Chrome, Edge, Brave, or another Chromium browser."
            .to_string()
    })?;

    graceful_shutdown(&detected, Duration::from_secs(10));
    thread::sleep(Duration::from_millis(1500));

    let extension_path = find_extension_dir()
        .ok_or_else(|| "Could not find extension directory for user-browser relaunch".to_string())?;

    let mut args = vec![
        "--silent-debugger-extension-api".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--hide-crash-restore-bubble".to_string(),
        "--disable-session-crashed-bubble".to_string(),
        "--restore-last-session".to_string(),
        format!("--disable-extensions-except={}", extension_path.display()),
        format!("--load-extension={}", extension_path.display()),
    ];
    if extra_args.is_empty() {
        // Load one normal web page so the extension's content-script keepalive
        // can wake the MV3 service worker after a cold browser relaunch.
        args.push("https://example.com/".to_string());
    } else {
        args.extend(extra_args.iter().cloned());
    }

    spawn_detached(&detected.executable_path, &args)?;

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if is_browser_running(&detected) {
            return Ok(detected);
        }
        thread::sleep(Duration::from_millis(500));
    }

    Err(format!("{} failed to start within 15 seconds", detected.name))
}

fn detect_browsers() -> Vec<DetectedBrowser> {
    browser_candidates()
        .into_iter()
        .filter_map(|candidate| detect_browser(candidate))
        .collect()
}

fn detect_browser(candidate: BrowserCandidate) -> Option<DetectedBrowser> {
    let (exe, profile) = if cfg!(target_os = "windows") {
        (
            candidate
                .win_exe
                .map(PathBuf::from)
                .or_else(|| {
                    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
                    Some(PathBuf::from(local_app_data).join("Vivaldi/Application/vivaldi.exe"))
                }),
            candidate
                .win_profile
                .and_then(build_local_app_data_path),
        )
    } else if cfg!(target_os = "macos") {
        (
            candidate.mac_exe.map(PathBuf::from),
            candidate.mac_profile.and_then(build_home_path),
        )
    } else if cfg!(target_os = "linux") {
        (
            candidate.linux_exe.map(PathBuf::from),
            candidate.linux_profile.and_then(build_home_path),
        )
    } else {
        (None, None)
    };

    let executable_path = exe?;
    let profile_dir = profile?;

    if executable_path.exists() {
        Some(DetectedBrowser {
            name: candidate.name,
            executable_path,
            profile_dir,
            process_name: candidate.process_name,
        })
    } else {
        None
    }
}

fn build_home_path(parts: Vec<String>) -> Option<PathBuf> {
    let mut path = dirs::home_dir()?;
    for part in parts {
        path.push(part);
    }
    Some(path)
}

fn build_local_app_data_path(parts: Vec<String>) -> Option<PathBuf> {
    let mut path = PathBuf::from(std::env::var("LOCALAPPDATA").ok()?);
    for part in parts {
        path.push(part);
    }
    Some(path)
}

fn is_browser_running(browser: &DetectedBrowser) -> bool {
    if cfg!(target_os = "windows") {
        Command::new("tasklist")
            .args([
                "/FI",
                &format!("IMAGENAME eq {}.exe", browser.process_name),
                "/NH",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .is_some_and(|output| output.contains(browser.process_name))
    } else {
        Command::new("pgrep")
            .args(["-x", browser.process_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn graceful_shutdown(browser: &DetectedBrowser, timeout: Duration) {
    if !is_browser_running(browser) {
        return;
    }

    if cfg!(target_os = "windows") {
        let _ = Command::new("taskkill")
            .args(["/IM", &format!("{}.exe", browser.process_name)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else if cfg!(target_os = "macos") {
        let app_name = browser.name;
        let apple_script = format!(r#"tell application "{}" to quit"#, app_name);
        let graceful = Command::new("osascript")
            .args(["-e", &apple_script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

        if !graceful {
            let _ = Command::new("pkill")
                .args(["-TERM", browser.process_name])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    } else {
        let _ = Command::new("pkill")
            .args(["-TERM", browser.process_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !is_browser_running(browser) {
            return;
        }
        thread::sleep(Duration::from_millis(500));
    }

    if cfg!(target_os = "windows") {
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", &format!("{}.exe", browser.process_name)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else {
        let _ = Command::new("pkill")
            .args(["-9", browser.process_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    thread::sleep(Duration::from_secs(1));
}

fn spawn_detached(executable_path: &Path, args: &[String]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new(executable_path);
        command.args(args);
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to relaunch browser: {}", e))?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;

        Command::new(executable_path)
            .args(args)
            .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to relaunch browser: {}", e))?;
    }

    Ok(())
}
