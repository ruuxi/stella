import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", async () => {
  const { DatabaseSync } = await import("node:sqlite");

  class BetterSqlite3Mock {
    private readonly db: InstanceType<typeof DatabaseSync>;

    constructor(filePath: string, options?: { readonly?: boolean }) {
      this.db = new DatabaseSync(filePath, {
        readOnly: options?.readonly === true,
      });
    }

    exec(sql: string) {
      this.db.exec(sql);
    }

    prepare(sql: string) {
      return this.db.prepare(sql);
    }

    close() {
      this.db.close();
    }
  }

  return { default: BetterSqlite3Mock };
});

const {
  generalEngineState,
  loadAgentsFromHomeMock,
  loadSkillsFromHomeMock,
  loadExtensionsMock,
  runOrchestratorTurnMock,
  runClaudeCodeTurnMock,
} = vi.hoisted(() => ({
  generalEngineState: { value: "claude_code_local" as "default" | "claude_code_local" },
  loadAgentsFromHomeMock: vi.fn(),
  loadSkillsFromHomeMock: vi.fn(),
  loadExtensionsMock: vi.fn(),
  runOrchestratorTurnMock: vi.fn(),
  runClaudeCodeTurnMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class MockConvexClient {
    action = vi.fn();
    setAuth = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    onUpdate = vi.fn(() => ({ unsubscribe: vi.fn() }));
  },
}));

vi.mock("convex/server", () => ({
  anyApi: {},
}));

vi.mock("../../../packages/runtime-kernel/agents/agents.js", () => ({
  loadAgentsFromHome: loadAgentsFromHomeMock,
}));

vi.mock("../../../packages/runtime-kernel/agents/skills.js", () => ({
  loadSkillsFromHome: loadSkillsFromHomeMock,
}));

vi.mock("../../../packages/runtime-kernel/extensions/loader.js", () => ({
  loadExtensions: loadExtensionsMock,
}));

vi.mock("../../../packages/runtime-kernel/extensions/hook-emitter.js", () => ({
  HookEmitter: class HookEmitter {
    registerAll() {}
    emit() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../packages/runtime-kernel/remote-turn-bridge.js", () => ({
  createRemoteTurnBridge: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    kick: vi.fn(),
  }),
}));

vi.mock("../../../packages/runtime-kernel/model-routing.js", () => ({
  canResolveLlmRoute: vi.fn(() => true),
  resolveLlmRoute: vi.fn(({ modelName }: { modelName?: string }) => ({
    model: {
      id: modelName ?? "openai/gpt-4.1-mini",
      name: "Mock model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 200_000,
      maxTokens: 100_000,
    },
    route: "direct-provider",
    getApiKey: () => "test-key",
  })),
}));

vi.mock("../../../packages/runtime-kernel/preferences/local-preferences.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/runtime-kernel/preferences/local-preferences.js")>(
    "../../../packages/runtime-kernel/preferences/local-preferences.js",
  );

  return {
    ...actual,
    getModelOverride: vi.fn(() => undefined),
    getDefaultModel: vi.fn(() => "openai/gpt-4.1-mini"),
    getGeneralAgentEngine: vi.fn(() => generalEngineState.value),
    getSelfModAgentEngine: vi.fn(() => "default"),
    getMaxAgentConcurrency: vi.fn(() => 24),
  };
});

vi.mock("../../../packages/runtime-kernel/integrations/claude-code-session-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/runtime-kernel/integrations/claude-code-session-runtime.js")>(
    "../../../packages/runtime-kernel/integrations/claude-code-session-runtime.js",
  );
  return {
    ...actual,
    isClaudeCodeModel: vi.fn(() => false),
    runClaudeCodeTurn: runClaudeCodeTurnMock,
    shutdownClaudeCodeRuntime: vi.fn(),
  };
});

vi.mock("../../../packages/runtime-kernel/agent-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/runtime-kernel/agent-runtime.js")>(
    "../../../packages/runtime-kernel/agent-runtime.js",
  );
  return {
    ...actual,
    runOrchestratorTurn: runOrchestratorTurnMock,
  };
});

const { createStellaHostRunner } = await import("../../../packages/runtime-kernel/runner.js");
const { createDesktopDatabase } = await import("../../../packages/runtime-kernel/storage/database.js");
const { RuntimeStore } = await import("../../../packages/runtime-kernel/storage/runtime-store.js");
const { TranscriptMirror } = await import("../../../packages/runtime-kernel/storage/transcript-mirror.js");

const tempHomes: string[] = [];

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-runner-task-bridge-"));
  tempHomes.push(dir);
  return dir;
};

