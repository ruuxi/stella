import path from "path";
import { promises as fs } from "fs";
import type { Dirent } from "fs";
import { fileURLToPath } from "url";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";

export type StellaHome = {
  desktopRoot: string;
  installRoot: string;
  homePath: string;
  coreSkillsPath: string;
  skillsPath: string;
  extensionsPath: string;
  statePath: string;
  logsPath: string;
  canvasPath: string;
  workspacePath: string;
  workspaceAppsPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_DEFAULTS_SEED_VERSION = 1;
const DEFAULTS_SEED_MARKER_FILE = ".bundled-defaults-seed.json";

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

export const resolveBundledDefaultsPath = (app?: App): string =>
  app?.isPackaged
    ? path.join(resolveInstallRoot(app), "stella-defaults")
    : path.join(resolveDesktopRoot(app), "resources", "stella-defaults");

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

const readSeedVersion = async (markerPath: string): Promise<number | null> => {
  try {
    const raw = await fs.readFile(markerPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown } | null;
    return typeof parsed?.version === "number" ? parsed.version : null;
  } catch {
    return null;
  }
};

const writeSeedVersion = async (markerPath: string, version: number) => {
  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        updatedAtMs: Date.now(),
        version,
      },
      null,
      2,
    ),
    "utf-8",
  );
};

export const resolveStellaHome = async (app: App): Promise<StellaHome> => {
  const desktopRoot = resolveDesktopRoot(app);
  const installRoot = resolveInstallRoot(app);
  const homePath = resolveRuntimeHomePath(app);
  const bundledDefaultsPath = resolveBundledDefaultsPath(app);
  const workspacePath = path.join(desktopRoot, "workspace");

  const coreSkillsPath = path.join(homePath, "core-skills");
  const skillsPath = path.join(homePath, "skills");
  const extensionsPath = path.join(homePath, "extensions");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(homePath, "logs");
  const canvasPath = path.join(homePath, "canvas");
  const workspaceAppsPath = path.join(workspacePath, "apps");
  const defaultsSeedMarkerPath = path.join(statePath, DEFAULTS_SEED_MARKER_FILE);

  process.env.STELLA_ROOT = installRoot;
  process.env.STELLA_HOME = homePath;

  await ensureDir(homePath);
  await ensureDir(coreSkillsPath);
  await ensureDir(skillsPath);
  await ensureDir(extensionsPath);
  await ensureDir(statePath);
  await ensureDir(logsPath);
  await ensureDir(canvasPath);
  await ensureDir(workspacePath);
  await ensureDir(workspaceAppsPath);

  const currentSeedVersion = await readSeedVersion(defaultsSeedMarkerPath);
  if (currentSeedVersion !== BUNDLED_DEFAULTS_SEED_VERSION) {
    await Promise.all([
      seedMissingEntries(path.join(bundledDefaultsPath, "core-skills"), coreSkillsPath),
      seedMissingEntries(path.join(bundledDefaultsPath, "skills"), skillsPath),
      seedMissingEntries(path.join(bundledDefaultsPath, "extensions"), extensionsPath),
    ]);
    await writeSeedVersion(
      defaultsSeedMarkerPath,
      BUNDLED_DEFAULTS_SEED_VERSION,
    );
  }

  return {
    desktopRoot,
    installRoot,
    homePath,
    coreSkillsPath,
    skillsPath,
    extensionsPath,
    statePath,
    logsPath,
    canvasPath,
    workspacePath,
    workspaceAppsPath,
  };
};
