import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";
import {
  reconcileBundledSkills,
  summarizeSkillsSync,
  type SkillsSyncReport,
} from "./skills-sync.js";
import {
  reconcileBundledAgents,
  summarizeAgentsSync,
  type AgentsSyncReport,
} from "./agents-sync.js";

export type StellaDataDir = {
  stellaAppDir: string;
  stellaDataDir: string;
  extensionsPath: string;
  statePath: string;
  workspacePath: string;
  workspaceAppsPath: string;
};

/**
 * Bundled agent prompts live in the install tree's stella-runtime extension;
 * they're reconciled into `${stellaDataDir}/agents/`, which is what the runtime
 * loads (so users can edit prompts and shipped updates still flow through).
 */
const resolveBundledAgentsDir = (stellaAppDir: string): string =>
  path.join(stellaAppDir, "runtime", "extensions", "stella-runtime", "agents");

const __dirname = import.meta.dirname;

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

// `skills/` is intentionally NOT a one-shot seed entry — it goes through
// hash-history reconciliation in `skills-sync.ts` so shipped skill updates
// reach existing users without trampling local edits.
const STELLA_DATA_SEED_ENTRIES = [
  "DREAM.md",
  path.join("outputs", "README.md"),
] as const;

export const resolveStellaAppDir = (app?: App, explicitRoot?: string): string => {
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

export const ensureStellaDataDirSeeded = async (
  stellaAppDir: string,
  stellaDataDir: string,
): Promise<{ skillsSync: SkillsSyncReport; agentsSync: AgentsSyncReport }> => {
  await ensureDir(stellaDataDir);
  const seedPath = resolveStellaDataSeedDir(stellaAppDir);
  for (const entry of STELLA_DATA_SEED_ENTRIES) {
    const sourcePath = path.join(seedPath, entry);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    await copyPathIfMissing(sourcePath, path.join(stellaDataDir, entry));
  }

  const bundledSkillsDir = path.join(seedPath, "skills");
  const homeSkillsDir = path.join(stellaDataDir, "skills");
  const skillsSync = await reconcileBundledSkills(
    bundledSkillsDir,
    homeSkillsDir,
  );
  const summary = summarizeSkillsSync(skillsSync);
  if (summary !== "no-op") {
    console.log(`[stella-home] skills sync: ${summary}`);
  }

  const agentsSync = await reconcileBundledAgents(
    resolveBundledAgentsDir(stellaAppDir),
    path.join(stellaDataDir, "agents"),
  );
  const agentsSummary = summarizeAgentsSync(agentsSync);
  if (agentsSummary !== "no-op") {
    console.log(`[stella-home] agents sync: ${agentsSummary}`);
  }

  return { skillsSync, agentsSync };
};

export const resolveStellaDataDir = async (
  app: App,
  explicitRoot?: string,
  explicitStatePath?: string,
): Promise<StellaDataDir> => {
  const stellaAppDir = resolveStellaAppDir(app, explicitRoot);
  const runtimeRoot = path.join(stellaAppDir, "runtime");
  const workspacePath = path.join(stellaAppDir, "workspace");

  const extensionsPath = path.join(runtimeRoot, "extensions");
  const statePath = resolveRuntimeStatePath(app, stellaAppDir, explicitStatePath);
  const workspaceAppsPath = path.join(workspacePath, "apps");

  process.env.STELLA_APP_DIR = stellaAppDir;
  process.env.STELLA_DATA_DIR = statePath;

  // NOTE: `ensureStellaDataDirSeeded` (skills/agents hash-history reconciliation)
  // is intentionally NOT invoked here. It does ~100 awaited fs ops + sha256 over
  // hundreds of KB across ~17 skill dirs + ~8 agent files, and nothing on the
  // first-paint path consumes the seeded dirs — only the deferred runtime worker
  // does. It is now awaited in `initializeStellaHostRunner` (host-runner.ts),
  // off the pre-window path, before the worker that reads those dirs connects.
  // `resolveStellaDataDir` keeps only the cheap path resolution + env + dir
  // ensures that the rest of bootstrap depends on synchronously.
  await ensureDir(workspacePath);
  await ensureDir(workspaceAppsPath);

  return {
    stellaAppDir,
    stellaDataDir: statePath,
    extensionsPath,
    statePath,
    workspacePath,
    workspaceAppsPath,
  };
};
