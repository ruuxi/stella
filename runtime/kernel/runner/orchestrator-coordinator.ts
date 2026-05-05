import type { RuntimeRunCallbacks } from "../agent-runtime.js";
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
    context.state.activeOrchestratorUiVisibility = "visible";
    context.state.activeOrchestratorSession = null;
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
    if (!context.state.activeOrchestratorRunId) {
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
    }
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

  const createRuntimeCallbacks = (
    runId: string,
    callbacks: AgentCallbacks,
    options?: {
      onCleanup?: () => void;
    },
  ): RuntimeRunCallbacks => ({
    onUserMessage: callbacks.onUserMessage,
    onStream: callbacks.onStream,
    onStatus: callbacks.onStatus,
    onToolStart: (event) => {
      callbacks.onToolStart(event);
    },
    onToolEnd: (event) => {
      callbacks.onToolEnd(event);
    },
    onError: (event) => {
      callbacks.onError(event);
      if (event.fatal) {
        cleanupRun(runId, options?.onCleanup);
      }
    },
    onInterrupted: (event) => {
      cleanupRun(runId, options?.onCleanup);
      callbacks.onInterrupted?.({
        runId,
        agentType: event.agentType,
        userMessageId: event.userMessageId,
        uiVisibility: event.uiVisibility,
        reason: event.reason,
      });
    },
    onEnd: (event) => {
      cleanupRun(runId, options?.onCleanup);
      callbacks.onEnd(event);
    },
  });

  return {
    drainQueuedOrchestratorTurns,
    queueOrchestratorTurn,
    createRuntimeCallbacks,
    cleanupRun,
    clearActiveOrchestratorRun,
  };
};
