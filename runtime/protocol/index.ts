import type {
  AgentHealth,
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
  ScheduledConversationEvent,
  SelfModFeatureRosterEntry,
  SelfModFeatureRosterPage,
  SelfModFeatureSnapshot,
  SelfModCommitSummary,
  SelfModHmrState,
  SocialSessionRuntimeRecord,
  SocialSessionServiceSnapshot,
  StoreInstallRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseGitArtifact,
  StoreReleaseGitObjectUpload,
  StoreReleaseSourcePackRef,
  StoreReleaseSourcePack,
  StellaReleaseArtifactRef,
} from "../contracts/index.js";
import type {
  AgentRunFinishOutcome,
  TaskLifecycleStatus,
} from "../contracts/agent-runtime.js";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "../contracts/file-changes.js";

export type {
  AgentHealth,
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
  ScheduledConversationEvent,
  SelfModFeatureRosterEntry,
  SelfModFeatureRosterPage,
  SelfModFeatureSnapshot,
  SelfModCommitSummary,
  SelfModHmrState,
  SocialSessionRuntimeRecord,
  SocialSessionServiceSnapshot,
  StoreInstallRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseGitArtifact,
  StoreReleaseGitObjectUpload,
  StoreReleaseSourcePackRef,
  StoreReleaseSourcePack,
  StellaReleaseArtifactRef,
};

