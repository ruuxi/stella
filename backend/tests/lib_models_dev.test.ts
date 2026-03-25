import { describe, expect, test } from "bun:test";
import { buildManagedModelPriceEntries } from "../convex/lib/models_dev";

describe("models.dev price mapping", () => {
  test("prefers vercel-backed aliases for managed gateway models", () => {
    const result = buildManagedModelPriceEntries({
      data: {
        vercel: {
          models: {
            "google/gemini-3-flash-preview": {
              cost: { input: 0.5, output: 3, cache_read: 0.05 },
              last_updated: "2026-03-16",
            },
          },
        },
      },
      modelIds: ["google/gemini-3-flash-preview"],
      syncedAt: 123,
    });

    expect(result.missingModels).toEqual([]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        model: "google/gemini-3-flash-preview",
        sourceProvider: "vercel",
        sourceModelId: "google/gemini-3-flash-preview",
        inputPerMillionUsd: 0.5,
        outputPerMillionUsd: 3,
        cacheReadPerMillionUsd: 0.05,
      }),
    ]);
  });

  test("reports missing models when no source entry can be found", () => {
    const result = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["moonshotai/kimi-k2.5"],
      syncedAt: 123,
    });

    expect(result.entries).toEqual([]);
    expect(result.missingModels).toEqual(["moonshotai/kimi-k2.5"]);
  });
});
