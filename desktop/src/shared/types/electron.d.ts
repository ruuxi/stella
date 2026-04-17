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
import type { AgentStreamEvent } from "@/app/chat/streaming/streaming-types";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { LocalChatEventWindowMode } from "../../../../runtime/chat-event-visibility";
import type {
  ChatContext as SharedChatContext,
  ChatContextFile as SharedChatContextFile,
  ChatContextUpdate as SharedChatContextUpdate,
  MiniBridgeEventRecord as SharedMiniBridgeEventRecord,
  MiniBridgeSnapshot as SharedMiniBridgeSnapshot,
  MiniBridgeRequest as SharedMiniBridgeRequest,
  MiniBridgeResponse as SharedMiniBridgeResponse,
  MiniBridgeRequestEnvelope as SharedMiniBridgeRequestEnvelope,
  MiniBridgeResponseEnvelope as SharedMiniBridgeResponseEnvelope,
  MiniBridgeUpdate as SharedMiniBridgeUpdate,
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
  SelfModFeatureRecord as SharedSelfModFeatureRecord,
  SelfModBatchRecord as SharedSelfModBatchRecord,
  StoreReleaseDraft as SharedStoreReleaseDraft,
  StoreReleaseArtifact as SharedStoreReleaseArtifact,
  StoreReleaseManifest as SharedStoreReleaseManifest,
  StorePackageRecord as SharedStorePackageRecord,
  StorePackageReleaseRecord as SharedStorePackageReleaseRecord,
  InstalledStoreModRecord as SharedInstalledStoreModRecord,
  SelfModHmrPhase as SharedSelfModHmrPhase,
  SelfModHmrState as SharedSelfModHmrState,
  AgentHealth as SharedAgentHealth,
  LocalLlmCredentialSummary as SharedLocalLlmCredentialSummary,
  LocalCronSchedule as SharedLocalCronSchedule,
  LocalCronPayload as SharedLocalCronPayload,
  LocalHeartbeatActiveHours as SharedLocalHeartbeatActiveHours,
  LocalCronJobRecord as SharedLocalCronJobRecord,
  LocalHeartbeatConfigRecord as SharedLocalHeartbeatConfigRecord,
  ScheduledConversationEvent as SharedScheduledConversationEvent,
  VoiceRuntimeSnapshot as SharedVoiceRuntimeSnapshot,
  SocialSessionRuntimeRecord as SharedSocialSessionRuntimeRecord,
  SocialSessionServiceSnapshot as SharedSocialSessionServiceSnapshot,
} from "../contracts/boundary";
import type {
  DiscoveryCategory,
  DiscoveryKnowledgeSeedPayload,
} from "@/shared/contracts/discovery";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "../contracts/onboarding";
import type { RuntimeSocialSessionStatus } from "../../../../runtime/protocol/index";
import type {
  OfficePreviewRef as SharedOfficePreviewRef,
  OfficePreviewSnapshot as SharedOfficePreviewSnapshot,
} from "../contracts/office-preview";
import type {
  BackupNowResult as SharedBackupNowResult,
  BackupStatusSnapshot as SharedBackupStatusSnapshot,
  BackupSummary as SharedBackupSummary,
  RestoreBackupResult as SharedRestoreBackupResult,
} from "../contracts/backup";

export type ChatContext = SharedChatContext;
export type ChatContextFile = SharedChatContextFile;
export type ChatContextUpdate = SharedChatContextUpdate;
export type MiniBridgeEventRecord = SharedMiniBridgeEventRecord;
export type MiniBridgeSnapshot = SharedMiniBridgeSnapshot;
export type MiniBridgeRequest = SharedMiniBridgeRequest;
export type MiniBridgeResponse = SharedMiniBridgeResponse;
export type MiniBridgeRequestEnvelope = SharedMiniBridgeRequestEnvelope;
export type MiniBridgeResponseEnvelope = SharedMiniBridgeResponseEnvelope;
export type MiniBridgeUpdate = SharedMiniBridgeUpdate;
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
export type SelfModFeatureRecord = SharedSelfModFeatureRecord;
export type SelfModBatchRecord = SharedSelfModBatchRecord;
export type StoreReleaseDraft = SharedStoreReleaseDraft;
export type StoreReleaseArtifact = SharedStoreReleaseArtifact;
export type StoreReleaseManifest = SharedStoreReleaseManifest;
export type StorePackageRecord = SharedStorePackageRecord;
export type StorePackageReleaseRecord = SharedStorePackageReleaseRecord;
export type InstalledStoreModRecord = SharedInstalledStoreModRecord;
export type SelfModHmrPhase = SharedSelfModHmrPhase;
export type SelfModHmrState = SharedSelfModHmrState;
export type AgentHealth = SharedAgentHealth;
export type LocalLlmCredentialSummary = SharedLocalLlmCredentialSummary;
export type LocalCronSchedule = SharedLocalCronSchedule;
export type LocalCronPayload = SharedLocalCronPayload;
export type LocalHeartbeatActiveHours = SharedLocalHeartbeatActiveHours;
export type LocalCronJobRecord = SharedLocalCronJobRecord;
export type LocalHeartbeatConfigRecord = SharedLocalHeartbeatConfigRecord;
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
  restoreSize: () => void;
  isMaximized: () => Promise<boolean>;
  show: (target: WindowMode) => void;
};

