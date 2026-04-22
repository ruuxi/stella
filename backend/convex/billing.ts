import Stripe from "stripe";
import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  requireSensitiveUserIdentityAction,
  requireUserId,
} from "./auth";
import { getMonthlyBounds, getWeekBounds } from "./lib/billing_date";
import {
  findPlanForStripePriceId,
  getPlanCatalog,
  getPlanConfig,
  getStripePriceIdForPlan,
  type SubscriptionPlan,
} from "./lib/billing_plans";
import {
  type TokenPriceConfig,
  computeRealtimeUsageCostMicroCents,
  computeUsageCostMicroCents,
  dollarsToMicroCents,
  microCentsToDollars,
} from "./lib/billing_money";
import { buildManagedModelPriceEntries, type ManagedModelPriceEntry, type ModelsDevApi } from "./lib/models_dev";
import { listManagedModelIds, resolveManagedModelAudience } from "./agent/model";
import {
  enforceActionRateLimit,
  RATE_EXPENSIVE,
} from "./lib/rate_limits";

const planValidator = v.union(
  v.literal("free"),
  v.literal("go"),
  v.literal("pro"),
  v.literal("plus"),
  v.literal("ultra"),
);

const paidPlanValidator = v.union(
  v.literal("go"),
  v.literal("pro"),
  v.literal("plus"),
  v.literal("ultra"),
);

const planConfigShapeValidator = v.object({
  label: v.string(),
  monthlyPriceCents: v.number(),
  rollingLimitUsd: v.number(),
  rollingWindowHours: v.number(),
  weeklyLimitUsd: v.number(),
  monthlyLimitUsd: v.number(),
  tokensPerMinute: v.number(),
});

const subscriptionStatusReturnValidator = v.object({
  authenticated: v.boolean(),
  isAnonymous: v.boolean(),
  plan: planValidator,
  subscriptionStatus: v.string(),
  cancelAtPeriodEnd: v.boolean(),
  currentPeriodEnd: v.union(v.number(), v.null()),
  usage: v.object({
    rollingUsedUsd: v.number(),
    rollingLimitUsd: v.number(),
    weeklyUsedUsd: v.number(),
    weeklyLimitUsd: v.number(),
    monthlyUsedUsd: v.number(),
    monthlyLimitUsd: v.number(),
  }),
  plans: v.object({
    free: planConfigShapeValidator,
    go: planConfigShapeValidator,
    pro: planConfigShapeValidator,
    plus: planConfigShapeValidator,
  }),
});

const STRIPE_API_VERSION = "2026-02-25.clover";
const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);

const emptyString = "";
const MODELS_DEV_API_URL = "https://models.dev/api.json";

const isAnonymousIdentity = (identity: unknown) =>
  Boolean(identity && typeof identity === "object" && (identity as Record<string, unknown>).isAnonymous === true);

const getStripeClient = () => {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Stripe is not configured.",
    });
  }

  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
};

const getStripePublishableKey = () => {
  const key =
    process.env.STRIPE_PUBLISHABLE_KEY?.trim()
    ?? process.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim()
    ?? emptyString;

  if (!key) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Stripe publishable key is not configured.",
    });
  }
  return key;
};

const toCurrencyAmount = (microCents: number) =>
  Number(microCentsToDollars(microCents).toFixed(4));

const toNonNegativeInt = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

const toSafeString = (value: string | null | undefined) => value?.trim() ?? emptyString;

const getOwnerBillingProfile = async (
  ctx: MutationCtx,
  ownerId: string,
) => await ctx.db
  .query("billing_profiles")
  .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
  .unique();

const getOwnerUsageRow = async (
  ctx: MutationCtx,
  ownerId: string,
) => await ctx.db
  .query("billing_usage_windows")
  .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
  .unique();

const createDefaultProfile = (ownerId: string, now: number) => ({
  ownerId,
  activePlan: "free" as const,
  subscriptionStatus: "none",
  stripeCustomerId: emptyString,
  stripeSubscriptionId: emptyString,
  stripePriceId: emptyString,
  defaultPaymentMethodId: emptyString,
  paymentMethodBrand: emptyString,
  paymentMethodLast4: emptyString,
  currentPeriodStart: 0,
  currentPeriodEnd: 0,
  cancelAtPeriodEnd: false,
  monthlyAnchorAt: now,
  createdAt: now,
  updatedAt: now,
});

const createDefaultUsage = (ownerId: string, now: number) => {
  const week = getWeekBounds(new Date(now));
  const month = getMonthlyBounds(new Date(now), new Date(now));

  return {
    ownerId,
    rollingUsageMicroCents: 0,
    rollingWindowStartedAt: now,
    weeklyUsageMicroCents: 0,
    weeklyWindowStartedAt: week.start.getTime(),
    monthlyUsageMicroCents: 0,
    monthlyWindowStartedAt: month.start.getTime(),
    totalUsageMicroCents: 0,
    createdAt: now,
    updatedAt: now,
  };
};

const ensureBillingRecordsForOwner = async (
  ctx: MutationCtx,
  ownerId: string,
) => {
  const now = Date.now();

  let profile = await getOwnerBillingProfile(ctx, ownerId);
  if (!profile) {
    const created = createDefaultProfile(ownerId, now);
    await ctx.db.insert("billing_profiles", created);
    profile = await getOwnerBillingProfile(ctx, ownerId);
  }

  if (!profile) {
    throw new ConvexError({
      code: "INTERNAL_ERROR",
      message: "Failed to initialize billing profile.",
    });
  }

  let usage = await getOwnerUsageRow(ctx, ownerId);
  if (!usage) {
    const created = createDefaultUsage(ownerId, now);
    await ctx.db.insert("billing_usage_windows", created);
    usage = await getOwnerUsageRow(ctx, ownerId);
  }

  if (!usage) {
    throw new ConvexError({
      code: "INTERNAL_ERROR",
      message: "Failed to initialize billing usage windows.",
    });
  }

  return { profile, usage };
};

