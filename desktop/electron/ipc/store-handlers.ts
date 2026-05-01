import { promises as fs } from "fs";
import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type {
  SelfModFeatureSnapshot,
  StoreInstallRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
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

  ipcMain.handle("store:readFeatureSnapshot", async (event) => {
    return await withStoreRunner(
      event,
      "store:readFeatureSnapshot",
      async (runner) =>
        (await runner.readSelfModFeatureSnapshot()) satisfies
          | SelfModFeatureSnapshot
          | null,
    );
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

  // Install via the new blueprint flow: the renderer fetches the
  // published release (blueprintMarkdown is on the release row), then
  // calls this IPC with the markdown + package metadata. The worker
  // runs a general agent that implements the blueprint and the runtime
  // self-mod commit captures whatever changed.
  ipcMain.handle(
    "store:installFromBlueprint",
    async (
      event,
      payload: {
        packageId: string;
        releaseNumber: number;
        displayName: string;
        blueprintMarkdown: string;
      },
    ) =>
      await withStoreRunner(event, "store:installFromBlueprint", async (runner) =>
        await runner.installFromBlueprint(payload) satisfies StoreInstallRecord),
  );

  ipcMain.handle("store:listInstalledMods", async (event) => {
    return await withStoreRunner(event, "store:listInstalledMods", async (runner) =>
      await runner.listInstalledMods() satisfies StoreInstallRecord[]);
  });

  ipcMain.handle("store:getThread", async (event) => {
    return await withStoreRunner(event, "store:getThread", async (runner) =>
      await runner.getStoreThread());
  });

  ipcMain.handle(
    "store:sendThreadMessage",
    async (
      event,
      payload: {
        text: string;
        attachedFeatureNames?: string[];
        editingBlueprint?: boolean;
      },
    ) =>
      await withStoreRunner(event, "store:sendThreadMessage", async (runner) =>
        await runner.sendStoreThreadMessage(payload)),
  );

  ipcMain.handle("store:cancelThreadTurn", async (event) => {
    return await withStoreRunner(event, "store:cancelThreadTurn", async (runner) =>
      await runner.cancelStoreThreadTurn());
  });

  ipcMain.handle("store:denyLatestBlueprint", async (event) => {
    return await withStoreRunner(event, "store:denyLatestBlueprint", async (runner) =>
      await runner.denyLatestStoreBlueprint());
  });

  ipcMain.handle(
    "store:markBlueprintPublished",
    async (event, payload: { messageId: string; releaseNumber: number }) =>
      await withStoreRunner(event, "store:markBlueprintPublished", async (runner) =>
        await runner.markStoreBlueprintPublished(payload)),
  );

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
