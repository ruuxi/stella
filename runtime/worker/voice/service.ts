import {
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  type AgentStreamEventType,
} from "../../contracts/agent-runtime.js";
import { prepareStoredLocalChatPayload } from "../../kernel/storage/local-chat-payload.js";
import type { MessageMetadata } from "../../contracts/local-chat.js";
import type {
  RuntimeAgentEventPayload,
  RuntimePromptMessage,
  RuntimeVoiceAgentEventPayload,
  RuntimeVoiceChatPayload,
  RuntimeVoiceHmrStatePayload,
  RuntimeVoiceOrchestratorConfig,
  RuntimeVoiceOrchestratorConfigRequest,
  RuntimeVoiceToolCallPayload,
  RuntimeVoiceToolCallResult,
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
import type { ToolContext, ToolResult } from "../../kernel/tools/types.js";
import { textFromUnknown } from "../../kernel/agent-runtime/shared.js";
import {
  sanitizeToolError,
  sanitizeToolResult,
  sanitizeToolVisibleText,
} from "../../kernel/tools/safety.js";

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
  notifyOrchestratorHistoryChanged: (conversationId: string) => void;
  getVoiceOrchestratorConfig: (
    payload: RuntimeVoiceOrchestratorConfigRequest,
  ) => Promise<RuntimeVoiceOrchestratorConfig>;
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
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

type VoiceToolCatalogCacheEntry = {
  config: RuntimeVoiceOrchestratorConfig;
  cachedAt: number;
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

const VOICE_TOOL_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS = 30_000;
const THREAD_VISIBLE_JSON_MAX_CHARS = 12_000;

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...(truncated)`;

const stringifyBounded = (value: unknown, maxChars: number): string => {
  if (typeof value === "string") return truncate(value.trim(), maxChars);
  try {
    return truncate(JSON.stringify(value), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
};

const formatModelVisibleToolOutput = (result: ToolResult): string => {
  if (result.error) {
    return `Error: ${sanitizeToolError(result.error)}`;
  }
  return sanitizeToolVisibleText(
    truncate(textFromUnknown(sanitizeToolResult(result.result)), MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS),
  );
};

const asObjectRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export class VoiceRuntimeService {
  private pendingVoiceRequest: PendingVoiceRequest | null = null;
  private voiceRequestActive = false;
  private toolConfigCache = new Map<string, VoiceToolCatalogCacheEntry>();

  constructor(private readonly options: VoiceRuntimeServiceOptions) {}

  persistTranscript(payload: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
    uiVisibility?: "visible" | "hidden";
    voiceSession?: { durationMs: number };
  }) {
    this.ensureRunner().appendThreadMessage({
      threadKey: payload.conversationId,
      role: payload.role,
      content: payload.text,
    });
    this.ensureRunner().notifyOrchestratorHistoryChanged(
      payload.conversationId,
    );
    const chatStore = this.options.getChatStore();
    if (chatStore) {
      const timestamp = Date.now();
      const type = payload.role === "user" ? "user_message" : "assistant_message";
      const metadata: MessageMetadata = {};
      if (payload.uiVisibility) {
        metadata.ui = { visibility: payload.uiVisibility };
      }
      if (payload.voiceSession) {
        metadata.voiceSession = { durationMs: payload.voiceSession.durationMs };
      }
      const hasMetadata = Object.keys(metadata).length > 0;
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
            ...(hasMetadata ? { metadata } : {}),
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

  async getOrchestratorConfig(
    payload: RuntimeVoiceOrchestratorConfigRequest,
  ): Promise<RuntimeVoiceOrchestratorConfig> {
    const config = await this.ensureRunner().getVoiceOrchestratorConfig(
      payload,
    );
    this.toolConfigCache.set(payload.conversationId, {
      config,
      cachedAt: Date.now(),
    });
    return config;
  }

  async executeTool(
    payload: RuntimeVoiceToolCallPayload,
  ): Promise<RuntimeVoiceToolCallResult> {
    const runner = this.ensureRunner();
    const config = await this.resolveToolConfig(payload.conversationId);
    const allowedToolNames = config.tools.map((tool) => tool.name);
    const allowed = new Set(allowedToolNames);
    const runId = payload.requestId || `voice:${payload.callId}`;

    this.recordVoiceToolRequest(payload);

    let result: ToolResult;
    if (!allowed.has(payload.name)) {
      result = {
        error: `${payload.name} is not available to the voice orchestrator.`,
      };
    } else {
      result = await runner.executeTool(
        payload.name,
        payload.args,
        {
          conversationId: payload.conversationId,
          deviceId: this.options.getDeviceId() ?? "unknown",
          requestId: payload.callId,
          runId,
          rootRunId: runId,
          agentType: "orchestrator",
          storageMode: "local",
          allowedToolNames,
        },
      );
    }

    const output = formatModelVisibleToolOutput(result);
    this.recordVoiceToolResult(payload, result, output);
    const details = sanitizeToolResult(result.details ?? result.result);
    return {
      output,
      details,
      ...(result.fileChanges?.length
        ? { fileChanges: result.fileChanges }
        : {}),
      ...(result.producedFiles?.length
        ? { producedFiles: result.producedFiles }
        : {}),
      ...(result.error ? { error: sanitizeToolError(result.error) } : {}),
    };
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

  private async resolveToolConfig(
    conversationId: string,
  ): Promise<RuntimeVoiceOrchestratorConfig> {
    const cached = this.toolConfigCache.get(conversationId);
    if (
      cached &&
      Date.now() - cached.cachedAt < VOICE_TOOL_CONFIG_CACHE_TTL_MS
    ) {
      return cached.config;
    }
    return await this.getOrchestratorConfig({ conversationId });
  }

  private appendLocalToolEvent(args: {
    conversationId: string;
    type: "tool_request" | "tool_result";
    requestId: string;
    payload: Record<string, unknown>;
  }) {
    const chatStore = this.options.getChatStore();
    if (!chatStore) return;
    chatStore.appendEvent({
      conversationId: args.conversationId,
      type: args.type,
      requestId: args.requestId,
      timestamp: Date.now(),
      payload: {
        ...args.payload,
        source: "voice",
        requestId: args.requestId,
      },
    });
    this.options.onLocalChatUpdated();
  }

  private recordVoiceToolRequest(payload: RuntimeVoiceToolCallPayload) {
    const runner = this.ensureRunner();
    runner.appendThreadMessage({
      threadKey: payload.conversationId,
      role: "assistant",
      content: [
        `[Tool call] ${payload.name}`,
        `request_id: ${payload.callId}`,
        `args: ${stringifyBounded(payload.args, THREAD_VISIBLE_JSON_MAX_CHARS)}`,
      ].join("\n"),
    });
    runner.notifyOrchestratorHistoryChanged(payload.conversationId);
    this.appendLocalToolEvent({
      conversationId: payload.conversationId,
      type: "tool_request",
      requestId: payload.callId,
      payload: {
        toolName: payload.name,
        args: payload.args,
      },
    });
  }

  private recordVoiceToolResult(
    payload: RuntimeVoiceToolCallPayload,
    result: ToolResult,
    output: string,
  ) {
    const runner = this.ensureRunner();
    const details = sanitizeToolResult(result.details ?? result.result);
    const detailRecord = asObjectRecord(details);
    const content = result.error
      ? [
          `[Tool result] ${payload.name}`,
          `request_id: ${payload.callId}`,
          `error: ${sanitizeToolError(result.error)}`,
        ].join("\n")
      : [
          `[Tool result] ${payload.name}`,
          `request_id: ${payload.callId}`,
          `result: ${stringifyBounded(output, THREAD_VISIBLE_JSON_MAX_CHARS)}`,
        ].join("\n");
    runner.appendThreadMessage({
      threadKey: payload.conversationId,
      role: "user",
      content,
    });
    runner.notifyOrchestratorHistoryChanged(payload.conversationId);
    this.appendLocalToolEvent({
      conversationId: payload.conversationId,
      type: "tool_result",
      requestId: payload.callId,
      payload: {
        toolName: payload.name,
        result: detailRecord ?? details ?? output,
        resultPreview: output,
        ...(detailRecord ? { details: detailRecord, ...detailRecord } : {}),
        ...(result.fileChanges?.length
          ? { fileChanges: result.fileChanges }
          : {}),
        ...(result.producedFiles?.length
          ? { producedFiles: result.producedFiles }
          : {}),
        agentType: "orchestrator",
        ...(result.error
          ? { error: sanitizeToolError(result.error) }
          : {}),
      },
    });
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
