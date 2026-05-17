import os from "os";
import { Type } from "@sinclair/typebox";
import { Agent } from "../agent-core/agent.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "../agent-core/types.js";
import type { Message } from "../../ai/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import { selectRecentByTokenBudget } from "../local-history.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { estimateRuntimeTokens } from "../runtime-threads.js";
import {
  getAgentSteeringMode,
  getLocalCliWorkingDirectory,
} from "../../contracts/agent-runtime.js";
import { stripStaleImageBlocks } from "./thread-memory.js";

const MAX_RESULT_PREVIEW = 200;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const CONTEXT_PRUNE_RESERVE_TOKENS = 16_384;
const MIN_CONTEXT_PRUNE_TOKENS = 8_000;
const ESTIMATED_IMAGE_TOKENS = 2_000;

export const DEFAULT_MAX_TURNS = 40;

export const PI_AGENT_MESSAGE_FILTER = (messages: AgentMessage[]): Message[] =>
  messages.flatMap((msg): Message[] => {
    if (
      msg.role === "user" ||
      msg.role === "assistant" ||
      msg.role === "toolResult"
    ) {
      return [msg];
    }
    if (msg.role === "runtimeInternal") {
      return [
        {
          role: "user",
          content: msg.content,
          timestamp: msg.timestamp,
        },
      ];
    }
    return [];
  });

export const AnyToolArgsSchema = Type.Object(
  {},
  { additionalProperties: true },
);

export const now = () => Date.now();

export const resolveLocalCliCwd = ({
  agentType,
  stellaRoot,
}: {
  agentType: string;
  stellaRoot?: string;
}): string | undefined => {
  if (getLocalCliWorkingDirectory(agentType) === "home") {
    const homeDirectory = os.homedir().trim();
    if (homeDirectory) {
      return homeDirectory;
    }
  }
  const normalizedStellaRoot = stellaRoot?.trim();
  return normalizedStellaRoot && normalizedStellaRoot.length > 0
    ? normalizedStellaRoot
    : undefined;
};

export const textFromUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const textFromToolLikeValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (record.details && typeof record.details === "object") {
      const details = record.details as Record<string, unknown>;
      if (typeof details.text === "string") {
        return details.text;
      }
    }
  }
  return textFromUnknown(value);
};

export const getToolResultPreview = (
  _toolName: string,
  result: unknown,
): string => textFromToolLikeValue(result).slice(0, MAX_RESULT_PREVIEW);

export const toAgentMessages = (
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
        return (
          sum +
          estimateRuntimeTokens(
            typeof candidate.text === "string" ? candidate.text : "",
          )
        );
      case "thinking":
        return (
          sum +
          estimateRuntimeTokens(
            typeof candidate.thinking === "string" ? candidate.thinking : "",
          )
        );
      case "image":
        return sum + ESTIMATED_IMAGE_TOKENS;
      case "toolCall":
        return (
          sum +
          estimateUnknownTokens({
            name: candidate.name,
            arguments: candidate.arguments,
          })
        );
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
  const safeContextWindow =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.max(
    MIN_CONTEXT_PRUNE_TOKENS,
    safeContextWindow - CONTEXT_PRUNE_RESERVE_TOKENS,
  );
};

