import { generateText, streamText } from "ai";
import { withModelFailover, withModelFailoverAsync } from "./model_failover";
import { toUsageSummary } from "./orchestrator_turn";

type ModelConfigLike = Record<string, unknown>;

type ToolCallLike = {
  toolName?: string;
};

type StepLike = {
  toolCalls?: ToolCallLike[];
};

const NO_RESPONSE_TOOL_NAME = "NoResponse";

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
  usage: unknown,
  totalUsage: unknown,
): ReturnType<typeof toUsageSummary> {
  return toUsageSummary(totalUsage ?? usage);
}

export function usageSummaryFromUsage(
  usage: unknown,
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
    onFinish: ({ usage, totalUsage }: { usage: unknown; totalUsage: unknown }) => {
      state = {
        ...state,
        usageSummary: usageSummaryFromFinish(usage, totalUsage),
      };
    },
    getState: (): StreamExecutionLifecycleState => state,
  };
}

export function streamTextWithFailover(args: {
  resolvedConfig: ModelConfigLike;
  fallbackConfig?: ModelConfigLike | null;
  sharedArgs: Record<string, unknown>;
}) {
  const { resolvedConfig, fallbackConfig, sharedArgs } = args;
  return withModelFailover(
    () => streamText({ ...(resolvedConfig as object), ...(sharedArgs as object) } as any),
    fallbackConfig
      ? () => streamText({ ...(fallbackConfig as object), ...(sharedArgs as object) } as any)
      : undefined,
  );
}

export async function generateTextWithFailover(args: {
  resolvedConfig: ModelConfigLike;
  fallbackConfig?: ModelConfigLike | null;
  sharedArgs: Record<string, unknown>;
}) {
  const { resolvedConfig, fallbackConfig, sharedArgs } = args;
  return await withModelFailoverAsync(
    () => generateText({ ...(resolvedConfig as object), ...(sharedArgs as object) } as any),
    fallbackConfig
      ? () => generateText({ ...(fallbackConfig as object), ...(sharedArgs as object) } as any)
      : undefined,
  );
}
