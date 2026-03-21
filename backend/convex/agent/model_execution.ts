import { BACKEND_TOOL_IDS } from "../lib/agent_constants";
import { validateAgainstSchema } from "../lib/validator";
import {
  assistantText,
  buildContextFromChatMessages,
  completeManagedChat,
  type ManagedUsageSummary,
} from "../runtime_ai/managed";
import type { AssistantMessage } from "../runtime_ai/types";
import type { ResolvedModelConfig } from "./model_resolver";
import { withModelFailoverAsync } from "./model_failover";
import type { BackendToolSet } from "../tools/types";

type ToolCallLike = {
  toolName?: string;
};

type StepLike = {
  toolCalls?: ToolCallLike[];
};

type SharedExecutionArgs = {
  system?: string;
  messages?: unknown;
  tools?: BackendToolSet;
  maxSteps?: number;
  onStepFinish?: (args: { toolCalls?: ToolCallLike[] }) => void;
  onFinish?: (args: {
    usage: ManagedUsageSummary | undefined;
    totalUsage: ManagedUsageSummary | undefined;
  }) => void;
};

const NO_RESPONSE_TOOL_NAME = BACKEND_TOOL_IDS.NO_RESPONSE;

export type UsageSummary = ManagedUsageSummary;
export type MaybeUsageSummary = UsageSummary | undefined;
export type UsageSummaryByModel = Record<string, UsageSummary>;

export type StreamExecutionLifecycleState = {
  noResponseCalled: boolean;
  usageSummary?: MaybeUsageSummary;
};

export function hasNoResponseToolCall(toolCalls?: ToolCallLike[]): boolean {
  return Boolean(
    toolCalls?.some((toolCall) => toolCall.toolName === NO_RESPONSE_TOOL_NAME),
  );
}

export function hasNoResponseInSteps(steps?: StepLike[]): boolean {
  return Boolean(steps?.some((step) => hasNoResponseToolCall(step.toolCalls)));
}

export class ToolLoopExhaustedError extends Error {
  readonly maxSteps: number;
  readonly partialText: string;

  constructor(maxSteps: number, partialText = "") {
    super(`Tool loop exhausted maxSteps=${maxSteps} before producing a final assistant response.`);
    this.name = "ToolLoopExhaustedError";
    this.maxSteps = maxSteps;
    this.partialText = partialText;
  }
}

export function appendAssistantStepText(
  currentText: string,
  message: AssistantMessage,
): string {
  const nextText = assistantText(message);
  if (!nextText) {
    return currentText;
  }
  if (!currentText) {
    return nextText;
  }
  return `${currentText}\n\n${nextText}`;
}

export function usageSummaryFromFinish(
  totalUsage: MaybeUsageSummary,
): MaybeUsageSummary {
  return totalUsage;
}

export function usageSummaryFromResult(
  result?: {
    usage?: UsageSummary | null;
  } | null,
): MaybeUsageSummary {
  return result?.usage ?? undefined;
}

export function mergeUsageSummaries(
  ...summaries: Array<MaybeUsageSummary>
): MaybeUsageSummary {
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

export function mergeUsageSummaryByModel(
  current: UsageSummaryByModel,
  model: string,
  usage: MaybeUsageSummary,
): UsageSummaryByModel {
  if (!usage) {
    return current;
  }

  return {
    ...current,
    [model]: mergeUsageSummaries(current[model], usage)!,
  };
}

export function splitDurationAcrossModels(
  usageByModel: UsageSummaryByModel,
  durationMs: number,
): Array<{ model: string; usage: UsageSummary; durationMs: number }> {
  const entries = Object.entries(usageByModel).filter(([, usage]) => usage);
  if (entries.length === 0) {
    return [];
  }

  const totalTokens = entries.reduce(
    (sum, [, usage]) => sum + Math.max(0, usage.totalTokens ?? 0),
    0,
  );

  let allocated = 0;
  return entries.map(([model, usage], index) => {
    const isLast = index === entries.length - 1;
    const sliceDuration = isLast
      ? Math.max(0, durationMs - allocated)
      : totalTokens > 0
        ? Math.max(0, Math.floor(durationMs * ((usage.totalTokens ?? 0) / totalTokens)))
        : Math.floor(durationMs / entries.length);
    allocated += sliceDuration;
    return { model, usage, durationMs: sliceDuration };
  });
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
      usage: MaybeUsageSummary;
      totalUsage: MaybeUsageSummary;
    }) => {
      state = {
        ...state,
        usageSummary: usageSummaryFromFinish(totalUsage),
      };
    },
    getState: (): StreamExecutionLifecycleState => state,
  };
}

