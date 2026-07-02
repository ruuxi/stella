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
import type { ToolResult, ToolUpdateCallback } from "../tools/types.js";
import {
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import {
  buildCodexPromptFromMessages,
  runCodexAgentTurn,
  shutdownCodexAppServerRuntime,
  shouldUseCodexAgentRuntime,
} from "../integrations/codex-agent-runtime.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createRuntimePromptAgentMessage,
} from "./run-preparation.js";
import {
  executeRuntimeToolCall,
  extractAttachImageBlocks,
  getRuntimeToolMetadata,
  truncateModelVisibleToolText,
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

/**
 * Build an interim assistant message pairing streamed preamble text with the
 * tool call it precedes. Passing this through `recordAssistantMessageEnd`
 * stamps the emitted stream event with `followedByToolCall` (the recorder sets
 * it whenever a message carries a tool-call block), so the renderer keeps the
 * working indicator up across the preamble→tool gap instead of handing off to
 * the painted preamble text. External engines stream a visible preamble but,
 * unlike the default runtime, never record a message-end boundary before a
 * tool — so without this the indicator would dismiss on the preamble and only
 * reappear at tool-start.
 */
export const buildPreambleToolBoundaryMessage = (args: {
  preamble: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: args.preamble },
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "codex",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

const buildToolResultText = (toolResult: {
  result?: unknown;
  error?: string;
}): string =>
  toolResult.error
    ? `Error: ${toolResult.error}`
    : textFromUnknown(toolResult.result);

const buildToolResultContent = async (toolResult: {
  result?: unknown;
  error?: string;
}): Promise<(TextContent | ImageContent)[]> => {
  const rawText = buildToolResultText(toolResult);
  const { text, images } = await extractAttachImageBlocks(rawText);
  const truncatedText = truncateModelVisibleToolText(text);
  const content: (TextContent | ImageContent)[] = [];
  if (truncatedText.text || images.length === 0) {
    content.push({ type: "text", text: truncatedText.text });
  }
  content.push(...images);
  return content;
};

type ExternalEngineSessionKind =
  | "claude_code_local"
  | "claude_code_local_vanilla"
  | "codex_cli";

type ExternalOrchestratorEngine = "claude_code_local";

const shouldUseClaudeCodeRuntime = (opts: BaseRunOptions): boolean => {
  const primaryModelId = opts.agentContext.model ?? opts.resolvedLlm.model.id;
  return shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: opts.stellaAppDir,
    agentEngine: opts.agentContext.agentEngine,
    modelId: primaryModelId,
  });
};

export const selectExternalOrchestratorEngine = (
  opts: BaseRunOptions,
): ExternalOrchestratorEngine | null => {
  if (shouldUseClaudeCodeRuntime(opts)) {
    return "claude_code_local";
  }
  return null;
};

const EXTERNAL_ENGINE_SESSION_PREFIXES: readonly string[] = [
  "claude_code_local:",
  // Vanilla per-spawn Claude Code sessions are persisted under their own
  // namespace so a takeover run never `--resume`s a vanilla conversation
  // (and vice versa).
  "claude_code_local_vanilla:",
  "codex_cli:",
];

export const getExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
}): string | undefined => {
  const raw = args.store.getThreadExternalSessionId(args.threadKey);
  if (!raw) return undefined;
  const expectedPrefix = `${args.engine}:`;
  if (raw.startsWith(expectedPrefix)) {
    const sessionId = raw.slice(expectedPrefix.length).trim();
    return sessionId || undefined;
  }
  if (
    EXTERNAL_ENGINE_SESSION_PREFIXES.some((prefix) => raw.startsWith(prefix))
  ) {
    return undefined;
  }
  // Existing Claude Code sessions were stored before engine namespacing.
  return args.engine === "claude_code_local" ? raw : undefined;
};

export const setExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
  sessionId: string;
}) => {
  args.store.setThreadExternalSessionId(
    args.threadKey,
    `${args.engine}:${args.sessionId}`,
  );
};

const persistExternalPromptMessages = (
  opts: BaseRunOptions,
  threadKey: string,
  promptMessages: RuntimePromptMessage[],
) => {
  const promptInputs: Array<
    RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] }
  > =
    promptMessages.length > 0
      ? promptMessages
      : [
          {
            text: opts.userPrompt,
            attachments: opts.attachments,
          },
        ];
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

