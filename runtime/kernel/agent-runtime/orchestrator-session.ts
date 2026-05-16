/**
 * Long-lived per-conversation orchestrator session.
 *
 * Owns one live Pi `Agent` for the lifetime of the conversation. Subsequent
 * turns reuse the same Agent (and its `state.messages` array) instead of
 * rebuilding from SQLite each turn. This lets provider prompt caches hit
 * cleanly between turns: the prefix the LLM sees on turn N+1 is byte-
 * identical to turn N up through the new user message at the tail.
 *
 * Lifetime: created lazily on the first user message for a `conversationId`
 * via `getOrCreateOrchestratorSession`. Disposed when the runtime worker
 * stops (`runtime-initialization.ts:stop`). One session per conversation;
 * concurrent runs against the same conversation are serialized by the
 * orchestrator coordinator's queue, same as before.
 *
 * Scope: the Pi engine path only. External engines (Claude Code) keep their
 * existing per-turn flow because the engine binary owns its own session
 * concept. Subagents are out of scope (E2 follow-up).
 *
 * Limitations (intentional for v1):
 *   - Model switching mid-conversation is supported (matches Pi's pattern,
 *     `agent-session.ts:setModel`). Each turn, the session updates the
 *     `currentResolvedLlm` slot and `agent.state.model`; the Agent's
 *     `getApiKey` / `refreshApiKey` / `transformContext` closures read
 *     from the slot via `resolvedLlmOverride`, so the next provider call
 *     uses the new credentials, base URL, and context-window budget.
 *   - Memory bundle injection cadence is preserved (runs through
 *     `buildOrchestratorPromptMessages` on cadence turns). Now that the
 *     bootstrap-replay-key dedup is removed in `buildHistorySource`, the
 *     accumulating bootstrap entries don't break prompt cache; they're
 *     bounded by `maybeCompactRuntimeThread`.
 */

import crypto from "crypto";
import {
  finalizeOrchestratorError,
  finalizeOrchestratorInterrupted,
  finalizeOrchestratorSuccess,
  markOrchestratorErrorReported,
  resolveInterruptionReason,
} from "./run-completion.js";
import { executeRuntimeAgentPrompt } from "./run-execution.js";
import { buildRuntimeSystemPrompt } from "./run-preparation.js";
import {
  createRunEventRecorder,
  type RuntimeRunEventRecorder,
} from "./run-events.js";
import {
  createOrchestratorResponseTargetTracker,
  type OrchestratorResponseTargetTracker,
} from "./response-target.js";
import { PiSessionCore } from "./pi-session-core.js";
import {
  buildOrchestratorPromptMessages,
  buildRunThreadKey,
} from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";
import type { OrchestratorRunOptions, RuntimeRunCallbacks } from "./types.js";

/**
 * Stable runId fragment fed to {@link buildRunThreadKey} so the
 * orchestrator's threadKey is stable across turns. The shared
 * `buildRunThreadKey` helper is also used by subagents (where the
 * runId genuinely varies per attempt), so a literal placeholder is
 * needed to disambiguate; promoting it to a named constant prevents
 * future copy-paste from carrying the magic string into a per-
 * conversation key migration.
 */
const ORCHESTRATOR_SESSION_RUN_ID = "session";

export class OrchestratorSession extends PiSessionCore {
  /**
   * Mutable tracker slot. Set at the start of every `runTurn`, cleared at
   * the end. The Agent's `afterToolCall` closure (built once at Agent
   * construction) reads from this slot so per-turn trackers reach the
   * long-lived loop without re-binding the closure each turn.
   */
  private currentResponseTargetTracker: OrchestratorResponseTargetTracker | null =
    null;
  /**
   * Per-turn slot read by {@link handleProviderRetry} (installed once at
   * Agent construction). Set at the top of `runTurn`, cleared in `finally`.
   * Lets the long-lived Agent's retry closure reach the current turn's
   * recorder + UI callbacks without re-binding on every turn.
   */
  private currentRetryStatusContext: {
    recorder: RuntimeRunEventRecorder;
    callbacks?: RuntimeRunCallbacks;
  } | null = null;

  constructor(public readonly conversationId: string) {
    super({
      loggerName: "orchestrator-session",
      threadKey: buildRunThreadKey({
        conversationId,
        agentType: "orchestrator",
        runId: ORCHESTRATOR_SESSION_RUN_ID,
      }),
    });
  }

  /**
   * Surface a transient "trying again in X" status as a STATUS event the
   * desktop renders as a brief retry toast. Skips the first retry (≤1s
   * blip) so single-attempt hiccups don't flash the UI.
   */
  private handleProviderRetry = (info: {
    attempt: number;
    delayMs: number;
    reason?: string;
  }): void => {
    if (info.attempt < 2) return;
    const ctx = this.currentRetryStatusContext;
    if (!ctx) return;
    const seconds = Math.max(1, Math.round(info.delayMs / 1000));
    const statusText = `Stella is having trouble reaching the server — trying again in ${seconds}s`;
    try {
      const event = ctx.recorder.recordStatus(statusText, "provider-retry");
      ctx.callbacks?.onStatus?.(event);
    } catch {
      // Best-effort UI signal; never let a status emit abort the retry.
    }
  };

