import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerGoogleWorkspaceHandlers } from "../ipc/google-workspace-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerMiniBridgeHandlers } from "../ipc/mini-bridge-handlers.js";
import { registerMorphHandlers } from "../ipc/morph-handlers.js";
import { registerOnboardingHandlers } from "../ipc/onboarding-handlers.js";
import { registerOfficePreviewHandlers } from "../ipc/office-preview-handlers.js";
import { registerProjectHandlers } from "../ipc/project-handlers.js";
import { registerScheduleHandlers } from "../ipc/schedule-handlers.js";
import { registerStoreHandlers } from "../ipc/store-handlers.js";
import { registerSystemHandlers } from "../ipc/system-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { startCapturingHandlers } from "../services/mobile-bridge/handler-registry.js";
import {
  type BootstrapContext,
  getMobileBroadcast,
  syncWakeWordState,
} from "./context.js";
import type { BootstrapResetFlows } from "./resets.js";
import { startMobileBridge, stopMobileBridge } from "./aux-runtime.js";

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
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    getStellaHomePath: lifecycle.getStellaHomePath,
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
    startPhoneAccessSession: () => {
      startMobileBridge(context);
      return { ok: true };
    },
    stopPhoneAccessSession: async () => {
      await stopMobileBridge(context);
      return { ok: true };
    },
    setRadialTriggerKey: (triggerKey) => {
      services.radialGestureService.setRadialTriggerKey(triggerKey);
    },
  });

  registerScheduleHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerBrowserHandlers({
    getStellaHomePath: lifecycle.getStellaHomePath,
    getFrontendRoot: () => config.frontendRoot,
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

  registerProjectHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
  });

  registerOfficePreviewHandlers({
    getStellaHomePath: lifecycle.getStellaHomePath,
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
    hmrTransitionController: state.hmrTransitionController,
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  registerLocalChatHandlers({
    getStellaHostRunner: lifecycle.getRunner,
    onStellaHostRunnerChanged: lifecycle.onRunnerChanged,
    assertPrivilegedSender: (event, channel) =>
      services.externalLinkService.assertPrivilegedSender(event, channel),
    getBroadcastToMobile: lazyMobileBroadcast,
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
    getBroadcastToMobile: lazyMobileBroadcast,
  });

  stopCapturing();
};
