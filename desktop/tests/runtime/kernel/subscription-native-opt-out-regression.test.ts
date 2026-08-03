import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../../../runtime/contracts/agent-runtime.js";
import type { AgentModelConfigSnapshot } from "../../../../runtime/contracts/agent-engine.js";
import type { ResolvedLlmRoute } from "../../../../runtime/kernel/model-routing.js";
import {
  getSubscriptionHarnessEnabled,
  loadLocalPreferences,
  updateLocalModelPreferences,
} from "../../../../runtime/kernel/preferences/local-preferences.js";
import { buildAgentContext } from "../../../../runtime/kernel/runner/context.js";
import type { RunnerContext } from "../../../../runtime/kernel/runner/types.js";
import {
  createStateContext,
  handleSpawnAgent,
} from "../../../../runtime/kernel/tools/state.js";
import type { AgentToolRequest } from "../../../../runtime/kernel/tools/types.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";

const tempDirs: string[] = [];

const makeDataDir = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-native-opt-out-regression-"),
  );
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const resolvedRoute = (
  provider: "stella" | "openai-codex",
  id: string,
): ResolvedLlmRoute =>
  ({
    model: {
      id,
      name: id,
      provider,
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    route: provider === "stella" ? "stella" : "oauth",
    getApiKey: () => "test-key",
  }) as ResolvedLlmRoute;

const contextFor = (stellaDataDir: string): RunnerContext =>
  ({
    stellaDataDir,
    stellaAppDir: stellaDataDir,
    deviceId: "native-opt-out-regression",
    runtimeStore: {
      loadThreadMessages: () => [],
      listActiveThreads: () => [],
      getOrchestratorReminderState: () => ({
        shouldInjectDynamicReminder: false,
        reminderTokensSinceLastInjection: 0,
      }),
    },
    state: { loadedAgents: [] },
  }) as unknown as RunnerContext;

describe("native agent runtime opt-out regression", () => {
  it("freezes independent inverse-default modes for new General, Orchestrator, and explicit spawn contexts", async () => {
    const stellaDataDir = makeDataDir();
    const context = contextFor(stellaDataDir);
    const codex = resolvedRoute("openai-codex", "gpt-5.6-sol");
    const stella = resolvedRoute("stella", "openai/gpt-5.6-sol");

    expect(getSubscriptionHarnessEnabled(stellaDataDir, "codex_cli")).toBe(
      true,
    );
    expect(
      getSubscriptionHarnessEnabled(stellaDataDir, "claude_code_local"),
    ).toBe(true);

    const newCodexGeneral = await buildAgentContext(context, {
      conversationId: "new-codex-general",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-new-codex-general",
      configuredAgentEngine: "codex_cli",
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codex,
    });
    expect(newCodexGeneral.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
    });

    const newClaudeGeneral = await buildAgentContext(context, {
      conversationId: "new-claude-general",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-new-claude-general",
      configuredAgentEngine: "claude_code_local",
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(newClaudeGeneral.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
      subscriptionHarnessEnabled: true,
    });

    const claudeOrchestrator = await buildAgentContext(context, {
      conversationId: "claude-orchestrator-parent",
      agentType: AGENT_IDS.ORCHESTRATOR,
      runId: "run-claude-orchestrator-parent",
      configuredAgentEngine: "claude_code_local",
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(claudeOrchestrator.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
      subscriptionHarnessEnabled: true,
    });

    const codexOrchestrator = await buildAgentContext(context, {
      conversationId: "codex-orchestrator-parent",
      agentType: AGENT_IDS.ORCHESTRATOR,
      runId: "run-codex-orchestrator-parent",
      configuredAgentEngine: "codex_cli",
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codex,
    });
    expect(codexOrchestrator.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
    });

    const explicitCodex = await buildAgentContext(context, {
      conversationId: "explicit-codex",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-explicit-codex",
      configuredAgentEngine: "default",
      spawnEngine: { engine: "codex_cli", model: "gpt-5.6-sol" },
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codex,
    });
    expect(explicitCodex.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
    });

    const explicitClaude = await buildAgentContext(context, {
      conversationId: "explicit-claude",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-explicit-claude",
      configuredAgentEngine: "default",
      spawnEngine: { engine: "claude_code_local", model: "opus" },
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(explicitClaude.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
      subscriptionHarnessEnabled: true,
    });

    const explicitStella = await buildAgentContext(context, {
      conversationId: "explicit-stella",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-explicit-stella",
      configuredAgentEngine: "codex_cli",
      spawnEngine: { engine: "default" },
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(explicitStella.modelConfigSnapshot).toMatchObject({
      engine: "default",
    });
    expect(explicitStella.modelConfigSnapshot).not.toHaveProperty(
      "subscriptionHarnessEnabled",
    );

    updateLocalModelPreferences(stellaDataDir, {
      useNativeCodexRuntime: true,
    });
    expect(getSubscriptionHarnessEnabled(stellaDataDir, "codex_cli")).toBe(
      false,
    );
    expect(
      getSubscriptionHarnessEnabled(stellaDataDir, "claude_code_local"),
    ).toBe(true);

    const nativeCodex = await buildAgentContext(context, {
      conversationId: "native-codex",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-native-codex",
      configuredAgentEngine: "codex_cli",
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codex,
    });
    expect(nativeCodex.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: false,
    });

    const stillHarnessedClaude = await buildAgentContext(context, {
      conversationId: "still-harnessed-claude",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-still-harnessed-claude",
      configuredAgentEngine: "claude_code_local",
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(stillHarnessedClaude.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
      subscriptionHarnessEnabled: true,
    });

    updateLocalModelPreferences(stellaDataDir, {
      useNativeCodexRuntime: false,
      useNativeClaudeCodeRuntime: true,
    });

    const reenabledCodexHarness = await buildAgentContext(context, {
      conversationId: "reenabled-codex-harness",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-reenabled-codex-harness",
      configuredAgentEngine: "codex_cli",
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codex,
    });
    expect(reenabledCodexHarness.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
    });

    const nativeClaude = await buildAgentContext(context, {
      conversationId: "native-claude",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-native-claude",
      configuredAgentEngine: "claude_code_local",
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(nativeClaude.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
      subscriptionHarnessEnabled: false,
    });

    expect(
      newCodexGeneral.modelConfigSnapshot?.subscriptionHarnessEnabled,
    ).toBe(true);
    expect(
      newClaudeGeneral.modelConfigSnapshot?.subscriptionHarnessEnabled,
    ).toBe(true);
  });
  it("migrates the retired global true per absent engine key while ignoring false", () => {
    const writePreferences = (value: Record<string, unknown>) => {
      const stellaDataDir = makeDataDir();
      fs.writeFileSync(
        path.join(stellaDataDir, "preferences.json"),
        JSON.stringify(value),
      );
      return loadLocalPreferences(stellaDataDir);
    };

    expect(writePreferences({ useNativeAgentRuntimes: true })).toMatchObject({
      useNativeCodexRuntime: true,
      useNativeClaudeCodeRuntime: true,
    });
    expect(writePreferences({ useNativeAgentRuntimes: false })).toMatchObject({
      useNativeCodexRuntime: false,
      useNativeClaudeCodeRuntime: false,
    });
    expect(
      writePreferences({
        useNativeAgentRuntimes: true,
        useNativeCodexRuntime: false,
      }),
    ).toMatchObject({
      useNativeCodexRuntime: false,
      useNativeClaudeCodeRuntime: true,
    });
    expect(
      writePreferences({
        useNativeAgentRuntimes: true,
        useNativeClaudeCodeRuntime: false,
      }),
    ).toMatchObject({
      useNativeCodexRuntime: true,
      useNativeClaudeCodeRuntime: false,
    });
    expect(
      writePreferences({
        subscriptionHarnessEnabled: true,
        useNativeAgentRuntimes: false,
      }),
    ).toMatchObject({
      useNativeCodexRuntime: false,
      useNativeClaudeCodeRuntime: false,
    });
  });

  it("keeps harness, native, and legacy-native snapshots byte-for-byte stable across a database reopen", () => {
    const stellaDataDir = makeDataDir();
    const dbPath = getDesktopDatabasePath(stellaDataDir);
    let db = new DatabaseSync(dbPath, {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    let store = new SessionStore(db);

    const snapshots: Record<string, AgentModelConfigSnapshot> = {
      harness: {
        engine: "claude_code_local",
        subscriptionHarnessEnabled: true,
        routeModel: "stella/openai/gpt-5.6-sol",
        engineModel: "opus",
      },
      native: {
        engine: "codex_cli",
        subscriptionHarnessEnabled: false,
        routeModel: "openai-codex/gpt-5.6-sol",
        engineModel: "gpt-5.6-sol",
      },
      legacy: {
        engine: "codex_cli",
        routeModel: "openai-codex/gpt-5.4",
        engineModel: "gpt-5.4",
      },
    };

    Object.entries(snapshots).forEach(([name, modelConfigSnapshot], index) => {
      store.saveAgentRecord({
        threadId: `queued-${name}`,
        conversationId: "queued-snapshot-restart",
        agentType: AGENT_IDS.GENERAL,
        description: `Queued ${name} run`,
        agentDepth: 1,
        status: "running",
        attemptGeneration: 1,
        startedAt: index + 1,
        completedAt: null,
        updatedAt: index + 1,
        modelConfigSnapshot,
      });
    });

    updateLocalModelPreferences(stellaDataDir, {
      useNativeCodexRuntime: true,
      useNativeClaudeCodeRuntime: true,
    });
    db.close();

    db = new DatabaseSync(dbPath, {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    store = new SessionStore(db);

    for (const [name, snapshot] of Object.entries(snapshots)) {
      expect(
        store.getAgentRecord(`queued-${name}`)?.modelConfigSnapshot,
      ).toEqual(snapshot);
    }

    db.close();
  });

  it("inherits explicit-native and legacy-native parent snapshots without resampling the preference", async () => {
    const inheritSnapshot = async (snapshot: AgentModelConfigSnapshot) => {
      const created: AgentToolRequest[] = [];
      const state = createStateContext("/tmp", {
        createAgent: async (request) => {
          created.push(request);
          return { threadId: `child-${created.length}` };
        },
        getAgent: async () => null,
        cancelAgent: async () => ({ canceled: false }),
      });

      await handleSpawnAgent(
        state,
        {
          description: "Inherited snapshot check",
          prompt: "Keep the parent's durable runtime mode.",
        },
        {
          conversationId: "inherit-native-mode",
          deviceId: "inherit-native-mode",
          requestId: "inherit-native-mode",
          agentType: AGENT_IDS.GENERAL,
          agentId: "parent-general",
          agentDepth: 1,
          maxAgentDepth: 2,
          modelConfigSnapshot: snapshot,
        },
      );

      return created[0]?.modelConfigSnapshot;
    };

    const explicitNative: AgentModelConfigSnapshot = {
      engine: "claude_code_local",
      subscriptionHarnessEnabled: false,
      routeModel: "stella/openai/gpt-5.6-sol",
      engineModel: "opus",
    };
    const legacyNative: AgentModelConfigSnapshot = {
      engine: "codex_cli",
      routeModel: "openai-codex/gpt-5.4",
      engineModel: "gpt-5.4",
    };

    await expect(inheritSnapshot(explicitNative)).resolves.toEqual(
      explicitNative,
    );
    await expect(inheritSnapshot(legacyNative)).resolves.toEqual(legacyNative);
  });

  it("resamples the explicitly pinned child engine instead of inheriting an Orchestrator's other-engine mode", async () => {
    const spawnPinned = async (
      parentSnapshot: AgentModelConfigSnapshot,
      model: string,
      childSnapshot: AgentModelConfigSnapshot,
    ) => {
      const created: AgentToolRequest[] = [];
      const state = createStateContext(
        "/tmp",
        {
          createAgent: async (request) => {
            created.push(request);
            return { threadId: `pinned-child-${created.length}` };
          },
          getAgent: async () => null,
          cancelAgent: async () => ({ canceled: false }),
        },
        undefined,
        undefined,
        async ({ spawnEngine }) => {
          expect(spawnEngine.engine).toBe(childSnapshot.engine);
          return childSnapshot;
        },
      );

      await handleSpawnAgent(
        state,
        {
          description: "Cross-engine pin check",
          prompt: "Use the explicitly selected child engine.",
          model,
        },
        {
          conversationId: "cross-engine-orchestrator-pin",
          deviceId: "cross-engine-orchestrator-pin",
          requestId: `cross-engine-${model}`,
          agentType: AGENT_IDS.ORCHESTRATOR,
          agentDepth: 0,
          maxAgentDepth: 2,
          modelConfigSnapshot: parentSnapshot,
        },
      );

      return created[0];
    };

    const codexHarnessParent: AgentModelConfigSnapshot = {
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
    };
    const nativeClaudeChild: AgentModelConfigSnapshot = {
      engine: "claude_code_local",
      subscriptionHarnessEnabled: false,
      routeModel: "stella/openai/gpt-5.6-sol",
      engineModel: "opus",
    };
    const nativeClaudeParent: AgentModelConfigSnapshot = {
      ...nativeClaudeChild,
    };
    const codexHarnessChild: AgentModelConfigSnapshot = {
      ...codexHarnessParent,
    };

    await expect(
      spawnPinned(codexHarnessParent, "claude-code/opus", nativeClaudeChild),
    ).resolves.toMatchObject({
      spawnEngine: { engine: "claude_code_local", model: "opus" },
      modelConfigSnapshot: nativeClaudeChild,
    });
    await expect(
      spawnPinned(nativeClaudeParent, "codex/gpt-5.6-sol", codexHarnessChild),
    ).resolves.toMatchObject({
      spawnEngine: { engine: "codex_cli", model: "gpt-5.6-sol" },
      modelConfigSnapshot: codexHarnessChild,
    });
  });
});