async function runToolLoop(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: SharedExecutionArgs;
}) {
  const context = buildContextFromChatMessages(args.sharedArgs.messages);
  if (args.sharedArgs.system) {
    context.systemPrompt = args.sharedArgs.system;
  }

  const tools = args.sharedArgs.tools ?? {};
  const toolSchemas = Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  }));

  let totalUsage: MaybeUsageSummary = undefined;
  let usageByModel: UsageSummaryByModel = {};
  let accumulatedAssistantText = "";
  const maxSteps = Math.max(1, Math.floor(args.sharedArgs.maxSteps ?? 20));

  for (let step = 0; step < maxSteps; step += 1) {
    const assistantMessage = await completeManagedChat({
      config: args.resolvedConfig,
      fallbackConfig: args.fallbackConfig,
      context: {
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
      },
    });

    const usage = usageSummaryFromResult({
      usage: {
        inputTokens: assistantMessage.usage.input,
        outputTokens: assistantMessage.usage.output,
        totalTokens: assistantMessage.usage.totalTokens,
        cachedInputTokens: assistantMessage.usage.cacheRead,
        cacheWriteInputTokens: assistantMessage.usage.cacheWrite,
        reasoningTokens: assistantMessage.usage.reasoningTokens,
      },
    });
    totalUsage = mergeUsageSummaries(totalUsage, usage);
    usageByModel = mergeUsageSummaryByModel(usageByModel, assistantMessage.model, usage);

    const toolCalls = assistantMessage.content
      .filter(
        (part): part is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
          part.type === "toolCall",
      )
      .map((toolCall) => ({
        ...toolCall,
        toolName: toolCall.name,
      }));

    args.sharedArgs.onStepFinish?.({
      toolCalls: toolCalls.map((toolCall) => ({ toolName: toolCall.toolName })),
    });

    context.messages.push(assistantMessage);

    if (toolCalls.length === 0) {
      const finalText = appendAssistantStepText(
        accumulatedAssistantText,
        assistantMessage,
      );
      args.sharedArgs.onFinish?.({
        usage,
        totalUsage,
      });
      return {
        text: finalText,
        totalUsage,
        usageByModel,
        executedModel: assistantMessage.model,
      };
    }

    if (hasNoResponseToolCall(toolCalls)) {
      args.sharedArgs.onFinish?.({
        usage,
        totalUsage,
      });
      return {
        text: "",
        totalUsage,
        usageByModel,
        executedModel: assistantMessage.model,
      };
    }

    accumulatedAssistantText = appendAssistantStepText(
      accumulatedAssistantText,
      assistantMessage,
    );

    for (const toolCall of toolCalls) {
      const tool = tools[toolCall.name];
      let resultText = "";
      let isError = false;

      if (!tool) {
        resultText = `Tool ${toolCall.name} is not available.`;
        isError = true;
      } else {
        const validation = validateAgainstSchema(
          tool.parameters,
          toolCall.arguments,
        );
        if (validation.ok === false) {
          resultText = `Invalid tool arguments for ${toolCall.name}: ${validation.reason}`;
          isError = true;
        } else {
          try {
            resultText = await tool.execute(toolCall.arguments);
          } catch (error) {
            resultText = `Tool ${toolCall.name} failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
            isError = true;
          }
        }
      }

      context.messages.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: resultText }],
        isError,
        timestamp: Date.now(),
      });
    }
  }

  args.sharedArgs.onFinish?.({
    usage: totalUsage,
    totalUsage,
  });

  throw new ToolLoopExhaustedError(maxSteps, accumulatedAssistantText);
}

export async function streamTextWithFailover(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: Record<string, unknown>;
}) {
  const execute = async (config: ResolvedModelConfig) => {
    const sharedArgs = args.sharedArgs as SharedExecutionArgs;
    const result = await runToolLoop({
      resolvedConfig: config,
      fallbackConfig: undefined,
      sharedArgs,
    });

    return {
      text: Promise.resolve(result.text),
      totalUsage: Promise.resolve(result.totalUsage),
      usageByModel: Promise.resolve(result.usageByModel),
      executedModel: result.executedModel,
    };
  };

  const fallbackConfig = args.fallbackConfig ?? undefined;
  return await withModelFailoverAsync(
    () => execute(args.resolvedConfig),
    fallbackConfig ? () => execute(fallbackConfig) : undefined,
  );
}

export async function generateTextWithFailover(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: Record<string, unknown>;
}) {
  const execute = async (config: ResolvedModelConfig) => {
    const sharedArgs = args.sharedArgs as SharedExecutionArgs;
    const context = buildContextFromChatMessages(sharedArgs.messages);
    if (sharedArgs.system) {
      context.systemPrompt = sharedArgs.system;
    }
    const message = await completeManagedChat({
      config,
      context,
    });

    return {
      text: assistantText(message),
      usage: usageSummaryFromResult({
        usage: {
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          totalTokens: message.usage.totalTokens,
          cachedInputTokens: message.usage.cacheRead,
          cacheWriteInputTokens: message.usage.cacheWrite,
          reasoningTokens: message.usage.reasoningTokens,
        },
      }),
      executedModel: message.model,
    };
  };

  const fallbackConfig = args.fallbackConfig ?? undefined;
  return await withModelFailoverAsync(
    () => execute(args.resolvedConfig),
    fallbackConfig ? () => execute(fallbackConfig) : undefined,
  );
}