export const STELLA_RUNTIME_PROTOCOL_VERSION = "v1";
export const STELLA_RUNTIME_READY_METHOD = "internal.worker.readyz";

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
  RUNTIME_RESTART_WORKER: "runtime.restartWorker",
  RUN_HEALTH_CHECK: "run.healthCheck",
  RUN_GET_ACTIVE: "run.getActive",
  RUN_START_CHAT: "run.startChat",
  RUN_CANCEL: "run.cancel",
  RUN_ACK_EVENTS: "run.ackEvents",
  RUN_AUTOMATION: "run.automation",
  AGENT_RUN_BLOCKING: "agent.runBlocking",
  AGENT_CREATE_BACKGROUND: "agent.createBackground",
  AGENT_GET_SNAPSHOT: "agent.getSnapshot",
  SEARCH_WEB: "search.web",
  VOICE_PERSIST_TRANSCRIPT: "voice.persistTranscript",
  VOICE_ORCHESTRATOR_CHAT: "voice.orchestratorChat",
  VOICE_ORCHESTRATOR_CONFIG: "voice.orchestratorConfig",
  VOICE_EXECUTE_TOOL: "voice.executeTool",
  VOICE_WEB_SEARCH: "voice.webSearch",
  THREAD_APPEND_MESSAGE: "thread.appendMessage",
  LOCAL_CHAT_GET_OR_CREATE_DEFAULT:
    "localChat.getOrCreateDefaultConversationId",
  LOCAL_CHAT_LIST_EVENTS: "localChat.listEvents",
  LOCAL_CHAT_GET_EVENT_COUNT: "localChat.getEventCount",
  LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME: "localChat.persistDiscoveryWelcome",
  LOCAL_CHAT_LIST_SYNC_MESSAGES: "localChat.listSyncMessages",
  LOCAL_CHAT_GET_SYNC_CHECKPOINT: "localChat.getSyncCheckpoint",
  LOCAL_CHAT_SET_SYNC_CHECKPOINT: "localChat.setSyncCheckpoint",
  STORE_MODS_LIST_INSTALLED: "storeMods.listInstalledMods",
  STORE_LIST_PACKAGES: "store.listPackages",
  STORE_GET_PACKAGE: "store.getPackage",
  STORE_LIST_RELEASES: "store.listReleases",
  STORE_GET_RELEASE: "store.getRelease",
  STORE_CREATE_FIRST_RELEASE: "store.createFirstRelease",
  STORE_CREATE_RELEASE_UPDATE: "store.createReleaseUpdate",
  STORE_PUBLISH_SELECTED_FEATURES: "store.publishSelectedFeatures",
  STORE_INSTALL_FROM_BLUEPRINT: "store.installFromBlueprint",
  STORE_UNINSTALL_MOD: "store.uninstallMod",
  SELF_MOD_FEATURE_SNAPSHOT_READ: "selfMod.featureSnapshot.read",
  SELF_MOD_FEATURE_ROSTER_LIST: "selfMod.featureRoster.list",
  SCHEDULE_LIST_CRON_JOBS: "schedule.listCronJobs",
  SCHEDULE_LIST_HEARTBEATS: "schedule.listHeartbeats",
  SCHEDULE_LIST_EVENTS: "schedule.listConversationEvents",
  SCHEDULE_GET_EVENT_COUNT: "schedule.getConversationEventCount",
  SOCIAL_SESSIONS_GET_STATUS: "socialSessions.getStatus",
  PROJECTS_LIST: "projects.list",
  PROJECTS_REGISTER_DIRECTORY: "projects.registerDirectory",
  PROJECTS_START: "projects.start",
  PROJECTS_STOP: "projects.stop",
  SELF_MOD_APPLY: "selfMod.apply",
  SELF_MOD_REVERT: "selfMod.revert",
  SELF_MOD_CRASH_RECOVERY_STATUS: "selfMod.crashRecoveryStatus",
  SELF_MOD_DISCARD_UNFINISHED: "selfMod.discardUnfinished",
  SELF_MOD_LAST_COMMIT: "selfMod.lastCommit",
  SELF_MOD_RECENT_COMMITS: "selfMod.recentCommits",
  SHELL_KILL_ALL: "shell.killAll",
  SHELL_KILL_BY_PORT: "shell.killByPort",
  DISCOVERY_COLLECT_BROWSER_DATA: "discovery.collectBrowserData",
  DISCOVERY_COLLECT_ALL_SIGNALS: "discovery.collectAllSignals",
  DISCOVERY_CORE_MEMORY_EXISTS: "discovery.coreMemoryExists",
  DISCOVERY_WRITE_CORE_MEMORY: "discovery.writeCoreMemory",
  DISCOVERY_DETECT_PREFERRED_BROWSER: "discovery.detectPreferredBrowser",
  DISCOVERY_LIST_BROWSER_PROFILES: "discovery.listBrowserProfiles",
  HOST_DEVICE_IDENTITY_GET: "host.deviceIdentity.get",
  HOST_DEVICE_HEARTBEAT_SIGN: "host.deviceHeartbeat.sign",
  HOST_CREDENTIALS_REQUEST: "host.credentials.request",
  HOST_CONNECTOR_CREDENTIAL_REQUEST: "host.connectorCredential.request",
  HOST_APP_BROWSER_CONTEXT_GET: "host.appBrowserContext.get",
  HOST_DISPLAY_UPDATE: "host.display.update",
  HOST_NOTIFICATION_SHOW: "host.notification.show",
  HOST_SYSTEM_REQUEST_PERMISSION: "host.system.requestPermission",
  HOST_SYSTEM_OPEN_EXTERNAL: "host.system.openExternal",
  HOST_WINDOW_SHOW: "host.window.show",
  HOST_WINDOW_FOCUS: "host.window.focus",
  HOST_HMR_RUN_TRANSITION: "host.hmr.runTransition",
  HOST_RUNTIME_RELOAD_PAUSE: "host.runtimeReload.pause",
  HOST_RUNTIME_RELOAD_RESUME: "host.runtimeReload.resume",
  HOST_RUNTIME_AUTH_REFRESH: "host.runtimeAuth.refresh",
  INTERNAL_WORKER_INITIALIZE: "internal.worker.initialize",
  INTERNAL_WORKER_CONFIGURE: "internal.worker.configure",
  INTERNAL_WORKER_HEALTH: "internal.worker.health",
  INTERNAL_WORKER_GET_ACTIVE: "internal.worker.getActive",
  INTERNAL_WORKER_START_CHAT: "internal.worker.startChat",
  INTERNAL_WORKER_CANCEL: "internal.worker.cancel",
  /**
   * Cancel the active orchestrator automation/chat run for a given local
   * conversation. Used by the host's remote-turn bridge when the
   * originating connector (e.g. the Stella mobile app) issues a
   * server-side cancel for its in-flight `requestId`.
   */
  INTERNAL_WORKER_CANCEL_BY_CONVERSATION:
    "internal.worker.cancelByConversation",
  INTERNAL_WORKER_RESUME_EVENTS: "internal.worker.resumeEvents",
  INTERNAL_WORKER_ACK_EVENTS: "internal.worker.ackEvents",
  INTERNAL_WORKER_LIST_ACTIVE_RUNS: "internal.worker.listActiveRuns",
  INTERNAL_WORKER_RUN_AUTOMATION: "internal.worker.runAutomation",
  INTERNAL_WORKER_RUN_BLOCKING_AGENT: "internal.worker.runBlockingAgent",
  INTERNAL_WORKER_CREATE_BACKGROUND_AGENT:
    "internal.worker.createBackgroundAgent",
  INTERNAL_WORKER_GET_AGENT_SNAPSHOT: "internal.worker.getAgentSnapshot",
  INTERNAL_WORKER_APPEND_THREAD_MESSAGE: "internal.worker.appendThreadMessage",
  INTERNAL_WORKER_SEND_AGENT_INPUT: "internal.worker.sendAgentInput",
  INTERNAL_WORKER_WEB_SEARCH: "internal.worker.webSearch",
  INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT:
    "internal.worker.voice.persistTranscript",
  INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT:
    "internal.worker.voice.orchestratorChat",
  INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG:
    "internal.worker.voice.orchestratorConfig",
  INTERNAL_WORKER_VOICE_EXECUTE_TOOL: "internal.worker.voice.executeTool",
  INTERNAL_WORKER_VOICE_WEB_SEARCH: "internal.worker.voice.webSearch",
  INTERNAL_WORKER_LIST_STORE_PACKAGES: "internal.worker.listStorePackages",
  INTERNAL_WORKER_GET_STORE_PACKAGE: "internal.worker.getStorePackage",
  INTERNAL_WORKER_LIST_STORE_RELEASES: "internal.worker.listStoreReleases",
  INTERNAL_WORKER_GET_STORE_RELEASE: "internal.worker.getStoreRelease",
  INTERNAL_WORKER_CREATE_FIRST_STORE_RELEASE:
    "internal.worker.createFirstStoreRelease",
  INTERNAL_WORKER_CREATE_STORE_RELEASE_UPDATE:
    "internal.worker.createStoreReleaseUpdate",
  INTERNAL_WORKER_PUBLISH_STORE_SELECTED_FEATURES:
    "internal.worker.publishStoreSelectedFeatures",
  INTERNAL_WORKER_INSTALL_FROM_BLUEPRINT:
    "internal.worker.installFromBlueprint",
  INTERNAL_WORKER_UNINSTALL_STORE_MOD: "internal.worker.uninstallStoreMod",
  INTERNAL_WORKER_FEATURE_SNAPSHOT_READ:
    "internal.worker.selfMod.featureSnapshotRead",
  INTERNAL_WORKER_FEATURE_ROSTER_LIST:
    "internal.worker.selfMod.featureRosterList",
  INTERNAL_WORKER_RESUME_HMR: "internal.worker.resumeHmr",
  INTERNAL_WORKER_SELF_MOD_EXTERNAL_BEGIN:
    "internal.worker.selfMod.externalBegin",
  INTERNAL_WORKER_SELF_MOD_EXTERNAL_FINISH:
    "internal.worker.selfMod.externalFinish",
  INTERNAL_WORKER_SOURCE_PACK_HISTORY_RECORD:
    "internal.worker.sourcePackHistory.record",
  INTERNAL_WORKER_SOURCE_HISTORY_HAS_COMMIT:
    "internal.worker.sourceHistory.hasCommit",
  INTERNAL_WORKER_KILL_ALL_SHELLS: "internal.worker.killAllShells",
  INTERNAL_WORKER_KILL_SHELL_BY_PORT: "internal.worker.killShellByPort",
  INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT:
    "internal.worker.localChat.getOrCreateDefaultConversationId",
  INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT:
    "internal.worker.localChat.appendEvent",
  INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS:
    "internal.worker.localChat.listEvents",
  INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT:
    "internal.worker.localChat.getEventCount",
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
  INTERNAL_WORKER_STORE_MODS_LIST_INSTALLED:
    "internal.worker.storeMods.listInstalledMods",
  INTERNAL_WORKER_SCHEDULE_LIST_CRON_JOBS:
    "internal.worker.schedule.listCronJobs",
  INTERNAL_WORKER_SCHEDULE_LIST_HEARTBEATS:
    "internal.worker.schedule.listHeartbeats",
  INTERNAL_WORKER_SCHEDULE_LIST_EVENTS:
    "internal.worker.schedule.listConversationEvents",
  INTERNAL_WORKER_SCHEDULE_GET_EVENT_COUNT:
    "internal.worker.schedule.getConversationEventCount",
  INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE:
    "internal.worker.socialSessions.create",
  INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS:
    "internal.worker.socialSessions.updateStatus",
  INTERNAL_WORKER_SOCIAL_SESSIONS_QUEUE_TURN:
    "internal.worker.socialSessions.queueTurn",
  INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS:
    "internal.worker.socialSessions.getStatus",
  INTERNAL_WORKER_PROJECTS_LIST: "internal.worker.projects.list",
  INTERNAL_WORKER_PROJECTS_REGISTER_DIRECTORY:
    "internal.worker.projects.registerDirectory",
  INTERNAL_WORKER_PROJECTS_START: "internal.worker.projects.start",
  INTERNAL_WORKER_PROJECTS_STOP: "internal.worker.projects.stop",
  INTERNAL_WORKER_ONE_SHOT_COMPLETION: "internal.worker.oneShotCompletion",
  INTERNAL_WORKER_DREAM_TRIGGER_NOW: "internal.worker.dream.triggerNow",
  INTERNAL_WORKER_CHRONICLE_SUMMARY_TICK:
    "internal.worker.chronicle.summaryTick",
  INTERNAL_WORKER_SELF_MOD_APPLY: "internal.worker.selfMod.apply",
  INTERNAL_WORKER_SELF_MOD_REVERT: "internal.worker.selfMod.revert",
  INTERNAL_WORKER_SELF_MOD_CRASH_RECOVERY_STATUS:
    "internal.worker.selfMod.crashRecoveryStatus",
  INTERNAL_WORKER_SELF_MOD_DISCARD_UNFINISHED:
    "internal.worker.selfMod.discardUnfinished",
  INTERNAL_WORKER_SELF_MOD_LAST_COMMIT: "internal.worker.selfMod.lastCommit",
  INTERNAL_WORKER_SELF_MOD_RECENT_COMMITS:
    "internal.worker.selfMod.recentCommits",
  INTERNAL_STORE_LOAD_THREAD_MESSAGES: "internal.store.loadThreadMessages",
  INTERNAL_STORE_LIST_ACTIVE_THREADS: "internal.store.listActiveThreads",
  INTERNAL_STORE_GET_ORCHESTRATOR_REMINDER_STATE:
    "internal.store.getOrchestratorReminderState",
  INTERNAL_STORE_RESOLVE_OR_CREATE_ACTIVE_THREAD:
    "internal.store.resolveOrCreateActiveThread",
  INTERNAL_STORE_APPEND_THREAD_MESSAGE: "internal.store.appendThreadMessage",
  INTERNAL_STORE_ARCHIVE_THREAD: "internal.store.archiveThread",
  INTERNAL_STORE_REPLACE_THREAD_MESSAGES:
    "internal.store.replaceThreadMessages",
  INTERNAL_STORE_UPDATE_THREAD_SUMMARY: "internal.store.updateThreadSummary",
  INTERNAL_STORE_UPDATE_ORCHESTRATOR_REMINDER_COUNTER:
    "internal.store.updateOrchestratorReminderCounter",
  INTERNAL_STORE_RECORD_RUN_EVENT: "internal.store.recordRunEvent",
  INTERNAL_STORE_LIST_LOCAL_CHAT_EVENTS: "internal.store.listLocalChatEvents",
  INTERNAL_STORE_BEGIN_SELF_MOD_RUN: "internal.store.beginSelfModRun",
  INTERNAL_STORE_FINALIZE_SELF_MOD_RUN: "internal.store.finalizeSelfModRun",
  INTERNAL_STORE_CANCEL_SELF_MOD_RUN: "internal.store.cancelSelfModRun",
  INTERNAL_SCHEDULE_LIST_CRON_JOBS: "internal.schedule.listCronJobs",
  INTERNAL_SCHEDULE_ADD_CRON_JOB: "internal.schedule.addCronJob",
  INTERNAL_SCHEDULE_UPDATE_CRON_JOB: "internal.schedule.updateCronJob",
  INTERNAL_SCHEDULE_REMOVE_CRON_JOB: "internal.schedule.removeCronJob",
  INTERNAL_SCHEDULE_RUN_CRON_JOB: "internal.schedule.runCronJob",
  INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG:
    "internal.schedule.getHeartbeatConfig",
  INTERNAL_SCHEDULE_UPSERT_HEARTBEAT: "internal.schedule.upsertHeartbeat",
  INTERNAL_SCHEDULE_RUN_HEARTBEAT: "internal.schedule.runHeartbeat",
  INTERNAL_CAPABILITY_STATE_GET: "internal.capabilityState.get",
  INTERNAL_CAPABILITY_STATE_SET: "internal.capabilityState.set",
  INTERNAL_CAPABILITY_STATE_APPEND_EVENT:
    "internal.capabilityState.appendEvent",
  INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS:
    "internal.worker.googleWorkspace.authStatus",
  INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT:
    "internal.worker.googleWorkspace.connect",
  INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT:
    "internal.worker.googleWorkspace.disconnect",
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
  APPROVAL_REQUESTED: "approval.requested",
} as const;

