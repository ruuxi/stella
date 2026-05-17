/**
 * Renderer-side type declarations for `window.electronAPI`.
 *
 * Channel name constants live in `@/shared/contracts/ipc-channels.ts`.
 * When adding a new IPC channel, add the constant there first, then wire
 * the preload bridge (electron/preload.ts) and handler (electron/ipc/*.ts)
 * using that constant — never raw strings.
 */
import type { UiState, WindowMode } from "./ui";
import type { Theme } from "@/shared/theme/themes/types";
import type { AgentStreamEvent } from "../../../../runtime/contracts/agent-stream.js";
import type {
  EventRecord,
  LocalChatUpdatedPayload,
  MessageRecord,
} from "../../../../runtime/contracts/local-chat.js";
import type { TaskLifecycleStatus } from "../../../../runtime/contracts/agent-runtime.js";
import type { RealtimeVoicePreferences } from "../../../../runtime/contracts/local-preferences";
import type {
  ChatContext as SharedChatContext,
  ChatContextFile as SharedChatContextFile,
  ChatContextUpdate as SharedChatContextUpdate,
  BrowserType as SharedBrowserType,
  DomainVisit as SharedDomainVisit,
  DomainDetail as SharedDomainDetail,
  BrowserData as SharedBrowserData,
  BrowserDataResult as SharedBrowserDataResult,
  PreferredBrowserProfile as SharedPreferredBrowserProfile,
  BrowserProfile as SharedBrowserProfile,
  CommandFrequency as SharedCommandFrequency,
  ShellAnalysis as SharedShellAnalysis,
  DiscoveredApp as SharedDiscoveredApp,
  AllUserSignals as SharedAllUserSignals,
  AllUserSignalsResult as SharedAllUserSignalsResult,
  SelfModFeatureSummary as SharedSelfModFeatureSummary,
  StoreReleaseArtifact as SharedStoreReleaseArtifact,
  StoreReleaseManifest as SharedStoreReleaseManifest,
  StorePackageRecord as SharedStorePackageRecord,
  StorePackageReleaseRecord as SharedStorePackageReleaseRecord,
  StoreInstallRecord as SharedStoreInstallRecord,
  StoreThreadMessage as SharedStoreThreadMessage,
  StoreThreadSnapshot as SharedStoreThreadSnapshot,
  SelfModFeatureSnapshot as SharedSelfModFeatureSnapshot,
  SelfModHmrPhase as SharedSelfModHmrPhase,
  SelfModHmrState as SharedSelfModHmrState,
  AgentHealth as SharedAgentHealth,
  LocalLlmCredentialSummary as SharedLocalLlmCredentialSummary,
  LocalCronSchedule as SharedLocalCronSchedule,
  LocalCronPayload as SharedLocalCronPayload,
  LocalHeartbeatActiveHours as SharedLocalHeartbeatActiveHours,
  LocalCronJobRecord as SharedLocalCronJobRecord,
  LocalCronJobUpdatePatch as SharedLocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord as SharedLocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput as SharedLocalHeartbeatUpsertInput,
  ScheduledConversationEvent as SharedScheduledConversationEvent,
  VoiceRuntimeSnapshot as SharedVoiceRuntimeSnapshot,
  SocialSessionRuntimeRecord as SharedSocialSessionRuntimeRecord,
  SocialSessionServiceSnapshot as SharedSocialSessionServiceSnapshot,
} from "../../../../runtime/contracts/index.js";
import type {
  DiscoveryCategory,
  DiscoveryKnowledgeSeedPayload,
} from "../../../../runtime/contracts/discovery.js";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "../contracts/onboarding";
import type { RuntimeSocialSessionStatus } from "../../../../runtime/protocol/index.js";
import type {
  OfficePreviewRef as SharedOfficePreviewRef,
  OfficePreviewSnapshot as SharedOfficePreviewSnapshot,
} from "../../../../runtime/contracts/office-preview.js";
import type {
  BackupNowResult as SharedBackupNowResult,
  BackupStatusSnapshot as SharedBackupStatusSnapshot,
  BackupSummary as SharedBackupSummary,
  RestoreBackupResult as SharedRestoreBackupResult,
} from "../contracts/backup";
import type { RadialTriggerCode as SharedRadialTriggerCode } from "@/shared/lib/radial-trigger";
import type { MiniDoubleTapModifier as SharedMiniDoubleTapModifier } from "@/shared/lib/mini-double-tap";

