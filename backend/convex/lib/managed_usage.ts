import type { AssistantMessage } from "../runtime_ai/types";

export type ManagedUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
};

export function usageSummaryFromAssistant(
  message: AssistantMessage | null | undefined,
): ManagedUsageSummary | undefined {
  if (!message) {
    return undefined;
  }

  return {
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
    cachedInputTokens: message.usage.cacheRead,
    cacheWriteInputTokens: message.usage.cacheWrite,
    reasoningTokens: message.usage.reasoningTokens,
  };
}
