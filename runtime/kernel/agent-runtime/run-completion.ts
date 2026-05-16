import type { Agent } from "../agent-core/agent.js";
import type { AgentMessage } from "../agent-core/types.js";
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
  args: {
    finalText: string;
    runId: string;
    threadKey: string;
    messagesSnapshot: AgentMessage[];
  },
): Promise<SelfModAppliedPayload | null> => {
  if (!opts.hookEmitter) {
    return null;
  }
  try {
    const result = await opts.hookEmitter.emit(
      "agent_end",
      {
        agentType: opts.agentType,
        finalText: args.finalText,
        outcome: "success",
        conversationId: opts.conversationId,
        threadKey: args.threadKey,
        runId: args.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        isUserTurn: opts.uiVisibility !== "hidden",
        // Stella-runtime post-finalize hooks (memory review, dream
        // notify, home suggestions, thread summaries) read accessors
        // off `services` instead of being baked into the kernel.
        services: {
          resolvedLlm: opts.resolvedLlm,
          messagesSnapshot: args.messagesSnapshot,
          ...(opts.appendLocalChatEvent
            ? { appendLocalChatEvent: opts.appendLocalChatEvent }
            : {}),
          ...(opts.listLocalChatEvents
            ? { listLocalChatEvents: opts.listLocalChatEvents }
            : {}),
          ...(opts.resolveSubsidiaryLlmRoute
            ? { resolveSubsidiaryLlmRoute: opts.resolveSubsidiaryLlmRoute }
            : {}),
          ...(opts.userTurnsSinceMemoryReview != null
            ? { userTurnsSinceMemoryReview: opts.userTurnsSinceMemoryReview }
            : {}),
        },
      },
      { agentType: opts.agentType },
    );
    return result?.selfModApplied ?? null;
  } catch {
    return null;
  }
};

/**
 * Cleanup-only `agent_end` emission for non-success outcomes.
 *
 * The result is discarded because non-success paths cannot surface
 * `selfModApplied`, but the event still lets hooks reclaim run-scoped state.
 */
const emitAgentEndCleanup = (
  opts: OrchestratorRunOptions,
  args: {
    runId: string;
    threadKey: string;
    outcome: "error" | "interrupted";
    finalText?: string;
  },
): void => {
  if (!opts.hookEmitter) return;
  void opts.hookEmitter
    .emit(
      "agent_end",
      {
        agentType: opts.agentType,
        finalText: args.finalText ?? "",
        outcome: args.outcome,
        conversationId: opts.conversationId,
        threadKey: args.threadKey,
        runId: args.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        isUserTurn: opts.uiVisibility !== "hidden",
      },
      { agentType: opts.agentType },
    )
    .catch(() => undefined);
};

/**
 * Subagent counterpart to {@link emitAgentEndCleanup} and
 * {@link emitAgentEndHook}. Subagent results are not threaded onto
 * user-facing events, but the lifecycle event still closes run-scoped hooks.
 */
const emitSubagentAgentEnd = (
  opts: SubagentRunOptions,
  args: {
    runId: string;
    threadKey: string;
    outcome: "success" | "error" | "interrupted";
    finalText: string;
    /**
     * `suppressCompletionSideEffects` flag that the subagent finalize
     * path uses for one-shot internal calls (commit-subject namer,
     * feature-snapshot namer, …). When true, we still fire `agent_end`
     * so balanced-lifecycle hooks (self-mod baseline cleanup, etc.)
     * run, but `services` is intentionally minimal so post-finalize
     * side-effect hooks (dream notify, home suggestions refresh,
     * thread summaries record) self-skip. Pre-migration these were
     * inline if-branches inside `finalizeSubagentSuccess` gated on
     * `sideEffectsAllowed`; now the gate lives on the hook side.
     */
    sideEffectsAllowed: boolean;
  },
): void => {
  if (!opts.hookEmitter) return;
  void opts.hookEmitter
    .emit(
      "agent_end",
      {
        agentType: opts.agentType,
        finalText: args.finalText,
        outcome: args.outcome,
        conversationId: opts.conversationId,
        threadKey: args.threadKey,
        runId: args.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        isUserTurn: opts.uiVisibility !== "hidden",
        // Only populate services when side-effects are allowed; the
        // post-finalize hooks read accessors off `services` and
        // self-skip when omitted.
        ...(args.sideEffectsAllowed
          ? {
              services: {
                resolvedLlm: opts.resolvedLlm,
                ...(opts.appendLocalChatEvent
                  ? { appendLocalChatEvent: opts.appendLocalChatEvent }
                  : {}),
                ...(opts.listLocalChatEvents
                  ? { listLocalChatEvents: opts.listLocalChatEvents }
                  : {}),
                ...(opts.resolveSubsidiaryLlmRoute
                  ? {
                      resolveSubsidiaryLlmRoute: opts.resolveSubsidiaryLlmRoute,
                    }
                  : {}),
              },
            }
          : {}),
      },
      { agentType: opts.agentType },
    )
    .catch(() => undefined);
};

