import { describe, expect, it, vi } from "vitest";
import { createRuntimeInitialization } from "../../../packages/runtime-kernel/runner/runtime-initialization.js";

describe("runtime initialization shutdown", () => {
  it("cancels tasks before clearing conversation callbacks", () => {
    const shutdownTasks = vi.fn(() => {
      expect(context.state.conversationCallbacks.size).toBe(1);
    });

    const context = {
      paths: {
        agentsPath: "",
        extensionsPath: "",
      },
      state: {
        isRunning: true,
        isInitialized: true,
        initializationPromise: Promise.resolve(),
        activeOrchestratorRunId: "run-1",
        activeOrchestratorConversationId: "conv-1",
        queuedOrchestratorTurns: [{ priority: "user", requeueOnInterrupt: false, execute: async () => {} }],
        activeToolExecutionCount: 1,
        interruptAfterTool: true,
        activeInterruptedReplayTurn: { priority: "system", requeueOnInterrupt: true, execute: async () => {} },
        activeRunAbortControllers: new Map([
          ["run-1", new AbortController()],
        ]),
        conversationCallbacks: new Map([
          ["conv-1", { onStream: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn(), onEnd: vi.fn() }],
        ]),
        interruptedRunIds: new Set(["run-1"]),
        loadedAgents: [],
      },
      hookEmitter: {
        registerAll: vi.fn(),
      },
      toolHost: {
        registerExtensionTools: vi.fn(),
        killAllShells: vi.fn(),
      },
      selfModHmrController: {
        forceResumeAll: vi.fn(async () => true),
      },
    } as any;

    const runtimeInitialization = createRuntimeInitialization(context, {
      refreshLoadedSkills: vi.fn(async () => undefined),
      disposeConvexClient: vi.fn(),
      syncRemoteTurnBridge: vi.fn(),
      shutdownTasks,
    });

    runtimeInitialization.stop();

    expect(shutdownTasks).toHaveBeenCalledTimes(1);
    expect(context.state.conversationCallbacks.size).toBe(0);
    expect(context.state.queuedOrchestratorTurns).toEqual([]);
    expect(context.toolHost.killAllShells).toHaveBeenCalledTimes(1);
  });
});
