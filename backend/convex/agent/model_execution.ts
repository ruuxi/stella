import { generateText, streamText, type LanguageModelUsage } from "ai";
import { BACKEND_TOOL_IDS } from "../lib/agent_constants";
import { withModelFailover, withModelFailoverAsync } from "./model_failover";
import type { ResolvedModelConfig } from "./model_resolver";

type ToolCallLike = {
  toolName?: string;
};

type StepLike = {
  toolCalls?: ToolCallLike[];
};

const NO_RESPONSE_TOOL_NAME = BACKEND_TOOL_IDS.NO_RESPONSE;

function toUsageSummary(usage?: LanguageModelUsage | null) {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens:
      typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
    outputTokens:
      typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
    totalTokens:
      typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
    cachedInputTokens:
      typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : undefined,
    cacheWriteInputTokens:
      typeof usage.inputTokenDetails?.cacheWriteTokens === "number"
        ? usage.inputTokenDetails.cacheWriteTokens
        : undefined,
    reasoningTokens:
      typeof usage.outputTokenDetails?.reasoningTokens === "number"
        ? usage.outputTokenDetails.reasoningTokens
        : typeof usage.reasoningTokens === "number"
          ? usage.reasoningTokens
          : undefined,
  };
}

export type UsageSummary = ReturnType<typeof toUsageSummary>;

export type StreamExecutionLifecycleState = {
  noResponseCalled: boolean;
  usageSummary?: ReturnType<typeof toUsageSummary>;
};

export function hasNoResponseToolCall(toolCalls?: ToolCallLike[]): boolean {
  return Boolean(
    toolCalls?.some((toolCall) => toolCall.toolName === NO_RESPONSE_TOOL_NAME),
  );
}

export function hasNoResponseInSteps(steps?: StepLike[]): boolean {
  return Boolean(steps?.some((step) => hasNoResponseToolCall(step.toolCalls)));
}

export function usageSummaryFromFinish(
  totalUsage: LanguageModelUsage,
): ReturnType<typeof toUsageSummary> {
  return toUsageSummary(totalUsage);
}

export function usageSummaryFromResult(
  result?: {
    usage?: LanguageModelUsage | null;
  } | null,
): UsageSummary {
  return toUsageSummary(result?.usage);
}

export function mergeUsageSummaries(
  ...summaries: Array<UsageSummary | undefined>
): UsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let reasoningTokens = 0;
  let hasValue = false;

  for (const summary of summaries) {
    if (!summary) {
      continue;
    }
    if (summary.inputTokens !== undefined) {
      inputTokens += summary.inputTokens;
      hasValue = true;
    }
    if (summary.outputTokens !== undefined) {
      outputTokens += summary.outputTokens;
      hasValue = true;
    }
    if (summary.totalTokens !== undefined) {
      totalTokens += summary.totalTokens;
      hasValue = true;
    }
    if (summary.cachedInputTokens !== undefined) {
      cachedInputTokens += summary.cachedInputTokens;
      hasValue = true;
    }
    if (summary.cacheWriteInputTokens !== undefined) {
      cacheWriteInputTokens += summary.cacheWriteInputTokens;
      hasValue = true;
    }
    if (summary.reasoningTokens !== undefined) {
      reasoningTokens += summary.reasoningTokens;
      hasValue = true;
    }
  }

  if (!hasValue) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      totalTokens > 0 || (inputTokens === 0 && outputTokens === 0)
        ? totalTokens
        : inputTokens + outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
  };
}

export function createStreamExecutionLifecycle() {
  let state: StreamExecutionLifecycleState = {
    noResponseCalled: false,
    usageSummary: undefined,
  };

  return {
    onStepFinish: ({ toolCalls }: { toolCalls?: ToolCallLike[] }) => {
      if (hasNoResponseToolCall(toolCalls)) {
        state = {
          ...state,
          noResponseCalled: true,
        };
      }
    },
    onFinish: ({
      totalUsage,
    }: {
      usage: LanguageModelUsage;
      totalUsage: LanguageModelUsage;
    }) => {
      state = {
        ...state,
        usageSummary: usageSummaryFromFinish(totalUsage),
      };
    },
    getState: (): StreamExecutionLifecycleState => state,
  };
}

export function streamTextWithFailover(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: Record<string, unknown>;
}) {
  const { resolvedConfig, fallbackConfig, sharedArgs } = args;
  return withModelFailover(
    () =>
      streamText({ ...resolvedConfig, ...sharedArgs } as Parameters<
        typeof streamText
      >[0]),
    fallbackConfig
      ? () =>
          streamText({ ...fallbackConfig, ...sharedArgs } as Parameters<
            typeof streamText
          >[0])
      : undefined,
  );
}

export async function generateTextWithFailover(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: Record<string, unknown>;
}) {
  const { resolvedConfig, fallbackConfig, sharedArgs } = args;
  return await withModelFailoverAsync(
    () =>
      generateText({ ...resolvedConfig, ...sharedArgs } as Parameters<
        typeof generateText
      >[0]),
    fallbackConfig
      ? () =>
          generateText({ ...fallbackConfig, ...sharedArgs } as Parameters<
            typeof generateText
          >[0])
      : undefined,
  );
}