export type ChatContext = SharedChatContext;
export type ChatContextFile = SharedChatContextFile;
export type ChatContextUpdate = SharedChatContextUpdate;
export type BrowserType = SharedBrowserType;
export type DomainVisit = SharedDomainVisit;
export type DomainDetail = SharedDomainDetail;
export type BrowserData = SharedBrowserData;
export type BrowserDataResult = SharedBrowserDataResult;
export type PreferredBrowserProfile = SharedPreferredBrowserProfile;
export type BrowserProfile = SharedBrowserProfile;
export type CommandFrequency = SharedCommandFrequency;
export type ShellAnalysis = SharedShellAnalysis;
export type DiscoveredApp = SharedDiscoveredApp;
export type AllUserSignals = SharedAllUserSignals;
export type AllUserSignalsResult = SharedAllUserSignalsResult;
export type AgentStreamIpcEvent = AgentStreamEvent;
export type SelfModFeatureSummary = SharedSelfModFeatureSummary;
export type StoreReleaseArtifact = SharedStoreReleaseArtifact;
export type StoreReleaseManifest = SharedStoreReleaseManifest;
export type StorePackageRecord = SharedStorePackageRecord;
export type StorePackageReleaseRecord = SharedStorePackageReleaseRecord;
export type StoreInstallRecord = SharedStoreInstallRecord;
export type StoreThreadMessage = SharedStoreThreadMessage;
export type StoreThreadSnapshot = SharedStoreThreadSnapshot;
export type SelfModFeatureSnapshot = SharedSelfModFeatureSnapshot;
export type SelfModHmrPhase = SharedSelfModHmrPhase;
export type SelfModHmrState = SharedSelfModHmrState;
export type AgentHealth = SharedAgentHealth;
export type LocalLlmCredentialSummary = SharedLocalLlmCredentialSummary;
export type LocalLlmOAuthProviderSummary = {
  provider: string;
  label: string;
};
export type LocalCronSchedule = SharedLocalCronSchedule;
export type LocalCronPayload = SharedLocalCronPayload;
export type LocalHeartbeatActiveHours = SharedLocalHeartbeatActiveHours;
export type LocalCronJobRecord = SharedLocalCronJobRecord;
export type LocalCronJobUpdatePatch = SharedLocalCronJobUpdatePatch;
export type LocalHeartbeatConfigRecord = SharedLocalHeartbeatConfigRecord;
export type LocalHeartbeatUpsertInput = SharedLocalHeartbeatUpsertInput;
export type ScheduledConversationEvent = SharedScheduledConversationEvent;
export type VoiceRuntimeSnapshot = SharedVoiceRuntimeSnapshot;
export type SocialSessionRuntimeRecord = SharedSocialSessionRuntimeRecord;
export type SocialSessionServiceSnapshot = SharedSocialSessionServiceSnapshot;
export type OfficePreviewRef = SharedOfficePreviewRef;
export type OfficePreviewSnapshot = SharedOfficePreviewSnapshot;
export type BackupNowResult = SharedBackupNowResult;
export type BackupStatusSnapshot = SharedBackupStatusSnapshot;
export type BackupSummary = SharedBackupSummary;
export type RestoreBackupResult = SharedRestoreBackupResult;
export type RadialTriggerCode = SharedRadialTriggerCode;
export type MiniDoubleTapModifier = SharedMiniDoubleTapModifier;
export type RadialWedge = "capture" | "chat" | "add" | "voice" | "dismiss";
export type VoiceShortcutRegistrationResult = {
  ok: boolean;
  requestedShortcut: string;
  activeShortcut: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Namespaced API sub-types
// ---------------------------------------------------------------------------

export type ElectronWindowApi = {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  isMiniAlwaysOnTop: () => Promise<boolean>;
  setMiniAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
  show: (target: WindowMode) => void;
  setNativeButtonsVisible: (visible: boolean) => void;
};

export type ElectronUiApi = {
  getState: () => Promise<UiState>;
  setState: (partial: Partial<UiState>) => Promise<UiState>;
  onState: (callback: (state: UiState) => void) => () => void;
  onOpenChatSidebar: (callback: () => void) => () => void;
  setAppReady: (ready: boolean) => void;
  reload: () => void;
  relaunch: () => void;
  hardReset: () => Promise<{ ok: boolean }>;
  morphStart: (payload?: {
    rect?: { x: number; y: number; width: number; height: number };
  }) => Promise<{ ok: boolean }>;
  morphComplete: (payload?: {
    rect?: { x: number; y: number; width: number; height: number };
  }) => Promise<{ ok: boolean }>;
  setOnboardingPresentation: (active: boolean) => Promise<{ ok: boolean }>;
};

export type ElectronCaptureApi = {
  getContext: () => Promise<ChatContext | null>;
  setContext: (context: ChatContext | null) => void;
  onContext: (
    callback: (payload: ChatContextUpdate | null) => void,
  ) => () => void;
  screenshot: (point?: { x: number; y: number }) => Promise<{
    dataUrl: string;
    width: number;
    height: number;
  } | null>;
  visionScreenshots: (point?: { x: number; y: number }) => Promise<
    Array<{
      dataUrl: string;
      width: number;
      height: number;
      displayId: number;
      screenNumber: number;
      label: string;
      isPrimaryFocus: boolean;
      coordinateSpace: {
        x: number;
        y: number;
        logicalWidth: number;
        logicalHeight: number;
        sourceWidth: number;
        sourceHeight: number;
        targetWidth: number;
        targetHeight: number;
      };
    }>
  >;
  removeScreenshot: (index: number) => void;
  submitRegionSelection: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  prepareRegionSelection: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<{
    screenshot: {
      dataUrl: string;
      width: number;
      height: number;
    } | null;
    window: null;
  } | null>;
  commitPreparedRegionCapture: (
    result: {
      screenshot: {
        dataUrl: string;
        width: number;
        height: number;
      } | null;
      window: {
        app: string;
        title: string;
        bounds: { x: number; y: number; width: number; height: number };
      } | null;
    } | null,
  ) => void;
  submitRegionClick: (point: { x: number; y: number }) => void;
  pageDataUrl: () => Promise<string | null>;
  getWindowCapture: (point: { x: number; y: number }) => Promise<{
    bounds: { x: number; y: number; width: number; height: number };
    thumbnail: string;
    result: {
      screenshot: {
        dataUrl: string;
        width: number;
        height: number;
      } | null;
      window: {
        app: string;
        title: string;
        bounds: { x: number; y: number; width: number; height: number };
      } | null;
    };
  } | null>;
  cursorDisplayInfo: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
  }>;
  cancelRegion: () => void;
  /**
   * Composer "+ menu" capture entry point. Mirrors the radial dial's
   * "capture" wedge: minimizes the active Stella window, opens the region
   * overlay (click=window, drag=region), merges the result into
   * `chatContext`, then restores the window. Resolves with `{ cancelled }`
   * if the user dismissed the overlay (Esc / right-click).
   */
  beginRegionCapture: () => Promise<{ ok: true } | { cancelled: true }>;
};

export type ElectronRadialApi = {
  onShow: (
    callback: (
      event: unknown,
      data: {
        centerX: number;
        centerY: number;
        x?: number;
        y?: number;
        screenX?: number;
        screenY?: number;
        compactFocused?: boolean;
        miniAlwaysOnTop?: boolean;
      },
    ) => void,
  ) => () => void;
  onHide: (callback: () => void) => () => void;
  animDone: () => void;
  onCursor: (
    callback: (
      event: unknown,
      data: { x: number; y: number; centerX: number; centerY: number },
    ) => void,
  ) => () => void;
};

