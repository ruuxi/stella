import crypto from "crypto";
import { Type } from "@sinclair/typebox";
import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { DEVICE_TOOL_NAMES, TOOL_DESCRIPTIONS } from "@stella/shared";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "./extensions/stella/claude_code_session_runtime.js";
import {
  runCodexAppServerTurn,
  shutdownCodexAppServerRuntime,
} from "./extensions/stella/codex_app_server_runtime.js";
import type { LocalTaskManagerAgentContext } from "./extensions/stella/local_task_manager.js";
import { localActivateSkill, localNoResponse, localWebFetch } from "./extensions/stella/local_tool_overrides.js";
import type { ToolContext, ToolResult } from "./extensions/stella/tools-types.js";
import { JsonlRuntimeStore } from "./jsonl_store.js";

const DEFAULT_MODEL = "openai/gpt-4.1-mini";
const DEFAULT_MAX_TURNS = 40;
const MAX_RESULT_PREVIEW = 200;

const PI_LOCAL_TOOLS = [
  ...DEVICE_TOOL_NAMES,
  "Task",
  "TaskCreate",
  "TaskCancel",
  "TaskOutput",
  "WebFetch",
  "ActivateSkill",
  "NoResponse",
  "SaveMemory",
  "RecallMemories",
] as const;

const AnyToolArgsSchema = Type.Object({}, { additionalProperties: true });

export type PiStreamEvent = {
  runId: string;
  seq: number;
  chunk: string;
};

export type PiToolStartEvent = {
  runId: string;
  seq: number;
  toolCallId: string;
  toolName: string;
};

export type PiToolEndEvent = {
  runId: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  resultPreview: string;
};

export type PiErrorEvent = {
  runId: string;
  seq: number;
  error: string;
  fatal: boolean;
};

export type PiEndEvent = {
  runId: string;
  seq: number;
  finalText: string;
  persisted: boolean;
};

export type PiRunCallbacks = {
  onStream: (event: PiStreamEvent) => void;
  onToolStart: (event: PiToolStartEvent) => void;
  onToolEnd: (event: PiToolEndEvent) => void;
  onError: (event: PiErrorEvent) => void;
  onEnd: (event: PiEndEvent) => void;
};

type BaseRunOptions = {
  runId?: string;
  conversationId: string;
  userMessageId: string;
  agentType: string;
  userPrompt: string;
  localHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  agentContext: LocalTaskManagerAgentContext;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
  deviceId: string;
  stellaHome: string;
  proxyBaseUrl: string;
  proxyToken: string;
  store: JsonlRuntimeStore;
  abortSignal?: AbortSignal;
};

type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: PiRunCallbacks;
};

type SubagentRunOptions = BaseRunOptions & {
  onProgress?: (chunk: string) => void;
};

const now = () => Date.now();

const parseModel = (rawModel: string | undefined): { provider: string; modelId: string } => {
  const value = (rawModel ?? DEFAULT_MODEL).trim();
  if (!value.includes("/")) {
    return { provider: "openai", modelId: value || "gpt-4.1-mini" };
  }
  const parts = value.split("/");
  const provider = parts.shift() || "openai";
  const modelId = parts.join("/") || "gpt-4.1-mini";
  return { provider, modelId };
};

const createProxyModel = (
  modelName: string | undefined,
  proxyBaseUrl: string,
  proxyToken: string,
): Model<"openai-completions"> => {
  const { provider, modelId } = parseModel(modelName);
  const baseUrl = proxyBaseUrl.replace(/\/+$/, "");

  return {
    id: modelId,
    name: `${provider}/${modelId}`,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 256_000,
    maxTokens: 16_384,
    headers: {
      "X-Proxy-Token": proxyToken,
      "X-Provider": provider,
      "X-Model-Id": modelId,
    },
    compat: {
      supportsStrictMode: false,
    },
  };
};

const toAgentMessages = (
  history: Array<{ role: "user" | "assistant"; content: string }>,
): AgentMessage[] => {
  const usage = {
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

  return history
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => {
      if (entry.role === "user") {
        return {
          role: "user" as const,
          content: [{ type: "text" as const, text: entry.content }],
          timestamp: now(),
        };
      }

      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: entry.content }],
        api: "openai-completions" as const,
        provider: "openai",
        model: "history",
        usage,
        stopReason: "stop" as const,
        timestamp: now(),
      };
    });
};

const textFromUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractAssistantText = (message: AgentMessage | undefined): string => {
  if (!message || message.role !== "assistant") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
};

const buildSystemPrompt = (context: LocalTaskManagerAgentContext): string => {
  const sections = [context.systemPrompt.trim()];

  if (context.dynamicContext?.trim()) {
    sections.push(context.dynamicContext.trim());
  }

  if (context.coreMemory?.trim()) {
    sections.push(`Core memory:\n${context.coreMemory.trim()}`);
  }

  return sections.filter(Boolean).join("\n\n");
};

