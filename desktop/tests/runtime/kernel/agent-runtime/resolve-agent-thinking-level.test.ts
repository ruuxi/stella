import { describe, expect, it } from "vitest";
import type { Model } from "../../../../../runtime/ai/types.js";
import type { ResolvedLlmRoute } from "../../../../../runtime/kernel/model-routing.js";
import { resolveAgentThinkingLevel } from "../../../../../runtime/kernel/agent-runtime/shared.js";

const fakeModel = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} as unknown as Model<"openai-completions">;

const directRoute = (): ResolvedLlmRoute =>
  ({
    route: "direct-provider",
    model: fakeModel,
    getApiKey: async () => "sk-test",
    refreshApiKey: async () => null,
  }) as unknown as ResolvedLlmRoute;

const stellaRoute = (): ResolvedLlmRoute =>
  ({
    route: "stella",
    model: fakeModel,
    getApiKey: async () => "stella-token",
    refreshApiKey: async () => null,
  }) as unknown as ResolvedLlmRoute;

describe("resolveAgentThinkingLevel", () => {
  it("uses the agentContext effort on direct-provider routes", () => {
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: directRoute(),
        agentContextReasoningEffort: "high",
      }),
    ).toBe("high");
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: directRoute(),
        agentContextReasoningEffort: "low",
      }),
    ).toBe("low");
  });

  it("falls back to medium on direct-provider when no effort is set", () => {
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: directRoute(),
      }),
    ).toBe("medium");
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: directRoute(),
        agentContextReasoningEffort: "default",
      }),
    ).toBe("medium");
  });

  it("falls back to medium on default Stella-routed runs", () => {
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: stellaRoute(),
        agentContextReasoningEffort: "default",
      }),
    ).toBe("medium");
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: stellaRoute(),
      }),
    ).toBe("medium");
  });

  it("uses explicit effort on Stella-routed runs", () => {
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: stellaRoute(),
        agentContextReasoningEffort: "high",
      }),
    ).toBe("high");
  });
});
