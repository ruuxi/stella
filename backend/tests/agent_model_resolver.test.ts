import { describe, test, expect } from "bun:test";
import type { ResolvedModelConfig } from "../convex/agent/model_resolver";

describe("ResolvedModelConfig type", () => {
  test("uses a managed model string plus standard generation options", () => {
    const config: ResolvedModelConfig = {
      model: "anthropic/claude-opus-4.6",
      temperature: 1.0,
      maxOutputTokens: 16192,
      providerOptions: {},
    };
    expect(config.model).toContain("claude");
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
