import { generateText, streamText, type LanguageModelUsage } from "ai";
import { withModelFailover, withModelFailoverAsync } from "./model_failover";
import type { ResolvedModelConfig } from "./model_resolver";

type ToolCallLike = {
  toolName?: string;
};

type StepLike = {
  toolCalls?: ToolCallLike[];
};

const NO_RESPONSE_TOOL_NAME = "NoResponse";

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
  };
}

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
  return Boolean(
    steps?.some((step) => hasNoResponseToolCall(step.toolCalls)),
  );
}

export function usageSummaryFromFinish(
  usage: LanguageModelUsage,
  totalUsage: LanguageModelUsage,
): ReturnType<typeof toUsageSummary> {
  return toUsageSummary(totalUsage);
}

export function usageSummaryFromUsage(
  usage: LanguageModelUsage,
): ReturnType<typeof toUsageSummary> {
  return toUsageSummary(usage);
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
    onFinish: ({ usage, totalUsage }: { usage: LanguageModelUsage; totalUsage: LanguageModelUsage }) => {
      state = {
        ...state,
        usageSummary: usageSummaryFromFinish(usage, totalUsage),
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
    () => streamText({ ...resolvedConfig, ...sharedArgs } as Parameters<typeof streamText>[0]),
    fallbackConfig
      ? () => streamText({ ...fallbackConfig, ...sharedArgs } as Parameters<typeof streamText>[0])
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
    () => generateText({ ...resolvedConfig, ...sharedArgs } as Parameters<typeof generateText>[0]),
    fallbackConfig
      ? () => generateText({ ...fallbackConfig, ...sharedArgs } as Parameters<typeof generateText>[0])
      : undefined,
  );
}