const getRecallQuery = (args: Record<string, unknown>): string => {
  const direct = typeof args.query === "string" ? args.query : "";
  if (direct.trim()) return direct;
  const fallback = typeof args.prompt === "string" ? args.prompt : "";
  return fallback;
};

const getSaveMemoryText = (args: Record<string, unknown>): string => {
  const direct = typeof args.content === "string" ? args.content : "";
  if (direct.trim()) return direct;
  const fallback = typeof args.text === "string" ? args.text : "";
  return fallback;
};

const formatToolResult = (toolResult: ToolResult): { text: string; details: unknown } => {
  if (toolResult.error) {
    return {
      text: `Error: ${toolResult.error}`,
      details: { error: toolResult.error },
    };
  }

  return {
    text: textFromUnknown(toolResult.result),
    details: toolResult.result,
  };
};

const createPiTools = (opts: {
  runId: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  stellaHome: string;
  toolsAllowlist?: string[];
  store: JsonlRuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
}): AgentTool[] => {
  const requested = Array.isArray(opts.toolsAllowlist) && opts.toolsAllowlist.length > 0
    ? opts.toolsAllowlist
    : [...PI_LOCAL_TOOLS];

  const uniqueToolNames = Array.from(new Set(requested));

  return uniqueToolNames.map((toolName) => ({
    name: toolName,
    label: toolName,
    description: TOOL_DESCRIPTIONS[toolName] ?? `${toolName} tool`,
    parameters: AnyToolArgsSchema,
    execute: async (toolCallId, params) => {
      const args = (params as Record<string, unknown>) ?? {};

      if (toolName === "WebFetch") {
        const url = typeof args.url === "string" ? args.url : "";
        const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
        const text = await localWebFetch({ url, prompt });
        return { content: [{ type: "text", text }], details: { text } };
      }

      if (toolName === "ActivateSkill") {
        const skillId =
          (typeof args.skillId === "string" ? args.skillId : undefined) ??
          (typeof args.skill_id === "string" ? args.skill_id : "");
        const text = await localActivateSkill({ skillId, stellaHome: opts.stellaHome });
        return { content: [{ type: "text", text }], details: { text } };
      }

      if (toolName === "NoResponse") {
        const text = await localNoResponse();
        return { content: [{ type: "text", text }], details: { text } };
      }

      if (toolName === "SaveMemory") {
        const content = getSaveMemoryText(args);
        const tags = Array.isArray(args.tags)
          ? args.tags.filter((entry): entry is string => typeof entry === "string")
          : undefined;
        opts.store.saveMemory({
          conversationId: opts.conversationId,
          content,
          ...(tags && tags.length > 0 ? { tags } : {}),
        });
        const text = content.trim()
          ? "Saved memory entry."
          : "No memory content provided.";
        return { content: [{ type: "text", text }], details: { ok: true } };
      }

      if (toolName === "RecallMemories") {
        const query = getRecallQuery(args);
        const requestedLimit = typeof args.limit === "number" ? args.limit : undefined;
        const rows = opts.store.recallMemories({ query, ...(requestedLimit ? { limit: requestedLimit } : {}) });
        const text = rows.length > 0
          ? rows.map((row, index) => `${index + 1}. ${row.content}`).join("\n")
          : "No matching memories found.";
        return { content: [{ type: "text", text }], details: { rows } };
      }

      const context: ToolContext = {
        conversationId: opts.conversationId,
        deviceId: opts.deviceId,
        requestId: toolCallId,
        agentType: opts.agentType,
        storageMode: "local",
      };

      const toolResult = await opts.toolExecutor(toolName, args, context);
      const formatted = formatToolResult(toolResult);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: formatted.details,
      };
    },
  }));
};

