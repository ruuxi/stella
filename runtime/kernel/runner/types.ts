import type { ConvexClient } from "convex/browser";
import type { Api, Model } from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { OrchestratorSession } from "../agent-runtime/orchestrator-session.js";
import type { BackgroundCompactionScheduler } from "../agent-runtime/compaction-scheduler.js";
import type {
  RuntimeAssistantMessageEvent,
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
  SourceImportToolApi,
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
  HostAppBrowserContextSnapshot,
  HostRuntimeAuthRefreshResult,
  RuntimeActiveRun,
  RuntimeAuthRefreshSource,
  RuntimeAttachmentRef,
  RuntimeAutomationTurnRequest,
  RuntimeAutomationTurnResult,
  RuntimeVoiceOrchestratorConfig,
  RuntimeVoiceOrchestratorConfigRequest,
  RuntimePromptMessage,
  StorePublishArgs,
} from "../../protocol/index.js";
import type { LocalChatAppendEventArgs } from "../storage/shared.js";

export type StellaHostRunnerOptions = {
  deviceId: string;
  stellaAppDir: string;
  stellaDataDir: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaConnectCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  /** UDS path for the worker-side CLI bridge (see runtime/worker/cli-bridge-server.ts).
   *  Forwarded into PTY env as `STELLA_CLI_BRIDGE_SOCK`. */
  cliBridgeSocketPath?: string;
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
      mode?: "author" | "install" | "update" | "uninstall" | "desktop-update";
    }) => Promise<void> | void;
    finalizeRun: (args: {
      runId: string;
      rootRunId?: string;
      taskDescription: string;
      taskPrompt: string;
      conversationId: string;
      /**
       * Engine thread key of the agent that authored this run (for
       * orchestrator: equals `conversationId`; for resumable subagents:
       * the persisted `agentId`/`threadId`). Recorded as the
       * `Stella-Thread` commit trailer so the revert-notice hook can
       * route the "user undid your change" reminder back to the same
       * thread when the orchestrator later resumes it via `send_input`.
       * Optional for backwards compatibility — commits without it can
       * still be reverted, the notice just routes to the orchestrator
       * only.
       */
      threadKey?: string;
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
  scheduleApi?: ScheduleToolApi;
  sourceImportApi?: SourceImportToolApi;
  fashionApi?: FashionToolApi;
  runtimeStore: RuntimeStore;
  getAppBrowserContext?: () =>
    | Promise<HostAppBrowserContextSnapshot>
    | HostAppBrowserContextSnapshot;
  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];
  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;
  getDefaultConversationId?: () => string;
};

export type ChatPayload = {
  conversationId: string;
  userMessageId: string;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  attachments?: RuntimeAttachmentRef[];
  agentType?: string;
  storageMode?: "cloud" | "local";
  selfModMetadata?: {
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update" | "uninstall" | "desktop-update";
    expectedChangedFiles?: string[];
  };
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
};

export type RuntimeSendUserMessageInput = RuntimeSendMessageInput & {
  metadata?: Record<string, unknown>;
};

export type ActiveOrchestratorSession = RuntimeExecutionSessionHandle & {
  conversationId: string;
  agentType: string;
  uiVisibility: "visible" | "hidden";
  queueCallbackSwitch: (callbacks: AgentCallbacks) => void;
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
  onAssistantMessage?: (event: RuntimeAssistantMessageEvent) => void;
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
  execute: () => Promise<void>;
};

export type ParsedAgentLike = {
  id: string;
  name: string;
  description: string;
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
  modelCatalogUpdatedAt: number | null;
  isRunning: boolean;
  isInitialized: boolean;
  initializationPromise: Promise<void> | null;
  localAgentManager: LocalAgentManager | null;
  activeOrchestratorRunId: string | null;
  activeOrchestratorConversationId: string | null;
  activeOrchestratorUiVisibility: "visible" | "hidden";
  activeOrchestratorSession: ActiveOrchestratorSession | null;
  /**
   * Long-lived orchestrator sessions keyed by `conversationId`. Each session
   * owns one live Pi `Agent` for the lifetime of the conversation and is
   * reused across turns to keep provider prompt-cache prefixes stable. See
   * `runtime/kernel/agent-runtime/orchestrator-session.ts`. Disposed on
   * worker shutdown via `runtime-initialization.ts:stop`.
   */
  orchestratorSessions: Map<string, OrchestratorSession>;
  /**
   * Per-thread background compaction scheduler. Holds at most one
   * in-flight compaction per `threadKey`; finalize* paths schedule
   * fire-and-forget after `onEnd` fires so users never wait on the
   * summarization LLM. Drained on worker shutdown so SQLite writes
   * complete before the store handle tears down. See
   * `runtime/kernel/agent-runtime/compaction-scheduler.ts`.
   */
  compactionScheduler: BackgroundCompactionScheduler;
  queuedOrchestratorTurns: QueuedOrchestratorTurn[];
  activeRunAbortControllers: Map<string, AbortController>;
  conversationCallbacks: Map<string, AgentCallbacks>;
  runCallbacksByRunId: Map<string, AgentCallbacks>;
  loadedAgents: ParsedAgentLike[];
  /**
   * Late-bound web search handler. Wired by `createStellaHostRunner` after the
   * Convex session is created so the toolHost (built earlier in startup) can
   * reach Exa via the same convex-session call path that the rest of the
   * runtime uses. Stored on state so the toolHost can read it lazily.
   */
  webSearch:
    | ((
        query: string,
        options?: { category?: string },
      ) => Promise<{
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      }>)
    | null;
};

