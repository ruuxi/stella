import { Type, type Static } from "@sinclair/typebox";
import type {
  AgentHealth,
  InstalledStoreModRecord,
  LocalCronJobRecord,
  LocalDevProjectRecord,
  LocalHeartbeatConfigRecord,
  ScheduledConversationEvent,
  SelfModFeatureSummary,
  SelfModBatchRecord,
  SelfModFeatureRecord,
  SelfModHmrState,
  SocialSessionRuntimeRecord,
  SocialSessionServiceSnapshot,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseDraft,
} from "../boundary-contracts/index.js";

export type {
  AgentHealth,
  InstalledStoreModRecord,
  LocalCronJobRecord,
  LocalDevProjectRecord,
  LocalHeartbeatConfigRecord,
  ScheduledConversationEvent,
  SelfModFeatureSummary,
  SelfModBatchRecord,
  SelfModFeatureRecord,
  SelfModHmrState,
  SocialSessionRuntimeRecord,
  SocialSessionServiceSnapshot,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseDraft,
};

export const STELLA_RUNTIME_PROTOCOL_VERSION = "v1";

export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32_700,
  INVALID_REQUEST: -32_600,
  METHOD_NOT_FOUND: -32_601,
  INVALID_PARAMS: -32_602,
  INTERNAL_ERROR: -32_603,
  OVERLOADED: -32_700 - 100,
  RUNTIME_UNAVAILABLE: -32_700 - 101,
} as const;

