import { promises as fs } from "fs";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type {
  InstalledStoreModRecord,
  SelfModBatchRecord,
  SelfModFeatureRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
} from "../../src/shared/contracts/electron-data.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { commitGitOperation, revertGitCommits, stageFeatureDependencyFiles, stageGitFiles } from "../self-mod/git.js";
import type { StoreModService } from "../self-mod/store-mod-service.js";

type StoreHandlersOptions = {
  getStellaHomePath: () => string | null;
  getFrontendRoot: () => string;
  getStellaHostRunner: () => StellaHostRunner | null;
  getStoreModService: () => StoreModService | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const readJsonArtifact = async (artifactUrl: string): Promise<StoreReleaseArtifact> => {
  const response = await fetch(artifactUrl);
  if (!response.ok) {
    throw new Error(`Failed to download release artifact (${response.status}).`);
  }
  return await response.json() as StoreReleaseArtifact;
};

const ensureRepoRoot = (options: StoreHandlersOptions): string => options.getFrontendRoot();

const resolveRequestedReleaseNumber = async (args: {
  runner: StellaHostRunner;
  packageId: string;
  releaseNumber?: number;
}): Promise<number> => {
  if (typeof args.releaseNumber === "number" && Number.isFinite(args.releaseNumber)) {
    return Math.max(1, Math.floor(args.releaseNumber));
  }
  const releases = await args.runner.listStorePackageReleases(args.packageId);
  const latestRelease = [...releases].sort((a, b) => b.releaseNumber - a.releaseNumber)[0];
  if (!latestRelease) {
    throw new Error(`Package "${args.packageId}" has no published releases.`);
  }
  return latestRelease.releaseNumber;
};

const listInstalledThemes = async (stellaHomePath: string) => {
  const themesDir = path.join(stellaHomePath, "themes");
  try {
    const files = await fs.readdir(themesDir);
    const themes = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(themesDir, file), "utf-8");
        const theme = JSON.parse(raw);
        if (theme.id && theme.name && theme.light && theme.dark) {
          themes.push(theme);
        }
      } catch {
        // Skip invalid theme files.
      }
    }
    return themes;
  } catch {
    return [];
  }
};

