import {
  shutdownExternalEngineIntegrations,
  runExternalOrchestratorTurn,
  runExternalSubagentTurn,
} from "./agent-runtime/external-engines.js";
import { OrchestratorSession } from "./agent-runtime/orchestrator-session.js";
import { SubagentSession } from "./agent-runtime/subagent-session.js";
import { DEFAULT_MAX_TURNS } from "./agent-runtime/shared.js";
import type { SubagentRunResult } from "./agent-runtime/types.js";

export type {
  SelfModAppliedPayload,
  SelfModMonitor,
  RuntimeExecutionSessionHandle,
  RuntimeReasoningEvent,
  RuntimeRunStartedEvent,
  RuntimeStreamEvent,
  RuntimeToolStartEvent,
  RuntimeToolEndEvent,
  RuntimeErrorEvent,
  RuntimeStatusEvent,
  RuntimeEndEvent,
  RuntimeAssistantMessageEvent,
  RuntimeUserMessageEvent,
  RuntimeRunCallbacks,
} from "./agent-runtime/types.js";

import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "./agent-runtime/types.js";

export async function runOrchestratorTurn(
  opts: OrchestratorRunOptions,
): Promise<string> {
  const integratedResult = await runExternalOrchestratorTurn(opts);
  if (integratedResult) {
    return integratedResult;
  }
  const ownsSession = !opts.orchestratorSession;
  const session =
    opts.orchestratorSession ?? new OrchestratorSession(opts.conversationId);
  try {
    return await session.runTurn(opts);
  } finally {
    if (ownsSession) {
      session.dispose();
    }
  }
}

export async function runSubagentTask(
  opts: SubagentRunOptions,
): Promise<SubagentRunResult> {
  const integratedResult = await runExternalSubagentTurn(opts);
  if (integratedResult) {
    return integratedResult;
  }
  if (opts.subagentSession) {
    return await opts.subagentSession.runTurn(opts);
  }
  const session = new SubagentSession(
    opts.agentId ?? opts.runId ?? opts.userMessageId,
    opts.conversationId,
    opts.agentType,
  );
  try {
    return await session.runTurn(opts);
  } finally {
    session.dispose();
  }
}

export const shutdownSubagentRuntimes = (): void => {
  shutdownExternalEngineIntegrations();
};

export const PI_RUNTIME_MAX_TURNS = DEFAULT_MAX_TURNS;
