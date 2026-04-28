import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
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

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const copyIfMissing = async (sourcePath: string, targetPath: string) => {
  if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, { recursive: true, errorOnExist: false });
};

const copyMissingChildren = async (sourceDir: string, targetDir: string) => {
  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }
  await fs.mkdir(targetDir, { recursive: true });
  await Promise.all(
    entries.map((entry) =>
      copyIfMissing(path.join(sourceDir, entry.name), path.join(targetDir, entry.name)),
    ),
  );
};

const seedBundledState = async (stellaRoot: string, statePath: string) => {
  const seedRoot = path.join(stellaRoot, "state");
  await Promise.all([
    copyIfMissing(path.join(seedRoot, "DREAM.md"), path.join(statePath, "DREAM.md")),
    copyIfMissing(path.join(seedRoot, "registry.md"), path.join(statePath, "registry.md")),
    copyMissingChildren(path.join(seedRoot, "skills"), path.join(statePath, "skills")),
    copyIfMissing(
      path.join(seedRoot, "outputs", "README.md"),
      path.join(statePath, "outputs", "README.md"),
    ),
  ]);
};

export const DEFAULT_STELLA_DATA_DIRNAME = ".stella";

export const resolveDefaultStellaDataRoot = (): string =>
  path.join(os.homedir(), DEFAULT_STELLA_DATA_DIRNAME);

export const resolveStellaRoot = (app?: App, explicitRoot?: string): string => {
  const normalizedExplicitRoot = explicitRoot?.trim();
  if (normalizedExplicitRoot) {
    return normalizedExplicitRoot;
  }
  return app
    ? path.resolve(app.getAppPath(), "..")
    : path.resolve(__dirname, "..", "..", "..");
};

export const resolveRuntimeStatePath = (app?: App, explicitRoot?: string): string => {
  if (explicitRoot?.trim()) {
    return path.join(resolveStellaRoot(app, explicitRoot), "state");
  }
  return resolveStellaStatePath();
};

export const resolveStellaStatePath = (
  stellaStatePath?: string,
  explicitStatePath?: string,
): string => {
  const normalizedExplicitStatePath = explicitStatePath?.trim();
  if (normalizedExplicitStatePath) {
    return path.resolve(normalizedExplicitStatePath);
  }

  const envStatePath = process.env.STELLA_STATE?.trim();
  if (envStatePath) {
    return path.resolve(envStatePath);
  }

  const envDataRoot = process.env.STELLA_DATA_ROOT?.trim();
  if (envDataRoot) {
    return path.resolve(envDataRoot);
  }

  const normalizedRoot = stellaStatePath?.trim();
  if (!normalizedRoot) {
    return resolveDefaultStellaDataRoot();
  }

  return path.resolve(normalizedRoot);
};

export const resolveStellaHome = async (
  app: App,
  explicitRoot?: string,
  explicitStatePath?: string,
): Promise<StellaHome> => {
  const stellaRoot = resolveStellaRoot(app, explicitRoot);
  const runtimeRoot = path.join(stellaRoot, "runtime");
  const workspacePath = path.join(stellaRoot, "workspace");

  const extensionsPath = path.join(runtimeRoot, "extensions");
  const statePath = resolveStellaStatePath(undefined, explicitStatePath);
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_ROOT = stellaRoot;
  process.env.STELLA_HOME = stellaRoot;
  process.env.STELLA_DATA_ROOT = statePath;
  process.env.STELLA_STATE = statePath;

  await ensureDir(statePath);
  await seedBundledState(stellaRoot, statePath);
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
