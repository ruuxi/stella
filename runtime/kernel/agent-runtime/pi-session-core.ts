import type { Agent } from "../agent-core/agent.js";
import { createRuntimeLogger } from "../debug.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
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
  }
}
