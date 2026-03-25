import type { UiState, WindowMode } from "./ui";
import type { Theme } from "@/shared/theme/themes/types";
import type { AgentStreamEvent } from "@/app/chat/streaming/streaming-types";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { ChatMessage } from "@/infra/ai/llm";
import type {
  RadialWedge as SharedRadialWedge,
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
  DevProject as SharedDevProject,
  LocalDevProjectRecord as SharedLocalDevProjectRecord,
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
import type { DiscoveryCategory } from "@/shared/contracts/discovery";

export type RadialWedge = SharedRadialWedge;
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
export type DevProject = SharedDevProject;
export type LocalDevProjectRecord = SharedLocalDevProjectRecord;
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
  show: (target: WindowMode) => void;
};

export type ElectronUiApi = {
  getState: () => Promise<UiState>;
  setState: (partial: Partial<UiState>) => Promise<UiState>;
  onState: (callback: (state: UiState) => void) => () => void;
  setAppReady: (ready: boolean) => void;
  reload: () => void;
  hardReset: () => Promise<{ ok: boolean }>;
  morphStart: () => Promise<{ ok: boolean }>;
  morphComplete: () => Promise<{ ok: boolean }>;
};

export type ElectronCaptureApi = {
  getContext: () => Promise<ChatContext | null>;
  onContext: (
    callback: (payload: ChatContextUpdate | null) => void,
  ) => () => void;
  ackContext: (payload: { version: number }) => void;
  screenshot: (point?: { x: number; y: number }) => Promise<{
    dataUrl: string;
    width: number;
    height: number;
  } | null>;
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
  cancelRegion: () => void;
  onRegionReset: (callback: () => void) => () => void;
};

