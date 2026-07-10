import { existsSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = import.meta.dirname;

/**
 * Locate the Stella browser service and extension directory.
 *
 * In development the service lives at `desktop/stella-browser/`. Packaged
 * builds copy its launcher, native binaries, and extension into Electron's
 * resources directory.
 *
 * Instead of re-threading yet another root through every caller, we resolve
 * the folder by walking up from this file's compiled location. Dev bundling
 * can collapse this helper into `main.js`, so try both the pre-bundle helper
 * depth and the bundled-main depth.
 *
 *   desktop/dist-electron/desktop/electron/utils/stella-browser-paths.js
 *                                                 ^ __dirname
 *   ../../../..           = desktop/
 *   ../../../../stella-browser
 *
 * If the layout changes, fix it here once.
 */
const compiledDesktopRootCandidates = [
  path.resolve(__dirname, "..", "..", "..", ".."),
  path.resolve(__dirname, "..", "..", ".."),
];

export const resolveStellaBrowserRoot = (): string => {
  for (const compiledDesktopRoot of compiledDesktopRootCandidates) {
    const desktopLocal = path.join(compiledDesktopRoot, "stella-browser");
    if (existsSync(desktopLocal)) {
      return desktopLocal;
    }
  }

  // Production: electron-builder copies stella-browser next to the asar at
  // Contents/Resources/stella-browser. `process.resourcesPath` is only defined
  // inside the Electron main process, which is where this helper runs.
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "stella-browser");
    if (existsSync(packaged)) {
      return packaged;
    }
  }

  return path.join(compiledDesktopRootCandidates[0], "stella-browser");
};

const currentStellaBrowserBinaryName = (): string | null => {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "darwin" && arch === "arm64") {
    return "stella-browser-darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "stella-browser-darwin-x64";
  }
  if (platform === "win32" && arch === "x64") {
    return "stella-browser-win32-x64.exe";
  }
  if (platform === "linux" && arch === "arm64") {
    return "stella-browser-linux-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "stella-browser-linux-x64";
  }
  return null;
};

/** Promote a verified updater artifact before any service/native-host spawn. */
export const activateStagedStellaBrowserBinary = (
  stellaBrowserRoot = resolveStellaBrowserRoot(),
): boolean => {
  const binaryName = currentStellaBrowserBinaryName();
  if (!binaryName) return false;
  const binaryPath = path.join(stellaBrowserRoot, "bin", binaryName);
  const stagedPath = `${binaryPath}.update`;
  if (!existsSync(stagedPath)) return false;

  const previousPath = `${binaryPath}.previous`;
  try {
    rmSync(previousPath, { force: true });
    if (existsSync(binaryPath)) renameSync(binaryPath, previousPath);
    renameSync(stagedPath, binaryPath);
    rmSync(previousPath, { force: true });
    return true;
  } catch (error) {
    if (!existsSync(binaryPath) && existsSync(previousPath)) {
      try {
        renameSync(previousPath, binaryPath);
      } catch {
        // Preserve the original activation failure below.
      }
    }
    throw new Error(
      `Cannot activate Stella Browser service update: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
