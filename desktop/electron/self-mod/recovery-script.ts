import { promises as fs } from "fs";
import path from "path";

const writeIfChanged = async (filePath: string, content: string) => {
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing === content) {
      return;
    }
  } catch {
    // File does not exist yet.
  }
  await fs.writeFile(filePath, content, "utf-8");
};

const escapeBatchValue = (value: string) =>
  value.replace(/%/g, "%%");

const escapeBashSingleQuoted = (value: string) =>
  value.replace(/'/g, `'\\''`);

const buildWindowsRecoveryScript = (repoRoot: string) => `@echo off
setlocal enabledelayedexpansion
set "REPO=${escapeBatchValue(repoRoot)}"

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
echo Recovery completed. Restart Stella.
pause
`;

const buildPosixRecoveryScript = (repoRoot: string) => `#!/usr/bin/env bash
set -euo pipefail

REPO='${escapeBashSingleQuoted(repoRoot)}'

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
echo "Recovery completed. Restart Stella."
read -r -n 1 -p "Press any key to close..." || true
echo
`;

const README_TEXT = `Stella Recovery Scripts
=======================

Use these scripts only as a last resort when Stella's UI is unresponsive.

- Windows: double-click \`Stella-Recovery.cmd\`
- macOS: double-click \`Stella-Recovery.command\`
- Linux/manual shell: run \`./stella-recovery.sh\`

Each script reverts the latest Git commit tagged with \`[feature:...]\` in the Stella frontend repository.
`;

export const ensureLastResortRecoveryScripts = async (args: {
  stellaHomePath: string;
  frontendRoot: string;
}) => {
  const recoveryDir = path.join(args.stellaHomePath, "recovery");
  await fs.mkdir(recoveryDir, { recursive: true });

  const windowsScriptPath = path.join(recoveryDir, "Stella-Recovery.cmd");
  const macScriptPath = path.join(recoveryDir, "Stella-Recovery.command");
  const linuxScriptPath = path.join(recoveryDir, "stella-recovery.sh");
  const readmePath = path.join(recoveryDir, "README.txt");

  const windowsScript = buildWindowsRecoveryScript(args.frontendRoot);
  const posixScript = buildPosixRecoveryScript(args.frontendRoot);

  await writeIfChanged(windowsScriptPath, windowsScript);
  await writeIfChanged(macScriptPath, posixScript);
  await writeIfChanged(linuxScriptPath, posixScript);
  await writeIfChanged(readmePath, README_TEXT);

  try {
    await fs.chmod(macScriptPath, 0o755);
    await fs.chmod(linuxScriptPath, 0o755);
  } catch {
    // Best effort on platforms without chmod support for these files.
  }
};

