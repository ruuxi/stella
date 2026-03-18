import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const WINDOWS_SCRIPT_NAME = "Stella-Recovery.cmd";
const MAC_SCRIPT_NAME = "Stella-Recovery.command";
const LINUX_SCRIPT_NAME = "stella-recovery.sh";
const README_NAME = "README.txt";
const MANIFEST_NAME = "recovery-manifest.json";

type RecoveryArtifactArgs = {
	recoveryDir: string;
	desktopDir: string;
};

type RecoveryManifest = {
	version: 1;
	desktopDir: string;
};

export type RecoveryStatus =
	| {
			ok: true;
			recoveryDir: string;
	  }
	| {
			ok: false;
			recoveryDir: string;
			errorMessage: string;
	  };

const writeIfChanged = async (filePath: string, content: string) => {
	try {
		const existing = await readFile(filePath, "utf8");
		if (existing === content) {
			return;
		}
	} catch {
		// File does not exist yet.
	}

	await writeFile(filePath, content, "utf8");
};

const exists = async (targetPath: string) => {
	try {
		await stat(targetPath);
		return true;
	} catch {
		return false;
	}
};

const escapeBatchValue = (value: string) => value.replace(/%/g, "%%");

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
echo Recovery completed. Restart Stella from the launcher.
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
echo "Recovery completed. Restart Stella from the launcher."
read -r -n 1 -p "Press any key to close..." || true
echo
`;

const buildReadme = (desktopDir: string) => `Stella Recovery Scripts
=======================

These launcher-managed scripts are the last-resort recovery path for Stella self-mod changes.

- Windows: double-click \`${WINDOWS_SCRIPT_NAME}\`
- macOS: double-click \`${MAC_SCRIPT_NAME}\`
- Linux/manual shell: run \`./${LINUX_SCRIPT_NAME}\`

Target desktop repository:
${desktopDir}

Each script reverts the latest Git commit tagged with \`[feature:...]\` in the Stella desktop repository.
`;

const buildExpectedArtifacts = ({ recoveryDir, desktopDir }: RecoveryArtifactArgs) => {
	const normalizedDesktopDir = path.resolve(desktopDir);
	const windowsScript = buildWindowsRecoveryScript(normalizedDesktopDir);
	const posixScript = buildPosixRecoveryScript(normalizedDesktopDir);
	const manifest: RecoveryManifest = {
		version: 1,
		desktopDir: normalizedDesktopDir,
	};

	return {
		windowsScriptPath: path.join(recoveryDir, WINDOWS_SCRIPT_NAME),
		macScriptPath: path.join(recoveryDir, MAC_SCRIPT_NAME),
		linuxScriptPath: path.join(recoveryDir, LINUX_SCRIPT_NAME),
		readmePath: path.join(recoveryDir, README_NAME),
		manifestPath: path.join(recoveryDir, MANIFEST_NAME),
		windowsScript,
		posixScript,
		readme: buildReadme(normalizedDesktopDir),
		manifest: `${JSON.stringify(manifest, null, 2)}\n`,
	};
};

const verifyRecoveryTarget = async (desktopDir: string) => {
	const packageJsonPath = path.join(desktopDir, "package.json");
	const gitPath = path.join(desktopDir, ".git");

	if (!(await exists(desktopDir))) {
		return "Desktop install path does not exist.";
	}
	if (!(await exists(packageJsonPath))) {
		return "Desktop install path is missing package.json.";
	}
	if (!(await exists(gitPath))) {
		return "Desktop install path is missing Git metadata.";
	}
	return null;
};

export const verifyLauncherRecoveryArtifacts = async (
	args: RecoveryArtifactArgs,
): Promise<RecoveryStatus> => {
	const targetError = await verifyRecoveryTarget(args.desktopDir);
	if (targetError) {
		return {
			ok: false,
			recoveryDir: args.recoveryDir,
			errorMessage: targetError,
		};
	}

	const expected = buildExpectedArtifacts(args);

	try {
		const [
			windowsScript,
			macScript,
			linuxScript,
			readme,
			manifest,
		] = await Promise.all([
			readFile(expected.windowsScriptPath, "utf8"),
			readFile(expected.macScriptPath, "utf8"),
			readFile(expected.linuxScriptPath, "utf8"),
			readFile(expected.readmePath, "utf8"),
			readFile(expected.manifestPath, "utf8"),
		]);

		if (
			windowsScript !== expected.windowsScript
			|| macScript !== expected.posixScript
			|| linuxScript !== expected.posixScript
			|| readme !== expected.readme
			|| manifest !== expected.manifest
		) {
			return {
				ok: false,
				recoveryDir: args.recoveryDir,
				errorMessage: "Recovery artifacts are missing or out of date.",
			};
		}

		return { ok: true, recoveryDir: args.recoveryDir };
	} catch (error) {
		return {
			ok: false,
			recoveryDir: args.recoveryDir,
			errorMessage: `Recovery artifacts could not be verified: ${(error as Error).message}`,
		};
	}
};

export const ensureLauncherRecoveryArtifacts = async (
	args: RecoveryArtifactArgs,
): Promise<RecoveryStatus> => {
	const targetError = await verifyRecoveryTarget(args.desktopDir);
	if (targetError) {
		return {
			ok: false,
			recoveryDir: args.recoveryDir,
			errorMessage: targetError,
		};
	}

	const expected = buildExpectedArtifacts(args);

	try {
		await mkdir(args.recoveryDir, { recursive: true });
		await Promise.all([
			writeIfChanged(expected.windowsScriptPath, expected.windowsScript),
			writeIfChanged(expected.macScriptPath, expected.posixScript),
			writeIfChanged(expected.linuxScriptPath, expected.posixScript),
			writeIfChanged(expected.readmePath, expected.readme),
			writeIfChanged(expected.manifestPath, expected.manifest),
		]);

		if (process.platform !== "win32") {
			await Promise.all([
				chmod(expected.macScriptPath, 0o755),
				chmod(expected.linuxScriptPath, 0o755),
			]);
		}
	} catch (error) {
		return {
			ok: false,
			recoveryDir: args.recoveryDir,
			errorMessage: `Recovery artifacts could not be written: ${(error as Error).message}`,
		};
	}

	return verifyLauncherRecoveryArtifacts(args);
};
