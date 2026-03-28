import { describe, expect, test } from "bun:test";
import {
  getManagedGatewayConfig,
  getModeConfig,
} from "../convex/agent/model";
import { buildManagedModel } from "../convex/runtime_ai/managed";

describe("managed gateway config", () => {
  test("defines OpenRouter and Fireworks gateways", () => {
    expect(getManagedGatewayConfig("openrouter")).toEqual({
      provider: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnvVar: "OPENROUTER_API_KEY",
    });
    expect(getManagedGatewayConfig("fireworks")).toEqual({
      provider: "fireworks",
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKeyEnvVar: "FIREWORKS_API_KEY",
    });
  });

  test("routes Fireworks modes through the Fireworks base URL", () => {
    const mode = getModeConfig("cheap");
    const model = buildManagedModel(mode, "openai-completions");
    expect(model.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
    expect(model.provider).toBe("fireworks");
  });

  test("routes OpenRouter modes through the OpenRouter base URL", () => {
    const mode = getModeConfig("smart");
    const model = buildManagedModel(mode, "openai-completions");
    expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(model.provider).toBe("openrouter");
  });
});
