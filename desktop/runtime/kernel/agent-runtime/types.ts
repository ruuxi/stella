import type { AgentMessage } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import type {
  TaskToolRequest,
  ToolContext,
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
  RuntimeAgentEventPayload,
} from "../../protocol/index.js";

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
};

export type RuntimeRunStartedEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
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
  statusState: "running" | "compacting";
  statusText: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeUserMessageEvent = {
  userMessageId: string;
  text: string;
  timestamp: number;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  finalText: string;
  persisted: boolean;
  selfModApplied?: SelfModAppliedPayload;
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
  onStream: (event: RuntimeStreamEvent) => void;
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
  taskId?: string;
  conversationId: string;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  agentType: string;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  attachments?: RuntimeAttachmentRef[];
  selfModMetadata?: TaskToolRequest["selfModMetadata"];
  agentContext: LocalTaskManagerAgentContext;
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
  selfModMonitor?: SelfModMonitor | null;
  webSearch?: (
    query: string,
    options?: {
      category?: string;
    },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  hookEmitter?: HookEmitter;
  displayHtml?: (html: string) => void;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: RuntimeRunCallbacks;
  onExecutionSessionCreated?: (
    session: RuntimeExecutionSessionHandle,
  ) => void;
};

export type SubagentRunOptions = BaseRunOptions & {
  onProgress?: (chunk: string) => void;
  callbacks?: Partial<RuntimeRunCallbacks>;
};

export type SubagentRunResult = {
  runId: string;
  result: string;
  error?: string;
};
