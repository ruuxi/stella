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
  | "taskId"
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
  | "webSearch"
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
    taskId: opts.taskId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaRoot: opts.stellaRoot,
    taskDepth: opts.agentContext.taskDepth ?? 0,
    maxTaskDepth: opts.agentContext.maxTaskDepth,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    toolCatalog: opts.toolCatalog,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
    hookEmitter: opts.hookEmitter,
  });
  // [diagnostic] one-line dump of every tool the model is being shown for this
  // run. Routed through console.log so it ignores the runtime log level.
  console.log(
    `[diagnostic] tools advertised to model | agent=${opts.agentType} | runId=${runId} | count=${tools.length} | names=${tools
      .map((t) => t.name)
      .join(",")}`,
  );

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
