import crypto from "crypto";
import {
  finalizeSubagentError,
  finalizeSubagentInterrupted,
  finalizeSubagentSuccess,
  resolveInterruptionReason,
} from "./run-completion.js";
import { executeRuntimeAgentPrompt } from "./run-execution.js";
import { buildSubagentSystemPrompt } from "./run-preparation.js";
import { createRunEventRecorder } from "./run-events.js";
import { PiSessionCore } from "./pi-session-core.js";
import {
  buildRunThreadKey,
  buildSubagentPromptMessages,
} from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";
import type { SubagentRunOptions, SubagentRunResult } from "./types.js";

export class SubagentSession extends PiSessionCore {
  constructor(
    public readonly threadId: string,
    public readonly conversationId: string,
    public readonly agentType: string,
  ) {
    super({
      loggerName: "subagent-session",
      threadKey: buildRunThreadKey({
        conversationId,
        agentType,
        runId: threadId,
        threadId,
      }),
    });
  }

  async runTurn(opts: SubagentRunOptions): Promise<SubagentRunResult> {
    const prompt = opts.userPrompt.trim();

    // Generate the runId BEFORE building the system prompt so the
    // `before_agent_start` hook payload carries it. Same pattern as
    // `OrchestratorSession.runTurn`. Without the runId in the payload,
    // any hook that keys on it (e.g. a baseline cache) silently fails
    // to set up its run-scoped state.
    const runId =
      opts.runId ?? `local:sub:${crypto.randomUUID()}`;
    const effectiveSystemPrompt = await buildSubagentSystemPrompt({
      ...opts,
      runId,
    });

    // Keep the reused Agent pointed at the current model route.
    this.setResolvedLlm(opts.resolvedLlm);

    this.refreshHistoryIfNeeded(opts.agentContext, {
      threadId: this.threadId,
    });

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
    });

    const agent = this.createOrReuseAgent({
      agentType: opts.agentType,
      systemPrompt: effectiveSystemPrompt,
      resolvedLlm: opts.resolvedLlm,
      agentContext: opts.agentContext,
      ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
      tools,
      logContext: {
        threadId: this.threadId,
        runId,
      },
    });

    runEvents.recordRunStart();

    if (opts.abortSignal?.aborted) {
      const reason =
        resolveInterruptionReason({ abortSignal: opts.abortSignal }) ??
        "Canceled";
      return finalizeSubagentInterrupted({
        opts,
        runEvents,
        runId,
        reason,
        threadKey: this.threadKey,
      });
    }

    try {
      const promptMessages = await buildSubagentPromptMessages({
        context: opts.agentContext,
        userPrompt: prompt,
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
      const { finalText: result, errorMessage } = await executeRuntimeAgentPrompt({
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
        ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
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
        return finalizeSubagentInterrupted({
          opts,
          runEvents,
          runId,
          reason: interruptedReason,
          threadKey: this.threadKey,
        });
      }
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      return await finalizeSubagentSuccess({
        opts,
        runEvents,
        runId,
        threadKey: this.threadKey,
        result,
        agentMessageCount: agent.state.messages.length,
      });
    } catch (error) {
      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error,
      });
      if (interruptedReason) {
        return finalizeSubagentInterrupted({
          opts,
          runEvents,
          runId,
          reason: interruptedReason,
          threadKey: this.threadKey,
        });
      }
      return finalizeSubagentError({
        opts,
        runEvents,
        runId,
        error,
        threadKey: this.threadKey,
      });
    }
  }

  dispose(): void {
    super.dispose();
  }
}

/**
 * Look up an existing session for the durable subagent threadId, or build
 * a new one and store it on the provided map.
 */
export const getOrCreateSubagentSession = (
  sessions: Map<string, SubagentSession>,
  threadId: string,
  conversationId: string,
  agentType: string,
): SubagentSession => {
  let session = sessions.get(threadId);
  if (!session) {
    session = new SubagentSession(threadId, conversationId, agentType);
    sessions.set(threadId, session);
  }
  return session;
};
