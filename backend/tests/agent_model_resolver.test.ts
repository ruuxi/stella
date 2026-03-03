import { describe, test, expect } from "bun:test";
import type { ResolvedModelConfig } from "../convex/agent/model_resolver";

describe("ResolvedModelConfig type", () => {
  test("type structure is valid", () => {
    const config: ResolvedModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-opus-4.6",
      fallback: "anthropic/claude-opus-4.5",
      temperature: 1.0,
      maxOutputTokens: 16192,
      apiKey: "test-key",
      providerOptions: {},
    };
    expect(config.provider).toBe("openrouter");
    expect(config.model).toContain("claude");
    expect(config.temperature).toBe(1.0);
  });

  test("optional fields can be omitted", () => {
    const config: ResolvedModelConfig = {
      provider: "openrouter",
      model: "test-model",
      apiKey: "key",
    };
    expect(config.fallback).toBeUndefined();
    expect(config.temperature).toBeUndefined();
    expect(config.maxOutputTokens).toBeUndefined();
  });
});
