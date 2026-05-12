import crypto from "crypto";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { ToolUpdateCallback } from "../tools/types.js";
import {
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import {
  getClaudeCodeAgentModelId,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createRuntimePromptAgentMessage,
} from "./run-preparation.js";
import {
  executeRuntimeToolCall,
  extractAttachImageBlocks,
  getRuntimeToolMetadata,
} from "./tool-adapters.js";
import {
  markOrchestratorErrorReported,
  resolveInterruptionReason,
} from "./run-completion.js";
import {
  createExternalOrchestratorRunSession,
  createExternalSubagentRunSession,
  type ExternalOrchestratorRunSession,
  type ExternalSubagentRunSession,
} from "./run-session.js";
import { now, resolveLocalCliCwd, textFromUnknown } from "./shared.js";
import {
  buildHistorySource,
  buildOrchestratorPromptMessages,
  buildSubagentPromptMessages,
  persistAssistantReply,
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import type {
  BaseRunOptions,
  OrchestratorRunOptions,
  RuntimeRunCallbacks,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const buildToolCallPayload = (args: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-code",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

const buildToolResultText = (toolResult: { result?: unknown; error?: string }): string =>
  toolResult.error ? `Error: ${toolResult.error}` : textFromUnknown(toolResult.result);

const buildToolResultContent = async (toolResult: {
  result?: unknown;
  error?: string;
}): Promise<(TextContent | ImageContent)[]> => {
  const rawText = buildToolResultText(toolResult);
  const { text, images } = await extractAttachImageBlocks(rawText);
  const content: (TextContent | ImageContent)[] = [];
  if (text || images.length === 0) {
    content.push({ type: "text", text });
  }
  content.push(...images);
  return content;
};

const shouldUseClaudeCodeRuntime = (opts: BaseRunOptions): boolean => {
  const primaryModelId = opts.agentContext.model ?? opts.resolvedLlm.model.id;
  return shouldUseClaudeCodeAgentRuntime({
    stellaRoot: opts.stellaRoot,
    agentEngine: opts.agentContext.agentEngine,
    modelId: primaryModelId,
  });
};

const persistClaudePromptMessages = (
  opts: BaseRunOptions,
  threadKey: string,
  promptMessages: RuntimePromptMessage[],
) => {
  const promptInputs: Array<
    RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] }
  > =
    promptMessages.length > 0
      ? promptMessages
      : [{
          text: opts.userPrompt,
          attachments: opts.attachments,
        }];
  const promptTimestamp = now();
  for (const [index, promptInput] of promptInputs.entries()) {
    const promptMessage = createRuntimePromptAgentMessage(
      promptInput,
      promptTimestamp + index,
    );
    const messageType = promptInput.messageType ?? "user";
    if (messageType === "user" && promptMessage.role === "user") {
      persistThreadPayloadMessage(opts.store, {
        threadKey,
        payload: promptMessage,
      });
    }
    if (
      messageType === "message" &&
      promptMessage.role === "runtimeInternal" &&
      promptInput.customType?.startsWith("bootstrap.")
    ) {
      persistThreadCustomMessage(opts.store, {
        threadKey,
        customType: promptInput.customType,
        content: promptMessage.content,
        display: promptMessage.display === true,
        timestamp: promptMessage.timestamp,
      });
    }
  }
};

const formatClaudePromptMessage = (
  message: RuntimePromptMessage,
  index: number,
): string => {
  const messageType = message.messageType ?? "user";
  const visibility = message.uiVisibility ?? "visible";
  const customType = message.customType?.trim();
  const attrs = [
    `index="${index + 1}"`,
    `type="${messageType}"`,
    `visibility="${visibility}"`,
    ...(customType
      ? [`customType="${customType.replaceAll('"', "&quot;")}"`]
      : []),
  ].join(" ");
  return `<message ${attrs}>\n${message.text.trim()}\n</message>`;
};

export const buildClaudePromptFromMessages = (
  promptMessages: RuntimePromptMessage[],
): string =>
  [
    "Stella is providing this turn as ordered prompt messages.",
    'Messages with visibility="hidden" are runtime context for you only; do not quote or reveal them unless the user explicitly asks about the relevant fact.',
    ...promptMessages.map(formatClaudePromptMessage),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

type ExternalQueuedMessage = {
  message: AgentMessage;
  delivery: "steer" | "followUp";
};

const contentToText = (content: AgentMessage["content"]): string => {
  if (typeof content === "string") {
    return content.trim();
  }
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[Image: ${block.mimeType}]`;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall") {
        return `[Tool call] ${block.name}\n${textFromUnknown(block.arguments)}`;
      }
      return "";
    })
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .trim();
};

const buildClaudeHistoryPromptMessage = (args: {
  opts: BaseRunOptions;
  promptMessages: RuntimePromptMessage[];
}): RuntimePromptMessage | null => {
  const history = buildHistorySource(args.opts.agentContext);
  if (history.length === 0) {
    return null;
  }
  const lastPromptUserText = [...args.promptMessages]
    .reverse()
    .find((message) => (message.messageType ?? "user") === "user")
    ?.text.trim();
  const trimmedHistory = [...history];
  const lastHistory = trimmedHistory[trimmedHistory.length - 1];
  if (
    lastHistory?.role === "user" &&
    lastPromptUserText &&
    contentToText(lastHistory.content) === lastPromptUserText
  ) {
    trimmedHistory.pop();
  }
  const lines = trimmedHistory
    .map((message, index) => {
      const text = contentToText(message.content);
      if (!text) return "";
      return `<history_message index="${index + 1}" role="${message.role}">\n${text}\n</history_message>`;
    })
    .filter((entry) => entry.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  return {
    messageType: "message",
    uiVisibility: "hidden",
    customType: "runtime.stella_thread_history",
    text: [
      '<stella_thread_history source="stella" note="Stella chat/runtime history is the source of truth for recall. Use it to answer questions about prior Stella messages, even when Claude Code session state is unavailable or incomplete.">',
      ...lines,
      "</stella_thread_history>",
    ].join("\n"),
  };
};

const formatQueuedClaudeMessage = (
  entry: ExternalQueuedMessage,
  index: number,
): RuntimePromptMessage => {
  const text = contentToText(entry.message.content);
  if (entry.message.role === "runtimeInternal") {
    return {
      text,
      messageType: "message",
      uiVisibility: "hidden",
      customType: entry.message.customType ?? `runtime.${entry.delivery}`,
      display: entry.message.display,
    };
  }
  return {
    text,
    messageType: "user",
    uiVisibility: "hidden",
    customType: `runtime.queued_${entry.delivery}_${index + 1}`,
  };
};

const attachmentsFromQueuedMessages = (
  entries: ExternalQueuedMessage[],
): RuntimeAttachmentRef[] =>
  entries.flatMap((entry) => {
    if (typeof entry.message.content === "string") {
      return [];
    }
    return entry.message.content.flatMap(
      (block: TextContent | ImageContent | ThinkingContent | ToolCall) =>
        block.type === "image"
          ? [{
              url: `data:${block.mimeType};base64,${block.data}`,
              mimeType: block.mimeType,
            }]
          : [],
    );
  });

const createExternalLiveAgent = () => {
  const queued: ExternalQueuedMessage[] = [];
  const state = { isStreaming: true };
  return {
    agent: {
      state,
      steer: (message: AgentMessage) => {
        queued.push({ message, delivery: "steer" });
      },
      followUp: (message: AgentMessage) => {
        queued.push({ message, delivery: "followUp" });
      },
    },
    drain(): ExternalQueuedMessage[] {
      return queued.splice(0, queued.length);
    },
    finish(): void {
      state.isStreaming = false;
    },
  };
};

const runClaudeHostedTurn = async (args: {
  opts: BaseRunOptions;
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{ finalText: string; sessionId: string }> => {
  const { runId, threadKey, runEvents } = args.session;
  // Orchestrator sessions own the response-target tracker; subagent sessions
  // do not (they don't drive the user-facing chat surface).
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistClaudePromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaRoot: args.opts.stellaRoot,
  });
  const sessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  const persistedSessionId =
    args.opts.store.getThreadExternalSessionId(threadKey);
  const toolMetadata = getRuntimeToolMetadata({
    toolsAllowlist: args.opts.agentContext.toolsAllowlist,
    toolCatalog: args.opts.toolCatalog,
  });
  const emitToolUpdateStatus = (update: {
    result?: unknown;
    details?: unknown;
    error?: string;
  }) => {
    const details =
      update.details && typeof update.details === "object"
        ? (update.details as { statusText?: unknown })
        : null;
    const statusText =
      typeof details?.statusText === "string" && details.statusText.trim()
        ? details.statusText.trim()
        : buildToolResultText(update).trim();
    if (statusText) {
      args.callbacks?.onStatus?.(runEvents.recordStatus(statusText));
    }
  };
  const executeClaudeTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {
    responseTargetTracker?.noteToolStart(toolName, toolArgs);
    args.callbacks?.onToolStart?.(
      runEvents.recordToolStart({
        toolCallId,
        toolName,
        toolArgs,
      }),
    );
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: buildToolCallPayload({
        toolCallId,
        toolName,
        toolArgs,
      }),
    });
    const toolResult = await executeRuntimeToolCall({
      toolCallId,
      toolName,
      args: toolArgs,
      runId,
      rootRunId: args.opts.rootRunId ?? runId,
      agentId: args.opts.agentId,
      conversationId: args.opts.conversationId,
      agentType: args.opts.agentType,
      deviceId: args.opts.deviceId,
      stellaRoot: args.opts.stellaRoot,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      allowedToolNames: args.opts.agentContext.toolsAllowlist,
      store: args.opts.store,
      toolExecutor: args.opts.toolExecutor,
      hookEmitter: args.opts.hookEmitter,
      signal,
      onUpdate,
    });
    responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId,
        toolName,
        result: toolResult,
        details: toolResult.details,
      }),
    );
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: await buildToolResultContent(toolResult),
        isError: Boolean(toolResult.error),
        timestamp: now(),
      },
    });
    return toolResult;
  };

  const historyPromptMessage = buildClaudeHistoryPromptMessage({
    opts: args.opts,
    promptMessages: args.promptMessages,
  });
  const promptMessagesWithHistory = historyPromptMessage
    ? [historyPromptMessage, ...args.promptMessages]
    : args.promptMessages;
  const prompt = buildClaudePromptFromMessages(promptMessagesWithHistory);
  const resumeFallbackPrompt = historyPromptMessage
    ? buildClaudePromptFromMessages(promptMessagesWithHistory)
    : undefined;

  let finalResult = await runClaudeCodeTurn({
    runId,
    sessionKey,
    persistedSessionId,
    modelId: getClaudeCodeAgentModelId(),
    prompt,
    ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
    systemPrompt: args.systemPrompt,
    cwd: localCliCwd,
    attachments: args.opts.attachments,
    tools: toolMetadata,
    abortSignal: args.opts.abortSignal,
    onStatusChange: (status) => {
      args.callbacks?.onStatus?.(
        runEvents.recordStatus(status.text, status.state),
      );
    },
    onStream: (chunk) => {
      args.callbacks?.onStream?.(runEvents.recordStream(chunk));
    },
    onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
    executeTool: executeClaudeTool,
  });

  for (;;) {
    const queued = args.liveAgent?.drain() ?? [];
    if (queued.length === 0) {
      break;
    }
    const queuedStarted = runEvents.recordQueuedUserMessageStart();
    if (queuedStarted) {
      args.callbacks?.onRunStarted?.(queuedStarted);
    }
    const queuedPromptMessages = queued.map(formatQueuedClaudeMessage);
    const queuedAttachments = attachmentsFromQueuedMessages(queued);
    const queuedHistoryPromptMessage = buildClaudeHistoryPromptMessage({
      opts: args.opts,
      promptMessages: queuedPromptMessages,
    });
    const queuedPromptMessagesWithHistory = queuedHistoryPromptMessage
      ? [queuedHistoryPromptMessage, ...queuedPromptMessages]
      : queuedPromptMessages;
    const queuedPrompt = buildClaudePromptFromMessages(
      queuedPromptMessagesWithHistory,
    );
    const queuedResumeFallbackPrompt = queuedHistoryPromptMessage
      ? buildClaudePromptFromMessages(queuedPromptMessagesWithHistory)
      : undefined;
    finalResult = await runClaudeCodeTurn({
      runId,
      sessionKey,
      persistedSessionId: finalResult.sessionId,
      modelId: getClaudeCodeAgentModelId(),
      prompt: queuedPrompt,
      ...(queuedResumeFallbackPrompt
        ? { resumeFallbackPrompt: queuedResumeFallbackPrompt }
        : {}),
      systemPrompt: args.systemPrompt,
      cwd: localCliCwd,
      attachments: queuedAttachments,
      tools: toolMetadata,
      abortSignal: args.opts.abortSignal,
      onStatusChange: (status) => {
        args.callbacks?.onStatus?.(
          runEvents.recordStatus(status.text, status.state),
        );
      },
      onStream: (chunk) => {
        args.callbacks?.onStream?.(runEvents.recordStream(chunk));
      },
      executeTool: executeClaudeTool,
      onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
    });
  }

  await persistAssistantReply({
    store: args.opts.store,
    threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: finalResult.text,
  });
  args.opts.store.setThreadExternalSessionId(threadKey, finalResult.sessionId);

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
  };
};

export const runExternalOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string | null> => {
  if (!shouldUseClaudeCodeRuntime(opts)) {
    return null;
  }

  // Self-mod baseline capture is performed by the bundled self-mod hook on
  // `before_agent_start`; the matching detect-applied runs on `agent_end`
  // and threads the result onto RuntimeEndEvent.selfModApplied.
  const session = createExternalOrchestratorRunSession(opts, {
    runId: opts.runId ?? `local:${crypto.randomUUID()}`,
  });
  const liveAgent = createExternalLiveAgent();

  try {
    // Thread `session.runId` into the prompt build so the
    // `before_agent_start` hook's payload carries the run id. Without
    // this, the bundled self-mod hook bails (it requires `payload.runId`
    // to key its baseline cache), the cache stays empty, and the
    // matching `agent_end` finds no entry — silently breaking the
    // morph overlay for the Claude Code orchestrator path. The Pi
    // path threads the session runId through `OrchestratorSession.runTurn`
    // already; mirror that here.
    const systemPrompt = await buildRuntimeSystemPrompt({
      ...opts,
      runId: session.runId,
    });
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
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });
    opts.onExecutionSessionCreated?.({
      runId: session.runId,
      threadKey: session.threadKey,
      queueUserMessageId: session.runEvents.queueUserMessageId,
      agent: liveAgent.agent,
    });
    const result = await runClaudeHostedTurn({
      opts,
      session,
      systemPrompt,
      promptMessages,
      callbacks: opts.callbacks,
      liveAgent,
    });
    return await session.finalizeSuccess(result.finalText);
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    session.finalizeError(error);
    throw markOrchestratorErrorReported(error);
  } finally {
    liveAgent.finish();
  }
};

export const runExternalSubagentTurn = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult | null> => {
  if (!shouldUseClaudeCodeRuntime(opts)) {
    return null;
  }

  const session = createExternalSubagentRunSession(opts, {
    runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
  });

  try {
    const promptMessages = await buildSubagentPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaHome: opts.stellaHome,
      stellaRoot: opts.stellaRoot,
      agentType: opts.agentType,
      hookContext: {
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        conversationId: opts.conversationId,
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });
    // Thread session.runId so a future `triggersSelfModDetection`
    // subagent (none today) would have the same baseline-capture
    // wiring as the orchestrator.
    const systemPrompt = await buildSubagentSystemPrompt({
      ...opts,
      runId: session.runId,
    });
    const result = await runClaudeHostedTurn({
      opts,
      session,
      systemPrompt,
      promptMessages,
      callbacks: opts.callbacks,
    });
    return await session.finalizeSuccess(result.finalText);
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    return session.finalizeError(error);
  }
};

export const shutdownExternalEngineIntegrations = (): void => {
  shutdownClaudeCodeRuntime();
};
