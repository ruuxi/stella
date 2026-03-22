import { BrowserWindow } from "electron";
import path from "path";
import { OverlayWindowController } from "../windows/overlay-window.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { AuthService } from "../services/auth-service.js";
import { CaptureService } from "../services/capture-service.js";
import { CredentialService } from "../services/credential-service.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import { MiniBridgeService } from "../services/mini-bridge-service.js";
import { RadialGestureService } from "../services/radial-gesture-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import type { WakeWordController } from "../wake-word/initialize.js";
import { WindowManager } from "../windows/window-manager.js";
import { createHmrTransitionController } from "../self-mod/hmr-morph.js";
import type { MobileBridgeService } from "../services/mobile-bridge/service.js";
import type { DevToolServer } from "../devtool/dev-server.js";
import { BootstrapLifecycleBindings } from "./lifecycle-bindings.js";
import { getDevServerUrl } from "../dev-url.js";
import type { LocalDevProjectRecord } from "../../packages/boundary-contracts/index.js";

export type MobileBroadcastFn = (channel: string, data: unknown) => void;

export type BootstrapConfig = {
  authProtocol: string;
  electronDir: string;
  frontendRoot: string;
  hardResetMutableHomePaths: readonly string[];
  isDev: boolean;
  sessionPartition: string;
  startupStageDelayMs: number;
};

export type BootstrapState = {
  appReady: boolean;
  appSessionStartedAt: number;
  deferredStartupSequence: Promise<void> | null;
  deviceId: string | null;
  hmrTransitionController: ReturnType<typeof createHmrTransitionController> | null;
  isQuitting: boolean;
  devProjectsUpdateUnsubscribe: (() => void) | null;
  localChatUpdateUnsubscribe: (() => void) | null;
  overlayController: OverlayWindowController | null;
  scheduleUpdateUnsubscribe: (() => void) | null;
  stellaHomePath: string | null;
  stellaWorkspacePath: string | null;
  stellaHostRunner: StellaHostRunner | null;
  wakeWordController: WakeWordController | null;
  mobileBridgeService: MobileBridgeService | null;
  devToolServer: DevToolServer | null;
  windowManager: WindowManager | null;
};

export type BootstrapServices = {
  authService: AuthService;
  captureService: CaptureService;
  credentialService: CredentialService;
  externalLinkService: ExternalLinkService;
  miniBridgeService: MiniBridgeService;
  radialGestureService: RadialGestureService;
  securityPolicyService: SecurityPolicyService;
  uiStateService: UiStateService;
};

export type BootstrapContext = {
  config: BootstrapConfig;
  lifecycle: BootstrapLifecycleBindings;
  services: BootstrapServices;
  state: BootstrapState;
};

/**
 * Retrieve the mobile bridge broadcast function from context.
 * Returns null if the bridge service hasn't started yet.
 */
export const getMobileBroadcast = (
  context: BootstrapContext,
): MobileBroadcastFn | null => {
  return context.state.mobileBridgeService?.broadcastToMobile ?? null;
};

const getAllWindows = (context: BootstrapContext) =>
  context.state.windowManager
    ? context.state.windowManager.getAllWindows()
    : BrowserWindow.getAllWindows();

export const forEachWindow = (
  context: BootstrapContext,
  callback: (window: BrowserWindow) => void,
) => {
  for (const window of getAllWindows(context)) {
    if (!window.isDestroyed()) {
      callback(window);
    }
  }
};

export const broadcastAuthCallback = (
  context: BootstrapContext,
  url: string,
) => {
  forEachWindow(context, (window) => {
    window.webContents.send("auth:callback", { url });
  });
  getMobileBroadcast(context)?.("auth:callback", { url });
};

export const broadcastLocalChatUpdated = (context: BootstrapContext) => {
  forEachWindow(context, (window) => {
    window.webContents.send("localChat:updated");
  });
  getMobileBroadcast(context)?.("localChat:updated", null);
};

export const broadcastScheduleUpdated = (context: BootstrapContext) => {
  forEachWindow(context, (window) => {
    window.webContents.send("schedule:updated");
  });
  getMobileBroadcast(context)?.("schedule:updated", null);
};

export const broadcastWakeWordState = (context: BootstrapContext) => {
  const enabled = context.state.wakeWordController?.getEnabled() ?? false;

  forEachWindow(context, (window) => {
    window.webContents.send("voice:wakeWordState", { enabled });
  });
  getMobileBroadcast(context)?.("voice:wakeWordState", { enabled });
};

export const broadcastDevProjectsChanged = (
  context: BootstrapContext,
  projects: LocalDevProjectRecord[],
) => {
  for (const window of getAllWindows(context)) {
    if (!window.isDestroyed()) {
      window.webContents.send("projects:changed", projects);
    }
  }
  getMobileBroadcast(context)?.("projects:changed", projects);
};

export const syncWakeWordState = (context: BootstrapContext) => {
  const enabled = context.state.wakeWordController?.syncState() ?? false;

  forEachWindow(context, (window) => {
    window.webContents.send("voice:wakeWordState", { enabled });
  });

  return enabled;
};

