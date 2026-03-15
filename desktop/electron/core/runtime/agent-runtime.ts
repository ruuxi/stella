import crypto from "crypto";
import os from "os";
import { Type } from "@sinclair/typebox";
import { Agent } from "../agent/agent.js";
import type { AgentMessage, AgentTool } from "../agent/types.js";
import {
  DEVICE_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_JSON_SCHEMAS,
} from "./tools/schemas.js";
import {
  localActivateSkill,
  localNoResponse,
  localWebFetch,
} from "./tools/local-tool-overrides.js";
import type { ToolContext, ToolResult } from "./tools/types.js";
import type { HookEmitter } from "./extensions/hook-emitter.js";
import {
  isClaudeCodeModel,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "./integrations/claude-code-session-runtime.js";
import {
  runCodexAppServerTurn,
  shutdownCodexAppServerRuntime,
} from "./integrations/codex-app-server-runtime.js";
import type { LocalTaskManagerAgentContext } from "./tasks/local-task-manager.js";
import type { RuntimeStore } from "../../storage/runtime-store.js";
import type { ResolvedLlmRoute } from "./model-routing.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "./thread-runtime.js";
import { selectRecentByTokenBudget } from "./local-history.js";
import { estimateRuntimeTokens } from "./runtime-threads.js";

const DEFAULT_MAX_TURNS = 40;
const MAX_RESULT_PREVIEW = 200;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const CONTEXT_PRUNE_RESERVE_TOKENS = 16_384;
const MIN_CONTEXT_PRUNE_TOKENS = 8_000;
const ESTIMATED_IMAGE_TOKENS = 2_000;

const STELLA_LOCAL_TOOLS = [
  ...DEVICE_TOOL_NAMES,
  "TaskUpdate",
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
  agentType: string;
  seq: number;
  chunk: string;
};

export type RuntimeToolStartEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type RuntimeToolEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  resultPreview: string;
};

export type RuntimeErrorEvent = {
  runId: string;
  agentType: string;
  seq: number;
  error: string;
  fatal: boolean;
};

export type RuntimeEndEvent = {
  runId: string;
  agentType: string;
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
  rootRunId?: string;
  conversationId: string;
  userMessageId: string;
  agentType: string;
  userPrompt: string;
  agentContext: LocalTaskManagerAgentContext;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  deviceId: string;
  stellaHome: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  abortSignal?: AbortSignal;
  frontendRoot?: string;
  selfModMonitor?: SelfModMonitor | null;
  webSearch?: (
    query: string,
    options?: {
      category?: string;
    },
  ) => Promise<{ text: string; results: Array<{ title: string; url: string; snippet: string }> }>;
  hookEmitter?: HookEmitter;
  displayHtml?: (html: string) => void;
};

type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: RuntimeRunCallbacks;
};

type SubagentRunOptions = BaseRunOptions & {
  onProgress?: (chunk: string) => void;
  callbacks?: Partial<RuntimeRunCallbacks>;
};

const resolveLocalCliCwd = ({
  agentType,
  frontendRoot,
}: {
  agentType: string;
  frontendRoot?: string;
}): string | undefined => {
  if (agentType === "general") {
    const homeDirectory = os.homedir().trim();
    if (homeDirectory) {
      return homeDirectory;
    }
  }
  const normalizedFrontendRoot = frontendRoot?.trim();
  return normalizedFrontendRoot && normalizedFrontendRoot.length > 0 ? normalizedFrontendRoot : undefined;
};

const getToolResultPreview = (_toolName: string, result: unknown): string =>
  textFromUnknown(result).slice(0, MAX_RESULT_PREVIEW);

const stripScriptTags = (html: string): string =>
  html.replace(/<script\b[\s\S]*?<\/script>/gi, "");

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

const estimateUnknownTokens = (value: unknown): number => {
  if (typeof value === "string") {
    return estimateRuntimeTokens(value);
  }
  if (value == null) {
    return 0;
  }
  try {
    return estimateRuntimeTokens(JSON.stringify(value));
  } catch {
    return estimateRuntimeTokens(String(value));
  }
};