export async function runPiOrchestratorTurn(opts: OrchestratorRunOptions): Promise<string> {
  const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
  let seq = 0;
  const nextSeq = () => ++seq;

  opts.store.recordRunEvent({
    timestamp: now(),
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    type: "run_start",
  });

  const historySource =
    opts.localHistory ??
    opts.agentContext.threadHistory
      ?.filter((entry): entry is { role: "user" | "assistant"; content: string } =>
        (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
      .map((entry) => ({ role: entry.role, content: entry.content })) ??
    [];

  const model = createProxyModel(opts.agentContext.model, opts.proxyBaseUrl, opts.proxyToken);
  const tools = createPiTools({
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(opts.agentContext),
      model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(historySource),
    },
    convertToLlm: (messages) => messages.filter((msg) =>
      msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult"),
    getApiKey: () => opts.proxyToken,
  });

  if (opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const chunk = event.assistantMessageEvent.delta;
      if (!chunk) return;
      const s = nextSeq();
      opts.callbacks.onStream({ runId, seq: s, chunk });
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: s,
        type: "stream",
        chunk,
      });
      return;
    }

    if (event.type === "tool_execution_start") {
      const s = nextSeq();
      opts.callbacks.onToolStart({
        runId,
        seq: s,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: s,
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const preview = textFromUnknown(event.result).slice(0, MAX_RESULT_PREVIEW);
      const s = nextSeq();
      opts.callbacks.onToolEnd({
        runId,
        seq: s,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultPreview: preview,
      });
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: s,
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultPreview: preview,
      });
    }
  });

  try {
    opts.store.appendThreadMessage({
      timestamp: now(),
      conversationId: opts.conversationId,
      role: "user",
      content: opts.userPrompt,
    });

    await agent.prompt({
      role: "user",
      content: [{ type: "text", text: opts.userPrompt }],
      timestamp: now(),
    });

    const latestAssistant = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const finalText = extractAssistantText(latestAssistant);

    if (finalText.trim()) {
      opts.store.appendThreadMessage({
        timestamp: now(),
        conversationId: opts.conversationId,
        role: "assistant",
        content: finalText,
      });
    }

    const endSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: endSeq,
      type: "run_end",
      finalText,
    });

    opts.callbacks.onEnd({
      runId,
      seq: endSeq,
      finalText,
      persisted: true,
    });

    return runId;
  } catch (error) {
    const errorMessage = (error as Error).message || "Pi runtime failed";
    const errSeq = nextSeq();

    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: errSeq,
      type: "error",
      error: errorMessage,
      fatal: true,
    });

    opts.callbacks.onError({
      runId,
      seq: errSeq,
      error: errorMessage,
      fatal: true,
    });
    throw error;
  } finally {
    unsubscribe();
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
}

export async function runPiSubagentTask(opts: SubagentRunOptions): Promise<{
  runId: string;
  result: string;
  error?: string;
}> {
  const runId = opts.runId ?? `local:sub:${crypto.randomUUID()}`;
  const prompt = opts.userPrompt.trim();

  if (opts.abortSignal?.aborted) {
    return { runId, result: "", error: "Aborted" };
  }

  const primaryModelId = opts.agentContext.model ?? DEFAULT_MODEL;
  const isGeneralAgent = opts.agentType === "general";
  const sessionKey = opts.agentContext.activeThreadId
    ? `${opts.conversationId}:${opts.agentContext.activeThreadId}`
    : `${opts.conversationId}:run:${runId}`;

  if (isGeneralAgent && opts.agentContext.generalAgentEngine === "codex_local") {
    try {
      const result = await runCodexAppServerTurn({
        runId,
        sessionKey,
        prompt,
        abortSignal: opts.abortSignal,
        onProgress: opts.onProgress,
        maxConcurrency: opts.agentContext.codexLocalMaxConcurrency,
      });
      return { runId, result: result.text };
    } catch (error) {
      return {
        runId,
        result: "",
        error: `Codex App Server execution failed: ${(error as Error).message || "Unknown error"}`,
      };
    }
  }

  if (
    isGeneralAgent &&
    (opts.agentContext.generalAgentEngine === "claude_code_local" || isClaudeCodeModel(primaryModelId))
  ) {
    try {
      const result = await runClaudeCodeTurn({
        runId,
        sessionKey,
        modelId: primaryModelId,
        prompt,
        abortSignal: opts.abortSignal,
        onProgress: opts.onProgress,
      });
      return { runId, result: result.text };
    } catch (error) {
      return {
        runId,
        result: "",
        error: `Claude Code execution failed: ${(error as Error).message || "Unknown error"}`,
      };
    }
  }

  const model = createProxyModel(opts.agentContext.model, opts.proxyBaseUrl, opts.proxyToken);
  const tools = createPiTools({
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
  });

  const contextHistory =
    opts.agentContext.threadHistory
      ?.filter((entry): entry is { role: "user" | "assistant"; content: string } =>
        (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
      .map((entry) => ({ role: entry.role, content: entry.content })) ??
    [];

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(opts.agentContext),
      model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(contextHistory),
    },
    convertToLlm: (messages) => messages.filter((msg) =>
      msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult"),
    getApiKey: () => opts.proxyToken,
  });

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const chunk = event.assistantMessageEvent.delta;
      if (chunk) {
        opts.onProgress?.(chunk);
      }
    }
  });

  try {
    await agent.prompt({
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: now(),
    });

    const latestAssistant = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const result = extractAssistantText(latestAssistant);

    return {
      runId,
      result,
    };
  } catch (error) {
    return {
      runId,
      result: "",
      error: (error as Error).message || "Subagent failed",
    };
  } finally {
    unsubscribe();
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
}

export const shutdownPiSubagentRuntimes = (): void => {
  shutdownCodexAppServerRuntime();
  shutdownClaudeCodeRuntime();
};

export const PI_RUNTIME_MAX_TURNS = DEFAULT_MAX_TURNS;
