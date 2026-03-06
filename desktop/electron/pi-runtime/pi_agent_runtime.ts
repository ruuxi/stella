import crypto from "crypto";
import { Type } from "@sinclair/typebox";
import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { DEVICE_TOOL_NAMES, TOOL_DESCRIPTIONS } from "./extensions/stella/tool_schemas.js";
import {
  detectSelfModAppliedSince,
  getGitHead,
  type SelfModAppliedPayload,
} from "../self-mod/git.js";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "./extensions/stella/claude-code-session-runtime.js";
import {
  runCodexAppServerTurn,
  shutdownCodexAppServerRuntime,
} from "./extensions/stella/codex-app-server-runtime.js";
import type { LocalTaskManagerAgentContext } from "./extensions/stella/local-task-manager.js";
import { localActivateSkill, localNoResponse, localWebFetch } from "./extensions/stella/local-tool-overrides.js";
import type { ToolContext, ToolResult } from "./extensions/stella/tools-types.js";
import { JsonlRuntimeStore } from "./jsonl_store.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

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

// Always loaded — high-frequency tools every agent needs
const CORE_TOOL_NAMES = new Set([
  "Read", "Edit", "Glob", "Grep", "Bash", "AskUserQuestion",
]);

// Deferred — loaded on demand via LoadTools
const DEFERRED_TOOL_CATALOG: Record<string, string> = {
  KillShell: "Stop a background shell process",
  ShellStatus: "Check status of background shell processes",
  RequestCredential: "Request an API key from the user via secure UI",
  SkillBash: "Run a shell command with skill secrets auto-mounted",
  MediaGenerate: "Generate or edit images and video",
  Task: "Manage subagent tasks (combined create/cancel/output)",
  TaskCreate: "Delegate a task to a subagent for background execution",
  TaskCancel: "Cancel a running subagent task",
  TaskOutput: "Get the result of a background subagent task",
  WebFetch: "Fetch and read content from a URL",
  ActivateSkill: "Load a skill's full instructions into context",
  NoResponse: "Signal that no user-visible response is needed",
  SaveMemory: "Save information worth remembering across conversations",
  RecallMemories: "Look up relevant memories from past conversations",
};

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
  selfModApplied?: SelfModAppliedPayload;
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
};

type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: PiRunCallbacks;
};

type SubagentRunOptions = BaseRunOptions & {
  onProgress?: (chunk: string) => void;
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

const buildSubagentThreadConversationId = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}): string => {
  const threadKey = args.threadId?.trim() || `run:${args.runId}`;
  return `${args.conversationId}::subagent::${args.agentType}::${threadKey}`;
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

  // Build a single AgentTool for a given name
  const buildTool = (toolName: string): AgentTool => ({
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
  });

  // Separate into core (always loaded), deferred (loaded via LoadTools), and other (eagerly loaded)
  const coreNames = uniqueToolNames.filter(name => CORE_TOOL_NAMES.has(name));
  const deferredNames = uniqueToolNames.filter(name => !CORE_TOOL_NAMES.has(name) && name in DEFERRED_TOOL_CATALOG);
  const otherNames = uniqueToolNames.filter(name => !CORE_TOOL_NAMES.has(name) && !(name in DEFERRED_TOOL_CATALOG));

  // Start with core tools
  const tools: AgentTool[] = coreNames.map(buildTool);

  // Eagerly load any tools not in the deferred catalog (custom/unknown)
  for (const name of otherNames) {
    tools.push(buildTool(name));
  }

  // Set up deferred loading
  if (deferredNames.length > 0) {
    const deferredMap = new Map<string, AgentTool>();
    for (const name of deferredNames) {
      deferredMap.set(name, buildTool(name));
    }

    const catalogText = deferredNames
      .map(name => `- ${name}: ${DEFERRED_TOOL_CATALOG[name]}`)
      .join("\n");

    tools.push({
      name: "LoadTools",
      label: "LoadTools",
      description:
        "Load additional tools to make them available.\n\n" +
        "Call this before using any tool listed below. " +
        "Once loaded, tools stay available for the rest of the conversation.\n\n" +
        "Available tools:\n" + catalogText + "\n\n" +
        "Usage:\n" +
        "- Load by name: LoadTools({ names: [\"TaskCreate\", \"WebFetch\"] })\n" +
        "- Search by keyword: LoadTools({ query: \"task\" })",
      parameters: AnyToolArgsSchema,
      execute: async (_toolCallId, params) => {
        const args = (params as Record<string, unknown>) ?? {};
        const names = Array.isArray(args.names)
          ? args.names.filter((n): n is string => typeof n === "string")
          : [];
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";

        let toLoad: string[] = [];
        if (names.length > 0) {
          toLoad = names.filter(n => deferredMap.has(n));
        } else if (query) {
          toLoad = Array.from(deferredMap.keys()).filter(name =>
            name.toLowerCase().includes(query) ||
            (DEFERRED_TOOL_CATALOG[name] ?? "").toLowerCase().includes(query),
          );
        }

        if (toLoad.length === 0) {
          const available = Array.from(deferredMap.keys());
          return {
            content: [{ type: "text", text: available.length > 0
              ? `No matching tools found. Available: ${available.join(", ")}`
              : "All tools are already loaded." }],
            details: { loaded: [], available },
          };
        }

        const loaded: string[] = [];
        for (const name of toLoad) {
          const tool = deferredMap.get(name);
          if (tool) {
            tools.push(tool);
            deferredMap.delete(name);
            loaded.push(name);
          }
        }

        const remaining = Array.from(deferredMap.keys());
        let text = `Loaded: ${loaded.join(", ")}.`;
        if (remaining.length > 0) {
          text += ` Still available: ${remaining.join(", ")}.`;
        }
        return {
          content: [{ type: "text", text }],
          details: { loaded, remaining },
        };
      },
    });
  }

  return tools;
};

export async function runPiOrchestratorTurn(opts: OrchestratorRunOptions): Promise<string> {
  const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
  let seq = 0;
  const nextSeq = () => ++seq;
  const baselineHead = opts.frontendRoot
    ? await getGitHead(opts.frontendRoot).catch(() => null)
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
    console.log(`[stella:trace] orchestrator end | runId=${runId} | finalText=${finalText.slice(0, 300)}`);
    const selfModApplied = opts.frontendRoot
      ? await detectSelfModAppliedSince({
          repoRoot: opts.frontendRoot,
          sinceHead: baselineHead,
        }).catch(() => null)
      : null;

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
  const subagentThreadConversationId = buildSubagentThreadConversationId({
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

export const shutdownPiSubagentRuntimes = (): void => {
  shutdownCodexAppServerRuntime();
  shutdownClaudeCodeRuntime();
};

export const PI_RUNTIME_MAX_TURNS = DEFAULT_MAX_TURNS;
