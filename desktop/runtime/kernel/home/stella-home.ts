import path from "path";
import { fileURLToPath } from "url";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";

export type StellaHome = {
  desktopRoot: string;
  homePath: string;
  extensionsPath: string;
  statePath: string;
  logsPath: string;
  canvasPath: string;
  workspacePath: string;
  workspaceAppsPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = async (dirPath: string) => {
  await ensurePrivateDir(dirPath);
};

export const resolveDesktopRoot = (app?: App): string =>
  app ? path.resolve(app.getAppPath()) : path.resolve(__dirname, "..", "..", "..");

export const resolveRuntimeHomePath = (app?: App): string =>
  resolveDesktopRoot(app);

export const resolveRuntimeStatePath = (app?: App): string =>
  path.join(resolveDesktopRoot(app), "state");

export const resolveStellaHome = async (app: App): Promise<StellaHome> => {
  const desktopRoot = resolveDesktopRoot(app);
  const homePath = resolveRuntimeHomePath(app);
  const runtimeRoot = path.join(desktopRoot, "runtime");
  const workspacePath = path.join(desktopRoot, "workspace");

  const extensionsPath = path.join(runtimeRoot, "extensions");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(statePath, "logs");
  const canvasPath = path.join(statePath, "canvas");
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_ROOT = desktopRoot;
  process.env.STELLA_HOME = homePath;
  process.env.STELLA_STATE = statePath;

  await ensureDir(statePath);
  await ensureDir(logsPath);
  await ensureDir(canvasPath);
  await ensureDir(workspacePath);
  await ensureDir(workspaceAppsPath);

  return {
    desktopRoot,
    homePath,
    extensionsPath,
    statePath,
    logsPath,
    canvasPath,
    workspacePath,
    workspaceAppsPath,
  };
};
