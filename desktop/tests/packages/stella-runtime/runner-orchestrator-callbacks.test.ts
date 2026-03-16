import { describe, expect, it, vi } from "vitest";
import {
  createAutomationAgentCallbacks,
  createAutomationErrorResult,
  createAutomationFatalErrorHandler,
  createAutomationSuccessResult,
  createOrchestratorFatalErrorHandler,
} from "../../../electron/core/runtime/runner/orchestrator-callbacks.js";

describe("runner orchestrator callback helpers", () => {
  it("maps automation runtime callbacks into result resolution", () => {
    const resolveResult = vi.fn();
    const callbacks = createAutomationAgentCallbacks(resolveResult);

    callbacks.onError({
      error: "tool failed",
    } as never);
    callbacks.onEnd({
      finalText: "done",
    } as never);

    expect(resolveResult).toHaveBeenNthCalledWith(
      1,
      createAutomationErrorResult("tool failed"),
    );
    expect(resolveResult).toHaveBeenNthCalledWith(
      2,
      createAutomationSuccessResult("done"),
    );
  });

  it("normalizes fatal automation errors", () => {
    const resolveResult = vi.fn();
    const onFatalError = createAutomationFatalErrorHandler(resolveResult);

    onFatalError(new Error("launch failed"));
    onFatalError("plain failure");

    expect(resolveResult).toHaveBeenNthCalledWith(
      1,
      createAutomationErrorResult("launch failed"),
    );
    expect(resolveResult).toHaveBeenNthCalledWith(
      2,
      createAutomationErrorResult("plain failure"),
    );
  });

  it("reports fatal orchestrator errors through agent callbacks", () => {
    const callbacks = { onError: vi.fn() };
    const onFatalError = createOrchestratorFatalErrorHandler({
      runId: "run-1",
      agentType: "orchestrator",
      callbacks,
    });

    onFatalError(new Error("runtime failed"));

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        agentType: "orchestrator",
        error: "runtime failed",
        fatal: true,
      }),
    );
  });
});
