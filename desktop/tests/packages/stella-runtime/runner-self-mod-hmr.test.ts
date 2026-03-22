import { describe, expect, it, vi } from "vitest";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";

const { runSubagentTaskMock, shutdownSubagentRuntimesMock } = vi.hoisted(() => ({
  runSubagentTaskMock: vi.fn(),
  shutdownSubagentRuntimesMock: vi.fn(),
}));

vi.mock("../../../packages/runtime-kernel/agent-runtime.js", () => ({
  runSubagentTask: runSubagentTaskMock,
  shutdownSubagentRuntimes: shutdownSubagentRuntimesMock,
}));

vi.mock("../../../packages/runtime-kernel/model-routing.js", () => ({
  resolveLlmRoute: vi.fn(() => ({
    model: { id: "mock-model" },
    getApiKey: () => "test-key",
  })),
}));

vi.mock("../../../packages/runtime-kernel/preferences/local-preferences.js", () => ({
  getMaxAgentConcurrency: vi.fn(() => 24),
}));

const { createTaskOrchestration } = await import(
  "../../../packages/runtime-kernel/runner/task-orchestration.js"
);

const waitForCondition = async (condition: () => boolean, timeoutMs = 3_000) => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("runner self-mod HMR transitions", () => {
  it("skips morph transition and resumes HMR quietly when queuedFiles is zero", async () => {
    runSubagentTaskMock.mockResolvedValue({
      runId: "local:sub:dashboard-1",
      result: "done",
    });

    const pause = vi.fn(async () => true);
    const resume = vi.fn(async () => true);
    const getStatus = vi.fn(async () => ({
      paused: true,
      queuedFiles: 0,
      requiresFullReload: false,
    }));
    const runTransition = vi.fn(async ({ resumeHmr }: { resumeHmr: () => Promise<void> }) => {
      await resumeHmr();
    });

    const context = {
      stellaHomePath: "/mock/home",
      deviceId: "device-1",
      frontendRoot: "/mock/frontend",
      selfModMonitor: null,
      selfModLifecycle: null,
      selfModHmrController: {
        pause,
        resume,
        getStatus,
      },
      getHmrTransitionController: () => ({
        runTransition,
      }),
      runtimeStore: {
        resolveOrCreateActiveThread: vi.fn(() => ({
          threadId: "thread-dashboard",
          threadName: "dashboard",
          reused: false,
        })),
      },
      hookEmitter: {},
      toolHost: {
        executeTool: vi.fn(async () => ({ result: "ok" })),
      },
      state: {
        conversationCallbacks: new Map(),
        localTaskManager: null,
      },
    } as never;

    const orchestration = createTaskOrchestration(context, {
      buildAgentContext: vi.fn(async () => ({
        systemPrompt: "system",
        dynamicContext: "",
        maxTaskDepth: 1,
        defaultSkills: [],
        skillIds: [],
      })),
      queueOrchestratorTurn: vi.fn(),
      startStreamingOrchestratorTurn: vi.fn(async () => ({ runId: "orchestrator-run" })),
      webSearch: vi.fn(async () => ({ text: "", results: [] })),
    });

    const created = await orchestration.createBackgroundTask({
      conversationId: "conv-dashboard",
      description: "Generate personal website",
      prompt: "Build the dashboard",
      agentType: AGENT_IDS.DASHBOARD_GENERATION,
      maxTaskDepth: 1,
    });

    // With zero queued files, the morph transition is skipped and HMR resumes quietly.
    await waitForCondition(() => resume.mock.calls.length === 1);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(runTransition).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);

    const snapshot = await context.state.localTaskManager?.getTask(created.taskId);
    expect(snapshot?.status).toBe("completed");
  });

  it("routes dashboard generation through the transition controller when queuedFiles > 0", async () => {
    runSubagentTaskMock.mockResolvedValue({
      runId: "local:sub:dashboard-2",
      result: "done",
    });

    const pause = vi.fn(async () => true);
    const resume = vi.fn(async () => true);
    const getStatus = vi.fn(async () => ({
      paused: true,
      queuedFiles: 3,
      requiresFullReload: false,
    }));
    const runTransition = vi.fn(async ({ resumeHmr }: { resumeHmr: () => Promise<void> }) => {
      await resumeHmr();
    });

    const context = {
      stellaHomePath: "/mock/home",
      deviceId: "device-1",
      frontendRoot: "/mock/frontend",
      selfModMonitor: null,
      selfModLifecycle: null,
      selfModHmrController: {
        pause,
        resume,
        getStatus,
      },
      getHmrTransitionController: () => ({
        runTransition,
      }),
      runtimeStore: {
        resolveOrCreateActiveThread: vi.fn(() => ({
          threadId: "thread-dashboard",
          threadName: "dashboard",
          reused: false,
        })),
      },
      hookEmitter: {},
      toolHost: {
        executeTool: vi.fn(async () => ({ result: "ok" })),
      },
      state: {
        conversationCallbacks: new Map(),
        localTaskManager: null,
      },
    } as never;

    const orchestration = createTaskOrchestration(context, {
      buildAgentContext: vi.fn(async () => ({
        systemPrompt: "system",
        dynamicContext: "",
        maxTaskDepth: 1,
        defaultSkills: [],
        skillIds: [],
      })),
      queueOrchestratorTurn: vi.fn(),
      startStreamingOrchestratorTurn: vi.fn(async () => ({ runId: "orchestrator-run" })),
      webSearch: vi.fn(async () => ({ text: "", results: [] })),
    });

    const created = await orchestration.createBackgroundTask({
      conversationId: "conv-dashboard",
      description: "Generate personal website",
      prompt: "Build the dashboard",
      agentType: AGENT_IDS.DASHBOARD_GENERATION,
      maxTaskDepth: 1,
    });

    await waitForCondition(() => runTransition.mock.calls.length === 1);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(runTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        requiresFullReload: false,
      }),
    );
    expect(resume).toHaveBeenCalledTimes(1);

    const snapshot = await context.state.localTaskManager?.getTask(created.taskId);
    expect(snapshot?.status).toBe("completed");
  });
});