type UsageSnapshot = {
  normalizedUsage: {
    rollingUsageMicroCents: number;
    rollingWindowStartedAt: number;
    weeklyUsageMicroCents: number;
    weeklyWindowStartedAt: number;
    monthlyUsageMicroCents: number;
    monthlyWindowStartedAt: number;
  };
  rolling: {
    used: number;
    limit: number;
    resetAt: number;
    exceeded: boolean;
  };
  weekly: {
    used: number;
    limit: number;
    resetAt: number;
    exceeded: boolean;
  };
  monthly: {
    used: number;
    limit: number;
    resetAt: number;
    exceeded: boolean;
  };
  changed: boolean;
};

const buildUsageSnapshot = (args: {
  profile: {
    monthlyAnchorAt: number;
  };
  usage: {
    rollingUsageMicroCents: number;
    rollingWindowStartedAt: number;
    weeklyUsageMicroCents: number;
    weeklyWindowStartedAt: number;
    monthlyUsageMicroCents: number;
    monthlyWindowStartedAt: number;
  };
  plan: SubscriptionPlan;
  now: number;
}): UsageSnapshot => {
  const planConfig = getPlanConfig(args.plan);
  const nowDate = new Date(args.now);

  const rollingWindowMs = Math.max(1, Math.floor(planConfig.rollingWindowHours * 60 * 60 * 1000));
  const rollingLimitMicroCents = dollarsToMicroCents(planConfig.rollingLimitUsd);
  const rollingWindowStartThreshold = args.now - rollingWindowMs;
  const rollingActive =
    args.usage.rollingWindowStartedAt > 0
    && args.usage.rollingWindowStartedAt >= rollingWindowStartThreshold;
  const rollingUsed = rollingActive ? args.usage.rollingUsageMicroCents : 0;
  const rollingStart = rollingActive ? args.usage.rollingWindowStartedAt : args.now;
  const rollingResetAt = rollingStart + rollingWindowMs;

  const week = getWeekBounds(nowDate);
  const weeklyLimitMicroCents = dollarsToMicroCents(planConfig.weeklyLimitUsd);
  const weeklyActive = args.usage.weeklyWindowStartedAt >= week.start.getTime();
  const weeklyUsed = weeklyActive ? args.usage.weeklyUsageMicroCents : 0;
  const weeklyStart = weeklyActive ? args.usage.weeklyWindowStartedAt : week.start.getTime();
  const weeklyResetAt = week.end.getTime();

  const anchor =
    args.profile.monthlyAnchorAt > 0 ? new Date(args.profile.monthlyAnchorAt) : nowDate;
  const month = getMonthlyBounds(nowDate, anchor);
  const monthlyLimitMicroCents = dollarsToMicroCents(planConfig.monthlyLimitUsd);
  const monthlyActive = args.usage.monthlyWindowStartedAt >= month.start.getTime();
  const monthlyUsed = monthlyActive ? args.usage.monthlyUsageMicroCents : 0;
  const monthlyStart = monthlyActive
    ? args.usage.monthlyWindowStartedAt
    : month.start.getTime();
  const monthlyResetAt = month.end.getTime();

  const normalizedUsage = {
    rollingUsageMicroCents: rollingUsed,
    rollingWindowStartedAt: rollingStart,
    weeklyUsageMicroCents: weeklyUsed,
    weeklyWindowStartedAt: weeklyStart,
    monthlyUsageMicroCents: monthlyUsed,
    monthlyWindowStartedAt: monthlyStart,
  };

  const changed =
    normalizedUsage.rollingUsageMicroCents !== args.usage.rollingUsageMicroCents
    || normalizedUsage.rollingWindowStartedAt !== args.usage.rollingWindowStartedAt
    || normalizedUsage.weeklyUsageMicroCents !== args.usage.weeklyUsageMicroCents
    || normalizedUsage.weeklyWindowStartedAt !== args.usage.weeklyWindowStartedAt
    || normalizedUsage.monthlyUsageMicroCents !== args.usage.monthlyUsageMicroCents
    || normalizedUsage.monthlyWindowStartedAt !== args.usage.monthlyWindowStartedAt;

  return {
    normalizedUsage,
    rolling: {
      used: rollingUsed,
      limit: rollingLimitMicroCents,
      resetAt: rollingResetAt,
      exceeded: rollingUsed >= rollingLimitMicroCents,
    },
    weekly: {
      used: weeklyUsed,
      limit: weeklyLimitMicroCents,
      resetAt: weeklyResetAt,
      exceeded: weeklyUsed >= weeklyLimitMicroCents,
    },
    monthly: {
      used: monthlyUsed,
      limit: monthlyLimitMicroCents,
      resetAt: monthlyResetAt,
      exceeded: monthlyUsed >= monthlyLimitMicroCents,
    },
    changed,
  };
};

const buildLimitMessage = (plan: SubscriptionPlan) => {
  if (plan === "free") {
    return "Free plan usage limit reached. Upgrade to continue.";
  }
  return `${getPlanConfig(plan).label} plan usage limit reached.`;
};

