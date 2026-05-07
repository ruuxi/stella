import crypto from "crypto";
import type { AssistantMessage, Usage } from "../../ai/types.js";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createUserPromptMessage,
} from "./run-preparation.js";
import { executeRuntimeToolCall, getRuntimeToolMetadata } from "./tool-adapters.js";
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
  buildOrchestratorPromptMessages,
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
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
}): Promise<{ finalText: string; sessionId: string }> => {
  const { runId, threadKey, runEvents } = args.session;
  // Orchestrator sessions own the response-target tracker; subagent sessions
  // do not (they don't drive the user-facing chat surface).
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

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
    : `${args.opts.conversationId}:run:${runId}`;
  const persistedSessionId =
    args.opts.store.getThreadExternalSessionId(threadKey);
  const toolMetadata = getRuntimeToolMetadata({
    toolsAllowlist: args.opts.agentContext.toolsAllowlist,
    toolCatalog: args.opts.toolCatalog,
  });

  const result = await runClaudeCodeTurn({
    runId,
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

  // Self-mod baseline capture is performed by the bundled self-mod hook on
  // `before_agent_start`; the matching detect-applied runs on `agent_end`
  // and threads the result onto RuntimeEndEvent.selfModApplied.
  const session = createExternalOrchestratorRunSession(opts, {
    runId: opts.runId ?? `local:${crypto.randomUUID()}`,
  });

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
    session.finalizeError(error);
    throw markOrchestratorErrorReported(error);
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
