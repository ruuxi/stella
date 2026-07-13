import { cleanupSessionResources } from "../../ai/session-resources.js";
import type { Agent } from "../agent-core/agent.js";
import { createRuntimeLogger } from "../debug.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import {
  buildSafetyAbortSwapRoute,
  isProviderContentAbortMessage,
  parseQuarantineRecord,
  ProviderAbortContainment,
  QUARANTINE_CUSTOM_TYPE,
  type QuarantineRecord,
  type SafetySwapRoute,
} from "./provider-abort-containment.js";
import { createRuntimeAgent, resolveAgentThinkingLevel } from "./shared.js";
import { buildHistorySource } from "./thread-memory.js";

type CreateRuntimeAgentArgs = Parameters<typeof createRuntimeAgent>[0];

type PiSessionCoreOptions = {
  threadKey: string;
  loggerName: string;
};

type SessionLogContext = Record<string, unknown>;

/**
 * Shared mutable Pi-Agent state for long-lived runtime sessions.
 *
 * Orchestrators and subagents differ in prompt assembly and finalization, but
 * the live `Agent` lifecycle is the same: keep one Agent per durable thread,
 * update route/system/tools between turns, and refresh the in-memory message
 * mirror only at turn boundaries after background compaction lands.
 */
export class PiSessionCore {
  private readonly logger;
  private agent: Agent | null = null;
  private currentResolvedLlm: ResolvedLlmRoute | null = null;
  private pendingHistoryRefresh = false;
  /**
   * Deterministic provider-abort tracking for this durable thread: instant
   * first-call failure counting and the request-assembly quarantine
   * registry. Survives across turns for the lifetime of the session.
   */
  protected readonly abortContainment = new ProviderAbortContainment();
  readonly threadKey: string;

  constructor(opts: PiSessionCoreOptions) {
    this.threadKey = opts.threadKey;
    this.logger = createRuntimeLogger(opts.loggerName);
  }

  get hasAgent(): boolean {
    return this.agent !== null;
  }

  /**
   * Flag that SQLite compaction wrote a new overlay. The next turn swaps the
   * live Agent's message array from freshly-loaded history before prompting.
   */
  notifyCompacted(): void {
    if (!this.agent) return;
    this.pendingHistoryRefresh = true;
  }

  /**
   * External conversation writers (for example realtime voice) append into
   * the same durable thread without going through this live Agent instance.
   * Refresh at the next turn boundary so switching surfaces keeps context.
   */
  notifyHistoryChanged(): void {
    this.pendingHistoryRefresh = true;
  }

  protected setResolvedLlm(resolvedLlm: ResolvedLlmRoute): void {
    this.currentResolvedLlm = resolvedLlm;
  }

  protected refreshHistoryIfNeeded(
    agentContext: LocalAgentContext,
    logContext: SessionLogContext,
  ): void {
    if (!this.pendingHistoryRefresh || !this.agent) return;
    const refreshed = buildHistorySource(agentContext);
    this.agent.state.messages = refreshed;
    this.pendingHistoryRefresh = false;
    this.logger.debug("history-refreshed", {
      threadKey: this.threadKey,
      historyLength: refreshed.length,
      ...logContext,
    });
  }

  /**
   * Close the session-creation race: a writer can flag history after the
   * caller loaded `agentContext`, but before the Pi Agent exists. Once the
   * Agent has been created, reload SQLite and replace its message mirror
   * before the provider turn begins.
   */
  protected refreshHistoryFromStoreIfNeeded(
    agentContext: LocalAgentContext,
    store: RuntimeStore,
    logContext: SessionLogContext,
  ): LocalAgentContext {
    if (!this.pendingHistoryRefresh || !this.agent) return agentContext;
    const refreshedContext: LocalAgentContext = {
      ...agentContext,
      threadHistory: store.loadThreadMessages(this.threadKey),
    };
    this.refreshHistoryIfNeeded(refreshedContext, logContext);
    return refreshedContext;
  }

