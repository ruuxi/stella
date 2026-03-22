import { promises as fs } from "fs";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type {
  SelfModBatchRecord,
  SelfModFeatureRecord,
  InstalledStoreModRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
} from "../../src/shared/contracts/boundary.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";

type StoreHandlersOptions = {
  getStellaHomePath: () => string | null;
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
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
  const waitForRunner = (timeoutMs = 10_000) =>
    waitForConnectedRunner(options.getStellaHostRunner, {
      timeoutMs,
      unavailableMessage: "Store backend is unavailable.",
      onRunnerChanged: options.onStellaHostRunnerChanged,
    });

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
    const runner = await waitForRunner();
    return await runner.listLocalFeatures(payload?.limit) satisfies SelfModFeatureRecord[];
  });

  ipcMain.handle("store:listFeatureBatches", async (event, payload: { featureId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:listFeatureBatches")) {
      throw new Error("Blocked untrusted store:listFeatureBatches request.");
    }
    const runner = await waitForRunner();
    return await runner.listFeatureBatches(payload.featureId) satisfies SelfModBatchRecord[];
  });

  ipcMain.handle("store:createReleaseDraft", async (event, payload: { featureId: string; batchIds?: string[] }) => {
    if (!options.assertPrivilegedSender(event, "store:createReleaseDraft")) {
      throw new Error("Blocked untrusted store:createReleaseDraft request.");
    }
    const runner = await waitForRunner();
    return await runner.createReleaseDraft(payload);
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
      const runner = await waitForRunner();
      return await runner.publishStoreRelease(payload);
    },
  );

  ipcMain.handle("store:listPackages", async (event) => {
    if (!options.assertPrivilegedSender(event, "store:listPackages")) {
      throw new Error("Blocked untrusted store:listPackages request.");
    }
    const runner = await waitForRunner();
    return await runner.listStorePackages() satisfies StorePackageRecord[];
  });

  ipcMain.handle("store:getPackage", async (event, payload: { packageId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:getPackage")) {
      throw new Error("Blocked untrusted store:getPackage request.");
    }
    const runner = await waitForRunner();
    return await runner.getStorePackage(payload.packageId) satisfies StorePackageRecord | null;
  });

  ipcMain.handle("store:listReleases", async (event, payload: { packageId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:listReleases")) {
      throw new Error("Blocked untrusted store:listReleases request.");
    }
    const runner = await waitForRunner();
    return await runner.listStorePackageReleases(payload.packageId) satisfies StorePackageReleaseRecord[];
  });

  ipcMain.handle(
    "store:getRelease",
    async (event, payload: { packageId: string; releaseNumber: number }) => {
      if (!options.assertPrivilegedSender(event, "store:getRelease")) {
        throw new Error("Blocked untrusted store:getRelease request.");
      }
      const runner = await waitForRunner();
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
      const runner = await waitForRunner();
      return await runner.installStoreRelease(payload) satisfies InstalledStoreModRecord;
    },
  );

  ipcMain.handle("store:listInstalledMods", async (event) => {
    if (!options.assertPrivilegedSender(event, "store:listInstalledMods")) {
      throw new Error("Blocked untrusted store:listInstalledMods request.");
    }
    const runner = await waitForRunner();
    return await runner.listInstalledMods() satisfies InstalledStoreModRecord[];
  });

  ipcMain.handle("store:uninstallMod", async (event, payload: { packageId: string }) => {
    if (!options.assertPrivilegedSender(event, "store:uninstallMod")) {
      throw new Error("Blocked untrusted store:uninstallMod request.");
    }
    const runner = await waitForRunner();
    return await runner.uninstallStoreMod(payload.packageId);
  });
};
