import { defineTable } from "convex/server";
import { v } from "convex/values";

export const subscriptionPlanValidator = v.union(
  v.literal("free"),
  v.literal("go"),
  v.literal("pro"),
  v.literal("plus"),
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
