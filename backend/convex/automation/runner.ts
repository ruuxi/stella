import { streamText } from "ai";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "../agent/prompt_builder";
import { eventsToHistoryMessages } from "../agent/history_messages";
import {
  AUTOMATION_HISTORY_MAX_TOKENS,
} from "../agent/context_budget";
import { createTools } from "../tools/index";
import { resolveModelConfig, resolveFallbackConfig } from "../agent/model_resolver";
import { withModelFailover } from "../agent/model_failover";

export type RunAgentTurnResult = {
  text: string;
  silent: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

type RunAgentTurnArgs = {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  prompt: string;
  agentType: string;
  ownerId?: string;
  targetDeviceId?: string;
  spriteName?: string;
  includeHistory?: boolean;
  historyMaxTokens?: number;
};

export async function runAgentTurn({
  ctx,
  conversationId,
  prompt,
  agentType,
  ownerId,
  targetDeviceId,
  spriteName,
  includeHistory = true,
  historyMaxTokens = AUTOMATION_HISTORY_MAX_TOKENS,
}: RunAgentTurnArgs): Promise<RunAgentTurnResult> {
  await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
  await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});

  const conversation = await ctx.runQuery(internal.conversations.getById, {
    id: conversationId,
  });
  if (!conversation) {
    return { text: "", silent: false };
  }

  const resolvedOwnerId = ownerId ?? conversation.ownerId;
  const promptBuild = await buildSystemPrompt(ctx, agentType, {
    ownerId: resolvedOwnerId,
  });

  const tools = createTools(
    ctx,
    targetDeviceId
      ? {
          conversationId,
          targetDeviceId,
          agentType,
          sourceDeviceId: targetDeviceId,
        }
      : undefined,
    {
      agentType,
      toolsAllowlist: promptBuild.toolsAllowlist,
      maxTaskDepth: promptBuild.maxTaskDepth,
      ownerId: resolvedOwnerId,
      conversationId,
      spriteName,
    },
  );

  const historyEvents =
    includeHistory && historyMaxTokens > 0
      ? await ctx.runQuery(internal.events.listRecentContextEventsByTokens, {
          conversationId,
          maxTokens: Math.min(Math.max(Math.floor(historyMaxTokens), 1), 120_000),
        })
      : [];

  const historyMessages = eventsToHistoryMessages(historyEvents ?? []);

  let usageSummary:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  let noResponseCalled = false;

  const resolvedConfig = await resolveModelConfig(ctx, agentType, resolvedOwnerId);
  const fallbackConfig = await resolveFallbackConfig(ctx, agentType, resolvedOwnerId).catch(() => null);

  const runnerSharedArgs = {
    system: promptBuild.systemPrompt,
    tools,
    messages: [
      ...historyMessages,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt.trim() || " " }],
      },
    ],
    onStepFinish: ({ toolCalls }: { toolCalls?: Array<{ toolName: string }> }) => {
      if (toolCalls?.some((tc: { toolName: string }) => tc.toolName === "NoResponse")) {
        noResponseCalled = true;
      }
    },
    onFinish: ({ usage, totalUsage }: { usage: any; totalUsage: any }) => {
      const usageTotals = totalUsage ?? usage;
      const hasUsage =
        usageTotals &&
        (typeof usageTotals.inputTokens === "number" ||
          typeof usageTotals.outputTokens === "number" ||
          typeof usageTotals.totalTokens === "number");
      usageSummary = hasUsage
        ? {
            inputTokens: usageTotals.inputTokens,
            outputTokens: usageTotals.outputTokens,
            totalTokens: usageTotals.totalTokens,
          }
        : undefined;
    },
  };

  const runnerStartTime = Date.now();
  const result = await withModelFailover(
    () => streamText({ ...resolvedConfig, ...runnerSharedArgs }),
    fallbackConfig
      ? () => streamText({ ...fallbackConfig, ...runnerSharedArgs })
      : undefined,
  );

  const text = await result.text;

  // Fire afterChat hook asynchronously for usage logging + token tracking
  await ctx.scheduler.runAfter(0, internal.agent.hooks.logUsageAsync, {
    ownerId: resolvedOwnerId,
    conversationId,
    agentType,
    model: resolvedConfig.model as string,
    inputTokens: usageSummary?.inputTokens,
    outputTokens: usageSummary?.outputTokens,
    totalTokens: usageSummary?.totalTokens,
    durationMs: Date.now() - runnerStartTime,
    success: true,
  });

  return { text, silent: noResponseCalled, usage: usageSummary };
}