const buildDowngradeMessage = (plan: Exclude<SubscriptionPlan, "free">) =>
  `${getPlanConfig(plan).label} plan managed-model limits reached. Falling back until usage resets.`;

type ManagedModelAccessResult = {
  allowed: boolean;
  plan: SubscriptionPlan;
  downgraded: boolean;
  modelAudience: ReturnType<typeof resolveManagedModelAudience>;
  retryAfterMs: number;
  message: string;
  tokensPerMinute: number;
};

const buildManagedModelAccessResult = (args: {
  plan: SubscriptionPlan;
  isAnonymous?: boolean;
  exceededWindow: UsageSnapshot["rolling"] | UsageSnapshot["weekly"] | UsageSnapshot["monthly"] | null;
  now: number;
}): ManagedModelAccessResult => {
  const { plan, exceededWindow, now } = args;
  const tokensPerMinute = getPlanConfig(plan).tokensPerMinute;

  if (!exceededWindow) {
    return {
      allowed: true,
      plan,
      downgraded: false,
      modelAudience: resolveManagedModelAudience({
        plan,
        isAnonymous: args.isAnonymous,
      }),
      retryAfterMs: 0,
      message: emptyString,
      tokensPerMinute,
    };
  }

  const retryAfterMs = Math.max(1_000, exceededWindow.resetAt - now);
  if (plan === "free") {
    return {
      allowed: false,
      plan,
      downgraded: false,
      modelAudience: resolveManagedModelAudience({
        plan,
        isAnonymous: args.isAnonymous,
      }),
      retryAfterMs,
      message: buildLimitMessage(plan),
      tokensPerMinute,
    };
  }

  return {
    allowed: true,
    plan,
    downgraded: true,
    modelAudience: resolveManagedModelAudience({
      plan,
      downgraded: true,
    }),
    retryAfterMs,
    message: buildDowngradeMessage(plan),
    tokensPerMinute,
  };
};

export type ManagedUsageRecordArgs = {
  ownerId: string;
  agentType: string;
  model: string;
  durationMs: number;
  success: boolean;
  conversationId?: Id<"conversations"> | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  costMicroCents?: number;
  fallbackUsed?: boolean;
  toolCalls?: number;
};

const getManagedModelPriceRow = async (
  ctx: MutationCtx,
  model: string,
) => await ctx.db
  .query("billing_model_prices")
  .withIndex("by_model", (q) => q.eq("model", model))
  .unique();

const toTokenPriceConfig = (
  row: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd: number;
    cacheWritePerMillionUsd: number;
    reasoningPerMillionUsd: number;
  } | null,
): TokenPriceConfig | undefined =>
  row
    ? {
      inputPerMillionUsd: row.inputPerMillionUsd,
      outputPerMillionUsd: row.outputPerMillionUsd,
      cacheReadPerMillionUsd: row.cacheReadPerMillionUsd,
      cacheWritePerMillionUsd: row.cacheWritePerMillionUsd,
      reasoningPerMillionUsd: row.reasoningPerMillionUsd,
    }
    : undefined;

const getDefaultConversationIdForOwner = async (
  ctx: MutationCtx,
  ownerId: string,
) => {
  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_ownerId_and_isDefault", (q) =>
      q.eq("ownerId", ownerId).eq("isDefault", true),
    )
    .first();
  return conversation?._id ?? null;
};

export const persistManagedUsage = async (
  ctx: MutationCtx,
  args: ManagedUsageRecordArgs,
) => {
  const inputTokens = toNonNegativeInt(args.inputTokens);
  const outputTokens = toNonNegativeInt(args.outputTokens);
  const cachedInputTokens = toNonNegativeInt(args.cachedInputTokens);
  const cacheWriteInputTokens = toNonNegativeInt(args.cacheWriteInputTokens);
  const reasoningTokens = toNonNegativeInt(args.reasoningTokens);
  const totalTokens = typeof args.totalTokens === "number" && Number.isFinite(args.totalTokens)
    ? Math.max(0, Math.floor(args.totalTokens))
    : inputTokens + outputTokens;
  const modelPrice = toTokenPriceConfig(await getManagedModelPriceRow(ctx, args.model));
  const costMicroCents =
    typeof args.costMicroCents === "number" && Number.isFinite(args.costMicroCents)
      ? Math.max(0, Math.floor(args.costMicroCents))
      : computeUsageCostMicroCents({
        model: args.model,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        reasoningTokens,
        price: modelPrice,
      });

  const { profile, usage } = await ensureBillingRecordsForOwner(ctx, args.ownerId);
  const plan = profile.activePlan as SubscriptionPlan;
  const now = Date.now();

  const snapshot = buildUsageSnapshot({
    profile,
    usage,
    plan,
    now,
  });

  await ctx.db.patch(usage._id, {
    rollingUsageMicroCents: snapshot.normalizedUsage.rollingUsageMicroCents + costMicroCents,
    rollingWindowStartedAt: snapshot.normalizedUsage.rollingWindowStartedAt,
    weeklyUsageMicroCents: snapshot.normalizedUsage.weeklyUsageMicroCents + costMicroCents,
    weeklyWindowStartedAt: snapshot.normalizedUsage.weeklyWindowStartedAt,
    monthlyUsageMicroCents: snapshot.normalizedUsage.monthlyUsageMicroCents + costMicroCents,
    monthlyWindowStartedAt: snapshot.normalizedUsage.monthlyWindowStartedAt,
    totalUsageMicroCents: usage.totalUsageMicroCents + costMicroCents,
    updatedAt: now,
  });

  const conversationId = args.conversationId ?? await getDefaultConversationIdForOwner(ctx, args.ownerId);
  if (conversationId) {
    await ctx.db.insert("usage_logs", {
      ownerId: args.ownerId,
      conversationId,
      agentType: args.agentType,
      model: args.model,
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      costMicroCents,
      billingPlan: plan,
      durationMs: Math.max(0, Math.floor(args.durationMs)),
      success: args.success,
      ...(args.fallbackUsed !== undefined ? { fallbackUsed: args.fallbackUsed } : {}),
      ...(args.toolCalls !== undefined ? { toolCalls: args.toolCalls } : {}),
      createdAt: now,
    });
  }

  return {
    costMicroCents,
    plan,
  };
};

