import crypto from "crypto";
import {
  shouldIncludeStellaDocumentation,
} from "../../../../src/shared/contracts/agent-runtime.js";
import { createRuntimeLogger } from "../debug.js";
import { createDisplayStreamController } from "./display-stream.js";
import {
  createRunEventRecorder,
  subscribeRuntimeAgentEvents,
} from "./run-events.js";
import {
  createRuntimeAgent,
  getAgentCompletion,
  now,
} from "./shared.js";
import {
  appendThreadMessage,
  buildHistorySource,
  buildOrchestratorUserPrompt,
  buildRunThreadKey,
  buildSelfModDocumentationPrompt,
  buildSystemPrompt,
  compactRuntimeThreadHistory,
  persistAssistantReply,
  updateOrchestratorReminderState,
} from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";
import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";

const logger = createRuntimeLogger("agent-runtime");

export const runPiOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string> => {
  const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
  const threadKey = buildRunThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  const runEvents = createRunEventRecorder({
    store: opts.store,
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
  });
  const baselineHead =
    opts.frontendRoot && opts.selfModMonitor
      ? await opts.selfModMonitor
          .getBaselineHead(opts.frontendRoot)
          .catch(() => null)
      : null;

  logger.debug("orchestrator.start", {
    runId,
    agentType: opts.agentType,
    model: opts.resolvedLlm.model.id,
    conversationId: opts.conversationId,
    promptPreview: opts.userPrompt.slice(0, 300),
  });

  let effectiveSystemPrompt = buildSystemPrompt(opts.agentContext);
  if (opts.hookEmitter) {
    const hookResult = await opts.hookEmitter.emit(
      "before_agent_start",
      { agentType: opts.agentType, systemPrompt: effectiveSystemPrompt },
      { agentType: opts.agentType },
    );
    if (hookResult) {
      if (hookResult.systemPromptReplace) {
        effectiveSystemPrompt = hookResult.systemPromptReplace;
      } else if (hookResult.systemPromptAppend) {
        effectiveSystemPrompt += `\n${hookResult.systemPromptAppend}`;
      }
    }
  }

  runEvents.recordRunStart();

  const historySource = buildHistorySource(opts.agentContext);
  const tools = createPiTools({
    runId,
    rootRunId: opts.rootRunId ?? runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    taskDepth: opts.agentContext.taskDepth ?? 0,
    maxTaskDepth: opts.agentContext.maxTaskDepth,
    delegationAllowlist: opts.agentContext.delegationAllowlist,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    defaultSkills: opts.agentContext.defaultSkills,
    skillIds: opts.agentContext.skillIds,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
    hookEmitter: opts.hookEmitter,
  });

  logger.debug("orchestrator.tools", {
    agentType: opts.agentType,
    tools: tools.map((tool) => ({
      name: tool.name,
      hasDesc: !!tool.description,
      paramKeys: Object.keys(
        ((tool.parameters as Record<string, unknown>)?.properties ??
          {}) as Record<string, unknown>,
      ),
    })),
  });

  const agent = createRuntimeAgent({
    agentType: opts.agentType,
    systemPrompt: effectiveSystemPrompt,
    resolvedLlm: opts.resolvedLlm,
    hookEmitter: opts.hookEmitter,
    tools,
    historySource,
  });

  if (opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const displayStream = createDisplayStreamController(opts.displayHtml);

  const unsubscribe = subscribeRuntimeAgentEvents({
    agent,
    runId,
    agentType: opts.agentType,
    recorder: runEvents,
    callbacks: opts.callbacks,
    displayEventHandler: displayStream.handleEvent,
    hookEmitter: opts.hookEmitter,
  });

  try {
    const promptText = buildOrchestratorUserPrompt(
      opts.agentContext,
      opts.userPrompt,
    );
    appendThreadMessage(opts.store, {
      threadKey,
      role: "user",
      content: opts.userPrompt,
    });

    await agent.prompt({
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: now(),
    });

    displayStream.flush();

    const { finalText, errorMessage } = getAgentCompletion(agent);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    logger.debug("orchestrator.end", {
      runId,
      agentType: opts.agentType,
      finalTextPreview: finalText.slice(0, 300),
    });

    if (opts.hookEmitter) {
      await opts.hookEmitter
        .emit(
          "agent_end",
          { agentType: opts.agentType, finalText },
          { agentType: opts.agentType },
        )
        .catch(() => undefined);
    }

    const selfModApplied =
      opts.frontendRoot && opts.selfModMonitor
        ? await opts.selfModMonitor
            .detectAppliedSince({
              repoRoot: opts.frontendRoot,
              sinceHead: baselineHead,
            })
            .catch(() => null)
        : null;

    if (finalText.trim()) {
      appendThreadMessage(opts.store, {
        threadKey,
        role: "assistant",
        content: finalText,
      });

      let shouldCompact = true;
      if (opts.hookEmitter) {
        const hookResult = await opts.hookEmitter
          .emit(
            "before_compact",
            {
              agentType: opts.agentType,
              messageCount: agent.state.messages.length,
            },
            { agentType: opts.agentType },
          )
          .catch(() => undefined);
        if (hookResult?.cancel) {
          shouldCompact = false;
        }
      }
      if (shouldCompact) {
        await compactRuntimeThreadHistory({
          store: opts.store,
          threadKey,
          resolvedLlm: opts.resolvedLlm,
          agentType: opts.agentType,
        });
      }
    }

    opts.callbacks.onEnd(
      runEvents.recordRunEnd({
        finalText,
        ...(selfModApplied ? { selfModApplied } : {}),
      }),
    );
    updateOrchestratorReminderState(opts.store, {
      conversationId: opts.conversationId,
      shouldInjectDynamicReminder:
        opts.agentContext.shouldInjectDynamicReminder,
      finalText,
    });

    return runId;
  } catch (error) {
    const errorMessage = (error as Error).message || "Stella runtime failed";
    opts.callbacks.onError(runEvents.recordError(errorMessage));
    throw error;
  } finally {
    displayStream.dispose();
    unsubscribe();
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
};

export const runPiSubagentTask = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult> => {
  const runId = opts.runId ?? `local:sub:${crypto.randomUUID()}`;
  const prompt = opts.userPrompt.trim();
  const effectiveSystemPrompt = [
    buildSystemPrompt(opts.agentContext),
    shouldIncludeStellaDocumentation(opts.agentType)
      ? buildSelfModDocumentationPrompt(opts.frontendRoot)
      : "",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
  const threadKey = buildRunThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  const runEvents = createRunEventRecorder({
    store: opts.store,
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
  });
  let finalText = "";

  runEvents.recordRunStart();

  if (prompt) {
    appendThreadMessage(opts.store, {
      threadKey,
      role: "user",
      content: prompt,
    });
  }

  if (opts.abortSignal?.aborted) {
    runEvents.recordError("Aborted");
    return { runId, result: "", error: "Aborted" };
  }

  const tools = createPiTools({
    runId,
    rootRunId: opts.rootRunId ?? runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    taskDepth: opts.agentContext.taskDepth ?? 0,
    maxTaskDepth: opts.agentContext.maxTaskDepth,
    delegationAllowlist: opts.agentContext.delegationAllowlist,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    defaultSkills: opts.agentContext.defaultSkills,
    skillIds: opts.agentContext.skillIds,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
    hookEmitter: opts.hookEmitter,
  });

  const contextHistory = buildHistorySource(opts.agentContext);
  const agent = createRuntimeAgent({
    agentType: opts.agentType,
    systemPrompt: effectiveSystemPrompt,
    resolvedLlm: opts.resolvedLlm,
    hookEmitter: opts.hookEmitter,
    tools,
    historySource: contextHistory,
  });

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const unsubscribe = subscribeRuntimeAgentEvents({
    agent,
    runId,
    agentType: opts.agentType,
    recorder: runEvents,
    callbacks: opts.callbacks,
    onProgress: opts.onProgress,
  });

  try {
    await agent.prompt({
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: now(),
    });

    const { finalText: result, errorMessage } = getAgentCompletion(agent);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    finalText = result;
    await persistAssistantReply({
      store: opts.store,
      threadKey,
      resolvedLlm: opts.resolvedLlm,
      agentType: opts.agentType,
      content: result,
    });
    opts.callbacks?.onEnd?.(runEvents.recordRunEnd({ finalText: result }));

    return {
      runId,
      result,
    };
  } catch (error) {
    const errorMessage = (error as Error).message || "Subagent failed";
    opts.callbacks?.onError?.(runEvents.recordError(errorMessage));
    return {
      runId,
      result: "",
      error: errorMessage,
    };
  } finally {
    unsubscribe();
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
};
