import { RUNTIME_RUN_EVENT_TYPES } from "../../contracts/agent-runtime.js";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
} from "../../contracts/file-changes.js";
import type { AgentEvent, AgentMessage } from "../agent-core/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type {
  HookEvent,
  HookEventMap,
  HookRuntimeContext,
} from "../extensions/types.js";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { extractAssistantText, getToolResultPreview, now } from "./shared.js";
import { persistThreadPayloadMessage } from "./thread-memory.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeAssistantMessageEvent,
  RuntimeInterruptedEvent,
  RuntimeReasoningEvent,
  RuntimeRunCallbacks,
  RuntimeRunStartedEvent,
  RuntimeStatusEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
  SelfModAppliedPayload,
} from "./types.js";
import type { RuntimeAgentEventPayload } from "../../protocol/index.js";

const logger = createRuntimeLogger("agent-runtime.events");
type PersistedAssistantContent = Extract<
  PersistedRuntimeThreadPayload,
  { role: "assistant" }
>["content"];

type RuntimeAgentLike = {
  state: {
    messages: AgentMessage[];
  };
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
};

type RunRecorderArgs = {
  store: RuntimeStore;
  runId: string;
  conversationId: string;
  agentType: string;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  getResponseTarget?: () => RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeRunEventRecorder = ReturnType<typeof createRunEventRecorder>;

const fileChangesFromDetails = (details: unknown) => {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const candidate = (details as { fileChanges?: unknown }).fileChanges;
  return isFileChangeRecordArray(candidate) ? candidate : undefined;
};

const fileChangesFromToolResult = (result: unknown) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const candidate = (result as { fileChanges?: unknown }).fileChanges;
  return isFileChangeRecordArray(candidate) ? candidate : undefined;
};

const producedFilesFromDetails = (details: unknown) => {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const candidate = (details as { producedFiles?: unknown }).producedFiles;
  return isProducedFileRecordArray(candidate) ? candidate : undefined;
};

const producedFilesFromToolResult = (result: unknown) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const candidate = (result as { producedFiles?: unknown }).producedFiles;
  return isProducedFileRecordArray(candidate) ? candidate : undefined;
};

