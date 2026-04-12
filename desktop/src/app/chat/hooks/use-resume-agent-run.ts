import { useEffect, type MutableRefObject } from "react";
import type { AgentStreamEvent } from "../streaming/streaming-types";

type ActiveRunSnapshot = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
} | null;

type TaskSnapshot = {
  runId: string;
  taskId: string;
  agentType?: string;
  description?: string;
  parentTaskId?: string;
  status: "running" | "completed" | "error" | "canceled";
  statusText?: string;
  result?: string;
  error?: string;
};

export interface ResumeRefs {
  lastSeqByConversationRef: MutableRefObject<Map<string, number>>;
}

export interface ResumeActions {
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
    if (
      !window.electronAPI.agent.healthCheck
      || !window.electronAPI.agent.resumeConversationExecution
    ) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const health = await window.electronAPI!.agent.healthCheck();
      if (!health?.ready || cancelled) {
        return;
      }

      ensureAgentStreamSubscription();

      const lastSeq =
        lastSeqByConversationRef.current.get(activeConversationId) ?? 0;
      const replay = await window.electronAPI!.agent.resumeConversationExecution({
        conversationId: activeConversationId,
        lastSeq,
      });
      if (cancelled) {
        return;
      }

      applyResumeSnapshot({
        conversationId: activeConversationId,
        activeRun: replay.activeRun,
        tasks: replay.tasks,
      });

      for (const replayEvent of replay.events) {
        if (cancelled) {
          return;
        }
        handleAgentEvent(replayEvent);
      }
    })().catch((error) => {
      if (cancelled) {
        return;
      }
      console.error("Failed to resume conversation execution:", error);
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeConversationId,
    applyResumeSnapshot,
    ensureAgentStreamSubscription,
    handleAgentEvent,
    lastSeqByConversationRef,
  ]);
}