  /**
   * Start a containment-tracked turn. Re-seeds the quarantine registry from
   * persisted thread records (so healed threads survive app restarts),
   * re-masks previously quarantined entries (history refreshes rebuild the
   * message array from the intact store) and, after two consecutive instant
   * provider aborts, quarantines the newest suspect tool-result entry from
   * the request assembly. Returns the pre-run message count so failures can
   * be classified later, plus any newly quarantined record so the caller
   * can persist it.
   */
  protected beginAbortContainmentTurn(
    agent: Agent,
    agentContext: LocalAgentContext,
    logContext: SessionLogContext,
  ): { messagesBefore: number; newlyQuarantined: QuarantineRecord | null } {
    const persisted = (agentContext.threadHistory ?? [])
      .map((entry) =>
        entry.customMessage?.customType === QUARANTINE_CUSTOM_TYPE
          ? parseQuarantineRecord(entry.customMessage.content)
          : null,
      )
      .filter((record): record is QuarantineRecord => record !== null);
    if (persisted.length > 0) {
      this.abortContainment.seedQuarantined(persisted);
    }

    const application = this.abortContainment.applyQuarantine(
      agent.state.messages,
    );
    if (application.newlyQuarantined || application.reappliedKeys.length > 0) {
      this.logger.warn("provider-abort-quarantine", {
        threadKey: this.threadKey,
        reapplied: application.reappliedKeys,
        newlyQuarantined: application.newlyQuarantined,
        consecutiveInstantAborts:
          this.abortContainment.consecutiveInstantAbortCount,
        ...logContext,
      });
    }
    return {
      messagesBefore: agent.state.messages.length,
      newlyQuarantined: application.newlyQuarantined,
    };
  }

  /**
   * Last resort after `prepareSafetySameModelRetry` exhausts the fable
   * attempt budget: auto-swap a fable-5 route to opus-4.8 and retry once
   * (fable's safety guardrails false-positive on benign quoted content).
   * When eligible, this pops the errored assistant tail, points the live
   * Agent at the swapped route, and returns the swap so the caller re-runs
   * via `resume`. Per-run only: the next turn's
   * `setResolvedLlm(opts.resolvedLlm)` restores the configured model. The
   * caller invokes this at most once per turn, which enforces the
   * one-swap-attempt cap (no ping-pong).
   */
  protected prepareSafetyModelSwap(
    agent: Agent,
    args: { errorMessage: string; logContext: SessionLogContext },
  ): SafetySwapRoute | null {
    if (!this.currentResolvedLlm) return null;
    if (!isProviderContentAbortMessage(args.errorMessage)) return null;
    const swap = buildSafetyAbortSwapRoute(this.currentResolvedLlm);
    if (!swap) return null;
    if (!this.popErroredTailForResume(agent)) return null;

    this.setResolvedLlm(swap.route);
    agent.state.model = swap.route.model;
    this.logger.warn("safety-model-swap", {
      threadKey: this.threadKey,
      fromModel: swap.fromModelId,
      toModel: swap.toModelId,
      providerError: args.errorMessage,
      ...args.logContext,
    });
    return swap;
  }

  /**
   * After a failed attempt, decide whether to retry the SAME fable-5 route
   * before any model swap (refusals are frequently transient). When
   * eligible, pops the errored tail so the caller re-runs via `resume` and
   * returns the failing model id for the status note; the caller owns the
   * attempt budget (`SAFETY_ABORT_FABLE_ATTEMPTS`). Requires the same
   * eligibility as the swap itself so a route that could never swap doesn't
   * burn retries on a hopeless error.
   */
  protected prepareSafetySameModelRetry(
    agent: Agent,
    args: { errorMessage: string; logContext: SessionLogContext },
  ): { modelId: string } | null {
    if (!this.currentResolvedLlm) return null;
    if (!isProviderContentAbortMessage(args.errorMessage)) return null;
    if (!buildSafetyAbortSwapRoute(this.currentResolvedLlm)) return null;
    if (!this.popErroredTailForResume(agent)) return null;

    const modelId = this.currentResolvedLlm.model.id;
    this.logger.warn("safety-same-model-retry", {
      threadKey: this.threadKey,
      model: modelId,
      providerError: args.errorMessage,
      ...args.logContext,
    });
    return { modelId };
  }

  /**
   * Pop the errored assistant tail so `continue()` resumes from the prompt
   * instead of refusing on a trailing assistant message. Inspects the tail
   * WITHOUT mutating it first: only commits to the pop once the retry is
   * definitely happening — bailing after a pop would corrupt the
   * appended-messages slice that failure classification reads, silently
   * resetting the deterministic-abort streak. Returns false when the tail
   * shape is unexpected (e.g. failure mid-tool-loop) and resuming would
   * throw.
   */
  private popErroredTailForResume(agent: Agent): boolean {
    const messages = agent.state.messages;
    const last = messages[messages.length - 1];
    const popErroredTail =
      last?.role === "assistant" &&
      (last.stopReason === "error" || last.stopReason === "aborted");
    const tailAfterPop = popErroredTail
      ? messages[messages.length - 2]
      : last;
    if (tailAfterPop?.role === "assistant") {
      return false;
    }
    if (popErroredTail) {
      // Drop the aborted stream's partial output.
      messages.pop();
    }
    return true;
  }

