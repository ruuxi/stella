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

vi.mock("../../../electron/core/runtime/tools/host.js", () => ({
  createToolHost: () => ({
    executeTool: vi.fn(),
    setSkills: vi.fn(),
    registerExtensionTools: vi.fn(),
    killAllShells: vi.fn(),
    killShellsByPort: vi.fn(),
  }),
}));

vi.mock("../../../electron/core/runtime/agents/agents.js", () => ({
  loadAgentsFromHome: loadAgentsFromHomeMock,
}));

vi.mock("../../../electron/core/runtime/agents/skills.js", () => ({
  loadSkillsFromHome: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../electron/core/runtime/extensions/loader.js", () => ({
  loadExtensions: vi.fn().mockResolvedValue({ tools: [], hooks: [], providers: [], prompts: [] }),
}));

vi.mock("../../../electron/core/runtime/extensions/hook-emitter.js", () => ({
  HookEmitter: class HookEmitter {
    registerAll() {}
    emit() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../electron/core/runtime/tasks/local-task-manager.js", () => ({
  LocalTaskManager: class LocalTaskManager {
    constructor(opts: unknown) {
      localTaskManagerCtorMock(opts);
    }

    shutdown() {}
  },
}));

vi.mock("../../../electron/core/runtime/remote-turn-bridge.js", () => ({
  createRemoteTurnBridge: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    kick: vi.fn(),
  }),
}));

vi.mock("../../../electron/core/runtime/model-routing.js", () => ({
  canResolveLlmRoute: vi.fn(() => true),
  resolveLlmRoute: vi.fn(() => ({ model: { id: "test-model" } })),
}));

vi.mock("../../../electron/core/runtime/agent-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../electron/core/runtime/agent-runtime.js")>(
    "../../../electron/core/runtime/agent-runtime.js",
  );
  return {
    ...actual,
    runOrchestratorTurn: runOrchestratorTurnMock,
    runSubagentTask: vi.fn(),
    shutdownSubagentRuntimes: vi.fn(),
  };
});

const { createStellaHostRunner } = await import("../../../electron/core/runtime/runner.js");
const { createDesktopDatabase } = await import("../../../electron/storage/database.js");
const { RuntimeStore } = await import("../../../electron/storage/runtime-store.js");
const { TranscriptMirror } = await import("../../../electron/storage/transcript-mirror.js");

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
    const home = createTempHome();
    const db = createDesktopDatabase(home);
    const runtimeStore = new RuntimeStore(
      db,
      new TranscriptMirror(path.join(home, "state")),
    );
    const runner = createStellaHostRunner({
      deviceId: "device-1",
      StellaHome: home,
      runtimeStore,
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
    db.close();
  });

  it("starts a follow-up orchestrator turn when a task completes", async () => {
    const home = createTempHome();
    const db = createDesktopDatabase(home);
    const runtimeStore = new RuntimeStore(
      db,
      new TranscriptMirror(path.join(home, "state")),
    );
    const runner = createStellaHostRunner({
      deviceId: "device-1",
      StellaHome: home,
      runtimeStore,
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

    const taskManagerOptions = localTaskManagerCtorMock.mock.calls[0]?.[0] as {
      onTaskEvent: (event: {
        type: "task-completed" | "task-failed" | "task-canceled";
        conversationId: string;
        taskId: string;
        agentType: string;
        description?: string;
        result?: string;
        error?: string;
      }) => void;
    };

    taskManagerOptions.onTaskEvent({
      type: "task-completed",
      conversationId: "conv-1",
      taskId: "local:task:1",
      agentType: "general",
      description: "Redesign dashboard",
      result: "The redesign is complete.",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runOrchestratorTurnMock).toHaveBeenCalledTimes(2);
    expect(runOrchestratorTurnMock).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      userPrompt: expect.stringContaining("[Task completed]"),
    }));
    expect(runOrchestratorTurnMock).toHaveBeenLastCalledWith(expect.objectContaining({
      userPrompt: expect.stringContaining("result: The redesign is complete."),
    }));

    runner.stop();
    db.close();
  });

  it("queues completed task results until the current orchestrator turn finishes", async () => {
    let finishFirstTurn: (() => void) | null = null;
    runOrchestratorTurnMock.mockReset();
    runOrchestratorTurnMock.mockImplementation((opts: { callbacks: { onEnd: (event: { finalText: string }) => void } }) => {
      if (!finishFirstTurn) {
        return new Promise<void>((resolve) => {
          finishFirstTurn = () => {
            opts.callbacks.onEnd({ finalText: "done" });
            resolve();
          };
        });
      }
      opts.callbacks.onEnd({ finalText: "task result handled" });
      return Promise.resolve();
    });

    const home = createTempHome();
    const db = createDesktopDatabase(home);
    const runtimeStore = new RuntimeStore(
      db,
      new TranscriptMirror(path.join(home, "state")),
    );
    const runner = createStellaHostRunner({
      deviceId: "device-1",
      StellaHome: home,
      runtimeStore,
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

    const taskManagerOptions = localTaskManagerCtorMock.mock.calls[0]?.[0] as {
      onTaskEvent: (event: {
        type: "task-completed" | "task-failed" | "task-canceled";
        conversationId: string;
        taskId: string;
        agentType: string;
        description?: string;
        result?: string;
        error?: string;
      }) => void;
    };

    taskManagerOptions.onTaskEvent({
      type: "task-completed",
      conversationId: "conv-1",
      taskId: "local:task:2",
      agentType: "general",
      result: "Queued result",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runOrchestratorTurnMock).toHaveBeenCalledTimes(1);

    finishFirstTurn?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runOrchestratorTurnMock).toHaveBeenCalledTimes(2);
    expect(runOrchestratorTurnMock).toHaveBeenLastCalledWith(expect.objectContaining({
      userPrompt: expect.stringContaining("Queued result"),
    }));

    runner.stop();
    db.close();
  });

  it("starts a follow-up orchestrator turn when a task is canceled", async () => {
    const home = createTempHome();
    const db = createDesktopDatabase(home);
    const runtimeStore = new RuntimeStore(
      db,
      new TranscriptMirror(path.join(home, "state")),
    );
    const runner = createStellaHostRunner({
      deviceId: "device-1",
      StellaHome: home,
      runtimeStore,
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

    const taskManagerOptions = localTaskManagerCtorMock.mock.calls[0]?.[0] as {
      onTaskEvent: (event: {
        type: "task-completed" | "task-failed" | "task-canceled";
        conversationId: string;
        taskId: string;
        agentType: string;
        description?: string;
        result?: string;
        error?: string;
      }) => void;
    };

    taskManagerOptions.onTaskEvent({
      type: "task-canceled",
      conversationId: "conv-1",
      taskId: "local:task:3",
      agentType: "general",
      description: "Redesign dashboard",
      error: "Canceled by user",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runOrchestratorTurnMock).toHaveBeenCalledTimes(2);
    expect(runOrchestratorTurnMock).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      userPrompt: expect.stringContaining("[Task canceled]"),
    }));
    expect(runOrchestratorTurnMock).toHaveBeenLastCalledWith(expect.objectContaining({
      userPrompt: expect.stringContaining("error: Canceled by user"),
    }));

    runner.stop();
    db.close();
  });
});