export type ElectronRadialApi = {
  onShow: (
    callback: (
      event: unknown,
      data: { centerX: number; centerY: number; x?: number; y?: number },
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
  onModifierBlock: (callback: (active: boolean) => void) => () => void;
  onStartRegionCapture: (callback: () => void) => () => void;
  onEndRegionCapture: (callback: () => void) => () => void;
  onShowMini: (
    callback: (data: { x: number; y: number }) => void,
  ) => () => void;
  onHideMini: (callback: () => void) => () => void;
  onRestoreMini?: (callback: () => void) => () => void;
  onShowVoice: (
    callback: (data: {
      x: number;
      y: number;
      mode: "stt" | "realtime";
    }) => void,
  ) => () => void;
  onHideVoice: (callback: () => void) => () => void;
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
  onShowAutoPanel: (
    callback: (data: {
      x: number;
      y: number;
      width: number;
      height: number;
      windowText: string;
      windowTitle: string | null;
    }) => void,
  ) => () => void;
  onHideAutoPanel: (callback: () => void) => () => void;
  hideAutoPanel: () => void;
  startAutoPanelStream: (payload: {
    requestId: string;
    agentType?: string;
    messages: ChatMessage[];
  }) => Promise<{ ok: boolean }>;
  cancelAutoPanelStream: (requestId: string) => void;
  onAutoPanelChunk: (
    callback: (data: { requestId: string; chunk: string }) => void,
  ) => () => void;
  onAutoPanelComplete: (
    callback: (data: { requestId: string; text: string }) => void,
  ) => () => void;
  onAutoPanelError: (
    callback: (data: { requestId: string; error: string }) => void,
  ) => () => void;
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
  submitTranscript: (transcript: string) => void;
  setShortcut: (shortcut: string) => Promise<VoiceShortcutRegistrationResult>;
  onTranscript: (callback: (transcript: string) => void) => () => void;
  persistTranscript: (payload: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
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
  getWakeWordState: () => Promise<{ enabled: boolean }>;
  onWakeWordState: (
    callback: (state: { enabled: boolean }) => void,
  ) => () => void;
  onWakeWordDetected: (
    callback: (payload: { detectedAt: number }) => void,
  ) => () => void;
  pushWakeWordAudio: (buffer: ArrayBuffer) => void;
  pushRuntimeState: (state: VoiceRuntimeSnapshot) => void;
  setRtcShortcut: (
    shortcut: string,
  ) => Promise<VoiceShortcutRegistrationResult>;
};

export type ElectronAgentApi = {
  healthCheck: () => Promise<AgentHealth | null>;
  getActiveRun: () => Promise<{ runId: string; conversationId: string } | null>;
  getAppSessionStartedAt: () => Promise<number>;
  startChat: (payload: {
    conversationId: string;
    userPrompt: string;
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
  }) => Promise<{ runId: string; userMessageId: string }>;
  cancelChat: (runId: string) => void;
  resumeStream: (payload: { runId: string; lastSeq: number }) => Promise<{
    events: AgentStreamIpcEvent[];
    exhausted: boolean;
  }>;
  onStream: (callback: (event: AgentStreamIpcEvent) => void) => () => void;
  onSelfModHmrState: (callback: (event: SelfModHmrState) => void) => () => void;
  selfModRevert: (featureId?: string, steps?: number) => Promise<unknown>;
  getLastSelfModFeature: () => Promise<string | null>;
  listSelfModFeatures: (limit?: number) => Promise<SelfModFeatureSummary[]>;
  startPersonalWebsiteGeneration: (payload: {
    conversationId: string;
    coreMemory: string;
    promptConfig: { systemPrompt: string; userPromptTemplate: string };
  }) => Promise<void>;
  triggerViteError: () => Promise<{ ok: boolean }>;
  fixViteError: () => Promise<{ ok: boolean }>;
};

export type ElectronSystemApi = {
  getDeviceId: () => Promise<string | null>;
  configurePiRuntime: (config: {
    convexUrl?: string;
    convexSiteUrl?: string;
  }) => Promise<{ deviceId: string | null }>;
  setAuthState: (payload: {
    authenticated: boolean;
    token?: string;
  }) => Promise<{ ok: boolean }>;
  setCloudSyncEnabled: (payload: {
    enabled: boolean;
  }) => Promise<{ ok: boolean }>;
  onAuthCallback: (callback: (data: { url: string }) => void) => () => void;
  openFullDiskAccess: () => void;
  openExternal: (url: string) => void;
  showItemInFolder: (filePath: string) => void;
  shellKillByPort: (port: number) => Promise<void>;
  getLocalSyncMode: () => Promise<string>;
  setLocalSyncMode: (mode: string) => Promise<void>;
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
  getIdentityMap: () => Promise<{
    version: number;
    mappings: {
      real: { name: string; identifier: string };
      alias: { name: string; identifier: string };
      source: string;
    }[];
  }>;
  depseudonymize: (text: string) => Promise<string>;
};

export type ElectronBrowserApi = {
  onBridgeStatus: (callback: (status: {
    state: "connecting" | "connected" | "reconnecting";
    attempt: number;
    nextRetryMs?: number;
    error?: string;
    notifyUser?: boolean;
  }) => void) => () => void;
  checkCoreMemoryExists: () => Promise<boolean>;
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
  collectData: (options?: {
    selectedBrowser?: string;
    selectedProfile?: string;
  }) => Promise<BrowserDataResult>;
  detectPreferred: () => Promise<PreferredBrowserProfile>;
  listProfiles: (browserType: string) => Promise<BrowserProfile[]>;
  writeCoreMemory: (
    content: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  writeHomeCanvas: (
    content: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  collectAllSignals: (options?: {
    categories?: DiscoveryCategory[];
    selectedBrowser?: string;
    selectedProfile?: string;
  }) => Promise<AllUserSignalsResult>;
};

export type ElectronProjectsApi = {
  list: () => Promise<LocalDevProjectRecord[]>;
  pickDirectory: () => Promise<{
    canceled: boolean;
    projects: LocalDevProjectRecord[];
    selectedProjectId?: string;
  }>;
  start: (projectId: string) => Promise<LocalDevProjectRecord[]>;
  stop: (projectId: string) => Promise<LocalDevProjectRecord[]>;
  onChanged: (
    callback: (projects: LocalDevProjectRecord[]) => void,
  ) => () => void;
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
  getStatus: () => Promise<SocialSessionServiceSnapshot>;
};

export type ElectronLocalChatApi = {
  getOrCreateDefaultConversationId: () => Promise<string>;
  listEvents: (payload: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<EventRecord[]>;
  getEventCount: (payload: { conversationId: string }) => Promise<number>;
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
// Main ElectronApi â€” composed from namespaced sub-types
// ---------------------------------------------------------------------------

export type ElectronDisplayApi = {
  onUpdate: (callback: (html: string) => void) => () => void;
};

export type ElectronApi = {
  platform: string;
  display: ElectronDisplayApi;
  window: ElectronWindowApi;
  ui: ElectronUiApi;
  capture: ElectronCaptureApi;
  radial: ElectronRadialApi;
  overlay: ElectronOverlayApi;
  mini: ElectronMiniApi;
  theme: ElectronThemeApi;
  voice: ElectronVoiceApi;
  agent: ElectronAgentApi;
  system: ElectronSystemApi;
  browser: ElectronBrowserApi;
  media: {
    saveOutput: (url: string, fileName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    getStellaMediaDir: () => Promise<string | null>;
  };
  projects: ElectronProjectsApi;
  schedule: ElectronScheduleApi;
  store: ElectronStoreApi;
  socialSessions: ElectronSocialSessionsApi;
  localChat: ElectronLocalChatApi;
};

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

export {};
