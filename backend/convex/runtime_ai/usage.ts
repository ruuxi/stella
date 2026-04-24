import { calculateCost } from "./model_utils";
import type { AssistantMessage, Model } from "./types";

export type OpenAIChatUsagePayload = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export function parseOpenAIChatUsage(
  rawUsage: OpenAIChatUsagePayload | null | undefined,
  model: Model<"openai-completions">,
): AssistantMessage["usage"] {
  const promptTokens = rawUsage?.prompt_tokens || 0;
  const reportedCachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens || 0;
  const cacheWriteTokens = rawUsage?.prompt_tokens_details?.cache_write_tokens || 0;
  const reasoningTokens = rawUsage?.completion_tokens_details?.reasoning_tokens || 0;
  const cacheReadTokens =
    cacheWriteTokens > 0
      ? Math.max(0, reportedCachedTokens - cacheWriteTokens)
      : reportedCachedTokens;
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const output = rawUsage?.completion_tokens || 0;
  const usage: AssistantMessage["usage"] = {
    input,
    output,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    reasoningTokens,
    totalTokens: rawUsage?.total_tokens ?? input + output + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}
