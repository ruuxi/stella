import { prepareStoredLocalChatPayload } from "../../runtime-kernel/storage/local-chat-payload.js";
import {
  ORCHESTRATOR_DELEGATION_ALLOWLIST,
  ORCHESTRATOR_MAX_TASK_DEPTH,
} from "../../runtime-kernel/agents/core-agent-prompts.js";
import { dispatchLocalTool, type LocalToolStore } from "../../runtime-kernel/tools/local-tool-dispatch.js";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import type {
  RuntimeWebSearchResult,
} from "../../runtime-protocol/index.js";
import type { ChatStore } from "../../runtime-kernel/storage/chat-store.js";
import type { ToolContext, ToolResult } from "../../runtime-kernel/tools/types.js";

type VoiceRunner = {
  appendThreadMessage: (args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) => void;
  webSearch: (
    query: string,
    options?: { category?: string; displayResults?: boolean },
  ) => Promise<RuntimeWebSearchResult>;
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolContext: ToolContext,
  ) => Promise<ToolResult>;
};

type VoiceRuntimeServiceOptions = {
  getRunner: () => VoiceRunner | null;
  getChatStore: () => ChatStore | null;
  getRuntimeStore: () => LocalToolStore | null;
  getDeviceId: () => string | null;
  onLocalChatUpdated: () => void;
};

export class VoiceRuntimeService {
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
    const chatStore = this.options.getChatStore();
    if (chatStore) {
      const timestamp = Date.now();
      const type = payload.role === "user" ? "user_message" : "assistant_message";
      const deviceId = this.options.getDeviceId();
      chatStore.appendEvent({
        conversationId: payload.conversationId,
        type,
        ...(payload.role === "user" && deviceId ? { deviceId } : {}),
        timestamp,
        payload: prepareStoredLocalChatPayload({
          type,
          payload: {
            text: payload.text,
            source: "voice",
          },
          timestamp,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
        }),
      });
      this.options.onLocalChatUpdated();
    }
    return { ok: true as const };
  }

  async executeTool(payload: {
    toolName: string;
    toolArgs: Record<string, unknown>;
    conversationId: string;
    callId: string;
  }): Promise<{ result: string; error?: string }> {
    const runner = this.ensureRunner();
    const { toolName, toolArgs, conversationId, callId } = payload;

    try {
      const localResult = await dispatchLocalTool(toolName, toolArgs, {
        conversationId,
        webSearch: (query, opts) =>
          runner.webSearch(query, { ...opts, displayResults: true }),
        store: this.options.getRuntimeStore(),
      });
      if (localResult.handled) {
        return { result: localResult.text };
      }

      const toolContext = this.buildToolContext(conversationId, callId);
      const result = await runner.executeTool(toolName, toolArgs, toolContext);
      if (result.error) {
        return { result: "", error: result.error };
      }
      const text = typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result ?? "Done.");
      return { result: text };
    } catch (error) {
      return {
        result: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildToolContext(conversationId: string, callId: string) {
    return {
      conversationId,
      deviceId: this.options.getDeviceId() ?? "",
      requestId: callId,
      runId: `voice-${Date.now()}`,
      agentType: AGENT_IDS.ORCHESTRATOR,
      storageMode: "local" as const,
      taskDepth: 0,
      maxTaskDepth: ORCHESTRATOR_MAX_TASK_DEPTH,
      delegationAllowlist: ORCHESTRATOR_DELEGATION_ALLOWLIST,
    };
  }

  private ensureRunner() {
    const runner = this.options.getRunner();
    if (!runner) {
      throw new Error("Stella runtime not initialized");
    }
    return runner;
  }

}
