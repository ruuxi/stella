import { AGENT_IDS } from "../../contracts/agent-runtime.js";
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
import {
  HOME_SUGGESTIONS_REFRESH_THRESHOLD,
  spawnHomeSuggestionsRefresh,
} from "./home-suggestions-refresh.js";
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

const shouldRecordThreadSummary = (agentType: string): boolean =>
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
  let hookCompaction:
    | { summary: string; preserveLastN?: number }
    | undefined;
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
    const summary = hookResult?.compaction?.summary?.trim();
    if (summary) {
      hookCompaction = {
        summary,
        ...(hookResult?.compaction?.preserveLastN !== undefined
          ? { preserveLastN: hookResult.compaction.preserveLastN }
          : {}),
      };
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
    ...(hookCompaction
      ? {
          overrideSummary: hookCompaction.summary,
          ...(hookCompaction.preserveLastN !== undefined
            ? { preserveLastN: hookCompaction.preserveLastN }
            : {}),
        }
      : {}),
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
  if (
    !args.opts.suppressCompletionSideEffects &&
    shouldRecordThreadSummary(args.opts.agentType)
  ) {
    // Stage 1 SQLite store: durable, queryable rollout summary feed for the
    // Dream protocol. Best-effort — never block the subagent finalize path.
    try {
      args.opts.store.threadSummariesStore.record({
        threadId: args.threadKey,
        runId: args.runId,
        agentType: args.opts.agentType,
        rolloutSummary: args.result,
      });
    } catch (error) {
      logger.debug("thread-summaries.record-failed", {
        threadKey: args.threadKey,
        runId: args.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Notify the Dream scheduler that there is fresh material. Lazy import
    // to avoid a cycle with run-completion <-> dream-scheduler types.
    try {
      const { maybeSpawnDreamRun } = await import("./dream-scheduler.js");
      void maybeSpawnDreamRun({
        stellaHome: args.opts.stellaHome,
        store: args.opts.store,
        resolvedLlm: args.opts.resolvedLlm,
        trigger: "subagent_finalize",
      }).catch((error) => {
        logger.debug("dream-scheduler.notify-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.debug("dream-scheduler.notify-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Background home-suggestions refresh. Counter ticks once per
    // successful General-agent finalize for this conversation; the
    // cheap-LLM refresh fires when it crosses the threshold and the
    // counter is reset to zero by the spawn helper. We need both
    // local-chat helpers (read current suggestions, append the new
    // event with the renderer-notify wrapper) to be plumbed through.
    if (
      args.opts.appendLocalChatEvent &&
      args.opts.listLocalChatEvents &&
      args.opts.conversationId
    ) {
      try {
        const finalizes = args.opts.store
          .incrementGeneralFinalizesSinceHomeSuggestionsRefresh(
            args.opts.conversationId,
          );
        if (finalizes >= HOME_SUGGESTIONS_REFRESH_THRESHOLD) {
          // Resolve the dedicated `home_suggestions` route (cheap reasoning
          // model) when available; fall back to the general agent's route
          // so the refresh still fires if the resolver isn't wired.
          let resolvedLlm = args.opts.resolvedLlm;
          if (args.opts.resolveSubsidiaryLlmRoute) {
            try {
              resolvedLlm = args.opts.resolveSubsidiaryLlmRoute(
                AGENT_IDS.HOME_SUGGESTIONS,
              );
            } catch (error) {
              logger.debug("home-suggestions-refresh.route-fallback", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          spawnHomeSuggestionsRefresh({
            conversationId: args.opts.conversationId,
            resolvedLlm,
            store: args.opts.store,
            appendLocalChatEvent: args.opts.appendLocalChatEvent,
            listLocalChatEvents: args.opts.listLocalChatEvents,
          });
        }
      } catch (error) {
        logger.debug("home-suggestions-refresh.tick-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (args.result.trim()) {
    await compactRuntimeThreadHistory({
      store: args.opts.store,
      threadKey: args.threadKey,
      resolvedLlm: args.opts.resolvedLlm,
      agentType: args.opts.agentType,
    });
  }
  if (!args.opts.suppressCompletionSideEffects) {
    args.opts.callbacks?.onEnd?.(
      args.runEvents.recordRunEnd({ finalText: args.result }),
    );
  }

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
