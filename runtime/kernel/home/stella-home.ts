import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";

export type StellaHome = {
  stellaRoot: string;
  stellaHome: string;
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

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const copyPathIfMissing = async (sourcePath: string, targetPath: string) => {
  if (await pathExists(targetPath)) {
    return;
  }
  const stat = await fs.lstat(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
};

const STELLA_HOME_SEED_ENTRIES = [
  "DREAM.md",
  "registry.md",
  "skills",
  path.join("outputs", "README.md"),
] as const;

export const resolveStellaRoot = (app?: App, explicitRoot?: string): string => {
  const normalizedExplicitRoot = explicitRoot?.trim();
  if (normalizedExplicitRoot) {
    return normalizedExplicitRoot;
  }
  return app
    ? path.resolve(app.getAppPath(), "..")
    : path.resolve(__dirname, "..", "..", "..");
};

export const resolveDefaultStellaHomePath = (): string =>
  path.join(os.homedir(), ".stella");

export const resolveBundledStellaHomeSeedPath = (stellaRoot: string): string =>
  path.join(stellaRoot, "state");

export const resolveRuntimeStatePath = (
  _app?: App,
  _explicitRoot?: string,
  explicitStatePath?: string,
): string => {
  const configuredStatePath =
    explicitStatePath?.trim() ||
    process.env.STELLA_HOME?.trim();
  return path.resolve(configuredStatePath || resolveDefaultStellaHomePath());
};

export const ensureStellaHomeSeeded = async (
  stellaRoot: string,
  stellaHome: string,
) => {
  await ensureDir(stellaHome);
  const seedPath = resolveBundledStellaHomeSeedPath(stellaRoot);
  for (const entry of STELLA_HOME_SEED_ENTRIES) {
    const sourcePath = path.join(seedPath, entry);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    await copyPathIfMissing(sourcePath, path.join(stellaHome, entry));
  }
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
  const statePath = resolveRuntimeStatePath(app, stellaRoot, explicitStatePath);
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_ROOT = stellaRoot;
  process.env.STELLA_HOME = statePath;

  await ensureStellaHomeSeeded(stellaRoot, statePath);
  await ensureDir(workspacePath);
  await ensureDir(workspaceAppsPath);

  return {
    stellaRoot,
    stellaHome: statePath,
    extensionsPath,
    statePath,
    workspacePath,
    workspaceAppsPath,
  };
};
