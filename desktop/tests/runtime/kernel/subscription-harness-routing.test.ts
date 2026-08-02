import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedLlmRoute } from "../../../../runtime/kernel/model-routing.js";
import { AGENT_IDS } from "../../../../runtime/contracts/agent-runtime.js";
import type { AgentModelConfigSnapshot } from "../../../../runtime/contracts/agent-engine.js";
import {
  getLocalModelPreferences,
  loadLocalPreferences,
  updateLocalModelPreferences,
} from "../../../../runtime/kernel/preferences/local-preferences.js";
import {
  captureEffectiveModelConfig,
  resolveSubscriptionHarnessRouteModel,
  sampleAgentEngineConfig,
} from "../../../../runtime/kernel/runner/agent-model-config.js";
import { buildAgentContext } from "../../../../runtime/kernel/runner/context.js";
import type { RunnerContext } from "../../../../runtime/kernel/runner/types.js";
import {
  createStateContext,
  handleSpawnAgent,
  type StateContext,
} from "../../../../runtime/kernel/tools/state.js";
import type { AgentToolRequest } from "../../../../runtime/kernel/tools/types.js";

const tempDirs: string[] = [];

const makeDataDir = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-subscription-harness-routing-"),
  );
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const stellaRoute = (): ResolvedLlmRoute =>
  ({
    model: {
      id: "openai/gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      provider: "stella",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    route: "stella",
    getApiKey: () => "test-key",
  }) as ResolvedLlmRoute;

const codexRoute = (modelId: string): ResolvedLlmRoute =>
  ({
    model: {
      id: modelId,
      name: modelId,
      provider: "openai-codex",
      api: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    route: "oauth",
    getApiKey: () => "test-oauth-token",
  }) as ResolvedLlmRoute;

const contextFor = (stellaDataDir: string): RunnerContext =>
  ({
    stellaDataDir,
    stellaAppDir: stellaDataDir,
    deviceId: "device-harness-race",
    runtimeStore: {
      loadThreadMessages: () => [],
    },
    state: { loadedAgents: [] },
  }) as unknown as RunnerContext;

describe("subscription harness preference and durable snapshots", () => {
  it("loads legacy preferences as disabled and round-trips an explicit opt-in", () => {
    const stellaDataDir = makeDataDir();
    fs.writeFileSync(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({ agentRuntimeEngine: "codex_cli" }),
    );

    expect(loadLocalPreferences(stellaDataDir).subscriptionHarnessEnabled).toBe(
      false,
    );
    expect(
      getLocalModelPreferences(stellaDataDir).subscriptionHarnessEnabled,
    ).toBe(false);

    fs.writeFileSync(
      path.join(stellaDataDir, "preferences.json"),
      JSON.stringify({
        agentRuntimeEngine: "codex_cli",
        subscriptionHarnessEnabled: "true",
      }),
    );
    expect(loadLocalPreferences(stellaDataDir).subscriptionHarnessEnabled).toBe(
      false,
    );

    const saved = updateLocalModelPreferences(stellaDataDir, {
      subscriptionHarnessEnabled: true,
    });
    expect(saved.subscriptionHarnessEnabled).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stellaDataDir, "preferences.json"), "utf8"),
      ),
    ).toMatchObject({ subscriptionHarnessEnabled: true });
  });

  it("captures Codex harness identity without losing the engine model, effort, or tier", () => {
    const stellaDataDir = makeDataDir();
    updateLocalModelPreferences(stellaDataDir, {
      codexModel: "gpt-5.6-sol",
      codexModelExplicit: true,
      codexReasoningEffort: "high",
      codexServiceTier: "fast",
      subscriptionHarnessEnabled: true,
    });

    expect(
      captureEffectiveModelConfig({
        stellaDataDir,
        engine: "codex_cli",
        subscriptionHarnessEnabled: true,
        engineModelOverride: "gpt-5.6-luna",
        resolvedLlm: stellaRoute(),
      }),
    ).toEqual({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.6-luna",
      engineModel: "gpt-5.6-luna",
      reasoningEffort: "high",
      serviceTier: "fast",
    });
  });

  it("captures the resolved Stella Light Codex model instead of re-expanding the saved default", () => {
    const stellaDataDir = makeDataDir();
    updateLocalModelPreferences(stellaDataDir, {
      codexModel: "gpt-5.6-sol",
      codexModelExplicit: false,
      subscriptionHarnessEnabled: true,
    });

    expect(
      captureEffectiveModelConfig({
        stellaDataDir,
        engine: "codex_cli",
        subscriptionHarnessEnabled: true,
        configuredModel: "stella/light",
        resolvedLlm: codexRoute("gpt-5.4-mini"),
      }),
    ).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.4-mini",
      engineModel: "gpt-5.4-mini",
    });
  });

  it("uses the one-shot pre-route mode sample after the live preference changes", async () => {
    const stellaDataDir = makeDataDir();
    updateLocalModelPreferences(stellaDataDir, {
      agentRuntimeEngine: "default",
      codexReasoningEffort: "high",
      subscriptionHarnessEnabled: false,
    });
    const sampledCodexConfig = sampleAgentEngineConfig({
      stellaDataDir,
      engine: "codex_cli",
      configuredModel: "openai-codex/gpt-5.6-sol",
    });
    updateLocalModelPreferences(stellaDataDir, {
      codexReasoningEffort: "low",
    });

    const sampledOn = await buildAgentContext(contextFor(stellaDataDir), {
      conversationId: "conversation-sampled-on",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-sampled-on",
      configuredAgentEngine: "codex_cli",
      configuredReasoningEffort: "default",
      sampledEngineConfig: sampledCodexConfig,
      subscriptionHarnessEnabled: true,
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codexRoute("gpt-5.6-sol"),
    });
    expect(sampledOn.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(sampledOn.reasoningEffort).toBe("high");

    updateLocalModelPreferences(stellaDataDir, {
      agentRuntimeEngine: "claude_code_local",
      subscriptionHarnessEnabled: true,
    });
    const sampledOff = await buildAgentContext(contextFor(stellaDataDir), {
      conversationId: "conversation-sampled-off",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-sampled-off",
      configuredAgentEngine: "codex_cli",
      subscriptionHarnessEnabled: false,
      model: "stella/standard",
      resolvedLlm: stellaRoute(),
    });
    expect(sampledOff.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      engineModel: "gpt-5.6-sol",
    });
    expect(
      sampledOff.modelConfigSnapshot?.subscriptionHarnessEnabled,
    ).toBeUndefined();
  });

  it("preserves an absent pre-route engine effort after the live preference becomes explicit", async () => {
    const stellaDataDir = makeDataDir();
    updateLocalModelPreferences(stellaDataDir, {
      agentRuntimeEngine: "codex_cli",
      codexReasoningEffort: "default",
      subscriptionHarnessEnabled: true,
    });
    const sampledCodexConfig = sampleAgentEngineConfig({
      stellaDataDir,
      engine: "codex_cli",
      configuredModel: "openai-codex/gpt-5.6-sol",
    });
    expect(sampledCodexConfig.reasoningEffort).toBeUndefined();

    updateLocalModelPreferences(stellaDataDir, {
      codexReasoningEffort: "high",
    });
    const context = await buildAgentContext(contextFor(stellaDataDir), {
      conversationId: "conversation-sampled-effort-absence",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-sampled-effort-absence",
      configuredAgentEngine: "codex_cli",
      configuredReasoningEffort: "default",
      sampledEngineConfig: sampledCodexConfig,
      subscriptionHarnessEnabled: true,
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codexRoute("gpt-5.6-sol"),
    });

    expect(context.modelConfigSnapshot?.reasoningEffort).toBeUndefined();
  });

  it("keeps legacy and persisted runs immutable while routing only new eligible Generals", () => {
    const stellaDataDir = makeDataDir();
    updateLocalModelPreferences(stellaDataDir, {
      codexModel: "gpt-5.6-sol",
      codexModelExplicit: true,
      subscriptionHarnessEnabled: true,
    });
    const common = {
      stellaDataDir,
      agentType: AGENT_IDS.GENERAL,
      configuredEngine: "codex_cli" as const,
      configuredModel: "openai-codex/gpt-5.6-sol",
    };

    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: true,
      }),
    ).toBe("openai-codex/gpt-5.6-sol");
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: true,
        spawnEngine: { engine: "codex_cli", model: "gpt-5.6-luna" },
      }),
    ).toBe("openai-codex/gpt-5.6-luna");
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: true,
        spawnEngine: { engine: "default" },
      }),
    ).toBeUndefined();
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        agentType: AGENT_IDS.ORCHESTRATOR,
        subscriptionHarnessEnabled: true,
      }),
    ).toBeUndefined();

    const legacyNativeSnapshot: AgentModelConfigSnapshot = {
      engine: "codex_cli",
      routeModel: "openai-codex/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
    };
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: true,
        modelConfigSnapshot: legacyNativeSnapshot,
      }),
    ).toBeUndefined();

    const persistedHarnessSnapshot: AgentModelConfigSnapshot = {
      ...legacyNativeSnapshot,
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.6-luna",
      engineModel: "gpt-5.6-luna",
    };
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: false,
        modelConfigSnapshot: persistedHarnessSnapshot,
      }),
    ).toBe("openai-codex/gpt-5.6-luna");
  });
});

