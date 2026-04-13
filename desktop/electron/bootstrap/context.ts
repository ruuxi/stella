import { BrowserWindow } from "electron";
import { OverlayWindowController } from "../windows/overlay-window.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { AuthService } from "../services/auth-service.js";
import type { CaptureService } from "../services/capture-service.js";
import type { BackupService } from "../services/backup-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { ExternalLinkService } from "../services/external-link-service.js";
import type { RadialGestureService } from "../services/radial-gesture-service.js";
import type { SecurityPolicyService } from "../services/security-policy-service.js";
import type { UiStateService } from "../services/ui-state-service.js";
import { WindowManager } from "../windows/window-manager.js";
import { createHmrTransitionController } from "../self-mod/hmr-morph.js";
import type {
  StellaBrowserBridgeResource,
  StellaBrowserBridgeStatus,
} from "../process-resources/browser-bridge-resource.js";
import type { MobileBridgeResource } from "../process-resources/mobile-bridge-resource.js";
import { BootstrapLifecycleBindings } from "./lifecycle-bindings.js";
import { ProcessRuntime } from "../process-runtime.js";
import { createBootstrapServices } from "./bootstrap-services.js";
import { registerBootstrapProcessCleanups } from "./cleanup.js";

export type MobileBroadcastFn = (channel: string, data: unknown) => void;

export type BootstrapConfig = {
  authProtocol: string;
  electronDir: string;
  stellaRoot: string;
  hardResetMutableHomePaths: readonly string[];
  isDev: boolean;
  sessionPartition: string;
  startupStageDelayMs: number;
};

export type BootstrapState = {
  appReady: boolean;
  appSessionStartedAt: number;
  deferredStartupSequence: Promise<void> | null;
  deviceId: string | null;
  hmrTransitionController: ReturnType<
    typeof createHmrTransitionController
  > | null;
  isQuitting: boolean;
  localChatUpdateUnsubscribe: (() => void) | null;
  overlayController: OverlayWindowController | null;
  processRuntime: ProcessRuntime;
  scheduleUpdateUnsubscribe: (() => void) | null;
  googleWorkspaceAuthRequiredUnsubscribe: (() => void) | null;
  stellaRoot: string | null;
  stellaWorkspacePath: string | null;
  stellaHostRunner: StellaHostRunner | null;
  stellaBrowserBridgeService: StellaBrowserBridgeResource | null;
  mobileBridgeResource: MobileBridgeResource | null;
  officePreviewBridgeStop: (() => void) | null;
  windowManager: WindowManager | null;
};

export type BootstrapServices = {
  authService: AuthService;
  backupService: BackupService;
  captureService: CaptureService;
  credentialService: CredentialService;
  externalLinkService: ExternalLinkService;
  radialGestureService: RadialGestureService;
  securityPolicyService: SecurityPolicyService;
  uiStateService: UiStateService;
};

export type BootstrapContext = {
  config: BootstrapConfig;
  lifecycle: BootstrapLifecycleBindings;
  services: BootstrapServices;
  state: BootstrapState;
};

/**
 * Retrieve the mobile bridge broadcast function from context.
 * Returns null if the bridge service hasn't started yet.
 */
export const getMobileBroadcast = (
  context: BootstrapContext,
): MobileBroadcastFn | null => {
  return context.state.mobileBridgeResource?.broadcastToMobile ?? null;
};

export const getAllWindows = (context: BootstrapContext) =>
  context.state.windowManager
    ? context.state.windowManager.getAllWindows()
    : BrowserWindow.getAllWindows();

export const forEachWindow = (
  context: BootstrapContext,
  callback: (window: BrowserWindow) => void,
) => {
  for (const window of getAllWindows(context)) {
    if (!window.isDestroyed()) {
      callback(window);
    }
  }
};

export const broadcastToWindows = (
  context: BootstrapContext,
  channel: string,
  payload?: unknown,
) => {
  forEachWindow(context, (window) => {
    window.webContents.send(channel, payload);
  });
};

const broadcastToWindowsAndMobile = (
  context: BootstrapContext,
  channel: string,
  payload?: unknown,
  mobilePayload: unknown = payload ?? null,
) => {
  broadcastToWindows(context, channel, payload);
  getMobileBroadcast(context)?.(channel, mobilePayload);
};

export const broadcastAuthCallback = (
  context: BootstrapContext,
  url: string,
) => {
  broadcastToWindowsAndMobile(context, "auth:callback", { url });
};

export const broadcastLocalChatUpdated = (context: BootstrapContext) => {
  broadcastToWindowsAndMobile(context, "localChat:updated");
};

export const broadcastScheduleUpdated = (context: BootstrapContext) => {
  broadcastToWindowsAndMobile(context, "schedule:updated");
};

export const broadcastGoogleWorkspaceAuthRequired = (
  context: BootstrapContext,
) => {
  broadcastToWindows(context, "googleWorkspace:authRequired");
};

export const broadcastStellaBrowserBridgeStatus = (
  context: BootstrapContext,
  status: StellaBrowserBridgeStatus,
) => {
  broadcastToWindows(context, "browser:bridgeStatus", status);
};

export const createBootstrapContext = (
  config: BootstrapConfig,
): BootstrapContext => {
  const processRuntime = new ProcessRuntime();
  const state: BootstrapState = {
    appReady: false,
    appSessionStartedAt: Date.now(),
    deferredStartupSequence: null,
    deviceId: null,
    hmrTransitionController: null,
    isQuitting: false,
    localChatUpdateUnsubscribe: null,
    overlayController: null,
    processRuntime,
    scheduleUpdateUnsubscribe: null,
    googleWorkspaceAuthRequiredUnsubscribe: null,
    stellaRoot: null,
    stellaWorkspacePath: null,
    stellaHostRunner: null,
    stellaBrowserBridgeService: null,
    mobileBridgeResource: null,
    officePreviewBridgeStop: null,
    windowManager: null,
  };

  const lifecycle = new BootstrapLifecycleBindings(state);
  const context = { config, lifecycle, state } as BootstrapContext;

  context.services = createBootstrapServices({
    config,
    lifecycle,
    state,
    getAllWindows: () => getAllWindows(context),
    getMobileBroadcast: () => getMobileBroadcast(context),
    onAuthCallback: (url) => {
      broadcastAuthCallback(context, url);
    },
  });
  registerBootstrapProcessCleanups(context);

  return context;
};
