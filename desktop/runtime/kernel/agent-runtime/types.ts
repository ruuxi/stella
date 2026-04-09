import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import type {
  TaskToolRequest,
  ToolContext,
  ToolMetadata,
  ToolResult,
} from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
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
};

export type RuntimeToolStartEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type RuntimeToolEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  resultPreview: string;
  details?: unknown;
};

export type RuntimeErrorEvent = {
  runId: string;
  agentType: string;
  seq: number;
  error: string;
  fatal: boolean;
};

export type RuntimeStatusEvent = {
  runId: string;
  agentType: string;
  seq: number;
  statusState: "running" | "compacting";
  statusText: string;
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
};

export type RuntimeRunCallbacks = {
  onUserMessage?: (event: RuntimeUserMessageEvent) => void;
  onStream: (event: RuntimeStreamEvent) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
};

export type BaseRunOptions = {
  runId?: string;
  rootRunId?: string;
  taskId?: string;
  conversationId: string;
  userMessageId: string;
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
  ) => Promise<ToolResult>;
  deviceId: string;
  stellaHome: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  abortSignal?: AbortSignal;
  frontendRoot?: string;
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
};

export type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: RuntimeRunCallbacks;
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
