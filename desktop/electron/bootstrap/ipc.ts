import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerMiniBridgeHandlers } from "../ipc/mini-bridge-handlers.js";
import { registerOverlayStreamHandlers } from "../ipc/overlay-stream-handlers.js";
import { registerProjectHandlers } from "../ipc/project-handlers.js";
import { registerScheduleHandlers } from "../ipc/schedule-handlers.js";
import { registerStoreHandlers } from "../ipc/store-handlers.js";
import { registerSystemHandlers } from "../ipc/system-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { type BootstrapContext, syncWakeWordState } from "./context.js";
import type { BootstrapResetFlows } from "./resets.js";

export const registerBootstrapIpcHandlers = (
  context: BootstrapContext,
  resetFlows: BootstrapResetFlows,
) => {
  const { config, services, state } = context;

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
    getStellaHostRunner: () => state.stellaHostRunner,
    getStellaHomePath: () => state.stellaHomePath,
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
  });

  registerScheduleHandlers({
    schedulerService: state.schedulerService!,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerBrowserHandlers({
    getStellaHomePath: () => state.stellaHomePath,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerProjectHandlers({
    devProjectService: services.devProjectService,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerAgentHandlers({
    getStellaHostRunner: () => state.stellaHostRunner,
    getAppSessionStartedAt: () => state.appSessionStartedAt,
    isHostAuthAuthenticated: () =>
      services.authService.getHostAuthAuthenticated(),
    frontendRoot: config.frontendRoot,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    hmrMorphOrchestrator: state.hmrMorphOrchestrator,
  });

  registerLocalChatHandlers({
    getChatStore: () => state.chatStore,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerOverlayStreamHandlers({
    getStellaHomePath: () => state.stellaHomePath,
    getConvexSiteUrl: () => services.authService.getConvexSiteUrl(),
    getAuthToken: () => services.authService.getAuthToken(),
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerMiniBridgeHandlers({
    miniBridgeService: services.miniBridgeService,
    windowManager: state.windowManager!,
  });

  registerStoreHandlers({
    getStellaHomePath: () => state.stellaHomePath,
    getFrontendRoot: () => config.frontendRoot,
    getStellaHostRunner: () => state.stellaHostRunner,
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
    getStellaHostRunner: () => state.stellaHostRunner,
    getOverlayController: () => state.overlayController,
    getConvexSiteUrl: () => services.authService.getConvexSiteUrl(),
    getAuthToken: () => services.authService.getAuthToken(),
  });
};
