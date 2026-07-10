import { existsSync } from "node:fs";
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