export const METHOD_NAMES = {
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",
  RUNTIME_CONFIGURE: "runtime.configure",
  RUNTIME_HEALTH: "runtime.health",
  RUNTIME_RELOAD_CAPABILITIES: "runtime.reloadCapabilities",
  RUNTIME_RESTART_WORKER: "runtime.restartWorker",
  RUN_HEALTH_CHECK: "run.healthCheck",
  RUN_GET_ACTIVE: "run.getActive",
  RUN_START_CHAT: "run.startChat",
  RUN_CANCEL: "run.cancel",
  RUN_RESUME_EVENTS: "run.resumeEvents",
  RUN_AUTOMATION: "run.automation",
  TASK_RUN_BLOCKING: "task.runBlocking",
  TASK_CREATE_BACKGROUND: "task.createBackground",
  TASK_GET_SNAPSHOT: "task.getSnapshot",
  SEARCH_WEB: "search.web",
  VOICE_PERSIST_TRANSCRIPT: "voice.persistTranscript",
  THREAD_APPEND_MESSAGE: "thread.appendMessage",
  LOCAL_CHAT_GET_OR_CREATE_DEFAULT: "localChat.getOrCreateDefaultConversationId",
  LOCAL_CHAT_LIST_EVENTS: "localChat.listEvents",
  LOCAL_CHAT_GET_EVENT_COUNT: "localChat.getEventCount",
  LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME: "localChat.persistDiscoveryWelcome",
  LOCAL_CHAT_LIST_SYNC_MESSAGES: "localChat.listSyncMessages",
  LOCAL_CHAT_GET_SYNC_CHECKPOINT: "localChat.getSyncCheckpoint",
  LOCAL_CHAT_SET_SYNC_CHECKPOINT: "localChat.setSyncCheckpoint",
  STORE_MODS_LIST_FEATURES: "storeMods.listLocalFeatures",
  STORE_MODS_LIST_BATCHES: "storeMods.listFeatureBatches",
  STORE_MODS_CREATE_RELEASE_DRAFT: "storeMods.createReleaseDraft",
  STORE_MODS_LIST_INSTALLED: "storeMods.listInstalledMods",
  STORE_LIST_PACKAGES: "store.listPackages",
  STORE_GET_PACKAGE: "store.getPackage",
  STORE_LIST_RELEASES: "store.listReleases",
  STORE_GET_RELEASE: "store.getRelease",
  STORE_CREATE_FIRST_RELEASE: "store.createFirstRelease",
  STORE_CREATE_RELEASE_UPDATE: "store.createReleaseUpdate",
  STORE_PUBLISH_RELEASE: "store.publishRelease",
  STORE_INSTALL_RELEASE: "store.installRelease",
  STORE_UNINSTALL_MOD: "store.uninstallMod",
  SCHEDULE_LIST_CRON_JOBS: "schedule.listCronJobs",
  SCHEDULE_LIST_HEARTBEATS: "schedule.listHeartbeats",
  SCHEDULE_LIST_EVENTS: "schedule.listConversationEvents",
  SCHEDULE_GET_EVENT_COUNT: "schedule.getConversationEventCount",
  SOCIAL_SESSIONS_GET_STATUS: "socialSessions.getStatus",
  PROJECTS_LIST: "projects.list",
  PROJECTS_REGISTER_DIRECTORY: "projects.registerDirectory",
  PROJECTS_START: "projects.start",
  PROJECTS_STOP: "projects.stop",
  OVERLAY_AUTO_PANEL_START: "overlay.autoPanel.start",
  OVERLAY_AUTO_PANEL_CANCEL: "overlay.autoPanel.cancel",
  SELF_MOD_REVERT: "selfMod.revert",
  SELF_MOD_LAST_FEATURE: "selfMod.lastFeature",
  SELF_MOD_RECENT_FEATURES: "selfMod.recentFeatures",
  COMMAND_LIST: "command.list",
  COMMAND_RUN: "command.run",
  SHELL_KILL_ALL: "shell.killAll",
  SHELL_KILL_BY_PORT: "shell.killByPort",
  DISCOVERY_COLLECT_BROWSER_DATA: "discovery.collectBrowserData",
  DISCOVERY_COLLECT_ALL_SIGNALS: "discovery.collectAllSignals",
  DISCOVERY_CORE_MEMORY_EXISTS: "discovery.coreMemoryExists",
  DISCOVERY_WRITE_CORE_MEMORY: "discovery.writeCoreMemory",
  DISCOVERY_DETECT_PREFERRED_BROWSER: "discovery.detectPreferredBrowser",
  DISCOVERY_LIST_BROWSER_PROFILES: "discovery.listBrowserProfiles",
  HOST_UI_SNAPSHOT: "host.ui.snapshot",
  HOST_UI_ACT: "host.ui.act",
  HOST_DEVICE_IDENTITY_GET: "host.deviceIdentity.get",
  HOST_DEVICE_HEARTBEAT_SIGN: "host.deviceHeartbeat.sign",
  HOST_CREDENTIALS_REQUEST: "host.credentials.request",
  HOST_DISPLAY_UPDATE: "host.display.update",
  HOST_NOTIFICATION_SHOW: "host.notification.show",
  HOST_SYSTEM_OPEN_EXTERNAL: "host.system.openExternal",
  HOST_WINDOW_SHOW: "host.window.show",
  HOST_WINDOW_FOCUS: "host.window.focus",
  HOST_HMR_RUN_TRANSITION: "host.hmr.runTransition",
  INTERNAL_WORKER_INITIALIZE: "internal.worker.initialize",
  INTERNAL_WORKER_CONFIGURE: "internal.worker.configure",
  INTERNAL_WORKER_HEALTH: "internal.worker.health",
  INTERNAL_WORKER_RELOAD_CAPABILITIES: "internal.worker.reloadCapabilities",
  INTERNAL_WORKER_GET_ACTIVE: "internal.worker.getActive",
  INTERNAL_WORKER_START_CHAT: "internal.worker.startChat",
  INTERNAL_WORKER_CANCEL: "internal.worker.cancel",
  INTERNAL_WORKER_RUN_AUTOMATION: "internal.worker.runAutomation",
  INTERNAL_WORKER_RUN_BLOCKING_TASK: "internal.worker.runBlockingTask",
  INTERNAL_WORKER_CREATE_BACKGROUND_TASK: "internal.worker.createBackgroundTask",
  INTERNAL_WORKER_GET_TASK_SNAPSHOT: "internal.worker.getTaskSnapshot",
  INTERNAL_WORKER_APPEND_THREAD_MESSAGE: "internal.worker.appendThreadMessage",
  INTERNAL_WORKER_WEB_SEARCH: "internal.worker.webSearch",
  INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT:
    "internal.worker.voice.persistTranscript",
  INTERNAL_WORKER_VOICE_EXECUTE_TOOL:
    "internal.worker.voice.executeTool",
  INTERNAL_WORKER_LIST_STORE_PACKAGES: "internal.worker.listStorePackages",
  INTERNAL_WORKER_GET_STORE_PACKAGE: "internal.worker.getStorePackage",
  INTERNAL_WORKER_LIST_STORE_RELEASES: "internal.worker.listStoreReleases",
  INTERNAL_WORKER_GET_STORE_RELEASE: "internal.worker.getStoreRelease",
  INTERNAL_WORKER_CREATE_FIRST_STORE_RELEASE: "internal.worker.createFirstStoreRelease",
  INTERNAL_WORKER_CREATE_STORE_RELEASE_UPDATE: "internal.worker.createStoreReleaseUpdate",
  INTERNAL_WORKER_PUBLISH_STORE_RELEASE: "internal.worker.publishStoreRelease",
  INTERNAL_WORKER_INSTALL_STORE_RELEASE: "internal.worker.installStoreRelease",
  INTERNAL_WORKER_UNINSTALL_STORE_MOD: "internal.worker.uninstallStoreMod",
  INTERNAL_WORKER_LIST_COMMANDS: "internal.worker.listCommands",
  INTERNAL_WORKER_RUN_COMMAND: "internal.worker.runCommand",
  INTERNAL_WORKER_RESUME_HMR: "internal.worker.resumeHmr",
  INTERNAL_WORKER_KILL_ALL_SHELLS: "internal.worker.killAllShells",
  INTERNAL_WORKER_KILL_SHELL_BY_PORT: "internal.worker.killShellByPort",
  INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT:
    "internal.worker.localChat.getOrCreateDefaultConversationId",
  INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS: "internal.worker.localChat.listEvents",
  INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT: "internal.worker.localChat.getEventCount",
  INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME:
    "internal.worker.localChat.persistDiscoveryWelcome",
  INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES:
    "internal.worker.localChat.listSyncMessages",
  INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT:
    "internal.worker.localChat.getSyncCheckpoint",
  INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT:
    "internal.worker.localChat.setSyncCheckpoint",
  INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA:
    "internal.worker.discovery.collectBrowserData",
  INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS:
    "internal.worker.discovery.collectAllSignals",
  INTERNAL_WORKER_STORE_MODS_LIST_FEATURES: "internal.worker.storeMods.listLocalFeatures",
  INTERNAL_WORKER_STORE_MODS_LIST_BATCHES: "internal.worker.storeMods.listFeatureBatches",
  INTERNAL_WORKER_STORE_MODS_CREATE_RELEASE_DRAFT:
    "internal.worker.storeMods.createReleaseDraft",
  INTERNAL_WORKER_STORE_MODS_LIST_INSTALLED: "internal.worker.storeMods.listInstalledMods",
  INTERNAL_WORKER_SCHEDULE_LIST_CRON_JOBS: "internal.worker.schedule.listCronJobs",
  INTERNAL_WORKER_SCHEDULE_LIST_HEARTBEATS: "internal.worker.schedule.listHeartbeats",
  INTERNAL_WORKER_SCHEDULE_LIST_EVENTS:
    "internal.worker.schedule.listConversationEvents",
  INTERNAL_WORKER_SCHEDULE_GET_EVENT_COUNT:
    "internal.worker.schedule.getConversationEventCount",
  INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS:
    "internal.worker.socialSessions.getStatus",
  INTERNAL_WORKER_PROJECTS_LIST: "internal.worker.projects.list",
  INTERNAL_WORKER_PROJECTS_REGISTER_DIRECTORY:
    "internal.worker.projects.registerDirectory",
  INTERNAL_WORKER_PROJECTS_START: "internal.worker.projects.start",
  INTERNAL_WORKER_PROJECTS_STOP: "internal.worker.projects.stop",
  INTERNAL_WORKER_OVERLAY_AUTO_PANEL_START:
    "internal.worker.overlay.autoPanel.start",
  INTERNAL_WORKER_OVERLAY_AUTO_PANEL_CANCEL:
    "internal.worker.overlay.autoPanel.cancel",
  INTERNAL_WORKER_SELF_MOD_REVERT: "internal.worker.selfMod.revert",
  INTERNAL_WORKER_SELF_MOD_LAST_FEATURE: "internal.worker.selfMod.lastFeature",
  INTERNAL_WORKER_SELF_MOD_RECENT_FEATURES:
    "internal.worker.selfMod.recentFeatures",
  INTERNAL_STORE_LOAD_THREAD_MESSAGES: "internal.store.loadThreadMessages",
  INTERNAL_STORE_LIST_ACTIVE_THREADS: "internal.store.listActiveThreads",
  INTERNAL_STORE_GET_ORCHESTRATOR_REMINDER_STATE: "internal.store.getOrchestratorReminderState",
  INTERNAL_STORE_RESOLVE_OR_CREATE_ACTIVE_THREAD: "internal.store.resolveOrCreateActiveThread",
  INTERNAL_STORE_APPEND_THREAD_MESSAGE: "internal.store.appendThreadMessage",
  INTERNAL_STORE_ARCHIVE_THREAD: "internal.store.archiveThread",
  INTERNAL_STORE_REPLACE_THREAD_MESSAGES: "internal.store.replaceThreadMessages",
  INTERNAL_STORE_UPDATE_THREAD_SUMMARY: "internal.store.updateThreadSummary",
  INTERNAL_STORE_UPDATE_ORCHESTRATOR_REMINDER_COUNTER: "internal.store.updateOrchestratorReminderCounter",
  INTERNAL_STORE_RECORD_RUN_EVENT: "internal.store.recordRunEvent",
  INTERNAL_STORE_SAVE_MEMORY: "internal.store.saveMemory",
  INTERNAL_STORE_RECALL_MEMORIES: "internal.store.recallMemories",
  INTERNAL_STORE_LIST_LOCAL_CHAT_EVENTS: "internal.store.listLocalChatEvents",
  INTERNAL_STORE_BEGIN_SELF_MOD_RUN: "internal.store.beginSelfModRun",
  INTERNAL_STORE_FINALIZE_SELF_MOD_RUN: "internal.store.finalizeSelfModRun",
  INTERNAL_STORE_CANCEL_SELF_MOD_RUN: "internal.store.cancelSelfModRun",
  INTERNAL_SCHEDULE_LIST_CRON_JOBS: "internal.schedule.listCronJobs",
  INTERNAL_SCHEDULE_ADD_CRON_JOB: "internal.schedule.addCronJob",
  INTERNAL_SCHEDULE_UPDATE_CRON_JOB: "internal.schedule.updateCronJob",
  INTERNAL_SCHEDULE_REMOVE_CRON_JOB: "internal.schedule.removeCronJob",
  INTERNAL_SCHEDULE_RUN_CRON_JOB: "internal.schedule.runCronJob",
  INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG: "internal.schedule.getHeartbeatConfig",
  INTERNAL_SCHEDULE_UPSERT_HEARTBEAT: "internal.schedule.upsertHeartbeat",
  INTERNAL_SCHEDULE_RUN_HEARTBEAT: "internal.schedule.runHeartbeat",
  INTERNAL_CAPABILITY_STATE_GET: "internal.capabilityState.get",
  INTERNAL_CAPABILITY_STATE_SET: "internal.capabilityState.set",
  INTERNAL_CAPABILITY_STATE_APPEND_EVENT: "internal.capabilityState.appendEvent",
} as const;

