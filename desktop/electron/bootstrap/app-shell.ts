import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { hasMacPermission } from "../utils/macos-permissions.js";
import path from "path";
import { resolveStellaDataDir } from "../../../runtime/kernel/home/stella-home.js";
import { getDevServerUrl } from "../dev-url.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { PetWindowController } from "../windows/pet-window.js";
import { WindowManager } from "../windows/window-manager.js";
import { TrayController } from "../windows/tray-controller.js";
import { createHmrTransitionController } from "../self-mod/hmr-morph.js";
import { configureNotificationActivationHandling } from "../services/notification-service.js";
import { configureStellaSessionPermissions } from "./session-permissions.js";
import {
  type BootstrapContext,
  getAllWindows,
  getMobileBroadcast,
} from "./context.js";
import { startDeferredStartup } from "./deferred-startup.js";
import { getMainLogger } from "../observability/main-logger.js";

const DEFAULT_STELLA_WEB_URL = "https://stella.sh";

const markDesktopReadyForLauncher = () => {
  const readyFile = process.env.STELLA_ELECTRON_READY_FILE?.trim();
  if (!readyFile) {
    return;
  }

  try {
    mkdirSync(path.dirname(readyFile), { recursive: true });
    writeFileSync(
      readyFile,
      JSON.stringify(
        {
          pid: Number(process.env.STELLA_ELECTRON_DEV_RUNNER_PID || 0) || null,
          readyAt: new Date().toISOString(),
          elapsedMs: Math.round(process.uptime() * 1000),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    getMainLogger()?.process("startup.launcher-ready-marker.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const readStellaWebBaseUrl = () => {
  const raw =
    (
      process.env.STELLA_WEB_URL ??
      process.env.VITE_STELLA_WEB_URL ??
      process.env.STELLA_STORE_WEB_URL ??
      process.env.VITE_STELLA_STORE_WEB_URL ??
      DEFAULT_STELLA_WEB_URL
    ).trim() || DEFAULT_STELLA_WEB_URL;
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return DEFAULT_STELLA_WEB_URL;
  }
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
  const stellaDataDir = await resolveStellaDataDir(
    app,
    config.stellaAppDir,
    config.stellaDataDirPath,
  );

  lifecycle.setStellaAppDir(stellaDataDir.stellaAppDir);
  lifecycle.setStellaDataDir(stellaDataDir.statePath);
  state.stellaAppDir = stellaDataDir.stellaAppDir;
  state.stellaDataDirPath = stellaDataDir.statePath;
  state.stellaWorkspacePath = stellaDataDir.workspacePath;
  services.backupService.start();

  services.securityPolicyService.setSecurityPolicyPath(
    path.join(stellaDataDir.statePath, "security_policy.json"),
  );
};

const initializeWindowShell = (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const preloadPath = path.join(config.electronDir, "preload.js");
  const storeWebPreloadPath = path.join(
    config.electronDir,
    "store-web-preload.js",
  );
  const storeWebBaseUrl = readStellaWebBaseUrl();
  const allowedStoreWebOrigin = storeWebOrigin(storeWebBaseUrl);
  configureStellaSessionPermissions({
    appPartition: config.sessionPartition,
    isDev: config.useDevServer,
    getDevServerUrl,
  });
  configureNotificationActivationHandling(context);

  state.overlayController = new OverlayWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.useDevServer,
    getDevServerUrl,
  });
  state.petController = new PetWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.useDevServer,
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
      storeWebBaseUrl,
      isAllowedStoreWebUrl: (url) =>
        Boolean(
          allowedStoreWebOrigin &&
            storeWebOrigin(url) === allowedStoreWebOrigin,
        ),
      sessionPartition: config.sessionPartition,
      isDev: config.useDevServer,
      getDevServerUrl,
      isAppReady: () => state.appReady,
      externalLinkService: services.externalLinkService,
      onUpdateUiState: (partial) => services.uiStateService.update(partial),
      onMiniHidden: () => services.selectionWatcherService.hideChip(),
      isQuitting: () => state.isQuitting,
      onMinimizeFullToTray: () => state.trayController?.notifyMinimizedToTray(),
    }),
  );

  // Windows keeps Stella alive in the system tray after the user closes the
  // main window. macOS already keeps the app running via the dock, so the
  // tray is Windows-only.
  if (process.platform === "win32") {
    const trayController = new TrayController({
      electronDir: config.electronDir,
      onShowWindow: () => state.windowManager?.showWindow("full"),
      onQuit: () => {
        state.isQuitting = true;
        app.quit();
      },
    });
    trayController.create();
    state.trayController = trayController;
  }

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
  let deferredStartupTriggered = false;
  const triggerDeferredStartup = (trigger: "first-paint" | "fallback") => {
    if (deferredStartupTriggered) {
      return;
    }
    deferredStartupTriggered = true;
    getMainLogger()?.process("startup.deferred-startup.trigger", {
      trigger,
      elapsedMs: Math.round(process.uptime() * 1000),
    });
    void startDeferredStartup(context);
  };

  // The cold-boot deep-link OTT (`stella://auth/callback?ott=…`) sits in
  // `authService.pendingAuthCallback` waiting for the renderer to pull it via
  // `auth:consumePendingCallback`. We deliberately don't rebroadcast on
  // `did-finish-load` — that fires before React commits its first effects,
  // so the renderer-side `auth:callback` listener wasn't necessarily mounted.
  // The renderer pulls explicitly from `AuthDeepLinkHandler` once subscribed.

  if (fullWindow) {
    fullWindow.webContents.once("did-finish-load", () => {
      getMainLogger()?.process("startup.first-paint", {
        elapsedMs: Math.round(process.uptime() * 1000),
      });
      markDesktopReadyForLauncher();
      triggerDeferredStartup("first-paint");
    });
  }

  state.windowManager!.showWindow("full");
  context.state.processRuntime.setManagedTimeout(() => {
    triggerDeferredStartup("fallback");
  }, config.startupFirstPaintFallbackMs);

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
