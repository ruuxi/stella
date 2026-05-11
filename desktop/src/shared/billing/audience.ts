/**
 * Desktop-side mirror of the backend's `ManagedModelAudience` notion.
 *
 * Source of truth for the audience values, restriction set, and plan label
 * mapping lives in `backend/convex/agent/model.ts`. Keep these constants in
 * sync when the backend changes — the desktop uses them to surface a "this
 * model isn't allowed on your plan" toast at picker time, since the backend
 * silently coerces the model on restricted tiers and we don't want users to
 * wonder why their selection wasn't honored.
 */

export type SubscriptionPlan = "free" | "go" | "pro" | "plus" | "ultra";

export type ManagedModelAudience =
  | "anonymous"
  | "free"
  | "go"
  | "pro"
  | "plus"
  | "ultra"
  | "go_fallback"
  | "pro_fallback"
  | "plus_fallback"
  | "ultra_fallback";

const RESTRICTED_MODEL_OVERRIDE_AUDIENCES = new Set<ManagedModelAudience>([
  "anonymous",
  "free",
  "go",
  "go_fallback",
]);

export const isRestrictedModelOverrideAudience = (
  audience: ManagedModelAudience | null | undefined,
): boolean =>
  audience !== null &&
  audience !== undefined &&
  RESTRICTED_MODEL_OVERRIDE_AUDIENCES.has(audience);

const PLAN_LABELS: Record<ManagedModelAudience, string> = {
  anonymous: "Free",
  free: "Free",
  go: "Go",
  pro: "Pro",
  plus: "Plus",
  ultra: "Ultra",
  go_fallback: "Go",
  pro_fallback: "Pro",
  plus_fallback: "Plus",
  ultra_fallback: "Ultra",
};

export const getPlanLabel = (audience: ManagedModelAudience): string =>
  PLAN_LABELS[audience];

export const getModelRestrictionActionLabel = (
  audience: ManagedModelAudience,
): string => (audience === "anonymous" ? "Sign in" : "Upgrade");

export const getModelRestrictionDescription = (args: {
  audience: ManagedModelAudience;
  modelLabel: string;
  tense: "will" | "is";
}): string => {
  const recommendedPhrase =
    args.tense === "will"
      ? "Stella will use its recommended model."
      : "Stella is using its recommended model.";

  if (args.audience === "anonymous") {
    return `${args.modelLabel} is available after signing in and upgrading. ${recommendedPhrase}`;
  }

  return `${args.modelLabel} isn't available on the ${getPlanLabel(args.audience)} plan. ${recommendedPhrase} Upgrade to switch models.`;
};

type BillingUsage = {
  rollingUsedUsd: number;
  rollingLimitUsd: number;
  weeklyUsedUsd: number;
  weeklyLimitUsd: number;
  monthlyUsedUsd: number;
  monthlyLimitUsd: number;
};

type ResolvableBillingStatus = {
  plan: SubscriptionPlan;
  usage: BillingUsage;
};

const isUsageExceeded = (usage: BillingUsage): boolean =>
  usage.rollingUsedUsd >= usage.rollingLimitUsd ||
  usage.weeklyUsedUsd >= usage.weeklyLimitUsd ||
  usage.monthlyUsedUsd >= usage.monthlyLimitUsd;

/**
 * Resolves the desktop-side audience the same way the backend's
 * `resolveManagedModelAudience` does:
 * - signed-out → "anonymous"
 * - free plan → "free"
 * - paid plan over usage cap → "{plan}_fallback"
 * - paid plan otherwise → plan id
 *
 * Returns `null` when we don't yet know (billing query still loading for a
 * signed-in user) so callers can avoid firing toasts during a hydration
 * gap.
 */
export const resolveBillingAudience = (args: {
  hasConnectedAccount: boolean;
  billingStatus: ResolvableBillingStatus | undefined;
}): ManagedModelAudience | null => {
  if (!args.hasConnectedAccount) {
    return "anonymous";
  }
  if (!args.billingStatus) {
    return null;
  }
  const { plan, usage } = args.billingStatus;
  if (plan === "free") {
    return "free";
  }
  return isUsageExceeded(usage)
    ? (`${plan}_fallback` as ManagedModelAudience)
    : plan;
};
