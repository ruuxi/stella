import {
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  type AgentStreamEventType,
} from "../../../desktop/src/shared/contracts/agent-runtime.js";
import { prepareStoredLocalChatPayload } from "../../kernel/storage/local-chat-payload.js";
import type {
  RuntimeAgentEventPayload,
  RuntimePromptMessage,
  RuntimeVoiceAgentEventPayload,
  RuntimeVoiceChatPayload,
  RuntimeVoiceHmrStatePayload,
  RuntimeWebSearchResult,
} from "../../protocol/index.js";
import type {
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeStatusEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "../../kernel/agent-runtime.js";
import type { AgentLifecycleEvent } from "../../kernel/agents/local-agent-manager.js";
import type { SelfModHmrState } from "../../contracts/index.js";
import type { ChatStore } from "../../kernel/storage/chat-store.js";

type VoiceRunner = {
  handleLocalChat: (
    payload: {
      conversationId: string;
      userMessageId: string;
      userPrompt: string;
      promptMessages?: RuntimePromptMessage[];
      agentType?: string;
      storageMode?: "cloud" | "local";
    },
    callbacks: {
      onStream: (event: RuntimeStreamEvent) => void;
      onStatus?: (event: RuntimeStatusEvent) => void;
      onToolStart: (event: RuntimeToolStartEvent) => void;
      onToolEnd: (event: RuntimeToolEndEvent) => void;
      onError: (event: RuntimeErrorEvent) => void;
      onEnd: (event: RuntimeEndEvent) => void;
      onAgentEvent?: (event: AgentLifecycleEvent) => void;
      onSelfModHmrState?: (state: SelfModHmrState) => void;
    },
  ) => Promise<{ runId: string }>;
  appendThreadMessage: (args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) => void;
  webSearch: (
    query: string,
    options?: { category?: string },
  ) => Promise<RuntimeWebSearchResult>;
};

type PendingVoiceRequest = {
  payload: RuntimeVoiceChatPayload;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type VoiceRuntimeServiceOptions = {
  getRunner: () => VoiceRunner | null;
  getChatStore: () => ChatStore | null;
  getDeviceId: () => string | null;
  onLocalChatUpdated: () => void;
  emitAgentEvent: (payload: RuntimeVoiceAgentEventPayload) => void;
  emitSelfModHmrState: (payload: RuntimeVoiceHmrStatePayload) => void;
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
    uiVisibility?: "visible" | "hidden";
  }) {
    this.ensureRunner().appendThreadMessage({
      threadKey: payload.conversationId,
      role: payload.role,
      content: payload.text,
    });
    const chatStore = this.options.getChatStore();
    if (chatStore) {
      const timestamp = Date.now();
      const type = payload.role === "user" ? "user_message" : "assistant_message";
      chatStore.appendEvent({
        conversationId: payload.conversationId,
        type,
        ...(payload.role === "user" && this.options.getDeviceId()
          ? { deviceId: this.options.getDeviceId() ?? undefined }
          : {}),
        timestamp,
        payload: prepareStoredLocalChatPayload({
          type,
          payload: {
            text: payload.text,
            source: "voice",
            ...(payload.uiVisibility
              ? {
                  metadata: {
                    ui: {
                      visibility: payload.uiVisibility,
                    },
                  },
                }
              : {}),
          },
          timestamp,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
        }),
      });
      this.options.onLocalChatUpdated();
    }
    return { ok: true as const };
  }

  async webSearch(payload: {
    query: string;
    category?: string;
  }) {
    return await this.ensureRunner().webSearch(payload.query, {
      category: payload.category,
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

  isBusy() {
    return this.voiceRequestActive;
  }

  getPendingRequestCount() {
    return this.pendingVoiceRequest ? 1 : 0;
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

    const promptMessages = [
      {
        text: [
          "The user is using Stella's live voice agent feature.",
          'Do the requested work normally. When the work is genuinely complete, call voice_result with status "completed" and a concise message for the voice agent to tell the user.',
          'If the work fails or cannot be completed, call voice_result with status "failed" and a concise explanation.',
          "Do not call voice_result just because you started work or delegated to a background agent; wait for a real terminal result.",
        ].join("\n"),
        uiVisibility: "hidden" as const,
        messageType: "message" as const,
        customType: "runtime.voice_action_completion_instruction",
        display: false,
      },
    ];

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

      runner
        .handleLocalChat(
          {
            conversationId: payload.conversationId,
            userMessageId: `voice-${Date.now()}`,
            userPrompt: payload.message,
            ...(promptMessages ? { promptMessages } : {}),
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
            onStatus: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.STATUS),
            onToolStart: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.TOOL_START),
            onToolEnd: (event) =>
              emitAgentEvent(event, AGENT_STREAM_EVENT_TYPES.TOOL_END),
            onAgentEvent: (event) => {
              this.options.emitAgentEvent({
                requestId: payload.requestId,
                event: {
                  type: event.type,
                  runId: event.rootRunId ?? activeRunId ?? payload.conversationId,
                  seq: syntheticSeq++,
                  agentId: event.agentId,
                  agentType: event.agentType,
                  description: event.description,
                  parentAgentId: event.parentAgentId,
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
            onEnd: (event) => {
              this.options.emitAgentEvent({
                requestId: payload.requestId,
                event: {
                  ...event,
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
                },
              });
              resolveOnce(resolve, (event.finalText ?? fullText) || "Done.");
            },
            onError: (event) => {
              this.options.emitAgentEvent({
                requestId: payload.requestId,
                event: {
                  ...event,
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
                  reason: event.error,
                },
              });
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
