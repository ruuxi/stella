import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "../agent/prompt_builder";
import { createTools } from "../tools/index";
import { resolveModelConfig, resolveFallbackConfig } from "../agent/model_resolver";
import {
  createStreamExecutionLifecycle,
  splitDurationAcrossModels,
  streamTextWithFailover,
} from "../agent/model_execution";
import { buildBackendJobModeSystemPrompt } from "../prompts/index";
import {
  assertManagedUsageAllowed,
  scheduleManagedUsage,
} from "../lib/managed_billing";

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
  const modelAccess = await assertManagedUsageAllowed(ctx, resolvedOwnerId);
  const resolvedConfig = await resolveModelConfig(ctx, agentType, resolvedOwnerId, {
    access: modelAccess,
  });
  const fallbackConfig = await resolveFallbackConfig(ctx, agentType, resolvedOwnerId, {
    access: modelAccess,
  });
  const promptBuild = await buildSystemPrompt(ctx, agentType, {
    ownerId: resolvedOwnerId,
    conversationId,
  });
  const requestMessages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: prompt.trim() || " " }],
    },
  ];

  const tools = createTools(
    ctx,
    {
      agentType,
      toolsAllowlist: promptBuild.toolsAllowlist,
      maxTaskDepth: promptBuild.maxTaskDepth,
      ownerId: resolvedOwnerId,
      conversationId,
      userMessageId,
      transient: Boolean(transient),
    },
  );

  const streamLifecycle = createStreamExecutionLifecycle();

  const systemPrompt = buildBackendJobModeSystemPrompt(
    promptBuild.systemPrompt,
  );

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

  // Fire afterChat hook asynchronously for usage logging + token tracking
  if (!transient) {
    const usageByModel = await result.usageByModel;
    const durationMs = Date.now() - runnerStartTime;
    const perModelUsage = splitDurationAcrossModels(usageByModel, durationMs);
    if (perModelUsage.length > 0) {
      for (const entry of perModelUsage) {
        await scheduleManagedUsage(ctx, {
          ownerId: resolvedOwnerId,
          conversationId,
          agentType,
          model: entry.model,
          durationMs: entry.durationMs,
          success: true,
          usage: entry.usage,
        });
      }
    } else {
      await scheduleManagedUsage(ctx, {
        ownerId: resolvedOwnerId,
        conversationId,
        agentType,
        model: result.executedModel,
        durationMs,
        success: true,
        usage: usageSummary,
      });
    }
  }

  return { text, silent: noResponseCalled, usage: usageSummary };
}
