import { describe, expect, test } from "bun:test";
import {
  buildPaidPlanConfig,
  getPlanConfig,
  getIncludedUsageUtilizationRate,
} from "../convex/lib/billing_plans";

describe("billing plan utilization tuning", () => {
  test("derives paid plan limits from a single utilization rate", () => {
    const config = buildPaidPlanConfig("Go", 1_000, 0.7);

    expect(config.monthlyPriceCents).toBe(1_000);
    expect(config.monthlyLimitUsd).toBe(14.29);
    expect(config.weeklyLimitUsd).toBe(7.15);
    expect(config.rollingLimitUsd).toBe(2.86);
    expect(config.tokensPerMinute).toBeGreaterThan(100_000);
  });

  test("default catalog uses the utilization-derived paid limits", () => {
    expect(getIncludedUsageUtilizationRate()).toBe(0.7);
    expect(getPlanConfig("go").monthlyLimitUsd).toBe(28.57);
    expect(getPlanConfig("pro").monthlyLimitUsd).toBe(85.71);
    expect(getPlanConfig("plus").monthlyLimitUsd).toBe(142.86);
  });
});
