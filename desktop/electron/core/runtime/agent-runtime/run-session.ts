import crypto from "crypto";
import { createRuntimeAgent } from "./shared.js";
import { buildHistorySource, buildRunThreadKey } from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";
import { createRunEventRecorder } from "./run-events.js";
import type {
  BaseRunOptions,
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "./types.js";

type SessionOptions = Pick<
  BaseRunOptions,
  | "runId"
  | "rootRunId"
  | "conversationId"
  | "agentType"
  | "agentContext"
  | "deviceId"
  | "stellaHome"
  | "frontendRoot"
  | "store"
  | "toolExecutor"
  | "webSearch"
  | "hookEmitter"
  | "resolvedLlm"
> & {
  systemPrompt: string;
  runIdPrefix?: string;
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
  });

  const tools = createPiTools({
    runId,
    rootRunId: opts.rootRunId ?? runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    frontendRoot: opts.frontendRoot,
    taskDepth: opts.agentContext.taskDepth ?? 0,
    maxTaskDepth: opts.agentContext.maxTaskDepth,
    delegationAllowlist: opts.agentContext.delegationAllowlist,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    defaultSkills: opts.agentContext.defaultSkills,
    skillIds: opts.agentContext.skillIds,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
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
  opts: OrchestratorRunOptions & { systemPrompt: string },
) => createRuntimeExecutionSession(opts);

export const createSubagentExecutionSession = (
  opts: SubagentRunOptions & { systemPrompt: string },
) =>
  createRuntimeExecutionSession({
    ...opts,
    runIdPrefix: "local:sub",
  });
