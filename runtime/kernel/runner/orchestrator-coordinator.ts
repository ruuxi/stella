import type { RuntimeRunCallbacks } from "../agent-runtime.js";
import type {
  AgentCallbacks,
  QueuedOrchestratorTurn,
  RunnerContext,
} from "./types.js";

export const createOrchestratorCoordinator = (context: RunnerContext) => {
  /**
   * Fires a fresh reply turn for user chat messages that were injected into a
   * run as follow-ups but never answered (the run was interrupted or failed
   * before draining its follow-up queue). Set by `orchestrator.ts` once the
   * turn launcher is defined. A no-op until then.
   */
  let flushPendingFollowUpReplies: ((conversationId: string) => void) | null =
    null;

  const clearActiveSessionQueues = (runId: string) => {
    const activeSession = context.state.activeOrchestratorSession;
    if (
      context.state.activeOrchestratorRunId !== runId ||
      activeSession?.runId !== runId
    ) {
      return;
    }
    activeSession.agent.clearAllQueues();
  };

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
  ): RuntimeRunCallbacks => {
    // Captured at callback-creation time (after `prepareOrchestratorRun` sets
    // it), so it survives the `cleanupRun` that clears the active-run state
    // before terminal callbacks run.
    const conversationId = context.state.activeOrchestratorConversationId;
    return {
      onRunStarted: callbacks.onRunStarted,
      onUserMessage: callbacks.onUserMessage,
      onAssistantMessage: callbacks.onAssistantMessage,
      onStream: callbacks.onStream,
      onStatus: callbacks.onStatus,
      onToolStart: callbacks.onToolStart,
      onToolEnd: callbacks.onToolEnd,
      onError: (event) => {
        callbacks.onError(event);
        if (event.fatal) {
          clearActiveSessionQueues(runId);
          cleanupRun(runId, options?.onCleanup);
          // The follow-up queue was discarded with the run before it could be
          // delivered — answer those messages in a fresh turn instead.
          if (conversationId) flushPendingFollowUpReplies?.(conversationId);
        }
      },
      onInterrupted: (event) => {
        clearActiveSessionQueues(runId);
        cleanupRun(runId, options?.onCleanup);
        callbacks.onInterrupted?.({
          runId,
          agentType: event.agentType,
          userMessageId: event.userMessageId,
          uiVisibility: event.uiVisibility,
          reason: event.reason,
        });
        if (conversationId) flushPendingFollowUpReplies?.(conversationId);
      },
      onEnd: (event) => {
        cleanupRun(runId, options?.onCleanup);
        // A clean end means the agent loop drained and answered any queued
        // follow-ups before `agent_end`, so drop the recovery buffer.
        if (conversationId) {
          context.state.pendingFollowUpReplies.delete(conversationId);
        }
        callbacks.onEnd(event);
      },
    };
  };

  return {
    drainQueuedOrchestratorTurns,
    queueOrchestratorTurn,
    createRuntimeCallbacks,
    cleanupRun,
    clearActiveOrchestratorRun,
    setFollowUpReplyFlusher: (
      flusher: (conversationId: string) => void,
    ): void => {
      flushPendingFollowUpReplies = flusher;
    },
  };
};
