import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AGENT_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import type { Agent } from "../agent-core/agent.js";
import { createRuntimeLogger } from "../debug.js";
import type { RuntimeRunEventRecorder } from "./run-events.js";
import {
  compactRuntimeThreadHistory,
  updateOrchestratorReminderState,
} from "./thread-memory.js";
import {
  MEMORY_REVIEW_TURN_THRESHOLD,
  spawnMemoryReview,
} from "./memory-review.js";
import type {
  OrchestratorRunOptions,
  SelfModAppliedPayload,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";

const logger = createRuntimeLogger("agent-runtime.completion");
const REPORTED_ORCHESTRATOR_ERROR = Symbol("reportedOrchestratorError");
const INTERRUPT_MESSAGE_RE =
  /^(?:aborted|request was aborted\.?|request aborted by user|interrupted by .+|canceled(?: because .*)?|this operation was aborted|claude code run aborted\.?)$/i;

const safeErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message || fallback : fallback;

const normalizeInterruptionReason = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === "this operation was aborted") {
    return "Canceled";
  }
  if (/^(?:aborted|request was aborted\.?|request aborted by user|claude code run aborted\.?)$/i.test(trimmed)) {
    return "Canceled";
  }
  return trimmed;
};

export const resolveInterruptionReason = (args: {
  abortSignal?: AbortSignal;
  error?: unknown;
}): string | null => {
  const signalReason = args.abortSignal?.aborted
    ? normalizeInterruptionReason(
        args.abortSignal.reason instanceof Error
          ? args.abortSignal.reason.message
          : typeof args.abortSignal.reason === "string"
            ? args.abortSignal.reason
            : undefined,
      ) ?? "Canceled"
    : null;
  if (signalReason) {
    return signalReason;
  }

  const message = safeErrorMessage(args.error, "").trim();
  if (!message || !INTERRUPT_MESSAGE_RE.test(message)) {
    return null;
  }
  return normalizeInterruptionReason(message) ?? "Canceled";
};

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

const appendLifeNote = async (
  stellaHome: string,
  runId: string,
  finalText: string,
): Promise<void> => {
  if (!finalText.trim()) return;

  const notesDir = join(stellaHome, "state", "notes");
  const today = new Date().toISOString().slice(0, 10);
  const notesFile = join(notesDir, `${today}.md`);
  const timestamp = new Date().toISOString().slice(11, 19);
  const entry = `\n## ${timestamp}\n\nrun: \`${runId}\`\n\n${finalText.trim()}\n`;

  try {
    await mkdir(notesDir, { recursive: true });
    await appendFile(notesFile, entry, "utf-8");
  } catch {
    logger.debug("life-notes.append-failed", { notesFile });
  }
};

const shouldAppendLifeNote = (agentType: string): boolean =>
  agentType === AGENT_IDS.GENERAL;

const detectSelfModApplied = async (
  opts: OrchestratorRunOptions,
  baselineHead: string | null,
): Promise<SelfModAppliedPayload | null> =>
  opts.stellaRoot && opts.selfModMonitor
    ? await opts.selfModMonitor
        .detectAppliedSince({
          repoRoot: opts.stellaRoot,
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
  responseTarget?: OrchestratorRunOptions["responseTarget"];
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
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    }),
  );

  updateOrchestratorReminderState(args.opts.store, {
    conversationId: args.opts.conversationId,
    shouldInjectDynamicReminder:
      args.opts.agentContext.shouldInjectDynamicReminder,
    finalText: args.finalText,
  });

  // Background memory review - fires AFTER onEnd so the user already sees the
  // final text before we spawn any extra work. Only triggers when:
  //   - this is the Orchestrator (memory is exclusively the Orchestrator's domain)
  //   - the run was a real user turn (uiVisibility !== "hidden")
  //   - the user-turn counter from prepareOrchestratorRun has reached threshold
  if (
    args.opts.agentType === AGENT_IDS.ORCHESTRATOR
    && args.opts.userTurnsSinceMemoryReview != null
    && args.opts.userTurnsSinceMemoryReview >= MEMORY_REVIEW_TURN_THRESHOLD
  ) {
    spawnMemoryReview({
      conversationId: args.opts.conversationId,
      messagesSnapshot: [...args.agent.state.messages],
      resolvedLlm: args.opts.resolvedLlm,
      store: args.opts.store,
    });
  }
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

export const finalizeOrchestratorInterrupted = (args: {
  opts: OrchestratorRunOptions;
  runEvents: RuntimeRunEventRecorder;
  reason: string;
}): string => {
  args.opts.callbacks.onInterrupted?.(
    args.runEvents.recordInterrupted(args.reason),
  );
  return args.reason;
};

export const finalizeSubagentSuccess = async (args: {
  opts: SubagentRunOptions;
  runEvents: RuntimeRunEventRecorder;
  runId: string;
  threadKey: string;
  result: string;
}): Promise<SubagentRunResult> => {
  if (shouldAppendLifeNote(args.opts.agentType)) {
    await appendLifeNote(args.opts.stellaHome, args.runId, args.result);
  }
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

export const finalizeSubagentInterrupted = (args: {
  opts: SubagentRunOptions;
  runEvents: RuntimeRunEventRecorder;
  runId: string;
  reason: string;
}): SubagentRunResult => {
  args.opts.callbacks?.onInterrupted?.(
    args.runEvents.recordInterrupted(args.reason),
  );
  return {
    runId: args.runId,
    result: "",
  };
};
