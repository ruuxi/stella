import type { Agent } from "../agent-core/agent.js";
import { createRuntimeLogger } from "../debug.js";
import type { RuntimeRunEventRecorder } from "./run-events.js";
import {
  compactRuntimeThreadHistory,
  updateOrchestratorReminderState,
} from "./thread-memory.js";
import type {
  OrchestratorRunOptions,
  SelfModAppliedPayload,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";

const logger = createRuntimeLogger("agent-runtime.completion");
const REPORTED_ORCHESTRATOR_ERROR = Symbol("reportedOrchestratorError");

const safeErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message || fallback : fallback;

export const markOrchestratorErrorReported = (error: unknown): Error => {
  const normalized =
    error instanceof Error
      ? error
      : new Error(safeErrorMessage(error, "Stella runtime failed"));

  Object.defineProperty(normalized, REPORTED_ORCHESTRATOR_ERROR, {
    value: true,
    configurable: true,
  });

  return normalized;
};

export const isReportedOrchestratorError = (error: unknown): boolean =>
  error instanceof Error &&
  Boolean(
    (error as Error & { [REPORTED_ORCHESTRATOR_ERROR]?: boolean })[
      REPORTED_ORCHESTRATOR_ERROR
    ],
  );

const emitAgentEndHook = async (
  opts: OrchestratorRunOptions,
  finalText: string,
): Promise<void> => {
  if (!opts.hookEmitter) {
    return;
  }
  await opts.hookEmitter
    .emit(
      "agent_end",
      { agentType: opts.agentType, finalText },
      { agentType: opts.agentType },
    )
    .catch(() => undefined);
};

const detectSelfModApplied = async (
  opts: OrchestratorRunOptions,
  baselineHead: string | null,
): Promise<SelfModAppliedPayload | null> =>
  opts.frontendRoot && opts.selfModMonitor
    ? await opts.selfModMonitor
        .detectAppliedSince({
          repoRoot: opts.frontendRoot,
          sinceHead: baselineHead,
        })
        .catch(() => null)
    : null;

type CompactableAgentState = {
  state: Pick<Agent["state"], "messages">;
};

const maybeCompactOrchestratorThread = async (args: {
  opts: OrchestratorRunOptions;
  agent: CompactableAgentState;
  threadKey: string;
  finalText: string;
}) => {
  if (!args.finalText.trim()) {
    return;
  }

  let shouldCompact = true;
  if (args.opts.hookEmitter) {
    const hookResult = await args.opts.hookEmitter
      .emit(
        "before_compact",
        {
          agentType: args.opts.agentType,
          messageCount: args.agent.state.messages.length,
        },
        { agentType: args.opts.agentType },
      )
      .catch(() => undefined);
    if (hookResult?.cancel) {
      shouldCompact = false;
    }
  }

  if (!shouldCompact) {
    return;
  }

  await compactRuntimeThreadHistory({
    store: args.opts.store,
    threadKey: args.threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
  });
};

export const finalizeOrchestratorSuccess = async (args: {
  opts: OrchestratorRunOptions;
  runId: string;
  threadKey: string;
  runEvents: RuntimeRunEventRecorder;
  agent: CompactableAgentState;
  finalText: string;
  baselineHead: string | null;
}): Promise<void> => {
  logger.debug("orchestrator.end", {
    runId: args.runId,
    agentType: args.opts.agentType,
    finalTextPreview: args.finalText.slice(0, 300),
  });

  await emitAgentEndHook(args.opts, args.finalText);
  const selfModApplied = await detectSelfModApplied(args.opts, args.baselineHead);
  await maybeCompactOrchestratorThread({
    opts: args.opts,
    agent: args.agent,
    threadKey: args.threadKey,
    finalText: args.finalText,
  });

  args.opts.callbacks.onEnd(
    args.runEvents.recordRunEnd({
      finalText: args.finalText,
      ...(selfModApplied ? { selfModApplied } : {}),
    }),
  );

  updateOrchestratorReminderState(args.opts.store, {
    conversationId: args.opts.conversationId,
    shouldInjectDynamicReminder:
      args.opts.agentContext.shouldInjectDynamicReminder,
    finalText: args.finalText,
  });
};

export const finalizeOrchestratorError = (args: {
  opts: OrchestratorRunOptions;
  runEvents: RuntimeRunEventRecorder;
  error: unknown;
}): string => {
  const errorMessage = safeErrorMessage(args.error, "Stella runtime failed");
  args.opts.callbacks.onError(args.runEvents.recordError(errorMessage));
  return errorMessage;
};

export const finalizeSubagentSuccess = async (args: {
  opts: SubagentRunOptions;
  runEvents: RuntimeRunEventRecorder;
  runId: string;
  threadKey: string;
  result: string;
}): Promise<SubagentRunResult> => {
  if (args.result.trim()) {
    await compactRuntimeThreadHistory({
      store: args.opts.store,
      threadKey: args.threadKey,
      resolvedLlm: args.opts.resolvedLlm,
      agentType: args.opts.agentType,
    });
  }
  args.opts.callbacks?.onEnd?.(
    args.runEvents.recordRunEnd({ finalText: args.result }),
  );

  return {
    runId: args.runId,
    result: args.result,
  };
};

export const finalizeSubagentError = (args: {
  opts: SubagentRunOptions;
  runEvents: RuntimeRunEventRecorder;
  runId: string;
  error: unknown;
}): SubagentRunResult => {
  const errorMessage = safeErrorMessage(args.error, "Subagent failed");
  args.opts.callbacks?.onError?.(args.runEvents.recordError(errorMessage));
  return {
    runId: args.runId,
    result: "",
    error: errorMessage,
  };
};
