import { beforeEach, describe, expect, it, vi } from "vitest";

const { subscribeRuntimeAgentEventsMock } = vi.hoisted(() => ({
  subscribeRuntimeAgentEventsMock: vi.fn(),
}));

vi.mock("../../../electron/core/runtime/agent-runtime/run-events.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../electron/core/runtime/agent-runtime/run-events.js")
  >("../../../electron/core/runtime/agent-runtime/run-events.js");

  return {
    ...actual,
    subscribeRuntimeAgentEvents: subscribeRuntimeAgentEventsMock,
  };
});

const { executeRuntimeAgentPrompt } = await import(
  "../../../electron/core/runtime/agent-runtime/run-execution.js"
);

describe("agent runtime execution helper", () => {
  beforeEach(() => {
    subscribeRuntimeAgentEventsMock.mockReset();
    subscribeRuntimeAgentEventsMock.mockReturnValue(vi.fn());
  });

  it("subscribes, prompts, and cleans up after a successful run", async () => {
    const unsubscribe = vi.fn();
    subscribeRuntimeAgentEventsMock.mockReturnValue(unsubscribe);

    const agent = {
      state: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            api: "openai-responses",
            provider: "openai",
            model: "openai/gpt-4.1-mini",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 1,
          },
        ],
      },
      subscribe: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
    };
    const controller = new AbortController();
    const onAfterPrompt = vi.fn();
    const onCleanup = vi.fn();

    const result = await executeRuntimeAgentPrompt({
      agent: agent as never,
      promptText: "hello",
      runId: "run-1",
      agentType: "orchestrator",
      recorder: {} as never,
      abortSignal: controller.signal,
      callbacks: {
        onStream: vi.fn(),
      },
      onAfterPrompt,
      onCleanup,
    });

    expect(result).toEqual({ finalText: "Done" });
    expect(subscribeRuntimeAgentEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        runId: "run-1",
        agentType: "orchestrator",
      }),
    );
    expect(agent.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: expect.any(Number),
      }),
    );
    expect(onAfterPrompt).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    controller.abort();
    expect(agent.abort).not.toHaveBeenCalled();
  });

  it("cleans up and rethrows prompt failures", async () => {
    const unsubscribe = vi.fn();
    subscribeRuntimeAgentEventsMock.mockReturnValue(unsubscribe);

    const agent = {
      state: { messages: [] },
      subscribe: vi.fn(),
      prompt: vi.fn().mockRejectedValue(new Error("prompt failed")),
      abort: vi.fn(),
    };
    const onCleanup = vi.fn();

    await expect(
      executeRuntimeAgentPrompt({
        agent: agent as never,
        promptText: "hello",
        runId: "run-2",
        agentType: "general",
        recorder: {} as never,
        onCleanup,
      }),
    ).rejects.toThrow("prompt failed");

    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