const estimateContentTokens = (content: unknown): number => {
  if (typeof content === "string") {
    return estimateRuntimeTokens(content);
  }
  if (!Array.isArray(content)) {
    return estimateUnknownTokens(content);
  }
  return content.reduce((sum, block) => {
    if (!block || typeof block !== "object") {
      return sum + estimateUnknownTokens(block);
    }
    const candidate = block as Record<string, unknown>;
    switch (candidate.type) {
      case "text":
        return sum + estimateRuntimeTokens(typeof candidate.text === "string" ? candidate.text : "");
      case "thinking":
        return sum + estimateRuntimeTokens(typeof candidate.thinking === "string" ? candidate.thinking : "");
      case "image":
        return sum + ESTIMATED_IMAGE_TOKENS;
      case "toolCall":
        return sum + estimateUnknownTokens({
          name: candidate.name,
          arguments: candidate.arguments,
        });
      default:
        return sum + estimateUnknownTokens(candidate);
    }
  }, 0);
};

const estimateAgentMessageTokens = (message: AgentMessage): number => {
  const baseTokens = 8;
  if (message.role === "toolResult") {
    return Math.max(
      1,
      baseTokens +
        estimateRuntimeTokens(message.toolName) +
        estimateContentTokens(message.content),
    );
  }
  return Math.max(1, baseTokens + estimateContentTokens(message.content));
};

const getContextPruneBudget = (resolvedLlm: ResolvedLlmRoute): number => {
  const contextWindow = Number(resolvedLlm.model.contextWindow);
  const safeContextWindow = Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.floor(contextWindow)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.max(
    MIN_CONTEXT_PRUNE_TOKENS,
    safeContextWindow - CONTEXT_PRUNE_RESERVE_TOKENS,
  );
};

const buildDefaultTransformContext = (
  resolvedLlm: ResolvedLlmRoute,
): ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) => {
  const maxTokens = getContextPruneBudget(resolvedLlm);
  return async (messages, signal) => {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
    const totalTokens = messages.reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0);
    if (totalTokens <= maxTokens) {
      return messages;
    }
    const selected = selectRecentByTokenBudget({
      itemsNewestFirst: [...messages].reverse(),
      maxTokens,
      estimateTokens: estimateAgentMessageTokens,
    });
    return [...selected].reverse();
  };
};

const extractAssistantText = (message: AgentMessage | undefined): string => {
  if (!message || message.role !== "assistant") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
};

const getLatestAssistantMessage = (messages: AgentMessage[]): AgentMessage | undefined =>
  [...messages].reverse().find((message) => message.role === "assistant");

const getAgentCompletion = (agent: Agent): { finalText: string; errorMessage?: string } => {
  const latestAssistant = getLatestAssistantMessage(agent.state.messages);
  const finalText = extractAssistantText(latestAssistant);

  if (latestAssistant?.role === "assistant") {
    const assistantError = latestAssistant.errorMessage?.trim();
    if (latestAssistant.stopReason === "error" || latestAssistant.stopReason === "aborted") {
      return {
        finalText,
        errorMessage:
          assistantError ||
          agent.state.error ||
          (latestAssistant.stopReason === "aborted" ? "Request was aborted" : "Agent failed"),
      };
    }

    if (assistantError) {
      return {
        finalText,
        errorMessage: assistantError,
      };
    }
  }

  if (agent.state.error && !finalText.trim()) {
    return {
      finalText,
      errorMessage: agent.state.error,
    };
  }

  return { finalText };
};

const getPlatformShellPrompt = (): string | null => {
  if (process.platform === "win32") {
    return "On Windows, Bash runs in Git Bash. Prefer POSIX commands and /c/... style paths over C:\\ paths when using Bash.";
  }
  if (process.platform === "darwin") {
    return "On macOS, use standard POSIX shell commands and native /Users/... paths when using Bash.";
  }
  return null;
};

