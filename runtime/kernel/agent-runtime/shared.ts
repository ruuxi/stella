import os from "os";
import path from "path";
import { Type } from "@sinclair/typebox";
import { Agent } from "../agent-core/agent.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "../agent-core/types.js";
import type { Message, ServiceTier } from "../../ai/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
// @ts-expect-error JavaScript runtime module intentionally has no declarations.
import { preflightProviderPayload } from "./context-budget.js";
import {
  getAgentFollowUpMode,
  getAgentSteeringMode,
  getLocalCliWorkingDirectory,
} from "../../contracts/agent-runtime.js";

const MAX_RESULT_PREVIEW = 200;
const IMAGE_DESCRIPTION_CUSTOM_TYPE = "vision.image_description";

export const DEFAULT_MAX_TURNS = 40;

export const PI_AGENT_MESSAGE_FILTER = (
  messages: AgentMessage[],
): Message[] => {
  const result: Message[] = [];
  for (const msg of messages) {
    if (
      msg.role === "user" ||
      msg.role === "assistant" ||
      msg.role === "toolResult"
    ) {
      result.push(msg);
      continue;
    }
    if (msg.role === "runtimeInternal") {
      const previous = result.at(-1);
      if (
        msg.customType === IMAGE_DESCRIPTION_CUSTOM_TYPE &&
        previous?.role === "user" &&
        Array.isArray(previous.content) &&
        previous.content.some((block) => block.type === "image")
      ) {
        const descriptionContent =
          typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content }]
            : msg.content;
        result[result.length - 1] = {
          ...previous,
          content: [...previous.content, ...descriptionContent],
        };
        continue;
      }
      result.push({
        role: "user",
        content: msg.content,
        timestamp: msg.timestamp,
      });
    }
  }
  return result;
};

export const AnyToolArgsSchema = Type.Object(
  {},
  { additionalProperties: true },
);

export const now = () => Date.now();

const expandWorkingDirectory = (
  value: string,
  homeDirectory: string,
): string => {
  if (value === "~") return homeDirectory;
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
};

/**
 * Resolve the filesystem root an agent should operate from. The install root
 * remains a separate absolute path for bundled assets; it is only selected
 * here for the legacy `frontend` mode or as a last-resort fallback when the
 * platform does not expose a home directory.
 */
export const resolveLocalCliCwd = ({
  agentType,
  stellaAppDir,
  workingDirectory,
}: {
  agentType: string;
  stellaAppDir?: string;
  workingDirectory?: string;
}): string | undefined => {
  const homeDirectory = os.homedir().trim();
  const explicitWorkingDirectory = workingDirectory?.trim();
  if (explicitWorkingDirectory) {
    return path.resolve(
      expandWorkingDirectory(explicitWorkingDirectory, homeDirectory),
    );
  }
  if (getLocalCliWorkingDirectory(agentType) !== "frontend" && homeDirectory) {
    return path.resolve(homeDirectory);
  }
  const normalizedStellaAppDir = stellaAppDir?.trim();
  return normalizedStellaAppDir && normalizedStellaAppDir.length > 0
    ? normalizedStellaAppDir
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
    if (typeof record.result === "string") {
      return record.result;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
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

/**
 * True when an assistant message carries at least one tool call. Such a
 * message is *interim* — the agent loop runs the tools and then produces a
 * further message — so any visible preamble text it contains is not the
 * final answer. The working indicator uses this to avoid handing off (and
 * disappearing) between a preamble and the tool call it precedes.
 */
export const assistantMessageHasToolCall = (
  message: AgentMessage | undefined,
): boolean => {
  if (!message || message.role !== "assistant") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.some((block) => block.type === "toolCall");
};

const getLatestAssistantMessage = (
  messages: AgentMessage[],
): AgentMessage | undefined =>
  [...messages].reverse().find((message) => message.role === "assistant");

type AgentCompletionSource = {
  state: Pick<Agent["state"], "messages" | "error">;
};

/**
 * True when the run's final assistant message is a truncated reasoning
 * trace: `stopReason: "length"` with neither visible text nor a tool call
 * (typically thinking-only). The provider hit its output-token cap while
 * the model was still reasoning, so no reply was ever produced. This is a
 * failure, not a success — without this check the run would finalize as
 * "success" with an empty result and surface only the generic
 * empty-result sentinel to the caller.
 */
const isTruncatedReasoningCompletion = (
  message: AgentMessage | undefined,
): message is Extract<AgentMessage, { role: "assistant" }> => {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "length") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return !blocks.some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && block.text.trim().length > 0),
  );
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

    if (isTruncatedReasoningCompletion(latestAssistant)) {
      const outputTokens = latestAssistant.usage?.output;
      return {
        finalText,
        errorMessage: `Run truncated: model hit the output-token cap${
          outputTokens ? ` (${outputTokens} tokens)` : ""
        } while reasoning; no visible reply was produced.`,
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
   * Per-agent session identifier used for transport resources and provider
   * session headers. Keep this unique for independently running agents.
   */
  cacheSessionId?: string;
  /** Stable cache affinity shared by sibling agents in one conversation. */
  promptCacheKey?: string;
  /** Provider request tier, currently used for ChatGPT/Codex Fast mode. */
  serviceTier?: ServiceTier;
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
  const toolInactivityRaw =
    process.env.STELLA_TOOL_INACTIVITY_TIMEOUT_MS?.trim();
  const toolInactivityParsed = toolInactivityRaw
    ? Number(toolInactivityRaw)
    : Number.NaN;
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
    promptCacheKey: args.promptCacheKey,
    serviceTier: args.serviceTier,
    // Per-tool inactivity bound (default 10 min in agent-core): a tool that
    // goes fully silent is cancelled with an error tool result instead of
    // tripping the run-level idle watchdog and killing the whole agent.
    ...(Number.isFinite(toolInactivityParsed)
      ? { toolInactivityTimeoutMs: toolInactivityParsed }
      : {}),
    convertToLlm: PI_AGENT_MESSAGE_FILTER,
    // Only pass steering / follow-up modes when the agent opts out of
    // the Pi default ("one-at-a-time").
    ...(getAgentSteeringMode(args.agentType) === "all"
      ? { steeringMode: "all" as const }
      : {}),
    ...(getAgentFollowUpMode(args.agentType) === "all"
      ? { followUpMode: "all" as const }
      : {}),
    getApiKey: () => resolveLlm().getApiKey(),
    // Always defined when an override is in play, since the *current*
    // route may have a refresher even if the original didn't (and vice
    // versa). The inner `?.()` returns `undefined` when the route lacks
    // one, which the agent loop already handles.
    refreshApiKey: () => resolveLlm().refreshApiKey?.(),
    onPayload: async (payload, model) => {
      const transform = createBeforeProviderPayloadTransform(
        args.hookEmitter,
        args.agentType,
      );
      const transformed = await transform?.(payload, model);
      const finalPayload = transformed ?? payload;
      preflightProviderPayload(
        args.cacheSessionId ?? args.agentType,
        finalPayload,
        model,
      );
      return transformed;
    },
    onProviderRetry: args.onProviderRetry,
    // The runtime's four-attempt policy owns empty completions. Leaving the
    // Agent core's default one-shot enabled here would allow every outer
    // attempt to make two provider calls.
    degenerateResponseRetries: 0,
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
