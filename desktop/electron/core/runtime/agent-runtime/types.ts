import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type { RuntimeStore } from "../../../storage/runtime-store.js";

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
};

export type RuntimeErrorEvent = {
  runId: string;
  agentType: string;
  seq: number;
  error: string;
  fatal: boolean;
};

export type RuntimeEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  finalText: string;
  persisted: boolean;
  selfModApplied?: SelfModAppliedPayload;
};

export type RuntimeRunCallbacks = {
  onStream: (event: RuntimeStreamEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
};

export type BaseRunOptions = {
  runId?: string;
  rootRunId?: string;
  conversationId: string;
  userMessageId: string;
  agentType: string;
  userPrompt: string;
  agentContext: LocalTaskManagerAgentContext;
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