  async runTurn(opts: OrchestratorRunOptions): Promise<string> {
    const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
    const turnOpts =
      opts.runId === runId ? opts : { ...opts, runId };
    const effectiveSystemPrompt = await buildRuntimeSystemPrompt(turnOpts);

    // Keep the reused Agent pointed at this turn's model route.
    this.setResolvedLlm(opts.resolvedLlm);

    // Apply compaction overlays before provider calls, never mid-stream.
    this.refreshHistoryIfNeeded(opts.agentContext, {
      conversationId: this.conversationId,
    });
    const responseTargetTracker = createOrchestratorResponseTargetTracker(
      opts.responseTarget,
    );
    this.currentResponseTargetTracker = responseTargetTracker;

    const tools = createPiTools({
      runId,
      rootRunId: opts.rootRunId ?? runId,
      agentId: opts.agentId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      deviceId: opts.deviceId,
      stellaRoot: opts.stellaRoot,
      toolWorkspaceRoot: opts.toolWorkspaceRoot,
      agentDepth: opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: opts.agentContext.maxAgentDepth,
      toolsAllowlist: opts.agentContext.toolsAllowlist,
      toolCatalog: opts.toolCatalog,
      store: opts.store,
      toolExecutor: opts.toolExecutor,
      hookEmitter: opts.hookEmitter,
    });

    const runEvents = createRunEventRecorder({
      store: opts.store,
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      userMessageId: opts.userMessageId,
      uiVisibility: opts.uiVisibility,
      getResponseTarget: () =>
        responseTargetTracker.resolve() ?? opts.responseTarget,
    });

    const agent = this.createOrReuseAgent({
      agentType: opts.agentType,
      systemPrompt: effectiveSystemPrompt,
      resolvedLlm: opts.resolvedLlm,
      agentContext: opts.agentContext,
      ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
      tools,
      afterToolCall: async (context) => {
        this.currentResponseTargetTracker?.noteToolEnd(
          context.toolCall.name,
          context.result.details,
        );
        return undefined;
      },
      onProviderRetry: this.handleProviderRetry,
      logContext: {
        conversationId: this.conversationId,
        runId,
      },
    });

    this.currentRetryStatusContext = {
      recorder: runEvents,
      ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
    };

    opts.onExecutionSessionCreated?.({
      runId,
      threadKey: this.threadKey,
      queueUserMessageId: runEvents.queueUserMessageId,
      agent,
    });

    runEvents.recordRunStart();

    if (opts.abortSignal?.aborted) {
      const reason =
        resolveInterruptionReason({ abortSignal: opts.abortSignal }) ??
        "Canceled";
      finalizeOrchestratorInterrupted({
        opts,
        runEvents,
        reason,
        runId,
        threadKey: this.threadKey,
      });
      this.currentResponseTargetTracker = null;
      this.currentRetryStatusContext = null;
      return runId;
    }

    try {
      const promptMessages = await buildOrchestratorPromptMessages({
        context: opts.agentContext,
        userPrompt: opts.userPrompt,
        promptMessages: opts.promptMessages,
        stellaHome: opts.stellaHome,
        stellaRoot: opts.stellaRoot,
        agentType: opts.agentType,
        hookContext: {
          ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
          conversationId: opts.conversationId,
          threadKey: this.threadKey,
          runId,
          ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        },
      });

      const { finalText, errorMessage } = await executeRuntimeAgentPrompt({
        agent,
        promptMessages: promptMessages.map((message, index) => ({
          ...message,
          ...(index === promptMessages.length - 1 && opts.attachments?.length
            ? { attachments: opts.attachments }
            : {}),
        })),
        runId,
        agentType: opts.agentType,
        userMessageId: opts.userMessageId,
        recorder: runEvents,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        callbacks: opts.callbacks,
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        threadStore: opts.store,
        threadKey: this.threadKey,
        conversationId: opts.conversationId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      });

      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error: errorMessage,
      });
      if (interruptedReason) {
        finalizeOrchestratorInterrupted({
          opts,
          runEvents,
          reason: interruptedReason,
          runId,
          threadKey: this.threadKey,
        });
        return runId;
      }
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      await finalizeOrchestratorSuccess({
        opts,
        runId,
        threadKey: this.threadKey,
        runEvents,
        agent,
        finalText,
        responseTarget: responseTargetTracker.resolve(),
      });
      return runId;
    } catch (error) {
      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error,
      });
      if (interruptedReason) {
        finalizeOrchestratorInterrupted({
          opts,
          runEvents,
          reason: interruptedReason,
          runId,
          threadKey: this.threadKey,
        });
        return runId;
      }
      finalizeOrchestratorError({
        opts,
        runEvents,
        error,
        runId,
        threadKey: this.threadKey,
      });
      throw markOrchestratorErrorReported(error);
    } finally {
      this.currentResponseTargetTracker = null;
      this.currentRetryStatusContext = null;
    }
  }

  dispose(): void {
    super.dispose();
    this.currentResponseTargetTracker = null;
    this.currentRetryStatusContext = null;
  }
}

/**
 * Look up an existing session for this conversation, or build a new one
 * and store it on the provided map.
 *
 * Conversation-reset assumption: this helper assumes that
 * `conversationId` is unique per logical conversation for the lifetime
 * of the worker process. If the caller ever reuses the same
 * `conversationId` for a freshly-reset thread (e.g. a "new chat" UX
 * that recycles ids), the long-lived `Agent`'s `state.messages` would
 * still hold the OLD conversation's history, and the next `runTurn`
 * would only refresh from store when `pendingHistoryRefresh` is set
 * (which it isn't after a reset). Today every reset path the renderer
 * surfaces allocates a new id, so the issue is latent — but if you're
 * adding an id-reusing reset flow, call `dispose()` on the old session
 * (and `sessions.delete(conversationId)`) before the next turn lands.
 */
export const getOrCreateOrchestratorSession = (
  sessions: Map<string, OrchestratorSession>,
  conversationId: string,
): OrchestratorSession => {
  let session = sessions.get(conversationId);
  if (!session) {
    session = new OrchestratorSession(conversationId);
    sessions.set(conversationId, session);
  }
  return session;
};