export type RunnerContext = {
  convexApi: unknown;
  deviceId: string;
  stellaAppDir: string;
  stellaDataDir: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaConnectCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  cliBridgeSocketPath?: string;
  selfModMonitor?: SelfModMonitor | null;
  selfModLifecycle?: StellaHostRunnerOptions["selfModLifecycle"];
  selfModHmrController?: StellaHostRunnerOptions["selfModHmrController"];
  requestCredential?: StellaHostRunnerOptions["requestCredential"];
  requestRuntimeAuthRefresh?: StellaHostRunnerOptions["requestRuntimeAuthRefresh"];
  scheduleApi?: ScheduleToolApi;
  fashionApi?: FashionToolApi;
  runtimeStore: RuntimeStore;
  listLocalChatEvents?: StellaHostRunnerOptions["listLocalChatEvents"];
  appendLocalChatEvent?: StellaHostRunnerOptions["appendLocalChatEvent"];
  getDefaultConversationId?: StellaHostRunnerOptions["getDefaultConversationId"];
  paths: RunnerPaths;
  state: RunnerState;
  hookEmitter: HookEmitter;
  toolHost: {
    getToolCatalog: (
      agentType?: string,
      options?: {
        model?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
        agentEngine?: import("../tools/file-edit-policy.js").FileEditAgentEngine;
        includeDeferred?: boolean;
      },
    ) => ToolMetadata[];
    executeTool: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      context: ToolContext,
      signal?: AbortSignal,
      onUpdate?: ToolUpdateCallback,
    ) => Promise<ToolResult>;
    registerExtensionTools: (tools: ToolDefinition[]) => void;
    /** Sweep user-extension tools (F1 hot-reload). Built-ins are untouched. */
    unregisterExtensionTools: () => void;
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
  getStoreGitObjectUrls: (
    packageId: string,
    releaseNumber: number,
    shas: string[],
  ) => Promise<Array<{ sha: string; r2Key: string; downloadUrl: string }>>;
};

export type RunnerPublicApi = {
  deviceId: string;
  hookEmitter: HookEmitter;
  setConvexUrl: (value: string | null) => void;
  setConvexSiteUrl: (value: string | null) => void;
  setAuthToken: (value: string | null) => void;
  setHasConnectedAccount: (value: boolean) => void;
  setCloudSyncEnabled: (enabled: boolean) => void;
  setModelCatalogUpdatedAt: (value: number | null) => void;
  start: () => void;
  stop: () => Promise<void>;
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
  warmModelCatalog: () => Promise<void>;
  webSearch: (
    query: string,
    options?: { category?: string },
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
  getStoreGitObjectUrls: StoreOperations["getStoreGitObjectUrls"];
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
  listActiveAgentRuns: () => RuntimeActiveRun[];
  getLocalAgentSnapshot: (agentId: string) => Promise<AgentToolSnapshot | null>;
  cancelLocalAgent: (
    agentId: string,
    reason?: string,
  ) => Promise<{ canceled: boolean }>;
  cancelLocalChat: (runId: string) => void;
  /**
   * Cancel the active orchestrator run for the given local conversation,
   * if one exists. Returns `true` if a run was cancelled. Used by the
   * remote-turn cancel path so callers don't need to track runIds.
   */
  cancelLocalChatByConversation: (conversationId: string) => boolean;
  getActiveOrchestratorRun: () => RuntimeActiveRun | null;
  appendThreadMessage: (args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) => void;
  notifyOrchestratorHistoryChanged: (conversationId: string) => void;
  getVoiceOrchestratorConfig: (
    payload: RuntimeVoiceOrchestratorConfigRequest,
  ) => Promise<RuntimeVoiceOrchestratorConfig>;
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
  triggerDreamNow: (trigger?: "manual" | "startup_catchup") => Promise<{
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
    pendingItems: number;
    detail?: string;
  }>;
  /**
   * Run one Chronicle rolling-summary pass for the given window. Reads the
   * tail of `~/.stella/chronicle/captures.jsonl`, calls a single cheap LLM
   * completion, atomically rewrites
   * `~/.stella/memories_extensions/chronicle/{window}-current.md`, and queues
   * the digest in the Dream inbox. Designed to be called by Electron on a
   * fixed cadence (every 1 minute for "10m", every 1 hour for "6h").
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