export const NOTIFICATION_NAMES = {
  RUNTIME_READY: "runtime.ready",
  RUNTIME_RELOADING: "runtime.reloading",
  RUNTIME_LAGGED: "runtime.lagged",
  RUN_EVENT: "run.event",
  RUN_SELF_MOD_HMR_STATE: "run.selfModHmrState",
  VOICE_AGENT_EVENT: "voice.agentEvent",
  VOICE_SELF_MOD_HMR_STATE: "voice.selfModHmrState",
  LOCAL_CHAT_UPDATED: "localChat.updated",
  SCHEDULE_UPDATED: "schedule.updated",
  PROJECTS_UPDATED: "projects.updated",
  OVERLAY_AUTO_PANEL_EVENT: "overlay.autoPanel.event",
  CAPABILITY_CHANGED: "capability.changed",
  APPROVAL_REQUESTED: "approval.requested",
} as const;

export type RuntimeInitializeParams = {
  clientName: string;
  clientVersion: string;
  platform: NodeJS.Platform;
  protocolVersion: string;
  isDev: boolean;
  frontendRoot: string;
  stellaHomePath: string;
  stellaWorkspacePath: string;
};

export type RuntimeInitializeResult = {
  protocolVersion: string;
  hostPid: number;
};

export type RuntimeConfigureParams = {
  convexUrl?: string | null;
  convexSiteUrl?: string | null;
  authToken?: string | null;
  cloudSyncEnabled?: boolean;
};