const getExistingVoiceUsageReceipt = async (
  ctx: MutationCtx,
  ownerId: string,
  responseId: string,
) => await ctx.db
  .query("billing_voice_usage_receipts")
  .withIndex("by_ownerId_and_responseId", (q) =>
    q.eq("ownerId", ownerId).eq("responseId", responseId),
  )
  .unique();

const getExistingMediaUsageReceipt = async (
  ctx: MutationCtx,
  ownerId: string,
  jobId: string,
) => await ctx.db
  .query("billing_media_usage_receipts")
  .withIndex("by_ownerId_and_jobId", (q) =>
    q.eq("ownerId", ownerId).eq("jobId", jobId),
  )
  .unique();

export const recordVoiceRealtimeUsage = internalMutation({
  args: {
    ownerId: v.string(),
    responseId: v.string(),
    model: v.string(),
    conversationId: v.optional(v.id("conversations")),
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
    textInputTokens: v.number(),
    textCachedInputTokens: v.number(),
    textOutputTokens: v.number(),
    audioInputTokens: v.number(),
    audioCachedInputTokens: v.number(),
    audioOutputTokens: v.number(),
    imageInputTokens: v.number(),
    imageCachedInputTokens: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await getExistingVoiceUsageReceipt(
      ctx,
      args.ownerId,
      args.responseId,
    );
    if (existing) {
      return {
        recorded: false,
        duplicate: true,
        costMicroCents: existing.costMicroCents,
      };
    }

    const costMicroCents = computeRealtimeUsageCostMicroCents({
      model: args.model,
      textInputTokens: args.textInputTokens,
      textCachedInputTokens: args.textCachedInputTokens,
      textOutputTokens: args.textOutputTokens,
      audioInputTokens: args.audioInputTokens,
      audioCachedInputTokens: args.audioCachedInputTokens,
      audioOutputTokens: args.audioOutputTokens,
      imageInputTokens: args.imageInputTokens,
      imageCachedInputTokens: args.imageCachedInputTokens,
    });

    await persistManagedUsage(ctx, {
      ownerId: args.ownerId,
      conversationId: args.conversationId ?? null,
      agentType: "service:voice:realtime",
      model: args.model,
      durationMs: 0,
      success: true,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      costMicroCents,
    });

    await ctx.db.insert("billing_voice_usage_receipts", {
      ownerId: args.ownerId,
      responseId: args.responseId,
      model: args.model,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.totalTokens,
      textInputTokens: args.textInputTokens,
      textCachedInputTokens: args.textCachedInputTokens,
      textOutputTokens: args.textOutputTokens,
      audioInputTokens: args.audioInputTokens,
      audioCachedInputTokens: args.audioCachedInputTokens,
      audioOutputTokens: args.audioOutputTokens,
      imageInputTokens: args.imageInputTokens,
      imageCachedInputTokens: args.imageCachedInputTokens,
      costMicroCents,
      createdAt: Date.now(),
    });

    return {
      recorded: true,
      duplicate: false,
      costMicroCents,
    };
  },
});

export const recordMediaCompletedUsage = internalMutation({
  args: {
    ownerId: v.string(),
    jobId: v.string(),
    providerRequestId: v.optional(v.string()),
    endpointId: v.string(),
    billingUnit: v.string(),
    quantity: v.number(),
    costMicroCents: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await getExistingMediaUsageReceipt(
      ctx,
      args.ownerId,
      args.jobId,
    );
    if (existing) {
      return {
        recorded: false,
        duplicate: true,
        costMicroCents: existing.costMicroCents,
      };
    }

    await persistManagedUsage(ctx, {
      ownerId: args.ownerId,
      agentType: "service:media",
      model: args.endpointId,
      durationMs: 0,
      success: true,
      costMicroCents: args.costMicroCents,
    });

    await ctx.db.insert("billing_media_usage_receipts", {
      ownerId: args.ownerId,
      jobId: args.jobId,
      ...(args.providerRequestId ? { providerRequestId: args.providerRequestId } : {}),
      endpointId: args.endpointId,
      billingUnit: args.billingUnit,
      quantity: args.quantity,
      costMicroCents: args.costMicroCents,
      createdAt: Date.now(),
    });

    return {
      recorded: true,
      duplicate: false,
      costMicroCents: args.costMicroCents,
    };
  },
});

const normalizeReturnUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Invalid return URL.",
    });
  }

  const host = parsed.hostname.toLowerCase();
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocalHost && parsed.protocol !== "https:") {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Return URL must use HTTPS outside local development.",
    });
  }

  return parsed.toString();
};

