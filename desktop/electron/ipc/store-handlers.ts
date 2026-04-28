import { promises as fs } from "fs";
import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type {
  InstalledStoreModRecord,
  LocalGitCommitRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StorePublishDraft,
} from "../../src/shared/contracts/boundary.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";
import {
  installOfficialConnector,
  listStellaConnectors,
  removeOfficialConnector,
} from "../../../runtime/kernel/mcp/state.js";
import { connectMcpOAuth, saveMcpAccessToken } from "../../../runtime/kernel/mcp/oauth.js";
import { resolveStellaStatePath } from "../../../runtime/kernel/home/stella-home.js";

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
  const themesDir = path.join(resolveStellaStatePath(stellaRoot), "themes");
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
    "store:publishCandidateRelease",
    async (
      event,
      payload: {
        requestText: string;
        selectedCommitHashes: string[];
        existingPackageId?: string;
      },
    ) =>
      await withStoreRunner(event, "store:publishCandidateRelease", async (runner) =>
        await runner.publishStoreCandidateRelease(payload) satisfies StorePackageReleaseRecord),
  );

  ipcMain.handle(
    "store:prepareCandidateRelease",
    async (
      event,
      payload: {
        requestText: string;
        selectedCommitHashes: string[];
        existingPackageId?: string;
      },
    ) =>
      await withStoreRunner(event, "store:prepareCandidateRelease", async (runner) =>
        (await runner.prepareStoreCandidateRelease(payload)) as StorePublishDraft),
  );

  ipcMain.handle(
    "store:publishPreparedRelease",
    async (
      event,
      payload: {
        requestText: string;
        selectedCommitHashes: string[];
        existingPackageId?: string;
        draft: StorePublishDraft;
      },
    ) =>
      await withStoreRunner(event, "store:publishPreparedRelease", async (runner) =>
        await runner.publishPreparedStoreRelease(payload) satisfies StorePackageReleaseRecord),
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

  ipcMain.handle("store:listConnectors", async (event) => {
    assertPrivilegedRequest(options, event, "store:listConnectors");
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) return [];
    return await listStellaConnectors(stellaRoot);
  });

  ipcMain.handle(
    "store:installConnector",
    async (event, payload: { marketplaceKey: string; credential?: string; config?: Record<string, string> }) => {
      assertPrivilegedRequest(options, event, "store:installConnector");
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        throw new Error("Stella root is unavailable.");
      }
      const installed = await installOfficialConnector(
        stellaRoot,
        payload.marketplaceKey,
        payload.config ?? {},
      );
      const oauthResults = [];
      for (const target of [...installed.servers, ...installed.apis]) {
        if (target.auth?.type !== "none" && target.auth?.tokenKey && payload.credential) {
          await saveMcpAccessToken(stellaRoot, target.auth.tokenKey, payload.credential);
        }
      }
      for (const [key, value] of Object.entries(payload.config ?? {})) {
        if (value) {
          await saveMcpAccessToken(stellaRoot, key, value);
        }
      }
      for (const server of installed.servers) {
        if (server.transport !== "streamable_http" || !server.url) continue;
        if (server.auth?.type !== "oauth" || !server.auth.tokenKey) continue;
        try {
          oauthResults.push(await connectMcpOAuth(stellaRoot, {
            tokenKey: server.auth.tokenKey,
            resourceUrl: server.url,
            openUrl: (url) => shell.openExternal(url),
          }));
        } catch (error) {
          await removeOfficialConnector(stellaRoot, payload.marketplaceKey);
          throw error;
        }
      }
      return {
        installedServers: installed.servers.map((server) => ({
          id: server.id,
          displayName: server.displayName,
          transport: server.transport,
          url: server.url,
          auth: server.auth?.type,
        })),
        installedApis: installed.apis.map((api) => ({
          id: api.id,
          displayName: api.displayName,
          baseUrl: api.baseUrl,
          auth: api.auth?.type,
        })),
        oauth: oauthResults,
      };
    },
  );
};
