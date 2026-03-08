import crypto from "crypto";
import { Type } from "@sinclair/typebox";
import { Agent, type AgentMessage, type AgentTool } from "@stella/stella-agent-core";
import {
  DEVICE_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_JSON_SCHEMAS,
  localActivateSkill,
  localNoResponse,
  localWebFetch,
  type ToolContext,
  type ToolResult,
} from "./tools/index.js";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
  runCodexAppServerTurn,
  shutdownCodexAppServerRuntime,
} from "./integrations/index.js";
import type { LocalTaskManagerAgentContext } from "./tasks/index.js";
import { JsonlRuntimeStore } from "./jsonl_store.js";
import type { ResolvedLlmRoute } from "./model-routing.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "./thread-runtime.js";

const DEFAULT_MAX_TURNS = 40;
const MAX_RESULT_PREVIEW = 200;

const STELLA_LOCAL_TOOLS = [
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

export type SelfModAppliedPayload = {
  featureId: string;
  files: string[];
  batchIndex: number;
};

export type SelfModMonitor = {
  getBaselineHead: (repoRoot: string) => Promise<string | null>;
  detectAppliedSince: (args: {
    repoRoot: string;
    sinceHead: string | null;
  }) => Promise<SelfModAppliedPayload | null>;
};


export type RuntimeStreamEvent = {
  runId: string;
  seq: number;
  chunk: string;
};

export type RuntimeToolStartEvent = {
  runId: string;
  seq: number;
  toolCallId: string;
  toolName: string;
};

export type RuntimeToolEndEvent = {
  runId: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  resultPreview: string;
};

export type RuntimeErrorEvent = {
  runId: string;
  seq: number;
  error: string;
  fatal: boolean;
};

export type RuntimeEndEvent = {
  runId: string;
  seq: number;
  finalText: string;
  persisted: boolean;
  selfModApplied?: SelfModAppliedPayload;
};

export type RuntimeRunCallbacks = {
  onStream: (event: RuntimeStreamEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
};

type BaseRunOptions = {
  runId?: string;
  conversationId: string;
  userMessageId: string;
  agentType: string;
  userPrompt: string;
  agentContext: LocalTaskManagerAgentContext;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
  deviceId: string;
  stellaHome: string;
  resolvedLlm: ResolvedLlmRoute;
  store: JsonlRuntimeStore;
  abortSignal?: AbortSignal;
  frontendRoot?: string;
  selfModMonitor?: SelfModMonitor | null;
  webSearch?: (query: string) => Promise<{ text: string; results: Array<{ title: string; url: string; snippet: string }>; html?: string }>;
};

type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: RuntimeRunCallbacks;
};

type SubagentRunOptions = BaseRunOptions & {
  onProgress?: (chunk: string) => void;
  callbacks?: Partial<RuntimeRunCallbacks>;
};

const now = () => Date.now();

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
  webSearch?: (query: string) => Promise<{ text: string; results: Array<{ title: string; url: string; snippet: string }>; html?: string }>;
}): AgentTool[] => {
  const requested = Array.isArray(opts.toolsAllowlist) && opts.toolsAllowlist.length > 0
    ? opts.toolsAllowlist
    : [...STELLA_LOCAL_TOOLS];

  const uniqueToolNames = Array.from(new Set(requested));

  // Build a single AgentTool for a given name
  const buildTool = (toolName: string): AgentTool => ({
    name: toolName,
    label: toolName,
    description: TOOL_DESCRIPTIONS[toolName] ?? `${toolName} tool`,
    parameters: (TOOL_JSON_SCHEMAS[toolName] ?? AnyToolArgsSchema) as typeof AnyToolArgsSchema,
    execute: async (toolCallId, params) => {
      const args = (params as Record<string, unknown>) ?? {};

      if (toolName === "WebSearch") {
        const query = typeof args.query === "string" ? args.query : "";
        if (!opts.webSearch) {
          return { content: [{ type: "text", text: "WebSearch is not available." }], details: {} };
        }
        const { text } = await opts.webSearch(query);
        return { content: [{ type: "text", text }], details: { text } };
      }

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
  });

  return uniqueToolNames.map(buildTool);
};

export async function runOrchestratorTurn(opts: OrchestratorRunOptions): Promise<string> {
  const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
  const threadKey = buildRuntimeThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  let seq = 0;
  const nextSeq = () => ++seq;
  const baselineHead = opts.frontendRoot && opts.selfModMonitor
    ? await opts.selfModMonitor.getBaselineHead(opts.frontendRoot).catch(() => null)
    : null;

  console.log(`[stella:trace] orchestrator start | runId=${runId} | agent=${opts.agentType} | model=${opts.resolvedLlm.model} | convId=${opts.conversationId}`);
  console.log(`[stella:trace] user prompt: ${opts.userPrompt.slice(0, 300)}`);

  opts.store.recordRunEvent({
    timestamp: now(),
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    type: "run_start",
  });

  const historySource =
    opts.agentContext.threadHistory
      ?.filter((entry): entry is { role: "user" | "assistant"; content: string } =>
        (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
      .map((entry) => ({ role: entry.role, content: entry.content })) ??
    [];

  const tools = createPiTools({
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(opts.agentContext),
      model: opts.resolvedLlm.model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(historySource),
    },
    convertToLlm: (messages) => messages.filter((msg) =>
      msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult"),
    getApiKey: () => opts.resolvedLlm.getApiKey(),
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
      console.log(`[stella:trace] tool exec start | ${event.toolName} | callId=${event.toolCallId} | args=${JSON.stringify(event.args ?? {}).slice(0, 300)}`);
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
      console.log(`[stella:trace] tool exec end   | ${event.toolName} | callId=${event.toolCallId} | result=${preview.slice(0, 200)}`);
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
      conversationId: threadKey,
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
    console.log(`[stella:trace] orchestrator end | runId=${runId} | finalText=${finalText.slice(0, 300)}`);
    const selfModApplied = opts.frontendRoot && opts.selfModMonitor
      ? await opts.selfModMonitor.detectAppliedSince({
          repoRoot: opts.frontendRoot,
          sinceHead: baselineHead,
        }).catch(() => null)
      : null;

    if (finalText.trim()) {
      opts.store.appendThreadMessage({
        timestamp: now(),
        conversationId: threadKey,
        role: "assistant",
        content: finalText,
      });
      await maybeCompactRuntimeThread({
        store: opts.store,
        threadKey,
        resolvedLlm: opts.resolvedLlm,
        agentType: opts.agentType,
      }).catch(() => undefined);
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
      ...(selfModApplied ? { selfModApplied } : {}),
    });

    opts.callbacks.onEnd({
      runId,
      seq: endSeq,
      finalText,
      persisted: true,
      ...(selfModApplied ? { selfModApplied } : {}),
    });

    return runId;
  } catch (error) {
    const errorMessage = (error as Error).message || "Stella runtime failed";
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

export async function runSubagentTask(opts: SubagentRunOptions): Promise<{
  runId: string;
  result: string;
  error?: string;
}> {
  const runId = opts.runId ?? `local:sub:${crypto.randomUUID()}`;
  const prompt = opts.userPrompt.trim();
  const subagentThreadConversationId = buildRuntimeThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  let seq = 0;
  const nextSeq = () => ++seq;

  opts.store.recordRunEvent({
    timestamp: now(),
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    type: "run_start",
  });

  if (prompt) {
    opts.store.appendThreadMessage({
      timestamp: now(),
      conversationId: subagentThreadConversationId,
      role: "user",
      content: prompt,
    });
  }

  if (opts.abortSignal?.aborted) {
    const errSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: errSeq,
      type: "error",
      error: "Aborted",
      fatal: true,
    });
    return { runId, result: "", error: "Aborted" };
  }

  const primaryModelId = opts.agentContext.model;
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
        onProgress: (chunk) => {
          if (!chunk) return;
          opts.onProgress?.(chunk);
          const s = nextSeq();
          opts.store.recordRunEvent({
            timestamp: now(),
            runId,
            conversationId: opts.conversationId,
            agentType: opts.agentType,
            seq: s,
            type: "stream",
            chunk,
          });
        },
        maxConcurrency: opts.agentContext.codexLocalMaxConcurrency,
      });
      if (result.text.trim()) {
        opts.store.appendThreadMessage({
          timestamp: now(),
          conversationId: subagentThreadConversationId,
          role: "assistant",
          content: result.text,
        });
        await maybeCompactRuntimeThread({
          store: opts.store,
          threadKey: subagentThreadConversationId,
          resolvedLlm: opts.resolvedLlm,
          agentType: opts.agentType,
        }).catch(() => undefined);
      }
      const endSeq = nextSeq();
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: endSeq,
        type: "run_end",
        finalText: result.text,
      });
      return { runId, result: result.text };
    } catch (error) {
      const errorMessage = `Codex App Server execution failed: ${(error as Error).message || "Unknown error"}`;
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
      return {
        runId,
        result: "",
        error: errorMessage,
      };
    }
  }

  if (
    isGeneralAgent &&
    (opts.agentContext.generalAgentEngine === "claude_code_local" || (primaryModelId && isClaudeCodeModel(primaryModelId)))
  ) {
    try {
      const result = await runClaudeCodeTurn({
        runId,
        sessionKey,
        modelId: primaryModelId!,
        prompt,
        abortSignal: opts.abortSignal,
        onProgress: (chunk) => {
          if (!chunk) return;
          opts.onProgress?.(chunk);
          const s = nextSeq();
          opts.store.recordRunEvent({
            timestamp: now(),
            runId,
            conversationId: opts.conversationId,
            agentType: opts.agentType,
            seq: s,
            type: "stream",
            chunk,
          });
        },
      });
      if (result.text.trim()) {
        opts.store.appendThreadMessage({
          timestamp: now(),
          conversationId: subagentThreadConversationId,
          role: "assistant",
          content: result.text,
        });
        await maybeCompactRuntimeThread({
          store: opts.store,
          threadKey: subagentThreadConversationId,
          resolvedLlm: opts.resolvedLlm,
          agentType: opts.agentType,
        }).catch(() => undefined);
      }
      const endSeq = nextSeq();
      opts.store.recordRunEvent({
        timestamp: now(),
        runId,
        conversationId: opts.conversationId,
        agentType: opts.agentType,
        seq: endSeq,
        type: "run_end",
        finalText: result.text,
      });
      return { runId, result: result.text };
    } catch (error) {
      const errorMessage = `Claude Code execution failed: ${(error as Error).message || "Unknown error"}`;
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
      return {
        runId,
        result: "",
        error: errorMessage,
      };
    }
  }

  const tools = createPiTools({
    runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
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
      model: opts.resolvedLlm.model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(contextHistory),
    },
    convertToLlm: (messages) => messages.filter((msg) =>
      msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult"),
    getApiKey: () => opts.resolvedLlm.getApiKey(),
  });

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const chunk = event.assistantMessageEvent.delta;
      if (chunk) {
        opts.onProgress?.(chunk);
        const s = nextSeq();
        opts.store.recordRunEvent({
          timestamp: now(),
          runId,
          conversationId: opts.conversationId,
          agentType: opts.agentType,
          seq: s,
          type: "stream",
          chunk,
        });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const s = nextSeq();
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
      opts.callbacks?.onToolStart?.({
        runId,
        seq: s,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const preview = textFromUnknown(event.result).slice(0, MAX_RESULT_PREVIEW);
      const s = nextSeq();
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
      opts.callbacks?.onToolEnd?.({
        runId,
        seq: s,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultPreview: preview,
      });
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
    if (result.trim()) {
      opts.store.appendThreadMessage({
        timestamp: now(),
        conversationId: subagentThreadConversationId,
        role: "assistant",
        content: result,
      });
      await maybeCompactRuntimeThread({
        store: opts.store,
        threadKey: subagentThreadConversationId,
        resolvedLlm: opts.resolvedLlm,
        agentType: opts.agentType,
      }).catch(() => undefined);
    }
    const endSeq = nextSeq();
    opts.store.recordRunEvent({
      timestamp: now(),
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      seq: endSeq,
      type: "run_end",
      finalText: result,
    });

    return {
      runId,
      result,
    };
  } catch (error) {
    const errorMessage = (error as Error).message || "Subagent failed";
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
    return {
      runId,
      result: "",
      error: errorMessage,
    };
  } finally {
    unsubscribe();
    opts.abortSignal?.removeEventListener("abort", abortHandler);
  }
}

export const shutdownSubagentRuntimes = (): void => {
  shutdownCodexAppServerRuntime();
  shutdownClaudeCodeRuntime();
};

export const PI_RUNTIME_MAX_TURNS = DEFAULT_MAX_TURNS;
