import { useEffect, type MutableRefObject } from "react";
import type { TaskLifecycleStatus } from "../../../../../runtime/contracts/agent-runtime.js";
import type { AgentStreamEvent } from "../streaming/streaming-types";

type ActiveRunSnapshot = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
} | null;

export const shouldRetainResumedStreamingState = (args: {
  resumedRunId: string | null;
  resumedConversationId: string | null;
  replayEventCount: number;
  replayExhausted: boolean;
  currentActiveRun: Pick<NonNullable<ActiveRunSnapshot>, "runId" | "conversationId"> | null;
}): boolean => {
  if (!args.resumedRunId || !args.resumedConversationId) {
    return false;
  }
  if (args.replayEventCount > 0) {
    return true;
  }
  if (!args.replayExhausted) {
    return true;
  }
  return (
    args.currentActiveRun?.runId === args.resumedRunId &&
    args.currentActiveRun?.conversationId === args.resumedConversationId
  );
};

type TaskSnapshot = {
  runId: string;
  agentId: string;
  agentType?: string;
  description?: string;
  anchorTurnId?: string;
  parentAgentId?: string;
  status: TaskLifecycleStatus;
  statusText?: string;
  reasoningText?: string;
  result?: string;
  error?: string;
};

interface ResumeRefs {
  lastSeqByConversationRef: MutableRefObject<Map<string, number>>;
}

interface ResumeActions {
  ensureAgentStreamSubscription: () => void;
  applyResumeSnapshot: (args: {
    conversationId: string;
    activeRun: ActiveRunSnapshot;
    tasks: TaskSnapshot[];
  }) => void;
  handleAgentEvent: (event: AgentStreamEvent) => void;
}

interface UseResumeAgentRunOptions {
  activeConversationId: string | null;
  refs: ResumeRefs;
  actions: ResumeActions;
}

/**
 * Hydrates renderer state from runtime-owned execution state.
 * The renderer never infers lifecycle here — it only applies runtime snapshots/events.
 *
 * Runs once on mount per conversation, and re-runs whenever the host
 * adapter transitions back to "connected" — that's the signal that the
 * detached worker reattached after an Electron restart and may have
 * buffered new events for us in its persistent run-event log.
 */
export function useResumeAgentRun({
  activeConversationId,
  refs,
  actions,
}: UseResumeAgentRunOptions) {
  const { lastSeqByConversationRef } = refs;
  const {
    ensureAgentStreamSubscription,
    applyResumeSnapshot,
    handleAgentEvent,
  } = actions;

  useEffect(() => {
    if (!activeConversationId || !window.electronAPI) {
      return;
    }
    if (!window.electronAPI.agent.resumeConversationExecution) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let pending = false;

    const runResume = async () => {
      if (cancelled) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        ensureAgentStreamSubscription();

        // Orchestrator turns are serialized per conversation, so one
        // conversation-level cursor is enough for replay. If we ever allow
        // overlapping root runs in the same conversation, this should become
        // a per-run cursor.
        const lastSeq =
          lastSeqByConversationRef.current.get(activeConversationId) ?? 0;
        const replay = await window.electronAPI!.agent.resumeConversationExecution({
          conversationId: activeConversationId,
          lastSeq,
        });
        if (cancelled) return;

        applyResumeSnapshot({
          conversationId: activeConversationId,
          activeRun: replay.activeRun,
          tasks: replay.tasks,
        });

        for (const replayEvent of replay.events) {
          if (cancelled) return;
          handleAgentEvent(replayEvent);
        }
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to resume conversation execution:", error);
      } finally {
        inFlight = false;
        if (pending && !cancelled) {
          pending = false;
          void runResume();
        }
      }
    };

    void runResume();

    // Re-run resume whenever the runtime client reconnects after a
    // disconnect. The detached worker may have streamed events to its
    // persistent log while we were gone — `lastSeq` tells the worker
    // exactly what to replay.
    const unsubscribeAvailability =
      window.electronAPI?.agent?.onAvailability?.((snapshot) => {
        if (cancelled) return;
        if (!snapshot.connected) return;
        void runResume();
      }) ?? null;

    return () => {
      cancelled = true;
      unsubscribeAvailability?.();
    };
  }, [
    activeConversationId,
    applyResumeSnapshot,
    ensureAgentStreamSubscription,
    handleAgentEvent,
    lastSeqByConversationRef,
  ]);
}
