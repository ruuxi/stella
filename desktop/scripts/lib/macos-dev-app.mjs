import { execFileSync, execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Shared macOS dev-app identity helpers used by both dev launchers
// (`dev-electron.mjs` and `electron-static-preview.mjs`). Stock Electron from
// node_modules launches with the generic "Electron" Dock icon/name; these
// helpers rename the bundle to `Stella.app`, swap in the Stella icon, align the
// Info.plist identity, re-seal the ad-hoc signature, and resolve the
// `disclaim-spawn` helper so the launched process adopts the Stella.app bundle
// identity in the Dock instead of inheriting the launching shell's.

export const DEV_MACOS_APP_NAME = "Stella";
export const DEV_MACOS_BUNDLE_ID = "com.stella.app";
const DEV_MACOS_RUNTIME_DIR_NAME = ".stella-dev-runtime";

// Packaged apps get NSMicrophoneUsageDescription from electron-builder
// extendInfo. The stock Electron.app in node_modules does not, so macOS never
// shows the mic prompt for getUserMedia in dev — inject the same string we ship
// in production.
const MIC_USAGE_DESCRIPTION =
  "Stella uses your microphone for voice conversations.";

const readHash = (filePath) => {
  if (!existsSync(filePath)) {
    return null;
  }
  return createHash("md5").update(readFileSync(filePath)).digest("hex");
};

const patchDevIcon = (electronBinary, desktopDir) => {
  const appIcon = path.join(desktopDir, "build", "icon.icns");
  const appBundle = path.join(path.dirname(electronBinary), "..");
  const electronIcon = path.join(appBundle, "Resources", "electron.icns");
  const infoPlist = path.join(appBundle, "Info.plist");
  if (!existsSync(appIcon) || !existsSync(electronIcon)) {
    return false;
  }

  const srcHash = readHash(appIcon);
  const dstHash = readHash(electronIcon);
  if (srcHash === dstHash) {
    return false;
  }

  try {
    copyFileSync(appIcon, electronIcon);
    if (existsSync(infoPlist)) {
      execSync(`touch "${path.join(appBundle, "..")}"`, { stdio: "ignore" });
    }
    return true;
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
  return false;
};

// Renames the stock `Electron.app` bundle to `Stella.app`, rewrites `path.txt`,
// and aligns the Info.plist identity. Returns the (possibly updated) electron
// binary path alongside whether anything changed, since the renamed bundle lives
// at a new location.
const patchDevAppName = (electronBinary) => {
  let changed = false;
  const distDir = path.resolve(path.dirname(electronBinary), "..", "..", "..");
  const oldBundle = path.join(distDir, "Electron.app");
  const newBundle = path.join(distDir, "Stella.app");
  const pathTxtFile = path.resolve(distDir, "..", "path.txt");
  const hasOldBundle = existsSync(oldBundle);
  const hasNewBundle = existsSync(newBundle);

  if (!hasOldBundle && !hasNewBundle) {
    return { electronBinary, changed: false };
  }

  try {
    if (hasOldBundle && !hasNewBundle) {
      renameSync(oldBundle, newBundle);
      changed = true;
    }
    electronBinary = electronBinary.replace("Electron.app", "Stella.app");

    if (existsSync(pathTxtFile)) {
      const pathTxt = readFileSync(pathTxtFile, "utf8");
      const nextPathTxt = pathTxt.replace("Electron.app", "Stella.app");
      if (nextPathTxt !== pathTxt) {
        writeFileSync(pathTxtFile, nextPathTxt);
        changed = true;
      }
    }

    const infoPlist = path.join(newBundle, "Contents", "Info.plist");
    if (existsSync(infoPlist)) {
      let plist = readFileSync(infoPlist, "utf8");
      let plistChanged = false;

      const replaceStringValue = (key, nextValue) => {
        const pattern = new RegExp(
          `(<key>${key}</key>\\s*<string>)([^<]+)(<\\/string>)`,
        );
        const match = plist.match(pattern);
        if (match && match[2] !== nextValue) {
          plist = plist.replace(pattern, `$1${nextValue}$3`);
          plistChanged = true;
        }
      };

      // Keep the dev Electron bundle identity aligned with Stella so macOS TCC
      // permissions target the desktop app instead of the generic Electron app.
      replaceStringValue("CFBundleName", DEV_MACOS_APP_NAME);
      replaceStringValue("CFBundleDisplayName", DEV_MACOS_APP_NAME);
      replaceStringValue("CFBundleIdentifier", DEV_MACOS_BUNDLE_ID);

      if (plistChanged) {
        writeFileSync(infoPlist, plist);
        changed = true;
      }
    }

    if (changed) {
      execSync(`touch "${distDir}"`, { stdio: "ignore" });
    }
  } catch {
    // Best-effort; may fail if node_modules is read-only.
  }
  return { electronBinary, changed };
};

const patchDevMicrophoneUsageDescription = (electronBinary) => {
  if (process.platform !== "darwin") {
    return false;
  }

  const contentsDir = path.resolve(path.dirname(electronBinary), "..");
  const infoPlist = path.join(contentsDir, "Info.plist");
  if (!existsSync(infoPlist)) {
    return false;
  }

  try {
    const existing = execFileSync(
      "plutil",
      ["-extract", "NSMicrophoneUsageDescription", "raw", infoPlist],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (existing === MIC_USAGE_DESCRIPTION) {
      return false;
    }
  } catch {
    // Missing key or unexpected plist; fall through to set it.
  }

  try {
    execSync(
      `plutil -replace NSMicrophoneUsageDescription -string ${JSON.stringify(MIC_USAGE_DESCRIPTION)} "${infoPlist}"`,
      { stdio: "ignore" },
    );
    return true;
  } catch {
    try {
      execSync(
        `plutil -insert NSMicrophoneUsageDescription -string ${JSON.stringify(MIC_USAGE_DESCRIPTION)} "${infoPlist}"`,
        { stdio: "ignore" },
      );
      return true;
    } catch {
      // Best-effort; read-only node_modules or unexpected plist shape.
    }
  }
  return false;
};

/**
 * Re-apply an ad-hoc bundle signature after the patch helpers above mutate
 * `Info.plist`. Electron ships an ad-hoc Mach-O signature whose CodeDirectory
 * hashes the bundle resources; once we change `CFBundleName` /
 * `CFBundleIdentifier` / `NSMicrophoneUsageDescription` the recorded hash
 * stops matching and macOS surfaces a "Stella was modified or has a damaged
 * signature" notification on launch (and may invalidate TCC permissions).
 *
 * `codesign --force --deep --sign -` re-seals the bundle with a fresh ad-hoc
 * signature consistent with the modified contents. No certificate, keychain,
 * Apple ID, or Xcode CLT required — `codesign` is a base macOS binary at
 * `/usr/bin/codesign`. The trust level stays the same (ad-hoc, no developer
 * id), it's just internally consistent again.
 */
const resignDevAppBundle = (electronBinary, force = false) => {
  if (process.platform !== "darwin") {
    return;
  }
  const appBundle = path.resolve(path.dirname(electronBinary), "..", "..");
  if (!existsSync(appBundle) || !appBundle.endsWith(".app")) {
    return;
  }
  if (!force) {
    try {
      execFileSync("codesign", ["--verify", "--no-strict", appBundle], {
        stdio: "ignore",
      });
      return;
    } catch (verifyError) {
      if (verifyError?.code === "ENOENT") {
        // codesign missing — no-op rather than fail dev startup.
        return;
      }
      // Signature broken or missing; fall through to re-sign.
    }
  }
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appBundle], {
      stdio: "ignore",
    });
  } catch {
    // Best-effort; read-only node_modules or unsupported signing flags.
  }
};

