/**
 * Plan catalog + Stripe-price wiring.
 *
 * All limits and prices are loaded from Convex env vars at startup.
 * There are no defaults in this file — Stella is open source, and the
 * plan economics live in the deployment, not the repo.
 *
 * Required env vars (all must be set; missing or invalid throws on
 * first access):
 *
 *   STELLA_FREE_ROLLING_LIMIT_USD
 *   STELLA_FREE_WEEKLY_LIMIT_USD
 *   STELLA_FREE_MONTHLY_LIMIT_USD
 *   STELLA_FREE_ROLLING_WINDOW_HOURS
 *
 *   STELLA_<PLAN>_PRICE_CENTS
 *   STELLA_<PLAN>_ROLLING_LIMIT_USD
 *   STELLA_<PLAN>_WEEKLY_LIMIT_USD
 *   STELLA_<PLAN>_MONTHLY_LIMIT_USD
 *   STELLA_<PLAN>_ROLLING_WINDOW_HOURS
 *
 * with `<PLAN>` ∈ { GO, PRO, PLUS, ULTRA }.
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

const PLAN_LABELS: Record<SubscriptionPlan, string> = {
  free: "Free",
  go: "Go",
  pro: "Pro",
  plus: "Plus",
  ultra: "Ultra",
};

const requireNumberEnv = (envName: string): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    throw new Error(
      `[billing] Missing required env ${envName}. Set it in Convex env before starting.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `[billing] Invalid env ${envName}=${raw}; expected a non-negative number.`,
    );
  }
  return parsed;
};

const requirePositiveIntEnv = (envName: string): number => {
  const value = requireNumberEnv(envName);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `[billing] Invalid env ${envName}=${value}; expected a non-negative integer.`,
    );
  }
  return value;
};

const buildPlanConfig = (plan: SubscriptionPlan): PlanConfig => {
  const envPrefix = `STELLA_${plan.toUpperCase()}`;
  const monthlyPriceCents =
    plan === "free" ? 0 : requirePositiveIntEnv(`${envPrefix}_PRICE_CENTS`);
  return {
    label: PLAN_LABELS[plan],
    monthlyPriceCents,
    rollingLimitUsd: requireNumberEnv(`${envPrefix}_ROLLING_LIMIT_USD`),
    rollingWindowHours: requireNumberEnv(`${envPrefix}_ROLLING_WINDOW_HOURS`),
    weeklyLimitUsd: requireNumberEnv(`${envPrefix}_WEEKLY_LIMIT_USD`),
    monthlyLimitUsd: requireNumberEnv(`${envPrefix}_MONTHLY_LIMIT_USD`),
  };
};

let cachedCatalog: PlanCatalog | null = null;

const loadPlanCatalog = (): PlanCatalog => {
  if (cachedCatalog) return cachedCatalog;
  cachedCatalog = {
    free: buildPlanConfig("free"),
    go: buildPlanConfig("go"),
    pro: buildPlanConfig("pro"),
    plus: buildPlanConfig("plus"),
    ultra: buildPlanConfig("ultra"),
  };
  return cachedCatalog;
};

const STRIPE_PRICE_ID_ENV: Record<Exclude<SubscriptionPlan, "free">, string> = {
  go: "STRIPE_PRICE_GO",
  pro: "STRIPE_PRICE_PRO",
  plus: "STRIPE_PRICE_PLUS",
  ultra: "STRIPE_PRICE_ULTRA",
};

export const getPlanCatalog = (): PlanCatalog => loadPlanCatalog();

export const getPlanConfig = (plan: SubscriptionPlan): PlanConfig =>
  loadPlanCatalog()[plan];

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
