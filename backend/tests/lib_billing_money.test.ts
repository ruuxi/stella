import { describe, expect, test } from "bun:test";
import {
  computeRealtimeUsageCostMicroCents,
  computeServiceCostMicroCents,
  computeUsageCostMicroCents,
  dollarsToMicroCents,
} from "../convex/lib/billing_money";

describe("billing money helpers", () => {
  test("service costs default to zero unless explicitly configured", () => {
    expect(computeServiceCostMicroCents("fal-ai/bytedance/seedream/v5/lite/text-to-image")).toBe(0);
    expect(computeServiceCostMicroCents("voice:session:test")).toBe(0);
  });

  test("token usage cost remains non-negative", () => {
    expect(
      computeUsageCostMicroCents({
        model: "unknown/model",
        inputTokens: 12_345,
        outputTokens: 6_789,
      }),
    ).toBeGreaterThanOrEqual(0);
  });

  test("usage cost accounts for cache and reasoning prices when provided", () => {
    expect(
      computeUsageCostMicroCents({
        model: "test/model",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cacheWriteInputTokens: 100_000,
        reasoningTokens: 300_000,
        price: {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 4,
          cacheReadPerMillionUsd: 0.5,
          cacheWritePerMillionUsd: 1,
          reasoningPerMillionUsd: 6,
        },
      }),
    ).toBe(
      dollarsToMicroCents(
        1.4 + 2.8 + 0.1 + 0.1 + 1.8,
      ),
    );
  });

  test("realtime usage cost uses modality-aware pricing", () => {
    expect(
      computeRealtimeUsageCostMicroCents({
        model: "gpt-realtime-1.5",
        textInputTokens: 1_000_000,
        textCachedInputTokens: 500_000,
        textOutputTokens: 250_000,
        audioInputTokens: 2_000_000,
        audioCachedInputTokens: 250_000,
        audioOutputTokens: 500_000,
        imageInputTokens: 100_000,
      }),
    ).toBe(
      dollarsToMicroCents(4 + 0.2 + 4 + 64 + 0.1 + 32 + 0.5),
    );
  });
});