describe("spawn_agent subscription harness inheritance", () => {
  const parentSnapshot: AgentModelConfigSnapshot = {
    engine: "codex_cli",
    subscriptionHarnessEnabled: true,
    routeModel: "openai-codex/gpt-5.6-sol",
    engineModel: "gpt-5.6-sol",
    reasoningEffort: "high",
    serviceTier: "fast",
  };

  const runSpawn = async (
    model?: string,
    captureSpawnModelConfig?: StateContext["captureSpawnModelConfig"],
  ) => {
    const created: AgentToolRequest[] = [];
    const ctx = createStateContext(
      "/tmp",
      {
        createAgent: async (request) => {
          created.push(request);
          return { threadId: `child-${created.length}` };
        },
        getAgent: async () => null,
        cancelAgent: async () => ({ canceled: false }),
      },
      undefined,
      undefined,
      captureSpawnModelConfig,
    );
    await handleSpawnAgent(
      ctx,
      {
        description: "Delegated work",
        prompt: "Complete the delegated work.",
        ...(model ? { model } : {}),
      },
      {
        conversationId: "conversation-harness",
        deviceId: "device-harness",
        requestId: `request-${model ?? "implicit"}`,
        agentType: AGENT_IDS.GENERAL,
        agentId: "parent-general",
        agentDepth: 1,
        maxAgentDepth: 2,
        modelConfigSnapshot: parentSnapshot,
      },
    );
    return created[0];
  };

  it("inherits the full immutable snapshot for an unqualified descendant", async () => {
    const request = await runSpawn();
    expect(request?.modelConfigSnapshot).toEqual(parentSnapshot);
    expect(request?.spawnEngine).toBeUndefined();
  });

  it("freezes a pinned Codex snapshot before enqueue", async () => {
    const snapshot: AgentModelConfigSnapshot = {
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.6-luna",
      engineModel: "gpt-5.6-luna",
      reasoningEffort: "high",
      serviceTier: "fast",
    };
    const capture = async (args: {
      spawnEngine: { engine: string; model?: string };
    }) => {
      expect(args.spawnEngine).toEqual({
        engine: "codex_cli",
        model: "gpt-5.6-luna",
      });
      return snapshot;
    };
    const request = await runSpawn("codex/gpt-5.6-luna", capture);
    expect(request?.modelConfigSnapshot).toEqual(snapshot);
    expect(request?.spawnEngine).toEqual({
      engine: "codex_cli",
      model: "gpt-5.6-luna",
    });
  });

  it("freezes explicit Stella as a durable harness bypass", async () => {
    const snapshot: AgentModelConfigSnapshot = {
      engine: "default",
      routeModel: "stella/openai/gpt-5.6-sol",
    };
    const request = await runSpawn("stella", async (args) => {
      expect(args.spawnEngine).toEqual({ engine: "default" });
      return snapshot;
    });
    expect(request?.modelConfigSnapshot).toEqual(snapshot);
    expect(request?.spawnEngine).toEqual({ engine: "default" });
  });

  it("freezes a pinned Claude snapshot without inheriting the Codex mode", async () => {
    const snapshot: AgentModelConfigSnapshot = {
      engine: "claude_code_local",
      routeModel: "stella/openai/gpt-5.6-sol",
      engineModel: "opus",
    };
    const request = await runSpawn("claude-code/opus", async (args) => {
      expect(args.spawnEngine).toEqual({
        engine: "claude_code_local",
        model: "opus",
      });
      return snapshot;
    });
    expect(request?.modelConfigSnapshot).toEqual(snapshot);
    expect(request?.spawnEngine).toEqual({
      engine: "claude_code_local",
      model: "opus",
    });
  });
});
