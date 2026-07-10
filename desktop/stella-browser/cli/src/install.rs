use std::fs;
use std::path::{Path, PathBuf};

fn browsers_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".stella-browser")
        .join("browsers")
}

pub fn find_installed_chrome() -> Option<PathBuf> {
    let mut versions: Vec<_> = fs::read_dir(browsers_dir())
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("chrome-"))
        })
        .collect();
    versions.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    versions
        .into_iter()
        .filter_map(|entry| chrome_binary_in_dir(&entry.path()))
        .find(|binary| binary.exists())
}

fn chrome_binary_in_dir(dir: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidates = [
        dir.join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        dir.join("chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        dir.join("chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    ];
    #[cfg(target_os = "linux")]
    let candidates = [dir.join("chrome"), dir.join("chrome-linux64/chrome")];
    #[cfg(target_os = "windows")]
    let candidates = [dir.join("chrome.exe"), dir.join("chrome-win64/chrome.exe")];
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let candidates: [PathBuf; 0] = [];

    candidates.into_iter().find(|candidate| candidate.exists())
}
