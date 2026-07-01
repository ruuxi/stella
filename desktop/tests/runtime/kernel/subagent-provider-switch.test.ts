// Regression coverage for the "subagents break when the provider/model is
// switched mid-session" bug.
//
// Root cause of the field failure was NOT here (it was reasoning-model
// provider-request handling — a resumed subagent adopted the newly-selected
// OpenRouter/OpenAI model fine and ran several turns before a reasoning-signature
// replay error). These tests lock in the invariant that DOES belong to the
// selection/propagation path: a subagent agent-type resolves the *same* active
// provider/model route as the orchestrator from the *same* live preference
// source, and a mid-session model switch is reflected for both. If a future
// change re-introduces a divergent subagent config path (a stale snapshot, a
// different resolver, or the wrong credential directory), this fails loudly.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../runtime/ai/types.js";
import { createSyncTempDirTracker } from "../../helpers/temp.js";

const credentials = new Map<string, string>();
const oauthCredentials = new Set<string>();

vi.mock("../../../../runtime/kernel/storage/llm-credentials.js", () => ({
  getLocalLlmCredential: (_stellaAppDir: string, provider: string) =>
    credentials.get(provider) ?? null,
}));

vi.mock("../../../../runtime/kernel/storage/llm-oauth-credentials.js", () => ({
  hasLocalLlmOAuthCredential: (_stellaAppDir: string, provider: string) =>
    oauthCredentials.has(provider),
  getLocalLlmOAuthApiKey: async (_stellaAppDir: string, provider: string) =>
    oauthCredentials.has(provider) ? `${provider}-oauth-token` : null,
}));

const model = (
  provider: string,
  id: string,
  api = "openai-completions",
): Model<any> => ({
  id,
  name: id,
  api: api as never,
  provider: provider as never,
  baseUrl: `https://${provider}.example.test`,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

vi.mock("../../../../runtime/ai/models.js", () => ({
  getAllModels: () => [
    model("anthropic", "claude-opus-4-8", "anthropic"),
    model("openrouter", "openai/gpt-5.5"),
  ],
  getModels: (provider: string) => {
    switch (provider) {
      case "anthropic":
        return [model("anthropic", "claude-opus-4-8", "anthropic")];
      case "openrouter":
        // OpenRouter is a synthesizable gateway; the first entry is the
        // template used to route arbitrary `<vendor>/<model>` ids.
        return [model("openrouter", "openai/gpt-5.5")];
      default:
        return [];
    }
  },
}));

const site = {
  baseUrl: "https://stella.example.test",
  getAuthToken: () => "stella-token",
};

const tempDirs = createSyncTempDirTracker();

// Mirrors how the runner obtains the active model per agent type:
//   orchestrator -> getConfiguredModel(...) = getModelOverride(dataDir, "orchestrator") ?? agent.model
//   subagent     -> resolveAgentModelRoute("general") = getModelOverride(dataDir, "general") ?? agent.model
// Both read the exact same preference map; there is no separate subagent store.
const ORCHESTRATOR = "orchestrator";
const SUBAGENT = "general";

beforeEach(() => {
  credentials.clear();
  oauthCredentials.clear();
  vi.resetModules();
});

const loadModules = async () => {
  const { resolveLlmRoute } = await import(
    "../../../../runtime/kernel/model-routing.js"
  );
  const { getModelOverride, updateLocalModelPreferences } = await import(
    "../../../../runtime/kernel/preferences/local-preferences.js"
  );
  return { resolveLlmRoute, getModelOverride, updateLocalModelPreferences };
};

describe("subagent provider/model selection parity", () => {
  it("orchestrator and subagent resolve the same route and follow a mid-session switch", async () => {
    const stellaDataDir = tempDirs.create("stella-subagent-switch-");
    credentials.set("anthropic", "anthropic-key");
    credentials.set("openrouter", "openrouter-key");

    const { resolveLlmRoute, getModelOverride, updateLocalModelPreferences } =
      await loadModules();

    const resolveFor = (agentType: string) =>
      resolveLlmRoute({
        stellaAppDir: stellaDataDir,
        modelName: getModelOverride(stellaDataDir, agentType),
        agentType,
        site,
      });

    // Starting state: the UI writes the same model to orchestrator + general
    // (the "Assistant" pair), so both read anthropic/claude-opus-4-8.
    updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: {
        [ORCHESTRATOR]: "anthropic/claude-opus-4-8",
        [SUBAGENT]: "anthropic/claude-opus-4-8",
      },
    });

    const orchBefore = resolveFor(ORCHESTRATOR);
    const subBefore = resolveFor(SUBAGENT);
    expect(subBefore.model.id).toBe(orchBefore.model.id);
    expect(subBefore.model.provider).toBe(orchBefore.model.provider);
    expect(subBefore.route).toBe(orchBefore.route);
    expect(orchBefore.model.provider).toBe("anthropic");
    expect(orchBefore.route).toBe("direct-provider");

    // Mid-session switch: Anthropic -> OpenRouter OpenAI model. This is the
    // exact transition that broke subagents in the field.
    updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: {
        [ORCHESTRATOR]: "openrouter/openai/gpt-5.5",
        [SUBAGENT]: "openrouter/openai/gpt-5.5",
      },
    });

    const orchAfter = resolveFor(ORCHESTRATOR);
    const subAfter = resolveFor(SUBAGENT);

    // The subagent must pick up the switch exactly like the orchestrator.
    expect(subAfter.model.id).toBe("openai/gpt-5.5");
    expect(subAfter.model.provider).toBe("openrouter");
    expect(subAfter.route).toBe("direct-provider");
    expect(subAfter.model.id).toBe(orchAfter.model.id);
    expect(subAfter.model.provider).toBe(orchAfter.model.provider);
    expect(subAfter.route).toBe(orchAfter.route);
    expect(subAfter.model.id).not.toBe(subBefore.model.id);
  });

  it("resolves BYOK credentials from the passed data dir (route carries a usable key)", async () => {
    // resolveLlmRoute's `stellaAppDir` arg is really the credential directory
    // (~/.stella data dir). The subagent route-resolution fallback in
    // agent-orchestration.ts must pass the data dir, not the install/code
    // tree, or a subagent would fail to find the key the orchestrator uses.
    const stellaDataDir = tempDirs.create("stella-subagent-cred-");
    credentials.set("openrouter", "openrouter-key");

    const { resolveLlmRoute, getModelOverride, updateLocalModelPreferences } =
      await loadModules();

    updateLocalModelPreferences(stellaDataDir, {
      modelOverrides: { [SUBAGENT]: "openrouter/openai/gpt-5.5" },
    });

    const route = resolveLlmRoute({
      stellaAppDir: stellaDataDir,
      modelName: getModelOverride(stellaDataDir, SUBAGENT),
      agentType: SUBAGENT,
      site,
    });

    expect(route.route).toBe("direct-provider");
    expect(await route.getApiKey()).toBe("openrouter-key");
  });
});
