import { describe, expect, it, vi } from "vitest";
import {
  executeOrQueueSystemOrchestratorTurn,
  executeOrQueueUserOrchestratorTurn,
} from "../../../electron/core/runtime/runner/orchestrator-dispatch.js";

describe("runner orchestrator dispatch helpers", () => {
  it("queues active user turns and resolves with the deferred result", async () => {
    const queueOrchestratorTurn = vi.fn();
    const execute = vi.fn().mockResolvedValue({ runId: "run-1" });

    const resultPromise = executeOrQueueUserOrchestratorTurn({
      hasActiveRun: true,
      queueOrchestratorTurn,
      execute,
    });

    expect(queueOrchestratorTurn).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();

    const queuedTurn = queueOrchestratorTurn.mock.calls[0]?.[0];
    await queuedTurn.execute();

    await expect(resultPromise).resolves.toEqual({ runId: "run-1" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("normalizes queued user turn failures into errors", async () => {
    const queueOrchestratorTurn = vi.fn();

    const resultPromise = executeOrQueueUserOrchestratorTurn({
      hasActiveRun: true,
      queueOrchestratorTurn,
      execute: vi.fn().mockRejectedValue("boom"),
    });

    const queuedTurn = queueOrchestratorTurn.mock.calls[0]?.[0];
    await queuedTurn.execute();

    await expect(resultPromise).rejects.toEqual(new Error("boom"));
  });

  it("runs idle system turns immediately with replay-enabled queue metadata", async () => {
    const queueOrchestratorTurn = vi.fn();
    const execute = vi.fn().mockResolvedValue(undefined);

    await executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: false,
      queueOrchestratorTurn,
      execute,
    });

    expect(queueOrchestratorTurn).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      priority: "system",
      requeueOnInterrupt: true,
    });
  });

  it("queues active system turns without executing them early", async () => {
    const queueOrchestratorTurn = vi.fn();
    const execute = vi.fn().mockResolvedValue(undefined);

    await executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: true,
      queueOrchestratorTurn,
      execute,
    });

    expect(queueOrchestratorTurn).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();

    const queuedTurn = queueOrchestratorTurn.mock.calls[0]?.[0];
    await queuedTurn.execute();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe(queuedTurn);
  });
});
