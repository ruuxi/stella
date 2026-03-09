import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadAgentsFromHomeMock,
  runOrchestratorTurnMock,
  localTaskManagerCtorMock,
} = vi.hoisted(() => ({
  loadAgentsFromHomeMock: vi.fn(),
  runOrchestratorTurnMock: vi.fn(),
  localTaskManagerCtorMock: vi.fn(),
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

vi.mock("../../../packages/stella-runtime/src/tools/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/stella-runtime/src/tools/index.js")>(
    "../../../packages/stella-runtime/src/tools/index.js",
  );
  return {
    ...actual,
    createToolHost: () => ({
      executeTool: vi.fn(),
      setSkills: vi.fn(),
      registerExtensionTools: vi.fn(),
      killAllShells: vi.fn(),
      killShellsByPort: vi.fn(),
    }),
  };
});

vi.mock("../../../packages/stella-runtime/src/agents/index.js", () => ({
  loadAgentsFromHome: loadAgentsFromHomeMock,
  loadSkillsFromHome: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../packages/stella-runtime/src/extensions/index.js", () => ({
  loadExtensions: vi.fn().mockResolvedValue({ tools: [], hooks: [], providers: [], prompts: [] }),
  HookEmitter: class HookEmitter {
    registerAll() {}
    emit() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../packages/stella-runtime/src/tasks/index.js", () => ({
  LocalTaskManager: class LocalTaskManager {
    constructor(opts: unknown) {
      localTaskManagerCtorMock(opts);
    }

    shutdown() {}
  },
}));

vi.mock("../../../packages/stella-runtime/src/remote-turn-bridge.js", () => ({
  createRemoteTurnBridge: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    kick: vi.fn(),
  }),
}));

vi.mock("../../../packages/stella-runtime/src/model-routing.js", () => ({
  canResolveLlmRoute: vi.fn(() => true),
  resolveLlmRoute: vi.fn(() => ({ model: { id: "test-model" } })),
}));

vi.mock("../../../packages/stella-runtime/src/agent-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/stella-runtime/src/agent-runtime.js")>(
    "../../../packages/stella-runtime/src/agent-runtime.js",
  );
  return {
    ...actual,
    runOrchestratorTurn: runOrchestratorTurnMock,
    runSubagentTask: vi.fn(),
    shutdownSubagentRuntimes: vi.fn(),
  };
});

const { createStellaHostRunner } = await import("../../../packages/stella-runtime/src/runner.js");

const tempHomes: string[] = [];

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-runner-tools-"));
  tempHomes.push(dir);
  return dir;
};

describe("runtime runner tools allowlist", () => {
  beforeEach(() => {
    loadAgentsFromHomeMock.mockReset();
    runOrchestratorTurnMock.mockReset();
    localTaskManagerCtorMock.mockReset();
    loadAgentsFromHomeMock.mockResolvedValue([
      {
        id: "orchestrator",
        name: "Orchestrator",
        systemPrompt: "prompt",
        agentTypes: ["orchestrator"],
        toolsAllowlist: ["Display", "CustomExtensionTool"],
      },
    ]);
    runOrchestratorTurnMock.mockImplementation(async (opts: { callbacks: { onEnd: (event: { finalText: string }) => void } }) => {
      opts.callbacks.onEnd({ finalText: "done" });
    });
  });

  afterEach(() => {
    for (const home of tempHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes declared agent tool names through without runner hardcoded filtering", async () => {
    const runner = createStellaHostRunner({
      deviceId: "device-1",
      StellaHome: createTempHome(),
    });

    runner.setConvexUrl("https://example.convex.cloud");
    runner.setAuthToken("token-1");
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await runner.handleLocalChat(
      {
        conversationId: "conv-1",
        userMessageId: "user-1",
        userPrompt: "hello",
      },
      {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
    );

    expect(runOrchestratorTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      agentContext: expect.objectContaining({
        toolsAllowlist: ["Display", "CustomExtensionTool"],
      }),
    }));

    runner.stop();
  });
});
