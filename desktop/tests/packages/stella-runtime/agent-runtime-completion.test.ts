import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appendThreadMessageMock,
  compactRuntimeThreadHistoryMock,
  persistAssistantReplyMock,
  updateOrchestratorReminderStateMock,
} = vi.hoisted(() => ({
  appendThreadMessageMock: vi.fn(),
  compactRuntimeThreadHistoryMock: vi.fn(),
  persistAssistantReplyMock: vi.fn(),
  updateOrchestratorReminderStateMock: vi.fn(),
}));

vi.mock("../../../packages/runtime-kernel/agent-runtime/thread-memory.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/runtime-kernel/agent-runtime/thread-memory.js")
  >("../../../packages/runtime-kernel/agent-runtime/thread-memory.js");

  return {
    ...actual,
    appendThreadMessage: appendThreadMessageMock,
    compactRuntimeThreadHistory: compactRuntimeThreadHistoryMock,
    persistAssistantReply: persistAssistantReplyMock,
    updateOrchestratorReminderState: updateOrchestratorReminderStateMock,
  };
});

const {
  finalizeOrchestratorSuccess,
  finalizeSubagentSuccess,
} = await import("../../../packages/runtime-kernel/agent-runtime/run-completion.js");

describe("agent runtime completion helpers", () => {
  beforeEach(() => {
    appendThreadMessageMock.mockReset();
    compactRuntimeThreadHistoryMock.mockReset();
    persistAssistantReplyMock.mockReset();
    updateOrchestratorReminderStateMock.mockReset();
  });

  it("skips compaction when before_compact cancels but still records success metadata", async () => {
    const callbacks = {
      onEnd: vi.fn(),
    };
    const hookEmitter = {
      emit: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ cancel: true }),
    };
    const selfModApplied = {
      featureId: "feat-1",
      files: ["src/App.tsx"],
      batchIndex: 0,
    };

    await finalizeOrchestratorSuccess({
      opts: {
        conversationId: "conv-1",
        agentType: "orchestrator",
        agentContext: {
          shouldInjectDynamicReminder: true,
        },
        store: {},
        resolvedLlm: {
          model: {} as never,
          route: "direct-provider",
          getApiKey: () => "key",
        },
        hookEmitter,
        selfModMonitor: {
          getBaselineHead: vi.fn(),
          detectAppliedSince: vi.fn().mockResolvedValue(selfModApplied),
        },
        frontendRoot: "C:/repo",
        callbacks,
      } as never,
      runId: "run-1",
      threadKey: "thread-1",
      runEvents: {
        recordRunEnd: vi.fn((event) => ({
          runId: "run-1",
          agentType: "orchestrator",
          seq: 1,
          persisted: true,
          ...event,
        })),
      } as never,
      agent: {
        state: {
          messages: [{ role: "assistant" }],
        },
      } as never,
      finalText: "Completed work",
      baselineHead: "abc123",
    });

    expect(appendThreadMessageMock).toHaveBeenCalledWith(
      {},
      {
        threadKey: "thread-1",
        role: "assistant",
        content: "Completed work",
      },
    );
    expect(compactRuntimeThreadHistoryMock).not.toHaveBeenCalled();
    expect(callbacks.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        finalText: "Completed work",
        selfModApplied,
      }),
    );
    expect(updateOrchestratorReminderStateMock).toHaveBeenCalledWith(
      {},
      {
        conversationId: "conv-1",
        shouldInjectDynamicReminder: true,
        finalText: "Completed work",
      },
    );
  });

  it("persists subagent replies before emitting success end events", async () => {
    const callbacks = {
      onEnd: vi.fn(),
    };

    const result = await finalizeSubagentSuccess({
      opts: {
        store: {},
        resolvedLlm: {
          model: {} as never,
          route: "direct-provider",
          getApiKey: () => "key",
        },
        agentType: "general",
        callbacks,
      } as never,
      runEvents: {
        recordRunEnd: vi.fn((event) => ({
          runId: "run-2",
          agentType: "general",
          seq: 2,
          persisted: true,
          ...event,
        })),
      } as never,
      runId: "run-2",
      threadKey: "thread-2",
      result: "subagent done",
    });

    expect(persistAssistantReplyMock).toHaveBeenCalledWith({
      store: {},
      threadKey: "thread-2",
      resolvedLlm: expect.any(Object),
      agentType: "general",
      content: "subagent done",
    });
    expect(callbacks.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        finalText: "subagent done",
      }),
    );
    expect(result).toEqual({
      runId: "run-2",
      result: "subagent done",
    });
  });
});
