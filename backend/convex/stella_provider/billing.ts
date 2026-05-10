/**
 * Stella provider — billing, usage normalization, and per-device
 * anonymous rate-limit bookkeeping.
 *
 * Pulled out of `stella_provider.ts` so the three streaming /
 * authorization / request-shaping concerns stop reaching for the
 * billing helpers via large mixed imports.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "../http_shared/anon_device";
import {
  assistantText,
  completeManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";

export type TokenEstimate = {
  inputTokens: number;
  outputTokens: number;
};

export type ManagedBillingUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
};

export type AnonymousUsageRecord = {
  deviceId: string;
  clientAddressKey?: string;
};

/**
 * Per-anonymous-device cap on the Stella provider endpoint. Each call
 * runs a managed-LLM completion that Stella pays for, so this stays
 * enforced server-side.
 */
export const MAX_ANON_REQUESTS = 1;
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const STELLA_MODELS_RATE_LIMIT = 60;
export const STELLA_MODELS_RATE_WINDOW_MS = 60_000;

export async function checkDeviceRateLimit(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  try {
    const usage = await ctx.runQuery(
      internal.ai_proxy_data.getDeviceUsage,
      {
        deviceId,
        nowMs: Date.now(),
        clientAddressKey: clientAddressKey ?? undefined,
      },
    );
    return (usage?.requestCount ?? 0) < MAX_ANON_REQUESTS;
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) {
      throw error;
    }
    logMissingSaltOnce("stella-provider");
    return false;
  }
}

export async function consumeAnonymousRequestAllowance(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  try {
    const usage = await ctx.runMutation(
      internal.ai_proxy_data.consumeDeviceAllowance,
      {
        deviceId,
        maxRequests: MAX_ANON_REQUESTS,
        clientAddressKey: clientAddressKey ?? undefined,
      },
    );
    return usage.allowed;
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) {
      throw error;
    }
    logMissingSaltOnce("stella-provider");
    return false;
  }
}

export const scheduleAnonymousUsageRecord = async (
  ctx: ActionCtx,
  record: AnonymousUsageRecord | undefined,
): Promise<void> => {
  if (!record) return;
  try {
    await ctx.scheduler.runAfter(0, internal.ai_proxy_data.incrementDeviceUsage, {
      deviceId: record.deviceId,
      clientAddressKey: record.clientAddressKey,
    });
  } catch (error) {
    if (isAnonDeviceHashSaltMissingError(error)) {
      logMissingSaltOnce("stella-provider");
      return;
    }
    console.error("[stella-provider] Failed to record anonymous usage", error);
  }
};

export function toManagedBillingUsage(
  message: Parameters<typeof usageSummaryFromAssistant>[0],
  estimate: TokenEstimate,
): ManagedBillingUsage {
  const usage = usageSummaryFromAssistant(message);

  return {
    inputTokens: usage?.inputTokens ?? estimate.inputTokens,
    outputTokens: usage?.outputTokens ?? estimate.outputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens,
    reasoningTokens: usage?.reasoningTokens,
  };
}

export function toOpenAIUsage(args: {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}) {
  const promptTokens = args.inputTokens;
  const completionTokens = args.outputTokens;
  return {
    input_tokens: args.inputTokens,
    prompt_tokens: promptTokens,
    output_tokens: completionTokens,
    completion_tokens: completionTokens,
    total_tokens: args.totalTokens ?? promptTokens + completionTokens,
    ...(typeof args.cachedInputTokens === "number"
      ? {
          prompt_tokens_details: {
            cached_tokens: args.cachedInputTokens,
          },
        }
      : {}),
    ...(typeof args.reasoningTokens === "number"
      ? {
          completion_tokens_details: {
            reasoning_tokens: args.reasoningTokens,
          },
        }
      : {}),
  };
}

export function mapStopReason(
  stopReason: string,
): "stop" | "length" | "tool_calls" {
  switch (stopReason) {
    case "length":
      return "length";
    case "toolUse":
      return "tool_calls";
    default:
      return "stop";
  }
}

function assistantReasoningContent(
  message: Awaited<ReturnType<typeof completeManagedChat>>,
): string | null {
  const reasoning = message.content
    .filter(
      (part): part is { type: "thinking"; thinking: string } =>
        part.type === "thinking" && typeof part.thinking === "string",
    )
    .map((part) => part.thinking)
    .join("\n")
    .trim();
  return reasoning.length > 0 ? reasoning : null;
}

function assistantReasoningSignature(
  message: Awaited<ReturnType<typeof completeManagedChat>>,
): string | null {
  const signature = message.content
    .filter(
      (
        part,
      ): part is {
        type: "thinking";
        thinking: string;
        thinkingSignature?: string;
      } =>
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        typeof part.thinkingSignature === "string",
    )
    .map((part) => part.thinkingSignature?.trim() || "")
    .find((value) => value.startsWith("{"));
  return signature && signature.length > 0 ? signature : null;
}

export function buildChatCompletionResponse(args: {
  id: string;
  created: number;
  model: string;
  message: Awaited<ReturnType<typeof completeManagedChat>>;
}) {
  const text = assistantText(args.message);
  const reasoningContent = assistantReasoningContent(args.message);
  const reasoningSignature = assistantReasoningSignature(args.message);
  const toolCalls = args.message.content
    .filter(
      (
        part,
      ): part is {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      } => part.type === "toolCall",
    )
    .map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    }));

  const usage = usageSummaryFromAssistant(args.message);

  return {
    id: args.id,
    object: "chat.completion",
    created: args.created,
    model: args.model,
    requestedModel: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(reasoningSignature
            ? { reasoning_signature: reasoningSignature }
            : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(args.message.stopReason),
      },
    ],
    usage: toOpenAIUsage({
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      reasoningTokens: usage?.reasoningTokens,
    }),
  };
}