const withCheckoutSessionPlaceholder = (returnUrl: string) => {
  const parsed = new URL(returnUrl);
  parsed.searchParams.set("checkoutSessionId", "{CHECKOUT_SESSION_ID}");
  return parsed.toString();
};

export const ensureBillingRecords = internalMutation({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const { profile, usage } = await ensureBillingRecordsForOwner(ctx, args.ownerId);
    return {
      ownerId: profile.ownerId,
      activePlan: profile.activePlan,
      subscriptionStatus: profile.subscriptionStatus,
      stripeCustomerId: profile.stripeCustomerId,
      stripeSubscriptionId: profile.stripeSubscriptionId,
      stripePriceId: profile.stripePriceId,
      currentPeriodEnd: profile.currentPeriodEnd,
      usageUpdatedAt: usage.updatedAt,
    };
  },
});

export const getBillingProfileByOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
    .unique(),
});

export const linkStripeCustomerToOwner = internalMutation({
  args: {
    ownerId: v.string(),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args) => {
    const stripeCustomerId = args.stripeCustomerId.trim();
    if (!stripeCustomerId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Stripe customer ID is required.",
      });
    }

    const existingCustomerOwner = await ctx.db
      .query("billing_profiles")
      .withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", stripeCustomerId))
      .unique();

    if (existingCustomerOwner && existingCustomerOwner.ownerId !== args.ownerId) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Stripe customer is already linked to a different account.",
      });
    }

    const { profile } = await ensureBillingRecordsForOwner(ctx, args.ownerId);
    if (profile.stripeCustomerId !== stripeCustomerId) {
      await ctx.db.patch(profile._id, {
        stripeCustomerId,
        updatedAt: Date.now(),
      });
    }

    return { ownerId: args.ownerId, stripeCustomerId };
  },
});

export const updatePaymentMethodForCustomer = internalMutation({
  args: {
    stripeCustomerId: v.string(),
    defaultPaymentMethodId: v.optional(v.string()),
    paymentMethodBrand: v.optional(v.string()),
    paymentMethodLast4: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const customerId = args.stripeCustomerId.trim();
    if (!customerId) {
      return { updated: false };
    }

    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", customerId))
      .unique();
    if (!profile) {
      return { updated: false };
    }

    await ctx.db.patch(profile._id, {
      defaultPaymentMethodId: toSafeString(args.defaultPaymentMethodId),
      paymentMethodBrand: toSafeString(args.paymentMethodBrand),
      paymentMethodLast4: toSafeString(args.paymentMethodLast4),
      updatedAt: Date.now(),
    });
    return { updated: true };
  },
});

export const recordStripeEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    ownerId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();

    if (existing) {
      return { accepted: false };
    }

    await ctx.db.insert("billing_stripe_events", {
      eventId: args.eventId,
      eventType: args.eventType,
      ownerId: toSafeString(args.ownerId),
      stripeCustomerId: toSafeString(args.stripeCustomerId),
      stripeSubscriptionId: toSafeString(args.stripeSubscriptionId),
      createdAt: args.createdAt,
      processedAt: Date.now(),
    });

    return { accepted: true };
  },
});

