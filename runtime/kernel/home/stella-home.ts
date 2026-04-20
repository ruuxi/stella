import path from "path";
import { fileURLToPath } from "url";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";

export type StellaHome = {
  stellaRoot: string;
  extensionsPath: string;
  statePath: string;
  logsPath: string;
  workspacePath: string;
  workspaceAppsPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = async (dirPath: string) => {
  await ensurePrivateDir(dirPath);
};

export const resolveStellaRoot = (app?: App): string =>
  app
    ? path.resolve(app.getAppPath(), "..")
    : path.resolve(__dirname, "..", "..", "..");

export const resolveRuntimeStatePath = (app?: App): string =>
  path.join(resolveStellaRoot(app), "state");

export const resolveStellaHome = async (app: App): Promise<StellaHome> => {
  const stellaRoot = resolveStellaRoot(app);
  const runtimeRoot = path.join(stellaRoot, "runtime");
  const workspacePath = path.join(stellaRoot, "workspace");

  const extensionsPath = path.join(runtimeRoot, "extensions");
  const statePath = path.join(stellaRoot, "state");
  const logsPath = path.join(statePath, "logs");
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_ROOT = stellaRoot;
  process.env.STELLA_HOME = stellaRoot;
  process.env.STELLA_STATE = statePath;

  await ensureDir(statePath);
  await ensureDir(logsPath);
  await ensureDir(workspacePath);
  await ensureDir(workspaceAppsPath);

  return {
    stellaRoot,
    extensionsPath,
    statePath,
    logsPath,
    workspacePath,
    workspaceAppsPath,
  };
};