  protected noteAbortContainmentSuccess(): void {
    this.abortContainment.noteRunSuccess();
  }

  /**
   * Record a failed turn with the containment tracker. Returns the error
   * message to surface — the original, or the deterministic-abort
   * containment error once the threshold is reached.
   */
  protected noteAbortContainmentFailure(
    agent: Agent,
    args: {
      messagesBefore: number;
      errorMessage: string;
      swapAttempted?: { fromModelId: string; toModelId: string } | undefined;
      logContext: SessionLogContext;
    },
  ): string {
    const messages = agent.state.messages;
    const surfaced = this.abortContainment.noteRunFailure({
      history: messages.slice(0, args.messagesBefore),
      appended: messages.slice(args.messagesBefore),
      errorMessage: args.errorMessage,
      swapAttempted: args.swapAttempted,
    });
    if (surfaced !== args.errorMessage) {
      this.logger.warn("deterministic-provider-abort", {
        threadKey: this.threadKey,
        consecutiveInstantAborts:
          this.abortContainment.consecutiveInstantAbortCount,
        quarantinedEntries: this.abortContainment.quarantinedCount,
        providerError: args.errorMessage,
        ...args.logContext,
      });
    }
    return surfaced;
  }

  protected createOrReuseAgent(args: {
    agentType: string;
    systemPrompt: string;
    resolvedLlm: ResolvedLlmRoute;
    agentContext: LocalAgentContext;
    hookEmitter?: HookEmitter;
    tools: CreateRuntimeAgentArgs["tools"];
    afterToolCall?: CreateRuntimeAgentArgs["afterToolCall"];
    onProviderRetry?: CreateRuntimeAgentArgs["onProviderRetry"];
    logContext: SessionLogContext;
  }): Agent {
    if (!this.agent) {
      const historySource = buildHistorySource(args.agentContext);
      this.agent = createRuntimeAgent({
        agentType: args.agentType,
        systemPrompt: args.systemPrompt,
        resolvedLlm: args.resolvedLlm,
        resolvedLlmOverride: () => this.currentResolvedLlm ?? args.resolvedLlm,
        reasoningEffort: resolveAgentThinkingLevel({
          resolvedLlm: args.resolvedLlm,
          ...(args.agentContext.reasoningEffort
            ? { agentContextReasoningEffort: args.agentContext.reasoningEffort }
            : {}),
        }),
        ...(args.hookEmitter ? { hookEmitter: args.hookEmitter } : {}),
        tools: args.tools,
        historySource,
        cacheSessionId: this.threadKey,
        ...(args.afterToolCall ? { afterToolCall: args.afterToolCall } : {}),
        ...(args.onProviderRetry
          ? { onProviderRetry: args.onProviderRetry }
          : {}),
      });
      this.logger.debug("agent-created", {
        threadKey: this.threadKey,
        historyLength: historySource.length,
        model: args.resolvedLlm.model.id,
        ...args.logContext,
      });
      return this.agent;
    }

    this.agent.state.systemPrompt = args.systemPrompt;
    this.agent.state.tools = args.tools;
    this.agent.state.model = args.resolvedLlm.model;
    this.agent.state.thinkingLevel = resolveAgentThinkingLevel({
      resolvedLlm: args.resolvedLlm,
      ...(args.agentContext.reasoningEffort
        ? { agentContextReasoningEffort: args.agentContext.reasoningEffort }
        : {}),
    });
    this.logger.debug("agent-reused", {
      threadKey: this.threadKey,
      priorMessages: this.agent.state.messages.length,
      model: args.resolvedLlm.model.id,
      thinkingLevel: this.agent.state.thinkingLevel,
      ...args.logContext,
    });
    return this.agent;
  }

  dispose(): void {
    if (this.agent) {
      try {
        this.agent.abort();
      } catch {
        // Best-effort; the Agent may already be idle.
      }
    }
    this.agent = null;
    this.currentResolvedLlm = null;
    this.pendingHistoryRefresh = false;
    // Release per-session provider resources keyed by the same id used as the
    // AI cache session id (the thread key), e.g. Codex WebSocket connections
    // and their transport/fallback bookkeeping.
    try {
      cleanupSessionResources(this.threadKey);
    } catch {
      // Best-effort; a failing cleanup shouldn't break session teardown.
    }
  }
}
