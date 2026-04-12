import { app, session } from "electron";
import { hasMacPermission } from "../utils/macos-permissions.js";
import path from "path";
import { resolveStellaHome } from "../../runtime/kernel/home/stella-home.js";
import { getDevServerUrl } from "../dev-url.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { WindowManager } from "../windows/window-manager.js";
import { createHmrTransitionController } from "../self-mod/hmr-morph.js";
import {
  type BootstrapContext,
  broadcastAuthCallback,
  getAllWindows,
  getMobileBroadcast,
} from "./context.js";
import { startDeferredStartup } from "./deferred-startup.js";

const initializeBootstrapLocalState = async (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const stellaHome = await resolveStellaHome(app);

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

  lifecycle.setWindowManager(
    new WindowManager({
      electronDir: config.electronDir,
      preloadPath,
      sessionPartition: config.sessionPartition,
      isDev: config.isDev,
      getDevServerUrl,
      isAppReady: () => state.appReady,
      externalLinkService: services.externalLinkService,
      onUpdateUiState: (partial) => services.uiStateService.update(partial),
    }),
  );

  services.uiStateService.bind({
    broadcastTarget: {
      getAllWindows: () => getAllWindows(context),
    },
    getOverlayTarget: () =>
      state.overlayController
        ? {
            showVoice: (x, y, mode) =>
              state.overlayController!.showVoice(x, y, mode),
            hideVoice: () => state.overlayController!.hideVoice(),
          }
        : null,
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

  const pendingAuthCallback = services.authService.consumePendingAuthCallback();
  const fullWindow = state.windowManager!.getFullWindow();

  if (pendingAuthCallback && fullWindow) {
    fullWindow.webContents.once("did-finish-load", () => {
      broadcastAuthCallback(context, pendingAuthCallback);
    });
  }

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
    });
  }
};

export const initializeBootstrapAppShell = async (
  context: BootstrapContext,
) => {
  await initializeBootstrapLocalState(context);
  initializeWindowShell(context);
  finalizeWindowLaunch(context);
};
