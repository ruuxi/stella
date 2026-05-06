import { app, BrowserWindow, session } from "electron";
import { hasMacPermission } from "../utils/macos-permissions.js";
import path from "path";
import { resolveStellaHome } from "../../../runtime/kernel/home/stella-home.js";
import { getDevServerUrl } from "../dev-url.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { PetWindowController } from "../windows/pet-window.js";
import { WindowManager } from "../windows/window-manager.js";
import { createHmrTransitionController } from "../self-mod/hmr-morph.js";
import {
  type BootstrapContext,
  getAllWindows,
  getMobileBroadcast,
} from "./context.js";
import { startDeferredStartup } from "./deferred-startup.js";

const DEFAULT_STORE_WEB_URL = "https://stella.sh/store";

const readStoreWebBaseUrl = () =>
  (
    process.env.STELLA_STORE_WEB_URL ??
    process.env.VITE_STELLA_STORE_WEB_URL ??
    DEFAULT_STORE_WEB_URL
  ).trim() || DEFAULT_STORE_WEB_URL;

const appendStoreWebParams = (
  rawUrl: string,
  params?: { tab?: string; packageId?: string },
) => {
  const url = new URL(rawUrl);
  if (params?.tab) {
    url.searchParams.set("tab", params.tab);
  }
  if (params?.packageId) {
    url.searchParams.set("package", params.packageId);
  }
  return url.toString();
};

const storeWebOrigin = (value: string) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const initializeBootstrapLocalState = async (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const stellaHome = await resolveStellaHome(app, config.stellaRoot);

  lifecycle.setStellaRoot(stellaHome.stellaRoot);
  state.stellaRoot = stellaHome.stellaRoot;
  state.stellaWorkspacePath = stellaHome.workspacePath;
  services.backupService.start();

  services.securityPolicyService.setSecurityPolicyPath(
    path.join(stellaHome.statePath, "security_policy.json"),
  );
};

const initializeWindowShell = (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const preloadPath = path.join(config.electronDir, "preload.js");
  const storeWebPreloadPath = path.join(config.electronDir, "store-web-preload.js");
  const storeWebBaseUrl = readStoreWebBaseUrl();
  const allowedStoreWebOrigin = storeWebOrigin(storeWebBaseUrl);
  const appSession = session.fromPartition(config.sessionPartition);

  appSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (permission === "media" || permission === "display-capture") {
        callback(true);
        return;
      }

      callback(false);
    },
  );

  state.overlayController = new OverlayWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.isDev,
    getDevServerUrl,
  });
  state.petController = new PetWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.isDev,
    getDevServerUrl,
  });
  state.overlayController.setSelectionChipClickHandler((requestId) => {
    services.selectionWatcherService.resolveClick(requestId);
  });

  lifecycle.setWindowManager(
    new WindowManager({
      electronDir: config.electronDir,
      preloadPath,
      storeWebPreloadPath,
      getStoreWebUrl: (params) => appendStoreWebParams(storeWebBaseUrl, params),
      isAllowedStoreWebUrl: (url) =>
        Boolean(allowedStoreWebOrigin && storeWebOrigin(url) === allowedStoreWebOrigin),
      sessionPartition: config.sessionPartition,
      isDev: config.isDev,
      getDevServerUrl,
      isAppReady: () => state.appReady,
      externalLinkService: services.externalLinkService,
      onUpdateUiState: (partial) => services.uiStateService.update(partial),
      onMiniHidden: () => services.selectionWatcherService.hideChip(),
    }),
  );

  services.uiStateService.bind({
    broadcastTarget: {
      getAllWindows: () => getAllWindows(context),
    },
    getBroadcastToMobile: () => getMobileBroadcast(context),
  });

  state.hmrTransitionController = createHmrTransitionController({
    getFullWindow: () => state.windowManager?.getFullWindow() ?? null,
    getOverlayController: () => state.overlayController,
  });
};

const finalizeWindowLaunch = (context: BootstrapContext) => {
  const { config, services, state } = context;

  state.windowManager!.createInitialWindows();

  const fullWindow = state.windowManager!.getFullWindow();

  // The cold-boot deep-link OTT (`stella://auth/callback?ott=…`) sits in
  // `authService.pendingAuthCallback` waiting for the renderer to pull it via
  // `auth:consumePendingCallback`. We deliberately don't rebroadcast on
  // `did-finish-load` — that fires before React commits its first effects,
  // so the renderer-side `auth:callback` listener wasn't necessarily mounted.
  // The renderer pulls explicitly from `AuthDeepLinkHandler` once subscribed.

  if (fullWindow) {
    fullWindow.webContents.once("did-finish-load", () => {
      void startDeferredStartup(context);
    });
  }

  state.windowManager!.showWindow("full");
  context.state.processRuntime.setManagedTimeout(() => {
    void startDeferredStartup(context);
  }, config.startupStageDelayMs);

  // If Accessibility was off at startup, deferred startup skips the hook; when
  // the user enables it in System Settings and returns to Stella, retry start.
  if (process.platform === "darwin") {
    app.on("browser-window-focus", () => {
      if (!hasMacPermission("accessibility", false)) {
        return;
      }
      services.radialGestureService.start();
      services.selectionWatcherService.start();
    });
  }

  app.on("browser-window-focus", () => {
    state.stellaHostRunner?.setHostFocused(true);
  });
  app.on("browser-window-blur", () => {
    context.state.processRuntime.setManagedTimeout(() => {
      if (BrowserWindow.getFocusedWindow()) {
        return;
      }
      state.stellaHostRunner?.setHostFocused(false);
    }, 250);
  });
};

export const initializeBootstrapAppShell = async (
  context: BootstrapContext,
) => {
  await prepareBootstrapAppShell(context);
  launchBootstrapAppShell(context);
};

export const prepareBootstrapAppShell = async (context: BootstrapContext) => {
  await initializeBootstrapLocalState(context);
  initializeWindowShell(context);
};

export const launchBootstrapAppShell = (context: BootstrapContext) => {
  finalizeWindowLaunch(context);
};