export const deleteStripeEvent = internalMutation({
  args: {
    eventId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billing_stripe_events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

export const syncSubscriptionFromStripe = internalMutation({
  args: {
    ownerId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.optional(v.string()),
    requestedPlan: v.optional(planValidator),
    subscriptionStatus: v.string(),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    defaultPaymentMethodId: v.optional(v.string()),
    paymentMethodBrand: v.optional(v.string()),
    paymentMethodLast4: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedCustomerId = toSafeString(args.stripeCustomerId);
    let ownerId = toSafeString(args.ownerId);

    if (!ownerId && normalizedCustomerId) {
      const byCustomer = await ctx.db
        .query("billing_profiles")
        .withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", normalizedCustomerId))
        .unique();
      ownerId = byCustomer?.ownerId ?? emptyString;
    }

    if (!ownerId) {
      return { updated: false, ownerId: null, activePlan: "free" as const };
    }

    const { profile, usage } = await ensureBillingRecordsForOwner(ctx, ownerId);
    const normalizedStatus = args.subscriptionStatus.trim().toLowerCase();
    const requestedPlan = args.requestedPlan && args.requestedPlan !== "free"
      ? args.requestedPlan
      : null;
    const planFromPriceId = findPlanForStripePriceId(args.stripePriceId);
    const resolvedPaidPlan = requestedPlan ?? planFromPriceId;
    const nextPlan: SubscriptionPlan =
      ACTIVE_SUBSCRIPTION_STATUSES.has(normalizedStatus) && resolvedPaidPlan
        ? resolvedPaidPlan
        : "free";

    const now = Date.now();
    const nextCurrentPeriodStart = toNonNegativeInt(args.currentPeriodStart);
    const nextCurrentPeriodEnd = toNonNegativeInt(args.currentPeriodEnd);
    const nextAnchor =
      nextPlan === "free"
        ? (profile.monthlyAnchorAt > 0 ? profile.monthlyAnchorAt : now)
        : (nextCurrentPeriodStart > 0 ? nextCurrentPeriodStart : now);

    await ctx.db.patch(profile._id, {
      activePlan: nextPlan,
      subscriptionStatus: normalizedStatus,
      stripeCustomerId: normalizedCustomerId || profile.stripeCustomerId,
      stripeSubscriptionId:
        nextPlan === "free" ? emptyString : toSafeString(args.stripeSubscriptionId),
      stripePriceId: nextPlan === "free" ? emptyString : toSafeString(args.stripePriceId),
      defaultPaymentMethodId: toSafeString(args.defaultPaymentMethodId),
      paymentMethodBrand: toSafeString(args.paymentMethodBrand),
      paymentMethodLast4: toSafeString(args.paymentMethodLast4),
      currentPeriodStart: nextCurrentPeriodStart,
      currentPeriodEnd: nextCurrentPeriodEnd,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd === true,
      monthlyAnchorAt: nextAnchor,
      updatedAt: now,
    });

    if (profile.activePlan !== nextPlan) {
      const week = getWeekBounds(new Date(now));
      const month = getMonthlyBounds(new Date(now), new Date(nextAnchor));
      await ctx.db.patch(usage._id, {
        rollingUsageMicroCents: 0,
        rollingWindowStartedAt: now,
        weeklyUsageMicroCents: 0,
        weeklyWindowStartedAt: week.start.getTime(),
        monthlyUsageMicroCents: 0,
        monthlyWindowStartedAt: month.start.getTime(),
        updatedAt: now,
      });
    }

    return { updated: true, ownerId, activePlan: nextPlan };
  },
});

export const recordInvoicePayment = internalMutation({
  args: {
    ownerId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeInvoiceId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    amountPaidCents: v.number(),
    currency: v.string(),
    billingReason: v.string(),
    status: v.string(),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let ownerId = toSafeString(args.ownerId);
    const customerId = toSafeString(args.stripeCustomerId);

    if (!ownerId && customerId) {
      const byCustomer = await ctx.db
        .query("billing_profiles")
        .withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", customerId))
        .unique();
      ownerId = byCustomer?.ownerId ?? emptyString;
    }

    if (!ownerId) {
      return { recorded: false };
    }

    await ensureBillingRecordsForOwner(ctx, ownerId);

    const existing = await ctx.db
      .query("billing_invoice_payments")
      .withIndex("by_stripeInvoiceId", (q) => q.eq("stripeInvoiceId", args.stripeInvoiceId))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ownerId,
        stripePaymentIntentId: toSafeString(args.stripePaymentIntentId),
        stripeSubscriptionId: toSafeString(args.stripeSubscriptionId),
        amountPaidCents: Math.max(0, Math.floor(args.amountPaidCents)),
        currency: args.currency,
        billingReason: args.billingReason,
        status: args.status,
        periodStart: toNonNegativeInt(args.periodStart),
        periodEnd: toNonNegativeInt(args.periodEnd),
        updatedAt: now,
      });
      return { recorded: true };
    }

    await ctx.db.insert("billing_invoice_payments", {
      ownerId,
      stripeInvoiceId: args.stripeInvoiceId,
      stripePaymentIntentId: toSafeString(args.stripePaymentIntentId),
      stripeSubscriptionId: toSafeString(args.stripeSubscriptionId),
      amountPaidCents: Math.max(0, Math.floor(args.amountPaidCents)),
      currency: args.currency,
      billingReason: args.billingReason,
      status: args.status,
      periodStart: toNonNegativeInt(args.periodStart),
      periodEnd: toNonNegativeInt(args.periodEnd),
      createdAt: now,
      updatedAt: now,
    });

    return { recorded: true };
  },
});