export type RuntimeInitializeParams = {
  clientName: string;
  clientVersion: string;
  platform: NodeJS.Platform;
  protocolVersion: string;
  isDev: boolean;
  stellaAppDir: string;
  stellaDataDirPath: string;
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
  hasConnectedAccount?: boolean;
  cloudSyncEnabled?: boolean;
  modelCatalogUpdatedAt?: number | null;
};

export type RuntimeAuthRefreshSource =
  | "heartbeat"
  | "subscription"
  | "register"
  | "stella_provider";

export type HostRuntimeAuthRefreshParams = {
  source: RuntimeAuthRefreshSource;
};

export type HostRuntimeAuthRefreshResult = {
  authenticated: boolean;
  token: string | null;
  hasConnectedAccount: boolean;
};

import type { ChatContext } from "../contracts/index.js";

export type RuntimeHealthSnapshot = {
  ready: boolean;
  hostPid: number;
  workerPid: number | null;
  workerRunning?: boolean;
  workerGeneration: number;
  deviceId: string | null;
  activeRunId: string | null;
  activeAgentCount: number;
};

export type RuntimeAttachmentRef = {
  url: string;
  mimeType?: string;
  /**
   * Optional metadata preserved across the host/worker boundary so future
   * non-image attachment paths (voice notes, documents, video) can branch
   * on it. Today the image materializer only reads `url`/`mimeType` and
   * silently drops everything that isn't an image — these fields exist so
   * that adding non-image support later is a worker-only change rather
   * than another round of contract plumbing.
   */
  kind?: string;
  name?: string;
  size?: number;
  transcript?: string;
  extractedText?: string;
  /**
   * Downscaled data URL generated at attach time. The model path always
   * uses the full-resolution `url`; the chat display store persists the
   * preview instead so user-message rows never decode (or store) tens of
   * megabytes of base64 per turn.
   */
  previewUrl?: string;
};

