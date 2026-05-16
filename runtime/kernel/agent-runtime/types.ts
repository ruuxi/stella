import type { AgentMessage } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
// Type-only imports — both session classes import from this file, so a
// runtime import would form a cycle. The types are consumed only as
// opaque options below so type-only resolution at compile time is enough.
import type { OrchestratorSession } from "./orchestrator-session.js";
import type { SubagentSession } from "./subagent-session.js";
import type { BackgroundCompactionScheduler } from "./compaction-scheduler.js";
import type {
  AgentToolRequest,
  ToolContext,
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type { LocalContextEvent } from "../local-history.js";
import type { LocalChatAppendEventArgs } from "../storage/shared.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
  RuntimeAgentEventPayload,
} from "../../protocol/index.js";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "../../contracts/file-changes.js";

export type SelfModAppliedPayload = {
  featureId: string;
  files: string[];
  batchIndex: number;
};

export type SelfModMonitor = {
  getBaselineHead: (repoRoot: string) => Promise<string | null>;
  detectAppliedSince: (args: {
    repoRoot: string;
    sinceHead: string | null;
  }) => Promise<SelfModAppliedPayload | null>;
};

export type RuntimeStreamEvent = {
  runId: string;
  agentType: string;
  seq: number;
  chunk: string;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeReasoningEvent = RuntimeStreamEvent;

export type RuntimeRunStartedEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeToolStartEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeToolEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  resultPreview: string;
  details?: unknown;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeErrorEvent = {
  runId: string;
  agentType: string;
  seq: number;
  error: string;
  fatal: boolean;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeStatusEvent = {
  runId: string;
  agentType: string;
  seq: number;
  statusState: "running" | "compacting" | "provider-retry";
  statusText: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeUserMessageEvent = {
  userMessageId: string;
  text: string;
  timestamp: number;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeAssistantMessageEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  text: string;
  timestamp: number;
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  finalText: string;
  persisted: boolean;
  selfModApplied?: SelfModAppliedPayload;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeInterruptedEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  reason: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeExecutionSessionHandle = {
  runId: string;
  threadKey: string;
  queueUserMessageId: (userMessageId: string, onStart?: () => void) => void;
  agent: {
    state: {
      isStreaming: boolean;
    };
    steer: (message: AgentMessage) => void;
    followUp: (message: AgentMessage) => void;
  };
};

export type RuntimeRunCallbacks = {
  onRunStarted?: (event: RuntimeRunStartedEvent) => void;
  onUserMessage?: (event: RuntimeUserMessageEvent) => void;
  onAssistantMessage?: (event: RuntimeAssistantMessageEvent) => void;
  onStream: (event: RuntimeStreamEvent) => void;
  onReasoning?: (event: RuntimeReasoningEvent) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
  onInterrupted?: (event: RuntimeInterruptedEvent) => void;
};

export type BaseRunOptions = {
  runId?: string;
  rootRunId?: string;
  agentId?: string;
  conversationId: string;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  agentType: string;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  attachments?: RuntimeAttachmentRef[];
  selfModMetadata?: AgentToolRequest["selfModMetadata"];
  agentContext: LocalAgentContext;
  toolCatalog?: ToolMetadata[];
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  deviceId: string;
  stellaHome: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  abortSignal?: AbortSignal;
  stellaRoot?: string;
  toolWorkspaceRoot?: string;
  selfModMonitor?: SelfModMonitor | null;
  hookEmitter?: HookEmitter;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  /**
   * Append a local-chat event for the conversation. Routes through the
   * worker server wrapper that also fires the `localChat:updated`
   * notification, so the renderer re-fetches reactively.
   */
  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;
  /**
   * Read recent local-chat events for the conversation. Used by post-run
   * background passes (e.g. home-suggestions refresh) that need a
   * snapshot of the persisted event log.
   */
  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];
  /**
   * Resolve the LLM route for a sibling agent type (e.g. "home_suggestions")
   * so post-run background passes can run on a different model mode than
   * the agent that just finalized. Lazy: only invoked when actually needed.
   */
  resolveSubsidiaryLlmRoute?: (agentType: string) => ResolvedLlmRoute;
  /**
   * Per-thread compaction scheduler. finalize* paths run thread compaction
   * in the background AFTER the user-visible `onEnd` fires, so the user
   * never waits on the summarization LLM.
   *
   * One scheduler instance is shared across the runtime — see
   * `RunnerContext.state.compactionScheduler`. The scheduler enforces
   * one in-flight compaction per `threadKey`, which is what prevents
   * double-overlay races when turns finalize back-to-back.
   */
  compactionScheduler: BackgroundCompactionScheduler;
};

export type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: RuntimeRunCallbacks;
  onExecutionSessionCreated?: (session: RuntimeExecutionSessionHandle) => void;
  beforeRunEnd?: (args: {
    runId: string;
    threadKey: string;
    finalText: string;
    outcome: "success";
  }) => Promise<void> | void;
  /**
   * Memory-review user-turn counter AFTER incrementing for this run, threaded
   * from prepareOrchestratorRun. Consumed by finalizeOrchestratorSuccess to
   * decide whether to fire the background memory review.
   * Undefined for synthetic (uiVisibility=hidden) turns.
   */
  userTurnsSinceMemoryReview?: number;
  /**
   * Long-lived per-conversation session. When provided, the Pi engine path
   * routes through `session.runTurn(opts)` so the underlying `Agent`
   * survives across turns and provider prompt-cache prefixes stay stable.
   * The external engine path (`runExternalOrchestratorTurn`) ignores this
   * field; external engines own their own session concept on the binary
   * side. Direct test helpers may omit it and get an ephemeral session
   * through `runOrchestratorTurn`, but the Pi execution path is still the
   * same session code.
   */
  orchestratorSession?: OrchestratorSession;
};

export type SubagentRunOptions = BaseRunOptions & {
  onProgress?: (chunk: string) => void;
  callbacks?: Partial<RuntimeRunCallbacks>;
  suppressCompletionSideEffects?: boolean;
  /**
   * Long-lived per-task subagent session. When provided, the Pi engine
   * path routes through `session.runTurn(opts)` so the underlying `Agent`
   * survives across `send_input` / restart-on-input cycles. The external
   * engine path ignores this. See `SubagentSession` for lifecycle.
   */
  subagentSession?: SubagentSession;
};

export type SubagentRunResult = {
  runId: string;
  result: string;
  error?: string;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
};
