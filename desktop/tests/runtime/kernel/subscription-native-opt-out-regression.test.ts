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
  it("freezes the inverse-default mode for new General, Orchestrator, and explicit spawn contexts", async () => {
    const stellaDataDir = makeDataDir();
    const context = contextFor(stellaDataDir);
    const codex = resolvedRoute("openai-codex", "gpt-5.6-sol");
    const stella = resolvedRoute("stella", "openai/gpt-5.6-sol");

    expect(getSubscriptionHarnessEnabled(stellaDataDir)).toBe(true);

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

    const orchestrator = await buildAgentContext(context, {
      conversationId: "orchestrator-parent",
      agentType: AGENT_IDS.ORCHESTRATOR,
      runId: "run-orchestrator-parent",
      configuredAgentEngine: "claude_code_local",
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(orchestrator.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
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
      useNativeAgentRuntimes: true,
    });
    expect(getSubscriptionHarnessEnabled(stellaDataDir)).toBe(false);

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
      useNativeAgentRuntimes: true,
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
});
