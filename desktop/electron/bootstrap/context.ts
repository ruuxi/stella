import { BrowserWindow } from "electron";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { PetWindowController } from "../windows/pet-window.js";
import type { TrayController } from "../windows/tray-controller.js";
import type { ChronicleController } from "../services/chronicle-controller.js";
import type { MeetingCaptureController } from "../services/meeting-capture-controller.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { AuthService } from "../services/auth-service.js";
import type { CaptureService } from "../services/capture-service.js";
import type { BackupService } from "../services/backup-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { ConnectorOAuthService } from "../services/connector-oauth-service.js";
import type { ConnectorConnectService } from "../services/connector-connect-service.js";
import type { MouseHookManager } from "../input/mouse-hook.js";
import type { ExternalLinkService } from "../services/external-link-service.js";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import type { SecurityPolicyService } from "../services/security-policy-service.js";
import type { UiStateService } from "../services/ui-state-service.js";
import type { UiStateStore } from "../../../runtime/kernel/ui-state/store.js";
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
  stellaAppDir: string;
  stellaDataDirPath: string;
  promptSiteUrl?: string | null;
  hardResetMutableHomePaths: readonly string[];
  isDev: boolean;
  useDevServer: boolean;
  sessionPartition: string;
  startupStageDelayMs: number;
  startupFirstPaintFallbackMs: number;
  startupRuntimeWarmupDelayMs: number;
};

export type BootstrapState = {
  appReady: boolean;
  appSessionStartedAt: number;
  deferredStartupSequence: Promise<void> | null;
  /** Kicks off the host runner (worker spawn + model-catalog warm). Set
   *  during bootstrap and invoked from the deferred-startup sequence so the
   *  worker spins up after the renderer's first paint rather than during the
   *  open burst. Idempotent. */
  startHostRunner: (() => void) | null;
  deviceId: string | null;
  hmrTransitionController: ReturnType<
    typeof createHmrTransitionController
  > | null;
  isQuitting: boolean;
  localChatUpdateUnsubscribe: (() => void) | null;
  threadActivityUpdateUnsubscribe: (() => void) | null;
  overlayController: OverlayWindowController | null;
  petController: PetWindowController | null;
  /** Disposer returned by `registerPetHandlers`. Stored on the
   *  bootstrap state so the quit-cleanup can tear down every pet IPC
   *  registration on app exit (or explicitly during tests). */
  petHandlersDispose: (() => void) | null;
  chronicleController: ChronicleController | null;
  meetingCaptureController: MeetingCaptureController | null;
  processRuntime: ProcessRuntime;
  scheduleUpdateUnsubscribe: (() => void) | null;
  globalInputHooksStarted: boolean;
  globalInputHooksStartScheduled: boolean;
  stellaAppDir: string | null;
  stellaDataDirPath: string | null;
  stellaWorkspacePath: string | null;
  stellaHostRunner: StellaHostRunner | null;
  stellaBrowserBridgeService: StellaBrowserBridgeResource | null;
  mobileBridgeResource: MobileBridgeResource | null;
  officePreviewBridgeStop: (() => void) | null;
  /** Shared renderer KV state backed by ~/.stella/ui-state.json. */
  uiStateKvStore: UiStateStore | null;
  windowManager: WindowManager | null;
  trayController: TrayController | null;
};

export type BootstrapServices = {
  authService: AuthService;
  backupService: BackupService;
  captureService: CaptureService;
  globalInputHook: MouseHookManager;
  credentialService: CredentialService;
  connectorOAuthService: ConnectorOAuthService;
  connectorConnectService: ConnectorConnectService;
  externalLinkService: ExternalLinkService;
  localChatHistoryService: LocalChatHistoryService;
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

export const getAllWindows = (context: BootstrapContext) => {
  const windows = context.state.windowManager
    ? context.state.windowManager.getAllWindows()
    : BrowserWindow.getAllWindows();
  const petWindow = context.state.petController?.getWindow() ?? null;
  if (!petWindow || petWindow.isDestroyed() || windows.includes(petWindow)) {
    return windows;
  }
  return [...windows, petWindow];
};

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

export const broadcastSocialInvite = (
  context: BootstrapContext,
  url: string,
) => {
  broadcastToWindows(context, "social:invite", { url });
};

export const broadcastLocalChatUpdated = (
  context: BootstrapContext,
  payload?:
    | import("../../../runtime/contracts/local-chat.js").LocalChatUpdatedPayload
    | null,
) => {
  broadcastToWindowsAndMobile(context, "localChat:updated", payload ?? null);
};

export const broadcastThreadActivityUpdated = (
  context: BootstrapContext,
  payload: import("../../../runtime/contracts/local-chat.js").ThreadActivityUpdatedPayload,
) => {
  broadcastToWindowsAndMobile(
    context,
    "localChat:threadActivityUpdated",
    payload,
  );
};

export const broadcastScheduleUpdated = (context: BootstrapContext) => {
  broadcastToWindowsAndMobile(context, "schedule:updated");
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
    startHostRunner: null,
    deviceId: null,
    hmrTransitionController: null,
    isQuitting: false,
    localChatUpdateUnsubscribe: null,
    threadActivityUpdateUnsubscribe: null,
    overlayController: null,
    petController: null,
    petHandlersDispose: null,
    chronicleController: null,
    meetingCaptureController: null,
    processRuntime,
    scheduleUpdateUnsubscribe: null,
    globalInputHooksStarted: false,
    globalInputHooksStartScheduled: false,
    stellaAppDir: null,
    stellaDataDirPath: null,
    stellaWorkspacePath: null,
    stellaHostRunner: null,
    stellaBrowserBridgeService: null,
    mobileBridgeResource: null,
    officePreviewBridgeStop: null,
    uiStateKvStore: null,
    windowManager: null,
    trayController: null,
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
    onSocialInvite: (url) => {
      broadcastSocialInvite(context, url);
    },
  });
  registerBootstrapProcessCleanups(context);

  return context;
};