export const resolveManagedModelAccess = internalMutation({
  args: {
    ownerId: v.string(),
    isAnonymous: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ManagedModelAccessResult> => {
    const { profile, usage } = await ensureBillingRecordsForOwner(ctx, args.ownerId);
    const now = Date.now();
    const plan = profile.activePlan as SubscriptionPlan;
    const snapshot = buildUsageSnapshot({
      profile,
      usage,
      plan,
      now,
    });

    if (snapshot.changed) {
      await ctx.db.patch(usage._id, {
        ...snapshot.normalizedUsage,
        updatedAt: now,
      });
    }

    const firstExceeded =
      snapshot.rolling.exceeded
        ? snapshot.rolling
        : snapshot.weekly.exceeded
          ? snapshot.weekly
          : snapshot.monthly.exceeded
            ? snapshot.monthly
            : null;

    return buildManagedModelAccessResult({
      plan,
      isAnonymous: args.isAnonymous,
      exceededWindow: firstExceeded,
      now,
    });
  },
});

export const enforceManagedUsageLimit = internalMutation({
  args: {
    ownerId: v.string(),
    minimumRemainingMicroCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { profile, usage } = await ensureBillingRecordsForOwner(ctx, args.ownerId);
    const now = Date.now();
    const plan = profile.activePlan as SubscriptionPlan;
    const snapshot = buildUsageSnapshot({
      profile,
      usage,
      plan,
      now,
    });

    if (snapshot.changed) {
      await ctx.db.patch(usage._id, {
        ...snapshot.normalizedUsage,
        updatedAt: now,
      });
    }

    const minimumRemainingMicroCents = Math.max(
      0,
      Math.floor(args.minimumRemainingMicroCents ?? 0),
    );
    const isBlockedByBuffer = (window: { used: number; limit: number }) =>
      minimumRemainingMicroCents > 0
      && Math.max(0, window.limit - window.used) <= minimumRemainingMicroCents;

    const firstExceeded =
      snapshot.rolling.exceeded || isBlockedByBuffer(snapshot.rolling)
        ? snapshot.rolling
        : snapshot.weekly.exceeded || isBlockedByBuffer(snapshot.weekly)
          ? snapshot.weekly
          : snapshot.monthly.exceeded || isBlockedByBuffer(snapshot.monthly)
            ? snapshot.monthly
            : null;

    if (firstExceeded) {
      return {
        allowed: false,
        plan,
        message: buildLimitMessage(plan),
        retryAfterMs: Math.max(1_000, firstExceeded.resetAt - now),
        tokensPerMinute: getPlanConfig(plan).tokensPerMinute,
      };
    }

    return {
      allowed: true,
      plan,
      retryAfterMs: 0,
      message: emptyString,
      tokensPerMinute: getPlanConfig(plan).tokensPerMinute,
    };
  },
});

export const logManagedUsage = internalMutation({
  args: {
    ownerId: v.string(),
    agentType: v.string(),
    model: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
    conversationId: v.optional(v.id("conversations")),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costMicroCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => await persistManagedUsage(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    agentType: `proxy:${args.agentType}`,
    model: args.model,
    durationMs: args.durationMs,
    success: args.success,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    totalTokens: args.totalTokens,
    cachedInputTokens: args.cachedInputTokens,
    cacheWriteInputTokens: args.cacheWriteInputTokens,
    reasoningTokens: args.reasoningTokens,
    costMicroCents: args.costMicroCents,
  }),
});

export const getManagedModelPrice = internalQuery({
  args: {
    model: v.string(),
  },
  handler: async (ctx, args) => await ctx.db
    .query("billing_model_prices")
    .withIndex("by_model", (q) => q.eq("model", args.model))
    .unique(),
});

export const upsertManagedModelPrices = internalMutation({
  args: {
    prices: v.array(v.object({
      model: v.string(),
      source: v.string(),
      sourceProvider: v.string(),
      sourceModelId: v.string(),
      inputPerMillionUsd: v.number(),
      outputPerMillionUsd: v.number(),
      cacheReadPerMillionUsd: v.number(),
      cacheWritePerMillionUsd: v.number(),
      reasoningPerMillionUsd: v.number(),
      sourceUpdatedAt: v.string(),
      syncedAt: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    for (const price of args.prices) {
      const existing = await ctx.db
        .query("billing_model_prices")
        .withIndex("by_model", (q) => q.eq("model", price.model))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, price);
        continue;
      }

      await ctx.db.insert("billing_model_prices", price);
    }

    return {
      upserted: args.prices.length,
    };
  },
});

export const syncManagedModelPricesFromModelsDev = internalAction({
  args: {},
  handler: async (ctx): Promise<{ syncedAt: number; upserted: number; source: string }> => {
    const response = await fetch(MODELS_DEV_API_URL, { method: "GET" });
    if (!response.ok) {
      throw new ConvexError({
        code: "MODEL_PRICE_SYNC_FAILED",
        message: `models.dev sync failed with status ${response.status}`,
      });
    }

    const data = await response.json() as ModelsDevApi;
    const syncedAt = Date.now();
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data,
      modelIds: listManagedModelIds(),
      syncedAt,
    });

    if (missingModels.length > 0) {
      throw new ConvexError({
        code: "MODEL_PRICE_SYNC_INCOMPLETE",
        message: `models.dev is missing prices for: ${missingModels.join(", ")}`,
      });
    }

    const upserted: { upserted: number } = await ctx.runMutation(internal.billing.upsertManagedModelPrices, {
      prices: entries as ManagedModelPriceEntry[] as never,
    });

    return {
      syncedAt,
      upserted: upserted.upserted,
      source: MODELS_DEV_API_URL,
    };
  },
});

/**
 * Public subscription/usage snapshot.
 *
 * `now` is optional. When omitted (e.g. callers that only need the plan
 * label), the query returns the usage figures **as stored** on the
 * `billing_usage_windows` row without recomputing window expiration. When
 * supplied, callers MUST bucket the value (e.g. floor to a minute) so
 * `useQuery` subscribers don't invalidate on every render — see
 * `desktop/src/global/settings/BillingTab.tsx` for the canonical pattern
 * (60-second `setInterval`).
 */
