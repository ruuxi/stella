import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";

// Windows counterpart of `macos-dev-app.mjs`. Stock Electron from
// node_modules runs as `electron.exe` with the generic Electron icon baked
// into the binary — that exe identity is what the Windows shell falls back to
// for the taskbar, alt-tab, and tray whenever AppUserModelID → Start Menu
// shortcut resolution doesn't apply (e.g. right after an in-app update
// respawns the process outside the stamped shortcut). Instead of patching
// runtime `BrowserWindow.icon` only, copy the binary to `Stella.exe` in the
// same dist directory (so it keeps resolving its DLLs/resources) and rewrite
// its icon + version strings with the rcedit binary the `rcedit` npm package
// ships.

const require = createRequire(import.meta.url);

const MARKER_FILE_NAME = ".stella-dev-app.json";

const resolveRceditBinary = () => {
  try {
    const rceditLib = require.resolve("rcedit");
    const binDir = path.join(path.dirname(rceditLib), "..", "bin");
    const candidates =
      process.arch === "x64" || process.arch === "arm64"
        ? ["rcedit-x64.exe", "rcedit.exe"]
        : ["rcedit.exe", "rcedit-x64.exe"];
    for (const candidate of candidates) {
      const candidatePath = path.join(binDir, candidate);
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  } catch {
    // rcedit not installed; caller falls back to the stock binary.
  }
  return null;
};

const readElectronVersion = (distDir) => {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(distDir, "..", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
};

const hashFile = (filePath) => {
  try {
    return createHash("md5").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
};

const readMarker = (markerFile) => {
  try {
    return JSON.parse(readFileSync(markerFile, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Produce (or reuse) the branded `Stella.exe` next to `electron.exe` and
 * return its path. Returns the stock binary untouched when anything fails —
 * a running instance keeps `Stella.exe` locked, rcedit is unavailable, or
 * the icon asset is missing — so dev startup never breaks on branding.
 */
export const prepareWinDevAppExecutable = ({ electronBinary, desktopDir }) => {
  if (process.platform !== "win32") {
    return electronBinary;
  }

  const distDir = path.dirname(electronBinary);
  const brandedBinary = path.join(distDir, "Stella.exe");
  const markerFile = path.join(distDir, MARKER_FILE_NAME);
  const iconPath = path.join(desktopDir, "build", "icon.ico");
  if (!existsSync(iconPath)) {
    return electronBinary;
  }

  const marker = {
    electronVersion: readElectronVersion(distDir),
    iconHash: hashFile(iconPath),
  };

  const existing = readMarker(markerFile);
  if (
    existsSync(brandedBinary) &&
    existing &&
    existing.electronVersion === marker.electronVersion &&
    existing.iconHash === marker.iconHash
  ) {
    return brandedBinary;
  }

  const rceditBinary = resolveRceditBinary();
  if (!rceditBinary) {
    return electronBinary;
  }

  try {
    copyFileSync(electronBinary, brandedBinary);
    execFileSync(
      rceditBinary,
      [
        brandedBinary,
        "--set-icon",
        iconPath,
        "--set-version-string",
        "ProductName",
        "Stella",
        "--set-version-string",
        "FileDescription",
        "Stella",
        "--set-version-string",
        "OriginalFilename",
        "Stella.exe",
        "--set-version-string",
        "InternalName",
        "Stella",
      ],
      { stdio: "ignore", windowsHide: true, timeout: 60_000 },
    );
    writeFileSync(markerFile, JSON.stringify(marker));
    return brandedBinary;
  } catch (error) {
    console.warn(
      `[windows-dev-app] Failed to brand Stella.exe (${error?.message ?? error}); using stock electron.exe.`,
    );
    // A stale-but-matching copy is still preferable to the Electron icon;
    // a stale copy from a *different* Electron version is not (its DLLs in
    // dist no longer match), so only reuse when the recorded version matches.
    if (
      existsSync(brandedBinary) &&
      existing &&
      existing.electronVersion === marker.electronVersion
    ) {
      return brandedBinary;
    }
    return electronBinary;
  }
};
