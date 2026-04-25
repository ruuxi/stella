import { promises as fs } from "fs";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type {
  InstalledStoreModRecord,
  LocalGitCommitRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
} from "../../src/shared/contracts/boundary.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

type StoreHandlersOptions = {
  getStellaRoot: () => string | null;
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const listInstalledThemes = async (stellaRoot: string) => {
  const themesDir = path.join(stellaRoot, "state", "themes");
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
  const withStoreRunner = async <T>(
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
    action: (runner: Awaited<ReturnType<typeof waitForRunner>>) => Promise<T>,
  ) => {
    assertPrivilegedRequest(options, event, channel);
    return await action(await waitForRunner());
  };

  ipcMain.handle("theme:listInstalled", async () => {
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) {
      return [];
    }
    return await listInstalledThemes(stellaRoot);
  });

  ipcMain.handle("store:listLocalCommits", async (event, payload?: { limit?: number }) => {
    return await withStoreRunner(event, "store:listLocalCommits", async (runner) =>
      await runner.listLocalCommits(payload?.limit) satisfies LocalGitCommitRecord[]);
  });

  ipcMain.handle("store:listPackages", async (event) => {
    return await withStoreRunner(event, "store:listPackages", async (runner) =>
      await runner.listStorePackages() satisfies StorePackageRecord[]);
  });

  ipcMain.handle("store:getPackage", async (event, payload: { packageId: string }) => {
    return await withStoreRunner(event, "store:getPackage", async (runner) =>
      await runner.getStorePackage(payload.packageId) satisfies StorePackageRecord | null);
  });

  ipcMain.handle("store:listReleases", async (event, payload: { packageId: string }) => {
    return await withStoreRunner(event, "store:listReleases", async (runner) =>
      await runner.listStorePackageReleases(payload.packageId) satisfies StorePackageReleaseRecord[]);
  });

  ipcMain.handle(
    "store:getRelease",
    async (event, payload: { packageId: string; releaseNumber: number }) =>
      await withStoreRunner(event, "store:getRelease", async (runner) =>
        await runner.getStorePackageRelease(
        payload.packageId,
        payload.releaseNumber,
      ) satisfies StorePackageReleaseRecord | null),
  );

  ipcMain.handle(
    "store:installRelease",
    async (event, payload: { packageId: string; releaseNumber?: number }) =>
      await withStoreRunner(event, "store:installRelease", async (runner) =>
        await runner.installStoreRelease(payload) satisfies InstalledStoreModRecord),
  );

  ipcMain.handle("store:listInstalledMods", async (event) => {
    return await withStoreRunner(event, "store:listInstalledMods", async (runner) =>
      await runner.listInstalledMods() satisfies InstalledStoreModRecord[]);
  });

  ipcMain.handle("store:uninstallMod", async (event, payload: { packageId: string }) => {
    return await withStoreRunner(event, "store:uninstallMod", (runner) =>
      runner.uninstallStoreMod(payload.packageId));
  });
};
