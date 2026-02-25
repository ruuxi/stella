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

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, type CoreMessage, type LanguageModel, type Tool } from "ai";
import crypto from "crypto";
import { RunJournal } from "./run_journal.js";
import { createAgentTools, type AgentToolCallbacks } from "./agent_tools.js";
import { createRemoteTools } from "./remote_tools.js";
import type { ToolContext, ToolResult } from "./tools-types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AgentContext = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
  coreMemory?: string;
  threadHistory?: Array<{ role: string; content: string; toolCallId?: string }>;
  activeThreadId?: string;
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
};

export type RunOrchestratorOpts = {
  conversationId: string;
  userMessageId: string;
  agentType?: string;
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

// ─── Proxy Fetch ─────────────────────────────────────────────────────────────

/**
 * Creates a custom fetch wrapper that injects proxy auth for requests
 * to our Convex LLM proxy. ONLY adds auth for same-origin requests.
 */
function createProxyFetch(
  proxyBaseUrl: string,
  proxyToken: string,
  provider: string,
  modelId: string,
) {
  const proxyOrigin = new URL(proxyBaseUrl).origin;

  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const targetUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const target = new URL(targetUrl);

    if (target.origin === proxyOrigin) {
      // Extract the path suffix that the provider SDK appended
      const fullPath = target.pathname;
      // The provider SDK sends to baseURL + /v1/messages (Anthropic) or /v1/chat/completions (OpenAI)
      // We need to forward this path to the upstream
      const headers = new Headers(init?.headers);
      headers.set("X-Proxy-Token", proxyToken);
      headers.set("X-Provider", provider);
      headers.set("X-Original-Path", fullPath.replace(/^\/api\/ai\/llm-proxy\/?/, "/"));
      headers.set("X-Model-Id", modelId);

      // Rewrite URL to the single proxy endpoint
      const proxyUrl = `${proxyOrigin}/api/ai/llm-proxy`;
      return fetch(proxyUrl, { ...init, headers });
    }

    return fetch(url, init);
  };
}

/**
 * Creates an AI SDK model instance that routes through our LLM proxy.
 */
function createProxiedModel(
  proxyBaseUrl: string,
  proxyToken: string,
  modelId: string,
): LanguageModel {
  const provider = modelId.split("/")[0] ?? "anthropic";
  const modelName = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  const customFetch = createProxyFetch(proxyBaseUrl, proxyToken, provider, modelId);

  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({
        baseURL: `${proxyBaseUrl}/api/ai/llm-proxy`,
        fetch: customFetch,
        apiKey: "proxy-managed", // Placeholder — real key injected by proxy
      });
      return anthropic(modelName);
    }
    case "openai":
    case "openrouter":
    case "moonshotai":
    case "zai":
    default: {
      const openai = createOpenAI({
        baseURL: `${proxyBaseUrl}/api/ai/llm-proxy`,
        fetch: customFetch,
        apiKey: "proxy-managed",
      });
      return openai(modelId); // Full model ID for gateway routing
    }
  }
}

// ─── Tool Call ID Generation ─────────────────────────────────────────────────

