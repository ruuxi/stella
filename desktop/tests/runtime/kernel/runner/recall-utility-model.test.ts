// Recall model pin: the Recall tool's backing route must be pinned to the
// cheap `stella/light` utility model instead of riding the orchestrator's
// (typically expensive) configured model, while preserving the one-shot
// completion candidate order for users who can't resolve a `stella/*` route:
// explicit pin first, then the orchestrator's own pick (BYOK), and the exact
// pre-pin failure modes when nothing is usable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Model } from "../../../../../runtime/ai/types.js";
import type { RunnerContext } from "../../../../../runtime/kernel/runner/types.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const credentials = new Map<string, string>();
const oauthCredentials = new Set<string>();

vi.mock("../../../../../runtime/kernel/storage/llm-credentials.js", () => ({
  getLocalLlmCredential: (_stellaAppDir: string, provider: string) =>
    credentials.get(provider) ?? null,
}));

vi.mock(
  "../../../../../runtime/kernel/storage/llm-oauth-credentials.js",
  () => ({
    hasLocalLlmOAuthCredential: (_stellaAppDir: string, provider: string) =>
      oauthCredentials.has(provider),
    getLocalLlmOAuthApiKey: async (_stellaAppDir: string, provider: string) =>
      oauthCredentials.has(provider) ? `${provider}-oauth-token` : null,
  }),
);

// Catalog metadata resolution is a network round-trip against the Stella
// site; identity pass-through keeps the tests offline without changing the
// candidate-selection behavior under test. The call counter lets tests
// assert which engine paths touch the catalog at all.
const catalogMetadataCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../../../runtime/kernel/stella-model-catalog.js", () => ({
  withStellaModelCatalogMetadata: async (args: { route: unknown }) => {
    catalogMetadataCalls.count += 1;
    return args.route;
  },
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

vi.mock("../../../../../runtime/ai/models.js", () => ({
  getAllModels: () => [
    model("anthropic", "claude-opus-4-8", "anthropic"),
    model("openrouter", "openai/gpt-5.5"),
  ],
  getModels: (provider: string) => {
    switch (provider) {
      case "anthropic":
        return [model("anthropic", "claude-opus-4-8", "anthropic")];
      case "openrouter":
        return [model("openrouter", "openai/gpt-5.5")];
      default:
        return [];
    }
  },
}));

const tempDirs = createSyncTempDirTracker();

const EXPENSIVE_ORCHESTRATOR_MODEL = "anthropic/claude-opus-4-8";

const makeContext = (args: {
  stellaDataDir: string;
  signedIn: boolean;
}): RunnerContext =>
  ({
    deviceId: "test-device",
    stellaAppDir: "/nonexistent/app-dir",
    stellaDataDir: args.stellaDataDir,
    state: {
      convexSiteUrl: args.signedIn ? "https://stella.example.test" : null,
      authToken: args.signedIn ? "stella-token" : null,
      hasConnectedAccount: args.signedIn,
      modelCatalogUpdatedAt: null,
    },
  }) as unknown as RunnerContext;

beforeEach(() => {
  credentials.clear();
  oauthCredentials.clear();
  catalogMetadataCalls.count = 0;
  vi.resetModules();
});

afterEach(() => {
  tempDirs.cleanup();
});

const loadModule = async () =>
  await import("../../../../../runtime/kernel/runner/model-selection.js");

describe("resolveRunnerUtilityLlmRoute (Recall pin)", () => {
  it("pins signed-in users to stella/light regardless of the orchestrator model", async () => {
    const { resolveRunnerUtilityLlmRoute, RUNNER_UTILITY_PINNED_MODEL } =
      await loadModule();
    const context = makeContext({
      stellaDataDir: tempDirs.create("recall-pin-"),
      signedIn: true,
    });

    const route = await resolveRunnerUtilityLlmRoute(
      context,
      "orchestrator",
      EXPENSIVE_ORCHESTRATOR_MODEL,
    );

    expect(route.route).toBe("stella");
    expect(route.model.id).toBe(RUNNER_UTILITY_PINNED_MODEL);
  });

  it("falls back to the orchestrator's BYOK pick when no stella route resolves", async () => {
    credentials.set("anthropic", "sk-anthropic-test");
    const { resolveRunnerUtilityLlmRoute } = await loadModule();
    const context = makeContext({
      stellaDataDir: tempDirs.create("recall-byok-"),
      signedIn: false,
    });

    const route = await resolveRunnerUtilityLlmRoute(
      context,
      "orchestrator",
      EXPENSIVE_ORCHESTRATOR_MODEL,
    );

    expect(route.route).toBe("direct-provider");
    expect(route.model.id).toBe("claude-opus-4-8");
    expect(await route.getApiKey()).toBe("sk-anthropic-test");
  });

  it("prefers the stella/light pin over an available BYOK key when signed in", async () => {
    credentials.set("anthropic", "sk-anthropic-test");
    const { resolveRunnerUtilityLlmRoute, RUNNER_UTILITY_PINNED_MODEL } =
      await loadModule();
    const context = makeContext({
      stellaDataDir: tempDirs.create("recall-prefer-pin-"),
      signedIn: true,
    });

    const route = await resolveRunnerUtilityLlmRoute(
      context,
      "orchestrator",
      EXPENSIVE_ORCHESTRATOR_MODEL,
    );

    expect(route.route).toBe("stella");
    expect(route.model.id).toBe(RUNNER_UTILITY_PINNED_MODEL);
  });

  it("keeps the pinned route usable without a key on the Claude Code engine", async () => {
    const { resolveRunnerUtilityLlmRoute, RUNNER_UTILITY_PINNED_MODEL } =
      await loadModule();
    const stellaDataDir = tempDirs.create("recall-claude-code-");
    writeFileSync(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({ agentRuntimeEngine: "claude_code_local" }),
    );
    const context = makeContext({ stellaDataDir, signedIn: true });

    const route = await resolveRunnerUtilityLlmRoute(
      context,
      "orchestrator",
      EXPENSIVE_ORCHESTRATOR_MODEL,
    );

    // The engine maps `stella/light` to its own light model downstream
    // (`getClaudeCodeAgentModelId`); the route itself stays on the pin so
    // `runRecall` sees the raw alias.
    expect(route.model.id).toBe(RUNNER_UTILITY_PINNED_MODEL);
    // And the engine path must never touch the catalog: metadata resolution
    // is a network round-trip whose result the CC engine discards. A stalled
    // catalog fetch here once hung Recall (and its orchestrator turn) even
    // though the engine never talks to the stella provider.
    expect(catalogMetadataCalls.count).toBe(0);
  });

  it("preserves the pre-pin failure mode when no candidate is usable", async () => {
    const { resolveRunnerUtilityLlmRoute } = await loadModule();
    const context = makeContext({
      stellaDataDir: tempDirs.create("recall-unusable-"),
      signedIn: false,
    });

    // Signed out, no local anthropic credential: the pin can't resolve and the
    // fallback resolves credential-less, so the resolver rethrows exactly what
    // the fallback model would have produced before the pin existed.
    await expect(
      resolveRunnerUtilityLlmRoute(
        context,
        "orchestrator",
        EXPENSIVE_ORCHESTRATOR_MODEL,
      ),
    ).rejects.toThrow(/anthropic/i);
  });
});