export const getSubscriptionStatus = query({
  args: {
    now: v.optional(v.number()),
  },
  returns: subscriptionStatusReturnValidator,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const planCatalog = getPlanCatalog();

    const plans = {
      free: planCatalog.free,
      go: planCatalog.go,
      pro: planCatalog.pro,
      plus: planCatalog.plus,
    };

    if (!identity) {
      return {
        authenticated: false,
        isAnonymous: true,
        plan: "free" as SubscriptionPlan,
        subscriptionStatus: "none",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        usage: {
          rollingUsedUsd: 0,
          rollingLimitUsd: planCatalog.free.rollingLimitUsd,
          weeklyUsedUsd: 0,
          weeklyLimitUsd: planCatalog.free.weeklyLimitUsd,
          monthlyUsedUsd: 0,
          monthlyLimitUsd: planCatalog.free.monthlyLimitUsd,
        },
        plans,
      };
    }

    const ownerId = identity.tokenIdentifier;
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    const usage = await ctx.db
      .query("billing_usage_windows")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();

    // Use the stored `updatedAt` as a deterministic fallback when the caller
    // doesn't pass `now`. This keeps the query reactive on data changes
    // while avoiding per-render `Date.now()` cache invalidation.
    const fallbackNow = args.now ?? usage?.updatedAt ?? profile?.updatedAt ?? 0;
    const normalizedProfile = profile ?? createDefaultProfile(ownerId, fallbackNow);
    const normalizedUsage = usage ?? createDefaultUsage(ownerId, fallbackNow);
    const plan = normalizedProfile.activePlan as SubscriptionPlan;
    const planConfig = getPlanConfig(plan);

    const usageSection = args.now !== undefined
      ? (() => {
        const snapshot = buildUsageSnapshot({
          profile: normalizedProfile,
          usage: normalizedUsage,
          plan,
          now: args.now!,
        });
        return {
          rollingUsedUsd: toCurrencyAmount(snapshot.rolling.used),
          rollingLimitUsd: toCurrencyAmount(snapshot.rolling.limit),
          weeklyUsedUsd: toCurrencyAmount(snapshot.weekly.used),
          weeklyLimitUsd: toCurrencyAmount(snapshot.weekly.limit),
          monthlyUsedUsd: toCurrencyAmount(snapshot.monthly.used),
          monthlyLimitUsd: toCurrencyAmount(snapshot.monthly.limit),
        };
      })()
      : {
        rollingUsedUsd: toCurrencyAmount(normalizedUsage.rollingUsageMicroCents),
        rollingLimitUsd: toCurrencyAmount(dollarsToMicroCents(planConfig.rollingLimitUsd)),
        weeklyUsedUsd: toCurrencyAmount(normalizedUsage.weeklyUsageMicroCents),
        weeklyLimitUsd: toCurrencyAmount(dollarsToMicroCents(planConfig.weeklyLimitUsd)),
        monthlyUsedUsd: toCurrencyAmount(normalizedUsage.monthlyUsageMicroCents),
        monthlyLimitUsd: toCurrencyAmount(dollarsToMicroCents(planConfig.monthlyLimitUsd)),
      };

    return {
      authenticated: true,
      isAnonymous: isAnonymousIdentity(identity),
      plan,
      subscriptionStatus: normalizedProfile.subscriptionStatus,
      cancelAtPeriodEnd: normalizedProfile.cancelAtPeriodEnd,
      currentPeriodEnd: normalizedProfile.currentPeriodEnd > 0 ? normalizedProfile.currentPeriodEnd : null,
      usage: usageSection,
      plans,
    };
  },
});

export const createEmbeddedCheckoutSession = action({
  args: {
    plan: paidPlanValidator,
    returnUrl: v.string(),
  },
  returns: v.object({
    publishableKey: v.string(),
    clientSecret: v.string(),
    sessionId: v.string(),
  }),
  handler: async (ctx, args): Promise<{ publishableKey: string; clientSecret: string; sessionId: string }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    if (isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Please sign in with an account before subscribing.",
      });
    }

    const ownerId = identity.tokenIdentifier;
    // Each call hits the live Stripe API (customer.create / checkout.create);
    // tight cap protects both Stripe rate limits and our cost.
    await enforceActionRateLimit(
      ctx,
      "billing_create_checkout_session",
      ownerId,
      RATE_EXPENSIVE,
      "Too many checkout requests. Please wait a moment and try again.",
    );
    const normalizedReturnUrl = normalizeReturnUrl(args.returnUrl);
    const stripe = getStripeClient();
    const publishableKey = getStripePublishableKey();

    const billing: {
      ownerId: string;
      activePlan: string;
      subscriptionStatus: string;
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodEnd: number;
      usageUpdatedAt: number;
    } = await ctx.runMutation(internal.billing.ensureBillingRecords, {
      ownerId,
    });

    if (
      billing.activePlan !== "free"
      && ACTIVE_SUBSCRIPTION_STATUSES.has(billing.subscriptionStatus)
    ) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "You already have an active subscription. Use billing management to change plans.",
      });
    }

    let stripeCustomerId = billing.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: {
          ownerId,
        },
      });
      stripeCustomerId = customer.id;

      await ctx.runMutation(internal.billing.linkStripeCustomerToOwner, {
        ownerId,
        stripeCustomerId,
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      ui_mode: "embedded",
      customer: stripeCustomerId,
      line_items: [
        {
          price: getStripePriceIdForPlan(args.plan),
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      return_url: withCheckoutSessionPlaceholder(normalizedReturnUrl),
      metadata: {
        ownerId,
        plan: args.plan,
      },
      subscription_data: {
        metadata: {
          ownerId,
          plan: args.plan,
        },
      },
    });

    if (!checkoutSession.client_secret) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Stripe did not return a checkout client secret.",
      });
    }

    return {
      publishableKey,
      clientSecret: checkoutSession.client_secret,
      sessionId: checkoutSession.id,
    };
  },
});

export const createBillingPortalSession = action({
  args: {
    returnUrl: v.string(),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    if (isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Please sign in with an account before opening billing.",
      });
    }

    const ownerId = identity.tokenIdentifier;
    await enforceActionRateLimit(
      ctx,
      "billing_create_portal_session",
      ownerId,
      RATE_EXPENSIVE,
      "Too many billing portal requests. Please wait a moment and try again.",
    );
    const billing: {
      ownerId: string;
      activePlan: string;
      subscriptionStatus: string;
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodEnd: number;
      usageUpdatedAt: number;
    } = await ctx.runMutation(internal.billing.ensureBillingRecords, {
      ownerId,
    });

    if (!billing.stripeCustomerId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No billing customer is linked to this account yet.",
      });
    }

    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: normalizeReturnUrl(args.returnUrl),
    });

    return {
      url: session.url,
    };
  },
});

export const getCurrentPlan = query({
  args: {},
  returns: planValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const profile = await ctx.db
      .query("billing_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    return (profile?.activePlan as SubscriptionPlan | undefined) ?? "free";
  },
});
