import type { BrowserWindow } from "electron";
import path from "path";
import { AuthService } from "../services/auth-service.js";
import { BackupService } from "../services/backup-service.js";
import { CaptureService } from "../services/capture-service.js";
import { ContextMenuService } from "../services/context-menu-service.js";
import { CredentialService } from "../services/credential-service.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import { getDevServerUrl } from "../dev-url.js";
import { hasMacPermission } from "../utils/macos-permissions.js";
import type {
  BootstrapConfig,
  BootstrapServices,
  BootstrapState,
  MobileBroadcastFn,
} from "./context.js";
import type { BootstrapLifecycleBindings } from "./lifecycle-bindings.js";

export const createBootstrapServices = (options: {
  config: BootstrapConfig;
  lifecycle: BootstrapLifecycleBindings;
  state: BootstrapState;
  getAllWindows: () => BrowserWindow[];
  getMobileBroadcast: () => MobileBroadcastFn | null;
  onAuthCallback: (url: string) => void;
}): BootstrapServices => {
  const { config, lifecycle, state } = options;

  const uiStateService = new UiStateService();
  const externalLinkService = new ExternalLinkService();
  externalLinkService.setDevBuild(config.isDev);
  if (config.isDev) {
    externalLinkService.trustDevServerBaseUrl(getDevServerUrl());
  }
  const securityPolicyService = new SecurityPolicyService({
    windowManagerTarget: lifecycle,
  });

  const credentialService = new CredentialService({
    windowManagerTarget: lifecycle,
    getBroadcastToMobile: () => options.getMobileBroadcast(),
  });

  const captureService = new CaptureService({
    window: {
      getAllWindows: () => options.getAllWindows(),
      showWindow: (target) => state.windowManager?.showWindow(target),
    },
    overlay: {
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
    projectDir: path.resolve(config.electronDir, "..", ".."),
    sessionPartition: config.sessionPartition,
    runnerTarget: lifecycle,
    onAuthCallback: (url) => {
      state.windowManager?.showWindow("full");
      options.onAuthCallback(url);
    },
    onSecondInstanceFocus: () => {
      state.windowManager?.getFullWindow()?.focus();
    },
  });

  const backupService = new BackupService({
    stellaRoot: config.stellaRoot,
    getStellaRoot: () => state.stellaRoot,
    getRunner: () => lifecycle.getRunner(),
    getAuthToken: () => authService.getAuthToken(),
    getConvexSiteUrl: () => authService.getConvexSiteUrl(),
    getDeviceId: () => state.deviceId,
    processRuntime: state.processRuntime,
  });

  const contextMenuService = new ContextMenuService({
    shouldEnable: () =>
      !uiStateService.state.suppressNativeContextMenuDuringOnboarding &&
      (process.platform !== "darwin" ||
        hasMacPermission("accessibility", false)),
    capture: {
      cancelRadialContextCapture: () =>
        captureService.cancelRadialContextCapture(),
      getChatContextSnapshot: () => captureService.getChatContextSnapshot(),
      setPendingChatContext: (ctx) => captureService.setPendingChatContext(ctx),
      clearTransientContext: () => captureService.clearTransientContext(),
      setRadialContextShouldCommit: (commit) =>
        captureService.setRadialContextShouldCommit(commit),
      setRadialWindowContextEnabled: (enabled) =>
        captureService.setRadialWindowContextEnabled(enabled),
      commitStagedRadialContext: (before) =>
        captureService.commitStagedRadialContext(before),
      hasPendingRadialCapture: () => captureService.hasPendingRadialCapture(),
      captureRadialContext: (x, y, before) =>
        captureService.captureRadialContext(x, y, before),
      waitForRadialContextSettled: () =>
        captureService.waitForRadialContextSettled(),
      getStagedRadialContext: () => captureService.getStagedRadialContext(),
      startRegionCapture: () => captureService.startRegionCapture(),
      emptyContext: () => captureService.emptyContext(),
      broadcastChatContext: () => captureService.broadcastChatContext(),
    },
    window: {
      isCompactMode: () => state.windowManager?.isCompactMode() ?? false,
      getLastActiveWindowMode: () =>
        state.windowManager?.getLastActiveWindowMode() ?? "full",
      isWindowFocused: () => state.windowManager?.isWindowFocused() ?? false,
      showWindow: (target) => state.windowManager?.showWindow(target),
      minimizeWindow: () => state.windowManager?.minimizeWindow(),
      openChatSidebar: (target) => {
        const wm = state.windowManager;
        if (!wm) return;
        const window =
          target === "mini" ? wm.getMiniWindow() : wm.getFullWindow();
        if (!window || window.isDestroyed()) return;
        const send = () => {
          if (!window.isDestroyed()) {
            window.webContents.send("chat:openSidebar");
          }
        };
        if (window.webContents.isLoading()) {
          window.webContents.once("did-finish-load", send);
        } else {
          send();
        }
      },
    },
    updateUiState: (partial) => uiStateService.update(partial),
    pinSidebarSuggestion: (chip) => {
      const wm = state.windowManager;
      if (!wm) return;
      for (const window of wm.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.webContents.send("home:pinSuggestion", { chip });
      }
    },
  });

  return {
    authService,
    backupService,
    captureService,
    contextMenuService,
    credentialService,
    externalLinkService,
    securityPolicyService,
    uiStateService,
  };
};