const waitForCondition = async (condition: () => boolean, timeoutMs = 3_000) => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("runner general task bridge", () => {
  beforeEach(() => {
    loadAgentsFromHomeMock.mockReset();
    loadSkillsFromHomeMock.mockReset();
    loadExtensionsMock.mockReset();
    runOrchestratorTurnMock.mockReset();
    runClaudeCodeTurnMock.mockReset();

    loadAgentsFromHomeMock.mockResolvedValue([
      {
        id: "orchestrator",
        name: "Orchestrator",
        systemPrompt: "orchestrator prompt",
        agentTypes: ["orchestrator"],
      },
      {
        id: "general",
        name: "General",
        systemPrompt: "general prompt",
        agentTypes: ["general"],
        model: "openai/gpt-4.1-mini",
      },
    ]);
    loadSkillsFromHomeMock.mockResolvedValue([]);
    loadExtensionsMock.mockResolvedValue({ tools: [], hooks: [], providers: [], prompts: [] });

    runOrchestratorTurnMock.mockImplementation(async (opts: {
      runId: string;
      agentType: string;
      callbacks: { onEnd: (event: { runId: string; agentType: string; seq: number; finalText: string; persisted: boolean }) => void };
    }) => {
      opts.callbacks.onEnd({
        runId: opts.runId,
        agentType: opts.agentType,
        seq: Date.now(),
        finalText: "ok",
        persisted: true,
      });
    });
  });

  afterEach(() => {
    for (const home of tempHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it(
    "delivers TaskCreate work to general and routes Claude Code completion back to orchestrator",
    async () => {
      generalEngineState.value = "claude_code_local";
      const completionText = "General claude completion";
      runClaudeCodeTurnMock.mockResolvedValue({
        text: completionText,
        sessionId: "session-1",
      });

      const home = createTempHome();
      const db = createDesktopDatabase(home);
      const runtimeStore = new RuntimeStore(
        db,
        new TranscriptMirror(path.join(home, "state")),
      );

      const runner = createStellaHostRunner({
        deviceId: "device-1",
        stellaHomePath: home,
        runtimeStore,
        frontendRoot: "/mock/project/stella/desktop",
      });

      const taskEvents: Array<{ type: string; agentType?: string; result?: string }> = [];

      try {
        runner.setConvexUrl("https://example.convex.cloud");
        runner.setAuthToken("token-1");
        runner.start();
        await waitForCondition(() => runner.agentHealthCheck().ready);

        await runner.handleLocalChat(
          {
            conversationId: "conv-1",
            userMessageId: "user-1",
            userPrompt: "seed orchestrator callbacks",
          },
          {
            onStream: vi.fn(),
            onToolStart: vi.fn(),
            onToolEnd: vi.fn(),
            onError: vi.fn(),
            onEnd: vi.fn(),
            onTaskEvent: (event) => {
              taskEvents.push({
                type: event.type,
                agentType: event.agentType,
                result: event.result,
              });
            },
          },
        );

        const taskDescription = "Implement reusable formatter";
        const taskPrompt = "Create the formatter and explain output.";

        const taskCreateResult = await runner.executeTool(
          "TaskCreate",
          {
            description: taskDescription,
            prompt: taskPrompt,
            subagent_type: "general",
          },
          {
            conversationId: "conv-1",
            deviceId: "device-1",
            requestId: "req-1",
            rootRunId: "root-1",
            agentType: "orchestrator",
            storageMode: "local",
            taskDepth: 0,
            maxTaskDepth: 2,
            delegationAllowlist: ["general", "self_mod", "explore", "app"],
          },
        );

        expect(taskCreateResult.error).toBeUndefined();
        const taskResultText = String(taskCreateResult.result ?? "");
        const taskIdMatch = taskResultText.match(/Task ID:\s*(\S+)/);
        expect(taskIdMatch?.[1]).toBeTruthy();

        await waitForCondition(() =>
          taskEvents.some((event) =>
            event.type === "task-completed"
            && event.agentType === "general"
            && event.result === completionText));

        await waitForCondition(() => runOrchestratorTurnMock.mock.calls.length >= 2);
        const followUpCall = runOrchestratorTurnMock.mock.calls.find(
          (call, index) => index > 0 && String((call?.[0] as { userPrompt?: unknown })?.userPrompt ?? "").includes("[Task completed]"),
        );
        expect(followUpCall).toBeTruthy();
        const followUpPrompt = String((followUpCall?.[0] as { userPrompt?: unknown }).userPrompt ?? "");
        expect(followUpPrompt).toContain("[Task completed]");
        expect(followUpPrompt).toContain("agent_type: general");
        expect(followUpPrompt).toContain(`result: ${completionText}`);

        expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
        const claudeRequest = runClaudeCodeTurnMock.mock.calls[0]?.[0] as {
          prompt?: string;
          cwd?: string;
        };
        expect(claudeRequest.prompt).toBe(`${taskDescription}\n\n${taskPrompt}`);
        expect(claudeRequest.cwd).toBe("/mock/project/stella/desktop");

        const taskOutputResult = await runner.executeTool(
          "TaskOutput",
          {
            task_id: taskIdMatch?.[1],
          },
          {
            conversationId: "conv-1",
            deviceId: "device-1",
            requestId: "req-2",
          },
        );
        expect(String(taskOutputResult.result ?? "")).toContain("Task completed.");
        expect(String(taskOutputResult.result ?? "")).toContain(completionText);
      } finally {
        runner.stop();
        db.close();
      }
    },
  );
});

