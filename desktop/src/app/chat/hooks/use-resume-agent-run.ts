import { useEffect, type MutableRefObject } from "react";
import type { AgentStreamEvent } from "../streaming/streaming-types";

/** Mutable refs shared with the streaming chat hook. */
export interface StreamingRefs {
  streamRunIdRef: MutableRefObject<number>;
  localRunIdRef: MutableRefObject<string | null>;
  localSeqByRunIdRef: MutableRefObject<Map<string, number>>;
  agentStreamCleanupRef: MutableRefObject<(() => void) | null>;
}

/** Callbacks / setters used to drive streaming state transitions. */
export interface StreamingActions {
  resetStreamingText: () => void;
  resetReasoningText: () => void;
  resetStreamingState: (runId: number) => void;
  setIsStreaming: (v: boolean) => void;
  setPendingUserMessageId: (v: string | null) => void;
  handleAgentEvent: (event: AgentStreamEvent, runId: number) => void;
}

interface UseResumeAgentRunOptions {
  activeConversationId: string | null;
  isStreaming: boolean;
  refs: StreamingRefs;
  actions: StreamingActions;
}

/**
 * Resumes an in-progress local agent run on mount / dependency change.
 * Gates on Convex auth so no IPC calls fire before the runner is ready.
 */
export function useResumeAgentRun({
  activeConversationId,
  isStreaming,
  refs,
  actions,
}: UseResumeAgentRunOptions) {
  const {
    streamRunIdRef,
    localRunIdRef,
    localSeqByRunIdRef,
    agentStreamCleanupRef,
  } = refs;

  const {
    resetStreamingText,
    resetReasoningText,
    resetStreamingState,
    setIsStreaming,
    setPendingUserMessageId,
    handleAgentEvent,
  } = actions;

  useEffect(() => {
    if (isStreaming || !activeConversationId || !window.electronAPI) {
      return;
    }
    if (
      !window.electronAPI.agent.healthCheck ||
      !window.electronAPI.agent.getActiveRun ||
      !window.electronAPI.agent.resumeStream
    ) {
      return;
    }

    let cancelled = false;
    const runIdCounter = streamRunIdRef.current + 1;

    void (async () => {
      const health = await window.electronAPI!.agent.healthCheck();
      if (!health?.ready || cancelled) return;

      const activeRun = await window.electronAPI!.agent.getActiveRun();
      if (!activeRun || cancelled) return;
      if (activeRun.conversationId !== activeConversationId) return;

      streamRunIdRef.current = runIdCounter;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(true);
      setPendingUserMessageId(null);
      localRunIdRef.current = activeRun.runId;
      localSeqByRunIdRef.current.clear();

      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current();
      }

      const cleanup = window.electronAPI!.agent.onStream((event) => {
        handleAgentEvent(event, runIdCounter);
      });
      agentStreamCleanupRef.current = cleanup;

      const replay = await window.electronAPI!.agent.resumeStream({
        runId: activeRun.runId,
        lastSeq: 0,
      });
      if (cancelled || runIdCounter !== streamRunIdRef.current) return;
      for (const replayEvent of replay.events) {
        handleAgentEvent(replayEvent, runIdCounter);
      }
    })().catch((error) => {
      if (cancelled) return;
      console.error("Failed to resume active local agent run:", error);
      resetStreamingState(runIdCounter);
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeConversationId,
    agentStreamCleanupRef,
    handleAgentEvent,
    isStreaming,
    localRunIdRef,
    localSeqByRunIdRef,
    resetReasoningText,
    resetStreamingState,
    resetStreamingText,
    setIsStreaming,
    setPendingUserMessageId,
    streamRunIdRef,
  ]);
}