export type RuntimeHealthSnapshot = {
  ready: boolean;
  hostPid: number;
  workerPid: number | null;
  workerRunning?: boolean;
  workerGeneration: number;
  deviceId: string | null;
  activeRunId: string | null;
  activeTaskCount: number;
};

export type RuntimeAttachmentRef = {
  url: string;
  mimeType?: string;
};

export type RuntimeChatPayload = {
  conversationId: string;
  userPrompt: string;
  deviceId?: string;
  platform?: string;
  timezone?: string;
  mode?: string;
  messageMetadata?: Record<string, unknown>;
  attachments?: RuntimeAttachmentRef[];
  agentType?: string;
  storageMode?: "cloud" | "local";
};

export type RuntimeVoiceTranscriptPayload = {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
};

export type RuntimeOverlayChatMessage = {
  role: "system" | "user" | "assistant" | "developer";
  content: string | Array<{ type?: string; text?: string }>;
};

export type RuntimeOverlayAutoPanelStartPayload = {
  requestId: string;
  agentType?: string;
  messages?: RuntimeOverlayChatMessage[];
};

export type RuntimeOverlayAutoPanelEventPayload =
  | {
      requestId: string;
      kind: "chunk";
      chunk: string;
    }
  | {
      requestId: string;
      kind: "complete";
      text: string;
    }
  | {
      requestId: string;
      kind: "error";
      error: string;
    };

