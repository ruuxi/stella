import { promises as fs } from "fs";
import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type {
  InstalledStoreModRecord,
  LocalGitCommitRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
} from "../../src/shared/contracts/boundary.js";
import type {
  StoreThreadCommitCatalogEntry,
  StoreThreadBundlePayload,
} from "../../src/shared/types/electron.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";
import {
  installOfficialConnector,
  listStellaConnectors,
  removeOfficialConnector,
} from "../../../runtime/kernel/mcp/state.js";
import { connectMcpOAuth, saveMcpAccessToken } from "../../../runtime/kernel/mcp/oauth.js";

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

  // Targeted lookup that walks the wide self-mod history (matching the
  // feature roster's window) so the publish path + pick card can resolve
  // commits older than the recent slice. Pass either feature ids,
  // commit hashes, or both.
  ipcMain.handle(
    "store:listLocalCommitsBySelector",
    async (event, payload: { featureIds?: string[]; commitHashes?: string[] }) => {
      return await withStoreRunner(
        event,
        "store:listLocalCommitsBySelector",
        async (runner) =>
          await runner.listLocalCommitsBySelector({
            ...(payload?.featureIds ? { featureIds: payload.featureIds } : {}),
            ...(payload?.commitHashes ? { commitHashes: payload.commitHashes } : {}),
          }) satisfies LocalGitCommitRecord[],
      );
    },
  );

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

  // Build the lightweight commit catalog the backend Store agent reasons
  // over. Identical to what `store:listLocalCommits` returns plus an
  // explicit `fileCount` (`fileCount` is already on the record but we
  // surface a stable shape) — this is the *backend-friendly* upload
  // payload, not a UI list.
  ipcMain.handle(
    "store-thread:buildCommitCatalog",
    async (event, payload: { limit?: number }) =>
      await withStoreRunner(event, "store-thread:buildCommitCatalog", async (runner) => {
        const commits = await runner.listLocalCommits(payload?.limit);
        const catalog: StoreThreadCommitCatalogEntry[] = commits.map((commit) => ({
          commitHash: commit.commitHash,
          shortHash: commit.shortHash,
          subject: commit.subject,
          body: commit.body,
          timestampMs: commit.timestampMs,
          files: commit.files,
          fileCount: commit.fileCount,
          ...(commit.featureId ? { featureId: commit.featureId } : {}),
          ...(commit.parentPackageIds && commit.parentPackageIds.length > 0
            ? { parentPackageIds: commit.parentPackageIds }
            : {}),
        }));
        return catalog;
      }),
  );

  // Build the full publish bundle (commit metadata + patches + file
  // snapshots) for the picked commit hashes. Called only at confirm
  // time so the renderer never uploads file snapshots speculatively.
  ipcMain.handle(
    "store-thread:buildBundle",
    async (event, payload: { commitHashes: string[] }) =>
      await withStoreRunner(event, "store-thread:buildBundle", async (runner) => {
        const bundle = await runner.buildStoreThreadBundle(payload.commitHashes);
        return bundle satisfies StoreThreadBundlePayload;
      }),
  );

  // Read the local feature roster (collapsed Stella self-mod commit
  // groups + installed-add-on footprints). Powers the Store side
  // panel's linear list and reuses exactly what the commit-message
  // LLM saw, so the UI never disagrees with the system.
  ipcMain.handle(
    "store-thread:listFeatureRoster",
    async (event) =>
      await withStoreRunner(event, "store-thread:listFeatureRoster", async (runner) =>
        await runner.listStoreFeatureRoster()),
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
