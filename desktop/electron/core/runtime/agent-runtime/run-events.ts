import { RUNTIME_RUN_EVENT_TYPES } from "../../../../src/shared/contracts/agent-runtime.js";
import type { AgentEvent, AgentMessage } from "../../agent/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { HookEventMap } from "../extensions/types.js";
import type { RuntimeStore } from "../../../storage/runtime-store.js";
import {
  extractAssistantText,
  getToolResultPreview,
  now,
} from "./shared.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeRunCallbacks,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
  SelfModAppliedPayload,
} from "./types.js";

const logger = createRuntimeLogger("agent-runtime.events");

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
};

export type RuntimeRunEventRecorder = ReturnType<typeof createRunEventRecorder>;

export const createRunEventRecorder = ({
  store,
  runId,
  conversationId,
  agentType,
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
      };
    },

    recordToolEnd(args: {
      toolCallId: string;
      toolName: string;
      result: unknown;
    }): RuntimeToolEndEvent {
      const resultPreview = getToolResultPreview(args.toolName, args.result);
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
      };
    },

    recordRunEnd(args: {
      finalText: string;
      selfModApplied?: SelfModAppliedPayload;
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
        finalText: args.finalText,
        persisted: true,
        ...(args.selfModApplied ? { selfModApplied: args.selfModApplied } : {}),
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

export const subscribeRuntimeAgentEvents = ({
  agent,
  runId,
  agentType,
  recorder,
  callbacks,
  onProgress,
  displayEventHandler,
  hookEmitter,
}: {
  agent: RuntimeAgentLike;
  runId: string;
  agentType: string;
  recorder: RuntimeRunEventRecorder;
  callbacks?: Partial<RuntimeRunCallbacks>;
  onProgress?: (chunk: string) => void;
  displayEventHandler?: (event: AgentEvent) => boolean;
  hookEmitter?: HookEmitter;
}) =>
  agent.subscribe((event) => {
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
