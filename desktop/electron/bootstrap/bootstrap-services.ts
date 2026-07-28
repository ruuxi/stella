import { BrowserWindow } from "electron";
import path from "path";
import { AuthService } from "../services/auth-service.js";
import { BackupService } from "../services/backup-service.js";
import { CaptureService } from "../services/capture-service.js";
import { RadialGestureService } from "../services/radial-gesture-service.js";
import { togglePetVoice } from "../services/pet-voice-control.js";
import { CredentialService } from "../services/credential-service.js";
import { ConnectorCredentialService } from "../services/connector-credential-service.js";
import { ConnectorConnectService } from "../services/connector-connect-service.js";
import { ExternalLinkService } from "../services/external-link-service.js";
import {
  readConfiguredCanvasShareBaseUrl,
  resolveSharedCanvasPayload,
} from "../services/canvas-share-service.js";
import { isCanvasShareUrl } from "../../../runtime/contracts/canvas-share.js";
import { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { SecurityPolicyService } from "../services/security-policy-service.js";
import { SelectionWatcherService } from "../services/selection-watcher-service.js";
import { UiStateService } from "../services/ui-state-service.js";
import { getDevServerUrl } from "../dev-url.js";
import { hasMacPermission } from "../utils/macos-permissions.js";
import { loadLocalPreferences } from "../../../runtime/kernel/preferences/local-preferences.js";
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
  onSocialInvite: (url: string) => void;
}): BootstrapServices => {
  const { config, lifecycle, state } = options;

  const uiStateService = new UiStateService();
  const externalLinkService = new ExternalLinkService();
  const localChatHistoryService = new LocalChatHistoryService({
    stellaAppDir: config.stellaDataDirPath,
    onUpdated: (payload) => {
      for (const window of options.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send("localChat:updated", payload ?? null);
        }
      }
      options.getMobileBroadcast()?.("localChat:updated", payload ?? null);
    },
    // Mobile-only: desktop windows maintain their own decoration stores from
    // the live stream; the bridge snapshot exists for the phone's benefit.
    onTaskDecorationUpdated: (payload) => {
      options.getMobileBroadcast()?.(
        "localChat:taskDecorationUpdated",
        payload,
      );
    },
  });
  externalLinkService.setDevBuild(config.useDevServer);
  if (config.useDevServer) {
    externalLinkService.trustDevServerBaseUrl(getDevServerUrl());
  } else {
    externalLinkService.trustFileRendererRoot(
      path.resolve(config.electronDir, "../../../dist"),
    );
  }
  // A canvas-share link (`<CANVAS_SHARE_BASE_URL>/c/<slug>`) clicked/opened
  // inside Stella is fetched + materialized in main and pushed to the Canvas
  // panel via the existing `display:update` path, instead of bouncing out to
  // the system browser. Returns true so the external-link funnel skips the
  // browser open. No-ops when the share domain has not been configured.
  externalLinkService.setCanvasShareHandler((url) => {
    const baseUrl = readConfiguredCanvasShareBaseUrl();
    if (!baseUrl || !isCanvasShareUrl(url, baseUrl)) return false;
    void resolveSharedCanvasPayload({
      url,
      baseUrl,
      stellaDataDir: config.stellaDataDirPath,
    })
      .then((payload) => {
        if (!payload) return;
        for (const window of options.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send("display:update", payload);
          }
        }
      })
      .catch(() => {});
    return true;
  });
  const securityPolicyService = new SecurityPolicyService({
    windowManagerTarget: lifecycle,
  });
  let connectorCredentialService: ConnectorCredentialService | null = null;

  // NOTE: setPreventComputerSleep is applied post-appReady in
  // registerBootstrapIpcHandlers (ipc.ts) so the first preferences.json read
  // and the power toggle don't run on the synchronous pre-paint path.

  const authService = new AuthService({
    authProtocol: config.authProtocol,
    isDev: config.isDev,
    projectDir: path.resolve(config.electronDir, "..", ".."),
    sessionPartition: config.sessionPartition,
    runnerTarget: lifecycle,
    onAuthCallback: (url) => {
      if (connectorCredentialService?.handleExternalOAuthCallback(url)) {
        return;
      }
      state.windowManager?.showWindow("full");
      options.onAuthCallback(url);
    },
    onSocialInvite: (url) => {
      // An invite click means the user is heading for the app — surface it
      // before broadcasting so the confirm dialog is actually visible.
      state.windowManager?.showWindow("full");
      options.onSocialInvite(url);
    },
    onSecondInstanceFocus: () => {
      state.windowManager?.getFullWindow()?.focus();
    },
  });

  const credentialService = new CredentialService({
    windowManagerTarget: lifecycle,
    getBroadcastToMobile: () => options.getMobileBroadcast(),
  });

  connectorCredentialService = new ConnectorCredentialService({
    windowManagerTarget: lifecycle,
    getStellaAppDir: () => lifecycle.getStellaDataDir(),
    getConvexAuthToken: () => authService.getConvexAuthToken(),
    getConvexSiteUrl: () => authService.getConvexSiteUrl(),
  });

  const connectorConnectService = new ConnectorConnectService({
    windowManagerTarget: lifecycle,
    getStellaAppDir: () => lifecycle.getStellaDataDir(),
    connectorCredentialService,
    getConvexAuthToken: () => authService.getConvexAuthToken(),
    getConvexSiteUrl: () => authService.getConvexSiteUrl(),
  });

  const captureService = new CaptureService({
    window: {
      getAllWindows: () => options.getAllWindows(),
      showWindow: (target) => state.windowManager?.showWindow(target),
    },
    overlay: {
      startRegionCapture: (options) =>
        state.overlayController?.startRegionCapture(options),
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

  const backupService = new BackupService({
    stellaAppDir: config.stellaAppDir,
    getStellaAppDir: () => state.stellaDataDirPath,
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
      const stellaDataDirPath = state.stellaDataDirPath;
      if (!stellaDataDirPath) return DEFAULT_RADIAL_TRIGGER_CODE;
      return loadLocalPreferences(stellaDataDirPath).radialTriggerKey;
    },
    getMiniDoubleTapModifier: () => {
      const stellaDataDirPath = state.stellaDataDirPath;
      if (!stellaDataDirPath) return "Alt";
      return loadLocalPreferences(stellaDataDirPath).miniDoubleTapModifier;
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
      commitRegionCaptureResult: (result) =>
        captureService.commitRegionCaptureResult(result),
      emptyContext: () => captureService.emptyContext(),
      broadcastChatContext: () => captureService.broadcastChatContext(),
    },
    overlay: {
      showRadial: (opts) => state.overlayController?.showRadial(opts),
      hideRadial: () => state.overlayController?.hideRadial(),
      updateRadialCursor: () => state.overlayController?.updateRadialCursor(),
      getRadialBounds: () => state.overlayController?.getRadialBounds() ?? null,
      setRadialAddIcon: (iconDataUrl) =>
        state.overlayController?.notifyRadialAddIcon(iconDataUrl),
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
    connectorConnectService,
    externalLinkService,
    localChatHistoryService,
    securityPolicyService,
    selectionWatcherService,
    uiStateService,
  };
};
