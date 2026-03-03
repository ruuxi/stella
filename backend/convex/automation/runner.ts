import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "../agent/prompt_builder";
import {
  AUTOMATION_HISTORY_MAX_TOKENS,
} from "../agent/context_budget";
import { CLOUD_ONLY_TOOL_NAMES } from "../agent/device_tools";
import { createTools } from "../tools/index";
import { resolveModelConfig, resolveFallbackConfig } from "../agent/model_resolver";
import {
  finalizeOrchestratorTurn,
  prepareOrchestratorTurn,
} from "../agent/orchestrator_turn";
import {
  createStreamExecutionLifecycle,
  streamTextWithFailover,
} from "../agent/model_execution";

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
  transient?: boolean;
};

/**
 * Module-level cache for ensureBuiltins. In Convex's serverless environment,
 * cold starts reset this state — that's fine because the fallback (re-running
 * ensureBuiltins) is idempotent and safe. The cache simply avoids redundant
 * DB writes within the same warm instance.
 */
const BUILTIN_ENSURE_CACHE_TTL_MS = 5 * 60 * 1000;
let builtinEnsurePromise: Promise<void> | null = null;
let builtinEnsureSucceededAt = 0;

const ensureBuiltins = async (ctx: ActionCtx) => {
  const now = Date.now();
  if (now - builtinEnsureSucceededAt < BUILTIN_ENSURE_CACHE_TTL_MS) {
    return;
  }
  if (!builtinEnsurePromise) {
    builtinEnsurePromise = (async () => {
      await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
      await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});
      builtinEnsureSucceededAt = Date.now();
    })().finally(() => {
      builtinEnsurePromise = null;
    });
  }
  await builtinEnsurePromise;
};

export async function runAgentTurn({
  ctx,
  conversationId,
  prompt,
  agentType,
  ownerId,
  userMessageId,
  targetDeviceId,
  transient,
}: RunAgentTurnArgs): Promise<RunAgentTurnResult> {
  await ensureBuiltins(ctx);

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
  let requestMessages: ModelMessage[];
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
        enabled: !transient,
        maxTokens: AUTOMATION_HISTORY_MAX_TOKENS,
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
    requestMessages = orchestratorTurn.messages as ModelMessage[];
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

  // When the desktop is offline (no targetDeviceId), restrict to cloud-only
  // tools since local tools (shell, file system, browser) can't execute.
  const effectiveToolsAllowlist = targetDeviceId
    ? promptBuild.toolsAllowlist
    : [...CLOUD_ONLY_TOOL_NAMES];

  const tools = createTools(
    ctx,
    targetDeviceId
      ? {
          conversationId,
          targetDeviceId,
          agentType,
          sourceDeviceId: targetDeviceId,
          ephemeral: Boolean(transient),
        }
      : undefined,
    {
      agentType,
      toolsAllowlist: effectiveToolsAllowlist,
      maxTaskDepth: targetDeviceId ? promptBuild.maxTaskDepth : 0,
      ownerId: resolvedOwnerId,
      conversationId,
      transient: Boolean(transient),
    },
  );

  const streamLifecycle = createStreamExecutionLifecycle();

  // Append cloud-only notice when desktop is offline
  const systemPrompt = targetDeviceId
    ? promptBuild.systemPrompt
    : `${promptBuild.systemPrompt}\n\n<system-notice>You are running in cloud-only mode. The user's desktop is offline, so local tools (file system, shell, browser, apps) are unavailable. You can only chat and search the web. Let the user know if they ask for something that requires their desktop.</system-notice>`;

  const runnerSharedArgs = {
    system: systemPrompt,
    tools,
    messages: requestMessages,
    onStepFinish: streamLifecycle.onStepFinish,
    onFinish: streamLifecycle.onFinish,
  };

  const runnerStartTime = Date.now();
  const result = await streamTextWithFailover({
    resolvedConfig,
    fallbackConfig: fallbackConfig ?? undefined,
    sharedArgs: runnerSharedArgs as Record<string, unknown>,
  });

  const text = await result.text;
  const { noResponseCalled, usageSummary } = streamLifecycle.getState();
  if (agentType === "orchestrator" && orchestratorTurn) {
    const response = await result.response;
    const reminderState = transient
      ? { shouldInjectDynamicReminder: false }
      : orchestratorTurn.reminderState;
    await finalizeOrchestratorTurn(ctx, {
      conversationId,
      ownerId: resolvedOwnerId,
      userMessageId,
      activeThreadId: transient ? null : orchestratorTurn.activeThreadId,
      threadUserMessage: orchestratorTurn.threadUserMessage,
      responseMessages: transient ? undefined : response?.messages,
      assistantText: text,
      usage: usageSummary,
      saveAssistantMessage: false,
      scheduleSuggestions: !transient,
      reminderState,
    });
  }

  // Fire afterChat hook asynchronously for usage logging + token tracking
  if (!transient) {
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
  }

  return { text, silent: noResponseCalled, usage: usageSummary };
}
