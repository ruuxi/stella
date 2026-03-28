import { app } from "electron";
import path from "path";
import { getDevServerUrl } from "../dev-url.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { resolveStellaHome } from "../../packages/runtime-kernel/home/stella-home.js";
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

  lifecycle.setStellaHomePath(stellaHome.homePath);
  state.stellaHomePath = stellaHome.homePath;
  state.stellaWorkspacePath = stellaHome.workspacePath;

  services.securityPolicyService.setSecurityPolicyPath(
    path.join(stellaHome.statePath, "security_policy.json"),
  );
};

const bindUiStateTargets = (context: BootstrapContext) => {
  const { services, state } = context;

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
};

const initializeWindowControllers = (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const preloadPath = path.join(config.electronDir, "preload.js");

  state.overlayController = new OverlayWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.isDev,
    getDevServerUrl,
  });

  lifecycle.setWindowManager(new WindowManager({
    electronDir: config.electronDir,
    preloadPath,
    sessionPartition: config.sessionPartition,
    isDev: config.isDev,
    getDevServerUrl,
    isAppReady: () => state.appReady,
    isQuitting: () => state.isQuitting,
    externalLinkService: services.externalLinkService,
    miniBridgeService: services.miniBridgeService,
    chatContextSyncBridge: {
      getChatContextVersion: () =>
        services.captureService.getChatContextVersion(),
      getLastBroadcastChatContextVersion: () =>
        services.captureService.getLastBroadcastChatContextVersion(),
      broadcastChatContext: () =>
        services.captureService.broadcastChatContext(),
      waitForMiniChatContext: (version: number) =>
        services.captureService.waitForMiniChatContext(version),
    },
    onDeactivateVoiceModes: () =>
      services.uiStateService.deactivateVoiceModes(),
    onUpdateUiState: (partial) => services.uiStateService.update(partial),
    getOverlayController: () => state.overlayController,
  }));

  bindUiStateTargets(context);
};

const initializeUiServerAndSelfMod = (context: BootstrapContext) => {
  const { state } = context;

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
};

export const initializeBootstrapAppShell = async (
  context: BootstrapContext,
) => {
  await initializeBootstrapLocalState(context);
  initializeWindowControllers(context);
  initializeUiServerAndSelfMod(context);
  finalizeWindowLaunch(context);
};
