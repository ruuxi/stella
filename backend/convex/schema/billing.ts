import { defineTable } from "convex/server";
import { v } from "convex/values";

export const subscriptionPlanValidator = v.union(
  v.literal("free"),
  v.literal("go"),
  v.literal("pro"),
  v.literal("plus"),
  v.literal("ultra"),
);

export const billingSchema = {
  billing_profiles: defineTable({
    ownerId: v.string(),
    activePlan: subscriptionPlanValidator,
    subscriptionStatus: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.string(),
    defaultPaymentMethodId: v.string(),
    paymentMethodBrand: v.string(),
    paymentMethodLast4: v.string(),
    currentPeriodStart: v.number(),
    currentPeriodEnd: v.number(),
    cancelAtPeriodEnd: v.boolean(),
    monthlyAnchorAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_stripeCustomerId", ["stripeCustomerId"])
    .index("by_stripeSubscriptionId", ["stripeSubscriptionId"]),

  billing_usage_windows: defineTable({
    ownerId: v.string(),
    rollingUsageMicroCents: v.number(),
    rollingWindowStartedAt: v.number(),
    weeklyUsageMicroCents: v.number(),
    weeklyWindowStartedAt: v.number(),
    monthlyUsageMicroCents: v.number(),
    monthlyWindowStartedAt: v.number(),
    totalUsageMicroCents: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  billing_model_prices: defineTable({
    model: v.string(),
    source: v.string(),
    sourceProvider: v.string(),
    sourceModelId: v.string(),
    inputPerMillionUsd: v.number(),
    outputPerMillionUsd: v.number(),
    cacheReadPerMillionUsd: v.number(),
    cacheWritePerMillionUsd: v.number(),
    reasoningPerMillionUsd: v.number(),
    /**
     * Input modalities advertised by models.dev (or its fallback). Optional
     * because pre-existing rows pre-date the modality sync; readers default
     * to ["text"] when missing so unknown models drop images at the gateway
     * boundary instead of being silently forwarded as data URLs.
     */
    modalitiesInput: v.optional(v.array(v.string())),
    /** Output modalities advertised by models.dev. Defaults to ["text"]. */
    modalitiesOutput: v.optional(v.array(v.string())),
    sourceUpdatedAt: v.string(),
    syncedAt: v.number(),
  })
    .index("by_model", ["model"])
    .index("by_syncedAt", ["syncedAt"]),

  billing_voice_usage_receipts: defineTable({
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
    costMicroCents: v.number(),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_responseId", ["ownerId", "responseId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  billing_media_usage_receipts: defineTable({
    ownerId: v.string(),
    jobId: v.string(),
    providerRequestId: v.optional(v.string()),
    endpointId: v.string(),
    billingUnit: v.string(),
    quantity: v.number(),
    costMicroCents: v.number(),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_jobId", ["ownerId", "jobId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),

  billing_stripe_events: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    ownerId: v.string(),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    createdAt: v.number(),
    processedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_processedAt", ["processedAt"]),

  billing_invoice_payments: defineTable({
    ownerId: v.string(),
    stripeInvoiceId: v.string(),
    stripePaymentIntentId: v.string(),
    stripeSubscriptionId: v.string(),
    amountPaidCents: v.number(),
    currency: v.string(),
    billingReason: v.string(),
    status: v.string(),
    periodStart: v.number(),
    periodEnd: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_stripeInvoiceId", ["stripeInvoiceId"])
    .index("by_stripePaymentIntentId", ["stripePaymentIntentId"]),
};
