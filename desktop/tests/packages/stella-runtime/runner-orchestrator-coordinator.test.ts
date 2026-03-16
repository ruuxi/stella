import { describe, expect, it, vi } from "vitest";
import { createOrchestratorCoordinator } from "../../../electron/core/runtime/runner/orchestrator-coordinator.js";

const createContext = () =>
  ({
    state: {
      activeOrchestratorRunId: "run-1",
      activeOrchestratorConversationId: "conv-1",
      queuedOrchestratorTurns: [] as Array<{
        priority: "user" | "system";
        requeueOnInterrupt: boolean;
        execute: () => Promise<void>;
      }>,
      activeRunAbortControllers: new Map<string, AbortController>(),
      interruptedRunIds: new Set<string>(),
      activeToolExecutionCount: 0,
      interruptAfterTool: false,
      activeInterruptedReplayTurn: null,
    },
  }) as never;

describe("runner orchestrator coordinator", () => {
  it("keeps the active run alive on non-fatal runtime errors", () => {
    const context = createContext();
    const coordinator = createOrchestratorCoordinator(context);
    const callbacks = {
      onStream: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };

    const runtimeCallbacks = coordinator.createRuntimeCallbacks(
      "run-1",
      callbacks,
    );
    runtimeCallbacks.onError({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      error: "recoverable",
      fatal: false,
    });

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: "recoverable", fatal: false }),
    );
    expect(context.state.activeOrchestratorRunId).toBe("run-1");
  });

  it("prioritizes queued user turns ahead of system turns", async () => {
    const context = createContext();
    context.state.activeOrchestratorRunId = null;
    const coordinator = createOrchestratorCoordinator(context);

    const executionOrder: string[] = [];
    coordinator.queueOrchestratorTurn({
      priority: "system",
      requeueOnInterrupt: false,
      execute: async () => {
        executionOrder.push("system");
      },
    });
    coordinator.queueOrchestratorTurn({
      priority: "user",
      requeueOnInterrupt: false,
      execute: async () => {
        executionOrder.push("user");
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(executionOrder).toEqual(["user", "system"]);
  });
});