function hashArgs(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function generateToolCallId(
  runId: string,
  turnIndex: number,
  toolName: string,
  args: Record<string, unknown>,
  ordinal: number,
): string {
  const argsHash = hashArgs(args);
  return `${runId}:${turnIndex}:${toolName}:${argsHash}:${ordinal}`;
}

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
  } = opts;

  const agentType = opts.agentType ?? "orchestrator";
  const runId = `local:${crypto.randomUUID()}`;
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

  // Build model
  const proxyBaseUrl = convexUrl.replace(/\/+$/, "");
  const model = createProxiedModel(
    proxyBaseUrl,
    agentContext.proxyToken.token,
    "anthropic/claude-opus-4.6", // Default model
  );

  // Build tools
  const toolCallCounters = new Map<string, number>(); // track ordinals per turn+tool+args combo
  let turnIndex = 0;

  const toolCallbacks: AgentToolCallbacks = {
    onToolCallStart: (toolCallId, toolName) => {
      const s = nextSeq();
      callbacks.onToolStart({ runId, seq: s, toolCallId, toolName });
      journal.recordEvent({
        runId, seq: s, type: "tool_call",
        toolCallId, toolName,
      });
    },
    onToolCallEnd: (toolCallId, result, durationMs) => {
      const preview = typeof result === "string"
        ? result.slice(0, MAX_RESULT_PREVIEW_LEN)
        : JSON.stringify(result).slice(0, MAX_RESULT_PREVIEW_LEN);
      const s = nextSeq();
      callbacks.onToolEnd({ runId, seq: s, toolCallId, resultPreview: preview });
      journal.recordEvent({
        runId, seq: s, type: "tool_result",
        toolCallId,
        resultText: typeof result === "string" ? result : JSON.stringify(result),
        durationMs,
      });
    },
  };

  const tools = createAgentTools({
    runId,
    agentType,
    toolsAllowlist: agentContext.toolsAllowlist,
    toolExecutor,
    deviceId,
    conversationId,
    callbacks: toolCallbacks,
    generateToolCallId: (toolName, args) => {
      const key = `${turnIndex}:${toolName}:${hashArgs(args)}`;
      const ordinal = toolCallCounters.get(key) ?? 0;
      toolCallCounters.set(key, ordinal + 1);
      return generateToolCallId(runId, turnIndex, toolName, args, ordinal);
    },
  });

  // Add remote tools (RecallMemories, etc.)
  const remoteTools = createRemoteTools({
    convexUrl,
    authToken,
    conversationId,
    agentType,
  });

  const allTools = { ...tools, ...remoteTools };

  // Build messages
  const messages: CoreMessage[] = [];

  // Add thread history if available
  if (agentContext.threadHistory) {
    for (const msg of agentContext.threadHistory) {
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

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools: allTools as Record<string, Tool>,
      maxSteps: MAX_TURNS,
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
    const finalResult = await result;
    usage = {
      inputTokens: finalResult.usage?.promptTokens,
      outputTokens: finalResult.usage?.completionTokens,
    };
    if (!fullText && finalResult.text) {
      fullText = finalResult.text;
    }
  } catch (error) {
    if (signal.aborted) {
      const s = nextSeq();
      callbacks.onError({ runId, seq: s, error: "Run aborted", fatal: true });
    } else {
      const s = nextSeq();
      const errMsg = (error as Error).message ?? "Unknown error";
      callbacks.onError({ runId, seq: s, error: errMsg, fatal: true });
      journal.recordEvent({ runId, seq: s, type: "status_update", errorText: errMsg });
    }
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

  const s = nextSeq();
  callbacks.onEnd({ runId, seq: s, finalText: fullText, persisted });
  journal.close();
  return runId;
}

// ─── Subagent Turn ───────────────────────────────────────────────────────────

export type RunSubagentOpts = Omit<RunOrchestratorOpts, "callbacks"> & {
  taskDescription: string;
  taskPrompt: string;
};

export async function runSubagentTask(opts: RunSubagentOpts): Promise<{
  runId: string;
  result: string;
  error?: string;
}> {
  const {
    conversationId,
    agentContext,
    toolExecutor,
    convexUrl,
    authToken,
    deviceId,
    stellaHome,
    abortSignal,
    taskDescription,
    taskPrompt,
  } = opts;

  const agentType = opts.agentType ?? "general";
  const runId = `local:sub:${crypto.randomUUID()}`;

  const journal = new RunJournal(stellaHome);
  journal.startRun({ runId, conversationId, agentType });

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), SUBAGENT_TIMEOUT_MS);
  const signal = abortSignal
    ? combineAbortSignals(abortSignal, timeoutController.signal)
    : timeoutController.signal;

  const proxyBaseUrl = convexUrl.replace(/\/+$/, "");
  const model = createProxiedModel(
    proxyBaseUrl,
    agentContext.proxyToken.token,
    "anthropic/claude-opus-4.6",
  );

  let turnIndex = 0;
  const toolCallCounters = new Map<string, number>();

  const noopCallbacks: AgentToolCallbacks = {
    onToolCallStart: (toolCallId, toolName) => {
      journal.recordEvent({
        runId, seq: 0, type: "tool_call",
        toolCallId, toolName,
      });
    },
    onToolCallEnd: (toolCallId, result, durationMs) => {
      journal.recordEvent({
        runId, seq: 0, type: "tool_result",
        toolCallId,
        resultText: typeof result === "string" ? result : JSON.stringify(result),
        durationMs,
      });
    },
  };

  const tools = createAgentTools({
    runId,
    agentType,
    toolsAllowlist: agentContext.toolsAllowlist,
    toolExecutor,
    deviceId,
    conversationId,
    callbacks: noopCallbacks,
    generateToolCallId: (toolName, args) => {
      const key = `${turnIndex}:${toolName}:${hashArgs(args)}`;
      const ordinal = toolCallCounters.get(key) ?? 0;
      toolCallCounters.set(key, ordinal + 1);
      return generateToolCallId(runId, turnIndex, toolName, args, ordinal);
    },
  });

  const remoteTools = createRemoteTools({
    convexUrl,
    authToken,
    conversationId,
    agentType,
  });

  const systemPrompt = agentContext.systemPrompt;
  const messages: CoreMessage[] = [
    { role: "user", content: `${taskDescription}\n\n${taskPrompt}` },
  ];

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools: { ...tools, ...remoteTools } as Record<string, Tool>,
      maxSteps: MAX_TURNS,
      abortSignal: signal,
      onStepFinish: () => {
        turnIndex++;
        toolCallCounters.clear();
      },
    });

    journal.completeRun(runId);
    clearTimeout(timeoutId);

    await persistRunToConvex({
      journal,
      runId,
      conversationId,
      agentType,
      convexUrl,
      authToken,
      fullText: result.text,
      usage: {
        inputTokens: result.usage?.promptTokens,
        outputTokens: result.usage?.completionTokens,
      },
      activeThreadId: agentContext.activeThreadId,
    });

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

  for (const chunk of chunks) {
    // Record in journal for crash recovery
    const payload = {
      runId,
      chunkKey: chunk.chunkKey,
      chunkIndex: chunk.chunkIndex,
      isFinal: chunk.isFinal,
      events: chunk.events.map((e) => ({
        type: e.type,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        argsPreview: e.argsJson?.slice(0, 200),
        resultPreview: e.resultText?.slice(0, 200),
        errorText: e.errorText,
        durationMs: e.durationMs,
        timestamp: e.createdAt,
      })),
      assistantText: chunk.assistantText,
      usage: chunk.usage,
      conversationId,
      agentType,
      ownerId: "", // Will be resolved by the mutation
      activeThreadId: opts.activeThreadId,
    };

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
        console.error(
          `[agent-runtime] Persist chunk ${chunk.chunkKey} failed: ${response.status}`,
        );
      }
    } catch (err) {
      console.error(`[agent-runtime] Persist chunk ${chunk.chunkKey} error:`, err);
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