type CompactableAgentState = {
  state: Pick<Agent["state"], "messages">;
};

/**
 * Run thread compaction through the shared hook lifecycle.
 *
 * `messageCount` is informational for the hook payload — the orchestrator
 * passes its live `agent.state.messages.length`, the subagent passes
 * the snapshot length (or 0 when the live agent isn't accessible from
 * the call site). Hooks that need a precise pre-compaction count should
 * read from the SQLite store directly via the threadKey.
 */
const runCompactionWithHooks = async (args: {
  opts: Pick<
    OrchestratorRunOptions,
    | "agentType"
    | "conversationId"
    | "uiVisibility"
    | "resolvedLlm"
    | "store"
    | "hookEmitter"
  >;
  threadKey: string;
  runId: string;
  messageCount: number;
}): Promise<{ compacted: boolean }> => {
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
          messageCount: args.messageCount,
          conversationId: args.opts.conversationId,
          threadKey: args.threadKey,
          runId: args.runId,
          ...(args.opts.uiVisibility
            ? { uiVisibility: args.opts.uiVisibility }
            : {}),
          isUserTurn: args.opts.uiVisibility !== "hidden",
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
    return { compacted: false };
  }

  const result = await compactRuntimeThreadHistory({
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

  // Only notify observers when an overlay was actually written.
  if (
    result.compacted &&
    args.opts.hookEmitter &&
    hookCompaction?.summary
  ) {
    void args.opts.hookEmitter
      .emit(
        "session_compact",
        {
          agentType: args.opts.agentType,
          summary: hookCompaction.summary,
          ...(hookCompaction.preserveLastN !== undefined
            ? { preserveLastN: hookCompaction.preserveLastN }
            : {}),
          fromHook: true,
          conversationId: args.opts.conversationId,
          threadKey: args.threadKey,
          runId: args.runId,
        },
        { agentType: args.opts.agentType },
      )
      .catch(() => undefined);
  }
  return result;
};

export const finalizeOrchestratorSuccess = async (args: {
  opts: OrchestratorRunOptions;
  runId: string;
  threadKey: string;
  runEvents: RuntimeRunEventRecorder;
  agent: CompactableAgentState;
  finalText: string;
  responseTarget?: OrchestratorRunOptions["responseTarget"];
}): Promise<void> => {
  logger.debug("orchestrator.end", {
    runId: args.runId,
    agentType: args.opts.agentType,
    finalTextPreview: args.finalText.slice(0, 300),
  });

  await Promise.resolve(
    args.opts.beforeRunEnd?.({
      runId: args.runId,
      threadKey: args.threadKey,
      finalText: args.finalText,
      outcome: "success",
    }),
  );

  const selfModApplied = await emitAgentEndHook(args.opts, {
    finalText: args.finalText,
    runId: args.runId,
    threadKey: args.threadKey,
    // Snapshot the messages array now so memory-review / other
    // post-finalize hooks see the state at end-of-turn rather than a
    // mutated state if a follow-up turn lands before the hook handler
    // runs.
    messagesSnapshot: [...args.agent.state.messages],
  });

  // Finish the visible turn before scheduling compaction.
  args.opts.callbacks.onEnd(
    args.runEvents.recordRunEnd({
      finalText: args.finalText,
      ...(selfModApplied ? { selfModApplied } : {}),
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    }),
  );

  if (args.finalText.trim()) {
    void args.opts.compactionScheduler.schedule({
      threadKey: args.threadKey,
      run: async () => {
        const { compacted } = await runCompactionWithHooks({
          opts: args.opts,
          threadKey: args.threadKey,
          runId: args.runId,
          messageCount: args.agent.state.messages.length,
        });
        if (compacted) {
          args.opts.orchestratorSession?.notifyCompacted();
        }
      },
    });
  }

  updateOrchestratorReminderState(args.opts.store, {
    conversationId: args.opts.conversationId,
    shouldInjectDynamicReminder:
      args.opts.agentContext.shouldInjectDynamicReminder,
    finalText: args.finalText,
  });

  // Memory review now lives as an `agent_end` hook in
  // `runtime/extensions/stella-runtime/hooks/memory-review.hook.ts`.
  // The hook reads `userTurnsSinceMemoryReview` off
  // `payload.services` (populated by `emitAgentEndHook` above) and
  // self-skips when the threshold isn't met.
};

export const finalizeOrchestratorError = (args: {
  opts: OrchestratorRunOptions;
  runEvents: RuntimeRunEventRecorder;
  error: unknown;
  runId?: string;
  threadKey?: string;
}): string => {
  const errorMessage = safeErrorMessage(args.error, "Stella runtime failed");
  args.opts.callbacks.onError(args.runEvents.recordError(errorMessage));
  if (args.runId && args.threadKey) {
    emitAgentEndCleanup(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "error",
      finalText: errorMessage,
    });
  }
  return errorMessage;
};

