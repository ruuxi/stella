import { promises as fs } from "fs";
import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "path";
import type {
  SelfModFeatureSnapshot,
  StoreInstallRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
} from "../../../runtime/contracts/index.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";
import {
  installOfficialConnector,
  listStellaConnectors,
  removeOfficialConnector,
} from "../../../runtime/kernel/mcp/state.js";
import { connectMcpOAuth, saveMcpAccessToken } from "../../../runtime/kernel/mcp/oauth.js";

const STORE_INSTALL_ARTIFACT_LIMIT = 20;

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
  assertStoreWebSender?: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getStoreAuthToken?: () => Promise<string | null>;
  showStoreWebView?: (params?: { tab?: string; packageId?: string }) => void;
  hideStoreWebView?: () => void;
  setStoreWebViewLayout?: (
    layout: { x: number; y: number; width: number; height: number } | null,
  ) => void;
  goBackInStoreWebView?: () => void;
  goForwardInStoreWebView?: () => void;
  reloadStoreWebView?: () => void;
  dispatchStoreWebLocalAction?: (action: unknown) => Promise<unknown>;
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

const safeStorePackageSegment = (packageId: string) =>
  packageId.replace(/[^a-z0-9_-]/gi, "_");

const cleanupStoreInstallArtifacts = async (
  stellaRoot: string,
  payload: { packageId: string; releaseNumber: number },
) => {
  const artifactRoot = path.join(stellaRoot, "state", "raw", "store-installs");
  const safePackageSegment = safeStorePackageSegment(payload.packageId);
  const packagePrefix = `${safePackageSegment}-r`;
  await fs.rm(path.join(artifactRoot, `${packagePrefix}${payload.releaseNumber}`), {
    recursive: true,
    force: true,
  });

  const entries = await fs
    .readdir(artifactRoot, { withFileTypes: true })
    .catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(packagePrefix))
      .map((entry) =>
        fs.rm(path.join(artifactRoot, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );

  const remaining = await fs
    .readdir(artifactRoot, { withFileTypes: true })
    .catch(() => []);
  const dirs = await Promise.all(
    remaining
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const fullPath = path.join(artifactRoot, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        return stat ? { fullPath, mtimeMs: stat.mtimeMs } : null;
      }),
  );
  const staleDirs = dirs
    .filter((dir): dir is { fullPath: string; mtimeMs: number } => dir !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(STORE_INSTALL_ARTIFACT_LIMIT);
  await Promise.all(
    staleDirs.map((dir) =>
      fs.rm(dir.fullPath, { recursive: true, force: true }),
    ),
  );
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
  const assertStoreWebRequest = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => {
    if (!options.assertStoreWebSender?.(event, channel)) {
      throw new Error(`Blocked untrusted IPC call to ${channel}`);
    }
  };
  const withStoreWebRunner = async <T>(
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
    action: (runner: Awaited<ReturnType<typeof waitForRunner>>) => Promise<T>,
  ) => {
    assertStoreWebRequest(event, channel);
    return await action(await waitForRunner());
  };

  ipcMain.handle(
    "storeWeb:show",
    async (event, payload?: { tab?: string; package?: string; packageId?: string }) => {
      assertPrivilegedRequest(options, event, "storeWeb:show");
      options.showStoreWebView?.({
        tab: payload?.tab,
        packageId: payload?.packageId ?? payload?.package,
      });
      return { ok: true };
    },
  );

  ipcMain.handle("storeWeb:hide", async (event) => {
    assertPrivilegedRequest(options, event, "storeWeb:hide");
    options.hideStoreWebView?.();
    return { ok: true };
  });

  ipcMain.handle(
    "storeWeb:setLayout",
    async (
      event,
      payload?: { x?: number; y?: number; width?: number; height?: number },
    ) => {
      assertPrivilegedRequest(options, event, "storeWeb:setLayout");
      const layout =
        payload &&
        Number.isFinite(payload.x) &&
        Number.isFinite(payload.y) &&
        Number.isFinite(payload.width) &&
        Number.isFinite(payload.height)
          ? {
              x: Math.round(payload.x!),
              y: Math.round(payload.y!),
              width: Math.max(0, Math.round(payload.width!)),
              height: Math.max(0, Math.round(payload.height!)),
            }
          : null;
      options.setStoreWebViewLayout?.(layout);
      return { ok: true };
    },
  );

  ipcMain.handle("storeWeb:goBack", async (event) => {
    assertPrivilegedRequest(options, event, "storeWeb:goBack");
    options.goBackInStoreWebView?.();
    return { ok: true };
  });

  ipcMain.handle("storeWeb:goForward", async (event) => {
    assertPrivilegedRequest(options, event, "storeWeb:goForward");
    options.goForwardInStoreWebView?.();
    return { ok: true };
  });

  ipcMain.handle("storeWeb:reload", async (event) => {
    assertPrivilegedRequest(options, event, "storeWeb:reload");
    options.reloadStoreWebView?.();
    return { ok: true };
  });

  ipcMain.handle("storeWeb:getAuthToken", async (event) => {
    assertStoreWebRequest(event, "storeWeb:getAuthToken");
    return (await options.getStoreAuthToken?.()) ?? null;
  });

  const handleStoreWebLocalAction = (action: unknown) => {
    if (!options.dispatchStoreWebLocalAction) {
      throw new Error("The local Store bridge is unavailable.");
    }
    return options.dispatchStoreWebLocalAction(action);
  };

  ipcMain.handle("storeWeb:openStorePanel", async (event) => {
    assertStoreWebRequest(event, "storeWeb:openStorePanel");
    return await handleStoreWebLocalAction({
      type: "openStorePanel",
    });
  });

  ipcMain.handle("storeWeb:installPet", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:installPet");
    return await handleStoreWebLocalAction({
      type: "installPet",
      payload,
    });
  });

  ipcMain.handle("storeWeb:selectPet", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:selectPet");
    return await handleStoreWebLocalAction({
      type: "selectPet",
      payload,
    });
  });

  ipcMain.handle("storeWeb:removePet", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:removePet");
    return await handleStoreWebLocalAction({
      type: "removePet",
      payload,
    });
  });

  ipcMain.handle("storeWeb:getPetState", async (event) => {
    assertStoreWebRequest(event, "storeWeb:getPetState");
    return await handleStoreWebLocalAction({
      type: "getPetState",
    });
  });

  ipcMain.handle("storeWeb:setPetOpen", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:setPetOpen");
    return await handleStoreWebLocalAction({
      type: "setPetOpen",
      payload,
    });
  });

  ipcMain.handle("storeWeb:installEmojiPack", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:installEmojiPack");
    return await handleStoreWebLocalAction({
      type: "installEmojiPack",
      payload,
    });
  });

  ipcMain.handle("storeWeb:clearEmojiPack", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:clearEmojiPack");
    return await handleStoreWebLocalAction({
      type: "clearEmojiPack",
      payload,
    });
  });

  ipcMain.handle("storeWeb:getEmojiPackState", async (event) => {
    assertStoreWebRequest(event, "storeWeb:getEmojiPackState");
    return await handleStoreWebLocalAction({
      type: "getEmojiPackState",
    });
  });

  ipcMain.handle("storeWeb:fashionLocalAction", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:fashionLocalAction");
    return await handleStoreWebLocalAction({
      type: "fashion",
      payload,
    });
  });

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

  ipcMain.handle("storeWeb:readFeatureSnapshot", async (event) => {
    return await withStoreWebRunner(
      event,
      "storeWeb:readFeatureSnapshot",
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

  ipcMain.handle(
    "storeWeb:getRelease",
    async (event, payload: { packageId: string; releaseNumber: number }) =>
      await withStoreWebRunner(event, "storeWeb:getRelease", async (runner) =>
        await runner.getStorePackageRelease(
          payload.packageId,
          payload.releaseNumber,
        ) satisfies StorePackageReleaseRecord | null),
  );

  // Install via the new blueprint flow: the renderer fetches the
  // published release (blueprintMarkdown + reference commits are on
  // the release row), then calls this IPC with that payload. The
  // worker materialises the spec + diffs into `state/raw/<pkg>-<rel>/`
  // and runs a general agent that implements the change, adapting the
  // diffs to the installer's possibly-divergent tree. The runtime's
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
        commits?: Array<{ hash: string; subject: string; diff: string }>;
      },
    ) =>
      await withStoreRunner(event, "store:installFromBlueprint", async (runner) => {
        const installRecord =
          await runner.installFromBlueprint(payload) satisfies StoreInstallRecord;
        const stellaRoot = options.getStellaRoot();
        if (stellaRoot) {
          await cleanupStoreInstallArtifacts(stellaRoot, payload).catch(
            () => undefined,
          );
        }
        return installRecord;
      }),
  );

  ipcMain.handle(
    "storeWeb:installFromBlueprint",
    async (
      event,
      payload: {
        packageId: string;
        releaseNumber: number;
        displayName: string;
        blueprintMarkdown: string;
        commits?: Array<{ hash: string; subject: string; diff: string }>;
      },
    ) =>
      await withStoreWebRunner(event, "storeWeb:installFromBlueprint", async (runner) => {
        const installRecord =
          await runner.installFromBlueprint(payload) satisfies StoreInstallRecord;
        const stellaRoot = options.getStellaRoot();
        if (stellaRoot) {
          await cleanupStoreInstallArtifacts(stellaRoot, payload).catch(
            () => undefined,
          );
        }
        return installRecord;
      }),
  );

  // Renderer-side publish entry point. The renderer collects the form
  // fields and the source `messageId`; the worker resolves the message
  // → attached features → commit hashes → `git show -U10` → redacted
  // diffs, and ships the spec + diffs to the backend in a single call.
  ipcMain.handle(
    "store:publishBlueprint",
    async (
      event,
      payload: {
        messageId: string;
        packageId: string;
        asUpdate: boolean;
        displayName?: string;
        description?: string;
        category?:
          | "apps-games"
          | "productivity"
          | "customization"
          | "skills-agents"
          | "integrations"
          | "other";
        manifest: Record<string, unknown>;
        releaseNotes?: string;
      },
    ) =>
      await withStoreRunner(event, "store:publishBlueprint", async (runner) =>
        await runner.publishStoreBlueprint(payload as Parameters<typeof runner.publishStoreBlueprint>[0])),
  );

  ipcMain.handle(
    "storeWeb:publishBlueprint",
    async (
      event,
      payload: {
        messageId: string;
        packageId: string;
        asUpdate: boolean;
        displayName?: string;
        description?: string;
        category?:
          | "apps-games"
          | "productivity"
          | "customization"
          | "skills-agents"
          | "integrations"
          | "other";
        manifest: Record<string, unknown>;
        releaseNotes?: string;
      },
    ) =>
      await withStoreWebRunner(event, "storeWeb:publishBlueprint", async (runner) =>
        await runner.publishStoreBlueprint(payload as Parameters<typeof runner.publishStoreBlueprint>[0])),
  );

  ipcMain.handle("store:listInstalledMods", async (event) => {
    return await withStoreRunner(event, "store:listInstalledMods", async (runner) =>
      await runner.listInstalledMods() satisfies StoreInstallRecord[]);
  });

  ipcMain.handle("storeWeb:listInstalledMods", async (event) => {
    return await withStoreWebRunner(event, "storeWeb:listInstalledMods", async (runner) =>
      await runner.listInstalledMods() satisfies StoreInstallRecord[]);
  });

  ipcMain.handle("store:getThread", async (event) => {
    return await withStoreRunner(event, "store:getThread", async (runner) =>
      await runner.getStoreThread());
  });

  ipcMain.handle("storeWeb:getThread", async (event) => {
    return await withStoreWebRunner(event, "storeWeb:getThread", async (runner) =>
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

  ipcMain.handle(
    "storeWeb:sendThreadMessage",
    async (
      event,
      payload: {
        text: string;
        attachedFeatureNames?: string[];
        editingBlueprint?: boolean;
      },
    ) =>
      await withStoreWebRunner(event, "storeWeb:sendThreadMessage", async (runner) =>
        await runner.sendStoreThreadMessage(payload)),
  );

  ipcMain.handle("store:cancelThreadTurn", async (event) => {
    return await withStoreRunner(event, "store:cancelThreadTurn", async (runner) =>
      await runner.cancelStoreThreadTurn());
  });

  ipcMain.handle("storeWeb:cancelThreadTurn", async (event) => {
    return await withStoreWebRunner(event, "storeWeb:cancelThreadTurn", async (runner) =>
      await runner.cancelStoreThreadTurn());
  });

  ipcMain.handle("store:denyLatestBlueprint", async (event) => {
    return await withStoreRunner(event, "store:denyLatestBlueprint", async (runner) =>
      await runner.denyLatestStoreBlueprint());
  });

  ipcMain.handle("storeWeb:denyLatestBlueprint", async (event) => {
    return await withStoreWebRunner(event, "storeWeb:denyLatestBlueprint", async (runner) =>
      await runner.denyLatestStoreBlueprint());
  });

  ipcMain.handle(
    "store:markBlueprintPublished",
    async (event, payload: { messageId: string; releaseNumber: number }) =>
      await withStoreRunner(event, "store:markBlueprintPublished", async (runner) =>
        await runner.markStoreBlueprintPublished(payload)),
  );

  ipcMain.handle(
    "storeWeb:markBlueprintPublished",
    async (event, payload: { messageId: string; releaseNumber: number }) =>
      await withStoreWebRunner(event, "storeWeb:markBlueprintPublished", async (runner) =>
        await runner.markStoreBlueprintPublished(payload)),
  );

  ipcMain.handle("store:uninstallMod", async (event, payload: { packageId: string }) => {
    return await withStoreRunner(event, "store:uninstallMod", (runner) =>
      runner.uninstallStoreMod(payload.packageId));
  });

  ipcMain.handle("storeWeb:uninstallMod", async (event, payload: { packageId: string }) => {
    return await withStoreWebRunner(event, "storeWeb:uninstallMod", (runner) =>
      runner.uninstallStoreMod(payload.packageId));
  });

  ipcMain.handle("store:listConnectors", async (event) => {
    assertPrivilegedRequest(options, event, "store:listConnectors");
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) return [];
    return await listStellaConnectors(stellaRoot);
  });

  ipcMain.handle("storeWeb:listConnectors", async (event) => {
    assertStoreWebRequest(event, "storeWeb:listConnectors");
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
      for (const api of installed.apis) {
        if (!api.baseUrl) continue;
        if (api.auth?.type !== "oauth" || !api.auth.tokenKey) continue;
        try {
          oauthResults.push(await connectMcpOAuth(stellaRoot, {
            tokenKey: api.auth.tokenKey,
            resourceUrl: api.baseUrl,
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

  ipcMain.handle(
    "storeWeb:installConnector",
    async (
      event,
      payload: {
        marketplaceKey: string;
        credential?: string;
        config?: Record<string, string>;
      },
    ) => {
      assertStoreWebRequest(event, "storeWeb:installConnector");
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
      for (const api of installed.apis) {
        if (!api.baseUrl) continue;
        if (api.auth?.type !== "oauth" || !api.auth.tokenKey) continue;
        try {
          oauthResults.push(await connectMcpOAuth(stellaRoot, {
            tokenKey: api.auth.tokenKey,
            resourceUrl: api.baseUrl,
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
