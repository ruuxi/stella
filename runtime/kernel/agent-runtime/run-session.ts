import crypto from "crypto";
import { createRuntimeAgent } from "./shared.js";
import { buildHistorySource, buildRunThreadKey } from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";
import { createRunEventRecorder } from "./run-events.js";
import type { OrchestratorResponseTargetTracker } from "./response-target.js";
import type {
  BaseRunOptions,
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "./types.js";

type SessionOptions = Pick<
  BaseRunOptions,
  | "runId"
  | "rootRunId"
  | "agentId"
  | "conversationId"
  | "userMessageId"
  | "uiVisibility"
  | "agentType"
  | "agentContext"
  | "toolCatalog"
  | "deviceId"
  | "stellaRoot"
  | "store"
  | "toolExecutor"
  | "hookEmitter"
  | "resolvedLlm"
  | "responseTarget"
> & {
  systemPrompt: string;
  runIdPrefix?: string;
  responseTargetTracker?: OrchestratorResponseTargetTracker;
};

export type RuntimeExecutionSession = {
  runId: string;
  threadKey: string;
  runEvents: ReturnType<typeof createRunEventRecorder>;
  tools: ReturnType<typeof createPiTools>;
  agent: ReturnType<typeof createRuntimeAgent>;
};

export const createRuntimeExecutionSession = (
  opts: SessionOptions,
): RuntimeExecutionSession => {
  const runId = opts.runId ?? `${opts.runIdPrefix ?? "local"}:${crypto.randomUUID()}`;
  const threadKey = buildRunThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  const runEvents = createRunEventRecorder({
    store: opts.store,
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    userMessageId: opts.userMessageId,
    uiVisibility: opts.uiVisibility,
  });

  const tools = createPiTools({
    runId,
    rootRunId: opts.rootRunId ?? runId,
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaRoot: opts.stellaRoot,
    agentDepth: opts.agentContext.agentDepth ?? 0,
    maxAgentDepth: opts.agentContext.maxAgentDepth,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    toolCatalog: opts.toolCatalog,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    hookEmitter: opts.hookEmitter,
  });

  const historySource = buildHistorySource(opts.agentContext);
  const agent = createRuntimeAgent({
    agentType: opts.agentType,
    systemPrompt: opts.systemPrompt,
    resolvedLlm: opts.resolvedLlm,
    hookEmitter: opts.hookEmitter,
    tools,
    historySource,
    afterToolCall: async (context) => {
      opts.responseTargetTracker?.noteToolEnd(
        context.toolCall.name,
        context.result.details,
      );
      return undefined;
    },
  });

  return {
    runId,
    threadKey,
    runEvents,
    tools,
    agent,
  };
};

export const createOrchestratorExecutionSession = (
  opts: OrchestratorRunOptions & {
    systemPrompt: string;
    responseTargetTracker?: OrchestratorResponseTargetTracker;
  },
) => createRuntimeExecutionSession(opts);

export const createSubagentExecutionSession = (
  opts: SubagentRunOptions & { systemPrompt: string },
) =>
  createRuntimeExecutionSession({
    ...opts,
    runIdPrefix: "local:sub",
  });