export const finalizeOrchestratorInterrupted = (args: {
  opts: OrchestratorRunOptions;
  runEvents: RuntimeRunEventRecorder;
  reason: string;
  runId?: string;
  threadKey?: string;
}): string => {
  args.opts.callbacks.onInterrupted?.(
    args.runEvents.recordInterrupted(args.reason),
  );
  if (args.runId && args.threadKey) {
    emitAgentEndCleanup(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "interrupted",
      finalText: args.reason,
    });
  }
  return args.reason;
};

/**
 * Sentinel surfaced to the orchestrator when a sub-agent run finishes
 * cleanly but the model produced no user-visible text. Without this
 * the orchestrator's hidden `[Agent completed]` reminder arrives with
 * no `result:` line and the model treats it as a hung run, wasting
 * turns asking the sub-agent what happened. Covers the Kimi K2 family
 * "thinking-only stop" pathology even after the agent-loop retry.
 */
export const SUBAGENT_EMPTY_RESULT_SENTINEL =
  "(Agent completed without a user-visible reply. Re-prompt with send_input if you need the outcome.)";

export const finalizeSubagentSuccess = async (args: {
  opts: SubagentRunOptions;
  runEvents: RuntimeRunEventRecorder;
  runId: string;
  threadKey: string;
  result: string;
  agentMessageCount?: number;
}): Promise<SubagentRunResult> => {
  // Thread-summaries record, dream-scheduler notify, and
  // home-suggestions refresh used to be inline branches here. They now
  // live as `agent_end` hooks in `runtime/extensions/stella-runtime/`.
  // The kernel just fires the lifecycle event with the per-run services
  // populated; each hook self-skips when its capability gate doesn't
  // match.
  const trimmedResult = args.result.trim();
  const resolvedResult = trimmedResult || SUBAGENT_EMPTY_RESULT_SENTINEL;
  const sideEffectsAllowed = !args.opts.suppressCompletionSideEffects;
  emitSubagentAgentEnd(args.opts, {
    runId: args.runId,
    threadKey: args.threadKey,
    outcome: "success",
    finalText: resolvedResult,
    sideEffectsAllowed,
  });

  // Finish the parent-visible run before scheduling subagent compaction.
  if (!args.opts.suppressCompletionSideEffects) {
    args.opts.callbacks?.onEnd?.(
      args.runEvents.recordRunEnd({ finalText: resolvedResult }),
    );
  }

  // Only schedule compaction when the model actually produced output;
  // sentinel-only finals carry no new history worth compacting.
  if (trimmedResult) {
    const messageCount = args.agentMessageCount ?? 0;
    void args.opts.compactionScheduler.schedule({
      threadKey: args.threadKey,
      run: async () => {
        const { compacted } = await runCompactionWithHooks({
          opts: args.opts,
          threadKey: args.threadKey,
          runId: args.runId,
          messageCount,
        });
        if (compacted) {
          args.opts.subagentSession?.notifyCompacted();
        }
      },
    });
  }

  return {
    runId: args.runId,
    result: resolvedResult,
  };
};

export const finalizeSubagentError = (args: {
  opts: SubagentRunOptions;
  runEvents: RuntimeRunEventRecorder;
  runId: string;
  error: unknown;
  /**
   * Optional threadKey used to fire the matching `agent_end` cleanup
   * hook. Optional for the same reason as the orchestrator counterpart:
   * direct callers (tests) without a threadKey wired through skip the
   * hook fire — the only side effect is that hooks tracking subagent
   * run-scoped state may leak entries for those test runs.
   */
  threadKey?: string;
}): SubagentRunResult => {
  const errorMessage = safeErrorMessage(args.error, "Subagent failed");
  args.opts.callbacks?.onError?.(args.runEvents.recordError(errorMessage));
  if (args.threadKey) {
    emitSubagentAgentEnd(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "error",
      finalText: errorMessage,
      // Error path never fires post-finalize side-effects.
      sideEffectsAllowed: false,
    });
  }
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
  threadKey?: string;
}): SubagentRunResult => {
  args.opts.callbacks?.onInterrupted?.(
    args.runEvents.recordInterrupted(args.reason),
  );
  if (args.threadKey) {
    emitSubagentAgentEnd(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "interrupted",
      finalText: args.reason,
      // Interrupted path never fires post-finalize side-effects.
      sideEffectsAllowed: false,
    });
  }
  return {
    runId: args.runId,
    result: "",
  };
};