export type RuntimePromptMessage = {
  text: string;
  uiVisibility?: "visible" | "hidden";
  messageType?: "message" | "user";
  customType?: string;
  display?: boolean;
};

export type RuntimeChatPayload = {
  conversationId: string;
  userPrompt: string;
  requestId?: string;
  promptMessages?: RuntimePromptMessage[];
  selectedText?: string | null;
  chatContext?: ChatContext | null;
  deviceId?: string;
  platform?: string;
  timezone?: string;
  /**
   * BCP-47 locale tag for the user's preferred response language. Plumbed
   * from the desktop renderer's `useI18n()` so the runtime can inject a
   * "respond in X" directive into the agent system prompt. Optional —
   * falls back to English when absent.
   */
  locale?: string;
  mode?: string;
  messageMetadata?: Record<string, unknown>;
  attachments?: RuntimeAttachmentRef[];
  userMessageEventId?: string;
  agentType?: string;
  storageMode?: "cloud" | "local";
  selfModMetadata?: {
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update" | "uninstall" | "desktop-update";
    expectedChangedFiles?: string[];
  };
};

export type RuntimeVoiceTranscriptPayload = {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  uiVisibility?: "visible" | "hidden";
  /** Present only on the visible end-of-session summary message. */
  voiceSession?: { durationMs: number };
};