export const buildDefaultTransformContext = (
  resolvedLlm: ResolvedLlmRoute,
): ((
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>) => {
  const maxTokens = getContextPruneBudget(resolvedLlm);
  return async (messages, signal) => {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
    // Strip on every per-turn call. `buildHistorySource` already runs this
    // once at run start, but the agent loop appends fresh tool results
    // (each carrying a base64 PNG) into the live messages array between
    // LLM calls. Without re-stripping, all those screenshots stack up in
    // the prompt every subsequent turn, and a 4-step stella-computer task
    // overflows the managed runtime's payload budget.
    const stripped = stripStaleImageBlocks(messages);
    const totalTokens = stripped.reduce(
      (sum, message) => sum + estimateAgentMessageTokens(message),
      0,
    );
    if (totalTokens <= maxTokens) {
      return stripped;
    }
    const selected = selectRecentByTokenBudget({
      itemsNewestFirst: [...stripped].reverse(),
      maxTokens,
      estimateTokens: estimateAgentMessageTokens,
    });
    return [...selected].reverse();
  };
};

export const extractAssistantText = (
  message: AgentMessage | undefined,
): string => {
  if (!message || message.role !== "assistant") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
};

const getLatestAssistantMessage = (
  messages: AgentMessage[],
): AgentMessage | undefined =>
  [...messages].reverse().find((message) => message.role === "assistant");

type AgentCompletionSource = {
  state: Pick<Agent["state"], "messages" | "error">;
};

export const getAgentCompletion = (
  agent: AgentCompletionSource,
): { finalText: string; errorMessage?: string } => {
  const latestAssistant = getLatestAssistantMessage(agent.state.messages);
  const finalText = extractAssistantText(latestAssistant);

  if (latestAssistant?.role === "assistant") {
    const assistantError = latestAssistant.errorMessage?.trim();
    if (
      latestAssistant.stopReason === "error" ||
      latestAssistant.stopReason === "aborted"
    ) {
      return {
        finalText,
        errorMessage:
          assistantError ||
          agent.state.error ||
          (latestAssistant.stopReason === "aborted"
            ? "Request was aborted"
            : "Agent failed"),
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

export const createBeforeProviderPayloadTransform = (
  hookEmitter: HookEmitter | undefined,
  agentType: string,
) =>
  hookEmitter
    ? async (payload: unknown, model: { id: string }) => {
        const result = await hookEmitter.emit("before_provider_request", {
          agentType,
          model: model.id,
          payload,
        });
        return result?.payload;
      }
    : undefined;

export const createRuntimeAgent = (args: {
  agentType: string;
  systemPrompt: string;
  resolvedLlm: ResolvedLlmRoute;
  /**
   * Optional dynamic resolver for the current `ResolvedLlmRoute`. When
   * provided, the Agent's `getApiKey`/`refreshApiKey`/`transformContext`
   * closures read from this getter on every call instead of capturing
   * `args.resolvedLlm` at construction time. Long-lived sessions
   * (`OrchestratorSession`) pass this so the user can switch models
   * mid-conversation: update the ref + `agent.state.model`, and the next
   * provider call uses the new credentials, base URL, and context-window
   * budget. Per-turn callers can omit this and the static `resolvedLlm` is
   * used for the lifetime of the run.
   */
  resolvedLlmOverride?: () => ResolvedLlmRoute;
  reasoningEffort?: ThinkingLevel;
  hookEmitter?: HookEmitter;
  tools: AgentTool[];
  historySource: AgentMessage[];
  /**
   * Stable identifier used for upstream prompt-cache routing affinity
   * (Anthropic ephemeral cache, OpenAI/Fireworks `prompt_cache_key`, etc.).
   * Pass the threadKey or agentType so repeated turns within the same
   * conversation hit the same cache shard.
   */
  cacheSessionId?: string;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) =>
    | Promise<AfterToolCallResult | undefined>
    | AfterToolCallResult
    | undefined;
  /**
   * Surface a transient "trying again in X" status when the provider
   * adapter retries a recoverable failure. Sessions wire this to a STATUS
   * event so the desktop can show a brief retry toast.
   */
  onProviderRetry?: (info: {
    attempt: number;
    delayMs: number;
    reason?: string;
  }) => void;
}): Agent => {
  const resolveLlm = args.resolvedLlmOverride ?? (() => args.resolvedLlm);
  return new Agent({
    initialState: {
      systemPrompt: args.systemPrompt,
      model: resolveLlm().model,
      thinkingLevel:
        args.reasoningEffort ??
        resolveAgentThinkingLevel({ resolvedLlm: args.resolvedLlm }),
      tools: args.tools,
      messages: args.historySource,
    },
    sessionId: args.cacheSessionId ?? args.agentType,
    convertToLlm: PI_AGENT_MESSAGE_FILTER,
    // Recompute the context budget against the current model route.
    transformContext: async (messages, signal) =>
      buildDefaultTransformContext(resolveLlm())(messages, signal),
    // Only pass steering mode when the agent opts out of the Pi default.
    ...(getAgentSteeringMode(args.agentType) === "all"
      ? { steeringMode: "all" as const }
      : {}),
    getApiKey: () => resolveLlm().getApiKey(),
    // Always defined when an override is in play, since the *current*
    // route may have a refresher even if the original didn't (and vice
    // versa). The inner `?.()` returns `undefined` when the route lacks
    // one, which the agent loop already handles.
    refreshApiKey: () => resolveLlm().refreshApiKey?.(),
    onPayload: createBeforeProviderPayloadTransform(
      args.hookEmitter,
      args.agentType,
    ),
    onProviderRetry: args.onProviderRetry,
    afterToolCall: args.afterToolCall
      ? async (context, signal) => await args.afterToolCall?.(context, signal)
      : undefined,
  });
};

/**
 * Resolve the `thinkingLevel` an Agent should run with for a given turn.
 *
 * Long-lived sessions refresh this between turns when the user changes
 * reasoning-effort preferences or model routes.
 */
export const resolveAgentThinkingLevel = (args: {
  resolvedLlm: ResolvedLlmRoute;
  agentContextReasoningEffort?: Exclude<ThinkingLevel, "off"> | "default";
}): ThinkingLevel => {
  if (
    args.agentContextReasoningEffort &&
    args.agentContextReasoningEffort !== "default"
  ) {
    return args.agentContextReasoningEffort;
  }
  return args.resolvedLlm.model.reasoning ? "medium" : "off";
};
