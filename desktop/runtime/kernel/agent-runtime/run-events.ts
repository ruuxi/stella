import { RUNTIME_RUN_EVENT_TYPES } from "../../../src/shared/contracts/agent-runtime.js";
import type { AgentEvent, AgentMessage } from "../agent-core/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { HookEventMap } from "../extensions/types.js";
import { sanitizeAssistantText } from "../internal-tool-transcript.js";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import {
  extractAssistantText,
  getToolResultPreview,
  now,
} from "./shared.js";
import { persistThreadPayloadMessage } from "./thread-memory.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeInterruptedEvent,
  RuntimeReasoningEvent,
  RuntimeRunCallbacks,
  RuntimeStatusEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
  SelfModAppliedPayload,
} from "./types.js";

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
};

export type RuntimeRunEventRecorder = ReturnType<typeof createRunEventRecorder>;

export const createRunEventRecorder = ({
  store,
  runId,
  conversationId,
  agentType,
  userMessageId,
  uiVisibility,
}: RunRecorderArgs) => {
  let seq = 0;
  const nextSeq = () => ++seq;

  return {
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
      return {
        runId,
        agentType,
        seq,
        chunk,
        userMessageId,
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordReasoning(chunk: string): RuntimeReasoningEvent {
      const seq = nextSeq();
      return {
        runId,
        agentType,
        seq,
        chunk,
        userMessageId,
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },

    recordStatus(statusText: string): RuntimeStatusEvent {
      const seq = nextSeq();
      return {
        runId,
        agentType,
        seq,
        statusState: "running",
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
      return {
        runId,
        agentType,
        seq,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        resultPreview,
        ...(args.details !== undefined ? { details: args.details } : {}),
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
        userMessageId,
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
        userMessageId,
        reason,
        ...(uiVisibility ? { uiVisibility } : {}),
      };
    },
  };
};

const emitHook = <E extends "turn_start" | "turn_end">(
  hookEmitter: HookEmitter | undefined,
  event: E,
  payload: HookEventMap[E]["payload"],
  agentType: string,
) => {
  if (!hookEmitter) {
    return;
  }

  void hookEmitter
    .emit(event, payload, { agentType })
    .catch(() => undefined);
};

const extractToolUpdateStatusText = (event: Extract<AgentEvent, { type: "tool_execution_update" }>): string | undefined => {
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
  return firstTextBlock?.type === "text" ? firstTextBlock.text.trim() : undefined;
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
}) => {
  const emittedThinkingLengths = new Map<number, number>();

  return agent.subscribe((event) => {

    if (event.type === "message_end" && threadStore && threadKey) {
      const payload = toPersistedThreadPayload(event.message);
      if (payload && payload.role !== "user") {
        persistThreadPayloadMessage(threadStore, {
          threadKey,
          payload,
        });
      }
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const chunk = event.assistantMessageEvent.delta;
      if (!chunk) {
        return;
      }
      const streamEvent = recorder.recordStream(chunk);
      onProgress?.(chunk);
      callbacks?.onStream?.(streamEvent);
      return;
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "thinking_delta"
    ) {
      const chunk = event.assistantMessageEvent.delta;
      if (!chunk) {
        return;
      }
      const previousLength =
        emittedThinkingLengths.get(event.assistantMessageEvent.contentIndex) ?? 0;
      emittedThinkingLengths.set(
        event.assistantMessageEvent.contentIndex,
        previousLength + chunk.length,
      );
      callbacks?.onReasoning?.(recorder.recordReasoning(chunk));
      return;
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "thinking_end"
    ) {
      const { contentIndex, content } = event.assistantMessageEvent;
      if (!content) {
        return;
      }
      const alreadyEmittedLength = emittedThinkingLengths.get(contentIndex) ?? 0;
      const remaining = content.slice(alreadyEmittedLength);
      if (!remaining) {
        return;
      }
      emittedThinkingLengths.set(contentIndex, content.length);
      callbacks?.onReasoning?.(recorder.recordReasoning(remaining));
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
      return;
    }

    if (event.type === "tool_execution_update") {
      const statusText = extractToolUpdateStatusText(event);
      if (!statusText) {
        return;
      }
      callbacks?.onStatus?.(recorder.recordStatus(statusText));
      return;
    }

    if (event.type === "turn_start") {
      emitHook(
        hookEmitter,
        "turn_start",
        {
          agentType,
          messageCount: agent.state.messages.length,
        },
        agentType,
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
        { agentType, assistantText: turnText },
        agentType,
      );
    }
  });
};

const toPersistedThreadPayload = (
  message: AgentMessage,
): PersistedRuntimeThreadPayload | null => {
  if (message.role === "assistant") {
    const sanitizedContent: PersistedAssistantContent = [];
    for (const block of message.content) {
      if (block.type !== "text") {
        sanitizedContent.push(block);
        continue;
      }
      const sanitized = sanitizeAssistantText(block.text);
      if (sanitized) {
        sanitizedContent.push({ ...block, text: sanitized });
      }
    }
    if (sanitizedContent.length === 0) {
      return null;
    }
    return {
      ...message,
      content: sanitizedContent,
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
  return null;
};