export type ElectronUiApi = {
  getState: () => Promise<UiState>;
  setState: (partial: Partial<UiState>) => Promise<UiState>;
  onState: (callback: (state: UiState) => void) => () => void;
  onOpenChatSidebar: (callback: () => void) => () => void;
  setAppReady: (ready: boolean) => void;
  reload: () => void;
  hardReset: () => Promise<{ ok: boolean }>;
  morphStart: () => Promise<{ ok: boolean }>;
  morphComplete: () => Promise<{ ok: boolean }>;
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
  visionScreenshots: (point?: { x: number; y: number }) => Promise<Array<{
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
  }>>;
  removeScreenshot: (index: number) => void;
  submitRegionSelection: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  submitRegionClick: (point: { x: number; y: number }) => void;
  pageDataUrl: () => Promise<string | null>;
  getWindowCapture: (point: { x: number; y: number }) => Promise<{
    bounds: { x: number; y: number; width: number; height: number };
    thumbnail: string;
  } | null>;
  cursorDisplayInfo: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
  }>;
  cancelRegion: () => void;
  onRegionReset: (callback: () => void) => () => void;
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
  onShowMini: (
    callback: (data: { x: number; y: number }) => void,
  ) => () => void;
  onHideMini: (callback: () => void) => () => void;
  onRestoreMini?: (callback: () => void) => () => void;
  onShowVoice: (
    callback: (data: { x: number; y: number; mode: "realtime" }) => void,
  ) => () => void;
  onHideVoice: (callback: () => void) => () => void;
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

export type ElectronMiniApi = {
  onVisibility: (callback: (visible: boolean) => void) => () => void;
  onDismissPreview: (callback: () => void) => () => void;
  request: (request: MiniBridgeRequest) => Promise<MiniBridgeResponse>;
  onUpdate: (callback: (update: MiniBridgeUpdate) => void) => () => void;
  onRequest: (
    callback: (envelope: MiniBridgeRequestEnvelope) => void,
  ) => () => void;
  respond: (envelope: MiniBridgeResponseEnvelope) => void;
  ready: () => void;
  pushUpdate: (update: MiniBridgeUpdate) => void;
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
  getRuntimeState: () => Promise<VoiceRuntimeSnapshot>;
  onRuntimeState: (
    callback: (state: VoiceRuntimeSnapshot) => void,
  ) => () => void;
  pushRuntimeState: (state: VoiceRuntimeSnapshot) => void;
  setRtcShortcut: (
    shortcut: string,
  ) => Promise<VoiceShortcutRegistrationResult>;
};

export type ElectronAgentApi = {
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
    mode?: string;
    messageMetadata?: Record<string, unknown>;
    attachments?: Array<{
      url: string;
      mimeType?: string;
    }>;
    agentType?: string;
    storageMode?: "cloud" | "local";
  }) => Promise<{ requestId: string }>;
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
      taskId: string;
      agentType?: string;
      description?: string;
      anchorTurnId?: string;
      parentTaskId?: string;
      status: "running" | "completed" | "error" | "canceled";
      statusText?: string;
      reasoningText?: string;
      result?: string;
      error?: string;
    }>;
  }>;
  onStream: (callback: (event: AgentStreamIpcEvent) => void) => () => void;
  onSelfModHmrState: (callback: (event: SelfModHmrState) => void) => () => void;
  selfModRevert: (featureId?: string, steps?: number) => Promise<unknown>;
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
  completeRuntimeAuthRefresh: (payload: {
    requestId: string;
    authenticated: boolean;
    token?: string;
    hasConnectedAccount?: boolean;
  }) => Promise<{ ok: boolean; accepted?: boolean }>;
  setCloudSyncEnabled: (payload: {
    enabled: boolean;
  }) => Promise<{ ok: boolean }>;
  onAuthCallback: (callback: (data: { url: string }) => void) => () => void;
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
  openExternal: (url: string) => void;
  showItemInFolder: (filePath: string) => void;
  shellKillByPort: (port: number) => Promise<void>;
  getLocalSyncMode: () => Promise<string>;
  setLocalSyncMode: (mode: string) => Promise<void>;
  getBackupStatus: () => Promise<BackupStatusSnapshot>;
  backUpNow: () => Promise<BackupNowResult>;
  listBackups: (limit?: number) => Promise<BackupSummary[]>;
  restoreBackup: (snapshotId: string) => Promise<RestoreBackupResult>;
  syncLocalModelPreferences: (payload: {
    defaultModels: Record<string, string>;
    resolvedDefaultModels: Record<string, string>;
    modelOverrides: Record<string, string>;
    generalAgentEngine: "default" | "claude_code_local";
    selfModAgentEngine: "default" | "claude_code_local";
    maxAgentConcurrency: number;
  }) => Promise<{ ok: boolean }>;
  listLlmCredentials: () => Promise<LocalLlmCredentialSummary[]>;
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
};

