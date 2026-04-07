import type { RuntimeRunCallbacks } from "../agent-runtime.js";
import { QUEUED_TURN_INTERRUPT_ERROR } from "./shared.js";
import type {
  AgentCallbacks,
  QueuedOrchestratorTurn,
  RunnerContext,
} from "./types.js";

export const createOrchestratorCoordinator = (context: RunnerContext) => {
  const clearActiveOrchestratorRun = (runId: string) => {
    if (context.state.activeOrchestratorRunId !== runId) {
      return;
    }
    context.state.activeOrchestratorRunId = null;
    context.state.activeOrchestratorConversationId = null;
    context.state.activeToolExecutionCount = 0;
    context.state.interruptAfterTool = false;
    context.state.activeInterruptedReplayTurn = null;
  };

  const abortActiveOrchestratorRunForQueuedTurn = () => {
    if (!context.state.activeOrchestratorRunId) {
      return false;
    }
    const runId = context.state.activeOrchestratorRunId;
    const abortController =
      context.state.activeRunAbortControllers.get(runId) ?? null;
    if (!abortController || context.state.interruptedRunIds.has(runId)) {
      return false;
    }
    context.state.interruptedRunIds.add(runId);
    abortController.abort(new Error(QUEUED_TURN_INTERRUPT_ERROR));
    return true;
  };

  const requestActiveOrchestratorCheckpoint = () => {
    if (!context.state.activeOrchestratorRunId) {
      return false;
    }
    if (context.state.activeToolExecutionCount > 0) {
      context.state.interruptAfterTool = true;
      return true;
    }
    context.state.interruptAfterTool = false;
    return abortActiveOrchestratorRunForQueuedTurn();
  };

  const maybeInterruptAfterToolCheckpoint = () => {
    if (
      !context.state.interruptAfterTool ||
      context.state.activeToolExecutionCount > 0
    ) {
      return;
    }
    context.state.interruptAfterTool = false;
    abortActiveOrchestratorRunForQueuedTurn();
  };

  const drainQueuedOrchestratorTurns = async (): Promise<void> => {
    if (context.state.activeOrchestratorRunId) {
      return;
    }

    while (
      !context.state.activeOrchestratorRunId &&
      context.state.queuedOrchestratorTurns.length > 0
    ) {
      const nextTurn = context.state.queuedOrchestratorTurns.shift();
      if (!nextTurn) {
        return;
      }
      try {
        await nextTurn.execute();
      } catch {
        // Individual queued turn handlers notify callers.
      }
    }
  };

  const queueOrchestratorTurn = (turn: QueuedOrchestratorTurn) => {
    if (turn.priority === "user") {
      const firstSystemIndex = context.state.queuedOrchestratorTurns.findIndex(
        (entry) => entry.priority !== "user",
      );
      if (firstSystemIndex === -1) {
        context.state.queuedOrchestratorTurns.push(turn);
      } else {
        context.state.queuedOrchestratorTurns.splice(firstSystemIndex, 0, turn);
      }
    } else {
      context.state.queuedOrchestratorTurns.push(turn);
    }
    if (context.state.activeOrchestratorRunId) {
      requestActiveOrchestratorCheckpoint();
      return;
    }
    queueMicrotask(() => {
      void drainQueuedOrchestratorTurns();
    });
  };

  const cleanupRun = (
    runId: string,
    onCleanup?: () => void,
  ) => {
    context.state.activeRunAbortControllers.delete(runId);
    clearActiveOrchestratorRun(runId);
    onCleanup?.();
    queueMicrotask(() => {
      void drainQueuedOrchestratorTurns();
    });
  };

  const finishInterruptedRun = (args: {
    runId: string;
    onInterrupted?: () => void;
    onCleanup?: () => void;
  }): boolean => {
    if (context.state.interruptedRunIds.delete(args.runId)) {
      cleanupRun(args.runId, args.onCleanup);
      args.onInterrupted?.();
      return true;
    }
    return false;
  };

  const createRuntimeCallbacks = (
    runId: string,
    callbacks: AgentCallbacks,
    options?: {
      onInterrupted?: () => void;
      onCleanup?: () => void;
    },
  ): RuntimeRunCallbacks => ({
    onUserMessage: callbacks.onUserMessage,
    onStream: callbacks.onStream,
    onToolStart: (event) => {
      context.state.activeToolExecutionCount += 1;
      callbacks.onToolStart(event);
    },
    onToolEnd: (event) => {
      context.state.activeToolExecutionCount = Math.max(
        0,
        context.state.activeToolExecutionCount - 1,
      );
      callbacks.onToolEnd(event);
      if (context.state.activeOrchestratorRunId === runId) {
        maybeInterruptAfterToolCheckpoint();
      }
    },
    onError: (event) => {
      if (
        finishInterruptedRun({
          runId,
          onInterrupted: options?.onInterrupted,
          onCleanup: options?.onCleanup,
        })
      ) {
        return;
      }
      callbacks.onError(event);
      if (event.fatal) {
        cleanupRun(runId, options?.onCleanup);
      }
    },
    onEnd: (event) => {
      if (
        finishInterruptedRun({
          runId,
          onInterrupted: options?.onInterrupted,
          onCleanup: options?.onCleanup,
        })
      ) {
        return;
      }
      cleanupRun(runId, options?.onCleanup);
      callbacks.onEnd(event);
    },
  });

  return {
    abortActiveOrchestratorRunForQueuedTurn,
    requestActiveOrchestratorCheckpoint,
    maybeInterruptAfterToolCheckpoint,
    drainQueuedOrchestratorTurns,
    queueOrchestratorTurn,
    createRuntimeCallbacks,
    cleanupRun,
    clearActiveOrchestratorRun,
    finishInterruptedRun,
  };
};
