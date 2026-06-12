import { promises as fs } from "fs";
import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import path from "path";
import type {
  SelfModFeatureRosterPage,
  SelfModFeatureSnapshot,
  StoreInstallRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
} from "../../../runtime/contracts/index.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

const STORE_INSTALL_ARTIFACT_LIMIT = 20;

/** Minimal theme payload forwarded to the embedded website view. Mirrors
 *  `WebsiteViewTheme` in `desktop/electron/windows/website-view.ts`; the
 *  type is duplicated locally because this module is also imported by the
 *  IPC layer that doesn't otherwise depend on the controller. */
type WebsiteViewThemePayload = {
  mode?: "light" | "dark";
  foreground?: string;
  foregroundWeak?: string;
  border?: string;
  primary?: string;
  surface?: string;
  background?: string;
};

const sanitizeWebsiteViewTheme = (
  raw: unknown,
): WebsiteViewThemePayload | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const pickString = (key: string): string | undefined => {
    const candidate = value[key];
    if (typeof candidate !== "string") return undefined;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const mode =
    value.mode === "light" || value.mode === "dark"
      ? (value.mode as "light" | "dark")
      : undefined;
  const sanitized: WebsiteViewThemePayload = {
    ...(mode ? { mode } : {}),
    ...(pickString("foreground")
      ? { foreground: pickString("foreground") }
      : {}),
    ...(pickString("foregroundWeak")
      ? { foregroundWeak: pickString("foregroundWeak") }
      : {}),
    ...(pickString("border") ? { border: pickString("border") } : {}),
    ...(pickString("primary") ? { primary: pickString("primary") } : {}),
    ...(pickString("surface") ? { surface: pickString("surface") } : {}),
    ...(pickString("background")
      ? { background: pickString("background") }
      : {}),
  };
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

type StoreHandlersOptions = {
  getStellaAppDir: () => string | null;
  getStellaDataDir: () => string | null;
  getStellaHostRunner: () => StellaHostRunner | null;
  getFullWindow?: () => BrowserWindow | null;
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
  showStoreWebView?: (params?: {
    route?: "store" | "billing";
    tab?: string;
    packageId?: string;
    embedded?: boolean;
    theme?: WebsiteViewThemePayload;
  }) => void;
  prewarmStoreWebView?: (params?: {
    route?: "store" | "billing";
    tab?: string;
    packageId?: string;
    embedded?: boolean;
    theme?: WebsiteViewThemePayload;
  }) => void;
  hideStoreWebView?: () => void;
  setStoreWebViewLayout?: (
    layout: { x: number; y: number; width: number; height: number } | null,
  ) => void;
  setStoreWebViewTheme?: (theme: WebsiteViewThemePayload) => void;
  goBackInStoreWebView?: () => void;
  goForwardInStoreWebView?: () => void;
  reloadStoreWebView?: () => void;
  dispatchStoreWebLocalAction?: (
    action: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;
};

const listInstalledThemes = async (stellaAppDir: string) => {
  const themesDir = path.join(stellaAppDir, "themes");
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

const installConfirmedStoreRelease = async (
  options: StoreHandlersOptions,
  runner: StellaHostRunner,
  payload: { packageId?: unknown; releaseNumber?: unknown },
) => {
  const packageId =
    typeof payload?.packageId === "string" ? payload.packageId : "";
  const releaseNumber =
    typeof payload?.releaseNumber === "number" &&
    Number.isFinite(payload.releaseNumber)
      ? payload.releaseNumber
      : NaN;
  if (!packageId || !Number.isFinite(releaseNumber)) {
    throw new Error("Invalid Store install request.");
  }
  // Confirmation lives in the Store webview (`InstallConfirmDialog`), which
  // shows the rendered release summary before the renderer reaches this
  // handler. Main still fetches its own release copy so a compromised renderer
  // cannot substitute install contents.
  const release = (await runner.getStorePackageRelease(
    packageId,
    releaseNumber,
  )) satisfies StorePackageReleaseRecord | null;
  if (!release?.blueprintMarkdown) {
    throw new Error("This package is missing its install release summary.");
  }
  const installPayload = {
    packageId: release.packageId,
    releaseNumber: release.releaseNumber,
    displayName: release.manifest.displayName,
    blueprintMarkdown: release.blueprintMarkdown,
    ...(release.gitArtifact ? { gitArtifact: release.gitArtifact } : {}),
    ...(release.diff ? { diff: release.diff } : {}),
    commits: release.commits,
  };
  const installRecord = (await runner.installFromBlueprint(
    installPayload,
  )) satisfies StoreInstallRecord;
  const stellaDataDir = options.getStellaDataDir();
  if (stellaDataDir) {
    await cleanupStoreInstallArtifacts(stellaDataDir, installPayload).catch(
      () => undefined,
    );
  }
  return installRecord;
};

const cleanupStoreInstallArtifacts = async (
  stellaDataDir: string,
  payload: { packageId: string; releaseNumber: number },
) => {
  const artifactRoot = path.join(stellaDataDir, "raw", "store-installs");
  const safePackageSegment = safeStorePackageSegment(payload.packageId);
  const packagePrefix = `${safePackageSegment}-r`;
  await fs.rm(
    path.join(artifactRoot, `${packagePrefix}${payload.releaseNumber}`),
    {
      recursive: true,
      force: true,
    },
  );

  const entries = await fs
    .readdir(artifactRoot, { withFileTypes: true })
    .catch(() => []);
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith(packagePrefix),
      )
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
    async (
      event,
      payload?: {
        route?: "store" | "billing";
        tab?: string;
        package?: string;
        packageId?: string;
        embedded?: boolean;
        theme?: unknown;
      },
    ) => {
      assertPrivilegedRequest(options, event, "storeWeb:show");
      options.showStoreWebView?.({
        route: payload?.route,
        tab: payload?.tab,
        packageId: payload?.packageId ?? payload?.package,
        embedded: payload?.embedded === true,
        theme: sanitizeWebsiteViewTheme(payload?.theme),
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "storeWeb:prewarm",
    async (
      event,
      payload?: {
        route?: "store" | "billing";
        tab?: string;
        package?: string;
        packageId?: string;
        embedded?: boolean;
        theme?: unknown;
      },
    ) => {
      assertPrivilegedRequest(options, event, "storeWeb:prewarm");
      options.prewarmStoreWebView?.({
        route: payload?.route,
        tab: payload?.tab,
        packageId: payload?.packageId ?? payload?.package,
        embedded: payload?.embedded === true,
        theme: sanitizeWebsiteViewTheme(payload?.theme),
      });
      return { ok: true };
    },
  );

  ipcMain.handle("storeWeb:setTheme", async (event, payload?: unknown) => {
    assertPrivilegedRequest(options, event, "storeWeb:setTheme");
    const theme = sanitizeWebsiteViewTheme(payload);
    if (theme) {
      options.setStoreWebViewTheme?.(theme);
    }
    return { ok: true };
  });

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

  const handleStoreWebLocalAction = (
    action: unknown,
    opts?: { timeoutMs?: number },
  ) => {
    if (!options.dispatchStoreWebLocalAction) {
      throw new Error("The local Store bridge is unavailable.");
    }
    return options.dispatchStoreWebLocalAction(action, opts);
  };

  ipcMain.handle("storeWeb:openStorePanel", async (event) => {
    assertStoreWebRequest(event, "storeWeb:openStorePanel");
    return await handleStoreWebLocalAction({
      type: "openStorePanel",
    });
  });

  ipcMain.handle("storeWeb:openSignIn", async (event) => {
    assertStoreWebRequest(event, "storeWeb:openSignIn");
    return await handleStoreWebLocalAction({
      type: "openSignIn",
    });
  });

  ipcMain.handle("storeWeb:showToast", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:showToast");
    return await handleStoreWebLocalAction({
      type: "showToast",
      payload,
    });
  });

  ipcMain.handle("storeWeb:listNativeIntegrations", async (event) => {
    assertStoreWebRequest(event, "storeWeb:listNativeIntegrations");
    return await handleStoreWebLocalAction({
      type: "listNativeIntegrations",
    });
  });

  ipcMain.handle(
    "storeWeb:connectNativeIntegration",
    async (event, payload: unknown) => {
      assertStoreWebRequest(event, "storeWeb:connectNativeIntegration");
      return await handleStoreWebLocalAction(
        {
          type: "connectNativeIntegration",
          payload,
        },
        { timeoutMs: 5 * 60 * 1000 },
      );
    },
  );

  ipcMain.handle(
    "storeWeb:disconnectNativeIntegration",
    async (event, payload: unknown) => {
      assertStoreWebRequest(event, "storeWeb:disconnectNativeIntegration");
      return await handleStoreWebLocalAction({
        type: "disconnectNativeIntegration",
        payload,
      });
    },
  );

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

  ipcMain.handle(
    "storeWeb:installEmojiPack",
    async (event, payload: unknown) => {
      assertStoreWebRequest(event, "storeWeb:installEmojiPack");
      return await handleStoreWebLocalAction({
        type: "installEmojiPack",
        payload,
      });
    },
  );

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

  ipcMain.handle("theme:listInstalled", async () => {
    const stellaDataDir = options.getStellaDataDir();
    if (!stellaDataDir) {
      return [];
    }
    return await listInstalledThemes(stellaDataDir);
  });

  ipcMain.handle("store:readFeatureSnapshot", async (event) => {
    return await withStoreRunner(
      event,
      "store:readFeatureSnapshot",
      async (runner) =>
        (await runner.readSelfModFeatureSnapshot()) satisfies SelfModFeatureSnapshot | null,
    );
  });

  ipcMain.handle("storeWeb:readFeatureSnapshot", async (event) => {
    return await withStoreWebRunner(
      event,
      "storeWeb:readFeatureSnapshot",
      async (runner) =>
        (await runner.readSelfModFeatureSnapshot()) satisfies SelfModFeatureSnapshot | null,
    );
  });

  ipcMain.handle(
    "store:listFeatureRoster",
    async (event, payload?: { limit?: number; offset?: number }) => {
      return await withStoreRunner(
        event,
        "store:listFeatureRoster",
        async (runner) =>
          (await runner.listSelfModFeatureRoster(
            payload,
          )) satisfies SelfModFeatureRosterPage,
      );
    },
  );

  ipcMain.handle("store:listPackages", async (event) => {
    return await withStoreRunner(
      event,
      "store:listPackages",
      async (runner) =>
        (await runner.listStorePackages()) satisfies StorePackageRecord[],
    );
  });

  ipcMain.handle(
    "store:getPackage",
    async (event, payload: { packageId: string }) => {
      return await withStoreRunner(
        event,
        "store:getPackage",
        async (runner) =>
          (await runner.getStorePackage(
            payload.packageId,
          )) satisfies StorePackageRecord | null,
      );
    },
  );

  ipcMain.handle(
    "store:listReleases",
    async (event, payload: { packageId: string }) => {
      return await withStoreRunner(
        event,
        "store:listReleases",
        async (runner) =>
          (await runner.listStorePackageReleases(
            payload.packageId,
          )) satisfies StorePackageReleaseRecord[],
      );
    },
  );

  ipcMain.handle(
    "store:getRelease",
    async (event, payload: { packageId: string; releaseNumber: number }) =>
      await withStoreRunner(
        event,
        "store:getRelease",
        async (runner) =>
          (await runner.getStorePackageRelease(
            payload.packageId,
            payload.releaseNumber,
          )) satisfies StorePackageReleaseRecord | null,
      ),
  );

  // Renderer install requests name a Store package/release only. Main fetches
  // the release, asks for native confirmation, then installs the fetched
  // source-backed release so a compromised renderer cannot supply contents.
  ipcMain.handle(
    "store:installFromBlueprint",
    async (
      event,
      payload: {
        packageId?: unknown;
        releaseNumber?: unknown;
      },
    ) =>
      await withStoreRunner(
        event,
        "store:installFromBlueprint",
        async (runner) =>
          await installConfirmedStoreRelease(options, runner, payload),
      ),
  );

  ipcMain.handle(
    "storeWeb:requestPackageInstall",
    async (
      event,
      payload: {
        packageId?: unknown;
        releaseNumber?: unknown;
      },
    ) =>
      await withStoreWebRunner(
        event,
        "storeWeb:requestPackageInstall",
        async (runner) =>
          await installConfirmedStoreRelease(options, runner, payload),
      ),
  );

  type StorePublishSelectedFeaturesPayload = {
    attachedFeatureNames: string[];
    /** Roster featureIds parallel to the names (`""` for legacy entries). */
    attachedFeatureIds?: string[];
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
  };

  ipcMain.handle(
    "store:publishSelectedFeatures",
    async (event, payload: StorePublishSelectedFeaturesPayload) =>
      await withStoreRunner(
        event,
        "store:publishSelectedFeatures",
        async (runner) =>
          await runner.publishStoreSelectedFeatures(
            payload as Parameters<
              typeof runner.publishStoreSelectedFeatures
            >[0],
          ),
      ),
  );

  ipcMain.handle(
    "storeWeb:publishSelectedFeatures",
    async (event, payload: StorePublishSelectedFeaturesPayload) =>
      await withStoreWebRunner(
        event,
        "storeWeb:publishSelectedFeatures",
        async (runner) =>
          await runner.publishStoreSelectedFeatures(
            payload as Parameters<
              typeof runner.publishStoreSelectedFeatures
            >[0],
          ),
      ),
  );

  ipcMain.handle("store:listInstalledMods", async (event) => {
    return await withStoreRunner(
      event,
      "store:listInstalledMods",
      async (runner) =>
        (await runner.listInstalledMods()) satisfies StoreInstallRecord[],
    );
  });

  ipcMain.handle("storeWeb:listInstalledMods", async (event) => {
    return await withStoreWebRunner(
      event,
      "storeWeb:listInstalledMods",
      async (runner) =>
        (await runner.listInstalledMods()) satisfies StoreInstallRecord[],
    );
  });

  ipcMain.handle(
    "store:uninstallMod",
    async (event, payload: { packageId: string }) => {
      return await withStoreRunner(event, "store:uninstallMod", (runner) =>
        runner.uninstallStoreMod(payload.packageId),
      );
    },
  );

  ipcMain.handle(
    "storeWeb:uninstallMod",
    async (event, payload: { packageId: string }) => {
      return await withStoreWebRunner(
        event,
        "storeWeb:uninstallMod",
        (runner) => runner.uninstallStoreMod(payload.packageId),
      );
    },
  );
};