export type RuntimeActiveRun = {
  runId: string;
  conversationId: string;
};

export type RuntimeAutomationTurnRequest = {
  conversationId: string;
  userPrompt: string;
  agentType?: string;
};

export type RuntimeAutomationTurnResult =
  | { status: "ok"; finalText: string }
  | { status: "busy"; finalText: ""; error: string }
  | { status: "error"; finalText: ""; error: string };

export type RuntimeProjectDirectoryRegistrationResult = {
  projects: LocalDevProjectRecord[];
  selectedProjectId: string;
};

export type RuntimeSelfModRevertResult = {
  featureId: string;
  revertedCommitHashes: string[];
  message: string;
};

export type RuntimeTaskRequest = {
  conversationId: string;
  description: string;
  prompt: string;
  agentType?: string;
  selfModMetadata?: {
    featureId?: string;
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update";
    displayName?: string;
    description?: string;
  };
};

export type RuntimeTaskSnapshot = {
  id: string;
  status: "running" | "completed" | "error" | "canceled";
  description: string;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  recentActivity?: string[];
  messages?: Array<{
    from: "orchestrator" | "subagent";
    text: string;
    timestamp: number;
  }>;
};

export type RuntimeAgentEventPayload = {
  type: string;
  runId: string;
  seq: number;
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: { featureId: string; files: string[]; batchIndex: number };
  taskId?: string;
  agentType?: string;
  description?: string;
  parentTaskId?: string;
  result?: string;
  statusText?: string;
};

export type RuntimeVoiceAgentEventPayload = {
  requestId: string;
  event: RuntimeAgentEventPayload;
};

export type RuntimeVoiceHmrStatePayload = {
  requestId: string;
  runId?: string;
  state: SelfModHmrState;
};

export type RunResumeEventsResult = {
  events: RuntimeAgentEventPayload[];
  exhausted: boolean;
};

export type RuntimeWebSearchResult = {
  text: string;
  results: Array<{ title: string; url: string; snippet: string }>;
};

export type RuntimeCommandSummary = {
  id: string;
  description: string;
  sourcePath: string;
  capabilityRequirements?: string[];
  argumentHint?: string;
};

export type RuntimeCommandRunParams = {
  id: string;
  argv: string[];
  stdinText?: string | null;
};

export type RuntimeCommandRunResult = {
  exitCode: number;
  stdout: string;
  stderr?: string;
};

export type CapabilityStateScope = "global" | "conversation" | "run" | "task";

