use std::path::{Path, PathBuf};
use tokio::fs;

const WINDOWS_SCRIPT_NAME: &str = "Stella-Recovery.cmd";
const MAC_SCRIPT_NAME: &str = "Stella-Recovery.command";
const LINUX_SCRIPT_NAME: &str = "stella-recovery.sh";
const README_NAME: &str = "README.txt";
const MANIFEST_NAME: &str = "recovery-manifest.json";

#[derive(Debug)]
pub struct RecoveryOk {
    pub recovery_dir: String,
}

#[derive(Debug)]
pub struct RecoveryError {
    pub recovery_dir: String,
    pub error_message: String,
}

pub enum RecoveryStatus {
    Ok(RecoveryOk),
    Err(RecoveryError),
}

impl RecoveryStatus {
    pub fn is_ok(&self) -> bool {
        matches!(self, RecoveryStatus::Ok(_))
    }

    pub fn error_message(&self) -> Option<&str> {
        match self {
            RecoveryStatus::Ok(_) => None,
            RecoveryStatus::Err(e) => Some(&e.error_message),
        }
    }
}

fn escape_batch(value: &str) -> String {
    value.replace('%', "%%")
}

fn escape_bash_single_quoted(value: &str) -> String {
    value.replace('\'', "'\\''")
}

fn build_windows_recovery_script(repo_root: &str) -> String {
    format!(
        r#"@echo off
setlocal enabledelayedexpansion
set "REPO={}"

echo.
echo Stella Recovery
echo Repository: %REPO%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not available in PATH.
  echo Install Git, then run this recovery script again.
  pause
  exit /b 1
)

set "FEATURE_COMMIT="
for /f "delims=" %%H in ('git -C "%REPO%" log --pretty^=format:%%H --fixed-strings --grep="[feature:" -n 1') do (
  set "FEATURE_COMMIT=%%H"
  goto :commit_found
)

:commit_found
if not defined FEATURE_COMMIT (
  echo No self-mod feature commit was found.
  pause
  exit /b 1
)

echo Reverting feature commit !FEATURE_COMMIT! ...
git -C "%REPO%" revert --no-edit !FEATURE_COMMIT!
if errorlevel 1 (
  echo.
  echo Recovery failed. Resolve Git conflicts manually, then retry.
  pause
  exit /b 1
)

echo.
echo Recovery completed. Restart Stella from the launcher.
pause
"#,
        escape_batch(repo_root)
    )
}

fn build_posix_recovery_script(repo_root: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
set -euo pipefail

REPO='{}'

echo
echo "Stella Recovery"
echo "Repository: $REPO"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "Git is not installed or not in PATH."
  echo "Install Git, then run this recovery script again."
  read -r -n 1 -p "Press any key to close..." || true
  echo
  exit 1
fi

FEATURE_COMMIT="$(git -C "$REPO" log --pretty=format:%H --fixed-strings --grep='[feature:' -n 1 || true)"
if [ -z "$FEATURE_COMMIT" ]; then
  echo "No self-mod feature commit was found."
  read -r -n 1 -p "Press any key to close..." || true
  echo
  exit 1
fi

echo "Reverting feature commit $FEATURE_COMMIT ..."
if ! git -C "$REPO" revert --no-edit "$FEATURE_COMMIT"; then
  echo
  echo "Recovery failed. Resolve Git conflicts manually, then retry."
  read -r -n 1 -p "Press any key to close..." || true
  echo
  exit 1
fi

echo
echo "Recovery completed. Restart Stella from the launcher."
read -r -n 1 -p "Press any key to close..." || true
echo
"#,
        escape_bash_single_quoted(repo_root)
    )
}