export const createRunEventRecorder = ({
  store,
  runId,
  conversationId,
  agentType,
  userMessageId,
  uiVisibility,
  getResponseTarget,
}: RunRecorderArgs) => {
  let seq = 0;
  let currentUserMessageId = userMessageId;
  const queuedUserMessageStarts: Array<{
    userMessageId: string;
    onStart?: () => void;
  }> = [];
  const nextSeq = () => ++seq;

  return {
    queueUserMessageId(nextUserMessageId: string, onStart?: () => void): void {
      const trimmed = nextUserMessageId.trim();
      if (trimmed) {
        queuedUserMessageStarts.push({
          userMessageId: trimmed,
          ...(onStart ? { onStart } : {}),
        });
      }
    },

    recordQueuedUserMessageStart(): RuntimeRunStartedEvent | null {
      const nextQueuedUserMessage = queuedUserMessageStarts.shift();
      if (!nextQueuedUserMessage) {
        return null;
      }
      nextQueuedUserMessage.onStart?.();
      currentUserMessageId = nextQueuedUserMessage.userMessageId;
      const responseTarget = getResponseTarget?.();
      return {
        runId,
        agentType,
        seq: nextSeq(),
        userMessageId: currentUserMessageId,
        ...(responseTarget ? { responseTarget } : {}),
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordAssistantMessageEnd(message: AgentMessage): RuntimeAssistantMessageEvent | null {
      const text = extractAssistantText(message).trim();
      if (!text) {
        return null;
      }
      const responseTarget = getResponseTarget?.();
      return {
        runId,
        agentType,
        seq: nextSeq(),
        userMessageId: currentUserMessageId,
        text,
        timestamp: message.timestamp ?? now(),
        ...(responseTarget ? { responseTarget } : {}),
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordRunStart(): void {
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        type: RUNTIME_RUN_EVENT_TYPES.RUN_START,
      });
    },

    recordStream(chunk: string): RuntimeStreamEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.STREAM,
        chunk,
      });
      const responseTarget = getResponseTarget?.();
      return {
        runId,
        agentType,
        seq,
        chunk,
        userMessageId: currentUserMessageId,
        ...(responseTarget ? { responseTarget } : {}),
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordReasoning(chunk: string): RuntimeReasoningEvent {
      const seq = nextSeq();
      const responseTarget = getResponseTarget?.();
      return {
        runId,
        agentType,
        seq,
        chunk,
        userMessageId: currentUserMessageId,
        ...(responseTarget ? { responseTarget } : {}),
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordStatus(
      statusText: string,
      statusState: RuntimeStatusEvent["statusState"] = "running",
    ): RuntimeStatusEvent {
      const seq = nextSeq();
      return {
        runId,
        agentType,
        seq,
        statusState,
        statusText,
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordToolStart(args: {
      toolCallId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
    }): RuntimeToolStartEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_START,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
      });
      return {
        runId,
        agentType,
        seq,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        args: args.toolArgs,
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordToolEnd(args: {
      toolCallId: string;
      toolName: string;
      result: unknown;
      details?: unknown;
    }): RuntimeToolEndEvent {
      const resultPreview = getToolResultPreview(
        args.toolName,
        args.details ?? args.result,
      );
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.TOOL_END,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        resultPreview,
      });
      const fileChanges =
        fileChangesFromDetails(args.details) ??
        fileChangesFromToolResult(args.result);
      const producedFiles =
        producedFilesFromDetails(args.details) ??
        producedFilesFromToolResult(args.result);
      return {
        runId,
        agentType,
        seq,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        resultPreview,
        ...(args.details !== undefined ? { details: args.details } : {}),
        ...(fileChanges ? { fileChanges } : {}),
        ...(producedFiles ? { producedFiles } : {}),
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordRunEnd(args: {
      finalText: string;
      selfModApplied?: SelfModAppliedPayload;
      responseTarget?: RuntimeEndEvent["responseTarget"];
    }): RuntimeEndEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.RUN_END,
        finalText: args.finalText,
        ...(args.selfModApplied ? { selfModApplied: args.selfModApplied } : {}),
      });
      return {
        runId,
        agentType,
        seq,
        userMessageId: currentUserMessageId,
        finalText: args.finalText,
        persisted: true,
        ...(args.selfModApplied ? { selfModApplied: args.selfModApplied } : {}),
        ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordError(error: string): RuntimeErrorEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: RUNTIME_RUN_EVENT_TYPES.ERROR,
        error,
        fatal: true,
      });
      return {
        runId,
        agentType,
        seq,
        error,
        fatal: true,
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordInterrupted(reason: string): RuntimeInterruptedEvent {
      const seq = nextSeq();
      store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId,
        agentType,
        seq,
        type: "interrupted",
        error: reason,
        fatal: false,
      });
      return {
        runId,
        agentType,
        seq,
        userMessageId: currentUserMessageId,
        reason,
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },
  };
};

const emitHook = <E extends HookEvent>(
  hookEmitter: HookEmitter | undefined,
  event: E,
  payload: HookEventMap[E]["payload"],
  filterContext: { tool?: string; agentType?: string },
) => {
  if (!hookEmitter) {
    return;
  }

  void hookEmitter.emit(event, payload, filterContext).catch(() => undefined);
};

/**
 * Build the common runtime context block injected into hook payloads.
 *
 * Centralized so every hook emission inside the run loop carries a consistent
 * shape (conversationId, threadKey, runId, isUserTurn, uiVisibility) without
 * each call site reconstructing it. Hooks that don't care can ignore the
 * extras; hooks that do care don't have to root around for them.
 */
const buildHookRuntimeContext = (args: {
  conversationId?: string;
  threadKey?: string;
  runId: string;
  uiVisibility?: "visible" | "hidden";
}): HookRuntimeContext => ({
  ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  ...(args.threadKey ? { threadKey: args.threadKey } : {}),
  runId: args.runId,
  ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
  isUserTurn: args.uiVisibility !== "hidden",
});

const extractToolUpdateStatusText = (
  event: Extract<AgentEvent, { type: "tool_execution_update" }>,
): string | undefined => {
  const details =
    typeof event.partialResult.details === "object" &&
    event.partialResult.details !== null
      ? (event.partialResult.details as { statusText?: unknown })
      : null;
  if (typeof details?.statusText === "string" && details.statusText.trim()) {
    return details.statusText.trim();
  }
  const firstTextBlock = event.partialResult.content.find(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
  return firstTextBlock?.type === "text"
    ? firstTextBlock.text.trim()
    : undefined;
};

export const subscribeRuntimeAgentEvents = ({
  agent,
  runId,
  agentType,
  recorder,
  callbacks,
  onProgress,
  displayEventHandler,
  hookEmitter,
  threadStore,
  threadKey,
  conversationId,
  uiVisibility,
}: {
  agent: RuntimeAgentLike;
  runId: string;
  agentType: string;
  recorder: RuntimeRunEventRecorder;
  callbacks?: Partial<RuntimeRunCallbacks>;
  onProgress?: (chunk: string) => void;
  displayEventHandler?: (event: AgentEvent) => boolean;
  hookEmitter?: HookEmitter;
  threadStore?: RuntimeStore;
  threadKey?: string;
  conversationId?: string;
  uiVisibility?: "visible" | "hidden";
}) => {
  // Stable run-level fields shared by every hook payload from this subscription.
  const hookContext = buildHookRuntimeContext({
    ...(conversationId ? { conversationId } : {}),
    ...(threadKey ? { threadKey } : {}),
    runId,
    ...(uiVisibility ? { uiVisibility } : {}),
  });
  const hookFilter = { agentType };

  return agent.subscribe((event) => {
    if (event.type === "agent_start") {
      emitHook(
        hookEmitter,
        "agent_start",
        { ...hookContext, agentType },
        hookFilter,
      );
      return;
    }

    if (event.type === "message_start") {
      // Keep queued user-message ids consistent between recorder and hooks.
      if (event.message.role === "user") {
        const runStartedEvent = recorder.recordQueuedUserMessageStart();
        if (runStartedEvent) {
          callbacks?.onRunStarted?.(runStartedEvent);
        }
      }
      emitHook(
        hookEmitter,
        "message_start",
        { ...hookContext, agentType, message: event.message },
        hookFilter,
      );
      return;
    }

    if (event.type === "message_end") {
      if (threadStore && threadKey) {
        const payload = toPersistedThreadPayload(event.message);
        if (payload && payload.role !== "user") {
          persistThreadPayloadMessage(threadStore, {
            threadKey,
            payload,
          });
        }
      }

      if (event.message.role === "assistant") {
        const assistantMessageEvent = recorder.recordAssistantMessageEnd(
          event.message,
        );
        if (assistantMessageEvent) {
          callbacks?.onAssistantMessage?.(assistantMessageEvent);
        }
      }

      // Observation-only; this fires after persistence and cannot replace the message.
      emitHook(
        hookEmitter,
        "message_end",
        { ...hookContext, agentType, message: event.message },
        hookFilter,
      );
      return;
    }

    if (event.type === "message_update") {
      // Recorder + IPC receive deltas before hooks observe the normalized update.
      if (event.assistantMessageEvent.type === "text_delta") {
        const chunk = event.assistantMessageEvent.delta;
        if (chunk) {
          const streamEvent = recorder.recordStream(chunk);
          onProgress?.(chunk);
          callbacks?.onStream?.(streamEvent);
        }
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        // Reasoning deltas stream to the per-agent reasoning section, not chat text.
        const chunk = event.assistantMessageEvent.delta;
        if (chunk) {
          const reasoningEvent = recorder.recordReasoning(chunk);
          callbacks?.onReasoning?.(reasoningEvent);
        }
      } else if (event.assistantMessageEvent.type === "thinking_end") {
        // Persisted on the assistant message; no user-facing event.
      }

      // Avoid per-token hook payload work when no hook consumes message updates.
      if (hookEmitter && hookEmitter.has("message_update")) {
        emitHook(
          hookEmitter,
          "message_update",
          {
            ...hookContext,
            agentType,
            message: event.message,
            assistantMessageEvent: event.assistantMessageEvent,
          },
          hookFilter,
        );
      }
      return;
    }

    if (displayEventHandler?.(event)) {
      return;
    }

    if (event.type === "tool_execution_start") {
      logger.debug("tool.start", {
        runId,
        agentType,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      });
      const toolStartEvent = recorder.recordToolStart({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolArgs: (event.args as Record<string, unknown>) ?? {},
      });
      callbacks?.onToolStart?.(toolStartEvent);
      emitHook(
        hookEmitter,
        "tool_execution_start",
        {
          ...hookContext,
          agentType,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: (event.args as Record<string, unknown>) ?? {},
        },
        { agentType, tool: event.toolName },
      );
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolEndEvent = recorder.recordToolEnd({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        details: event.result.details,
      });
      logger.debug("tool.end", {
        agentType,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        resultPreview: toolEndEvent.resultPreview.slice(0, 200),
      });
      callbacks?.onToolEnd?.(toolEndEvent);
      emitHook(
        hookEmitter,
        "tool_execution_end",
        {
          ...hookContext,
          agentType,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
        { agentType, tool: event.toolName },
      );
      return;
    }

    if (event.type === "tool_execution_update") {
      const statusText = extractToolUpdateStatusText(event);
      if (statusText) {
        callbacks?.onStatus?.(recorder.recordStatus(statusText));
      }
      emitHook(
        hookEmitter,
        "tool_execution_update",
        {
          ...hookContext,
          agentType,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: (event.args as Record<string, unknown>) ?? {},
          partialResult: event.partialResult,
        },
        { agentType, tool: event.toolName },
      );
      return;
    }

    if (event.type === "turn_start") {
      emitHook(
        hookEmitter,
        "turn_start",
        {
          ...hookContext,
          agentType,
          messageCount: agent.state.messages.length,
        },
        hookFilter,
      );
      return;
    }

    if (event.type === "turn_end") {
      const turnText =
        event.message?.role === "assistant"
          ? extractAssistantText(event.message)
          : "";
      emitHook(
        hookEmitter,
        "turn_end",
        { ...hookContext, agentType, assistantText: turnText },
        hookFilter,
      );
    }
  });
};

const toPersistedThreadPayload = (
  message: AgentMessage,
): PersistedRuntimeThreadPayload | null => {
  if (message.role === "assistant") {
    const trimmedContent: PersistedAssistantContent = [];
    for (const block of message.content) {
      if (block.type !== "text") {
        trimmedContent.push(block);
        continue;
      }
      const trimmed = block.text.trim();
      if (trimmed) {
        trimmedContent.push({ ...block, text: trimmed });
      }
    }
    if (trimmedContent.length === 0) {
      return null;
    }
    return {
      ...message,
      content: trimmedContent,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  // runtimeInternal messages are not universally durable; producers persist
  // durable cases at emit time, before queueing them into the agent loop.
  return null;
};
