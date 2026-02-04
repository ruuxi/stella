import { streamText } from "ai";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { buildSystemPrompt } from "../prompt_builder";
import { createTools } from "../tools/index";
import { getModelConfig } from "../model";

export type RunAgentTurnResult = {
  text: string;
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
  includeHistory?: boolean;
  historyLimit?: number;
};

export async function runAgentTurn({
  ctx,
  conversationId,
  prompt,
  agentType,
  ownerId,
  targetDeviceId,
  includeHistory = true,
  historyLimit = 80,
}: RunAgentTurnArgs): Promise<RunAgentTurnResult> {
  await ctx.runMutation(api.agents.ensureBuiltins, {});

  const conversation = await ctx.runQuery(internal.conversations.getById, {
    id: conversationId,
  });
  if (!conversation) {
    return { text: "" };
  }

  const resolvedOwnerId = ownerId ?? conversation.ownerId;
  const promptBuild = await buildSystemPrompt(ctx, agentType, {
    ownerId: resolvedOwnerId,
  });
  const pluginTools = (await ctx.runQuery(api.plugins.listToolDescriptors, {})) as Array<{
    pluginId: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;

  const tools = targetDeviceId
    ? createTools(
        ctx,
        {
          conversationId,
          targetDeviceId,
          agentType,
          sourceDeviceId: targetDeviceId,
        },
        {
          agentType,
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          pluginTools,
          ownerId: resolvedOwnerId,
        },
      )
    : undefined;

  const historyEvents =
    includeHistory && historyLimit > 0
      ? await ctx.runQuery(internal.events.listRecentMessages, {
          conversationId,
          limit: Math.min(Math.max(Math.floor(historyLimit), 1), 100),
        })
      : [];

  const historyMessages = (historyEvents ?? []).flatMap((event) => {
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as { text?: string })
        : {};
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return [];
    }
    return [
      {
        role: event.type === "assistant_message" ? ("assistant" as const) : ("user" as const),
        content: text,
      },
    ];
  });

  let usageSummary:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined;

  const result = await streamText({
    ...getModelConfig(agentType),
    system: promptBuild.systemPrompt,
    tools,
    messages: [
      ...historyMessages,
      {
        role: "user",
        content: [{ type: "text", text: prompt.trim() || " " }],
      },
    ],
    onFinish: ({ usage, totalUsage }) => {
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
  });

  const text = await result.text;

  const totalTokens = usageSummary?.totalTokens ?? 0;
  if (totalTokens > 0) {
    await ctx.runMutation(internal.conversations.patchTokenCount, {
      conversationId,
      tokenDelta: totalTokens,
    });
  }

  return { text, usage: usageSummary };
}