export const createBootstrapContext = (
  config: BootstrapConfig,
): BootstrapContext => {
  const state: BootstrapState = {
    appReady: false,
    appSessionStartedAt: Date.now(),
    deferredStartupSequence: null,
    deviceId: null,
    devProjectsUpdateUnsubscribe: null,
    hmrTransitionController: null,
    isQuitting: false,
    localChatUpdateUnsubscribe: null,
    overlayController: null,
    scheduleUpdateUnsubscribe: null,
    stellaHomePath: null,
    stellaWorkspacePath: null,
    stellaHostRunner: null,
    wakeWordController: null,
    mobileBridgeService: null,
    devToolServer: null,
    windowManager: null,
  };

  const lifecycle = new BootstrapLifecycleBindings(state);
  const context = { config, lifecycle, state } as BootstrapContext;

  const uiStateService = new UiStateService();
  const externalLinkService = new ExternalLinkService();
  externalLinkService.setDevBuild(config.isDev);
  if (config.isDev) {
    externalLinkService.trustDevServerBaseUrl(getDevServerUrl());
  }
  const miniBridgeService = new MiniBridgeService();

  const securityPolicyService = new SecurityPolicyService({
    windowManagerTarget: lifecycle,
  });

  const credentialService = new CredentialService({
    windowManagerTarget: lifecycle,
    getBroadcastToMobile: () => getMobileBroadcast(context),
  });

  const captureService = new CaptureService({
    window: {
      getAllWindows: () =>
        state.windowManager
          ? state.windowManager.getAllWindows()
          : BrowserWindow.getAllWindows(),
      getMiniWindow: () => state.windowManager?.getMiniWindow() ?? null,
      isMiniShowing: () => state.windowManager?.isMiniShowing() ?? false,
      showWindow: (target) => state.windowManager?.showWindow(target),
      concealMiniWindowForCapture: () =>
        state.windowManager?.concealMiniWindowForCapture() ?? false,
      restoreMiniWindowAfterCapture: () => {
        state.windowManager?.restoreMiniWindowAfterCapture();
      },
    },
    overlay: {
      hideRadial: () => state.overlayController?.hideRadial(),
      hideModifierBlock: () => state.overlayController?.hideModifierBlock(),
      startRegionCapture: () => state.overlayController?.startRegionCapture(),
      endRegionCapture: () => state.overlayController?.endRegionCapture(),
      getOverlayBounds: () =>
        state.overlayController?.getWindow()?.getBounds() ?? null,
    },
    updateUiState: (partial) => uiStateService.update(partial),
  });

  const authService = new AuthService({
    authProtocol: config.authProtocol,
    isDev: config.isDev,
    projectDir: path.resolve(config.electronDir, ".."),
    sessionPartition: config.sessionPartition,
    runnerTarget: lifecycle,
    onAuthCallback: (url) => {
      state.windowManager?.showWindow("full");
      broadcastAuthCallback(context, url);
    },
    onSecondInstanceFocus: () => {
      state.windowManager?.getFullWindow()?.focus();
    },
  });

  const radialGestureService = new RadialGestureService({
    isAppReady: () => state.appReady,
    capture: {
      cancelRadialContextCapture: () =>
        captureService.cancelRadialContextCapture(),
      getChatContextSnapshot: () => captureService.getChatContextSnapshot(),
      setPendingChatContext: (ctx) => captureService.setPendingChatContext(ctx),
      clearTransientContext: () => captureService.clearTransientContext(),
      setRadialContextShouldCommit: (commit) =>
        captureService.setRadialContextShouldCommit(commit),
      commitStagedRadialContext: (before) =>
        captureService.commitStagedRadialContext(before),
      hasPendingRadialCapture: () => captureService.hasPendingRadialCapture(),
      captureRadialContext: (x, y, before) =>
        captureService.captureRadialContext(x, y, before),
      startRegionCapture: () => captureService.startRegionCapture(),
      captureAutoWindowText: () => captureService.captureAutoWindowText(),
      emptyContext: () => captureService.emptyContext(),
      broadcastChatContext: () => captureService.broadcastChatContext(),
    },
    overlay: {
      showModifierBlock: () => state.overlayController?.showModifierBlock(),
      hideModifierBlock: () => state.overlayController?.hideModifierBlock(),
      showRadial: () => state.overlayController?.showRadial(),
      hideRadial: () => state.overlayController?.hideRadial(),
      updateRadialCursor: () => state.overlayController?.updateRadialCursor(),
      getRadialBounds: () => state.overlayController?.getRadialBounds() ?? null,
      showAutoPanel: (data) => state.overlayController?.showAutoPanel(data),
      hideAutoPanel: () => state.overlayController?.hideAutoPanel(),
    },
    window: {
      isMiniShowing: () => state.windowManager?.isMiniShowing() ?? false,
      hasPendingMiniShow: () =>
        state.windowManager?.hasPendingMiniShow() ?? false,
      getMiniWindow: () => state.windowManager?.getMiniWindow() ?? null,
      showWindow: (target) => state.windowManager?.showWindow(target),
      hideMiniWindow: (animate) => state.windowManager?.hideMiniWindow(animate),
      concealMiniWindowForCapture: () =>
        state.windowManager?.concealMiniWindowForCapture() ?? false,
      restoreMiniWindowAfterCapture: () =>
        state.windowManager?.restoreMiniWindowAfterCapture(),
    },
    updateUiState: (partial) => uiStateService.update(partial),
  });

  context.services = {
    authService,
    captureService,
    credentialService,
    externalLinkService,
    miniBridgeService,
    radialGestureService,
    securityPolicyService,
    uiStateService,
  };

  return context;
};
