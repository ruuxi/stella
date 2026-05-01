import type { ConvexClient } from "convex/browser";
import type { AgentMessage } from "../agent-core/types.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeExecutionSessionHandle,
  RuntimeReasoningEvent,
  RuntimeRunStartedEvent,
  RuntimeStatusEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
  RuntimeUserMessageEvent,
  SelfModMonitor,
} from "../agent-runtime.js";
import type { RuntimeAgentEventPayload } from "../../protocol/index.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { LocalContextEvent } from "../local-history.js";
import type {
  FashionToolApi,
  ScheduleToolApi,
  AgentToolRequest,
  AgentToolSnapshot,
  ToolContext,
  ToolUpdateCallback,
  ToolMetadata,
  ToolResult,
} from "../tools/types.js";
import type { ToolDefinition } from "../extensions/types.js";
import type {
  LocalAgentManager,
  AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  SelfModHmrState,
} from "../../contracts/index.js";
import type {
  HostRuntimeAuthRefreshResult,
  RuntimeActiveRun,
  RuntimeAuthRefreshSource,
  RuntimeAttachmentRef,
  RuntimeAutomationTurnRequest,
  RuntimeAutomationTurnResult,
  RuntimePromptMessage,
  StorePublishArgs,
} from "../../protocol/index.js";
import type { LocalChatAppendEventArgs } from "../storage/shared.js";

export type StellaHostRunnerOptions = {
  deviceId: string;
  stellaRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
  stellaComputerCliPath?: string;
  selfModMonitor?: SelfModMonitor | null;
  selfModLifecycle?: {
    beginRun: (args: {
      runId: string;
      rootRunId?: string;
      taskDescription: string;
      taskPrompt: string;
      conversationId: string;
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update" | "uninstall";
    }) => Promise<void> | void;
    finalizeRun: (args: {
      runId: string;
      rootRunId?: string;
      taskDescription: string;
      taskPrompt: string;
      conversationId: string;
      succeeded: boolean;
      /**
       * Returns a 1-line user-friendly commit subject (≤ 12 words).
       * Returning `null` falls back to the task description.
       */
      commitMessageProvider?: (args: {
        taskDescription: string;
        files: string[];
        diffPreview: string;
        conversationId?: string;
      }) => Promise<string | null>;
      /**
       * Returns the rolling-window feature snapshot items (3-7 word
       * normie-friendly names grouping the most recent self-mod commits).
       * Runs after a successful commit; result replaces the snapshot
       * the side panel reads. Returning `null` leaves the previous
       * snapshot in place.
       */
      featureNamerProvider?: (args: {
        commits: Array<{
          commitHash: string;
          shortHash: string;
          subject: string;
          body: string;
          timestampMs: number;
          files: string[];
        }>;
      }) => Promise<Array<{ name: string; commitHashes: string[] }> | null>;
    }) => Promise<void> | void;
    cancelRun?: (runId: string) => Promise<void> | void;
  } | null;
  selfModHmrController?:
    | import("../self-mod/hmr.js").SelfModHmrController
    | null;
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
  requestRuntimeAuthRefresh?: (payload: {
    source: RuntimeAuthRefreshSource;
  }) => Promise<HostRuntimeAuthRefreshResult>;
  notifyVoiceActionComplete?: (payload: {
    conversationId: string;
    status: "completed" | "failed";
    message: string;
  }) => Promise<void> | void;
  scheduleApi?: ScheduleToolApi;
  fashionApi?: FashionToolApi;
  displayHtml?: (html: string) => void;
  runtimeStore: RuntimeStore;
  /**
   * Optional MemoryStore wired to the orchestrator's memory surface.
   * Defaults to `runtimeStore.memoryStore` when not provided.
   */
  memoryStore?: import("../memory/memory-store.js").MemoryStore;
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
  promptMessages?: RuntimePromptMessage[];
  attachments?: RuntimeAttachmentRef[];
  agentType?: string;
  storageMode?: "cloud" | "local";
};

export type RuntimeSendMessageInput = {
  conversationId: string;
  text: string;
  uiVisibility?: "visible" | "hidden";
  agentType?: string;
  deliverAs?: "steer" | "followUp";
  callbackRunId?: string;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  customType?: string;
  display?: boolean;
  wakePrompt?: string;
};

export type RuntimeSendUserMessageInput = RuntimeSendMessageInput & {
  metadata?: Record<string, unknown>;
};

export type ActiveOrchestratorSession = RuntimeExecutionSessionHandle & {
  conversationId: string;
  agentType: string;
  uiVisibility: "visible" | "hidden";
  queueMessage: (message: AgentMessage, delivery: "steer" | "followUp") => void;
};

export type AgentHealth = {
  ready: boolean;
  reason?: string;
  engine?: string;
};

