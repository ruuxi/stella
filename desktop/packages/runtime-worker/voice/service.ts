import {
  AGENT_STREAM_EVENT_TYPES,
  type AgentStreamEventType,
} from "../../../src/shared/contracts/agent-runtime.js";
import type {
  RuntimeAgentEventPayload,
  RuntimeVoiceAgentEventPayload,
  RuntimeVoiceChatPayload,
  RuntimeVoiceHmrStatePayload,
  RuntimeWebSearchResult,
} from "../../runtime-protocol/index.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "../../runtime-kernel/agent-runtime.js";
import { createSelfModHmrState } from "../../runtime-kernel/runner/shared.js";
import type { TaskLifecycleEvent } from "../../runtime-kernel/tasks/local-task-manager.js";
import type { SelfModHmrState } from "../../boundary-contracts/index.js";

type VoiceRunner = {
  handleLocalChat: (
    payload: {
      conversationId: string;
      userMessageId: string;
      userPrompt: string;
      agentType?: string;
      storageMode?: "cloud" | "local";
    },
    callbacks: {
      onStream: (event: RuntimeStreamEvent) => void;
      onToolStart: (event: RuntimeToolStartEvent) => void;
      onToolEnd: (event: RuntimeToolEndEvent) => void;
      onError: (event: RuntimeErrorEvent) => void;
      onEnd: (event: RuntimeEndEvent) => void;
      onTaskEvent?: (event: TaskLifecycleEvent) => void;
      onSelfModHmrState?: (state: SelfModHmrState) => void;
      onHmrResume?: (args: {
        runId: string;
        resumeHmr: () => Promise<void>;
        reportState?: (state: SelfModHmrState) => void;
        requiresFullReload: boolean;
      }) => Promise<void>;
    },
  ) => Promise<{ runId: string }>;
  appendThreadMessage: (args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) => void;
  webSearch: (
    query: string,
    options?: { category?: string; displayResults?: boolean },
  ) => Promise<RuntimeWebSearchResult>;
};

type PendingVoiceRequest = {
  payload: RuntimeVoiceChatPayload;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type VoiceRuntimeServiceOptions = {
  getRunner: () => VoiceRunner | null;
  emitAgentEvent: (payload: RuntimeVoiceAgentEventPayload) => void;
  emitSelfModHmrState: (payload: RuntimeVoiceHmrStatePayload) => void;
  requestHostHmrTransition: (payload: {
    runId: string;
    requiresFullReload: boolean;
  }) => Promise<void>;
};

const normalizeError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error ?? "Unknown voice runtime error"));

export class VoiceRuntimeService {
  private pendingVoiceRequest: PendingVoiceRequest | null = null;
  private voiceRequestActive = false;

  constructor(private readonly options: VoiceRuntimeServiceOptions) {}

  persistTranscript(payload: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
  }) {
    this.ensureRunner().appendThreadMessage({
      threadKey: payload.conversationId,
      role: payload.role,
      content: payload.text,
    });
    return { ok: true as const };
  }

  async webSearch(payload: {
    query: string;
    category?: string;
  }) {
    return await this.ensureRunner().webSearch(payload.query, {
      category: payload.category,
      displayResults: true,
    });
  }

  async orchestratorChat(payload: RuntimeVoiceChatPayload) {
    if (this.voiceRequestActive) {
      if (this.pendingVoiceRequest) {
        this.pendingVoiceRequest.reject(
          new Error("Superseded by newer voice request"),
        );
      }
      return await new Promise<string>((resolve, reject) => {
        this.pendingVoiceRequest = { payload, resolve, reject };
      });
    }

    this.voiceRequestActive = true;
    try {
      return await this.executeVoiceChat(payload);
    } finally {
      await this.drainVoiceQueue();
    }
  }

  private ensureRunner() {
    const runner = this.options.getRunner();
    if (!runner) {
      throw new Error("Stella runtime not initialized");
    }
    return runner;
  }

  private async drainVoiceQueue() {
    const pending = this.pendingVoiceRequest;
    this.pendingVoiceRequest = null;

    if (!pending) {
      this.voiceRequestActive = false;
      return;
    }

    try {
      pending.resolve(await this.executeVoiceChat(pending.payload));
    } catch (error) {
      pending.reject(normalizeError(error));
    } finally {
      await this.drainVoiceQueue();
    }
  }

  private async executeVoiceChat(payload: RuntimeVoiceChatPayload) {
    const runner = this.ensureRunner();
    let activeRunId = "";
    let handleLocalChatPromise:
      | Promise<{ runId: string } | undefined>
      | null = null;
    let fullText = "";
    let syntheticSeq = 1;
    let settled = false;

    const resolveOnce = (resolve: (value: string) => void, value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const rejectOnce = (reject: (error: Error) => void, error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(normalizeError(error));
    };

    const ensureActiveRunId = async () => {
      if (activeRunId) {
        return activeRunId;
      }
      if (!handleLocalChatPromise) {
        return undefined;
      }
      const result = await handleLocalChatPromise;
      if (!result) {
        return undefined;
      }
      activeRunId = result.runId;
      return activeRunId;
    };

    return await new Promise<string>((resolve, reject) => {
      const emitAgentEvent = (
        event: Omit<RuntimeAgentEventPayload, "type">,
        type: AgentStreamEventType,
      ) => {
        this.options.emitAgentEvent({
          requestId: payload.requestId,
          event: {
            ...event,
            type,
          },
        });
      };

      handleLocalChatPromise = runner
        .handleLocalChat(
          {
            conversationId: payload.conversationId,
            userMessageId: `voice-${Date.now()}`,
            userPrompt: payload.message,
            agentType: "orchestrator",
            storageMode: "local",
          },
          {
            onStream: (event) => {
              if (event.chunk) {
                fullText += event.chunk;
              }
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.STREAM);
            },
            onToolStart: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.TOOL_START),
            onToolEnd: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.TOOL_END),
            onTaskEvent: (event) => {
              this.options.emitAgentEvent({
                requestId: payload.requestId,
                event: {
                  type: event.type,
                  runId: event.rootRunId ?? activeRunId ?? payload.conversationId,
                  seq: syntheticSeq++,
                  taskId: event.taskId,
                  agentType: event.agentType,
                  description: event.description,
                  parentTaskId: event.parentTaskId,
                  result: event.result,
                  error: event.error,
                  statusText: event.statusText,
                },
              });
            },
            onSelfModHmrState: (state) => {
              this.options.emitSelfModHmrState({
                requestId: payload.requestId,
                runId: activeRunId || undefined,
                state,
              });
            },
            onHmrResume: async ({ runId, requiresFullReload, reportState }) => {
              activeRunId = runId;
              reportState?.(
                createSelfModHmrState(
                  requiresFullReload ? "reloading" : "applying",
                  false,
                  requiresFullReload,
                ),
              );
              await this.options.requestHostHmrTransition({
                runId,
                requiresFullReload,
              });
              reportState?.(createSelfModHmrState("idle", false));
            },
            onEnd: (event) => {
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.END);
              resolveOnce(resolve, (event.finalText ?? fullText) || "Done.");
            },
            onError: (event) => {
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.ERROR);
              rejectOnce(reject, event.error ?? "Unknown voice runtime error");
            },
          },
        )
        .then(({ runId }) => {
          activeRunId = runId;
          return { runId };
        })
        .catch((error) => {
          rejectOnce(reject, error);
          return undefined;
        });
    });
  }
}
