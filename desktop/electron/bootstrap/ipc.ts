import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerRuntimeAvailabilityBridge } from "../ipc/runtime-availability-bridge.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerDiscoveryHandlers } from "../ipc/discovery-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerChronicleHandlers } from "../ipc/chronicle-handlers.js";
import { registerMeetingCaptureHandlers } from "../ipc/meeting-capture-handlers.js";
import { registerDisplayHandlers } from "../ipc/display-handlers.js";
import { registerHomeHandlers } from "../ipc/home-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerMobileHelloHandlers } from "../ipc/mobile-hello-handlers.js";
import { registerMemoryHandlers } from "../ipc/memory-handlers.js";
import { registerMigrationHandlers } from "../ipc/migration-handlers.js";
import { registerMorphHandlers } from "../ipc/morph-handlers.js";
import { registerNativeIntegrationHandlers } from "../ipc/native-integration-handlers.js";
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
import {
  registerSystemHandlers,
  setPreventComputerSleep,
} from "../ipc/system-handlers.js";
import { registerExternalOpenerHandlers } from "../ipc/external-opener-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerUiStateKvHandlers } from "../ipc/ui-state-handlers.js";
import { registerUpdatesHandlers } from "../ipc/updates-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { registerDictationHandlers } from "../ipc/dictation-handlers.js";
import { startCapturingHandlers } from "../services/mobile-bridge/handler-registry.js";
import {
  type BootstrapContext,
  getAllWindows,
  getMobileBroadcast,
} from "./context.js";
import type { BootstrapResetFlows } from "./resets.js";
import {
  startMobileBridge,
  startStellaBrowserBridge,
  stopMobileBridge,
} from "./aux-runtime.js";
import { isBrowserBridgeEagerStartWorthwhile } from "../services/stella-browser-bridge-service.js";
import { scheduleGlobalInputHooksAfterAppReady } from "./global-input-hooks.js";
import { randomUUID } from "crypto";
import { startOfficePreviewBridge } from "./office-preview-bridge.js";

