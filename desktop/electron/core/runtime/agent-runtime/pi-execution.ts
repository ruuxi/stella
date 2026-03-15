import crypto from "crypto";
import { Agent } from "../../agent/agent.js";
import {
  shouldIncludeStellaDocumentation,
  RUNTIME_RUN_EVENT_TYPES,
} from "../../../../src/shared/contracts/agent-runtime.js";
import { createDisplayStreamController } from "./display-stream.js";
import {
  buildDefaultTransformContext,
  createBeforeProviderPayloadTransform,
  extractAssistantText,
  getAgentCompletion,
  getToolResultPreview,
  now,
  PI_AGENT_MESSAGE_FILTER,
  toAgentMessages,
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
  let seq = 0;
  const nextSeq = () => ++seq;
  const baselineHead =
    opts.frontendRoot && opts.selfModMonitor
      ? await opts.selfModMonitor
          .getBaselineHead(opts.frontendRoot)
          .catch(() => null)
      : null;

  console.log(
    `[stella:trace] orchestrator start | runId=${runId} | agent=${opts.agentType} | model=${opts.resolvedLlm.model.id} | convId=${opts.conversationId}`,
  );
  console.log(`[stella:trace] user prompt: ${opts.userPrompt.slice(0, 300)}`);

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

  opts.store.recordRunEvent({
    timestamp: now(),
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    type: RUNTIME_RUN_EVENT_TYPES.RUN_START,
  });

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

  console.log(
    `[stella:trace] tools for ${opts.agentType}:`,
    tools.map((tool) => ({
      name: tool.name,
      hasDesc: !!tool.description,
      paramKeys: Object.keys(
        ((tool.parameters as Record<string, unknown>)?.properties ??
          {}) as Record<string, unknown>,
      ),
    })),
  );

  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveSystemPrompt,
      model: opts.resolvedLlm.model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(historySource),
    },
    convertToLlm: PI_AGENT_MESSAGE_FILTER,
    transformContext: buildDefaultTransformContext(opts.resolvedLlm),
    getApiKey: () => opts.resolvedLlm.getApiKey(),
    onPayload: createBeforeProviderPayloadTransform(
      opts.hookEmitter,
      opts.agentType,
    ),
  });

  if (opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const displayStream = createDisplayStreamController(opts.displayHtml);

  const unsubscribe = agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const chunk = event.assistantMessageEvent.delta;
      if (!chunk) return;
      const streamSeq = nextSeq();
      opts.callbacks.onStream({
        runId,
        agentType: opts.agentType,
        seq: streamSeq,
        chunk,
      });
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: streamSeq,
        type: RUNTIME_RUN_EVENT_TYPES.STREAM,
        chunk,
      });
      return;
    }

    if (displayStream.handleEvent(event)) {
      return;
    }

    if (event.type === "tool_execution_start") {
      console.log(
        `[stella:trace] tool exec start | ${event.toolName} | callId=${event.toolCallId} | args=${JSON.stringify(event.args ?? {}).slice(0, 300)}`,
      );
      const toolSeq = nextSeq();
      opts.callbacks.onToolStart({
        runId,
        agentType: opts.agentType,
        seq: toolSeq,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: (event.args as Record<string, unknown>) ?? {},
      });
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: toolSeq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_START,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const preview = getToolResultPreview(event.toolName, event.result);
      console.log(
        `[stella:trace] tool exec end   | ${event.toolName} | callId=${event.toolCallId} | result=${preview.slice(0, 200)}`,
      );
      const toolSeq = nextSeq();
      opts.callbacks.onToolEnd({
        runId,
        agentType: opts.agentType,
        seq: toolSeq,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultPreview: preview,
      });
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: toolSeq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_END,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultPreview: preview,
      });
    }

    if (event.type === "turn_start" && opts.hookEmitter) {
      void opts.hookEmitter
        .emit(
          "turn_start",
          {
            agentType: opts.agentType,
            messageCount: agent.state.messages.length,
          },
          { agentType: opts.agentType },
        )
        .catch(() => undefined);
    }
    if (event.type === "turn_end" && opts.hookEmitter) {
      const turnText =
        event.message?.role === "assistant"
          ? extractAssistantText(event.message)
          : "";
      void opts.hookEmitter
        .emit(
          "turn_end",
          { agentType: opts.agentType, assistantText: turnText },
          { agentType: opts.agentType },
        )
        .catch(() => undefined);
    }
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
    console.log(
      `[stella:trace] orchestrator end | runId=${runId} | finalText=${finalText.slice(0, 300)}`,
    );

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

    const endSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: endSeq,
      type: RUNTIME_RUN_EVENT_TYPES.RUN_END,
      finalText,
      ...(selfModApplied ? { selfModApplied } : {}),
    });

    opts.callbacks.onEnd({
      runId,
      agentType: opts.agentType,
      seq: endSeq,
      finalText,
      persisted: true,
      ...(selfModApplied ? { selfModApplied } : {}),
    });
    updateOrchestratorReminderState(opts.store, {
      conversationId: opts.conversationId,
      shouldInjectDynamicReminder:
        opts.agentContext.shouldInjectDynamicReminder,
      finalText,
    });

    return runId;
  } catch (error) {
    const errorMessage = (error as Error).message || "Stella runtime failed";
    const errSeq = nextSeq();

    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: errSeq,
      type: RUNTIME_RUN_EVENT_TYPES.ERROR,
      error: errorMessage,
      fatal: true,
    });

    opts.callbacks.onError({
      runId,
      agentType: opts.agentType,
      seq: errSeq,
      error: errorMessage,
      fatal: true,
    });
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
  let seq = 0;
  const nextSeq = () => ++seq;
  let finalText = "";

  opts.store.recordRunEvent({
    timestamp: now(),
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    type: RUNTIME_RUN_EVENT_TYPES.RUN_START,
  });

  if (prompt) {
    appendThreadMessage(opts.store, {
      threadKey,
      role: "user",
      content: prompt,
    });
  }

  if (opts.abortSignal?.aborted) {
    const errSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: errSeq,
      type: RUNTIME_RUN_EVENT_TYPES.ERROR,
      error: "Aborted",
      fatal: true,
    });
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
  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveSystemPrompt,
      model: opts.resolvedLlm.model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(contextHistory),
    },
    convertToLlm: PI_AGENT_MESSAGE_FILTER,
    transformContext: buildDefaultTransformContext(opts.resolvedLlm),
    getApiKey: () => opts.resolvedLlm.getApiKey(),
    onPayload: createBeforeProviderPayloadTransform(
      opts.hookEmitter,
      opts.agentType,
    ),
  });

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const unsubscribe = agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const chunk = event.assistantMessageEvent.delta;
      if (chunk) {
        opts.onProgress?.(chunk);
        const streamSeq = nextSeq();
        opts.store.recordRunEvent({
          timestamp: now(),
          runId,
          conversationId: opts.conversationId,
          agentType: opts.agentType,
          seq: streamSeq,
          type: RUNTIME_RUN_EVENT_TYPES.STREAM,
          chunk,
        });
        opts.callbacks?.onStream?.({
          runId,
          agentType: opts.agentType,
          seq: streamSeq,
          chunk,
        });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolSeq = nextSeq();
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: toolSeq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_START,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      opts.callbacks?.onToolStart?.({
        runId,
        agentType: opts.agentType,
        seq: toolSeq,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: (event.args as Record<string, unknown>) ?? {},
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const preview = getToolResultPreview(event.toolName, event.result);
      const toolSeq = nextSeq();
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: toolSeq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_END,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultPreview: preview,
      });
      opts.callbacks?.onToolEnd?.({
        runId,
        agentType: opts.agentType,
        seq: toolSeq,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultPreview: preview,
      });
    }
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
    const endSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: endSeq,
      type: RUNTIME_RUN_EVENT_TYPES.RUN_END,
      finalText: result,
    });
    opts.callbacks?.onEnd?.({
      runId,
      agentType: opts.agentType,
      seq: endSeq,
      finalText,
      persisted: true,
    });

    return {
      runId,
      result,
    };
  } catch (error) {
    const errorMessage = (error as Error).message || "Subagent failed";
    const errSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: errSeq,
      type: RUNTIME_RUN_EVENT_TYPES.ERROR,
      error: errorMessage,
      fatal: true,
    });
    opts.callbacks?.onError?.({
      runId,
      agentType: opts.agentType,
      seq: errSeq,
      error: errorMessage,
      fatal: true,
    });
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