fn build_readme(desktop_dir: &str) -> String {
    format!(
        "Stella Recovery Scripts\n\
         =======================\n\
         \n\
         These launcher-managed scripts are the last-resort recovery path for Stella self-mod changes.\n\
         \n\
         - Windows: double-click `{WINDOWS_SCRIPT_NAME}`\n\
         - macOS: double-click `{MAC_SCRIPT_NAME}`\n\
         - Linux/manual shell: run `./{LINUX_SCRIPT_NAME}`\n\
         \n\
         Target desktop repository:\n\
         {desktop_dir}\n\
         \n\
         Each script reverts the latest Git commit tagged with `[feature:...]` in the Stella desktop repository.\n"
    )
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RecoveryManifest {
    version: u32,
    #[serde(rename = "desktopDir")]
    desktop_dir: String,
}

struct ExpectedArtifacts {
    windows_script_path: PathBuf,
    mac_script_path: PathBuf,
    linux_script_path: PathBuf,
    readme_path: PathBuf,
    manifest_path: PathBuf,
    windows_script: String,
    posix_script: String,
    readme: String,
    manifest: String,
}

fn build_expected_artifacts(recovery_dir: &str, desktop_dir: &str) -> ExpectedArtifacts {
    let normalized = std::fs::canonicalize(desktop_dir)
        .unwrap_or_else(|_| PathBuf::from(desktop_dir))
        .to_string_lossy()
        .to_string();
    // Strip UNC prefix on Windows
    let normalized = normalized
        .strip_prefix(r"\\?\")
        .unwrap_or(&normalized)
        .to_string();

    let rd = Path::new(recovery_dir);
    let manifest = RecoveryManifest {
        version: 1,
        desktop_dir: normalized.clone(),
    };

    ExpectedArtifacts {
        windows_script_path: rd.join(WINDOWS_SCRIPT_NAME),
        mac_script_path: rd.join(MAC_SCRIPT_NAME),
        linux_script_path: rd.join(LINUX_SCRIPT_NAME),
        readme_path: rd.join(README_NAME),
        manifest_path: rd.join(MANIFEST_NAME),
        windows_script: build_windows_recovery_script(&normalized),
        posix_script: build_posix_recovery_script(&normalized),
        readme: build_readme(&normalized),
        manifest: format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap_or_default()),
    }
}

async fn path_exists(p: &Path) -> bool {
    fs::metadata(p).await.is_ok()
}

async fn verify_recovery_target(desktop_dir: &str) -> Option<String> {
    let dd = Path::new(desktop_dir);
    if !path_exists(dd).await {
        return Some("Desktop install path does not exist.".into());
    }
    if !path_exists(&dd.join("package.json")).await {
        return Some("Desktop install path is missing package.json.".into());
    }
    if !path_exists(&dd.join(".git")).await {
        return Some("Desktop install path is missing Git metadata.".into());
    }
    None
}

async fn write_if_changed(file_path: &Path, content: &str) {
    if let Ok(existing) = fs::read_to_string(file_path).await {
        if existing == content {
            return;
        }
    }
    let _ = fs::write(file_path, content).await;
}

pub async fn ensure_launcher_recovery_artifacts(
    recovery_dir: &str,
    desktop_dir: &str,
) -> RecoveryStatus {
    if let Some(err) = verify_recovery_target(desktop_dir).await {
        return RecoveryStatus::Err(RecoveryError {
            recovery_dir: recovery_dir.into(),
            error_message: err,
        });
    }

    let expected = build_expected_artifacts(recovery_dir, desktop_dir);

    if let Err(e) = fs::create_dir_all(recovery_dir).await {
        return RecoveryStatus::Err(RecoveryError {
            recovery_dir: recovery_dir.into(),
            error_message: format!("Recovery artifacts could not be written: {e}"),
        });
    }

    write_if_changed(&expected.windows_script_path, &expected.windows_script).await;
    write_if_changed(&expected.mac_script_path, &expected.posix_script).await;
    write_if_changed(&expected.linux_script_path, &expected.posix_script).await;
    write_if_changed(&expected.readme_path, &expected.readme).await;
    write_if_changed(&expected.manifest_path, &expected.manifest).await;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&expected.mac_script_path, &expected.linux_script_path] {
            if let Ok(meta) = fs::metadata(path).await {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(path, perms).await;
            }
        }
    }

    // Verify
    verify_launcher_recovery_artifacts(recovery_dir, desktop_dir).await
}

pub async fn verify_launcher_recovery_artifacts(
    recovery_dir: &str,
    desktop_dir: &str,
) -> RecoveryStatus {
    if let Some(err) = verify_recovery_target(desktop_dir).await {
        return RecoveryStatus::Err(RecoveryError {
            recovery_dir: recovery_dir.into(),
            error_message: err,
        });
    }

    let expected = build_expected_artifacts(recovery_dir, desktop_dir);

    let files_match = async {
        let ws = fs::read_to_string(&expected.windows_script_path).await?;
        let ms = fs::read_to_string(&expected.mac_script_path).await?;
        let ls = fs::read_to_string(&expected.linux_script_path).await?;
        let rm = fs::read_to_string(&expected.readme_path).await?;
        let mf = fs::read_to_string(&expected.manifest_path).await?;

        Ok::<bool, std::io::Error>(
            ws == expected.windows_script
                && ms == expected.posix_script
                && ls == expected.posix_script
                && rm == expected.readme
                && mf == expected.manifest,
        )
    }
    .await;

    match files_match {
        Ok(true) => RecoveryStatus::Ok(RecoveryOk {
            recovery_dir: recovery_dir.into(),
        }),
        Ok(false) => RecoveryStatus::Err(RecoveryError {
            recovery_dir: recovery_dir.into(),
            error_message: "Recovery artifacts are missing or out of date.".into(),
        }),
        Err(e) => RecoveryStatus::Err(RecoveryError {
            recovery_dir: recovery_dir.into(),
            error_message: format!("Recovery artifacts could not be verified: {e}"),
        }),
    }
}
