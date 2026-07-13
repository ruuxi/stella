import path from "path";
import { promises as fs } from "fs";
import type { App } from "electron";
import { ensurePrivateDir } from "../shared/private-fs.js";
import {
  reconcileBundledSkills,
  summarizeSkillsSync,
  type SkillsSyncReport,
} from "./skills-sync.js";
import {
  summarizeBundledSync,
  type BundledSyncReport,
} from "./bundled-sync.js";
import {
  StalePromptManifestError,
  applyPromptManifestIfCurrent,
  reconcileBundledManagerPromptFallback,
  reconcileRemotePromptManifest,
  resolvePromptManifest,
  type PromptManifestResolution,
} from "./prompt-manifest-sync.js";
import { reconcileSelectedPersonality } from "./personality-sync.js";
import {
  resolveBundledAgentMetadataDir,
  resolveDefaultStellaDataDir,
  resolveRuntimeStatePath,
  resolveStellaAppDir,
  resolveStellaDataSeedDir,
} from "./stella-paths.js";

// Path helpers are re-exported so existing Electron-side importers keep
// working; runtime-worker code must import `stella-paths.js` directly so this
// module (and the sync machinery it drags in) stays out of the worker bundle.
export {
  resolveBundledAgentMetadataDir,
  resolveDefaultStellaDataDir,
  resolveRuntimeStatePath,
  resolveStellaAppDir,
  resolveStellaDataSeedDir,
};

export type StellaDataDir = {
  stellaAppDir: string;
  stellaDataDir: string;
  extensionsPath: string;
  statePath: string;
  workspacePath: string;
  workspaceAppsPath: string;
};

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

export const ensureStellaDataDirSeeded = async (
  stellaAppDir: string,
  stellaDataDir: string,
  options: { promptSiteUrl?: string | null } = {},
): Promise<{
  skillsSync: SkillsSyncReport;
  personalitySync: BundledSyncReport;
  promptResolution: PromptManifestResolution["source"];
}> => {
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

  const promptResolution = await resolvePromptManifest({
    stellaDataDir,
    siteUrl: options.promptSiteUrl,
  });
  let personalitySync: BundledSyncReport | null = null;
  if (promptResolution.manifest) {
    if (!promptResolution.endpoint) {
      throw new Error("Resolved prompt manifest is missing its endpoint");
    }
    try {
      await applyPromptManifestIfCurrent({
        stellaDataDir,
        endpoint: promptResolution.endpoint,
        manifest: promptResolution.manifest,
        reconcile: async () => {
          await reconcileRemotePromptManifest(
            promptResolution.manifest!,
            stellaDataDir,
            resolveBundledAgentMetadataDir(stellaAppDir),
          );
          personalitySync = await reconcileSelectedPersonality(
            stellaDataDir,
            promptResolution.manifest!.revision,
          );
        },
      });
    } catch (error) {
      if (!(error instanceof StalePromptManifestError)) throw error;
      personalitySync = { actions: [] };
    }
  }

  const managerFallbackSync = await reconcileBundledManagerPromptFallback(
    stellaDataDir,
    resolveBundledAgentMetadataDir(stellaAppDir),
  );
  const managerFallbackSummary = summarizeBundledSync(managerFallbackSync);
  if (managerFallbackSummary !== "no-op") {
    console.log(
      `[stella-home] manager prompt fallback sync: ${managerFallbackSummary}`,
    );
  }

  personalitySync ??= { actions: [] };

  return {
    skillsSync,
    personalitySync,
    promptResolution: promptResolution.source,
  };
};

/**
 * Re-run only the remote prompt portion after the renderer supplies a site URL
 * later than main-process startup. Agent bodies are live-read per turn and the
 * extension watcher observes the atomic replacements.
 */
export const syncStellaPromptSnapshot = async (
  stellaAppDir: string,
  stellaDataDir: string,
  promptSiteUrl: string,
): Promise<PromptManifestResolution> => {
  const resolution = await resolvePromptManifest({
    stellaDataDir,
    siteUrl: promptSiteUrl,
  });
  if (resolution.manifest) {
    if (!resolution.endpoint) {
      throw new Error("Resolved prompt manifest is missing its endpoint");
    }
    try {
      await applyPromptManifestIfCurrent({
        stellaDataDir,
        endpoint: resolution.endpoint,
        manifest: resolution.manifest,
        reconcile: async () => {
          await reconcileRemotePromptManifest(
            resolution.manifest!,
            stellaDataDir,
            resolveBundledAgentMetadataDir(stellaAppDir),
          );
          await reconcileSelectedPersonality(
            stellaDataDir,
            resolution.manifest!.revision,
          );
        },
      });
    } catch (error) {
      if (!(error instanceof StalePromptManifestError)) throw error;
    }
  }
  await reconcileBundledManagerPromptFallback(
    stellaDataDir,
    resolveBundledAgentMetadataDir(stellaAppDir),
  );
  return resolution;
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
  const statePath = resolveRuntimeStatePath(
    app,
    stellaAppDir,
    explicitStatePath,
  );
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
