import { useEffect, type MutableRefObject } from "react";
import { useConvexAuth } from "convex/react";

type SelfModAppliedData = {
  featureId: string;
  files: string[];
  batchIndex: number;
};

type AgentStreamEvent = {
  type: "stream" | "tool-start" | "tool-end" | "error" | "end";
  runId: string;
  seq: number;
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: SelfModAppliedData;
};

interface UseResumeAgentRunOptions {
  activeConversationId: string | null;
  isStreaming: boolean;
  streamRunIdRef: MutableRefObject<number>;
  localRunIdRef: MutableRefObject<string | null>;
  localSeqRef: MutableRefObject<number>;
  agentStreamCleanupRef: MutableRefObject<(() => void) | null>;
  resetStreamingText: () => void;
  resetReasoningText: () => void;
  resetStreamingState: (runId: number) => void;
  setIsStreaming: (v: boolean) => void;
  setPendingUserMessageId: (v: string | null) => void;
  handleAgentEvent: (event: AgentStreamEvent, runId: number) => void;
}

/**
 * Resumes an in-progress local agent run on mount / dependency change.
 * Gates on Convex auth so no IPC calls fire before the runner is ready.
 */
export function useResumeAgentRun({
  activeConversationId,
  isStreaming,
  streamRunIdRef,
  localRunIdRef,
  localSeqRef,
  agentStreamCleanupRef,
  resetStreamingText,
  resetReasoningText,
  resetStreamingState,
  setIsStreaming,
  setPendingUserMessageId,
  handleAgentEvent,
}: UseResumeAgentRunOptions) {
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    if (!isAuthenticated || isStreaming || !activeConversationId || !window.electronAPI) {
      return;
    }
    if (
      !window.electronAPI.agentHealthCheck ||
      !window.electronAPI.getActiveAgentRun ||
      !window.electronAPI.resumeAgentStream
    ) {
      return;
    }

    let cancelled = false;
    const runIdCounter = streamRunIdRef.current + 1;

    void (async () => {
      const health = await window.electronAPI!.agentHealthCheck();
      if (!health?.ready || cancelled) return;

      const activeRun = await window.electronAPI!.getActiveAgentRun();
      if (!activeRun || cancelled) return;
      if (activeRun.conversationId !== activeConversationId) return;

      streamRunIdRef.current = runIdCounter;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(true);
      setPendingUserMessageId(null);
      localRunIdRef.current = activeRun.runId;
      localSeqRef.current = 0;

      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current();
      }

      const cleanup = window.electronAPI!.onAgentStream((event) => {
        handleAgentEvent(event as AgentStreamEvent, runIdCounter);
      });
      agentStreamCleanupRef.current = cleanup;

      const replay = await window.electronAPI!.resumeAgentStream({
        runId: activeRun.runId,
        lastSeq: 0,
      });
      if (cancelled || runIdCounter !== streamRunIdRef.current) return;
      for (const replayEvent of replay.events) {
        handleAgentEvent(replayEvent as AgentStreamEvent, runIdCounter);
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
    isAuthenticated,
    activeConversationId,
    handleAgentEvent,
    isStreaming,
    resetReasoningText,
    resetStreamingState,
    resetStreamingText,
    setIsStreaming,
    setPendingUserMessageId,
  ]);
}
