/**
 * Plan catalog + Stripe-price wiring.
 *
 * Pricing and limits are loaded from Convex env at startup. Stella is
 * open source — no real values live in this file. Prices are public
 * (the marketing site shows them) but the included-usage utilization
 * rate is not, so it stays env-only.
 *
 * Required env:
 *   STELLA_INCLUDED_USAGE_UTILIZATION_RATE   — number in (0, 1]
 *   STELLA_<PLAN>_PRICE_CENTS                — paid plans only
 *
 * Optional per-plan overrides (derive from price + utilization when
 * unset; useful if a single plan needs limits that depart from the
 * shared formula):
 *   STELLA_<PLAN>_ROLLING_LIMIT_USD
 *   STELLA_<PLAN>_WEEKLY_LIMIT_USD
 *   STELLA_<PLAN>_MONTHLY_LIMIT_USD
 *   STELLA_<PLAN>_ROLLING_WINDOW_HOURS
 *
 * Free plan has no PRICE_CENTS (always 0). Its four limit/window envs
 * are required (no formula derives from a $0 price).
 *
 * `<PLAN>` ∈ { FREE, GO, PRO, PLUS, ULTRA }.
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

// Share of the derived monthly limit allotted to the smaller windows.
// These shape the rolling/weekly buckets relative to monthly; on their
// own they reveal nothing about real dollar amounts (those depend on
// the env-only utilization rate × env-only price).
const ROLLING_LIMIT_SHARE = 0.2;
const WEEKLY_LIMIT_SHARE = 0.5;
const DEFAULT_ROLLING_WINDOW_HOURS = 5;

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
  if (!Number.isInteger(value)) {
    throw new Error(
      `[billing] Invalid env ${envName}=${value}; expected a non-negative integer.`,
    );
  }
  return value;
};

const requireUtilizationRateEnv = (envName: string): number => {
  const value = requireNumberEnv(envName);
  if (value <= 0 || value > 1) {
    throw new Error(
      `[billing] Invalid env ${envName}=${value}; expected a number in (0, 1].`,
    );
  }
  return value;
};

const optionalNumberEnv = (envName: string): number | undefined => {
  const raw = process.env[envName]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `[billing] Invalid env ${envName}=${raw}; expected a non-negative number.`,
    );
  }
  return parsed;
};

const roundUsd = (value: number): number =>
  Math.max(0, Math.round(value * 100) / 100);

const toMonthlyPriceUsd = (monthlyPriceCents: number): number =>
  Math.max(0, monthlyPriceCents) / 100;

const buildFreePlanConfig = (): PlanConfig => ({
  label: PLAN_LABELS.free,
  monthlyPriceCents: 0,
  rollingLimitUsd: requireNumberEnv("STELLA_FREE_ROLLING_LIMIT_USD"),
  rollingWindowHours: requireNumberEnv("STELLA_FREE_ROLLING_WINDOW_HOURS"),
  weeklyLimitUsd: requireNumberEnv("STELLA_FREE_WEEKLY_LIMIT_USD"),
  monthlyLimitUsd: requireNumberEnv("STELLA_FREE_MONTHLY_LIMIT_USD"),
});

const buildPaidPlanConfig = (
  plan: Exclude<SubscriptionPlan, "free">,
  utilizationRate: number,
): PlanConfig => {
  const envPrefix = `STELLA_${plan.toUpperCase()}`;
  const monthlyPriceCents = requirePositiveIntEnv(`${envPrefix}_PRICE_CENTS`);
  const derivedMonthlyLimitUsd = roundUsd(
    toMonthlyPriceUsd(monthlyPriceCents) / utilizationRate,
  );
  const monthlyLimitUsd =
    optionalNumberEnv(`${envPrefix}_MONTHLY_LIMIT_USD`) ?? derivedMonthlyLimitUsd;
  return {
    label: PLAN_LABELS[plan],
    monthlyPriceCents,
    rollingLimitUsd:
      optionalNumberEnv(`${envPrefix}_ROLLING_LIMIT_USD`) ??
      roundUsd(derivedMonthlyLimitUsd * ROLLING_LIMIT_SHARE),
    rollingWindowHours:
      optionalNumberEnv(`${envPrefix}_ROLLING_WINDOW_HOURS`) ??
      DEFAULT_ROLLING_WINDOW_HOURS,
    weeklyLimitUsd:
      optionalNumberEnv(`${envPrefix}_WEEKLY_LIMIT_USD`) ??
      roundUsd(derivedMonthlyLimitUsd * WEEKLY_LIMIT_SHARE),
    monthlyLimitUsd,
  };
};

let cachedCatalog: PlanCatalog | null = null;

const loadPlanCatalog = (): PlanCatalog => {
  if (cachedCatalog) return cachedCatalog;
  const utilizationRate = requireUtilizationRateEnv(
    "STELLA_INCLUDED_USAGE_UTILIZATION_RATE",
  );
  cachedCatalog = {
    free: buildFreePlanConfig(),
    go: buildPaidPlanConfig("go", utilizationRate),
    pro: buildPaidPlanConfig("pro", utilizationRate),
    plus: buildPaidPlanConfig("plus", utilizationRate),
    ultra: buildPaidPlanConfig("ultra", utilizationRate),
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
