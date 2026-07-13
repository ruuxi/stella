import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../../../../runtime/kernel/model-routing.js";
import { parseSpawnAgentModel } from "../../../../runtime/kernel/tools/state.js";

const site = {
  baseUrl: "https://stella.example.test",
  getAuthToken: () => "stella-token",
};

const resolve = (modelName: string) =>
  resolveLlmRoute({
    stellaAppDir: "/tmp/stella",
    modelName,
    agentType: "general",
    site,
  });

describe("bare Stella model routing", () => {
  it("fails closed for the Codex-only Sol model instead of substituting GPT-5.5", () => {
    expect(() => resolve("stella/gpt-5.6-sol")).toThrow(
      /not available from stella/i,
    );

    const parsed = parseSpawnAgentModel(
      "stella/gpt-5.6-sol:high",
      (candidate) => {
        try {
          resolve(candidate);
          return true;
        } catch {
          return false;
        }
      },
    );
    expect(parsed).toEqual({
      kind: "model",
      model: "stella/gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(() => resolve(parsed.model)).toThrow(/not available from stella/i);
  });

  it("resolves a unique managed-provider registry id to its real upstream", () => {
    const route = resolve("stella/claude-fable-5");
    expect(route.route).toBe("stella");
    expect(route.model.provider).toBe("anthropic");
    expect(
      (route.model as typeof route.model & { upstreamModelId?: string })
        .upstreamModelId,
    ).toBe("claude-fable-5");
  });

  it("preserves an opaque bare id exactly for catalog enrichment", () => {
    const route = resolve("stella/future-model-not-in-registry");
    expect(
      (route.model as typeof route.model & { upstreamModelId?: string })
        .upstreamModelId,
    ).toBe("future-model-not-in-registry");
  });
});
