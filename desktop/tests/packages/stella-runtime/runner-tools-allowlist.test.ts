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
  loadSkillsFromHomeMock,
  loadExtensionsMock,
  runOrchestratorTurnMock,
  localTaskManagerCtorMock,
} = vi.hoisted(() => ({
  loadAgentsFromHomeMock: vi.fn(),
  loadSkillsFromHomeMock: vi.fn(),
  loadExtensionsMock: vi.fn(),
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

vi.mock("../../../packages/runtime-kernel/tools/host.js", () => ({
  createToolHost: () => ({
    executeTool: vi.fn(),
    setSkills: vi.fn(),
    registerExtensionTools: vi.fn(),
    killAllShells: vi.fn(),
    killShellsByPort: vi.fn(),
  }),
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

vi.mock("../../../packages/runtime-kernel/tasks/local-task-manager.js", () => ({
  TASK_SHUTDOWN_CANCEL_REASON: "Canceled because Stella closed or restarted.",
  LocalTaskManager: class LocalTaskManager {
    constructor(opts: unknown) {
      localTaskManagerCtorMock(opts);
    }

    shutdown() {}
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
  resolveLlmRoute: vi.fn(() => ({ model: { id: "test-model" } })),
}));

vi.mock("../../../packages/runtime-kernel/agent-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/runtime-kernel/agent-runtime.js")>(
    "../../../packages/runtime-kernel/agent-runtime.js",
  );
  return {
    ...actual,
    runOrchestratorTurn: runOrchestratorTurnMock,
    runSubagentTask: vi.fn(),
    shutdownSubagentRuntimes: vi.fn(),
  };
});

const { createStellaHostRunner } = await import("../../../packages/runtime-kernel/runner.js");
const { createDesktopDatabase } = await import("../../../packages/runtime-kernel/storage/database.js");
const { RuntimeStore } = await import("../../../packages/runtime-kernel/storage/runtime-store.js");
const { TranscriptMirror } = await import("../../../packages/runtime-kernel/storage/transcript-mirror.js");

const tempHomes: string[] = [];

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-runner-tools-"));
  tempHomes.push(dir);
  return dir;
};

describe("runtime runner tools allowlist", () => {
  beforeEach(() => {
    loadAgentsFromHomeMock.mockReset();
    loadSkillsFromHomeMock.mockReset();
    loadExtensionsMock.mockReset();
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
    loadSkillsFromHomeMock.mockResolvedValue([]);
    loadExtensionsMock.mockResolvedValue({ tools: [], hooks: [], providers: [], prompts: [] });
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
      stellaHomePath: home,
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

  it("does not report ready or accept chats until skills, agents, and extensions finish loading", async () => {
    let resolveSkills: ((value: []) => void) | null = null;
    let resolveAgents: ((value: Array<{
      id: string;
      name: string;
      systemPrompt: string;
      agentTypes: string[];
    }>) => void) | null = null;
    let resolveExtensions: ((value: {
      tools: [];
      hooks: [];
      providers: [];
      prompts: [];
    }) => void) | null = null;

    loadSkillsFromHomeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveSkills = resolve as typeof resolveSkills;
    }));
    loadAgentsFromHomeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveAgents = resolve as typeof resolveAgents;
    }));
    loadExtensionsMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveExtensions = resolve as typeof resolveExtensions;
    }));

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
    });

    runner.setConvexUrl("https://example.convex.cloud");
    runner.setAuthToken("token-1");
    runner.start();

    expect(runner.agentHealthCheck()).toEqual({
      ready: false,
      reason: "Stella runtime is still initializing",
      engine: "stella",
    });

    await expect(
      runner.handleLocalChat(
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
      ),
    ).rejects.toThrow("Stella runtime is still initializing");

    resolveSkills?.([]);
    resolveAgents?.([
      {
        id: "orchestrator",
        name: "Orchestrator",
        systemPrompt: "prompt",
        agentTypes: ["orchestrator"],
      },
    ]);
    resolveExtensions?.({ tools: [], hooks: [], providers: [], prompts: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runner.agentHealthCheck()).toEqual({
      ready: true,
      engine: "pi",
    });

    runner.stop();
    db.close();
  });

  it("passes enabled skill IDs into agent context and drops disabled defaults", async () => {
    loadAgentsFromHomeMock.mockResolvedValue([
      {
        id: "orchestrator",
        name: "Orchestrator",
        systemPrompt: "prompt",
        agentTypes: ["orchestrator"],
        defaultSkills: ["calendar", "disabled-skill"],
      },
    ]);
    loadSkillsFromHomeMock.mockResolvedValue([
      {
        id: "calendar",
        name: "Calendar",
        description: "Calendar skill",
        markdown: "Calendar instructions",
        agentTypes: ["orchestrator"],
        version: 1,
        source: "local",
        filePath: "/tmp/calendar/SKILL.md",
      },
      {
        id: "music",
        name: "Music",
        description: "Music skill",
        markdown: "Music instructions",
        agentTypes: ["orchestrator"],
        version: 1,
        source: "local",
        filePath: "/tmp/music/SKILL.md",
      },
    ]);

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
        defaultSkills: ["calendar"],
        skillIds: ["calendar", "music"],
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
      stellaHomePath: home,
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
      taskId: "1",
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
      stellaHomePath: home,
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
      taskId: "2",
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
      stellaHomePath: home,
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
      taskId: "3",
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

  it("interrupts an active system follow-up so the queued user turn starts next", async () => {
    runOrchestratorTurnMock.mockReset();
    runOrchestratorTurnMock.mockImplementation((opts: {
      userMessageId: string;
      userPrompt: string;
      abortSignal?: AbortSignal;
      callbacks: {
        onEnd: (event: { finalText: string }) => void;
        onError: (event: { error: string; fatal: boolean }) => void;
      };
    }) => {
      if (opts.userMessageId.startsWith("system:")) {
        return new Promise<void>((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => {
            opts.callbacks.onError({
              error: "Interrupted by queued orchestrator turn",
              fatal: true,
            });
            resolve();
          }, { once: true });
        });
      }

      opts.callbacks.onEnd({ finalText: "done" });
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
      stellaHomePath: home,
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
        result?: string;
      }) => void;
    };

    taskManagerOptions.onTaskEvent({
      type: "task-completed",
      conversationId: "conv-1",
      taskId: "4",
      agentType: "general",
      result: "Background result",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runOrchestratorTurnMock).toHaveBeenCalledTimes(2);

    await expect(runner.handleLocalChat(
      {
        conversationId: "conv-1",
        userMessageId: "user-2",
        userPrompt: "new foreground message",
      },
      {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
    )).resolves.toEqual(expect.objectContaining({
      runId: expect.stringMatching(/^local:/),
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runOrchestratorTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      userMessageId: "user-2",
      userPrompt: "new foreground message",
    }));

    runner.stop();
    db.close();
  });
});