const DEFAULT_STORE_WEB_URL = "https://stella.sh/store";
// Delay native-service startup ~4s past app-ready so the bridge/office-preview
// spawns stay off the first-paint (TTI) path. Previously Windows-only; now
// applied on all platforms.
const POST_READY_NATIVE_DELAY_MS = 4_000;

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
  let postReadyNativeServicesScheduled = false;

  const schedulePostReadyNativeServices = () => {
    if (postReadyNativeServicesScheduled) {
      return;
    }
    postReadyNativeServicesScheduled = true;
    // Keep native-service startup off the TTI path on every platform. Windows
    // already deferred ~4s post-paint; apply the same delay on macOS/Linux so
    // the bridge spawn never competes with first paint.
    state.processRuntime.setManagedTimeout(() => {
      postReadyNativeServicesScheduled = false;
      if (!state.appReady || state.isQuitting) {
        return;
      }
      // Only spawn the browser-bridge daemon when a cheap precondition says the
      // user actually uses browser automation (host already registered, or the
      // extension is installed). Spawning unconditionally launched an extra
      // Electron-as-Node process that, for users without the extension, just
      // retried with backoff before failing — pure startup cost. Users who DO
      // have the extension still get the bridge; first-time setup picks it up on
      // the next launch once the extension/host registration is detected.
      if (isBrowserBridgeEagerStartWorthwhile()) {
        startStellaBrowserBridge(context);
      }
      if (!state.officePreviewBridgeStop) {
        state.officePreviewBridgeStop = startOfficePreviewBridge(context);
      }
    }, POST_READY_NATIVE_DELAY_MS);
  };

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
        // Apply the preventComputerSleep power toggle here rather than during
        // synchronous bootstrap — it's not needed for the window to appear and
        // forces the first preferences.json read off the pre-paint path.
        setPreventComputerSleep(
          loadLocalPreferences(config.stellaDataDirPath).preventComputerSleep,
        );
        scheduleGlobalInputHooksAfterAppReady(context);
        schedulePostReadyNativeServices();
      }
    },
    deactivateVoiceModes: () => services.uiStateService.deactivateVoiceModes(),
    syncNativeRadialGesture: () =>
      scheduleGlobalInputHooksAfterAppReady(context),
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  state.uiStateKvStore = registerUiStateKvHandlers({
    stellaDataDirPath: state.stellaDataDirPath ?? config.stellaDataDirPath,
    getAllWindows: () => getAllWindows(context),
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
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
    getController: () => state.chronicleController,
    setController: (controller) => {
      state.chronicleController = controller;
    },
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerMigrationHandlers({
    getStellaDataDir: lifecycle.getStellaDataDir,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerChronicleHandlers({
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
    getController: () => state.chronicleController,
    setController: (controller) => {
      state.chronicleController = controller;
    },
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    triggerDreamNow: async () => {
      const stellaAppDir = lifecycle.getStellaAppDir();
      if (!stellaAppDir) {
        return {
          ok: false,
          reason: "no-stella-root",
          pendingItems: 0,
        };
      }
      const runner = lifecycle.getRunner();
      if (!runner) {
        return {
          ok: false,
          reason: "no-runner",
          pendingItems: 0,
        };
      }
      try {
        const result = await runner.triggerDreamNow("manual");
        return { ok: result.scheduled, ...result };
      } catch (error) {
        return {
          ok: false,
          reason: "unavailable",
          pendingItems: 0,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  registerMeetingCaptureHandlers({
    getStellaDataDir: lifecycle.getStellaDataDir,
    getController: () => state.meetingCaptureController,
    setController: (controller) => {
      state.meetingCaptureController = controller;
    },
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
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
    getStellaAppDir: lifecycle.getStellaDataDir,
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
    respondConnectorConnect: (payload) =>
      services.connectorConnectService.respond(payload),
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
    stopGlobalInputHooksForPermissionReset: () => {
      services.radialGestureService.stop();
      services.selectionWatcherService.stop();
      state.globalInputHooksStarted = false;
      state.globalInputHooksStartScheduled = false;
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
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    // On-demand fallback to the eager startup gate: if the extension wasn't
    // detected at launch (installed mid-session, or in a custom user-data-dir),
    // the first browser-session fetch still starts the bridge. Idempotent —
    // reuses the existing resource if already running.
    ensureBrowserBridgeStarted: () => startStellaBrowserBridge(context),
  });

  registerDiscoveryHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
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
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
    localChatHistoryService: services.localChatHistoryService,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerDisplayHandlers({
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
    localChatHistoryService: services.localChatHistoryService,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerAgentHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    getAppSessionStartedAt: () => state.appSessionStartedAt,
    isHostAuthAuthenticated: () =>
      services.authService.getHostAuthAuthenticated(),
    stellaAppDir: config.stellaAppDir,
    localChatHistoryService: services.localChatHistoryService,
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

  registerMobileHelloHandlers({
    localChatHistoryService: services.localChatHistoryService,
    getActiveConversationId: () => services.uiStateService.state.conversationId,
    getUiStateSnapshot: () => state.uiStateKvStore?.snapshot() ?? {},
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerMorphHandlers({
    windowManager: state.windowManager!,
    getOverlayController: () => state.overlayController,
  });

  registerStoreHandlers({
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
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
    getStoreWebEmbedConfig: () =>
      state.windowManager?.getStoreWebEmbedConfig() ?? null,
    dispatchStoreWebLocalAction,
  });

  registerFashionHandlers({
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerNativeIntegrationHandlers({
    getStellaAppDir: lifecycle.getStellaDataDir,
    requestPreregisteredOAuth: (payload) =>
      services.connectorCredentialService.requestPreregisteredOAuth(payload),
    requestDeviceOAuth: (payload) =>
      services.connectorCredentialService.requestDeviceOAuth(payload),
    requestExternalOAuthApproval: (payload) =>
      services.connectorCredentialService.requestExternalOAuthApproval(payload),
    getConvexAuthToken: () => services.authService.getConvexAuthToken(),
    getConvexSiteUrl: () => services.authService.getConvexSiteUrl(),
    disconnectGoogleWorkspace: async () => {
      const runner = lifecycle.getRunner();
      if (!runner) return { ok: false };
      return await runner.googleWorkspaceDisconnect();
    },
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerUpdatesHandlers({
    getStellaAppDir: lifecycle.getStellaAppDir,
    getStellaDataDir: lifecycle.getStellaDataDir,
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
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
    stellaAppDir: state.stellaAppDir!,
    stellaDataDirPath: state.stellaDataDirPath!,
  });

  // Register dictation first so we can pass `startPetDictation` into
  // the pet handlers — the pet's mic action is dictation now (voice
  // is wake-word driven, not button-driven).
  const dictationPushToTalk = registerDictationHandlers({
    windowManager: state.windowManager!,
    getOverlayController: () => state.overlayController ?? null,
    getStellaAppDir: lifecycle.getStellaDataDir,
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
  // Defer both the preferences.json read AND the enable/spawn off the pre-paint
  // IPC-registration path. The synchronous statSync+readFileSync that fed the
  // listener threshold used to run before first paint; loading prefs here keeps
  // that disk read off the TTI path. The threshold is only consumed by
  // WakewordService at spawn time, so constructing the service here loses
  // nothing. For "Hey Stella" users `setEnabled(true)` synchronously spawns the
  // native wakeword_listener helper (ONNX model load + mic open), which we don't
  // want blocking first paint either. setEnabled is idempotent and
  // timing-tolerant.
  state.processRuntime.setManagedTimeout(() => {
    const stellaDataDir = lifecycle.getStellaDataDir();
    const wakePrefs = stellaDataDir
      ? loadLocalPreferences(stellaDataDir)
      : { wakeWordEnabled: false, wakeWordThreshold: 0.6 };
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
    // Inherit any pause state accumulated (voice/dictation) during the deferral
    // gap before applying the persisted enabled preference.
    syncWakewordPause();
    wakeword.setEnabled(wakePrefs.wakeWordEnabled);
  }, 0);
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
    const root = lifecycle.getStellaDataDir();
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
    const root = lifecycle.getStellaDataDir();
    if (root) {
      const prefs = loadLocalPreferences(root);
      prefs.wakeWordEnabled = next;
      saveLocalPreferences(root, prefs);
    }
    // Null-safe: the listener is now constructed in a deferred post-registration
    // task. The persisted preference above is the source of truth, so a toggle
    // that lands before construction is honored when the deferred setEnabled
    // runs; `?.` only guards the (renderer-not-yet-painted) startup race.
    wakeword?.setEnabled(next);
    return { enabled: next };
  });

  stopCapturing();
};
