import { BrowserWindow } from "electron";
import path from "path";
import { AuthService } from "../services/auth-service.js";
import { BackupService } from "../services/backup-service.js";
import { CaptureService } from "../services/capture-service.js";
import { RadialGestureService } from "../services/radial-gesture-service.js";
import { togglePetVoice } from "../services/pet-voice-control.js";
import { CredentialService } from "../services/credential-service.js";
import { ConnectorCredentialService } from "../services/connector-credential-service.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { SelectionWatcherService } from "../services/selection-watcher-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import { getDevServerUrl } from "../dev-url.js";
import { hasMacPermission } from "../utils/macos-permissions.js";
import { loadLocalPreferences } from "../../../runtime/kernel/preferences/local-preferences.js";
import { setPreventComputerSleep } from "../ipc/system-handlers.js";
import { DEFAULT_RADIAL_TRIGGER_CODE } from "../../src/shared/lib/radial-trigger.js";
import type { ChatContext } from "../../../runtime/contracts/index.js";
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
  const localChatHistoryService = new LocalChatHistoryService({
    stellaRoot: config.stellaRoot,
    onUpdated: (payload) => {
      for (const window of options.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send("localChat:updated", payload ?? null);
        }
      }
      options.getMobileBroadcast()?.("localChat:updated", payload ?? null);
    },
  });
  externalLinkService.setDevBuild(config.isDev);
  if (config.isDev) {
    externalLinkService.trustDevServerBaseUrl(getDevServerUrl());
  }
  const securityPolicyService = new SecurityPolicyService({
    windowManagerTarget: lifecycle,
  });

  setPreventComputerSleep(
    loadLocalPreferences(config.stellaRoot).preventComputerSleep,
  );

  const credentialService = new CredentialService({
    windowManagerTarget: lifecycle,
    getBroadcastToMobile: () => options.getMobileBroadcast(),
  });

  const connectorCredentialService = new ConnectorCredentialService({
    windowManagerTarget: lifecycle,
    getStellaRoot: () => lifecycle.getStellaRoot(),
  });

  const captureService = new CaptureService({
    window: {
      getAllWindows: () => options.getAllWindows(),
      showWindow: (target) => state.windowManager?.showWindow(target),
    },
    overlay: {
      startRegionCapture: () => state.overlayController?.startRegionCapture(),
      endRegionCapture: () => state.overlayController?.endRegionCapture(),
      suspendRegionCaptureForScreenshot: () =>
        state.overlayController?.suspendRegionCaptureForScreenshot(),
      restoreRegionCaptureAfterScreenshot: () =>
        state.overlayController?.restoreRegionCaptureAfterScreenshot(),
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

  const setChatContextSelectedText = (text: string) => {
    const baseEmpty: ChatContext = captureService.emptyContext();
    captureService.setPendingChatContext({ ...baseEmpty, selectedText: text });
  };

  const showMiniChatTarget = () => {
    const wm = state.windowManager;
    if (!wm) return;
    wm.showWindow("mini");
    const window = wm.getMiniWindow();
    if (!window || window.isDestroyed()) return;
    const broadcast = () => {
      if (!window.isDestroyed()) {
        captureService.broadcastChatContext();
      }
    };
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", broadcast);
    } else {
      broadcast();
    }
  };

  const selectionWatcherService = new SelectionWatcherService({
    shouldEnable: () =>
      process.platform !== "darwin" || hasMacPermission("accessibility", false),
    overlay: {
      showSelectionChip: (payload) => {
        state.overlayController?.showSelectionChip(payload);
      },
      hideSelectionChip: (requestId) => {
        state.overlayController?.hideSelectionChip(requestId);
      },
    },
    window: {
      isStellaFocused: () => Boolean(BrowserWindow.getFocusedWindow()),
      isMiniWindowVisible: () => state.windowManager?.isMiniShowing() ?? false,
      routeSelectionToSidebar: (text) => {
        setChatContextSelectedText(text);
        showMiniChatTarget();
      },
    },
    capture: captureService,
  });

  const radialGestureService = new RadialGestureService({
    getRadialTriggerKey: () => {
      const stellaRoot = state.stellaRoot;
      if (!stellaRoot) return DEFAULT_RADIAL_TRIGGER_CODE;
      return loadLocalPreferences(stellaRoot).radialTriggerKey;
    },
    getMiniDoubleTapModifier: () => {
      const stellaRoot = state.stellaRoot;
      if (!stellaRoot) return "Alt";
      return loadLocalPreferences(stellaRoot).miniDoubleTapModifier;
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
      mergeRegionCaptureResult: (result) =>
        captureService.mergeRegionCaptureResult(result),
      emptyContext: () => captureService.emptyContext(),
      broadcastChatContext: () => captureService.broadcastChatContext(),
    },
    overlay: {
      showRadial: (opts) => state.overlayController?.showRadial(opts),
      hideRadial: () => state.overlayController?.hideRadial(),
      updateRadialCursor: () => state.overlayController?.updateRadialCursor(),
      getRadialBounds: () => state.overlayController?.getRadialBounds() ?? null,
    },
    window: {
      isCompactMode: () => state.windowManager?.isCompactMode() ?? false,
      getLastActiveWindowMode: () =>
        state.windowManager?.getLastActiveWindowMode() ?? "full",
      getLastFocusedWindowMode: () =>
        state.windowManager?.getLastFocusedWindowMode() ?? "full",
      isMiniShowing: () => state.windowManager?.isMiniShowing() ?? false,
      isMiniAlwaysOnTop: () => state.windowManager?.isMiniAlwaysOnTop() ?? true,
      isWindowFocused: () => state.windowManager?.isWindowFocused() ?? false,
      isShellWindowVisible: (target) =>
        state.windowManager?.isShellWindowVisible(target) ?? false,
      isShellWindowFocused: (target) =>
        state.windowManager?.isShellWindowFocused(target) ?? false,
      showWindow: (target) => state.windowManager?.showWindow(target),
      restoreWindowVisibility: (target) =>
        state.windowManager?.restoreWindowVisibility(target),
      minimizeWindow: () => state.windowManager?.minimizeWindow(),
      hideMiniWindow: () => state.windowManager?.hideMiniWindow(false),
    },
    togglePetVoice: () => {
      // Resolve lazily — the pet controller is constructed in
      // app-shell after this options bag is built. Inlining the
      // toggle here keeps it scoped to this single radial dep
      // without exporting more bootstrap state.
      const wm = state.windowManager;
      if (!wm) return;
      togglePetVoice({
        uiStateService,
        getPetController: () => state.petController ?? null,
        windowManager: wm,
      });
    },
    updateUiState: (partial) => uiStateService.update(partial),
    // Forward every left-mouse-up to the SelectionWatcher so it can ask the
    // native helper for the current selection and pop the "Ask Stella" pill.
    onLeftMouseUp: (event) => {
      selectionWatcherService.handleLeftMouseUp(event);
    },
  });

  return {
    authService,
    backupService,
    captureService,
    radialGestureService,
    credentialService,
    connectorCredentialService,
    externalLinkService,
    localChatHistoryService,
    securityPolicyService,
    selectionWatcherService,
    uiStateService,
  };
};
