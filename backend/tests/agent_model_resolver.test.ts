import { describe, test, expect } from "bun:test";
import {
  resolveFallbackConfig,
  resolveModelConfig,
  type ResolvedModelConfig,
} from "../convex/agent/model_resolver";

describe("ResolvedModelConfig type", () => {
  test("uses a managed model string plus standard generation options", () => {
    const config: ResolvedModelConfig = {
      model: "anthropic/claude-opus-4.6",
      managedGatewayProvider: "openrouter",
      temperature: 1.0,
      maxOutputTokens: 16192,
      providerOptions: {},
    };
    expect(config.model).toContain("claude");
    expect(config.managedGatewayProvider).toBe("openrouter");
    expect(config.temperature).toBe(1.0);
    expect(config.maxOutputTokens).toBe(16192);
  });

  test("optional fields can be omitted", () => {
    const config: ResolvedModelConfig = {
      model: "test-model",
    };
    expect(config.temperature).toBeUndefined();
    expect(config.maxOutputTokens).toBeUndefined();
    expect(config.providerOptions).toBeUndefined();
  });
});

describe("resolveModelConfig", () => {
  const ctx = {
    runQuery: async () => null,
  };

  test("returns default managed gateway metadata for standard modes", async () => {
    const config = await resolveModelConfig(ctx, "general");
    expect(config.managedGatewayProvider).toBe("openrouter");
  });

  test("forces Fireworks routing for explicit Fireworks router ids", async () => {
    const overrideCtx = {
      runQuery: async () => "stella/accounts/fireworks/routers/kimi-k2p5-turbo",
    };

    const config = await resolveModelConfig(overrideCtx, "general", "owner-1");
    expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p5-turbo");
    expect(config.managedGatewayProvider).toBe("fireworks");
  });

  test("uses fallback gateway metadata from the fallback mode", async () => {
    const config = await resolveFallbackConfig(ctx, "synthesis");
    expect(config).toEqual(
      expect.objectContaining({
        model: "accounts/fireworks/models/kimi-k2p5",
        managedGatewayProvider: "fireworks",
        providerOptions: {
          gateway: {
            order: ["fireworks"],
          },
        },
      }),
    );
  });
});
