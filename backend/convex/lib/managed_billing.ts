import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ManagedModelAudience } from "../agent/model";
import type { ManagedUsageSummary } from "./managed_usage";

type BillingMutationCtx = {
  runMutation: ActionCtx["runMutation"];
};

type BillingSchedulerCtx = {
  scheduler: ActionCtx["scheduler"];
};

export type ManagedUsageLogArgs = {
  ownerId: string;
  agentType: string;
  model: string;
  durationMs: number;
  success: boolean;
  conversationId?: Id<"conversations">;
  usage?: ManagedUsageSummary | null;
  costMicroCents?: number;
};

export type ManagedModelAccess = {
  allowed: boolean;
  plan: "free" | "go" | "pro" | "plus" | "ultra";
  unlimited: boolean;
  downgraded: boolean;
  modelAudience: ManagedModelAudience;
  retryAfterMs: number;
  message: string;
};

const toLogPayload = (args: ManagedUsageLogArgs) => ({
  ownerId: args.ownerId,
  agentType: args.agentType,
  model: args.model,
  durationMs: args.durationMs,
  success: args.success,
  ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  ...(args.usage?.inputTokens !== undefined ? { inputTokens: args.usage.inputTokens } : {}),
  ...(args.usage?.outputTokens !== undefined ? { outputTokens: args.usage.outputTokens } : {}),
  ...(args.usage?.totalTokens !== undefined ? { totalTokens: args.usage.totalTokens } : {}),
  ...(args.usage?.cachedInputTokens !== undefined ? { cachedInputTokens: args.usage.cachedInputTokens } : {}),
  ...(args.usage?.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: args.usage.cacheWriteInputTokens } : {}),
  ...(args.usage?.reasoningTokens !== undefined ? { reasoningTokens: args.usage.reasoningTokens } : {}),
  ...(args.costMicroCents !== undefined ? { costMicroCents: args.costMicroCents } : {}),
});

export async function checkManagedUsageLimit(
  ctx: BillingMutationCtx,
  ownerId: string,
  options?: {
    minimumRemainingMicroCents?: number;
  },
) {
  return await ctx.runMutation(internal.billing.enforceManagedUsageLimit, {
    ownerId,
    ...(options?.minimumRemainingMicroCents !== undefined
      ? { minimumRemainingMicroCents: options.minimumRemainingMicroCents }
      : {}),
  });
}

export async function resolveManagedModelAccess(
  ctx: BillingMutationCtx,
  ownerId: string,
  options?: {
    isAnonymous?: boolean;
  },
): Promise<ManagedModelAccess> {
  return await ctx.runMutation(internal.billing.resolveManagedModelAccess, {
    ownerId,
    ...(options?.isAnonymous !== undefined ? { isAnonymous: options.isAnonymous } : {}),
  });
}

export async function assertManagedUsageAllowed(
  ctx: BillingMutationCtx,
  ownerId: string,
  options?: {
    isAnonymous?: boolean;
  },
) {
  const result = await resolveManagedModelAccess(ctx, ownerId, options);
  if (!result.allowed) {
    throw new ConvexError({
      code: "USAGE_LIMIT_REACHED",
      message: result.message,
      retryAfterMs: result.retryAfterMs,
    });
  }
  return result;
}

/**
 * Stella-paid media generation (fal images/video, Lyria music, emoji
 * packs, etc.) is gated to paid plans only — free and anonymous users
 * cannot burn Stella's third-party API credits without a subscription.
 * BYOK paths that don't touch Stella's keys should bypass this check.
 */
export function isPaidMediaTier(audience: ManagedModelAudience): boolean {
  return audience !== "anonymous" && audience !== "free";
}

export async function assertPaidMediaTier(
  ctx: BillingMutationCtx,
  ownerId: string,
  options?: { isAnonymous?: boolean },
): Promise<ManagedModelAccess> {
  const access = await resolveManagedModelAccess(ctx, ownerId, options);
  if (!isPaidMediaTier(access.modelAudience)) {
    throw new ConvexError({
      code: "PAID_PLAN_REQUIRED",
      message: "Media generation requires a Stella subscription. Upgrade your plan to continue.",
    });
  }
  return access;
}

export async function recordManagedUsage(
  ctx: BillingMutationCtx,
  args: ManagedUsageLogArgs,
) {
  return await ctx.runMutation(
    internal.billing.logManagedUsage,
    toLogPayload(args),
  );
}

export async function scheduleManagedUsage(
  ctx: BillingSchedulerCtx,
  args: ManagedUsageLogArgs,
) {
  await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, toLogPayload(args));
}