const hasShellToolGuidance = (context: LocalTaskManagerAgentContext): boolean => {
  const toolsAllowlist = context.toolsAllowlist;
  if (!Array.isArray(toolsAllowlist) || toolsAllowlist.length === 0) {
    return true;
  }
  return toolsAllowlist.includes("Bash") || toolsAllowlist.includes("SkillBash");
};

const buildSystemPrompt = (context: LocalTaskManagerAgentContext): string => {
  const sections = [context.systemPrompt.trim()];

  if (context.dynamicContext?.trim()) {
    sections.push(context.dynamicContext.trim());
  }

  if (context.coreMemory?.trim()) {
    sections.push(`Core memory:\n${context.coreMemory.trim()}`);
  }

  const platformShellPrompt = getPlatformShellPrompt();
  if (platformShellPrompt && hasShellToolGuidance(context)) {
    sections.push(platformShellPrompt);
  }

  const defaultSkills = Array.from(new Set(context.defaultSkills.filter((value) => value.trim().length > 0)));
  const skillIds = Array.from(new Set(context.skillIds.filter((value) => value.trim().length > 0)));
  if (defaultSkills.length > 0 || skillIds.length > 0) {
    const lines = ["Skills available in this runtime:"];
    if (defaultSkills.length > 0) {
      lines.push(`Default skills: ${defaultSkills.join(", ")}`);
    }
    if (skillIds.length > 0) {
      lines.push(`Enabled installed skill IDs: ${skillIds.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }

  return sections.filter(Boolean).join("\n\n");
};

const buildSelfModDocumentationPrompt = (frontendRoot?: string): string => {
  if (!frontendRoot?.trim()) return "";
  return [
    "Documentation:",
    "- If you are working on renderer structure, file placement, or ownership boundaries, read `src/STELLA.md` first.",
  ].join("\n");
};

const buildOrchestratorUserPrompt = (context: LocalTaskManagerAgentContext, userPrompt: string): string => {
  const reminder = context.orchestratorReminderText?.trim();
  if (!context.shouldInjectDynamicReminder || !reminder) {
    return userPrompt;
  }
  return `${userPrompt}\n\n<system-context>\n${reminder}\n</system-context>`;
};

const updateOrchestratorReminderState = (
  store: RuntimeStore,
  args: { conversationId: string; shouldInjectDynamicReminder?: boolean; finalText: string },
): void => {
  const updateCounter = (
    store as RuntimeStore & {
      updateOrchestratorReminderCounter?: (args: {
        conversationId: string;
        resetTo?: number;
        incrementBy?: number;
      }) => void;
    }
  ).updateOrchestratorReminderCounter;
  if (typeof updateCounter !== "function") {
    return;
  }
  if (args.shouldInjectDynamicReminder) {
    updateCounter.call(store, {
      conversationId: args.conversationId,
      resetTo: 0,
    });
    return;
  }
  const outputTokens = estimateRuntimeTokens(args.finalText);
  if (outputTokens > 0) {
    updateCounter.call(store, {
      conversationId: args.conversationId,
      incrementBy: outputTokens,
    });
  }
};

const getRecallQuery = (args: Record<string, unknown>): string =>
  typeof args.query === "string" ? args.query : "";

const getSaveMemoryText = (args: Record<string, unknown>): string =>
  typeof args.content === "string" ? args.content : "";

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
  rootRunId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  stellaHome: string;
  taskDepth?: number;
  maxTaskDepth?: number;
  delegationAllowlist?: string[];
  toolsAllowlist?: string[];
  defaultSkills?: string[];
  skillIds?: string[];
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  webSearch?: (
    query: string,
    options?: {
      category?: string;
    },
  ) => Promise<{ text: string; results: Array<{ title: string; url: string; snippet: string }> }>;
  hookEmitter?: HookEmitter;
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
    execute: async (toolCallId, params, signal) => {
      const args = (params as Record<string, unknown>) ?? {};

      if (toolName === "WebSearch") {
        const query = typeof args.query === "string" ? args.query : "";
        if (!opts.webSearch) {
          return { content: [{ type: "text", text: "WebSearch is not available." }], details: {} };
        }
        const category = typeof args.category === "string" ? args.category : undefined;
        const result = await opts.webSearch(query, { category });
        return {
          content: [{ type: "text", text: result.text || "WebSearch returned no response." }],
          details: result,
        };
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
        const text = await localActivateSkill({
          skillId,
          stellaHome: opts.stellaHome,
          allowedSkillIds: opts.skillIds,
        });
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
        ...(opts.rootRunId ? { rootRunId: opts.rootRunId } : {}),
        agentType: opts.agentType,
        storageMode: "local",
        ...(typeof opts.taskDepth === "number" ? { taskDepth: opts.taskDepth } : {}),
        ...(typeof opts.maxTaskDepth === "number" ? { maxTaskDepth: opts.maxTaskDepth } : {}),
        ...(opts.delegationAllowlist ? { delegationAllowlist: opts.delegationAllowlist } : {}),
        ...(opts.defaultSkills ? { defaultSkills: opts.defaultSkills } : {}),
        ...(opts.skillIds ? { skillIds: opts.skillIds } : {}),
      };

      // --- before_tool hook ---
      let effectiveArgs = args;
      if (opts.hookEmitter) {
        const hookResult = await opts.hookEmitter.emit(
          "before_tool",
          { tool: toolName, args, context },
          { tool: toolName, agentType: opts.agentType },
        );
        if (hookResult?.cancel) {
          return {
            content: [{ type: "text", text: `Tool blocked: ${hookResult.reason ?? "blocked by hook"}` }],
            details: { blocked: true },
          };
        }
        if (hookResult?.args) {
          effectiveArgs = hookResult.args;
        }
      }

      let toolResult = await opts.toolExecutor(toolName, effectiveArgs, context, signal);

      // --- after_tool hook ---
      if (opts.hookEmitter) {
        const hookResult = await opts.hookEmitter.emit(
          "after_tool",
          { tool: toolName, args: effectiveArgs, result: toolResult, context },
          { tool: toolName, agentType: opts.agentType },
        );
        if (hookResult?.result) {
          toolResult = hookResult.result;
        }
      }

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

  console.log(`[stella:trace] orchestrator start | runId=${runId} | agent=${opts.agentType} | model=${opts.resolvedLlm.model.id} | convId=${opts.conversationId}`);
  console.log(`[stella:trace] user prompt: ${opts.userPrompt.slice(0, 300)}`);

  // --- before_agent_start hook ---
  let effectiveSystemPrompt = buildSystemPrompt(opts.agentContext);
  if (opts.hookEmitter) {
    const hookResult = await opts.hookEmitter.emit(
      "before_agent_start",
      { agentType: opts.agentType, systemPrompt: effectiveSystemPrompt },
      { agentType: opts.agentType },
    );
    if (hookResult) {
      if (hookResult.systemPromptReplace) {
        effectiveSystemPrompt = hookResult.systemPromptReplace;
      } else if (hookResult.systemPromptAppend) {
        effectiveSystemPrompt += "\n" + hookResult.systemPromptAppend;
      }
    }
  }

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
    rootRunId: opts.rootRunId ?? runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    taskDepth: opts.agentContext.taskDepth ?? 0,
    maxTaskDepth: opts.agentContext.maxTaskDepth,
    delegationAllowlist: opts.agentContext.delegationAllowlist,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    defaultSkills: opts.agentContext.defaultSkills,
    skillIds: opts.agentContext.skillIds,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
    hookEmitter: opts.hookEmitter,
  });

  console.log(`[stella:trace] tools for ${opts.agentType}:`, tools.map(t => ({
    name: t.name,
    hasDesc: !!t.description,
    paramKeys: Object.keys((t.parameters as Record<string, unknown>)?.properties ?? {}),
  })));

  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveSystemPrompt,
      model: opts.resolvedLlm.model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(historySource),
    },
    convertToLlm: (messages) => messages.filter((msg) =>
      msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult"),
    transformContext: buildDefaultTransformContext(opts.resolvedLlm),
    getApiKey: () => opts.resolvedLlm.getApiKey(),
    onPayload: opts.hookEmitter ? async (payload, model) => {
      const result = await opts.hookEmitter!.emit("before_provider_request", {
        agentType: opts.agentType,
        model: model.id,
        payload,
      });
      return result?.payload;
    } : undefined,
  });

  if (opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const abortHandler = () => agent.abort();
  opts.abortSignal?.addEventListener("abort", abortHandler);

  // Streaming state for Display tool DOM-diffing
  let displayStreamTimer: ReturnType<typeof setTimeout> | null = null;
  let displayStreamLastHtml = "";

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const chunk = event.assistantMessageEvent.delta;
      if (!chunk) return;
      const s = nextSeq();
      opts.callbacks.onStream({ runId, agentType: opts.agentType, seq: s, chunk });
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

    // Stream Display tool HTML as it's being generated (morphdom diffing on frontend)
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "toolcall_delta" &&
      opts.displayHtml
    ) {
      try {
        const partial = event.assistantMessageEvent.partial;
        const contentIndex = event.assistantMessageEvent.contentIndex;
        const block = partial?.content?.[contentIndex] as { type?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
        if (
          block?.type === "toolCall" &&
          block.name === "Display" &&
          typeof block.arguments?.html === "string"
        ) {
          const html = stripScriptTags(block.arguments.html as string);
          if (html.length > 20 && html !== displayStreamLastHtml) {
            displayStreamLastHtml = html;
            // Debounce at 150ms for smooth rendering
            if (!displayStreamTimer) {
              displayStreamTimer = setTimeout(() => {
                displayStreamTimer = null;
                if (displayStreamLastHtml && opts.displayHtml) {
                  opts.displayHtml(displayStreamLastHtml);
                }
              }, 150);
            }
          }
        }
      } catch {
        // Ignore parsing errors during streaming
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      console.log(`[stella:trace] tool exec start | ${event.toolName} | callId=${event.toolCallId} | args=${JSON.stringify(event.args ?? {}).slice(0, 300)}`);
      const s = nextSeq();
      opts.callbacks.onToolStart({
        runId,
        agentType: opts.agentType,
        seq: s,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: (event.args as Record<string, unknown>) ?? {},
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
      const preview = getToolResultPreview(event.toolName, event.result);
      console.log(`[stella:trace] tool exec end   | ${event.toolName} | callId=${event.toolCallId} | result=${preview.slice(0, 200)}`);
      const s = nextSeq();
      opts.callbacks.onToolEnd({
        runId,
        agentType: opts.agentType,
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

    // --- turn_start / turn_end hooks ---
    if (event.type === "turn_start" && opts.hookEmitter) {
      void opts.hookEmitter.emit(
        "turn_start",
        { agentType: opts.agentType, messageCount: agent.state.messages.length },
        { agentType: opts.agentType },
      ).catch(() => undefined);
    }
    if (event.type === "turn_end" && opts.hookEmitter) {
      const turnText = event.message?.role === "assistant"
        ? extractAssistantText(event.message)
        : "";
      void opts.hookEmitter.emit(
        "turn_end",
        { agentType: opts.agentType, assistantText: turnText },
        { agentType: opts.agentType },
      ).catch(() => undefined);
    }
  });

  try {
    const promptText = buildOrchestratorUserPrompt(opts.agentContext, opts.userPrompt);
    opts.store.appendThreadMessage({
      timestamp: now(),
      threadKey,
      role: "user",
      content: opts.userPrompt,
    });

    await agent.prompt({
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: now(),
    });

    // Flush any pending display stream update
    if (displayStreamTimer) {
      clearTimeout(displayStreamTimer);
      displayStreamTimer = null;
      if (displayStreamLastHtml && opts.displayHtml) {
        opts.displayHtml(displayStreamLastHtml);
      }
    }

    const { finalText, errorMessage } = getAgentCompletion(agent);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    console.log(`[stella:trace] orchestrator end | runId=${runId} | finalText=${finalText.slice(0, 300)}`);

    // --- agent_end hook ---
    if (opts.hookEmitter) {
      await opts.hookEmitter.emit(
        "agent_end",
        { agentType: opts.agentType, finalText },
        { agentType: opts.agentType },
      ).catch(() => undefined);
    }

    const selfModApplied = opts.frontendRoot && opts.selfModMonitor
      ? await opts.selfModMonitor.detectAppliedSince({
          repoRoot: opts.frontendRoot,
          sinceHead: baselineHead,
        }).catch(() => null)
      : null;

    if (finalText.trim()) {
      opts.store.appendThreadMessage({
        timestamp: now(),
        threadKey,
        role: "assistant",
        content: finalText,
      });

      // --- before_compact hook ---
      let shouldCompact = true;
      if (opts.hookEmitter) {
        const hookResult = await opts.hookEmitter.emit(
          "before_compact",
          { agentType: opts.agentType, messageCount: agent.state.messages.length },
          { agentType: opts.agentType },
        ).catch(() => undefined);
        if (hookResult?.cancel) {
          shouldCompact = false;
        }
      }
      if (shouldCompact) {
        await maybeCompactRuntimeThread({
          store: opts.store,
          threadKey,
          resolvedLlm: opts.resolvedLlm,
          agentType: opts.agentType,
        }).catch(() => undefined);
      }
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
      agentType: opts.agentType,
      seq: endSeq,
      finalText,
      persisted: true,
      ...(selfModApplied ? { selfModApplied } : {}),
    });
    updateOrchestratorReminderState(opts.store, {
      conversationId: opts.conversationId,
      shouldInjectDynamicReminder: opts.agentContext.shouldInjectDynamicReminder,
      finalText,
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
      agentType: opts.agentType,
      seq: errSeq,
      error: errorMessage,
      fatal: true,
    });
    throw error;
  } finally {
    if (displayStreamTimer) {
      clearTimeout(displayStreamTimer);
      displayStreamTimer = null;
    }
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
  const effectiveSystemPrompt = [
    buildSystemPrompt(opts.agentContext),
    opts.agentType === "self_mod" ? buildSelfModDocumentationPrompt(opts.frontendRoot) : "",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
  const subagentThreadConversationId = buildRuntimeThreadKey({
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    runId,
    threadId: opts.agentContext.activeThreadId,
  });
  let seq = 0;
  const nextSeq = () => ++seq;
  let finalText = "";

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
      threadKey: subagentThreadConversationId,
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
  const usesLocalCliRuntime = opts.agentType === "general" || opts.agentType === "self_mod";
  const localCliCwd = resolveLocalCliCwd({
    agentType: opts.agentType,
    frontendRoot: opts.frontendRoot,
  });
  const sessionKey = opts.agentContext.activeThreadId
    ? `${opts.conversationId}:${opts.agentContext.activeThreadId}`
    : `${opts.conversationId}:run:${runId}`;

  if (usesLocalCliRuntime && opts.agentContext.agentEngine === "codex_local") {
    try {
      const result = await runCodexAppServerTurn({
        runId,
        sessionKey,
        prompt,
        developerInstructions: effectiveSystemPrompt,
        cwd: localCliCwd,
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
          opts.callbacks?.onStream?.({
            runId,
            agentType: opts.agentType,
            seq: s,
            chunk,
          });
        },
        maxConcurrency: opts.agentContext.maxAgentConcurrency,
      });
      if (result.text.trim()) {
        opts.store.appendThreadMessage({
          timestamp: now(),
          threadKey: subagentThreadConversationId,
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
      finalText = result.text;
      opts.callbacks?.onEnd?.({
        runId,
        agentType: opts.agentType,
        seq: endSeq,
        finalText,
        persisted: true,
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
      opts.callbacks?.onError?.({
        runId,
        agentType: opts.agentType,
        seq: errSeq,
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
    usesLocalCliRuntime &&
    (opts.agentContext.agentEngine === "claude_code_local" || (primaryModelId && isClaudeCodeModel(primaryModelId)))
  ) {
    try {
      const result = await runClaudeCodeTurn({
        runId,
        sessionKey,
        modelId: primaryModelId!,
        prompt,
        systemPrompt: effectiveSystemPrompt,
        cwd: localCliCwd,
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
          opts.callbacks?.onStream?.({
            runId,
            agentType: opts.agentType,
            seq: s,
            chunk,
          });
        },
      });
      if (result.text.trim()) {
        opts.store.appendThreadMessage({
          timestamp: now(),
          threadKey: subagentThreadConversationId,
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
      finalText = result.text;
      opts.callbacks?.onEnd?.({
        runId,
        agentType: opts.agentType,
        seq: endSeq,
        finalText,
        persisted: true,
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
      opts.callbacks?.onError?.({
        runId,
        agentType: opts.agentType,
        seq: errSeq,
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
    rootRunId: opts.rootRunId ?? runId,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
    deviceId: opts.deviceId,
    stellaHome: opts.stellaHome,
    taskDepth: opts.agentContext.taskDepth ?? 0,
    maxTaskDepth: opts.agentContext.maxTaskDepth,
    delegationAllowlist: opts.agentContext.delegationAllowlist,
    toolsAllowlist: opts.agentContext.toolsAllowlist,
    defaultSkills: opts.agentContext.defaultSkills,
    skillIds: opts.agentContext.skillIds,
    store: opts.store,
    toolExecutor: opts.toolExecutor,
    webSearch: opts.webSearch,
    hookEmitter: opts.hookEmitter,
  });

  const contextHistory =
    opts.agentContext.threadHistory
      ?.filter((entry): entry is { role: "user" | "assistant"; content: string } =>
        (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
      .map((entry) => ({ role: entry.role, content: entry.content })) ??
    [];

  const agent = new Agent({
    initialState: {
      systemPrompt: effectiveSystemPrompt,
      model: opts.resolvedLlm.model,
      thinkingLevel: "medium",
      tools,
      messages: toAgentMessages(contextHistory),
    },
    convertToLlm: (messages) => messages.filter((msg) =>
      msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult"),
    transformContext: buildDefaultTransformContext(opts.resolvedLlm),
    getApiKey: () => opts.resolvedLlm.getApiKey(),
    onPayload: opts.hookEmitter ? async (payload, model) => {
      const result = await opts.hookEmitter!.emit("before_provider_request", {
        agentType: opts.agentType,
        model: model.id,
        payload,
      });
      return result?.payload;
    } : undefined,
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
        opts.callbacks?.onStream?.({
          runId,
          agentType: opts.agentType,
          seq: s,
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
        agentType: opts.agentType,
        seq: s,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: (event.args as Record<string, unknown>) ?? {},
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const preview = getToolResultPreview(event.toolName, event.result);
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
        agentType: opts.agentType,
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

    const { finalText: result, errorMessage } = getAgentCompletion(agent);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    finalText = result;
    if (result.trim()) {
      opts.store.appendThreadMessage({
        timestamp: now(),
        threadKey: subagentThreadConversationId,
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
    opts.callbacks?.onEnd?.({
      runId,
      agentType: opts.agentType,
      seq: endSeq,
      finalText,
      persisted: true,
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
    opts.callbacks?.onError?.({
      runId,
      agentType: opts.agentType,
      seq: errSeq,
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
