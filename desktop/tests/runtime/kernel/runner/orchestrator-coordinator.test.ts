import { describe, expect, it, vi } from "vitest";
import { createOrchestratorCoordinator } from "../../../../../runtime/kernel/runner/orchestrator-coordinator.js";
import type { RunnerContext } from "../../../../../runtime/kernel/runner/types.js";

const waitForQueuedMicrotasks = async () => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};

const createContext = (runId = "run-1") => {
  const clearAllQueues = vi.fn();
  const context = {
    state: {
      activeOrchestratorRunId: runId,
      activeOrchestratorConversationId: "conversation-1",
      activeOrchestratorUiVisibility: "visible",
      activeOrchestratorSession: {
        runId,
        conversationId: "conversation-1",
        agentType: "orchestrator",
        uiVisibility: "visible",
        threadKey: "thread-1",
        engine: "native",
        queueUserMessageId: vi.fn(),
        queueCallbackSwitch: vi.fn(),
        queueMessage: vi.fn(),
        agent: {
          state: {
            isStreaming: true,
          },
          steer: vi.fn(),
          followUp: vi.fn(),
          clearAllQueues,
        },
      },
      activeRunAbortControllers: new Map([[runId, new AbortController()]]),
      queuedOrchestratorTurns: [],
      pendingFollowUpReplies: new Map(),
    },
  } as unknown as RunnerContext;

  return { context, clearAllQueues };
};

const createCallbacks = () => ({
  onStream: vi.fn(),
  onToolStart: vi.fn(),
  onToolEnd: vi.fn(),
  onError: vi.fn(),
  onEnd: vi.fn(),
  onInterrupted: vi.fn(),
});

describe("createOrchestratorCoordinator", () => {
  it("clears live-session queues when a run fails fatally", () => {
    const { context, clearAllQueues } = createContext();
    const callbacks = createCallbacks();
    const runtimeCallbacks =
      createOrchestratorCoordinator(context).createRuntimeCallbacks(
        "run-1",
        callbacks,
      );

    runtimeCallbacks.onError({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      error: "provider failed",
      fatal: true,
    });

    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(clearAllQueues).toHaveBeenCalledOnce();
    expect(context.state.activeOrchestratorRunId).toBeNull();
    expect(context.state.activeOrchestratorSession).toBeNull();
  });

  it("does not clear live-session queues for non-fatal errors", () => {
    const { context, clearAllQueues } = createContext();
    const callbacks = createCallbacks();
    const runtimeCallbacks =
      createOrchestratorCoordinator(context).createRuntimeCallbacks(
        "run-1",
        callbacks,
      );

    runtimeCallbacks.onError({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      error: "transient",
      fatal: false,
    });

    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(clearAllQueues).not.toHaveBeenCalled();
    expect(context.state.activeOrchestratorRunId).toBe("run-1");
  });

  it("clears live-session queues when a run is interrupted", () => {
    const { context, clearAllQueues } = createContext();
    const callbacks = createCallbacks();
    const runtimeCallbacks =
      createOrchestratorCoordinator(context).createRuntimeCallbacks(
        "run-1",
        callbacks,
      );

    runtimeCallbacks.onInterrupted?.({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      userMessageId: "message-1",
      reason: "Canceled",
    });

    expect(clearAllQueues).toHaveBeenCalledOnce();
    expect(callbacks.onInterrupted).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        userMessageId: "message-1",
        reason: "Canceled",
      }),
    );
    expect(context.state.activeOrchestratorRunId).toBeNull();
  });

  it("keeps live-session queues intact when a run completes", () => {
    const { context, clearAllQueues } = createContext();
    const callbacks = createCallbacks();
    const runtimeCallbacks =
      createOrchestratorCoordinator(context).createRuntimeCallbacks(
        "run-1",
        callbacks,
      );

    runtimeCallbacks.onEnd({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      finalText: "done",
      timestamp: Date.now(),
    });

    expect(clearAllQueues).not.toHaveBeenCalled();
    expect(callbacks.onEnd).toHaveBeenCalledOnce();
    expect(context.state.activeOrchestratorRunId).toBeNull();
  });

  it("flushes pending follow-up replies when a run fails fatally", () => {
    const { context } = createContext();
    const callbacks = createCallbacks();
    const coordinator = createOrchestratorCoordinator(context);
    const flush = vi.fn();
    coordinator.setFollowUpReplyFlusher(flush);
    context.state.pendingFollowUpReplies.set("conversation-1", [
      { text: "are you there?" },
    ]);
    const runtimeCallbacks = coordinator.createRuntimeCallbacks(
      "run-1",
      callbacks,
    );

    runtimeCallbacks.onError({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      error: "provider failed",
      fatal: true,
    });

    expect(flush).toHaveBeenCalledExactlyOnceWith("conversation-1");
  });

  it("flushes pending follow-up replies when a run is interrupted", () => {
    const { context } = createContext();
    const callbacks = createCallbacks();
    const coordinator = createOrchestratorCoordinator(context);
    const flush = vi.fn();
    coordinator.setFollowUpReplyFlusher(flush);
    const runtimeCallbacks = coordinator.createRuntimeCallbacks(
      "run-1",
      callbacks,
    );

    runtimeCallbacks.onInterrupted?.({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      userMessageId: "message-1",
      reason: "Canceled",
    });

    expect(flush).toHaveBeenCalledExactlyOnceWith("conversation-1");
  });

  it("does not flush follow-up replies for non-fatal errors", () => {
    const { context } = createContext();
    const callbacks = createCallbacks();
    const coordinator = createOrchestratorCoordinator(context);
    const flush = vi.fn();
    coordinator.setFollowUpReplyFlusher(flush);
    const runtimeCallbacks = coordinator.createRuntimeCallbacks(
      "run-1",
      callbacks,
    );

    runtimeCallbacks.onError({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      error: "transient",
      fatal: false,
    });

    expect(flush).not.toHaveBeenCalled();
  });

  it("discards the follow-up recovery buffer when a run completes cleanly", () => {
    const { context } = createContext();
    const callbacks = createCallbacks();
    const coordinator = createOrchestratorCoordinator(context);
    const flush = vi.fn();
    coordinator.setFollowUpReplyFlusher(flush);
    context.state.pendingFollowUpReplies.set("conversation-1", [
      { text: "are you there?" },
    ]);
    const runtimeCallbacks = coordinator.createRuntimeCallbacks(
      "run-1",
      callbacks,
    );

    runtimeCallbacks.onEnd({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      finalText: "done",
      timestamp: Date.now(),
    });

    expect(flush).not.toHaveBeenCalled();
    expect(context.state.pendingFollowUpReplies.has("conversation-1")).toBe(
      false,
    );
  });

  it("still drains queued orchestrator turns after terminal cleanup", async () => {
    const { context } = createContext();
    const callbacks = createCallbacks();
    const queuedTurn = vi.fn(async () => {});
    const coordinator = createOrchestratorCoordinator(context);
    const runtimeCallbacks = coordinator.createRuntimeCallbacks(
      "run-1",
      callbacks,
    );
    context.state.queuedOrchestratorTurns.push({
      priority: "user",
      execute: queuedTurn,
    });

    runtimeCallbacks.onEnd({
      runId: "run-1",
      agentType: "orchestrator",
      seq: 1,
      finalText: "done",
      timestamp: Date.now(),
    });
    await waitForQueuedMicrotasks();

    expect(queuedTurn).toHaveBeenCalledOnce();
  });
});