export type ElectronOverlayApi = {
  setInteractive: (interactive: boolean) => void;
  showWindowHighlight: (payload: {
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    tone?: "default" | "subtle";
  }) => void;
  hideWindowHighlight: () => void;
  previewWindowHighlightAtPoint: (point: { x: number; y: number }) => void;
  onStartRegionCapture: (callback: () => void) => () => void;
  onEndRegionCapture: (callback: () => void) => () => void;
  onWindowHighlight: (
    callback: (
      data: {
        x: number;
        y: number;
        width: number;
        height: number;
        tone?: "default" | "subtle";
      } | null,
    ) => void,
  ) => () => void;
  onShowDictation: (
    callback: (data: { x: number; y: number }) => void,
  ) => () => void;
  onHideDictation: (callback: () => void) => () => void;
  onShowScreenGuide: (
    callback: (data: {
      annotations: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
      }>;
    }) => void,
  ) => () => void;
  onHideScreenGuide: (callback: () => void) => () => void;
  onShowSelectionChip: (
    callback: (data: {
      requestId: number;
      text: string;
      rect: { x: number; y: number; width: number; height: number };
    }) => void,
  ) => () => void;
  onHideSelectionChip: (
    callback: (data: { requestId?: number } | null) => void,
  ) => () => void;
  selectionChipClicked: (requestId: number) => void;
  onDisplayChange: (
    callback: (data: {
      origin: { x: number; y: number };
      bounds: { x: number; y: number; width: number; height: number };
    }) => void,
  ) => () => void;
  onMorphForward: (
    callback: (data: {
      transitionId: string;
      screenshotDataUrl: string;
      x: number;
      y: number;
      width: number;
      height: number;
      flavor?: "hmr" | "onboarding";
    }) => void,
  ) => () => void;
  onMorphBounds: (
    callback: (data: {
      transitionId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }) => void,
  ) => () => void;
  onMorphReverse: (
    callback: (data: {
      transitionId: string;
      screenshotDataUrl: string;
      requiresFullReload: boolean;
      flavor?: "hmr" | "onboarding";
    }) => void,
  ) => () => void;
  onMorphEnd: (
    callback: (payload: { transitionId: string }) => void,
  ) => () => void;
  onMorphState: (
    callback: (payload: {
      transitionId: string;
      state: SelfModHmrState;
    }) => void,
  ) => () => void;
  morphReady: (transitionId: string) => void;
  morphDone: (transitionId: string) => void;
};

export type ElectronThemeApi = {
  onChange: (
    callback: (event: unknown, data: { key: string; value: string }) => void,
  ) => () => void;
  broadcast: (key: string, value: string) => void;
  listInstalled: () => Promise<Theme[]>;
};

export type ElectronVoiceApi = {
  persistTranscript: (payload: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
    uiVisibility?: "visible" | "hidden";
  }) => void;
  orchestratorChat: (payload: {
    conversationId: string;
    message: string;
  }) => Promise<string>;
  webSearch: (payload: { query: string; category?: string }) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  createOpenAISession: (payload: { instructions?: string }) => Promise<{
    provider: "openai";
    clientSecret: string;
    model: string;
    voice: string;
    expiresAt?: number;
    sessionId?: string;
  }>;
  createXaiSession: (payload: { instructions?: string }) => Promise<{
    provider: "xai";
    clientSecret: string;
    model: string;
    voice: string;
    expiresAt?: number;
  }>;
  createInworldSession: (payload: { instructions?: string }) => Promise<{
    provider: "inworld";
    clientSecret: string;
    model: string;
    voice: string;
    iceServers?: RTCIceServer[];
  }>;
  getCoreMemory: () => Promise<string>;
  getRuntimeState: () => Promise<VoiceRuntimeSnapshot>;
  onRuntimeState: (
    callback: (state: VoiceRuntimeSnapshot) => void,
  ) => () => void;
  pushRuntimeState: (state: VoiceRuntimeSnapshot) => void;
  onActionCompleted: (
    callback: (payload: {
      conversationId: string;
      status: "completed" | "failed";
      message: string;
    }) => void,
  ) => () => void;
  setRtcShortcut: (
    shortcut: string,
  ) => Promise<VoiceShortcutRegistrationResult>;
  getRtcShortcut: () => Promise<string>;
};

export type ElectronDictationApi = {
  /**
   * Subscribe to global Cmd/Ctrl+Shift+M presses (or any other registered
   * dictation shortcut). The renderer dispatches the in-window event the
   * `useDictation` hook listens to so the active composer toggles its
   * speech-to-text session.
   */
  onToggle: (
    callback: (data: {
      startId?: string;
      action?: "toggle" | "start" | "reveal" | "stop" | "cancel";
    }) => void,
  ) => () => void;
  /** Programmatically trigger the same toggle from the renderer. */
  trigger: () => Promise<{ ok: boolean }>;
  /** Returns the currently registered global shortcut accelerator. */
  getShortcut: () => Promise<string>;
  /**
   * Replace the global shortcut accelerator. Pass an empty string to
   * disable the shortcut entirely.
   */
  setShortcut: (shortcut: string) => Promise<VoiceShortcutRegistrationResult>;
  /** Returns whether dictation start/stop sound effects are enabled. */
  getSoundEffectsEnabled: () => Promise<boolean>;
  /** Enable or disable dictation start/stop sound effects. */
  setSoundEffectsEnabled: (
    enabled: boolean,
  ) => Promise<{ enabled: boolean }>;
  localStatus: () => Promise<{
    available: boolean;
    model: string;
    reason?: string;
  }>;
  downloadLocalModel: () => Promise<{
    available: boolean;
    model: string;
    reason?: string;
  }>;
  warmLocal: () => Promise<{
    available: boolean;
    model: string;
    reason?: string;
  }>;
  transcribeLocal: (payload: { audioBase64: string }) => Promise<{
    transcript: string;
    model: string;
  }>;
  onOverlayStart: (
    callback: (data: { sessionId: string }) => void,
  ) => () => void;
  onOverlayStop: (
    callback: (data: { sessionId: string }) => void,
  ) => () => void;
  onOverlayCancel: (
    callback: (data: { sessionId: string }) => void,
  ) => () => void;
  overlayCompleted: (payload: { sessionId: string; text: string }) => void;
  overlayFailed: (payload: { sessionId: string; error?: string }) => void;
  inAppStarted: (payload: { startId?: string }) => void;
  activeChanged: (payload: { active: boolean }) => void;
  playSound: (payload: {
    sound: "startRecording" | "stopRecording" | "cancel";
  }) => void;
};

