import { describe, expect, it } from "vitest";
import { getModelProviders, getModels } from "../../../../runtime/ai/models.js";
import { STELLA_RELAY_PROVIDERS } from "../../../../runtime/contracts/stella-api.js";
import { resolveLlmRoute } from "../../../../runtime/kernel/model-routing.js";
import { parseSpawnAgentModel } from "../../../../runtime/kernel/tools/state.js";

const site = {
  baseUrl: "https://stella.example.test",
  getAuthToken: () => "stella-token",
};

const resolve = (modelName: string, reasoningEffort?: string) =>
  resolveLlmRoute({
    stellaAppDir: "/tmp/stella",
    modelName,
    agentType: "general",
    site,
    reasoningEffort,
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
    expect(() => resolve(parsed.model, parsed.reasoningEffort)).toThrow(
      /use "codex\/gpt-5\.6-sol:high" instead/i,
    );
  });

  it("routes gpt-5 through its eligible OpenAI match despite registry shadows", () => {
    const route = resolve("stella/gpt-5");
    expect(route.route).toBe("stella");
    expect(route.model.provider).toBe("openai");
    expect(
      (route.model as typeof route.model & { upstreamModelId?: string })
        .upstreamModelId,
    ).toBe("gpt-5");
  });

  it("routes every slashless managed match shadowed by ineligible namespaces", () => {
    const managedProviders = new Set<string>(STELLA_RELAY_PROVIDERS);
    const providersById = new Map<string, string[]>();
    for (const provider of getModelProviders()) {
      for (const model of getModels(provider) ?? []) {
        if (model.id.includes("/")) continue;
        const providers = providersById.get(model.id) ?? [];
        providers.push(provider);
        providersById.set(model.id, providers);
      }
    }
    const shadowedManagedIds = Array.from(providersById)
      .filter(
        ([, providers]) =>
          providers.some((provider) => managedProviders.has(provider)) &&
          providers.some((provider) => !managedProviders.has(provider)),
      )
      .map(([id]) => id);

    expect(shadowedManagedIds).toHaveLength(62);
    for (const id of shadowedManagedIds) {
      expect(() => resolve(`stella/${id}`), id).not.toThrow();
    }
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
