import path from "path";
import os from "os";
import type { App } from "electron";

/**
 * Pure path resolution shared by the Electron main process and the Bun
 * runtime worker. Nothing here may import Electron values, sqlite, or the
 * sync machinery in this directory: the worker's tools pull these helpers
 * into the runner chunk, and any heavier dependency rides along into the
 * Bun bundle (see the desktop-v0.0.409 `node:sqlite` worker outage).
 * Electron-only seeding/sync lives in `stella-home.ts`.
 */

/**
 * Capability-bearing agent metadata stays in the install tree. Prompt bodies
 * are backend-owned and are joined with this frontmatter during remote sync.
 */
export const resolveBundledAgentMetadataDir = (stellaAppDir: string): string =>
  path.join(
    stellaAppDir,
    "runtime",
    "extensions",
    "stella-runtime",
    "agent-metadata",
  );

const __dirname = import.meta.dirname;

export const resolveStellaAppDir = (
  app?: App,
  explicitRoot?: string,
): string => {
  const normalizedExplicitRoot = explicitRoot?.trim();
  if (normalizedExplicitRoot) {
    return normalizedExplicitRoot;
  }
  return app
    ? path.resolve(app.getAppPath(), "..")
    : path.resolve(__dirname, "..", "..", "..");
};

export const resolveDefaultStellaDataDir = (): string =>
  path.join(os.homedir(), ".stella");

export const resolveStellaDataSeedDir = (stellaAppDir: string): string =>
  path.join(stellaAppDir, "runtime", "home-seed");

export const resolveRuntimeStatePath = (
  _app?: App,
  _explicitRoot?: string,
  explicitStatePath?: string,
): string => {
  const configuredStatePath =
    explicitStatePath?.trim() || process.env.STELLA_DATA_DIR?.trim();
  return path.resolve(configuredStatePath || resolveDefaultStellaDataDir());
};
