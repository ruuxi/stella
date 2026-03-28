import path from "path";
import { getDevServerUrl } from "../dev-url.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { WindowManager } from "../windows/window-manager.js";
import { createHmrTransitionController } from "../self-mod/hmr-morph.js";
import type { UiStateServiceDeps } from "../services/ui-state-service.js";
import {
  type BootstrapContext,
  getAllWindows,
  getMobileBroadcast,
} from "./context.js";

export const createUiStateServiceDeps = (
  context: BootstrapContext,
): UiStateServiceDeps => {
  const { state } = context;

  return {
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
  };
};

const createOverlayController = (context: BootstrapContext) => {
  const { config } = context;
  const preloadPath = path.join(config.electronDir, "preload.js");

  return new OverlayWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.isDev,
    getDevServerUrl,
  });
};

const createWindowManager = (context: BootstrapContext) => {
  const { config, services, state } = context;
  const preloadPath = path.join(config.electronDir, "preload.js");

  return new WindowManager({
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
  });
};

export const initializeBootstrapWindowShell = (context: BootstrapContext) => {
  context.state.overlayController = createOverlayController(context);
  context.lifecycle.setWindowManager(createWindowManager(context));
  context.services.uiStateService.bind(createUiStateServiceDeps(context));

  context.state.hmrTransitionController = createHmrTransitionController({
    getFullWindow: () => context.state.windowManager?.getFullWindow() ?? null,
    getOverlayController: () => context.state.overlayController,
  });
};
