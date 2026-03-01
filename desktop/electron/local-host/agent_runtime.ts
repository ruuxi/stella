/**
 * Local agent runtime — runs the AI agent loop in Electron's main process.
 *
 * For interactive desktop sessions only. Convex remains the data layer,
 * credential broker, and always-on execution host for automations/webhooks.
 *
 * Flow:
 * 1. Fetch agent context from Convex (prompt, tools, history, proxy token)
 * 2. Create AI SDK model via LLM proxy (keys never leave server)
 * 3. Run streamText/generateText with local tool execution
 * 4. Emit IPC events for live streaming to renderer
 * 5. Persist run data to Convex via chunked batch persist
 */

import { streamText, generateText, stepCountIs, type ModelMessage, type Tool } from "ai";
import crypto from "crypto";
import { RunJournal } from "./run_journal.js";
import { createAgentTools, type AgentToolCallbacks } from "./agent_tools.js";
import { createRemoteTools } from "./remote_tools.js";
import type { ToolContext, ToolResult } from "./tools-types.js";
import { createProxiedModel, createGatewayModel } from "./agent_core/model_proxy.js";
import { combineAbortSignals, isRetryableModelError } from "./agent_core/runtime_utils.js";
import { extractToolNameFromCallId } from "./agent_core/tool_call_ids.js";
import { createToolCallIdFactory } from "./agent_core/tool_call_factory.js";
import { runWithFallbackModel } from "./agent_core/failover.js";
import { isClaudeCodeModel, runClaudeCodeTurn } from "./claude_code_session_runtime.js";
import { runCodexAppServerTurn } from "./codex_app_server_runtime.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AgentContext = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  model: string;
  fallbackModel?: string;
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
  coreMemory?: string;
  threadHistory?: Array<{ role: string; content: string; toolCallId?: string }>;
  activeThreadId?: string;
  generalAgentEngine?: "default" | "codex_local" | "claude_code_local";
  codexLocalMaxConcurrency?: number;
  proxyToken: {
    token: string;
    expiresAt: number;
  };
};

export type RunCallbacks = {
  onStream: (event: AgentStreamEvent) => void;
  onToolStart: (event: AgentToolStartEvent) => void;
  onToolEnd: (event: AgentToolEndEvent) => void;
  onError: (event: AgentErrorEvent) => void;
  onEnd: (event: AgentEndEvent) => void;
};

export type AgentStreamEvent = {
  runId: string;
  seq: number;
  chunk: string;
};

export type AgentToolStartEvent = {
  runId: string;
  seq: number;
  toolCallId: string;
  toolName: string;
};

export type AgentToolEndEvent = {
  runId: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  resultPreview: string;
};

export type AgentErrorEvent = {
  runId: string;
  seq: number;
  error: string;
  fatal: boolean;
};

export type AgentEndEvent = {
  runId: string;
  seq: number;
  finalText: string;
  persisted: boolean;
  selfModApplied?: { featureId: string; files: string[]; batchIndex: number };
};

