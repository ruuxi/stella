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

const DEFAULT_FREE_PLAN: PlanConfig = {
  label: "Free",
  monthlyPriceCents: 0,
  rollingLimitUsd: 0.75,
  rollingWindowHours: 5,
  weeklyLimitUsd: 0.75,
  monthlyLimitUsd: 0.75,
};

const DEFAULT_INCLUDED_USAGE_UTILIZATION_RATE = 0.7;
const DEFAULT_ROLLING_WINDOW_HOURS = 5;
const DEFAULT_ROLLING_LIMIT_SHARE = 0.2;
const DEFAULT_WEEKLY_LIMIT_SHARE = 0.5;

const roundUsd = (value: number): number =>
  Math.max(0, Math.round(value * 100) / 100);

const toMonthlyPriceUsd = (monthlyPriceCents: number): number =>
  Math.max(0, monthlyPriceCents) / 100;

const parseUtilizationRate = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return fallback;
  }
  return parsed;
};

export const getIncludedUsageUtilizationRate = (): number =>
  parseUtilizationRate(
    process.env.STELLA_INCLUDED_USAGE_UTILIZATION_RATE?.trim(),
    DEFAULT_INCLUDED_USAGE_UTILIZATION_RATE,
  );

export const buildPaidPlanConfig = (
  label: string,
  monthlyPriceCents: number,
  utilizationRate: number,
): PlanConfig => {
  const monthlyLimitUsd = roundUsd(toMonthlyPriceUsd(monthlyPriceCents) / utilizationRate);
  return {
    label,
    monthlyPriceCents,
    rollingLimitUsd: roundUsd(monthlyLimitUsd * DEFAULT_ROLLING_LIMIT_SHARE),
    rollingWindowHours: DEFAULT_ROLLING_WINDOW_HOURS,
    weeklyLimitUsd: roundUsd(monthlyLimitUsd * DEFAULT_WEEKLY_LIMIT_SHARE),
    monthlyLimitUsd,
  };
};

const buildDefaultPlanCatalog = (): PlanCatalog => {
  const utilizationRate = getIncludedUsageUtilizationRate();
  return {
    free: DEFAULT_FREE_PLAN,
    go: buildPaidPlanConfig("Go", 2_000, utilizationRate),
    pro: buildPaidPlanConfig("Pro", 6_000, utilizationRate),
    plus: buildPaidPlanConfig("Plus", 10_000, utilizationRate),
    ultra: buildPaidPlanConfig("Ultra", 20_000, utilizationRate),
  };
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
  };
};

const loadPlanCatalog = (): PlanCatalog => {
  const defaultPlanCatalog = buildDefaultPlanCatalog();
  const raw = process.env.STELLA_PLAN_CONFIG_JSON?.trim();
  if (!raw) {
    return defaultPlanCatalog;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      free: mergePlanOverride(defaultPlanCatalog.free, parsed.free),
      go: mergePlanOverride(defaultPlanCatalog.go, parsed.go),
      pro: mergePlanOverride(defaultPlanCatalog.pro, parsed.pro),
      plus: mergePlanOverride(defaultPlanCatalog.plus, parsed.plus),
      ultra: mergePlanOverride(defaultPlanCatalog.ultra, parsed.ultra),
    };
  } catch (error) {
    console.warn("[billing] Invalid STELLA_PLAN_CONFIG_JSON. Falling back to defaults.", error);
    return defaultPlanCatalog;
  }
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