export const buildExternalStellaHistoryPromptMessage = (args: {
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
      '<stella_thread_history source="stella" note="Stella chat/runtime history is the source of truth for recall. Use it to answer questions about prior Stella messages, even when external engine session state is unavailable or incomplete.">',
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
          ? [
              {
                url: `data:${block.mimeType};base64,${block.data}`,
                mimeType: block.mimeType,
              },
            ]
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
      clearAllQueues: () => {
        queued.splice(0, queued.length);
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
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
  });
  // Per-spawn claude-code selection (spawn_agent `model: claude-code[/...]`)
  // runs vanilla Claude Code: CC keeps its own tools and config — no Stella
  // tool bridge, no system-prompt override (the headless flags and hook
  // settings still apply). The global engine preference keeps the full
  // takeover behavior (spawnEngine is never set on that path).
  const spawnEngine = args.opts.agentContext.spawnEngine;
  const vanilla = spawnEngine?.engine === "claude_code_local";
  const baseSessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  // Mode-suffixed so a later default-engine run on the same thread never
  // reuses a CLI process that was started with vanilla arguments.
  const sessionKey = vanilla ? `${baseSessionKey}:vanilla` : baseSessionKey;
  // The persisted CLI session id is namespaced by mode too, so a takeover
  // run never resumes a vanilla conversation on the same thread.
  const sessionEngine: "claude_code_local" | "claude_code_local_vanilla" =
    vanilla ? "claude_code_local_vanilla" : "claude_code_local";
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
  });
  const toolMetadata = vanilla
    ? []
    : getRuntimeToolMetadata({
        toolsAllowlist: args.opts.agentContext.toolsAllowlist,
        toolCatalog: args.opts.toolCatalog,
      });
  const claudeCodeModelId = getClaudeCodeAgentModelId(
    args.opts.stellaAppDir,
    args.opts.agentContext.model,
    args.opts.agentType,
    vanilla ? spawnEngine?.model : undefined,
  );
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
  // Unlike Codex (see runCodexHostedTurn.flushPreambleBeforeTool), Claude Code
  // needs no preamble buffer/flush here: the Claude Code emitter suppresses
  // streamed output for structured tool-request steps, so no visible preamble
  // paints before its tools and the working indicator never dismisses across a
  // preamble->tool gap. If that emitter ever starts streaming pre-tool
  // commentary, the same gap would reappear here and would need the equivalent
  // flush wiring.
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
      stellaAppDir: args.opts.stellaAppDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
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

  const historyPromptMessage = buildExternalStellaHistoryPromptMessage({
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
  const claudeCodeEffortLevel = getClaudeCodeRuntimeEffortLevel(
    args.opts.stellaAppDir,
  );

  let finalResult = await runClaudeCodeTurn({
    runId,
    sessionKey,
    persistedSessionId,
    modelId: claudeCodeModelId,
    ...(vanilla ? { vanilla } : {}),
    ...(claudeCodeEffortLevel ? { effortLevel: claudeCodeEffortLevel } : {}),
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
    const queuedHistoryPromptMessage = buildExternalStellaHistoryPromptMessage({
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
      modelId: claudeCodeModelId,
      ...(vanilla ? { vanilla } : {}),
      ...(claudeCodeEffortLevel ? { effortLevel: claudeCodeEffortLevel } : {}),
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
  const assistantMessageEvent = runEvents.recordAssistantTextEnd(
    finalResult.text,
  );
  if (assistantMessageEvent) {
    args.callbacks?.onAssistantMessage?.(assistantMessageEvent);
  }
  setExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
    sessionId: finalResult.sessionId,
  });

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
  };
};

const runCodexHostedTurn = async (args: {
  opts: BaseRunOptions & { onProgress?: (chunk: string) => void };
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{
  finalText: string;
  sessionId: string;
  fileChanges?: SubagentRunResult["fileChanges"];
}> => {
  const { runId, threadKey, runEvents } = args.session;
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
  });
  const sessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: "codex_cli",
  });
  const persistCodexSessionId = (sessionId: string) => {
    setExternalEngineSessionId({
      store: args.opts.store,
      threadKey,
      engine: "codex_cli",
      sessionId,
    });
  };
  const emitToolUpdateStatus = (update: ToolResult) => {
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
  // Buffers the assistant text Codex has streamed since the last message
  // boundary. When a tool call starts we flush it as an interim, tool-call-
  // bearing message (see `flushPreambleBeforeTool`) so the working indicator
  // does not dismiss on the preamble across the gap before the tool starts.
  let streamedAssistantText = "";
  const flushPreambleBeforeTool = (args2: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    const preamble = streamedAssistantText.trim();
    streamedAssistantText = "";
    if (!preamble) {
      return;
    }
    const preambleEvent = runEvents.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble,
        toolCallId: args2.toolCallId,
        toolName: args2.toolName,
        toolArgs: args2.toolArgs,
      }),
    );
    if (preambleEvent) {
      args.callbacks?.onAssistantMessage?.(preambleEvent);
    }
  };
  const executeCodexTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {
    flushPreambleBeforeTool({ toolCallId, toolName, toolArgs });
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
      stellaAppDir: args.opts.stellaAppDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
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
  const prompt = buildCodexPromptFromMessages({
    promptMessages: args.promptMessages,
  });
  let finalResult = await runCodexAgentTurn({
    runId,
    sessionKey,
    ...(persistedSessionId ? { persistedSessionId } : {}),
    prompt,
    systemPrompt: args.systemPrompt,
    cwd: localCliCwd,
    stellaDataDir: args.opts.stellaDataDir,
    stellaAppDir: args.opts.stellaAppDir,
    stellaModel: args.opts.agentContext.model,
    // Per-spawn codex model pin (spawn_agent `model: codex/<model>`).
    ...(args.opts.agentContext.spawnEngine?.engine === "codex_cli" &&
    args.opts.agentContext.spawnEngine.model
      ? { modelOverride: args.opts.agentContext.spawnEngine.model }
      : {}),
    attachments: args.opts.attachments,
    abortSignal: args.opts.abortSignal,
    onStatus: (status) => {
      args.opts.onProgress?.(status);
      args.callbacks?.onStatus?.(runEvents.recordStatus(status));
    },
    onStream: (chunk) => {
      streamedAssistantText += chunk;
      args.opts.onProgress?.(chunk);
      args.callbacks?.onStream?.(runEvents.recordStream(chunk));
    },
    onSessionId: persistCodexSessionId,
    onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
    executeTool: executeCodexTool,
    reuseAppServer: true,
    streamFinalAnswer: args.session.kind === "orchestrator",
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
    const queuedPrompt = buildCodexPromptFromMessages({
      promptMessages: queuedPromptMessages,
    });
    finalResult = await runCodexAgentTurn({
      runId,
      sessionKey,
      persistedSessionId: finalResult.sessionId,
      prompt: queuedPrompt,
      systemPrompt: args.systemPrompt,
      cwd: localCliCwd,
      stellaDataDir: args.opts.stellaDataDir,
      stellaAppDir: args.opts.stellaAppDir,
      stellaModel: args.opts.agentContext.model,
      ...(args.opts.agentContext.spawnEngine?.engine === "codex_cli" &&
      args.opts.agentContext.spawnEngine.model
        ? { modelOverride: args.opts.agentContext.spawnEngine.model }
        : {}),
      attachments: queuedAttachments,
      abortSignal: args.opts.abortSignal,
      onStatus: (status) => {
        args.opts.onProgress?.(status);
        args.callbacks?.onStatus?.(runEvents.recordStatus(status));
      },
      onStream: (chunk) => {
        streamedAssistantText += chunk;
        args.opts.onProgress?.(chunk);
        args.callbacks?.onStream?.(runEvents.recordStream(chunk));
      },
      onSessionId: persistCodexSessionId,
      onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
      executeTool: executeCodexTool,
      reuseAppServer: true,
      streamFinalAnswer: args.session.kind === "orchestrator",
    });
  }

  await persistAssistantReply({
    store: args.opts.store,
    threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: finalResult.text,
  });
  const assistantMessageEvent = runEvents.recordAssistantTextEnd(
    finalResult.text,
  );
  if (assistantMessageEvent) {
    args.callbacks?.onAssistantMessage?.(assistantMessageEvent);
  }
  persistCodexSessionId(finalResult.sessionId);

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
    ...(finalResult.fileChanges?.length
      ? { fileChanges: finalResult.fileChanges }
      : {}),
  };
};

export const runExternalOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string | null> => {
  const engine = selectExternalOrchestratorEngine(opts);
  if (!engine) {
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
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
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
    const useCodex = shouldUseCodexAgentRuntime({
      agentType: opts.agentType,
      agentEngine: opts.agentContext.agentEngine,
    });
    if (!useCodex) {
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
        stellaDataDir: opts.stellaDataDir,
        stellaAppDir: opts.stellaAppDir,
        agentType: opts.agentType,
        hookContext: {
          ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
          conversationId: opts.conversationId,
          threadKey: session.threadKey,
          runId: session.runId,
          ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        },
      });
      const systemPrompt = await buildSubagentSystemPrompt({
        ...opts,
        runId: session.runId,
      });
      const result = await runCodexHostedTurn({
        opts,
        session,
        systemPrompt,
        promptMessages,
        callbacks: opts.callbacks,
      });
      const finalized = await session.finalizeSuccess(result.finalText);
      if (result.fileChanges?.length) {
        finalized.fileChanges = result.fileChanges;
      }
      return finalized;
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
  }

  const session = createExternalSubagentRunSession(opts, {
    runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
  });

  try {
    const promptMessages = await buildSubagentPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
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
  shutdownCodexAppServerRuntime();
};