export type RunOrchestratorOpts = {
  runId?: string;
  conversationId: string;
  userMessageId: string;
  agentType?: string;
  localHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  persistToConvex?: boolean;
  enableRemoteTools?: boolean;
  agentContext: AgentContext;
  callbacks: RunCallbacks;
  toolExecutor: (toolName: string, args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  convexUrl: string;
  authToken: string;
  deviceId: string;
  stellaHome: string;
  abortSignal?: AbortSignal;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const ORCHESTRATOR_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PERSIST_CHUNK_MAX_EVENTS = 20;
const PERSIST_CHUNK_MAX_BYTES = 800_000;
const MAX_RESULT_PREVIEW_LEN = 200;
const MAX_TURNS = 50; // safety limit

// ─── Orchestrator Turn ───────────────────────────────────────────────────────

export async function runOrchestratorTurn(opts: RunOrchestratorOpts): Promise<string> {
  const {
    conversationId,
    agentContext,
    callbacks,
    toolExecutor,
    convexUrl,
    authToken,
    deviceId,
    stellaHome,
    abortSignal,
    localHistory,
  } = opts;

  const agentType = opts.agentType ?? "orchestrator";
  const persistToConvex = opts.persistToConvex ?? true;
  const enableRemoteTools = opts.enableRemoteTools ?? true;
  const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
  let seq = 0;
  const nextSeq = () => ++seq;

  // Initialize journal
  const journal = new RunJournal(stellaHome);
  journal.startRun({
    runId,
    conversationId,
    agentType,
  });

  // Set up abort controller with timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), ORCHESTRATOR_TIMEOUT_MS);
  const signal = abortSignal
    ? combineAbortSignals(abortSignal, timeoutController.signal)
    : timeoutController.signal;

  // Build model — custom HTTP routes (llm-proxy) live on .convex.site, not .convex.cloud
  const proxyBaseUrl = convexUrl.replace(/\/+$/, "").replace(".convex.cloud", ".convex.site");
  const primaryModelId = agentContext.model;
  const fallbackModelId =
    agentContext.fallbackModel && agentContext.fallbackModel !== primaryModelId
      ? agentContext.fallbackModel
      : undefined;
  const storageMode: "cloud" | "local" = persistToConvex ? "cloud" : "local";
  const historyForLocalMemory = (
    localHistory ??
    (agentContext.threadHistory ?? [])
      .filter((msg): msg is { role: "user" | "assistant"; content: string } =>
        (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
      .map((msg) => ({ role: msg.role, content: msg.content }))
  );

  // Build tools
  const toolCallCounters = new Map<string, number>(); // track ordinals per turn+tool+args combo
  let turnIndex = 0;
  let hasToolSideEffects = false;

  const toolCallbacks: AgentToolCallbacks = {
    onToolCallStart: (toolCallId, toolName) => {
      hasToolSideEffects = true;
      const s = nextSeq();
      callbacks.onToolStart({ runId, seq: s, toolCallId, toolName });
      journal.recordEvent({
        runId, seq: s, type: "tool_call",
        toolCallId, toolName,
      });
    },
    onToolCallEnd: (toolCallId, result, durationMs) => {
      const toolName = extractToolNameFromCallId(toolCallId);
      const preview = typeof result === "string"
        ? result.slice(0, MAX_RESULT_PREVIEW_LEN)
        : JSON.stringify(result).slice(0, MAX_RESULT_PREVIEW_LEN);
      const s = nextSeq();
      callbacks.onToolEnd({ runId, seq: s, toolCallId, toolName, resultPreview: preview });
      journal.recordEvent({
        runId, seq: s, type: "tool_result",
        toolCallId, toolName,
        resultText: typeof result === "string" ? result : JSON.stringify(result),
        durationMs,
      });
    },
  };
  const generateToolCallId = createToolCallIdFactory({
    runId,
    getTurnIndex: () => turnIndex,
    toolCallCounters,
  });

  const tools = createAgentTools({
    runId,
    agentType,
    storageMode,
    toolsAllowlist: agentContext.toolsAllowlist,
    toolExecutor,
    deviceId,
    conversationId,
    callbacks: toolCallbacks,
    generateToolCallId,
  });

  // Add remote tools (RecallMemories, etc.)
  const remoteTools = enableRemoteTools
    ? createRemoteTools({
        convexUrl,
        authToken,
        conversationId,
        agentType,
        mode: storageMode,
        ...(storageMode === "local"
          ? {
            localMemory: {
              stellaHome,
              proxyBaseUrl,
              proxyToken: agentContext.proxyToken.token,
              rerankModelId: "openai/gpt-4.1-mini",
              localHistory: historyForLocalMemory,
            },
          }
          : {}),
      })
    : {};

  const allTools = { ...tools, ...remoteTools };

  // Build messages
  const messages: ModelMessage[] = [];

  const historyMessages = localHistory ?? agentContext.threadHistory ?? [];

  // Add thread history if available
  if (historyMessages) {
    for (const msg of historyMessages) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  // System prompt includes dynamic context
  const systemPrompt = agentContext.dynamicContext
    ? `${agentContext.systemPrompt}\n\n${agentContext.dynamicContext}`
    : agentContext.systemPrompt;

  let fullText = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;

  const runStreamWithModel = async (modelId: string) => {
    // Prefer gateway (direct AI SDK integration) over raw proxy
    const gatewayKey = (agentContext as Record<string, unknown>).gatewayApiKey as string | undefined;
    const model = gatewayKey
      ? createGatewayModel(gatewayKey, modelId)
      : createProxiedModel(proxyBaseUrl, agentContext.proxyToken.token, modelId);

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools: allTools as Record<string, Tool>,
      stopWhen: stepCountIs(MAX_TURNS),
      abortSignal: signal,
      onStepFinish: () => {
        turnIndex++;
        toolCallCounters.clear();
        journal.checkpoint(runId);
      },
    });

    // Stream text chunks to renderer
    for await (const chunk of result.textStream) {
      if (signal.aborted) break;
      const s = nextSeq();
      fullText += chunk;
      callbacks.onStream({ runId, seq: s, chunk });
      journal.recordEvent({
        runId, seq: s, type: "assistant_chunk",
        resultText: chunk,
      });
    }

    // Wait for completion to get usage
    const [resolvedText, resolvedUsage] = await Promise.all([result.text, result.usage]);
    usage = {
      inputTokens: resolvedUsage?.inputTokens,
      outputTokens: resolvedUsage?.outputTokens,
    };
    if (!fullText && resolvedText) {
      fullText = resolvedText;
    }
  };

  try {
    await runWithFallbackModel({
      runWithModel: runStreamWithModel,
      primaryModelId,
      fallbackModelId,
      shouldFallback: (error) =>
        !signal.aborted &&
        !hasToolSideEffects &&
        fullText.length === 0 &&
        isRetryableModelError(error),
      onFallback: (_error, resolvedFallbackModelId) => {
        const s = nextSeq();
        const failoverMsg = `Primary model failed (${primaryModelId}). Retrying with fallback (${resolvedFallbackModelId}).`;
        callbacks.onError({ runId, seq: s, error: failoverMsg, fatal: false });
        journal.recordEvent({
          runId,
          seq: s,
          type: "status_update",
          errorText: failoverMsg,
        });
      },
    });
  } catch (error) {
    if (signal.aborted) {
      const s = nextSeq();
      callbacks.onError({ runId, seq: s, error: "Run aborted", fatal: true });
      journal.markRunCrashed(runId);
      clearTimeout(timeoutId);
      journal.close();
      return runId;
    }
    const s = nextSeq();
    // Extract nested cause from RetryError / AI SDK errors
    const rawErr = error as Error & { cause?: unknown; lastError?: unknown; responseBody?: string };
    const causeMsg = rawErr.cause instanceof Error ? rawErr.cause.message : "";
    const lastErrMsg = rawErr.lastError instanceof Error ? (rawErr.lastError as Error).message : "";
    const errMsg = [rawErr.message, causeMsg, lastErrMsg, rawErr.responseBody]
      .filter(Boolean).join(" | ") || "Unknown error";
    console.error("[agent-runtime] LLM error:", errMsg, error);
    callbacks.onError({ runId, seq: s, error: errMsg, fatal: true });
    journal.recordEvent({ runId, seq: s, type: "status_update", errorText: errMsg });
    journal.markRunCrashed(runId);
    clearTimeout(timeoutId);
    journal.close();
    return runId;
  }

  if (signal.aborted) {
    const s = nextSeq();
    callbacks.onError({ runId, seq: s, error: "Run aborted", fatal: true });
    journal.markRunCrashed(runId);
    clearTimeout(timeoutId);
    journal.close();
    return runId;
  }

  // Mark run complete locally
  journal.completeRun(runId);
  clearTimeout(timeoutId);

  // Persist to Convex in chunks
  let persisted = false;
  if (persistToConvex) {
    try {
      await persistRunToConvex({
        journal,
        runId,
        conversationId,
        agentType,
        convexUrl,
        authToken,
        fullText,
        usage,
        activeThreadId: agentContext.activeThreadId,
      });
      persisted = true;
    } catch (err) {
      console.error("[agent-runtime] Persist failed:", err);
    }
  }

  const s = nextSeq();
  callbacks.onEnd({ runId, seq: s, finalText: fullText, persisted });
  journal.close();
  return runId;
}

// ─── Subagent Turn ───────────────────────────────────────────────────────────

export type RunSubagentOpts = Omit<RunOrchestratorOpts, "callbacks"> & {
  taskId?: string;
  taskDescription: string;
  taskPrompt: string;
  cwd?: string;
  onProgress?: (chunk: string) => void;
};

export async function runSubagentTask(opts: RunSubagentOpts): Promise<{
  runId: string;
  result: string;
  error?: string;
}> {
  const {
    conversationId,
    agentContext,
    convexUrl,
    authToken,
    deviceId,
    stellaHome,
    abortSignal,
    taskDescription,
    taskPrompt,
    cwd,
    onProgress,
  } = opts;

  // Wrap tool executor to inject default working directory when cwd is provided
  const toolExecutor = cwd
    ? async (toolName: string, args: Record<string, unknown>, context: ToolContext) => {
        if ((toolName === "Bash" || toolName === "SkillBash") && !args.working_directory && !args.cwd) {
          args = { ...args, working_directory: cwd };
        }
        if ((toolName === "Glob" || toolName === "Grep" || toolName === "Read") && !args.path) {
          args = { ...args, path: cwd };
        }
        return opts.toolExecutor(toolName, args, context);
      }
    : opts.toolExecutor;

  const agentType = opts.agentType ?? "general";
  const persistToConvex = opts.persistToConvex ?? true;
  const enableRemoteTools = opts.enableRemoteTools ?? true;
  const storageMode: "cloud" | "local" = persistToConvex ? "cloud" : "local";
  const historyForLocalMemory = (agentContext.threadHistory ?? [])
    .filter((msg): msg is { role: "user" | "assistant"; content: string } =>
      (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
    .map((msg) => ({ role: msg.role, content: msg.content }));
  const runId = `local:sub:${crypto.randomUUID()}`;

  const journal = new RunJournal(stellaHome);
  journal.startRun({
    runId,
    conversationId,
    taskId: opts.taskId,
    agentType,
  });

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), SUBAGENT_TIMEOUT_MS);
  const signal = abortSignal
    ? combineAbortSignals(abortSignal, timeoutController.signal)
    : timeoutController.signal;

  const proxyBaseUrl = convexUrl.replace(/\/+$/, "").replace(".convex.cloud", ".convex.site");
  const primaryModelId = agentContext.model;
  const fallbackModelId =
    agentContext.fallbackModel && agentContext.fallbackModel !== primaryModelId
      ? agentContext.fallbackModel
      : undefined;

  if (agentType === "general" && agentContext.generalAgentEngine === "codex_local") {
    const prompt = `${taskDescription}\n\n${taskPrompt}`;
    let subagentSeq = 0;
    const nextSubagentSeq = () => ++subagentSeq;

    try {
      const sessionKey = agentContext.activeThreadId
        ? `${conversationId}:${agentContext.activeThreadId}`
        : opts.taskId
          ? `${conversationId}:task:${opts.taskId}`
          : `${conversationId}:run:${runId}`;

      const result = await runCodexAppServerTurn({
        runId,
        sessionKey,
        prompt,
        cwd,
        abortSignal: signal,
        maxConcurrency: agentContext.codexLocalMaxConcurrency,
        onProgress: (chunk) => {
          if (!chunk) return;
          onProgress?.(chunk);
          journal.recordEvent({
            runId,
            seq: nextSubagentSeq(),
            type: "assistant_chunk",
            resultText: chunk,
          });
        },
      });

      journal.completeRun(runId);

      if (persistToConvex) {
        try {
          await persistRunToConvex({
            journal,
            runId,
            conversationId,
            agentType,
            convexUrl,
            authToken,
            fullText: result.text,
            usage: result.usage,
            activeThreadId: agentContext.activeThreadId,
          });
        } catch (persistError) {
          console.error("[agent-runtime] Persist failed:", persistError);
        }
      }
      clearTimeout(timeoutId);
      journal.close();
      return { runId, result: result.text };
    } catch (error) {
      const errorMessage = `Codex App Server execution failed: ${(error as Error).message ?? "Unknown error"}`;
      journal.recordEvent({
        runId,
        seq: nextSubagentSeq(),
        type: "status_update",
        errorText: errorMessage,
      });
      journal.markRunCrashed(runId);
      clearTimeout(timeoutId);
      journal.close();
      return { runId, result: "", error: errorMessage };
    }
  }

  if (
    agentType === "general" &&
    (agentContext.generalAgentEngine === "claude_code_local" || isClaudeCodeModel(primaryModelId))
  ) {
    const prompt = `${taskDescription}\n\n${taskPrompt}`;
    let subagentSeq = 0;
    const nextSubagentSeq = () => ++subagentSeq;

    try {
      const sessionKey = agentContext.activeThreadId
        ? `${conversationId}:${agentContext.activeThreadId}`
        : opts.taskId
          ? `${conversationId}:task:${opts.taskId}`
          : `${conversationId}:run:${runId}`;

      const result = await runClaudeCodeTurn({
        runId,
        sessionKey,
        modelId: primaryModelId,
        prompt,
        abortSignal: signal,
        onProgress: (chunk) => {
          if (!chunk) return;
          onProgress?.(chunk);
          journal.recordEvent({
            runId,
            seq: nextSubagentSeq(),
            type: "assistant_chunk",
            resultText: chunk,
          });
        },
      });

      journal.completeRun(runId);

      if (persistToConvex) {
        try {
          await persistRunToConvex({
            journal,
            runId,
            conversationId,
            agentType,
            convexUrl,
            authToken,
            fullText: result.text,
            usage: result.usage,
            activeThreadId: agentContext.activeThreadId,
          });
        } catch (persistError) {
          console.error("[agent-runtime] Persist failed:", persistError);
        }
      }
      clearTimeout(timeoutId);
      journal.close();
      return { runId, result: result.text };
    } catch (error) {
      const errorMessage = `Claude Code execution failed: ${(error as Error).message ?? "Unknown error"}`;
      journal.recordEvent({
        runId,
        seq: nextSubagentSeq(),
        type: "status_update",
        errorText: errorMessage,
      });
      journal.markRunCrashed(runId);
      clearTimeout(timeoutId);
      journal.close();
      return { runId, result: "", error: errorMessage };
    }
  }

  let turnIndex = 0;
  const toolCallCounters = new Map<string, number>();
  let subagentSeq = 0;
  const nextSubagentSeq = () => ++subagentSeq;
  let hasToolSideEffects = false;

  const noopCallbacks: AgentToolCallbacks = {
    onToolCallStart: (toolCallId, toolName) => {
      hasToolSideEffects = true;
      journal.recordEvent({
        runId, seq: nextSubagentSeq(), type: "tool_call",
        toolCallId, toolName,
      });
    },
    onToolCallEnd: (toolCallId, result, durationMs) => {
      journal.recordEvent({
        runId, seq: nextSubagentSeq(), type: "tool_result",
        toolCallId,
        resultText: typeof result === "string" ? result : JSON.stringify(result),
        durationMs,
      });
    },
  };
  const generateToolCallId = createToolCallIdFactory({
    runId,
    getTurnIndex: () => turnIndex,
    toolCallCounters,
  });

  const tools = createAgentTools({
    runId,
    agentType,
    storageMode,
    toolsAllowlist: agentContext.toolsAllowlist,
    toolExecutor,
    deviceId,
    conversationId,
    callbacks: noopCallbacks,
    generateToolCallId,
  });

  const remoteTools = enableRemoteTools
    ? createRemoteTools({
        convexUrl,
        authToken,
        conversationId,
        agentType,
        mode: storageMode,
        ...(storageMode === "local"
          ? {
            localMemory: {
              stellaHome,
              proxyBaseUrl,
              proxyToken: agentContext.proxyToken.token,
              rerankModelId: "openai/gpt-4.1-mini",
              localHistory: historyForLocalMemory,
            },
          }
          : {}),
      })
    : {};

  const systemPrompt = agentContext.systemPrompt;
  const messages: ModelMessage[] = [
    { role: "user", content: `${taskDescription}\n\n${taskPrompt}` },
  ];

  const runGenerateWithModel = async (modelId: string) => {
    const gatewayKey = (agentContext as Record<string, unknown>).gatewayApiKey as string | undefined;
    const model = gatewayKey
      ? createGatewayModel(gatewayKey, modelId)
      : createProxiedModel(proxyBaseUrl, agentContext.proxyToken.token, modelId);
    return await generateText({
      model,
      system: systemPrompt,
      messages,
      tools: { ...tools, ...remoteTools } as Record<string, Tool>,
      stopWhen: stepCountIs(MAX_TURNS),
      abortSignal: signal,
      onStepFinish: () => {
        turnIndex++;
        toolCallCounters.clear();
      },
    });
  };

  try {
    const result = await runWithFallbackModel({
      runWithModel: runGenerateWithModel,
      primaryModelId,
      fallbackModelId,
      shouldFallback: (error) =>
        !signal.aborted &&
        !hasToolSideEffects &&
        isRetryableModelError(error),
      onFallback: (_error, resolvedFallbackModelId) => {
        journal.recordEvent({
          runId,
          seq: nextSubagentSeq(),
          type: "status_update",
          errorText: `Primary model failed (${primaryModelId}). Retrying fallback (${resolvedFallbackModelId}).`,
        });
      },
    });

    journal.completeRun(runId);
    clearTimeout(timeoutId);

    if (persistToConvex) {
      await persistRunToConvex({
        journal,
        runId,
        conversationId,
        agentType,
        convexUrl,
        authToken,
        fullText: result.text,
        usage: {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        },
        activeThreadId: agentContext.activeThreadId,
      });
    }

    journal.close();
    return { runId, result: result.text };
  } catch (error) {
    journal.markRunCrashed(runId);
    clearTimeout(timeoutId);
    journal.close();
    return { runId, result: "", error: (error as Error).message };
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

type PersistOpts = {
  journal: RunJournal;
  runId: string;
  conversationId: string;
  agentType: string;
  convexUrl: string;
  authToken: string;
  fullText: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  activeThreadId?: string;
};

async function persistRunToConvex(opts: PersistOpts): Promise<void> {
  const { journal, runId, conversationId, agentType, convexUrl, authToken } = opts;

  // Collect all events from journal
  const events = journal.getRunEvents(runId);
  if (events.length === 0 && !opts.fullText) return;

  // Build chunks
  const chunks: Array<{
    chunkIndex: number;
    chunkKey: string;
    isFinal: boolean;
    events: typeof events;
    assistantText?: string;
    usage?: typeof opts.usage;
  }> = [];

  let currentChunk: typeof events = [];
  let currentSize = 0;
  let chunkIndex = 0;

  for (const event of events) {
    const eventSize = JSON.stringify(event).length;
    if (
      currentChunk.length > 0 &&
      (currentChunk.length >= PERSIST_CHUNK_MAX_EVENTS || currentSize + eventSize > PERSIST_CHUNK_MAX_BYTES)
    ) {
      const startSeq = currentChunk[0]!.seq;
      const endSeq = currentChunk[currentChunk.length - 1]!.seq;
      chunks.push({
        chunkIndex,
        chunkKey: `${runId}:seq:${startSeq}-${endSeq}`,
        isFinal: false,
        events: currentChunk,
      });
      chunkIndex++;
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(event);
    currentSize += eventSize;
  }

  // Final chunk includes assistant text and usage
  if (currentChunk.length > 0) {
    const startSeq = currentChunk[0]!.seq;
    const endSeq = currentChunk[currentChunk.length - 1]!.seq;
    chunks.push({
      chunkIndex,
      chunkKey: `${runId}:seq:${startSeq}-${endSeq}`,
      isFinal: true,
      events: currentChunk,
      assistantText: opts.fullText,
      usage: opts.usage,
    });
  } else {
    // No events in this chunk but we have final data
    chunks.push({
      chunkIndex,
      chunkKey: `${runId}:final`,
      isFinal: true,
      events: [],
      assistantText: opts.fullText,
      usage: opts.usage,
    });
  }

  // Persist each chunk via Convex HTTP
  const baseUrl = convexUrl.replace(/\/+$/, "");
  const failedChunks: string[] = [];
  const truncationSuffix = "\n\n[Assistant text truncated for persistence limit]";

  for (const chunk of chunks) {
    const serializedEvents = chunk.events.map((e) => ({
      type: e.type,
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      argsPreview: e.argsJson?.slice(0, 200),
      resultPreview: e.resultText?.slice(0, 200),
      errorText: e.errorText,
      durationMs: e.durationMs,
      timestamp: e.createdAt,
    }));

    const buildPayload = (assistantText?: string) => ({
      runId,
      chunkKey: chunk.chunkKey,
      chunkIndex: chunk.chunkIndex,
      isFinal: chunk.isFinal,
      events: serializedEvents,
      assistantText,
      usage: chunk.usage,
      conversationId,
      agentType,
      activeThreadId: opts.activeThreadId,
    });

    let assistantText = chunk.assistantText;
    let payload = buildPayload(assistantText);
    let payloadSize = JSON.stringify(payload).length;

    if (chunk.isFinal && assistantText && payloadSize > PERSIST_CHUNK_MAX_BYTES) {
      let candidate = assistantText;
      while (candidate.length > 0 && payloadSize > PERSIST_CHUNK_MAX_BYTES) {
        candidate = candidate.slice(0, Math.max(0, Math.floor(candidate.length * 0.8)));
        assistantText =
          candidate.length > 0
            ? `${candidate}${truncationSuffix}`
            : undefined;
        payload = buildPayload(assistantText);
        payloadSize = JSON.stringify(payload).length;
      }
    }

    if (payloadSize > PERSIST_CHUNK_MAX_BYTES) {
      // Last-resort guardrail: avoid repeatedly failing persistence with oversized payloads.
      throw new Error(`Persist payload exceeds ${PERSIST_CHUNK_MAX_BYTES} bytes for ${chunk.chunkKey}`);
    }

    journal.addPendingPersist({
      runId,
      chunkIndex: chunk.chunkIndex,
      chunkKey: chunk.chunkKey,
      payloadJson: JSON.stringify(payload),
    });

    // Send to Convex
    try {
      const response = await fetch(`${baseUrl}/api/mutation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          path: "agent/tasks:batchPersistRunChunk",
          args: payload,
        }),
      });

      if (response.ok) {
        journal.markPersisted(chunk.chunkKey);
      } else {
        failedChunks.push(chunk.chunkKey);
        console.error(
          `[agent-runtime] Persist chunk ${chunk.chunkKey} failed: ${response.status}`,
        );
      }
    } catch (err) {
      failedChunks.push(chunk.chunkKey);
      console.error(`[agent-runtime] Persist chunk ${chunk.chunkKey} error:`, err);
    }
  }

  if (failedChunks.length > 0) {
    throw new Error(`Failed to persist ${failedChunks.length} chunk(s)`);
  }

  journal.markRunPersisted(runId);
}

