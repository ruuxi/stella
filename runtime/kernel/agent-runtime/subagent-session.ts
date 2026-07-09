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
  QUARANTINE_CUSTOM_TYPE,
  SAFETY_ABORT_FABLE_ATTEMPTS,
  safetyRetryStatusMessage,
  safetySwapStatusMessage,
  serializeQuarantineRecord,
} from "./provider-abort-containment.js";
import {
  buildRunThreadKey,
  buildSubagentPromptMessages,
  persistThreadCustomMessage,
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
      stellaAppDir: opts.stellaAppDir,
      stellaDataDir: opts.stellaDataDir,
      toolWorkspaceRoot: opts.toolWorkspaceRoot,
      agentDepth: opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: opts.agentContext.maxAgentDepth,
      // Inherited from the spawning orchestrator's run so subagent-side
      // tools that opt in (none today — `image_gen` is orchestrator-only)
      // can route their outputs back to the same connector. Subagents
      // don't *need* this for the current toolset; carry it so future
      // connector-aware tools work without another round of plumbing.
      connectorDeliveryTarget: opts.connectorDeliveryTarget,
      toolsAllowlist: opts.agentContext.toolsAllowlist,
      toolCatalog: opts.toolCatalog,
      store: opts.store,
      toolExecutor: opts.toolExecutor,
      hookEmitter: opts.hookEmitter,
      imageCapTarget: {
        provider: opts.resolvedLlm.model.provider,
        api: opts.resolvedLlm.model.api,
        modelId: opts.resolvedLlm.model.id,
      },
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

    const containmentTurn = this.beginAbortContainmentTurn(
      agent,
      opts.agentContext,
      {
        threadId: this.threadId,
        runId,
      },
    );
    if (containmentTurn.newlyQuarantined) {
      // Durable record so the quarantine survives session/app restarts.
      persistThreadCustomMessage(opts.store, {
        threadKey: this.threadKey,
        customType: QUARANTINE_CUSTOM_TYPE,
        content: [
          {
            type: "text",
            text: serializeQuarantineRecord(containmentTurn.newlyQuarantined),
          },
        ],
      });
    }
    let swapAttempted:
      | { fromModelId: string; toModelId: string }
      | undefined;

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
        stellaDataDir: opts.stellaDataDir,
        stellaAppDir: opts.stellaAppDir,
        agentType: opts.agentType,
        hookContext: {
          ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
          conversationId: opts.conversationId,
          threadKey: this.threadKey,
          runId,
          ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        },
      });
      const executionArgs = {
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
      };
      let execution = await executeRuntimeAgentPrompt(executionArgs);

      // Safety containment: a fable-5 refusal/safety abort first gets
      // retried on the configured model — refusals are often transient — up
      // to SAFETY_ABORT_FABLE_ATTEMPTS consecutive attempts total. Only when
      // every attempt fails does the turn swap to opus-4.8 below.
      let fableAttempts = 1;
      while (
        execution.errorMessage &&
        !opts.abortSignal?.aborted &&
        fableAttempts < SAFETY_ABORT_FABLE_ATTEMPTS
      ) {
        const retry = this.prepareSafetySameModelRetry(agent, {
          errorMessage: execution.errorMessage,
          logContext: {
            threadId: this.threadId,
            runId,
            attempt: fableAttempts + 1,
          },
        });
        if (!retry) break;
        fableAttempts += 1;
        opts.callbacks?.onStatus?.(
          runEvents.recordStatus(
            safetyRetryStatusMessage({
              modelId: retry.modelId,
              attempt: fableAttempts,
            }),
            "running",
          ),
        );
        execution = await executeRuntimeAgentPrompt({
          ...executionArgs,
          resume: true,
        });
      }
      // Safety model swap: after the fable attempts are exhausted, one retry
      // on opus-4.8 (same auth path, per-run only). `prepareSafetyModelSwap`
      // returns null for anything else, and this block runs at most once per
      // turn, so there is no swap ping-pong.
      if (execution.errorMessage && !opts.abortSignal?.aborted) {
        const swap = this.prepareSafetyModelSwap(agent, {
          errorMessage: execution.errorMessage,
          logContext: { threadId: this.threadId, runId },
        });
        if (swap) {
          swapAttempted = {
            fromModelId: swap.fromModelId,
            toModelId: swap.toModelId,
          };
          const statusText = safetySwapStatusMessage(swapAttempted);
          opts.callbacks?.onStatus?.(
            runEvents.recordStatus(statusText, "model-fallback"),
          );
          persistThreadCustomMessage(opts.store, {
            threadKey: this.threadKey,
            customType: "containment.safety-model-swap",
            content: [{ type: "text", text: statusText }],
          });
          execution = await executeRuntimeAgentPrompt({
            ...executionArgs,
            resume: true,
          });
        }
      }
      const { finalText: result, errorMessage } = execution;

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

      this.noteAbortContainmentSuccess();
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
      const surfacedMessage = this.noteAbortContainmentFailure(agent, {
        messagesBefore: containmentTurn.messagesBefore,
        errorMessage:
          error instanceof Error
            ? error.message || "Subagent failed"
            : String(error),
        swapAttempted,
        logContext: { threadId: this.threadId, runId },
      });
      const surfacedError =
        error instanceof Error && surfacedMessage === error.message
          ? error
          : new Error(surfacedMessage);
      return finalizeSubagentError({
        opts,
        runEvents,
        runId,
        error: surfacedError,
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
