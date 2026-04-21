import { registerAgentHandlers } from "../ipc/agent-handlers.js";
import { registerBrowserHandlers } from "../ipc/browser-handlers.js";
import { registerDiscoveryHandlers } from "../ipc/discovery-handlers.js";
import { registerGoogleWorkspaceHandlers } from "../ipc/google-workspace-handlers.js";
import { registerCaptureHandlers } from "../ipc/capture-handlers.js";
import { registerChronicleHandlers } from "../ipc/chronicle-handlers.js";
import { registerDisplayHandlers } from "../ipc/display-handlers.js";
import { registerHomeHandlers } from "../ipc/home-handlers.js";
import { registerLocalChatHandlers } from "../ipc/local-chat-handlers.js";
import { registerMorphHandlers } from "../ipc/morph-handlers.js";
import { registerOnboardingHandlers } from "../ipc/onboarding-handlers.js";
import { registerOfficePreviewHandlers } from "../ipc/office-preview-handlers.js";
import { registerScheduleHandlers } from "../ipc/schedule-handlers.js";
import { registerStoreHandlers } from "../ipc/store-handlers.js";
import { registerSystemHandlers } from "../ipc/system-handlers.js";
import { registerUiHandlers } from "../ipc/ui-handlers.js";
import { registerVoiceHandlers } from "../ipc/voice-handlers.js";
import { startCapturingHandlers } from "../services/mobile-bridge/handler-registry.js";
import {
  type BootstrapContext,
  getMobileBroadcast,
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
    deactivateVoiceModes: () => services.uiStateService.deactivateVoiceModes(),
    syncNativeContextMenu: () => services.contextMenuService.start(),
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
        services.contextMenuService.start();
      }
    },
    ensureContextMenuOnMac: () => {
      services.contextMenuService.start();
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

  registerMorphHandlers({
    windowManager: state.windowManager!,
    getOverlayController: () => state.overlayController,
  });

  registerStoreHandlers({
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

  registerVoiceHandlers({
    uiState: services.uiStateService.state,
    getAppReady: () => state.appReady,
    windowManager: state.windowManager!,
    broadcastUiState: () => services.uiStateService.broadcast(),
    syncVoiceOverlay: () => services.uiStateService.syncVoiceOverlay(),
    getStellaHostRunner: lifecycle.getRunner,
    getBroadcastToMobile: lazyMobileBroadcast,
    getOverlayController: () => state.overlayController ?? null,
  });

  stopCapturing();
};
