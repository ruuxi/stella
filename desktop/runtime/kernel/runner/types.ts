import type { ConvexClient } from "convex/browser";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeStatusEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
  RuntimeUserMessageEvent,
  SelfModMonitor,
} from "../agent-runtime.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { LocalContextEvent } from "../local-history.js";
import type {
  ScheduleToolApi,
  TaskToolRequest,
  TaskToolSnapshot,
  ToolContext,
  ToolMetadata,
  ToolResult,
} from "../tools/types.js";
import type { ToolDefinition } from "../extensions/types.js";
import type {
  LocalTaskManager,
  TaskLifecycleEvent,
} from "../tasks/local-task-manager.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  SelfModHmrState,
} from "../../contracts/index.js";
import type {
  RuntimeActiveRun,
  RuntimeAttachmentRef,
  RuntimeAutomationTurnRequest,
  RuntimeAutomationTurnResult,
  StorePublishArgs,
} from "../../protocol/index.js";
import type { LocalChatAppendEventArgs } from "../storage/shared.js";

export type StellaHostRunnerOptions = {
  deviceId: string;
  stellaHomePath: string;
  frontendRoot?: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
  selfModMonitor?: SelfModMonitor | null;
  selfModLifecycle?: {
    beginRun: (args: {
      runId: string;
      taskDescription: string;
      taskPrompt: string;
      conversationId: string;
      featureId?: string;
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update";
      displayName?: string;
      description?: string;
    }) => Promise<void> | void;
    finalizeRun: (args: {
      runId: string;
      taskDescription: string;
      taskPrompt: string;
      conversationId: string;
      succeeded: boolean;
      featureId?: string;
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update";
      displayName?: string;
      description?: string;
    }) => Promise<void> | void;
    cancelRun?: (runId: string) => Promise<void> | void;
  } | null;
  selfModHmrController?: {
    pause: (runId: string) => Promise<boolean>;
    resume: (
      runId: string,
      options?: { suppressClientFullReload?: boolean },
    ) => Promise<boolean>;
    forceResumeAll: () => Promise<boolean>;
    getStatus: () => Promise<{
      queuedFiles: number;
      requiresFullReload: boolean;
    } | null>;
  } | null;
  getHmrTransitionController?: () => {
    runTransition: (args: {
      runId: string;
      resumeHmr: (
        options?: { suppressClientFullReload?: boolean },
      ) => Promise<void>;
      reportState?: (state: SelfModHmrState) => void;
      requiresFullReload: boolean;
    }) => Promise<void>;
  } | null;
  signHeartbeatPayload?: (
    signedAtMs: number,
  ) =>
    | Promise<{ publicKey: string; signature: string }>
    | { publicKey: string; signature: string };
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
  scheduleApi?: ScheduleToolApi;
  displayHtml?: (html: string) => void;
  runtimeStore: RuntimeStore;
  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];
  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;
  getDefaultConversationId?: () => string;
  onGoogleWorkspaceAuthRequired?: () => void;
};

export type ChatPayload = {
  conversationId: string;
  userMessageId: string;
  userPrompt: string;
  promptMessages?: Array<{
    text: string;
    uiVisibility?: "visible" | "hidden";
  }>;
  attachments?: RuntimeAttachmentRef[];
  agentType?: string;
  storageMode?: "cloud" | "local";
};

export type AgentHealth = {
  ready: boolean;
  reason?: string;
  engine?: string;
};

export type AgentCallbacks = {
  onUserMessage?: (event: RuntimeUserMessageEvent) => void;
  onStream: (event: RuntimeStreamEvent) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
  onTaskEvent?: (event: TaskLifecycleEvent) => void;
  onSelfModHmrState?: (event: SelfModHmrState) => void;
  onHmrResume?: (args: {
    runId: string;
    resumeHmr: (
      options?: { suppressClientFullReload?: boolean },
    ) => Promise<void>;
    reportState?: (state: SelfModHmrState) => void;
    requiresFullReload: boolean;
  }) => Promise<void>;
};

export type QueuedOrchestratorTurn = {
  priority: "user" | "system";
  requeueOnInterrupt: boolean;
  execute: () => Promise<void>;
};

export type ParsedAgentLike = {
  id: string;
  name: string;
  systemPrompt: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  model?: string;
  maxTaskDepth?: number;
};

export type RunnerPaths = {
  extensionsPath: string;
};

export type RunnerState = {
  convexSiteUrl: string | null;
  authToken: string | null;
  convexDeploymentUrl: string | null;
  convexClient: ConvexClient | null;
  convexClientUrl: string | null;
  hasConnectedAccount: boolean;
  cloudSyncEnabled: boolean;
  isRunning: boolean;
  isInitialized: boolean;
  initializationPromise: Promise<void> | null;
  localTaskManager: LocalTaskManager | null;
  activeOrchestratorRunId: string | null;
  activeOrchestratorConversationId: string | null;
  queuedOrchestratorTurns: QueuedOrchestratorTurn[];
  activeRunAbortControllers: Map<string, AbortController>;
  conversationCallbacks: Map<string, AgentCallbacks>;
  interruptedRunIds: Set<string>;
  activeToolExecutionCount: number;
  interruptAfterTool: boolean;
  activeInterruptedReplayTurn: QueuedOrchestratorTurn | null;
  loadedAgents: ParsedAgentLike[];
  /** `null` before lazy load, `[]` when loaded but unavailable, otherwise registered tool names. */
  googleWorkspaceToolNames: string[] | null;
  googleWorkspaceDisconnect: (() => Promise<void>) | null;
  googleWorkspaceCallTool: ((name: string, args: Record<string, unknown>) => Promise<ToolResult>) | null;
  /** Cached Google Workspace auth state. null = unknown, true/false = last observed state. */
  googleWorkspaceAuthenticated: boolean | null;
};

