import path from "path";
import { fileURLToPath } from "url";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";

export type StellaHome = {
  stellaRoot: string;
  extensionsPath: string;
  statePath: string;
  workspacePath: string;
  workspaceAppsPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = async (dirPath: string) => {
  await ensurePrivateDir(dirPath);
};

export const resolveStellaRoot = (app?: App, explicitRoot?: string): string => {
  const normalizedExplicitRoot = explicitRoot?.trim();
  if (normalizedExplicitRoot) {
    return normalizedExplicitRoot;
  }
  return app
    ? path.resolve(app.getAppPath(), "..")
    : path.resolve(__dirname, "..", "..", "..");
};

export const resolveRuntimeStatePath = (app?: App, explicitRoot?: string): string =>
  path.join(resolveStellaRoot(app, explicitRoot), "state");

export const resolveStellaHome = async (
  app: App,
  explicitRoot?: string,
): Promise<StellaHome> => {
  const stellaRoot = resolveStellaRoot(app, explicitRoot);
  const runtimeRoot = path.join(stellaRoot, "runtime");
  const workspacePath = path.join(stellaRoot, "workspace");

  const extensionsPath = path.join(runtimeRoot, "extensions");
  const statePath = path.join(stellaRoot, "state");
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_ROOT = stellaRoot;
  process.env.STELLA_HOME = stellaRoot;
  process.env.STELLA_STATE = statePath;

  await ensureDir(statePath);
  await ensureDir(workspacePath);
  await ensureDir(workspaceAppsPath);

  return {
    stellaRoot,
    extensionsPath,
    statePath,
    workspacePath,
    workspaceAppsPath,
  };
};