export const registerStoreHandlers = (options: StoreHandlersOptions) => {
  ipcMain.handle("theme:listInstalled", async () => {
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath) {
      return [];
    }
    return await listInstalledThemes(stellaHomePath);
  });

  ipcMain.handle("store:listLocalFeatures", async (event, payload?: { limit?: number }) => {
    if (!options.assertPrivilegedSender(event, "store:listLocalFeatures")) {
      throw new Error("Blocked untrusted store:listLocalFeatures request.");
    }
    return options.getStoreModService()?.listLocalFeatures(payload?.limit) ?? [] satisfies SelfModFeatureRecord[];
  });

  ipcMain.handle("store:listFeatureBatches", async (event, payload: { featureId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:listFeatureBatches")) {
      throw new Error("Blocked untrusted store:listFeatureBatches request.");
    }
    return options.getStoreModService()?.listFeatureBatches(payload.featureId) ?? [] satisfies SelfModBatchRecord[];
  });

  ipcMain.handle("store:createReleaseDraft", async (event, payload: { featureId: string; batchIds?: string[] }) => {
    if (!options.assertPrivilegedSender(event, "store:createReleaseDraft")) {
      throw new Error("Blocked untrusted store:createReleaseDraft request.");
    }
    const service = options.getStoreModService();
    if (!service) {
      throw new Error("Store mod service is unavailable.");
    }
    return service.createReleaseDraft(payload);
  });

  ipcMain.handle(
    "store:publishRelease",
    async (
      event,
      payload: {
        featureId: string;
        batchIds?: string[];
        packageId?: string;
        displayName?: string;
        description?: string;
        releaseNotes?: string;
      },
    ) => {
      if (!options.assertPrivilegedSender(event, "store:publishRelease")) {
        throw new Error("Blocked untrusted store:publishRelease request.");
      }
      const service = options.getStoreModService();
      const runner = options.getStellaHostRunner();
      if (!service || !runner) {
        throw new Error("Store publishing is unavailable.");
      }

      return await service.publishRelease({
        ...payload,
        publish: async (args) => {
          const existing = await runner.getStorePackage(args.packageId);
          return existing
            ? await runner.createStoreReleaseUpdate(args)
            : await runner.createFirstStoreRelease(args);
        },
      });
    },
  );

  ipcMain.handle("store:listPackages", async (event) => {
    if (!options.assertPrivilegedSender(event, "store:listPackages")) {
      throw new Error("Blocked untrusted store:listPackages request.");
    }
    const runner = options.getStellaHostRunner();
    if (!runner) {
      throw new Error("Store backend is unavailable.");
    }
    return await runner.listStorePackages() satisfies StorePackageRecord[];
  });

  ipcMain.handle("store:getPackage", async (event, payload: { packageId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:getPackage")) {
      throw new Error("Blocked untrusted store:getPackage request.");
    }
    const runner = options.getStellaHostRunner();
    if (!runner) {
      throw new Error("Store backend is unavailable.");
    }
    return await runner.getStorePackage(payload.packageId) satisfies StorePackageRecord | null;
  });

  ipcMain.handle("store:listReleases", async (event, payload: { packageId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:listReleases")) {
      throw new Error("Blocked untrusted store:listReleases request.");
    }
    const runner = options.getStellaHostRunner();
    if (!runner) {
      throw new Error("Store backend is unavailable.");
    }
    return await runner.listStorePackageReleases(payload.packageId) satisfies StorePackageReleaseRecord[];
  });

  ipcMain.handle(
    "store:getRelease",
    async (event, payload: { packageId: string; releaseNumber: number }) => {
      if (!options.assertPrivilegedSender(event, "store:getRelease")) {
        throw new Error("Blocked untrusted store:getRelease request.");
      }
      const runner = options.getStellaHostRunner();
      if (!runner) {
        throw new Error("Store backend is unavailable.");
      }
      return await runner.getStorePackageRelease(
        payload.packageId,
        payload.releaseNumber,
      ) satisfies StorePackageReleaseRecord | null;
    },
  );

  ipcMain.handle(
    "store:installRelease",
    async (event, payload: { packageId: string; releaseNumber?: number }) => {
      if (!options.assertPrivilegedSender(event, "store:installRelease")) {
        throw new Error("Blocked untrusted store:installRelease request.");
      }
      const service = options.getStoreModService();
      const runner = options.getStellaHostRunner();
      if (!service || !runner) {
        throw new Error("Store install is unavailable.");
      }
      const repoRoot = ensureRepoRoot(options);
      const releaseNumber = await resolveRequestedReleaseNumber({
        runner,
        packageId: payload.packageId,
        releaseNumber: payload.releaseNumber,
      });

      return await service.installRelease({
        packageId: payload.packageId,
        releaseNumber,
        fetchRelease: async ({ packageId, releaseNumber }) => {
          const release = await runner.getStorePackageRelease(packageId, releaseNumber);
          const packageRecord = await runner.getStorePackage(packageId);
          if (!release || !packageRecord) {
            throw new Error("Store release not found.");
          }
          if (!release.artifactUrl) {
            throw new Error("Store release artifact URL is unavailable.");
          }
          const artifact = await readJsonArtifact(release.artifactUrl);
          return {
            package: packageRecord,
            release,
            artifact,
          };
        },
        commitApply: async ({ packageId, featureId, releaseNumber, touchedFiles }) => {
          await stageGitFiles(repoRoot, touchedFiles);
          await stageFeatureDependencyFiles(repoRoot);
          const commitHash = await commitGitOperation({
            repoRoot,
            subject: `Store install ${packageId}@${releaseNumber} [feature:${featureId}]`,
            bodyLines: [
              `Stella-Package-Id: ${packageId}`,
              `Stella-Feature-Id: ${featureId}`,
              `Stella-Release-Number: ${releaseNumber}`,
            ],
          });
          if (!commitHash) {
            throw new Error("Install produced no staged changes to commit.");
          }
          return commitHash;
        },
      }) satisfies InstalledStoreModRecord;
    },
  );

  ipcMain.handle("store:listInstalledMods", async (event) => {
    if (!options.assertPrivilegedSender(event, "store:listInstalledMods")) {
      throw new Error("Blocked untrusted store:listInstalledMods request.");
    }
    return options.getStoreModService()?.listInstalledMods() ?? [] satisfies InstalledStoreModRecord[];
  });

  ipcMain.handle("store:uninstallMod", async (event, payload: { packageId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:uninstallMod")) {
      throw new Error("Blocked untrusted store:uninstallMod request.");
    }
    const service = options.getStoreModService();
    if (!service) {
      throw new Error("Store uninstall is unavailable.");
    }
    const install = service.getInstalledModByPackageId(payload.packageId);
    if (!install || install.state === "uninstalled") {
      return {
        packageId: payload.packageId,
        revertedCommits: [],
      };
    }
    const repoRoot = ensureRepoRoot(options);
    const revertedCommits = await revertGitCommits({
      repoRoot,
      commitHashes: [...install.applyCommitHashes].reverse(),
    });
    service.markInstallUninstalled(install.installId);
    return {
      packageId: payload.packageId,
      revertedCommits,
    };
  });
};
