import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerMiniBridgeHandlers } from "../ipc/mini-bridge-handlers.js";
import { registerMorphHandlers } from "../ipc/morph-handlers.js";
import { registerOverlayStreamHandlers } from "../ipc/overlay-stream-handlers.js";
import { registerProjectHandlers } from "../ipc/project-handlers.js";
import { registerScheduleHandlers } from "../ipc/schedule-handlers.js";
import { registerStoreHandlers } from "../ipc/store-handlers.js";
import { registerSystemHandlers } from "../ipc/system-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { startCapturingHandlers } from "../services/mobile-bridge/handler-registry.js";
import { type BootstrapContext, getMobileBroadcast, syncWakeWordState } from "./context.js";
import type { BootstrapResetFlows } from "./resets.js";

export const registerBootstrapIpcHandlers = (
  context: BootstrapContext,
  resetFlows: BootstrapResetFlows,
) => {
  // Capture all ipcMain.handle registrations for the mobile bridge
  const stopCapturing = startCapturingHandlers();
  const lazyMobileBroadcast = () => getMobileBroadcast(context);
  const { config, lifecycle, services, state } = context;

  registerUiHandlers({
    uiState: services.uiStateService.state,
    windowManager: state.windowManager!,
    updateUiState: (partial) => services.uiStateService.update(partial),
    broadcastUiState: () => services.uiStateService.broadcast(),
    syncVoiceOverlay: () => services.uiStateService.syncVoiceOverlay(),
    setAppReady: (ready) => {
      state.appReady = ready;
    },
    getResumeWakeWordCapture: () =>
      services.uiStateService.getResumeWakeWordCapture(),
    scheduleResumeWakeWord: () =>
      services.uiStateService.scheduleResumeWakeWord(),
    deactivateVoiceModes: () => services.uiStateService.deactivateVoiceModes(),
    syncWakeWordState: () => syncWakeWordState(context),
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

  registerSystemHandlers({
    getDeviceId: () => state.deviceId,
    authService: services.authService,
    getStellaHostRunner: lifecycle.getRunner,
    getStellaHomePath: lifecycle.getStellaHomePath,
    socialSessionService: services.socialSessionService,
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
    submitCredential: (payload) =>
      services.credentialService.submitCredential(payload),
    cancelCredential: (payload) =>
      services.credentialService.cancelCredential(payload),
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  registerScheduleHandlers({
    schedulerService: state.schedulerService!,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  registerBrowserHandlers({
    getStellaHomePath: lifecycle.getStellaHomePath,
    getFrontendRoot: () => config.frontendRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerProjectHandlers({
    devProjectService: services.devProjectService,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerAgentHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    getAppSessionStartedAt: () => state.appSessionStartedAt,
    isHostAuthAuthenticated: () =>
      services.authService.getHostAuthAuthenticated(),
    frontendRoot: config.frontendRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    hmrMorphOrchestrator: state.hmrMorphOrchestrator,
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  registerLocalChatHandlers({
    getChatStore: () => state.chatStore,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  registerOverlayStreamHandlers({
    getStellaHomePath: lifecycle.getStellaHomePath,
    getConvexSiteUrl: () => services.authService.getConvexSiteUrl(),
    getAuthToken: () => services.authService.getAuthToken(),
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerMiniBridgeHandlers({
    miniBridgeService: services.miniBridgeService,
    windowManager: state.windowManager!,
  });

  registerMorphHandlers({
    windowManager: state.windowManager!,
    getOverlayController: () => state.overlayController,
  });

  registerStoreHandlers({
    getStellaHomePath: lifecycle.getStellaHomePath,
    getFrontendRoot: () => config.frontendRoot,
    getStellaHostRunner: lifecycle.getRunner,
    getStoreModService: () => state.storeModService,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerVoiceHandlers({
    uiState: services.uiStateService.state,
    getAppReady: () => state.appReady,
    windowManager: state.windowManager!,
    broadcastUiState: () => services.uiStateService.broadcast(),
    scheduleResumeWakeWord: () =>
      services.uiStateService.scheduleResumeWakeWord(),
    syncVoiceOverlay: () => services.uiStateService.syncVoiceOverlay(),
    syncWakeWordState: () => syncWakeWordState(context),
    getWakeWordEnabled: () => state.wakeWordController?.getEnabled() ?? false,
    pushWakeWordAudio: (pcm) => state.wakeWordController?.pushAudioChunk(pcm),
    getStellaHostRunner: lifecycle.getRunner,
    getOverlayController: () => state.overlayController,
    getConvexSiteUrl: () => services.authService.getConvexSiteUrl(),
    getAuthToken: () => services.authService.getAuthToken(),
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  stopCapturing();
};