export type CapabilityStateValue = {
  moduleId: string;
  scope: CapabilityStateScope;
  entityId: string;
  key: string;
  jsonValue: unknown;
  updatedAt: number;
};

export type CapabilityStateEventRecord = {
  moduleId: string;
  scope: CapabilityStateScope;
  entityId: string;
  eventType: string;
  jsonValue: unknown;
  createdAt: number;
};

export type HostUiActParams =
  | { action: "click"; ref: string }
  | { action: "fill"; ref: string; value: string }
  | { action: "select"; ref: string; value: string };

export type HostDeviceIdentity = {
  deviceId: string;
  publicKey: string;
};

export type HostHeartbeatSignature = {
  publicKey: string;
  signature: string;
};

export type HostDisplayUpdateParams = {
  html: string;
};

export type HostWindowTarget = "mini" | "full";

export const initializeParamsSchema = Type.Object({
  clientName: Type.String({ minLength: 1 }),
  clientVersion: Type.String({ minLength: 1 }),
  platform: Type.String({ minLength: 1 }),
  protocolVersion: Type.String({ minLength: 1 }),
  isDev: Type.Boolean(),
  frontendRoot: Type.String({ minLength: 1 }),
  stellaHomePath: Type.String({ minLength: 1 }),
  stellaWorkspacePath: Type.String({ minLength: 1 }),
});

export const runtimeConfigureParamsSchema = Type.Object({
  convexUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  convexSiteUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  authToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cloudSyncEnabled: Type.Optional(Type.Boolean()),
});

export const commandRunParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  argv: Type.Array(Type.String()),
  stdinText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const protocolSchemas = {
  initializeParams: initializeParamsSchema,
  runtimeConfigureParams: runtimeConfigureParamsSchema,
  commandRunParams: commandRunParamsSchema,
} as const;

export type InitializeParamsSchema = Static<typeof initializeParamsSchema>;
export type RuntimeConfigureParamsSchema = Static<
  typeof runtimeConfigureParamsSchema
>;
export type CommandRunParamsSchema = Static<typeof commandRunParamsSchema>;

export type RuntimeProtocolSchemaExport = {
  version: string;
  schemas: typeof protocolSchemas;
};

export const runtimeProtocolSchema: RuntimeProtocolSchemaExport = {
  version: STELLA_RUNTIME_PROTOCOL_VERSION,
  schemas: protocolSchemas,
};

export type StorePublishArgs = {
  packageId: string;
  featureId: string;
  releaseNumber: number;
  displayName: string;
  description: string;
  releaseNotes?: string;
  manifest: StoreReleaseArtifact["manifest"];
  artifact: StoreReleaseArtifact;
};

export type RuntimeStoreApi = {
  listPackages: () => Promise<StorePackageRecord[]>;
  getPackage: (packageId: string) => Promise<StorePackageRecord | null>;
  listReleases: (packageId: string) => Promise<StorePackageReleaseRecord[]>;
  getRelease: (
    packageId: string,
    releaseNumber: number,
  ) => Promise<StorePackageReleaseRecord | null>;
  createFirstRelease: (
    args: StorePublishArgs,
  ) => Promise<StorePackageReleaseRecord>;
  createReleaseUpdate: (
    args: StorePublishArgs,
  ) => Promise<StorePackageReleaseRecord>;
};

export type RuntimeStoreModApi = {
  listLocalFeatures: (limit?: number) => Promise<SelfModFeatureRecord[]>;
  listFeatureBatches: (featureId: string) => Promise<SelfModBatchRecord[]>;
  createReleaseDraft: (args: {
    featureId: string;
    batchIds?: string[];
  }) => Promise<StoreReleaseDraft>;
  listInstalledMods: () => Promise<InstalledStoreModRecord[]>;
};

export type RuntimeScheduleApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>;
  listHeartbeats: () => Promise<LocalHeartbeatConfigRecord[]>;
  listConversationEvents: (args: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<ScheduledConversationEvent[]>;
  getConversationEventCount: (args: { conversationId: string }) => Promise<number>;
};

export type RuntimeSocialSessionApi = {
  getStatus: () => Promise<SocialSessionServiceSnapshot>;
};

export type RuntimeHealthApi = {
  healthCheck: () => Promise<AgentHealth | null>;
  getActiveRun: () => Promise<RuntimeActiveRun | null>;
};
