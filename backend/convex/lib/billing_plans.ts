/**
 * Plan catalog + Stripe-price wiring.
 *
 * Every limit is overrideable from a Convex env var so we can tune
 * pricing without redeploying. Defaults match current production values
 * — set the matching `STELLA_*` env to override.
 *
 * Env vars (all optional, all positive numbers; invalid values fall back
 * to the listed default):
 *
 * Free plan:
 *   STELLA_FREE_ROLLING_LIMIT_USD       (default 0.75)
 *   STELLA_FREE_WEEKLY_LIMIT_USD        (default 0.75)
 *   STELLA_FREE_MONTHLY_LIMIT_USD       (default 0.75)
 *   STELLA_FREE_ROLLING_WINDOW_HOURS    (default 5)
 *
 * Paid plans (replace `<PLAN>` with `GO`, `PRO`, `PLUS`, `ULTRA`):
 *   STELLA_<PLAN>_PRICE_CENTS           (default Go 2000 / Pro 6000 / Plus 10000 / Ultra 20000)
 *   STELLA_<PLAN>_ROLLING_LIMIT_USD     (default derived from price + utilization rate)
 *   STELLA_<PLAN>_WEEKLY_LIMIT_USD      (default derived)
 *   STELLA_<PLAN>_MONTHLY_LIMIT_USD     (default derived)
 *   STELLA_<PLAN>_ROLLING_WINDOW_HOURS  (default 5)
 *
 * Cross-plan:
 *   STELLA_INCLUDED_USAGE_UTILIZATION_RATE  (default 0.7; bounded (0, 1])
 */
export const SUBSCRIPTION_PLANS = ["free", "go", "pro", "plus", "ultra"] as const;

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export type PlanConfig = {
  label: string;
  monthlyPriceCents: number;
  rollingLimitUsd: number;
  rollingWindowHours: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
};

export type PlanCatalog = Record<SubscriptionPlan, PlanConfig>;

const DEFAULT_INCLUDED_USAGE_UTILIZATION_RATE = 0.7;
const DEFAULT_ROLLING_WINDOW_HOURS = 5;
const DEFAULT_ROLLING_LIMIT_SHARE = 0.2;
const DEFAULT_WEEKLY_LIMIT_SHARE = 0.5;

const DEFAULT_FREE_ROLLING_LIMIT_USD = 0.75;
const DEFAULT_FREE_WEEKLY_LIMIT_USD = 0.75;
const DEFAULT_FREE_MONTHLY_LIMIT_USD = 0.75;

const DEFAULT_PAID_PRICE_CENTS: Record<Exclude<SubscriptionPlan, "free">, number> = {
  go: 2_000,
  pro: 6_000,
  plus: 10_000,
  ultra: 20_000,
};

const PAID_PLAN_LABELS: Record<Exclude<SubscriptionPlan, "free">, string> = {
  go: "Go",
  pro: "Pro",
  plus: "Plus",
  ultra: "Ultra",
};

const roundUsd = (value: number): number =>
  Math.max(0, Math.round(value * 100) / 100);

const toMonthlyPriceUsd = (monthlyPriceCents: number): number =>
  Math.max(0, monthlyPriceCents) / 100;

const parsePositiveNumberEnv = (
  envName: string,
  fallback: number,
): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[billing] Invalid ${envName}=${raw}; falling back to default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
};

const parseUtilizationRateEnv = (
  envName: string,
  fallback: number,
): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    console.warn(
      `[billing] Invalid ${envName}=${raw} (must be in (0, 1]); falling back to default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
};

export const getIncludedUsageUtilizationRate = (): number =>
  parseUtilizationRateEnv(
    "STELLA_INCLUDED_USAGE_UTILIZATION_RATE",
    DEFAULT_INCLUDED_USAGE_UTILIZATION_RATE,
  );

const buildFreePlanConfig = (): PlanConfig => ({
  label: "Free",
  monthlyPriceCents: 0,
  rollingLimitUsd: parsePositiveNumberEnv(
    "STELLA_FREE_ROLLING_LIMIT_USD",
    DEFAULT_FREE_ROLLING_LIMIT_USD,
  ),
  rollingWindowHours: parsePositiveNumberEnv(
    "STELLA_FREE_ROLLING_WINDOW_HOURS",
    DEFAULT_ROLLING_WINDOW_HOURS,
  ),
  weeklyLimitUsd: parsePositiveNumberEnv(
    "STELLA_FREE_WEEKLY_LIMIT_USD",
    DEFAULT_FREE_WEEKLY_LIMIT_USD,
  ),
  monthlyLimitUsd: parsePositiveNumberEnv(
    "STELLA_FREE_MONTHLY_LIMIT_USD",
    DEFAULT_FREE_MONTHLY_LIMIT_USD,
  ),
});

export const buildPaidPlanConfig = (
  plan: Exclude<SubscriptionPlan, "free">,
  utilizationRate: number,
): PlanConfig => {
  const envPrefix = `STELLA_${plan.toUpperCase()}`;
  const monthlyPriceCents = parsePositiveNumberEnv(
    `${envPrefix}_PRICE_CENTS`,
    DEFAULT_PAID_PRICE_CENTS[plan],
  );
  const derivedMonthlyLimitUsd = roundUsd(
    toMonthlyPriceUsd(monthlyPriceCents) / utilizationRate,
  );
  const monthlyLimitUsd = parsePositiveNumberEnv(
    `${envPrefix}_MONTHLY_LIMIT_USD`,
    derivedMonthlyLimitUsd,
  );
  return {
    label: PAID_PLAN_LABELS[plan],
    monthlyPriceCents,
    rollingLimitUsd: parsePositiveNumberEnv(
      `${envPrefix}_ROLLING_LIMIT_USD`,
      roundUsd(derivedMonthlyLimitUsd * DEFAULT_ROLLING_LIMIT_SHARE),
    ),
    rollingWindowHours: parsePositiveNumberEnv(
      `${envPrefix}_ROLLING_WINDOW_HOURS`,
      DEFAULT_ROLLING_WINDOW_HOURS,
    ),
    weeklyLimitUsd: parsePositiveNumberEnv(
      `${envPrefix}_WEEKLY_LIMIT_USD`,
      roundUsd(derivedMonthlyLimitUsd * DEFAULT_WEEKLY_LIMIT_SHARE),
    ),
    monthlyLimitUsd,
  };
};

const loadPlanCatalog = (): PlanCatalog => {
  const utilizationRate = getIncludedUsageUtilizationRate();
  return {
    free: buildFreePlanConfig(),
    go: buildPaidPlanConfig("go", utilizationRate),
    pro: buildPaidPlanConfig("pro", utilizationRate),
    plus: buildPaidPlanConfig("plus", utilizationRate),
    ultra: buildPaidPlanConfig("ultra", utilizationRate),
  };
};

const PLAN_CATALOG = loadPlanCatalog();

const STRIPE_PRICE_ID_ENV: Record<Exclude<SubscriptionPlan, "free">, string> = {
  go: "STRIPE_PRICE_GO",
  pro: "STRIPE_PRICE_PRO",
  plus: "STRIPE_PRICE_PLUS",
  ultra: "STRIPE_PRICE_ULTRA",
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

  for (const plan of ["go", "pro", "plus", "ultra"] as const) {
    const configured = process.env[STRIPE_PRICE_ID_ENV[plan]]?.trim();
    if (configured && configured === normalized) {
      return plan;
    }
  }

  return null;
};
