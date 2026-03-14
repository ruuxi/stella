export const SUBSCRIPTION_PLANS = ["free", "go", "pro", "plus"] as const;

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export type PlanConfig = {
  label: string;
  monthlyPriceCents: number;
  rollingLimitUsd: number;
  rollingWindowHours: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  tokensPerMinute: number;
};

export type PlanCatalog = Record<SubscriptionPlan, PlanConfig>;

const OPENCODE_GO_FALLBACK_LIMITS = {
  rollingLimitUsd: 12,
  rollingWindowHours: 5,
  weeklyLimitUsd: 30,
  monthlyLimitUsd: 60,
  tokensPerMinute: 500_000,
} as const;

const OPENCODE_BLACK_USAGE_MULTIPLIERS = {
  pro: 5,
  plus: 20,
} as const;

const scalePlanValue = (value: number, multiplier: number) =>
  Math.max(0, Math.floor(value * multiplier));

const buildBlackTierFallback = (
  label: string,
  monthlyPriceCents: number,
  multiplier: number,
): PlanConfig => ({
  label,
  monthlyPriceCents,
  // OpenCode Black absolute limits are secret-backed. Use documented Go limits as
  // the fallback baseline, then scale by published Black multipliers.
  rollingLimitUsd: scalePlanValue(OPENCODE_GO_FALLBACK_LIMITS.rollingLimitUsd, multiplier),
  rollingWindowHours: OPENCODE_GO_FALLBACK_LIMITS.rollingWindowHours,
  weeklyLimitUsd: scalePlanValue(OPENCODE_GO_FALLBACK_LIMITS.weeklyLimitUsd, multiplier),
  monthlyLimitUsd: scalePlanValue(OPENCODE_GO_FALLBACK_LIMITS.monthlyLimitUsd, multiplier),
  tokensPerMinute: scalePlanValue(OPENCODE_GO_FALLBACK_LIMITS.tokensPerMinute, multiplier),
});

const DEFAULT_PLAN_CATALOG: PlanCatalog = {
  free: {
    label: "Free",
    monthlyPriceCents: 0,
    rollingLimitUsd: 3,
    rollingWindowHours: 5,
    weeklyLimitUsd: 8,
    monthlyLimitUsd: 15,
    tokensPerMinute: 150_000,
  },
  go: {
    label: "Go",
    // OpenCode Go reference pricing + limits from docs.
    monthlyPriceCents: 1_000,
    rollingLimitUsd: OPENCODE_GO_FALLBACK_LIMITS.rollingLimitUsd,
    rollingWindowHours: OPENCODE_GO_FALLBACK_LIMITS.rollingWindowHours,
    weeklyLimitUsd: OPENCODE_GO_FALLBACK_LIMITS.weeklyLimitUsd,
    monthlyLimitUsd: OPENCODE_GO_FALLBACK_LIMITS.monthlyLimitUsd,
    tokensPerMinute: OPENCODE_GO_FALLBACK_LIMITS.tokensPerMinute,
  },
  pro: buildBlackTierFallback("Pro", 10_000, OPENCODE_BLACK_USAGE_MULTIPLIERS.pro),
  plus: buildBlackTierFallback("Plus", 20_000, OPENCODE_BLACK_USAGE_MULTIPLIERS.plus),
};

const parsePositiveNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
};

const parseLabel = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const mergePlanOverride = (
  fallback: PlanConfig,
  override: unknown,
): PlanConfig => {
  if (!override || typeof override !== "object") {
    return fallback;
  }
  const record = override as Record<string, unknown>;
  return {
    label: parseLabel(record.label, fallback.label),
    monthlyPriceCents: parsePositiveNumber(record.monthlyPriceCents, fallback.monthlyPriceCents),
    rollingLimitUsd: parsePositiveNumber(record.rollingLimitUsd, fallback.rollingLimitUsd),
    rollingWindowHours: parsePositiveNumber(record.rollingWindowHours, fallback.rollingWindowHours),
    weeklyLimitUsd: parsePositiveNumber(record.weeklyLimitUsd, fallback.weeklyLimitUsd),
    monthlyLimitUsd: parsePositiveNumber(record.monthlyLimitUsd, fallback.monthlyLimitUsd),
    tokensPerMinute: parsePositiveNumber(record.tokensPerMinute, fallback.tokensPerMinute),
  };
};

const loadPlanCatalog = (): PlanCatalog => {
  const raw = process.env.STELLA_PLAN_CONFIG_JSON?.trim();
  if (!raw) {
    return DEFAULT_PLAN_CATALOG;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      free: mergePlanOverride(DEFAULT_PLAN_CATALOG.free, parsed.free),
      go: mergePlanOverride(DEFAULT_PLAN_CATALOG.go, parsed.go),
      pro: mergePlanOverride(DEFAULT_PLAN_CATALOG.pro, parsed.pro),
      plus: mergePlanOverride(DEFAULT_PLAN_CATALOG.plus, parsed.plus),
    };
  } catch (error) {
    console.warn("[billing] Invalid STELLA_PLAN_CONFIG_JSON. Falling back to defaults.", error);
    return DEFAULT_PLAN_CATALOG;
  }
};

const PLAN_CATALOG = loadPlanCatalog();

const STRIPE_PRICE_ID_ENV: Record<Exclude<SubscriptionPlan, "free">, string> = {
  go: "STRIPE_PRICE_GO",
  pro: "STRIPE_PRICE_PRO",
  plus: "STRIPE_PRICE_PLUS",
};

export const getPlanCatalog = () => PLAN_CATALOG;

export const getPlanConfig = (plan: SubscriptionPlan) => PLAN_CATALOG[plan];

export const getStripePriceIdForPlan = (plan: Exclude<SubscriptionPlan, "free">) => {
  const key = STRIPE_PRICE_ID_ENV[plan];
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key} environment variable for ${plan} checkout.`);
  }
  return value;
};

export const findPlanForStripePriceId = (
  stripePriceId: string | null | undefined,
): Exclude<SubscriptionPlan, "free"> | null => {
  const normalized = stripePriceId?.trim();
  if (!normalized) {
    return null;
  }

  for (const plan of ["go", "pro", "plus"] as const) {
    const configured = process.env[STRIPE_PRICE_ID_ENV[plan]]?.trim();
    if (configured && configured === normalized) {
      return plan;
    }
  }

  return null;
};