export type ElectronOnboardingApi = {
  synthesizeCoreMemory: (
    payload: OnboardingSynthesisRequest,
  ) => Promise<OnboardingSynthesisResponse>;
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
  onUpdated: (callback: () => void) => () => void;
};

export type ElectronStoreApi = {
  listSelfModFeatures: (limit?: number) => Promise<SelfModFeatureRecord[]>;
  listFeatureBatches: (featureId: string) => Promise<SelfModBatchRecord[]>;
  getReleaseDraft: (payload: {
    featureId: string;
    batchIds?: string[];
  }) => Promise<StoreReleaseDraft>;
  publishRelease: (payload: {
    featureId: string;
    packageId?: string;
    displayName?: string;
    description?: string;
    releaseNotes?: string;
    batchIds?: string[];
  }) => Promise<StorePackageReleaseRecord>;
  listPackages: () => Promise<StorePackageRecord[]>;
  getPackage: (packageId: string) => Promise<StorePackageRecord | null>;
  listPackageReleases: (
    packageId: string,
  ) => Promise<StorePackageReleaseRecord[]>;
  getPackageRelease: (payload: {
    packageId: string;
    releaseNumber: number;
  }) => Promise<StorePackageReleaseRecord | null>;
  listInstalledMods: () => Promise<InstalledStoreModRecord[]>;
  installRelease: (payload: {
    packageId: string;
    releaseNumber?: number;
  }) => Promise<InstalledStoreModRecord>;
  uninstallPackage: (packageId: string) => Promise<{
    packageId: string;
    revertedCommits: string[];
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
  listEvents: (payload: {
    conversationId: string;
    maxItems?: number;
    windowBy?: LocalChatEventWindowMode;
  }) => Promise<EventRecord[]>;
  getEventCount: (payload: {
    conversationId: string;
    countBy?: LocalChatEventWindowMode;
  }) => Promise<number>;
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
  onUpdated: (callback: () => void) => () => void;
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
  /**
   * Subscribe to one-shot suggestion-pin events from the main process
   * (e.g. cmd+right-click → "Open chat" surfaces the right-clicked window
   * as a sidebar suggestion). The renderer's auto-context chip strip
   * absorbs these into the next available slot.
   */
  onPinSuggestion: (
    callback: (payload: {
      chip:
        | {
            kind: "app";
            pid: number;
            name: string;
            bundleId?: string;
            isActive: boolean;
            windowTitle?: string;
          }
        | {
            kind: "tab";
            browser: string;
            bundleId: string;
            url: string;
            title?: string;
            host: string;
          };
    }) => void,
  ) => () => void;
};

export type ElectronScreenGuideApi = {
  show: (annotations: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
  }>) => void;
  hide: () => void;
};

// ---------------------------------------------------------------------------
// Main ElectronApi â€” composed from namespaced sub-types
// ---------------------------------------------------------------------------

export type ElectronDisplayApi = {
  onUpdate: (callback: (html: string) => void) => () => void;
};

export type ElectronOfficePreviewApi = {
  list: () => Promise<OfficePreviewSnapshot[]>;
  onUpdate: (callback: (snapshot: OfficePreviewSnapshot) => void) => () => void;
};

export type ElectronApi = {
  platform: string;
  display: ElectronDisplayApi;
  officePreview: ElectronOfficePreviewApi;
  window: ElectronWindowApi;
  ui: ElectronUiApi;
  capture: ElectronCaptureApi;
  overlay: ElectronOverlayApi;
  screenGuide: ElectronScreenGuideApi;
  mini: ElectronMiniApi;
  theme: ElectronThemeApi;
  voice: ElectronVoiceApi;
  agent: ElectronAgentApi;
  system: ElectronSystemApi;
  onboarding: ElectronOnboardingApi;
  discovery: ElectronDiscoveryApi;
  browser: ElectronBrowserApi;
  media: {
    saveOutput: (
      url: string,
      fileName: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    getStellaMediaDir: () => Promise<string | null>;
  };
  schedule: ElectronScheduleApi;
  store: ElectronStoreApi;
  socialSessions: ElectronSocialSessionsApi;
  localChat: ElectronLocalChatApi;
  googleWorkspace: ElectronGoogleWorkspaceApi;
  home: ElectronHomeApi;
};

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

export {};
