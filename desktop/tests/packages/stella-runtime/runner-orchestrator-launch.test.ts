import { beforeEach, describe, expect, it, vi } from "vitest";

const { runOrchestratorTurnMock } = vi.hoisted(() => ({
  runOrchestratorTurnMock: vi.fn(),
}));

vi.mock("../../../electron/core/runtime/agent-runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../electron/core/runtime/agent-runtime.js")
  >("../../../electron/core/runtime/agent-runtime.js");

  return {
    ...actual,
    runOrchestratorTurn: runOrchestratorTurnMock,
  };
});

const {
  launchPreparedOrchestratorRun,
  prepareOrchestratorRun,
} = await import("../../../electron/core/runtime/runner/orchestrator-launch.js");

describe("runner orchestrator launch helpers", () => {
  beforeEach(() => {
    runOrchestratorTurnMock.mockReset();
  });

  it("cleans up non-interrupted launch failures and reports the fatal error", async () => {
    runOrchestratorTurnMock.mockRejectedValue(new Error("launch failed"));

    const cleanupRun = vi.fn();
    const onFatalError = vi.fn();

    launchPreparedOrchestratorRun({
      context: {
        toolHost: { executeTool: vi.fn() },
        deviceId: "device-1",
        stellaHomePath: "/tmp/stella",
        runtimeStore: {},
        frontendRoot: "/repo",
        selfModMonitor: null,
        hookEmitter: {},
        displayHtml: undefined,
      } as never,
      prepared: {
        runId: "run-1",
        conversationId: "conv-1",
        agentType: "orchestrator",
        userPrompt: "hello",
        agentContext: { model: "openai/gpt-4.1-mini" },
        resolvedLlm: { model: { id: "openai/gpt-4.1-mini" } },
        abortController: new AbortController(),
        replayInterruptedTurn: vi.fn(),
      } as never,
      userMessageId: "user-1",
      runtimeCallbacks: {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
      webSearch: vi.fn(),
      finishInterruptedRun: vi.fn(() => false),
      cleanupRun,
      onFatalError,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(cleanupRun).toHaveBeenCalledWith("run-1");
    expect(onFatalError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("prepares active runner state and replay handling for queued turns", async () => {
    const replayTurn = {
      priority: "system",
      requeueOnInterrupt: true,
      execute: vi.fn(),
    };
    const queueOrchestratorTurn = vi.fn();
    const context = {
      stellaHomePath: "/tmp/stella-home",
      state: {
        proxyBaseUrl: "https://demo.convex.site/api/stella/v1",
        authToken: "token-123",
        activeOrchestratorRunId: null,
        activeOrchestratorConversationId: null,
        activeInterruptedReplayTurn: null,
        activeRunAbortControllers: new Map<string, AbortController>(),
      },
    };

    const prepared = await prepareOrchestratorRun({
      context: context as never,
      buildAgentContext: vi.fn().mockResolvedValue({
        model: "openai/gpt-4.1-mini",
      }),
      queueOrchestratorTurn,
      runId: "run-2",
      conversationId: "conv-2",
      agentType: "orchestrator",
      userPrompt: "hello",
      replayTurn,
    });

    expect(context.state.activeOrchestratorRunId).toBe("run-2");
    expect(context.state.activeOrchestratorConversationId).toBe("conv-2");
    expect(context.state.activeInterruptedReplayTurn).toBe(replayTurn);
    expect(context.state.activeRunAbortControllers.get("run-2")).toBe(
      prepared.abortController,
    );

    prepared.replayInterruptedTurn();
    expect(queueOrchestratorTurn).toHaveBeenCalledWith(replayTurn);
  });
});
