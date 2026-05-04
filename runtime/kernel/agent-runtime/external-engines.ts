import crypto from "crypto";
import type { AssistantMessage, Usage } from "../../ai/types.js";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import { createRunEventRecorder } from "./run-events.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createUserPromptMessage,
} from "./run-preparation.js";
import { executeRuntimeToolCall, getRuntimeToolMetadata } from "./tool-adapters.js";
import {
  finalizeOrchestratorError,
  finalizeOrchestratorInterrupted,
  finalizeOrchestratorSuccess,
  finalizeSubagentError,
  finalizeSubagentInterrupted,
  finalizeSubagentSuccess,
  markOrchestratorErrorReported,
  resolveInterruptionReason,
} from "./run-completion.js";
import {
  createOrchestratorResponseTargetTracker,
} from "./response-target.js";
import { now, resolveLocalCliCwd, textFromUnknown } from "./shared.js";
import {
  buildOrchestratorPromptMessages,
  buildRunThreadKey,
  buildSubagentPromptMessages,
  persistAssistantReply,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import type {
  BaseRunOptions,
  OrchestratorRunOptions,
  RuntimeRunCallbacks,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";
import type { RuntimePromptMessage } from "../../protocol/index.js";
import {
  isLocalCliAgentId,
} from "../../contracts/agent-runtime.js";

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

const shouldUseClaudeCodeRuntime = (opts: BaseRunOptions): boolean => {
  const primaryModelId = opts.agentContext.model ?? opts.resolvedLlm.model.id;
  return (
    isLocalCliAgentId(opts.agentType) &&
    (opts.agentContext.agentEngine === "claude_code_local" ||
      isClaudeCodeModel(primaryModelId))
  );
};

const persistUserPrompt = (opts: BaseRunOptions, threadKey: string) => {
  const payload = {
    ...createUserPromptMessage(opts.userPrompt, opts.attachments),
    timestamp: now(),
  };
  persistThreadPayloadMessage(opts.store, {
    threadKey,
    payload,
  });
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

const runClaudeHostedTurn = async (args: {
  opts: BaseRunOptions;
  runId: string;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  responseTargetTracker?: ReturnType<typeof createOrchestratorResponseTargetTracker>;
}) => {
  const threadKey = buildRunThreadKey({
    conversationId: args.opts.conversationId,
    agentType: args.opts.agentType,
    runId: args.runId,
    threadId: args.opts.agentContext.activeThreadId,
  });
  const runEvents = createRunEventRecorder({
    store: args.opts.store,
    runId: args.runId,
    conversationId: args.opts.conversationId,
    agentType: args.opts.agentType,
    userMessageId: args.opts.userMessageId,
    uiVisibility: args.opts.uiVisibility,
    getResponseTarget: () =>
      args.responseTargetTracker?.resolve() ?? args.opts.responseTarget,
  });
  runEvents.recordRunStart();
  persistUserPrompt(args.opts, threadKey);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaRoot: args.opts.stellaRoot,
  });
  const sessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${args.runId}`;
  const persistedSessionId =
    args.opts.store.getThreadExternalSessionId(threadKey);
  const toolMetadata = getRuntimeToolMetadata({
    toolsAllowlist: args.opts.agentContext.toolsAllowlist,
    toolCatalog: args.opts.toolCatalog,
  });

  const result = await runClaudeCodeTurn({
    runId: args.runId,
    sessionKey,
    persistedSessionId,
    modelId: args.opts.agentContext.model ?? args.opts.resolvedLlm.model.id,
    prompt: buildClaudePromptFromMessages(args.promptMessages),
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
    executeTool: async (toolCallId, toolName, toolArgs, signal) => {
      args.responseTargetTracker?.noteToolStart(toolName, toolArgs);
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
        runId: args.runId,
        rootRunId: args.opts.rootRunId ?? args.runId,
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
      });
      args.responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
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
          content: [{ type: "text", text: buildToolResultText(toolResult) }],
          isError: Boolean(toolResult.error),
          timestamp: now(),
        },
      });
      return toolResult;
    },
  });

  await persistAssistantReply({
    store: args.opts.store,
    threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: result.text,
  });
  args.opts.store.setThreadExternalSessionId(threadKey, result.sessionId);

  return {
    runId: args.runId,
    threadKey,
    runEvents,
    finalText: result.text,
    sessionId: result.sessionId,
  };
};

export const runExternalOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string | null> => {
  if (!shouldUseClaudeCodeRuntime(opts)) {
    return null;
  }

  const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
  const baselineHead =
    opts.stellaRoot && opts.selfModMonitor
      ? await opts.selfModMonitor
          .getBaselineHead(opts.stellaRoot)
          .catch(() => null)
      : null;
  const responseTargetTracker = createOrchestratorResponseTargetTracker(
    opts.responseTarget,
  );

  try {
    const systemPrompt = await buildRuntimeSystemPrompt(opts);
    const promptMessages = await buildOrchestratorPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaHome: opts.stellaHome,
      stellaRoot: opts.stellaRoot,
    });
    const result = await runClaudeHostedTurn({
      opts,
      runId,
      systemPrompt,
      promptMessages,
      callbacks: opts.callbacks,
      responseTargetTracker,
    });
    await finalizeOrchestratorSuccess({
      opts,
      runId,
      threadKey: result.threadKey,
      runEvents: result.runEvents,
      agent: { state: { messages: [] } },
      finalText: result.finalText,
      baselineHead,
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
        runEvents: createRunEventRecorder({
          store: opts.store,
          runId,
          conversationId: opts.conversationId,
          agentType: opts.agentType,
          userMessageId: opts.userMessageId,
        }),
        reason: interruptedReason,
      });
      return runId;
    }
    finalizeOrchestratorError({
      opts,
      runEvents: createRunEventRecorder({
        store: opts.store,
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        userMessageId: opts.userMessageId,
      }),
      error,
    });
    throw markOrchestratorErrorReported(error);
  }
};

export const runExternalSubagentTurn = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult | null> => {
  if (!shouldUseClaudeCodeRuntime(opts)) {
    return null;
  }

  const runId = opts.runId ?? `local:sub:${crypto.randomUUID()}`;

  try {
    const promptMessages = await buildSubagentPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaHome: opts.stellaHome,
      stellaRoot: opts.stellaRoot,
    });
    const result = await runClaudeHostedTurn({
      opts,
      runId,
      systemPrompt: buildSubagentSystemPrompt(opts),
      promptMessages,
      callbacks: opts.callbacks,
    });
    return await finalizeSubagentSuccess({
      opts,
      runEvents: result.runEvents,
      runId,
      threadKey: result.threadKey,
      result: result.finalText,
    });
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return finalizeSubagentInterrupted({
        opts,
        runEvents: createRunEventRecorder({
          store: opts.store,
          runId,
          conversationId: opts.conversationId,
          agentType: opts.agentType,
          userMessageId: opts.userMessageId,
        }),
        runId,
        reason: interruptedReason,
      });
    }
    return finalizeSubagentError({
      opts,
      runEvents: createRunEventRecorder({
        store: opts.store,
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        userMessageId: opts.userMessageId,
      }),
      runId,
      error,
    });
  }
};

export const shutdownExternalEngineIntegrations = (): void => {
  shutdownClaudeCodeRuntime();
};