/**
 * Apply the macOS dev-app identity patches (icon, bundle name/id, mic usage)
 * to the resolved Electron bundle and re-seal its ad-hoc signature. Returns the
 * (possibly relocated) electron binary path so callers spawn the renamed bundle.
 *
 * `extraPatches` runs after the name/icon/mic patches but before re-signing, so
 * launcher-specific bundle mutations (e.g. dev-electron's relaunch shim) are
 * covered by the same signature. It receives the current electron binary path
 * and returns whether it changed the bundle.
 */
export const prepareMacDevAppBundle = ({
  electronBinary,
  desktopDir,
  extraPatches,
}) => {
  if (process.platform !== "darwin") {
    return { electronBinary, changed: false };
  }

  const iconChanged = patchDevIcon(electronBinary, desktopDir);
  const nameResult = patchDevAppName(electronBinary);
  electronBinary = nameResult.electronBinary;
  const micChanged = patchDevMicrophoneUsageDescription(electronBinary);
  const extraChanged = extraPatches ? Boolean(extraPatches(electronBinary)) : false;

  const changed = iconChanged || nameResult.changed || micChanged || extraChanged;
  resignDevAppBundle(electronBinary, changed);
  return { electronBinary, changed };
};

/**
 * Resolve the `disclaim-spawn` helper used to launch Electron so the spawned
 * process becomes its own responsible process — adopting the Stella.app bundle
 * identity (Dock icon + name) and owning its TCC grants instead of inheriting
 * the launching shell's. Prefers the shipped prebuilt; falls back to compiling
 * the bundled C source for dev checkouts. Returns `null` when unavailable, in
 * which case callers spawn Electron directly.
 */
export const resolveDisclaimBinary = ({ desktopDir }) => {
  if (process.platform !== "darwin") {
    return null;
  }

  const prebuilt = path.join(
    desktopDir,
    "native",
    "out",
    "darwin",
    "disclaim-spawn",
  );
  if (existsSync(prebuilt)) {
    return prebuilt;
  }

  const source = path.join(desktopDir, "scripts", "disclaim-spawn.c");
  if (!existsSync(source)) {
    return null;
  }

  const runtimeRoot = path.join(desktopDir, DEV_MACOS_RUNTIME_DIR_NAME);
  const fallback = path.join(runtimeRoot, "disclaim-spawn");
  try {
    mkdirSync(runtimeRoot, { recursive: true });
    execFileSync("clang", ["-O2", "-o", fallback, source], {
      stdio: "ignore",
      timeout: 15_000,
    });
    return fallback;
  } catch {
    console.warn(
      "[macos-dev-app] Failed to compile disclaim-spawn; macOS TCC prompts may not appear.",
    );
    return null;
  }
};
