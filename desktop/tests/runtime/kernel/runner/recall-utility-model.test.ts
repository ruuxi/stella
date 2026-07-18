// Recall's utility model is selected solely from the active orchestrator
// engine. User model picks (including a saved Claude fable preference) must
// never override the engine's light tier.

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
    model("anthropic", "claude-haiku-4-5", "anthropic"),
    model("openrouter", "openai/gpt-5.5"),
    model("openai-codex", "gpt-5.6-luna", "openai-codex-responses"),
  ],
  getModels: (provider: string) => {
    switch (provider) {
      case "anthropic":
        return [
          model("anthropic", "claude-opus-4-8", "anthropic"),
          model("anthropic", "claude-haiku-4-5", "anthropic"),
        ];
      case "openrouter":
        return [model("openrouter", "openai/gpt-5.5")];
      case "openai-codex":
        return [
          model("openai-codex", "gpt-5.6-luna", "openai-codex-responses"),
        ];
      default:
        return [];
    }
  },
}));

const tempDirs = createSyncTempDirTracker();

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

describe("resolveRunnerRecallLlmRoute", () => {
  it("uses DeepSeek V4 Flash for the Stella engine", async () => {
    const { resolveRunnerRecallLlmRoute } = await loadModule();
    const context = makeContext({
      stellaDataDir: tempDirs.create("recall-pin-"),
      signedIn: true,
    });

    const route = await resolveRunnerRecallLlmRoute(context, "orchestrator");

    expect(route).toMatchObject({
      activeEngine: "default",
      executionEngine: "native",
      modelId: "stella/deepseek/deepseek-v4-flash",
      resolvedLlm: { route: "stella" },
    });
    expect(catalogMetadataCalls.count).toBe(1);
  });

  it("uses Haiku even when the data-dir preference says fable", async () => {
    const { resolveRunnerRecallLlmRoute } = await loadModule();
    const stellaDataDir = tempDirs.create("recall-claude-code-");
    writeFileSync(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({
        agentRuntimeEngine: "claude_code_local",
        claudeCodeModel: "fable",
      }),
    );
    const context = makeContext({ stellaDataDir, signedIn: true });

    const route = await resolveRunnerRecallLlmRoute(context, "orchestrator");

    expect(route).toEqual({
      activeEngine: "claude_code_local",
      executionEngine: "claude-code",
      modelId: "claude-code/haiku",
      claudeCodeModel: "haiku",
    });
    expect(catalogMetadataCalls.count).toBe(0);
  });

  it("uses the captured run engine when preferences change mid-turn", async () => {
    const { resolveRunnerRecallLlmRoute } = await loadModule();
    const stellaDataDir = tempDirs.create("recall-captured-engine-");
    writeFileSync(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({ agentRuntimeEngine: "default" }),
    );
    const context = makeContext({ stellaDataDir, signedIn: true });

    const route = await resolveRunnerRecallLlmRoute(context, "orchestrator", {
      engine: "claude_code_local",
      routeModel: "stella/saved-at-run-start",
      engineModel: "fable",
    });

    expect(route).toEqual({
      activeEngine: "claude_code_local",
      executionEngine: "claude-code",
      modelId: "claude-code/haiku",
      claudeCodeModel: "haiku",
    });
    expect(catalogMetadataCalls.count).toBe(0);
  });

  it("uses the direct Anthropic provider when a Stella credential is available", async () => {
    credentials.set("anthropic", "anthropic-test-key");
    const { resolveRunnerRecallLlmRoute } = await loadModule();
    const stellaDataDir = tempDirs.create("recall-claude-direct-");
    writeFileSync(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({ agentRuntimeEngine: "claude_code_local" }),
    );
    const context = makeContext({ stellaDataDir, signedIn: true });

    const route = await resolveRunnerRecallLlmRoute(context, "orchestrator");

    expect(route).toMatchObject({
      activeEngine: "claude_code_local",
      executionEngine: "native",
      modelId: "anthropic/claude-haiku-4-5",
      resolvedLlm: {
        route: "direct-provider",
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
      },
    });
  });

  it("uses Luna through the direct OpenAI provider for the Codex engine", async () => {
    oauthCredentials.add("openai-codex");
    const { resolveRunnerRecallLlmRoute } = await loadModule();
    const stellaDataDir = tempDirs.create("recall-codex-");
    writeFileSync(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({ agentRuntimeEngine: "codex_cli" }),
    );
    const context = makeContext({ stellaDataDir, signedIn: true });

    const route = await resolveRunnerRecallLlmRoute(context, "orchestrator");

    expect(route).toMatchObject({
      activeEngine: "codex_cli",
      executionEngine: "native",
      modelId: "openai-codex/gpt-5.6-luna",
      resolvedLlm: {
        route: "direct-provider",
        model: {
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          api: "openai-codex-responses",
        },
      },
    });
    expect(catalogMetadataCalls.count).toBe(0);
  });
});
