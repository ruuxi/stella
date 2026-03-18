import type { ConvexClient } from "convex/browser";
import type { ParsedSkill } from "../agents/manifests.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
  SelfModMonitor,
} from "../agent-runtime.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { LocalContextEvent } from "../local-history.js";
import type {
  ScheduleToolApi,
  TaskToolRequest,
  ToolContext,
  ToolResult,
} from "../tools/types.js";
import type { ToolDefinition } from "../extensions/types.js";
import type {
  LocalTaskManager,
  TaskLifecycleEvent,
} from "../tasks/local-task-manager.js";
import type { RuntimeStore } from "../../../storage/runtime-store.js";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseManifest,
  SelfModHmrState,
} from "../../../../src/shared/contracts/electron-data.js";

export type StellaHostRunnerOptions = {
  deviceId: string;
  stellaHomePath: string;
  frontendRoot?: string;
  stellaBrowserBinPath?: string;
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
    resume: (runId: string) => Promise<boolean>;
    forceResumeAll: () => Promise<boolean>;
    getStatus: () => Promise<{
      queuedFiles: number;
      requiresFullReload: boolean;
    } | null>;
  } | null;
  getHmrMorphOrchestrator?: () => {
    runTransition: (args: {
      resumeHmr: () => Promise<void>;
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
};

export type ChatPayload = {
  conversationId: string;
  userMessageId: string;
  userPrompt: string;
  agentType?: string;
  storageMode?: "cloud" | "local";
};

export type AgentHealth = {
  ready: boolean;
  reason?: string;
  engine?: string;
};

export type AgentCallbacks = {
  onStream: (event: RuntimeStreamEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
  onTaskEvent?: (event: TaskLifecycleEvent) => void;
  onSelfModHmrState?: (event: SelfModHmrState) => void;
  onHmrResume?: (args: {
    resumeHmr: () => Promise<void>;
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
  delegationAllowlist?: string[];
  defaultSkills?: string[];
  model?: string;
  maxTaskDepth?: number;
};

export type RunnerPaths = {
  skillsPath: string;
  coreSkillsPath: string;
  agentsPath: string;
  extensionsPath: string;
};

export type RunnerState = {
  proxyBaseUrl: string | null;
  authToken: string | null;
  convexDeploymentUrl: string | null;
  convexClient: ConvexClient | null;
  convexClientUrl: string | null;
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
  loadedSkills: ParsedSkill[];
  loadedSkillsPromise: Promise<ParsedSkill[]> | null;
};

export type RunnerContext = {
  convexApi: unknown;
  deviceId: string;
  stellaHomePath: string;
  frontendRoot?: string;
  stellaBrowserBinPath?: string;
  stellaUiCliPath?: string;
  selfModMonitor?: SelfModMonitor | null;
  selfModLifecycle?: StellaHostRunnerOptions["selfModLifecycle"];
  selfModHmrController?: StellaHostRunnerOptions["selfModHmrController"];
  getHmrMorphOrchestrator?: StellaHostRunnerOptions["getHmrMorphOrchestrator"];
  signHeartbeatPayload?: StellaHostRunnerOptions["signHeartbeatPayload"];
  requestCredential?: StellaHostRunnerOptions["requestCredential"];
  scheduleApi?: ScheduleToolApi;
  displayHtml?: (html: string) => void;
  runtimeStore: RuntimeStore;
  listLocalChatEvents?: StellaHostRunnerOptions["listLocalChatEvents"];
  paths: RunnerPaths;
  state: RunnerState;
  hookEmitter: HookEmitter;
  toolHost: {
    setSkills: (skills: ParsedSkill[]) => void;
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
  createFirstStoreRelease: (args: {
    packageId: string;
    featureId: string;
    displayName: string;
    description: string;
    releaseNotes?: string;
    manifest: StoreReleaseManifest;
    artifact: StoreReleaseArtifact;
  }) => Promise<StorePackageReleaseRecord>;
  createStoreReleaseUpdate: (args: {
    packageId: string;
    featureId: string;
    displayName: string;
    description: string;
    releaseNotes?: string;
    manifest: StoreReleaseManifest;
    artifact: StoreReleaseArtifact;
  }) => Promise<StorePackageReleaseRecord>;
};

export type RunnerPublicApi = {
  deviceId: string;
  hookEmitter: HookEmitter;
  setConvexUrl: (value: string | null) => void;
  setAuthToken: (value: string | null) => void;
  setCloudSyncEnabled: (enabled: boolean) => void;
  start: () => void;
  stop: () => void;
  subscribeQuery: (
    query: unknown,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => (() => void) | null;
  getConvexUrl: () => string | null;
  getProxy: () => { baseUrl: string; authToken: string } | null;
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
  runAutomationTurn: (payload: {
    conversationId: string;
    userPrompt: string;
    agentType?: string;
  }) => Promise<
    | { status: "ok"; finalText: string }
    | { status: "busy"; finalText: ""; error: string }
    | { status: "error"; finalText: ""; error: string }
  >;
  runBlockingLocalTask: (
    request: Omit<TaskToolRequest, "storageMode">,
  ) => Promise<
    | { status: "ok"; finalText: string; taskId: string }
    | { status: "error"; finalText: ""; error: string; taskId?: string }
  >;
  createBackgroundTask: (
    request: Omit<TaskToolRequest, "storageMode">,
  ) => Promise<{ taskId: string }>;
  cancelLocalChat: (runId: string) => void;
  getActiveOrchestratorRun: () => {
    runId: string;
    conversationId: string;
  } | null;
  recoverCrashedRuns: () => Promise<void>;
  appendThreadMessage: (args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) => void;
};