export type ElectronAgentApi = {
  oneShotCompletion: (payload: {
    agentType: string;
    systemPrompt?: string;
    userText: string;
    maxOutputTokens?: number;
    temperature?: number;
    fallbackAgentTypes?: string[];
  }) => Promise<{ text: string }>;
  healthCheck: () => Promise<AgentHealth | null>;
  getActiveRun: () => Promise<{
    runId: string;
    conversationId: string;
    uiVisibility?: "visible" | "hidden";
  } | null>;
  getAppSessionStartedAt: () => Promise<number>;
  startChat: (payload: {
    conversationId: string;
    userPrompt: string;
    selectedText?: string | null;
    chatContext?: SharedChatContext | null;
    deviceId?: string;
    platform?: string;
    timezone?: string;
    /** BCP-47 locale for the user's preferred response language. */
    locale?: string;
    mode?: string;
    messageMetadata?: Record<string, unknown>;
    attachments?: Array<{
      url: string;
      mimeType?: string;
    }>;
    userMessageEventId?: string;
    agentType?: string;
    storageMode?: "cloud" | "local";
  }) => Promise<{ requestId: string }>;
  sendInput: (payload: {
    conversationId: string;
    threadId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ delivered: boolean }>;
  cancelChat: (runId: string) => void;
  resumeConversationExecution: (payload: {
    conversationId: string;
    lastSeq: number;
  }) => Promise<{
    activeRun: {
      runId: string;
      conversationId: string;
      requestId?: string;
      userMessageId?: string;
      uiVisibility?: "visible" | "hidden";
    } | null;
    events: AgentStreamIpcEvent[];
    tasks: Array<{
      runId: string;
      agentId: string;
      agentType?: string;
      description?: string;
      anchorTurnId?: string;
      parentAgentId?: string;
      status: TaskLifecycleStatus;
      statusText?: string;
      reasoningText?: string;
      result?: string;
      error?: string;
    }>;
  }>;
  onStream: (callback: (event: AgentStreamIpcEvent) => void) => () => void;
  onSelfModHmrState: (callback: (event: SelfModHmrState) => void) => () => void;
  /**
   * Runtime availability transitions (worker disconnected / reconnected).
   * Renderer hooks subscribe so they can re-resume chat replay after the
   * detached worker reattaches following an Electron restart.
   */
  onAvailability: (
    callback: (snapshot: {
      connected: boolean;
      ready: boolean;
      reason?: string;
    }) => void,
  ) => () => void;
  selfModRevert: (featureId?: string, steps?: number) => Promise<unknown>;
  getCrashRecoveryStatus: () => Promise<
    | {
        kind: "dirty";
        changedFileCount: number;
        latestChangedAtMs: number | null;
      }
    | {
        kind: "clean";
        latestFeature: SelfModFeatureSummary | null;
      }
  >;
  discardUnfinishedSelfModChanges: () => Promise<{
    discardedFileCount: number;
  }>;
  getLastSelfModFeature: () => Promise<string | null>;
  listSelfModFeatures: (limit?: number) => Promise<SelfModFeatureSummary[]>;
  triggerViteError: () => Promise<{ ok: boolean }>;
  fixViteError: () => Promise<{ ok: boolean }>;
};

export type ElectronSystemApi = {
  getDeviceId: () => Promise<string | null>;
  startPhoneAccessSession: () => Promise<{ ok: boolean }>;
  stopPhoneAccessSession: () => Promise<{ ok: boolean }>;
  configurePiRuntime: (config: {
    convexUrl?: string;
    convexSiteUrl?: string;
  }) => Promise<{ deviceId: string | null }>;
  setAuthState: (payload: {
    authenticated: boolean;
    token?: string;
    hasConnectedAccount?: boolean;
  }) => Promise<{ ok: boolean }>;
  getAuthSession: () => Promise<unknown | null>;
  signInAnonymous: () => Promise<unknown>;
  signOutAuth: () => Promise<{ ok: boolean }>;
  deleteAuthUser: () => Promise<{ ok: boolean }>;
  verifyAuthCallbackUrl: (url: string) => Promise<{ ok: boolean }>;
  applyAuthSessionCookie: (sessionCookie: string) => Promise<{ ok: boolean }>;
  getConvexAuthToken: () => Promise<string | null>;
  completeRuntimeAuthRefresh: (payload: {
    requestId: string;
    authenticated: boolean;
    token?: string;
    hasConnectedAccount?: boolean;
  }) => Promise<{ ok: boolean; accepted?: boolean }>;
  setCloudSyncEnabled: (payload: {
    enabled: boolean;
  }) => Promise<{ ok: boolean }>;
  setModelCatalogUpdatedAt: (payload: {
    updatedAt: number | null;
  }) => Promise<{ ok: boolean }>;
  onAuthCallback: (callback: (data: { url: string }) => void) => () => void;
  consumePendingAuthCallback: () => Promise<string | null>;
  onRuntimeAuthRefreshRequested: (
    callback: (data: {
      requestId: string;
      source: "heartbeat" | "subscription" | "register";
    }) => void,
  ) => () => void;
  quitForRestart: () => Promise<{ ok: boolean }>;
  openFullDiskAccess: () => void;
  getPermissionStatus: () => Promise<{
    accessibility: boolean;
    screen: boolean;
    microphone: boolean;
    microphoneStatus:
      | "not-determined"
      | "granted"
      | "denied"
      | "restricted"
      | "unknown";
  }>;
  openPermissionSettings: (kind: string) => Promise<void>;
  requestPermission: (kind: string) => Promise<{
    granted: boolean;
    alreadyGranted: boolean;
    openedSettings?: boolean;
  }>;
  resetMicrophonePermission: () => Promise<{ ok: boolean }>;
  resetPermission: (
    kind: "accessibility" | "screen" | "microphone",
  ) => Promise<{ ok: boolean }>;
  openExternal: (url: string) => void;
  showItemInFolder: (filePath: string) => void;
  saveFileAs: (
    sourcePath: string,
    defaultName?: string,
  ) => Promise<{
    ok: boolean;
    path?: string;
    canceled?: boolean;
    error?: string;
  }>;
  listExternalOpeners: (filePath: string) => Promise<{
    openers: Array<{
      id: string;
      label: string;
      kind: "app" | "default" | "reveal";
    }>;
  }>;
  openWithExternal: (
    filePath: string,
    openerId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  shellKillByPort: (port: number) => Promise<void>;
  getLocalSyncMode: () => Promise<string>;
  setLocalSyncMode: (mode: string) => Promise<void>;
  getRadialTriggerKey: () => Promise<RadialTriggerCode>;
  setRadialTriggerKey: (
    triggerKey: RadialTriggerCode,
  ) => Promise<{ triggerKey: RadialTriggerCode }>;
  getMiniDoubleTapModifier: () => Promise<MiniDoubleTapModifier>;
  setMiniDoubleTapModifier: (
    modifier: MiniDoubleTapModifier,
  ) => Promise<{ modifier: MiniDoubleTapModifier }>;
  getPreventComputerSleep: () => Promise<boolean>;
  setPreventComputerSleep: (enabled: boolean) => Promise<{ enabled: boolean }>;
  getSoundNotificationsEnabled: () => Promise<boolean>;
  setSoundNotificationsEnabled: (
    enabled: boolean,
  ) => Promise<{ enabled: boolean }>;
  getReadAloudEnabled: () => Promise<boolean>;
  setReadAloudEnabled: (
    enabled: boolean,
  ) => Promise<{ enabled: boolean }>;
  setGlobalShortcutsSuspended: (
    suspended: boolean,
  ) => Promise<{ supported: boolean; suspended: boolean }>;
  getGlobalShortcutsSuspended: () => Promise<{
    supported: boolean;
    suspended: boolean;
  }>;
  recordHeapTrace: (
    durationMs?: number,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  getWakeWordEnabled: () => Promise<boolean>;
  setWakeWordEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  getPersonalityVoice: () => Promise<string | null>;
  setPersonalityVoice: (
    voiceId: string,
  ) => Promise<{ ok: boolean; voiceId: string }>;
  getBackupStatus: () => Promise<BackupStatusSnapshot>;
  backUpNow: () => Promise<BackupNowResult>;
  listBackups: (limit?: number) => Promise<BackupSummary[]>;
  restoreBackup: (snapshotId: string) => Promise<RestoreBackupResult>;
  getLocalModelPreferences: () => Promise<{
    defaultModels: Record<string, string>;
    modelOverrides: Record<string, string>;
    assistantPropagatedAgents: string[];
    reasoningEfforts: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    agentRuntimeEngine: "default" | "claude_code_local";
    maxAgentConcurrency: number;
    imageGeneration: {
      provider: "stella" | "openai" | "openrouter" | "fal";
      model?: string;
    };
    realtimeVoice: RealtimeVoicePreferences;
  } | null>;
  setLocalModelPreferences: (payload: {
    defaultModels?: Record<string, string>;
    modelOverrides?: Record<string, string>;
    assistantPropagatedAgents?: string[];
    reasoningEfforts?: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    agentRuntimeEngine?: "default" | "claude_code_local";
    maxAgentConcurrency?: number;
    imageGeneration?: {
      provider: "stella" | "openai" | "openrouter" | "fal";
      model?: string;
    };
    realtimeVoice?: RealtimeVoicePreferences;
  }) => Promise<{
    defaultModels: Record<string, string>;
    modelOverrides: Record<string, string>;
    assistantPropagatedAgents: string[];
    reasoningEfforts: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    agentRuntimeEngine: "default" | "claude_code_local";
    maxAgentConcurrency: number;
    imageGeneration: {
      provider: "stella" | "openai" | "openrouter" | "fal";
      model?: string;
    };
    realtimeVoice: RealtimeVoicePreferences;
  } | null>;
  listLlmCredentials: () => Promise<LocalLlmCredentialSummary[]>;
  listLlmOAuthProviders: () => Promise<LocalLlmOAuthProviderSummary[]>;
  listLlmOAuthCredentials: () => Promise<LocalLlmCredentialSummary[]>;
  loginLlmOAuthCredential: (
    provider: string,
  ) => Promise<LocalLlmCredentialSummary>;
  deleteLlmOAuthCredential: (provider: string) => Promise<{ removed: boolean }>;
  saveLlmCredential: (payload: {
    provider: string;
    label: string;
    plaintext: string;
  }) => Promise<LocalLlmCredentialSummary>;
  deleteLlmCredential: (provider: string) => Promise<{ removed: boolean }>;
  resetMessages: () => Promise<{ ok: boolean }>;
  onCredentialRequest: (
    callback: (
      event: unknown,
      data: {
        requestId: string;
        provider: string;
        label?: string;
        description?: string;
        placeholder?: string;
      },
    ) => void,
  ) => () => void;
  submitCredential: (payload: {
    requestId: string;
    secretId: string;
    provider: string;
    label: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  cancelCredential: (payload: {
    requestId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onConnectorCredentialRequest: (
    callback: (
      event: unknown,
      data: {
        requestId: string;
        tokenKey: string;
        displayName: string;
        mode: "api_key" | "oauth";
        description?: string;
        placeholder?: string;
      },
    ) => void,
  ) => () => void;
  submitConnectorCredential: (payload: {
    requestId: string;
    value: string;
    label?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  cancelConnectorCredential: (payload: {
    requestId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
};

export type InstallManifestSnapshot = {
  version: string;
  platform: string;
  installPath: string;
  installedAt: string;
  desktopReleaseTag: string | null;
  desktopReleaseCommit: string | null;
  desktopInstallBaseCommit: string | null;
};

export type ElectronUpdatesApi = {
  getInstallManifest: () => Promise<InstallManifestSnapshot | null>;
  recordAppliedCommit: (
    commit: string,
    tag?: string,
  ) => Promise<InstallManifestSnapshot | null>;
};

export type ElectronOnboardingApi = {
  synthesizeCoreMemory: (
    payload: OnboardingSynthesisRequest,
  ) => Promise<OnboardingSynthesisResponse>;
  complete: () => Promise<{ ok: boolean }>;
  reset: () => Promise<{ ok: boolean }>;
};

export type ElectronDiscoveryApi = {
  checkCoreMemoryExists: () => Promise<boolean>;
  checkKnowledgeExists: () => Promise<boolean>;
  collectData: (options?: {
    selectedBrowser?: string;
    selectedProfile?: string;
  }) => Promise<BrowserDataResult>;
  detectPreferred: () => Promise<PreferredBrowserProfile>;
  listProfiles: (browserType: string) => Promise<BrowserProfile[]>;
  writeCoreMemory: (
    content: string,
    options?: { includeLocation?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  writeKnowledge: (
    payload: DiscoveryKnowledgeSeedPayload,
  ) => Promise<{ ok: boolean; error?: string }>;
  collectAllSignals: (options?: {
    categories?: DiscoveryCategory[];
    selectedBrowser?: string;
    selectedProfile?: string;
  }) => Promise<AllUserSignalsResult>;
};

export type ElectronBrowserApi = {
  onBridgeStatus: (
    callback: (status: {
      state:
        | "connecting"
        | "connected"
        | "reconnecting"
        | "host_registration_failed";
      attempt: number;
      nextRetryMs?: number;
      error?: string;
      notifyUser?: boolean;
    }) => void,
  ) => () => void;
  fetchJson: (
    url: string,
    init?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<unknown>;
  fetchText: (
    url: string,
    init?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<string>;
};

export type ElectronScheduleApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>;
  listHeartbeats: () => Promise<LocalHeartbeatConfigRecord[]>;
  listConversationEvents: (payload: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<ScheduledConversationEvent[]>;
  getConversationEventCount: (payload: {
    conversationId: string;
  }) => Promise<number>;
  runCronJob: (payload: { jobId: string }) => Promise<unknown>;
  removeCronJob: (payload: { jobId: string }) => Promise<boolean>;
  updateCronJob: (payload: {
    jobId: string;
    patch: LocalCronJobUpdatePatch;
  }) => Promise<LocalCronJobRecord | null>;
  upsertHeartbeat: (
    payload: LocalHeartbeatUpsertInput,
  ) => Promise<LocalHeartbeatConfigRecord>;
  runHeartbeat: (payload: { conversationId: string }) => Promise<unknown>;
  onUpdated: (callback: () => void) => () => void;
};

export type ElectronStoreApi = {
  readFeatureSnapshot: () => Promise<SelfModFeatureSnapshot | null>;
  listPackages: () => Promise<StorePackageRecord[]>;
  getPackage: (packageId: string) => Promise<StorePackageRecord | null>;
  listPackageReleases: (
    packageId: string,
  ) => Promise<StorePackageReleaseRecord[]>;
  getPackageRelease: (payload: {
    packageId: string;
    releaseNumber: number;
  }) => Promise<StorePackageReleaseRecord | null>;
  listInstalledMods: () => Promise<StoreInstallRecord[]>;
  installFromBlueprint: (payload: {
    packageId: string;
    releaseNumber: number;
  }) => Promise<StoreInstallRecord | null>;
  getThread: () => Promise<StoreThreadSnapshot>;
  sendThreadMessage: (payload: {
    text: string;
    attachedFeatureNames?: string[];
    editingBlueprint?: boolean;
  }) => Promise<StoreThreadSnapshot>;
  cancelThreadTurn: () => Promise<StoreThreadSnapshot>;
  denyLatestBlueprint: () => Promise<StoreThreadSnapshot>;
  markBlueprintPublished: (payload: {
    messageId: string;
    releaseNumber: number;
  }) => Promise<StoreThreadSnapshot>;
  publishBlueprint: (payload: {
    messageId: string;
    packageId: string;
    asUpdate: boolean;
    displayName?: string;
    description?: string;
    category?:
      | "apps-games"
      | "productivity"
      | "customization"
      | "skills-agents"
      | "integrations"
      | "other";
    manifest: Record<string, unknown>;
    releaseNotes?: string;
  }) => Promise<StorePackageReleaseRecord>;
  uninstallPackage: (packageId: string) => Promise<{
    packageId: string;
    revertedCommits: string[];
  }>;
  showBlueprintNotification: (payload: {
    messageId: string;
    name: string;
  }) => Promise<{ ok: boolean }>;
  onBlueprintNotificationActivated: (
    callback: (payload: { messageId: string | null }) => void,
  ) => () => void;
  /**
   * Push-based subscription to Store-thread changes. Fires whenever a
   * thread message is appended/patched/cleared/deleted/denied or marked
   * as published — both renderer flows that mutate the thread (sending
   * a turn, denying a draft) and runtime-side mutations (the agent
   * polling loop completing) emit the same event. Replaces polling.
   */
  onThreadUpdated: (
    callback: (snapshot: StoreThreadSnapshot) => void,
  ) => () => void;
};

export type EmbeddedWebsiteTheme = {
  mode?: "light" | "dark";
  foreground?: string;
  foregroundWeak?: string;
  border?: string;
  primary?: string;
  surface?: string;
  background?: string;
};

export type ElectronStoreWebApi = {
  show: (payload?: {
    route?: "store" | "billing";
    tab?: string;
    package?: string;
    packageId?: string;
    embedded?: boolean;
    theme?: EmbeddedWebsiteTheme;
  }) => Promise<{ ok: boolean }>;
  hide: () => Promise<{ ok: boolean }>;
  setLayout: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<{ ok: boolean }>;
  setTheme: (payload: EmbeddedWebsiteTheme) => Promise<{ ok: boolean }>;
  goBack: () => Promise<{ ok: boolean }>;
  goForward: () => Promise<{ ok: boolean }>;
  reload: () => Promise<{ ok: boolean }>;
};

export type ElectronStoreWebLocalApi = {
  onAction: (
    callback: (payload: { requestId: string; action: unknown }) => void,
  ) => () => void;
  reply: (payload: {
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }) => void;
};

export type FashionBodyPhotoInfo = {
  hasBodyPhoto: boolean;
  absolutePath?: string;
  mimeType?: string;
  updatedAt?: number;
};

export type ElectronFashionApi = {
  pickAndSaveBodyPhoto: () => Promise<
    { canceled: true } | { canceled: false; info: FashionBodyPhotoInfo }
  >;
  getBodyPhotoInfo: () => Promise<FashionBodyPhotoInfo>;
  getBodyPhotoDataUrl: () => Promise<string | null>;
  deleteBodyPhoto: () => Promise<{ ok: true }>;
  getLocalImageDataUrl: (path: string) => Promise<string>;
  startOutfitBatch: (payload: {
    prompt?: string;
    batchId?: string;
    count?: number;
    excludeProductIds?: string[];
    seedHints?: string[];
  }) => Promise<{ threadId?: string; batchId: string }>;
  pickTryOnImages: () => Promise<
    { canceled: true; paths: string[] } | { canceled: false; paths: string[] }
  >;
  /** Returns the absolute on-disk path for a dropped File, or "" if unavailable. */
  getDroppedFilePath: (file: File) => string;
  startTryOn: (payload: {
    prompt?: string;
    batchId?: string;
    imagePaths?: string[];
    imageUrls?: string[];
  }) => Promise<{
    threadId?: string;
    batchId: string;
    imagePaths: string[];
    imageUrls: string[];
  }>;
};

export type ElectronSocialSessionsApi = {
  create: (payload: {
    roomId: string;
    workspaceLabel?: string;
  }) => Promise<{ sessionId: string }>;
  updateStatus: (payload: {
    sessionId: string;
    status: RuntimeSocialSessionStatus;
  }) => Promise<{ sessionId: string; status: RuntimeSocialSessionStatus }>;
  queueTurn: (payload: {
    sessionId: string;
    prompt: string;
    agentType?: string;
    clientTurnId?: string;
  }) => Promise<{ turnId: string }>;
  getStatus: () => Promise<SocialSessionServiceSnapshot>;
};

export type ElectronLocalChatApi = {
  getOrCreateDefaultConversationId: () => Promise<string>;
  /**
   * Raw event-stream read kept for the few non-timeline consumers that
   * look for specific auxiliary event types (the welcome dialog reads
   * `assistant_message`, home categories reads `home_suggestions`), and
   * for the mobile bridge which proxies the channel to phone clients.
   * Renderer chat surfaces use `listMessages` / `listActivity` /
   * `listFiles` instead.
   */
  listEvents: (payload: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<EventRecord[]>;
  listMessages: (payload: {
    conversationId: string;
    maxVisibleMessages?: number;
  }) => Promise<{ messages: MessageRecord[]; visibleMessageCount: number }>;
  listMessagesBefore: (payload: {
    conversationId: string;
    beforeTimestampMs: number;
    beforeId: string;
    maxVisibleMessages?: number;
  }) => Promise<{ messages: MessageRecord[]; visibleMessageCount: number }>;
  listActivity: (payload: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }) => Promise<{
    activities: EventRecord[];
    latestMessageTimestampMs: number | null;
  }>;
  listFiles: (payload: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }) => Promise<{ files: EventRecord[] }>;
  persistDiscoveryWelcome: (payload: {
    conversationId: string;
    message: string;
    suggestions?: unknown[];
  }) => Promise<{ ok: true }>;
  listSyncMessages: (payload: {
    conversationId: string;
    maxMessages?: number;
  }) => Promise<
    Array<{
      localMessageId: string;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      deviceId?: string;
    }>
  >;
  getSyncCheckpoint: (payload: {
    conversationId: string;
  }) => Promise<string | null>;
  setSyncCheckpoint: (payload: {
    conversationId: string;
    localMessageId: string;
  }) => Promise<{ ok: boolean }>;
  onUpdated: (
    callback: (payload: LocalChatUpdatedPayload | null) => void,
  ) => () => void;
};

// ---------------------------------------------------------------------------
// Google Workspace
// ---------------------------------------------------------------------------

export type ElectronGoogleWorkspaceApi = {
  getAuthStatus: () => Promise<{
    connected: boolean;
    unavailable?: boolean;
    email?: string;
    name?: string;
  }>;
  connect: () => Promise<{
    connected: boolean;
    unavailable?: boolean;
    email?: string;
    name?: string;
  }>;
  disconnect: () => Promise<{ ok: boolean }>;
  onAuthRequired: (callback: () => void) => () => void;
};

// ---------------------------------------------------------------------------
// Home dashboard signals
// ---------------------------------------------------------------------------

export type ElectronHomeApi = {
  /**
   * Returns a snapshot of currently running user-facing apps with the
   * frontmost app marked `isActive: true`. Resolves with an empty `apps`
   * list when the native helper is unavailable (e.g. non-darwin) so the
   * UI can render an empty state without special-casing.
   */
  listRecentApps: (limit?: number) => Promise<{
    apps: Array<{
      name: string;
      bundleId?: string;
      pid: number;
      isActive: boolean;
      windowTitle?: string;
      iconDataUrl?: string;
    }>;
  }>;
  /**
   * Captures a screenshot of the named app's topmost window via Electron's
   * desktopCapturer, and returns the title we matched against. Returns
   * `{ capture: null }` when no matching window source is available or
   * screen recording permission is denied. Used by the auto-context chip
   * "lazy capture" path: chip attaches eagerly with metadata, then we
   * patch in this screenshot when it lands.
   */
  captureAppWindow: (
    target: string | { appName?: string | null; pid?: number | null },
  ) => Promise<{
    capture: {
      title: string;
      screenshot: {
        dataUrl: string;
        width: number;
        height: number;
      };
    } | null;
  }>;
  /**
   * Looks up the active tab for the given browser bundle id. Returns
   * `{ tab: null }` when the bundle id isn't a known browser, the browser
   * has no windows, or AppleScript permission was denied.
   */
  getActiveBrowserTab: (bundleId: string) => Promise<{
    tab: {
      browser: string;
      bundleId?: string;
      url: string;
      title?: string;
    } | null;
  }>;
};

export type ElectronScreenGuideApi = {
  show: (
    annotations: Array<{
      id: string;
      label: string;
      x: number;
      y: number;
    }>,
  ) => void;
  hide: () => void;
};

// ---------------------------------------------------------------------------
// Main ElectronApi â€” composed from namespaced sub-types
// ---------------------------------------------------------------------------

export type ElectronDisplayApi = {
  /**
   * Subscribes to runtime-driven workspace panel updates.
   *
   * Payload is a structured `DisplayPayload` object describing what to render.
   * Callers should pass through `normalizeDisplayPayload` from
   * `@/shared/contracts/display-payload` before routing it to the panel.
   */
  onUpdate: (callback: (payload: unknown) => void) => () => void;
  /**
   * Reads a file's raw bytes from the main process. Used by the PDF
   * viewer / canvas / media previewers to load local files without
   * giving the renderer file:// access. Bytes are transferred directly
   * via Electron's structured-clone IPC (no base64 round-trip).
   */
  readFile: (
    filePath: string,
  ) => Promise<
    | {
        bytes: Uint8Array;
        sizeBytes: number;
        mimeType: string;
        missing: false;
      }
    | { missing: true; mimeType: string; path: string }
  >;
  listTrash: () => Promise<{
    items: Array<{
      id: string;
      source: string;
      originalPath: string;
      trashPath: string;
      trashedAt: number;
      purgeAfter: number;
      requestId?: string;
      agentType?: string;
      conversationId?: string;
    }>;
    errors: string[];
  }>;
  forceDeleteTrash: (payload: { id?: string; all?: boolean }) => Promise<{
    checked: number;
    purged: number;
    skipped: number;
    errors: string[];
  }>;
};

export type ElectronOfficePreviewApi = {
  list: () => Promise<OfficePreviewSnapshot[]>;
  start: (filePath: string) => Promise<OfficePreviewRef>;
  onUpdate: (callback: (snapshot: OfficePreviewSnapshot) => void) => () => void;
};

export type ElectronApi = {
  platform: string;
  arch: string;
  display: ElectronDisplayApi;
  officePreview: ElectronOfficePreviewApi;
  window: ElectronWindowApi;
  ui: ElectronUiApi;
  capture: ElectronCaptureApi;
  radial: ElectronRadialApi;
  overlay: ElectronOverlayApi;
  screenGuide: ElectronScreenGuideApi;
  theme: ElectronThemeApi;
  voice: ElectronVoiceApi;
  dictation: ElectronDictationApi;
  agent: ElectronAgentApi;
  system: ElectronSystemApi;
  updates: ElectronUpdatesApi;
  onboarding: ElectronOnboardingApi;
  discovery: ElectronDiscoveryApi;
  browser: ElectronBrowserApi;
  storeWeb: ElectronStoreWebApi;
  storeWebLocal: ElectronStoreWebLocalApi;
  media: {
    saveOutput: (
      url: string,
      fileName: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    getStellaMediaDir: () => Promise<string | null>;
    copyImage: (pngBase64: string) => Promise<{ ok: boolean; error?: string }>;
  };
  memory: {
    status: () => Promise<{
      available: boolean;
      status: {
        enabled: boolean;
        pending: boolean;
        running: boolean;
        permission: boolean;
      };
    }>;
    setEnabled: (
      enabled: boolean,
      options?: { pending?: boolean },
    ) => Promise<{
      ok: boolean;
      reason?: string;
      status: {
        enabled: boolean;
        pending: boolean;
        running: boolean;
        permission: boolean;
      };
    }>;
    promotePending: () => Promise<{
      ok: boolean;
      promoted: boolean;
      reason?: string;
    }>;
  };
  chronicle: {
    status: () => Promise<{
      available: boolean;
      status?: {
        enabled: boolean;
        running: boolean;
        paused?: boolean;
        fps?: number;
        captures?: number;
        lastCaptureAt?: number | null;
      };
    }>;
    setEnabled: (enabled: boolean) => Promise<{
      ok: boolean;
      enabled?: boolean;
      running?: boolean;
      permission?: boolean;
      reason?: string;
    }>;
    openMemoriesFolder: () => Promise<{ ok: boolean }>;
    dreamNow: () => Promise<{
      ok: boolean;
      reason?: string;
      pendingThreadSummaries: number;
      pendingExtensions: number;
      detail?: string;
    }>;
    wipeMemories: () => Promise<{ ok: boolean; reason?: string }>;
  };
  schedule: ElectronScheduleApi;
  store: ElectronStoreApi;
  fashion: ElectronFashionApi;
  socialSessions: ElectronSocialSessionsApi;
  localChat: ElectronLocalChatApi;
  googleWorkspace: ElectronGoogleWorkspaceApi;
  home: ElectronHomeApi;
  pet: ElectronPetApi;
};

type PetOverlayMood =
  | "idle"
  | "running"
  | "waiting"
  | "review"
  | "failed"
  | "waving";

type PetOverlayStatusPayload = {
  state: PetOverlayMood;
  title: string;
  message: string;
  isLoading: boolean;
};

type ElectronPetApi = {
  /** Read the main-process canonical visibility/status. Used by the overlay
   *  renderer on mount because it can be loaded after the original broadcast. */
  getState: () => Promise<{
    open: boolean;
    status: PetOverlayStatusPayload;
  }>;
  /** Toggle the floating pet visibility from any window. */
  setOpen: (open: boolean) => void;
  /** Move the dedicated pet window to an absolute screen-coords
   *  position. Used by the renderer's drag handler. */
  moveWindow: (position: { x: number; y: number }) => void;
  /** Toggle the inline chat composer next to the pet. Main grows the
   *  pet window leftward to make room for the composer and flips
   *  `focusable` on so the textarea can receive keystrokes. Pass
   *  `false` to collapse the composer and restore the resting
   *  footprint. */
  setComposerActive: (active: boolean) => void;
  /** Renderer-driven mouse passthrough toggle. Defaults to click-through
   *  on the empty pixels of the pet window; the renderer flips this to
   *  `true` while the cursor is over a visibly-interactive element so
   *  clicks land on the pet, not the app below. */
  setInteractive: (active: boolean) => void;
  /** Pet voice button — ask main to enter voice (RTC) mode. */
  requestVoice: () => void;
  /** Pet mic button — start a dictation overlay whose transcript is
   *  delivered to Stella's chat instead of pasted into the focused app. */
  requestDictation: () => void;
  /** Subscribe to pet-mic dictation start/stop broadcasts. */
  onDictationActive: (callback: (active: boolean) => void) => () => void;
  /** Subscribe to visibility broadcasts coming back from main. */
  onSetOpen: (callback: (open: boolean) => void) => () => void;
  /** Push a derived `PetOverlayStatus` to every renderer. */
  pushStatus: (status: PetOverlayStatusPayload) => void;
  /** Subscribe to status broadcasts (fan-out from `pushStatus`). */
  onStatus: (callback: (status: PetOverlayStatusPayload) => void) => () => void;
  /** Ask main to focus the full window and open the chat sidebar. */
  openChat: () => void;
  /** Forward a popover-composer message to the full window's chat. */
  sendMessage: (text: string) => void;
  /** Receive `pet:sendMessage` payloads (full window only). */
  onSendMessage: (callback: (text: string) => void) => () => void;
};

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

export {};
