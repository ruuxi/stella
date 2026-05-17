import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerRuntimeAvailabilityBridge } from "../ipc/runtime-availability-bridge.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerDiscoveryHandlers } from "../ipc/discovery-handlers.js";
import { registerGoogleWorkspaceHandlers } from "../ipc/google-workspace-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerChronicleHandlers } from "../ipc/chronicle-handlers.js";
import { registerDisplayHandlers } from "../ipc/display-handlers.js";
import { registerHomeHandlers } from "../ipc/home-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerMemoryHandlers } from "../ipc/memory-handlers.js";
import { registerMorphHandlers } from "../ipc/morph-handlers.js";
import { registerOnboardingHandlers } from "../ipc/onboarding-handlers.js";
import { registerPetHandlers } from "../ipc/pet-handlers.js";
import { ipcMain } from "electron";
import {
  cleanupPetVoiceSession,
  togglePetVoice,
} from "../services/pet-voice-control.js";
import { WakewordService } from "../services/wakeword-service.js";
import {
  loadLocalPreferences,
  saveLocalPreferences,
} from "../../../runtime/kernel/preferences/local-preferences.js";
import {
  IPC_PREFERENCES_GET_WAKE_WORD,
  IPC_PREFERENCES_SET_WAKE_WORD,
} from "../../src/shared/contracts/ipc-channels.js";
import { registerOfficePreviewHandlers } from "../ipc/office-preview-handlers.js";
import { registerFashionHandlers } from "../ipc/fashion-handlers.js";
import { registerScheduleHandlers } from "../ipc/schedule-handlers.js";
import { registerStoreHandlers } from "../ipc/store-handlers.js";
import { registerSystemHandlers } from "../ipc/system-handlers.js";
import { registerExternalOpenerHandlers } from "../ipc/external-opener-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerUpdatesHandlers } from "../ipc/updates-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { registerDictationHandlers } from "../ipc/dictation-handlers.js";
import { startCapturingHandlers } from "../services/mobile-bridge/handler-registry.js";
import { type BootstrapContext, getMobileBroadcast } from "./context.js";
import type { BootstrapResetFlows } from "./resets.js";
import { startMobileBridge, stopMobileBridge } from "./aux-runtime.js";
import { scheduleGlobalInputHooksAfterAppReady } from "./global-input-hooks.js";
import { randomUUID } from "crypto";
import { showStellaNotification } from "../services/notification-service.js";

const DEFAULT_STORE_WEB_URL = "https://stella.sh/store";

const readStoreWebBaseUrl = () =>
  (
    process.env.STELLA_STORE_WEB_URL ??
    process.env.VITE_STELLA_STORE_WEB_URL ??
    DEFAULT_STORE_WEB_URL
  ).trim() || DEFAULT_STORE_WEB_URL;

