import path from "path";
import { promises as fs } from "fs";
import type { Dirent } from "fs";
import { fileURLToPath } from "url";
import type { App } from "electron";
import { ensurePrivateDir } from "./private-fs.js";

export type StellaHome = {
  desktopRoot: string;
  installRoot: string;
  homePath: string;
  agentsPath: string;
  coreSkillsPath: string;
  skillsPath: string;
  extensionsPath: string;
  statePath: string;
  logsPath: string;
  canvasPath: string;
  workspacePath: string;
  workspacePanelsPath: string;
  workspaceAppsPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = async (dirPath: string) => {
  await ensurePrivateDir(dirPath);
};

export const resolveDesktopRoot = (app?: App): string =>
  app ? path.resolve(app.getAppPath()) : path.resolve(__dirname, "..", "..", "..");

export const resolveInstallRoot = (app?: App): string =>
  path.resolve(resolveDesktopRoot(app), "..");

export const resolveRuntimeHomePath = (app?: App): string =>
  path.join(resolveInstallRoot(app), ".stella");

export const resolveRuntimeStatePath = (app?: App): string =>
  path.join(resolveRuntimeHomePath(app), "state");

const seedMissingEntries = async (sourcePath: string, targetPath: string) => {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sourcePath, { withFileTypes: true });
  } catch {
    return;
  }

  await ensureDir(targetPath);

  for (const entry of entries) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      await seedMissingEntries(sourceEntryPath, targetEntryPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      await fs.stat(targetEntryPath);
      continue;
    } catch {
      await ensureDir(path.dirname(targetEntryPath));
      await fs.copyFile(sourceEntryPath, targetEntryPath);
    }
  }
};

export const resolveStellaHome = async (app: App): Promise<StellaHome> => {
  const desktopRoot = resolveDesktopRoot(app);
  const installRoot = resolveInstallRoot(app);
  const homePath = resolveRuntimeHomePath(app);
  const bundledDefaultsPath = path.join(desktopRoot, ".stella");
  const workspacePath = path.join(desktopRoot, "workspace");

  const agentsPath = path.join(homePath, "agents");
  const coreSkillsPath = path.join(homePath, "core-skills");
  const skillsPath = path.join(homePath, "skills");
  const extensionsPath = path.join(homePath, "extensions");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(homePath, "logs");
  const canvasPath = path.join(homePath, "canvas");
  const workspacePanelsPath = path.join(workspacePath, "panels");
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_ROOT = installRoot;
  process.env.STELLA_HOME = homePath;

  await ensureDir(homePath);
  await ensureDir(agentsPath);
  await ensureDir(coreSkillsPath);
  await ensureDir(skillsPath);
  await ensureDir(extensionsPath);
  await ensureDir(statePath);
  await ensureDir(logsPath);
  await ensureDir(canvasPath);
  await ensureDir(workspacePath);
  await ensureDir(workspacePanelsPath);
  await ensureDir(workspaceAppsPath);

  await Promise.all([
    seedMissingEntries(path.join(bundledDefaultsPath, "core-skills"), coreSkillsPath),
    seedMissingEntries(path.join(bundledDefaultsPath, "skills"), skillsPath),
    seedMissingEntries(path.join(bundledDefaultsPath, "extensions"), extensionsPath),
    seedMissingEntries(path.join(bundledDefaultsPath, "state"), statePath),
    seedMissingEntries(path.join(bundledDefaultsPath, "themes"), path.join(homePath, "themes")),
    seedMissingEntries(path.join(bundledDefaultsPath, "canvas"), canvasPath),
    seedMissingEntries(path.join(bundledDefaultsPath, "mods"), path.join(homePath, "mods")),
  ]);

  return {
    desktopRoot,
    installRoot,
    homePath,
    agentsPath,
    coreSkillsPath,
    skillsPath,
    extensionsPath,
    statePath,
    logsPath,
    canvasPath,
    workspacePath,
    workspacePanelsPath,
    workspaceAppsPath,
  };
};
