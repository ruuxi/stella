import { streamText } from "ai";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "../agent/prompt_builder";
import { createTools } from "../tools/index";
import { resolveModelConfig } from "../agent/model_resolver";

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
  historyLimit?: number;
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
  historyLimit = 80,
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
  const pluginTools = (await ctx.runQuery(
    internal.data.plugins.listToolDescriptorsInternal,
    { ownerId: resolvedOwnerId },
  )) as Array<{
    pluginId: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;

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
      pluginTools,
      ownerId: resolvedOwnerId,
      conversationId,
      spriteName,
    },
  );

  const historyEvents =
    includeHistory && historyLimit > 0
      ? await ctx.runQuery(internal.events.listRecentMessages, {
          conversationId,
          limit: Math.min(Math.max(Math.floor(historyLimit), 1), 100),
        })
      : [];

  const historyMessages = (historyEvents ?? []).flatMap((event: { type: string; payload?: unknown }) => {
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
  let noResponseCalled = false;

  const resolvedConfig = await resolveModelConfig(ctx, agentType, resolvedOwnerId);
  const result = await streamText({
    ...resolvedConfig,
    system: promptBuild.systemPrompt,
    tools,
    messages: [
      ...historyMessages,
      {
        role: "user",
        content: [{ type: "text", text: prompt.trim() || " " }],
      },
    ],
    onStepFinish: ({ toolCalls }) => {
      if (toolCalls?.some((tc: { toolName: string }) => tc.toolName === "NoResponse")) {
        noResponseCalled = true;
      }
    },
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

  return { text, silent: noResponseCalled, usage: usageSummary };
}