const getUrlOrigin = (value: string) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export const registerBootstrapIpcHandlers = (
  context: BootstrapContext,
  resetFlows: BootstrapResetFlows,
) => {
  // Capture all ipcMain.handle registrations for the mobile bridge
  const stopCapturing = startCapturingHandlers();
  const lazyMobileBroadcast = () => getMobileBroadcast(context);
  const { config, lifecycle, services, state } = context;
  const allowedStoreWebOrigin = getUrlOrigin(readStoreWebBaseUrl());
  const dispatchStoreWebLocalAction = (
    action: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> => {
    const fullWindow = state.windowManager?.getFullWindow();
    if (!fullWindow || fullWindow.isDestroyed()) {
      return Promise.reject(new Error("Stella window is unavailable."));
    }
    const requestId = randomUUID();
    const channel = `storeWeb:localActionResult:${requestId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(channel);
        reject(new Error("Timed out waiting for the local Store bridge."));
      }, opts?.timeoutMs ?? 10_000);
      ipcMain.once(channel, (event, payload) => {
        clearTimeout(timeout);
        if (
          !services.externalLinkService.assertPrivilegedSender(event, channel)
        ) {
          reject(new Error("Rejected untrusted Store bridge response."));
          return;
        }
        const result = payload as {
          ok?: boolean;
          result?: unknown;
          error?: string;
        };
        if (result.ok) {
          resolve(result.result ?? null);
        } else {
          reject(new Error(result.error || "Store bridge action failed."));
        }
      });
      fullWindow.webContents.send("storeWeb:localAction", {
        requestId,
        action,
      });
    });
  };

  registerUiHandlers({
    uiState: services.uiStateService.state,
    windowManager: state.windowManager!,
    updateUiState: (partial) => services.uiStateService.update(partial),
    broadcastUiState: () => services.uiStateService.broadcast(),
    setAppReady: (ready) => {
      state.appReady = ready;
      if (ready) {
        scheduleGlobalInputHooksAfterAppReady(context);
      }
    },
    deactivateVoiceModes: () => services.uiStateService.deactivateVoiceModes(),
    syncNativeRadialGesture: () =>
      scheduleGlobalInputHooksAfterAppReady(context),
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  registerCaptureHandlers({
    captureService: services.captureService,
    windowManager: state.windowManager!,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerHomeHandlers({
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerMemoryHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    getController: () => state.chronicleController,
    setController: (controller) => {
      state.chronicleController = controller;
    },
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerChronicleHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    getController: () => state.chronicleController,
    setController: (controller) => {
      state.chronicleController = controller;
    },
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    triggerDreamNow: async () => {
      const stellaRoot = lifecycle.getStellaRoot();
      if (!stellaRoot) {
        return {
          ok: false,
          reason: "no-stella-root",
          pendingThreadSummaries: 0,
          pendingExtensions: 0,
        };
      }
      const runner = lifecycle.getRunner();
      if (!runner) {
        return {
          ok: false,
          reason: "no-runner",
          pendingThreadSummaries: 0,
          pendingExtensions: 0,
        };
      }
      try {
        const result = await runner.triggerDreamNow("manual");
        return { ok: result.scheduled, ...result };
      } catch (error) {
        return {
          ok: false,
          reason: "unavailable",
          pendingThreadSummaries: 0,
          pendingExtensions: 0,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  registerExternalOpenerHandlers({
    externalLinkService: services.externalLinkService,
  });

  registerSystemHandlers({
    getDeviceId: () => state.deviceId,
    authService: services.authService,
    backupService: services.backupService,
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    getStellaRoot: lifecycle.getStellaRoot,
    externalLinkService: services.externalLinkService,
    ensurePrivilegedActionApproval: (action, message, detail, event) =>
      services.securityPolicyService.ensureApproval(
        action,
        message,
        detail,
        event,
      ),
    hardResetLocalState: resetFlows.hardResetLocalState,
    resetLocalMessages: resetFlows.resetLocalMessages,
    shutdownRuntime: resetFlows.shutdownRuntime,
    restartRuntime: resetFlows.restartRuntime,
    submitCredential: (payload) =>
      services.credentialService.submitCredential(payload),
    cancelCredential: (payload) =>
      services.credentialService.cancelCredential(payload),
    submitConnectorCredential: (payload) =>
      services.connectorCredentialService.submitCredential(payload),
    cancelConnectorCredential: (payload) =>
      services.connectorCredentialService.cancelCredential(payload),
    getBroadcastToMobile: lazyMobileBroadcast,
    startPhoneAccessSession: () => {
      startMobileBridge(context);
      return { ok: true };
    },
    stopPhoneAccessSession: async () => {
      await stopMobileBridge(context);
      return { ok: true };
    },
    onPermissionGranted: (kind) => {
      if (kind === "accessibility") {
        scheduleGlobalInputHooksAfterAppReady(context);
      }
    },
    setRadialTriggerKey: (triggerKey) => {
      services.radialGestureService.setRadialTriggerKey(triggerKey);
    },
    setMiniDoubleTapModifier: (modifier) => {
      services.radialGestureService.setMiniDoubleTapModifier(modifier);
    },
    ensureRadialGestureOnMac: () => {
      scheduleGlobalInputHooksAfterAppReady(context);
    },
  });

  registerScheduleHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerBrowserHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerDiscoveryHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerOnboardingHandlers({
    authService: services.authService,
    getDeviceId: () => state.deviceId,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerOfficePreviewHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerDisplayHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerAgentHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    getAppSessionStartedAt: () => state.appSessionStartedAt,
    isHostAuthAuthenticated: () =>
      services.authService.getHostAuthAuthenticated(),
    stellaRoot: config.stellaRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  registerRuntimeAvailabilityBridge({
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
  });

  registerLocalChatHandlers({
    localChatHistoryService: services.localChatHistoryService,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerMorphHandlers({
    windowManager: state.windowManager!,
    getOverlayController: () => state.overlayController,
  });

  registerStoreHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    getStellaHostRunner: lifecycle.getRunner,
    getFullWindow: () => state.windowManager?.getFullWindow() ?? null,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    assertStoreWebSender: (event, channel) => {
      if (state.windowManager?.isStoreWebViewWebContents(event.sender.id)) {
        return true;
      }
      const senderOrigin = getUrlOrigin(
        services.externalLinkService.getSenderUrl(event),
      );
      const trusted = Boolean(
        allowedStoreWebOrigin && senderOrigin === allowedStoreWebOrigin,
      );
      if (!trusted) {
        console.warn(
          `[security] Blocked untrusted Store web IPC ${channel} from ${senderOrigin ?? "unknown"}`,
        );
      }
      return trusted;
    },
    getStoreAuthToken: () => services.authService.getConvexAuthToken(),
    showStoreWebView: (params) => state.windowManager?.showStoreWebView(params),
    hideStoreWebView: () => state.windowManager?.hideStoreWebView(),
    setStoreWebViewLayout: (layout) =>
      state.windowManager?.setStoreWebViewLayout(layout),
    setStoreWebViewTheme: (theme) =>
      state.windowManager?.setStoreWebViewTheme(theme),
    goBackInStoreWebView: () => state.windowManager?.goBackInStoreWebView(),
    goForwardInStoreWebView: () =>
      state.windowManager?.goForwardInStoreWebView(),
    reloadStoreWebView: () => state.windowManager?.reloadStoreWebView(),
    showBlueprintNotification: ({ messageId, name }) => {
      showStellaNotification(
        context,
        {
          id: `store-blueprint-${messageId}`,
          groupId: "stella-store-blueprints",
          groupTitle: "Stella Store",
          title: "Blueprint draft ready",
          body: `${name} is ready to review and publish.`,
        },
        { kind: "store-blueprint", messageId },
      );
    },
    dispatchStoreWebLocalAction,
  });

  registerFashionHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerGoogleWorkspaceHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerUpdatesHandlers({
    getStellaRoot: lifecycle.getStellaRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  const togglePetVoiceImpl = () =>
    togglePetVoice({
      uiStateService: services.uiStateService,
      getPetController: () => state.petController ?? null,
      windowManager: state.windowManager!,
    });
  let wakeword: WakewordService | null = null;
  let wakewordPausedForVoice = services.uiStateService.state.isVoiceRtcActive;
  let wakewordPausedForDictation = false;
  const syncWakewordPause = () => {
    wakeword?.setPaused(wakewordPausedForVoice || wakewordPausedForDictation);
  };

  registerVoiceHandlers({
    uiState: services.uiStateService.state,
    getAppReady: () => state.appReady,
    windowManager: state.windowManager!,
    getPetWindow: () => state.petController?.getWindow() ?? null,
    broadcastUiState: () => services.uiStateService.broadcast(),
    togglePetVoice: togglePetVoiceImpl,
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    getBroadcastToMobile: lazyMobileBroadcast,
    getOverlayController: () => state.overlayController ?? null,
    stellaRoot: state.stellaRoot!,
  });

  // Register dictation first so we can pass `startPetDictation` into
  // the pet handlers — the pet's mic action is dictation now (voice
  // is wake-word driven, not button-driven).
  const dictationPushToTalk = registerDictationHandlers({
    windowManager: state.windowManager!,
    getOverlayController: () => state.overlayController ?? null,
    getStellaRoot: lifecycle.getStellaRoot,
    onDictationActiveChanged: (active) => {
      wakewordPausedForDictation = active;
      syncWakewordPause();
    },
  });
  services.radialGestureService.setDictationPushToTalkHandlers(
    dictationPushToTalk,
  );

  state.petHandlersDispose = registerPetHandlers({
    windowManager: state.windowManager!,
    getPetController: () => state.petController ?? null,
    toggleVoiceRtc: togglePetVoiceImpl,
    startPetDictation: () => dictationPushToTalk.startPetDictation(),
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  // ── Wake-word listener ──────────────────────────────────────────────
  // Spawns the native `wakeword_listener` helper. On a "Hey Stella"
  // detection it activates the realtime voice agent (the same surface
  // the keybind / radial wedge / pet mic button reach via
  // `togglePetVoice`). Mic buttons stay dictation-only — voice is
  // wake-word-gated. Auto-pauses while a voice session is active so
  // the assistant cannot trigger itself.
  const stellaRoot = lifecycle.getStellaRoot();
  const wakePrefs = stellaRoot
    ? loadLocalPreferences(stellaRoot)
    : { wakeWordEnabled: false, wakeWordThreshold: 0.68 };
  wakeword = new WakewordService({
    threshold: wakePrefs.wakeWordThreshold,
    onWake: (event) => {
      if (services.uiStateService.state.isVoiceRtcActive) return;
      console.log(
        `[wakeword] detected "${event.model}" (score=${event.score.toFixed(3)})`,
      );
      togglePetVoiceImpl();
    },
  });
  services.uiStateService.onVoiceActiveChanged((active) => {
    wakewordPausedForVoice = active;
    if (!active) {
      cleanupPetVoiceSession({
        getPetController: () => state.petController ?? null,
        windowManager: state.windowManager!,
      });
    }
    syncWakewordPause();
  });
  syncWakewordPause();
  wakeword.setEnabled(wakePrefs.wakeWordEnabled);
  state.processRuntime.registerCleanup("will-quit", "wakeword-service", () => {
    wakeword?.dispose();
  });

  ipcMain.handle(IPC_PREFERENCES_GET_WAKE_WORD, (event) => {
    if (
      !services.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_WAKE_WORD,
      )
    ) {
      throw new Error("Blocked untrusted preferences:getWakeWord request.");
    }
    const root = lifecycle.getStellaRoot();
    if (!root) return false;
    return loadLocalPreferences(root).wakeWordEnabled;
  });

  ipcMain.handle(IPC_PREFERENCES_SET_WAKE_WORD, (event, enabled: boolean) => {
    if (
      !services.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_SET_WAKE_WORD,
      )
    ) {
      throw new Error("Blocked untrusted preferences:setWakeWord request.");
    }
    const next = enabled === true;
    const root = lifecycle.getStellaRoot();
    if (root) {
      const prefs = loadLocalPreferences(root);
      prefs.wakeWordEnabled = next;
      saveLocalPreferences(root, prefs);
    }
    wakeword.setEnabled(next);
    return { enabled: next };
  });

  stopCapturing();
};