export type RuntimeVoiceChatPayload = {
  requestId: string;
  conversationId: string;
  message: string;
};

export type RuntimeVoiceToolMetadata = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RuntimeVoiceOrchestratorConfigRequest = {
  conversationId: string;
};

export type RuntimeVoiceHistoryItem = {
  role: string;
  content: string;
  timestamp?: number;
  toolCallId?: string;
};

export type RuntimeVoiceOrchestratorConfig = {
  instructions: string;
  tools: RuntimeVoiceToolMetadata[];
  history?: RuntimeVoiceHistoryItem[];
};

export type RuntimeVoiceToolCallPayload = {
  requestId: string;
  conversationId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type RuntimeVoiceToolCallResult = {
  output: string;
  details?: unknown;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  error?: string;
};

export type RuntimeActiveRun = {
  runId: string;
  conversationId: string;
  uiVisibility?: "visible" | "hidden";
};

/**
 * One-shot text completion request. Lets renderer surfaces (task progress
 * summaries, the music-prompt shaper, etc.) run a single completion through
 * the runtime's BYOK-aware route resolver — same path the orchestrator and
 * subsidiary agents use — instead of unconditionally hitting Stella's
 * managed chat-completions endpoint.
 *
 * `agentType` picks which per-agent model override + provider to honor.
 * `fallbackAgentTypes` lets the caller fall through to a related agent's
 * configured model when no explicit override exists for `agentType` (e.g.
 * `task_summary` falls back to `general` so the user's Assistant-tab BYOK
 * pick is respected even though `task_summary` is not user-configurable).
 */
export type RuntimeOneShotCompletionRequest = {
  agentType: string;
  systemPrompt?: string;
  userText: string;
  maxOutputTokens?: number;
  temperature?: number;
  fallbackAgentTypes?: string[];
};

export type RuntimeOneShotCompletionResult = {
  text: string;
};

export type RuntimeAutomationTurnRequest = {
  conversationId: string;
  userPrompt: string;
  agentType?: string;
  modelOverride?: string;
  toolWorkspaceRoot?: string;
  attachments?: RuntimeAttachmentRef[];
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
};

export type RuntimeAutomationTurnResult =
  | { status: "ok"; finalText: string }
  | { status: "busy"; finalText: ""; error: string }
  | { status: "error"; finalText: ""; error: string };

export type RuntimeSelfModRevertResult = {
  commitHash: string;
  revertedCommitHashes: string[];
  message: string;
  /** Conversation id parsed from the reverted commit's `Stella-Conversation` trailer (null when absent). */
  conversationId?: string | null;
  /** Originating agent thread key parsed from the reverted commit's `Stella-Thread` trailer (null when absent). Used by the revert-notice hook to fan the hidden reminder to the specific resumable subagent that authored the commit. */
  originThreadKey?: string | null;
  /** Files touched by the reverted commit(s); used by the revert-notice hook for the hidden reminder. */
  files?: string[];
};

export type RuntimeSelfModApplyResult = {
  commitHash?: string;
  applied: boolean;
  message?: string;
};

export type RuntimeCrashRecoveryStatus =
  | {
      kind: "dirty";
      changedFileCount: number;
      latestChangedAtMs: number | null;
    }
  | {
      kind: "clean";
      latestSelfModCommit: {
        commitHash: string;
        name: string;
        description: string;
        timestampMs: number;
      } | null;
    };

export type RuntimeDiscardUnfinishedResult = {
  discardedFileCount: number;
  discardedFiles: string[];
};

export type RuntimeLocalAgentRequest = {
  conversationId: string;
  description: string;
  prompt: string;
  agentType?: string;
  selfModMetadata?: {
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update" | "uninstall" | "desktop-update";
    expectedChangedFiles?: string[];
  };
};

export type RuntimeLocalAgentSnapshot = {
  id: string;
  status: TaskLifecycleStatus;
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
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  rootRunId?: string;
  chunk?: string;
  statusState?: "running" | "compacting" | "provider-retry";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  details?: unknown;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: {
    commitHash: string;
    files: string[];
    batchIndex: number;
    status?: "pending" | "applied";
  };
  agentId?: string;
  agentType?: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  /** Work group (`grp-…` key + human label) of the agent's thread. */
  groupKey?: string;
  groupLabel?: string;
  responseTarget?:
    | { type: "user_turn" }
    | { type: "agent_turn"; agentId: string }
    | {
        type: "agent_terminal_notice";
        agentId: string;
        terminalState: "completed" | "failed" | "canceled";
      };
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

export type RuntimeConversationActiveRunSnapshot = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeConversationTaskSnapshot = {
  runId: string;
  agentId: string;
  agentType?: string;
  description?: string;
  parentAgentId?: string;
  status: TaskLifecycleStatus;
  statusText?: string;
  result?: string;
  error?: string;
};

export type RuntimeConversationResumeResult = {
  activeRun: RuntimeConversationActiveRunSnapshot | null;
  events: RuntimeAgentEventPayload[];
  tasks: RuntimeConversationTaskSnapshot[];
};

export type RuntimeWebSearchResult = {
  text: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    image?: string;
    favicon?: string;
  }>;
};

export type HostDeviceIdentity = {
  deviceId: string;
  publicKey: string;
};

export type HostHeartbeatSignature = {
  publicKey: string;
  signature: string;
};

/**
 * The host display update bridge accepts structured payloads that the renderer
 * maps to the workspace panel tab manager.
 *
 * Structured payloads use the same `DisplayPayload` shape defined in
 * `desktop/src/shared/contracts/display-payload.ts`. We avoid importing it
 * here so the runtime protocol stays free of desktop-only types — the
 * renderer is the single source of truth for the union and validates the
 * payload shape before routing it to the panel.
 */
export type HostDisplayUpdateParams = { payload: unknown };

export type HostWindowTarget = "mini" | "full";

export type HostRecentApp = {
  name: string;
  pid: number;
  isActive: boolean;
  bundleId?: string;
  windowTitle?: string;
};

export type HostActiveBrowserTab = {
  browser: string;
  url: string;
  bundleId?: string;
  title?: string;
};

export type HostAppBrowserContextSnapshot = {
  apps: HostRecentApp[];
  activeBrowserTab: HostActiveBrowserTab | null;
};

export type StorePublishArgs = {
  packageId: string;
  releaseNumber: number;
  displayName: string;
  /** Optional listing description; only meaningful on a first release. */
  description?: string;
  releaseNotes?: string;
  manifest: StoreReleaseArtifact["manifest"];
  artifact: StoreReleaseArtifact;
  gitObjectUploads?: StoreReleaseGitObjectUpload[];
};

/**
 * Source-backed publish path. The renderer only selects local feature names and
 * listing metadata; the worker resolves those names to commits/source packs.
 */
export type StorePublishSelectedFeaturesArgs = {
  attachedFeatureNames: string[];
  /**
   * Roster featureIds parallel to `attachedFeatureNames` (`""` for legacy
   * entries without one). Feature names are not unique, so the worker
   * resolves by id first and only falls back to the name when the id is
   * blank.
   */
  attachedFeatureIds?: string[];
  packageId: string;
  asUpdate: boolean;
  displayName?: string;
  description?: string;
  category?: StoreReleaseArtifact["manifest"]["category"];
  manifest: StoreReleaseArtifact["manifest"];
  releaseNotes?: string;
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
  publishSelectedFeatures: (
    args: StorePublishSelectedFeaturesArgs,
  ) => Promise<StorePackageReleaseRecord>;
};

export type RuntimeStoreModApi = {
  listInstalledMods: () => Promise<StoreInstallRecord[]>;
};

export type RuntimeScheduleApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>;
  listHeartbeats: () => Promise<LocalHeartbeatConfigRecord[]>;
  listConversationEvents: (args: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<ScheduledConversationEvent[]>;
  getConversationEventCount: (args: {
    conversationId: string;
  }) => Promise<number>;
};

export type RuntimeSocialSessionStatus = "active" | "paused" | "ended";

export type RuntimeSocialSessionApi = {
  createSession: (args: {
    roomId: string;
    workspaceLabel?: string;
  }) => Promise<{ sessionId: string }>;
  updateSessionStatus: (args: {
    sessionId: string;
    status: RuntimeSocialSessionStatus;
  }) => Promise<{ sessionId: string; status: RuntimeSocialSessionStatus }>;
  queueTurn: (args: {
    sessionId: string;
    prompt: string;
    agentType?: string;
    clientTurnId?: string;
  }) => Promise<{ turnId: string }>;
  getStatus: () => Promise<SocialSessionServiceSnapshot>;
};

export type RuntimeHealthApi = {
  healthCheck: () => Promise<AgentHealth | null>;
  getActiveRun: () => Promise<RuntimeActiveRun | null>;
};
