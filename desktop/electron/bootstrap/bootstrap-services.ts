import type { BrowserWindow } from "electron";
import path from "path";
import { AuthService } from "../services/auth-service.js";
import { BackupService } from "../services/backup-service.js";
import { CaptureService } from "../services/capture-service.js";
import { CredentialService } from "../services/credential-service.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import { RadialGestureService } from "../services/radial-gesture-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import { getDevServerUrl } from "../dev-url.js";
import { hasMacPermission } from "../utils/macos-permissions.js";
import { loadLocalPreferences } from "../../../runtime/kernel/preferences/local-preferences.js";
import { DEFAULT_RADIAL_TRIGGER_CODE } from "../../src/shared/lib/radial-trigger.js";
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
      hideRadial: () => state.overlayController?.hideRadial(),
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

  const radialGestureService = new RadialGestureService({
    getRadialTriggerKey: () => {
      const stellaRoot = state.stellaRoot;
      if (!stellaRoot) {
        return DEFAULT_RADIAL_TRIGGER_CODE;
      }
      return loadLocalPreferences(stellaRoot).radialTriggerKey;
    },
    shouldEnable: () =>
      !uiStateService.state.suppressNativeRadialDuringOnboarding &&
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
      startRegionCapture: () => captureService.startRegionCapture(),
      emptyContext: () => captureService.emptyContext(),
      broadcastChatContext: () => captureService.broadcastChatContext(),
    },
    overlay: {
      showRadial: (options) =>
        state.overlayController?.showRadial({
          ...options,
          hostWindow:
            state.windowManager?.isFullWindowMacFullscreen() &&
            state.windowManager?.getFullWindow()?.isFocused()
              ? state.windowManager.getFullWindow()
              : null,
        }),
      hideRadial: () => state.overlayController?.hideRadial(),
      updateRadialCursor: () => state.overlayController?.updateRadialCursor(),
      getRadialBounds: () => state.overlayController?.getRadialBounds() ?? null,
    },
    window: {
      isCompactMode: () => state.windowManager?.isCompactMode() ?? false,
      getLastActiveWindowMode: () =>
        state.windowManager?.getLastActiveWindowMode() ?? "full",
      isWindowFocused: () => state.windowManager?.isWindowFocused() ?? false,
      showWindow: (target) => state.windowManager?.showWindow(target),
      minimizeWindow: () => state.windowManager?.minimizeWindow(),
    },
    activateVoiceRtc: () => {
      uiStateService.activateVoiceRtc(uiStateService.state.conversationId);
    },
    deactivateVoiceModes: () => uiStateService.deactivateVoiceModes(),
    isVoiceActive: () => uiStateService.state.isVoiceRtcActive,
    updateUiState: (partial) => uiStateService.update(partial),
  });

  return {
    authService,
    backupService,
    captureService,
    credentialService,
    externalLinkService,
    radialGestureService,
    securityPolicyService,
    uiStateService,
  };
};