export type AgentCallbacks = {
  onRunStarted?: (event: RuntimeRunStartedEvent) => void;
  onUserMessage?: (event: RuntimeUserMessageEvent) => void;
  onStream: (event: RuntimeStreamEvent) => void;
  onAgentReasoning?: (
    event: RuntimeReasoningEvent & { agentId: string; rootRunId?: string },
  ) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
  onInterrupted?: (event: {
    runId: string;
    agentType: string;
    userMessageId?: string;
    uiVisibility?: "visible" | "hidden";
    reason: string;
  }) => void;
  onAgentEvent?: (event: AgentLifecycleEvent) => void;
  onSelfModHmrState?: (event: SelfModHmrState) => void;
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
  maxAgentDepth?: number;
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
  localAgentManager: LocalAgentManager | null;
  activeOrchestratorRunId: string | null;
  activeOrchestratorConversationId: string | null;
  activeOrchestratorUiVisibility: "visible" | "hidden";
  activeOrchestratorSession: ActiveOrchestratorSession | null;
  queuedOrchestratorTurns: QueuedOrchestratorTurn[];
  activeRunAbortControllers: Map<string, AbortController>;
  conversationCallbacks: Map<string, AgentCallbacks>;
  runCallbacksByRunId: Map<string, AgentCallbacks>;
  interruptedRunIds: Set<string>;
  activeToolExecutionCount: number;
  interruptAfterTool: boolean;
  activeInterruptedReplayTurn: QueuedOrchestratorTurn | null;
  loadedAgents: ParsedAgentLike[];
  googleWorkspaceToolsLoaded: boolean;
  googleWorkspaceDisconnect: (() => Promise<void>) | null;
  googleWorkspaceCallTool:
    | ((name: string, args: Record<string, unknown>) => Promise<ToolResult>)
    | null;
  /** Cached Google Workspace auth state. null = unknown, true/false = last observed state. */
  googleWorkspaceAuthenticated: boolean | null;
  /**
   * Late-bound web search handler. Wired by `createStellaHostRunner` after the
   * Convex session is created so the toolHost (built earlier in startup) can
   * reach Exa via the same convex-session call path that the rest of the
   * runtime uses. Stored on state so the toolHost can read it lazily.
   */
  webSearch:
    | ((
        query: string,
        options?: { category?: string; displayResults?: boolean },
      ) => Promise<{
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      }>)
    | null;
};

export type RunnerContext = {
  convexApi: unknown;
  deviceId: string;
  stellaRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
  stellaComputerCliPath?: string;
  selfModMonitor?: SelfModMonitor | null;
  selfModLifecycle?: StellaHostRunnerOptions["selfModLifecycle"];
  selfModHmrController?: StellaHostRunnerOptions["selfModHmrController"];
  requestCredential?: StellaHostRunnerOptions["requestCredential"];
  requestRuntimeAuthRefresh?: StellaHostRunnerOptions["requestRuntimeAuthRefresh"];
  scheduleApi?: ScheduleToolApi;
  fashionApi?: FashionToolApi;
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
    getToolCatalog: (agentType?: string) => ToolMetadata[];
    executeTool: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      context: ToolContext,
      signal?: AbortSignal,
      onUpdate?: ToolUpdateCallback,
    ) => Promise<ToolResult>;
    registerExtensionTools: (tools: ToolDefinition[]) => void;
    killAllShells: () => void;
    killShell: (sessionId: string) => Promise<void> | void;
    killShellsByPort: (port: number) => void;
    shutdown: () => Promise<void>;
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
  createFirstStoreRelease: (
    args: StorePublishArgs,
  ) => Promise<StorePackageReleaseRecord>;
  createStoreReleaseUpdate: (
    args: StorePublishArgs,
  ) => Promise<StorePackageReleaseRecord>;
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
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
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
  sendMessage: (input: RuntimeSendMessageInput) => Promise<void>;
  sendUserMessage: (input: RuntimeSendUserMessageInput) => Promise<void>;
  runAutomationTurn: (
    payload: RuntimeAutomationTurnRequest,
  ) => Promise<RuntimeAutomationTurnResult>;
  runBlockingLocalAgent: (
    request: Omit<AgentToolRequest, "storageMode">,
  ) => Promise<
    | { status: "ok"; finalText: string; threadId: string }
    | { status: "error"; finalText: ""; error: string; threadId?: string }
  >;
  createBackgroundAgent: (
    request: Omit<AgentToolRequest, "storageMode">,
  ) => Promise<{ threadId: string }>;
  getActiveAgentCount: () => number;
  getLocalAgentSnapshot: (agentId: string) => Promise<AgentToolSnapshot | null>;
  cancelLocalAgent: (
    agentId: string,
    reason?: string,
  ) => Promise<{ canceled: boolean }>;
  cancelLocalChat: (runId: string) => void;
  getActiveOrchestratorRun: () => RuntimeActiveRun | null;
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
  /**
   * Ask the Dream scheduler to run now. Trigger names are advisory and used
   * for diagnostics; eligibility gates apply to non-`manual` triggers.
   */
  triggerDreamNow: (
    trigger?:
      | "manual"
      | "subagent_finalize"
      | "chronicle_summary"
      | "startup_catchup",
  ) => Promise<{
    scheduled: boolean;
    reason:
      | "scheduled"
      | "disabled"
      | "in_flight"
      | "count_failed"
      | "no_inputs"
      | "below_threshold"
      | "lock_busy"
      | "no_api_key"
      | "unavailable";
    pendingThreadSummaries: number;
    pendingExtensions: number;
    detail?: string;
  }>;
  /**
   * Run one Chronicle rolling-summary pass for the given window. Reads the
   * tail of `state/chronicle/captures.jsonl`, calls a single cheap LLM
   * completion, and atomically rewrites
   * `state/memories_extensions/chronicle/{window}-current.md`. Designed to
   * be called by Electron on a fixed cadence (every 1 minute for "10m",
   * every 1 hour for "6h").
   */
  runChronicleSummaryTick: (window: "10m" | "6h") => Promise<
    | {
        wrote: true;
        window: "10m" | "6h";
        uniqueLines: number;
        outPath: string;
      }
    | {
        wrote: false;
        window: "10m" | "6h";
        reason:
          | "disabled"
          | "lock_busy"
          | "no_api_key"
          | "no_captures"
          | "below_threshold"
          | "unchanged"
          | "no_signal"
          | "llm_failed"
          | "write_failed";
        uniqueLines: number;
        detail?: string;
      }
  >;
};
