import { streamText } from "ai";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "../agent/prompt_builder";
import {
  AUTOMATION_HISTORY_MAX_TOKENS,
} from "../agent/context_budget";
import { normalizeOptionalInt } from "../lib/number_utils";
import { createTools } from "../tools/index";
import { resolveModelConfig, resolveFallbackConfig } from "../agent/model_resolver";
import { withModelFailover } from "../agent/model_failover";
import {
  finalizeOrchestratorTurn,
  prepareOrchestratorTurn,
  toUsageSummary,
} from "../agent/orchestrator_turn";

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
  userMessageId?: Id<"events">;
  targetDeviceId?: string;
  spriteName?: string;
};

export async function runAgentTurn({
  ctx,
  conversationId,
  prompt,
  agentType,
  ownerId,
  userMessageId,
  targetDeviceId,
  spriteName,
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
  const resolvedConfig = await resolveModelConfig(ctx, agentType, resolvedOwnerId);
  const fallbackConfig = await resolveFallbackConfig(ctx, agentType, resolvedOwnerId).catch(() => null);
  let promptBuild: Awaited<ReturnType<typeof buildSystemPrompt>>;
  let requestMessages: any[];
  let orchestratorTurn: Awaited<ReturnType<typeof prepareOrchestratorTurn>> | null = null;

  if (agentType === "orchestrator") {
    let historyBeforeTimestamp: number | undefined;
    let historyExcludeEventId: Id<"events"> | undefined;
    if (userMessageId) {
      const userEvent = await ctx.runQuery(internal.events.getById, { id: userMessageId });
      if (
        userEvent &&
        userEvent.type === "user_message" &&
        userEvent.conversationId === conversationId
      ) {
        historyBeforeTimestamp = userEvent.timestamp;
        historyExcludeEventId = userMessageId;
      }
    }

    orchestratorTurn = await prepareOrchestratorTurn(ctx, {
      conversation,
      conversationId,
      ownerId: resolvedOwnerId,
      userPayload: {
        kind: "task_delivery",
        text: prompt,
      },
      history: {
        enabled: true,
        maxTokens: normalizeOptionalInt({
          value: AUTOMATION_HISTORY_MAX_TOKENS,
          defaultValue: AUTOMATION_HISTORY_MAX_TOKENS,
          min: 1,
          max: 120_000,
        }),
        beforeTimestamp: historyBeforeTimestamp,
        excludeEventId: historyExcludeEventId,
        microcompact: {
          trigger: "auto",
          modelForWarningThreshold:
            typeof resolvedConfig.model === "string" ? resolvedConfig.model : undefined,
        },
      },
    });
    promptBuild = orchestratorTurn.promptBuild;
    requestMessages = orchestratorTurn.messages as any[];
  } else {
    promptBuild = await buildSystemPrompt(ctx, agentType, {
      ownerId: resolvedOwnerId,
      conversationId,
    });
    requestMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt.trim() || " " }],
      },
    ];
  }

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

  let usageSummary:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  let noResponseCalled = false;

  const runnerSharedArgs = {
    system: promptBuild.systemPrompt,
    tools,
    messages: requestMessages,
    onStepFinish: ({ toolCalls }: { toolCalls?: Array<{ toolName: string }> }) => {
      if (toolCalls?.some((tc: { toolName: string }) => tc.toolName === "NoResponse")) {
        noResponseCalled = true;
      }
    },
    onFinish: ({ usage, totalUsage }: { usage: any; totalUsage: any }) => {
      usageSummary = toUsageSummary(totalUsage ?? usage);
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
  if (agentType === "orchestrator" && orchestratorTurn) {
    const response = await result.response;
    await finalizeOrchestratorTurn(ctx, {
      conversationId,
      ownerId: resolvedOwnerId,
      userMessageId,
      activeThreadId: orchestratorTurn.activeThreadId,
      threadUserMessage: orchestratorTurn.threadUserMessage,
      responseMessages: response?.messages,
      assistantText: text,
      usage: usageSummary,
      saveAssistantMessage: false,
      scheduleSuggestions: false,
      reminderState: orchestratorTurn.reminderState,
    });
  }

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