export type RunnerContext = {
  convexApi: unknown;
  deviceId: string;
  stellaHomePath: string;
  frontendRoot?: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
  selfModMonitor?: SelfModMonitor | null;
  selfModLifecycle?: StellaHostRunnerOptions["selfModLifecycle"];
  selfModHmrController?: StellaHostRunnerOptions["selfModHmrController"];
  getHmrTransitionController?: StellaHostRunnerOptions["getHmrTransitionController"];
  signHeartbeatPayload?: StellaHostRunnerOptions["signHeartbeatPayload"];
  requestCredential?: StellaHostRunnerOptions["requestCredential"];
  scheduleApi?: ScheduleToolApi;
  displayHtml?: (html: string) => void;
  runtimeStore: RuntimeStore;
  listLocalChatEvents?: StellaHostRunnerOptions["listLocalChatEvents"];
  appendLocalChatEvent?: StellaHostRunnerOptions["appendLocalChatEvent"];
  getDefaultConversationId?: StellaHostRunnerOptions["getDefaultConversationId"];
  paths: RunnerPaths;
  state: RunnerState;
  ensureGoogleWorkspaceToolsLoaded: () => Promise<void>;
  hookEmitter: HookEmitter;
  toolHost: {
    getToolCatalog: () => ToolMetadata[];
    executeTool: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      context: ToolContext,
    ) => Promise<ToolResult>;
    registerExtensionTools: (tools: ToolDefinition[]) => void;
    killAllShells: () => void;
    killShellsByPort: (port: number) => void;
  };
};

export type StoreOperations = {
  listStorePackages: () => Promise<StorePackageRecord[]>;
  getStorePackage: (packageId: string) => Promise<StorePackageRecord | null>;
  listStorePackageReleases: (
    packageId: string,
  ) => Promise<StorePackageReleaseRecord[]>;
  getStorePackageRelease: (
    packageId: string,
    releaseNumber: number,
  ) => Promise<StorePackageReleaseRecord | null>;
  createFirstStoreRelease: (args: StorePublishArgs) => Promise<StorePackageReleaseRecord>;
  createStoreReleaseUpdate: (args: StorePublishArgs) => Promise<StorePackageReleaseRecord>;
};

export type RunnerPublicApi = {
  deviceId: string;
  hookEmitter: HookEmitter;
  setConvexUrl: (value: string | null) => void;
  setConvexSiteUrl: (value: string | null) => void;
  setAuthToken: (value: string | null) => void;
  setHasConnectedAccount: (value: boolean) => void;
  setCloudSyncEnabled: (enabled: boolean) => void;
  start: () => void;
  stop: () => void;
  waitUntilInitialized: () => Promise<void>;
  subscribeQuery: (
    query: unknown,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => (() => void) | null;
  getConvexUrl: () => string | null;
  getStellaSiteAuth: () => { baseUrl: string; authToken: string } | null;
  killAllShells: () => void;
  killShellsByPort: (port: number) => void;
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
  agentHealthCheck: () => AgentHealth;
  webSearch: (
    query: string,
    options?: { category?: string; displayResults?: boolean },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  listStorePackages: StoreOperations["listStorePackages"];
  getStorePackage: StoreOperations["getStorePackage"];
  listStorePackageReleases: StoreOperations["listStorePackageReleases"];
  getStorePackageRelease: StoreOperations["getStorePackageRelease"];
  createFirstStoreRelease: StoreOperations["createFirstStoreRelease"];
  createStoreReleaseUpdate: StoreOperations["createStoreReleaseUpdate"];
  handleLocalChat: (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ) => Promise<{ runId: string }>;
  runAutomationTurn: (
    payload: RuntimeAutomationTurnRequest,
  ) => Promise<RuntimeAutomationTurnResult>;
  runBlockingLocalTask: (
    request: Omit<TaskToolRequest, "storageMode">,
  ) => Promise<
    | { status: "ok"; finalText: string; threadId: string }
    | { status: "error"; finalText: ""; error: string; threadId?: string }
  >;
  createBackgroundTask: (
    request: Omit<TaskToolRequest, "storageMode">,
  ) => Promise<{ threadId: string }>;
  getActiveTaskCount: () => number;
  getLocalTaskSnapshot: (taskId: string) => Promise<TaskToolSnapshot | null>;
  cancelLocalChat: (runId: string) => void;
  getActiveOrchestratorRun: () => RuntimeActiveRun | null;
  resumeSelfModHmr: (
    runId: string,
    options?: { suppressClientFullReload?: boolean },
  ) => Promise<boolean>;
  recoverCrashedRuns: () => Promise<void>;
  appendThreadMessage: (args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) => void;
  convexAction: (ref: unknown, args: unknown) => Promise<unknown>;
  googleWorkspaceGetAuthStatus: () => Promise<{
    connected: boolean;
    unavailable?: boolean;
    email?: string;
    name?: string;
  }>;
  googleWorkspaceConnect: () => Promise<{
    connected: boolean;
    unavailable?: boolean;
    email?: string;
    name?: string;
  }>;
  googleWorkspaceDisconnect: () => Promise<{ ok: boolean }>;
};
