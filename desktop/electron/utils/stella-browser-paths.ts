import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Locate the stella-browser CLI/daemon/extension directory.
 *
 * stella-browser is not packaged (not listed in electron-builder `files` or
 * `extraResources`), so at runtime it only exists inside the desktop source
 * tree at `desktop/stella-browser/`. Historically this was resolved via
 * `frontendRoot` (i.e. the `desktop/` directory), but the "unify stella root"
 * refactor repointed that value at the workspace root, which doesn't contain
 * stella-browser.
 *
 * Instead of re-threading yet another root through every caller, we resolve
 * the folder by walking up from this file's compiled location:
 *
 *   desktop/dist-electron/desktop/electron/utils/stella-browser-paths.js
 *                                                 ^ __dirname
 *   ../../../..           = desktop/
 *   ../../../../stella-browser
 *
 * If the layout ever changes, fix it here once. If upstream ever decides to
 * bundle stella-browser as an extraResource, the existsSync fallback to
 * `<app resources>/stella-browser` will keep packaged builds working.
 */
const compiledDesktopRoot = path.resolve(__dirname, "..", "..", "..", "..");

export const resolveStellaBrowserRoot = (): string => {
  const desktopLocal = path.join(compiledDesktopRoot, "stella-browser");
  if (existsSync(desktopLocal)) {
    return desktopLocal;
  }

  // Production fallback: if electron-builder ever copies stella-browser as an
  // extraResource, it will land next to the asar at
  // Contents/Resources/stella-browser. `process.resourcesPath` is only defined
  // inside the Electron main process, which is where this helper runs.
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "stella-browser");
    if (existsSync(packaged)) {
      return packaged;
    }
  }

  return desktopLocal;
};
