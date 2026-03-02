/**
 * Shared streaming chat hook: streaming state machine, SSE connection,
 * tool/task tracking, abort, follow-up queue, event sync.
 *
 * Used by both full-shell and mini-shell — UI state (message, expanded,
 * chatContext, selectedText) belongs to the consumer, not this hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRafStringAccumulator } from "./use-raf-state";
import { getPlatform } from "../utils/platform";
import { getOrCreateDeviceId } from "../services/device";
import type { EventRecord } from "./use-conversation-events";
import type { ChatContext } from "../types/electron";
import {
  findQueuedFollowUp,
  toEventId,
} from "./streaming/streaming-event-utils";
import { showToast } from "../components/toast";
import { useResumeAgentRun } from "./use-resume-agent-run";
import type { AgentStreamEvent, SelfModAppliedData } from "./streaming/streaming-types";
import { useChatStore } from "../app/state/chat-store";

export type { AgentStreamEvent, SelfModAppliedData } from "./streaming/streaming-types";

export type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

export type SendMessageArgs = {
  text: string;
  selectedText: string | null;
  chatContext: ChatContext | null;
  onClear: () => void;
};

type UseStreamingChatOptions = {
  conversationId: string | null;
  events: EventRecord[];
};

const isOrchestratorBusyError = (error: unknown): boolean => {
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
  return message.toLowerCase().includes("orchestrator is already running");
};

export function useStreamingChat({
  conversationId,
  events,
}: UseStreamingChatOptions) {
  const activeConversationId = conversationId;
  const {
    isLocalStorage,
    storageMode,
    appendAgentEvent: chatStoreAppendAgentEvent,
    appendEvent: chatStoreAppendEvent,
    uploadAttachments: chatStoreUploadAttachments,
    buildHistory: chatStoreBuildHistory,
  } = useChatStore();

  const [streamingText, appendStreamingDelta, resetStreamingText, streamingTextRef] = useRafStringAccumulator();
  const [reasoningText, appendReasoningDelta, resetReasoningText] = useRafStringAccumulator();
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef(0);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(null);
  const [selfModMap, setSelfModMap] = useState<Record<string, SelfModAppliedData>>({});

  const appendLocalAgentEvent = useCallback(
    (event: {
      type: "tool_request" | "tool_result" | "assistant_message";
      userMessageId?: string;
      toolCallId?: string;
      toolName?: string;
      resultPreview?: string;
      finalText?: string;
    }) => {
      if (!activeConversationId) return;

      chatStoreAppendAgentEvent({
        conversationId: activeConversationId,
        ...event,
      });
    },
    [activeConversationId, chatStoreAppendAgentEvent],
  );

  const resetStreamingState = useCallback(
    (runId?: number) => {
      if (typeof runId === "number" && runId !== streamRunIdRef.current) {
        return;
      }
      const scheduledForRunId = streamRunIdRef.current;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(false);
      requestAnimationFrame(() => {
        if (scheduledForRunId !== streamRunIdRef.current) {
          return;
        }
        setPendingUserMessageId(null);
      });
      streamAbortRef.current = null;
    },
    [resetStreamingText, resetReasoningText],
  );

  const cancelCurrentStream = useCallback(() => {
    // Cancel HTTP stream if active
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
    }
    streamAbortRef.current = null;

    // Cancel local agent stream if active
    if (localRunIdRef.current && window.electronAPI?.cancelAgentChat) {
      window.electronAPI.cancelAgentChat(localRunIdRef.current);
      localRunIdRef.current = null;
      localSeqRef.current = 0;
    }
    if (agentStreamCleanupRef.current) {
      agentStreamCleanupRef.current();
      agentStreamCleanupRef.current = null;
    }
  }, []);

  // Track active local agent run for IPC path
  const localRunIdRef = useRef<string | null>(null);
  const localSeqRef = useRef(0);
  const agentStreamCleanupRef = useRef<(() => void) | null>(null);

  const handleAgentEvent = useCallback(
    (
      event: AgentStreamEvent,
      runIdCounter: number,
      options?: { userMessageId?: string },
    ) => {
      if (runIdCounter !== streamRunIdRef.current) return;
      if (localRunIdRef.current && event.runId !== localRunIdRef.current) return;
      if (event.seq <= localSeqRef.current) return;

      localSeqRef.current = event.seq;

      switch (event.type) {
        case "stream":
          if (event.chunk) appendStreamingDelta(event.chunk);
          break;
        case "tool-start":
          appendLocalAgentEvent({
            type: "tool_request",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
          break;
        case "tool-end":
          appendLocalAgentEvent({
            type: "tool_result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            resultPreview: event.resultPreview,
          });
          break;
        case "error":
          if (event.fatal) {
            console.error("Local agent error:", event.error);
            showToast({ title: "Something went wrong", description: event.error || undefined, variant: "error" });
            resetStreamingState(runIdCounter);
          }
          break;
        case "end":
          appendLocalAgentEvent({
            type: "assistant_message",
            userMessageId: options?.userMessageId,
            finalText: event.finalText ?? streamingTextRef.current,
          });
          if (event.selfModApplied && options?.userMessageId) {
            setSelfModMap((prev) => ({
              ...prev,
              [options.userMessageId!]: event.selfModApplied!,
            }));
          }
          streamAbortRef.current = null;
          setIsStreaming(false);
          localRunIdRef.current = null;
          localSeqRef.current = 0;
          if (agentStreamCleanupRef.current) {
            agentStreamCleanupRef.current();
            agentStreamCleanupRef.current = null;
          }
          if (streamingTextRef.current.trim().length === 0) {
            resetStreamingText();
            setPendingUserMessageId(null);
          }
          break;
      }
    },
    [
      appendLocalAgentEvent,
      appendStreamingDelta,
      resetStreamingState,
      resetStreamingText,
      streamingTextRef,
    ],
  );

  /** Start streaming via IPC (local agent runtime in Electron) */
  const startLocalStream = useCallback(
    (
      args: {
        userMessageId: string;
        attachments?: AttachmentRef[];
        localHistory?: import("../services/local-chat-store").LocalHistoryMessage[];
      },
      runIdCounter: number,
    ) => {
      if (!activeConversationId || !window.electronAPI) return;

      const cleanup = window.electronAPI.onAgentStream((event) => {
        handleAgentEvent(event as AgentStreamEvent, runIdCounter, {
          userMessageId: args.userMessageId,
        });
      });

      agentStreamCleanupRef.current = cleanup;

      window.electronAPI
        .startAgentChat({
          conversationId: activeConversationId,
          userMessageId: args.userMessageId,
          storageMode,
          localHistory: args.localHistory,
        })
        .then(({ runId: agentRunId }) => {
          if (runIdCounter !== streamRunIdRef.current) return;
          localRunIdRef.current = agentRunId;
          localSeqRef.current = 0;
        })
        .catch((error) => {
          if (runIdCounter !== streamRunIdRef.current) return;
          console.error("Failed to start local agent chat:", error);
          if (isOrchestratorBusyError(error)) {
            resetStreamingState(runIdCounter);
            return;
          }
          resetStreamingState(runIdCounter);
        });
    },
    [
      activeConversationId,
      handleAgentEvent,
      storageMode,
      resetStreamingState,
    ],
  );

  const startStream = useCallback(
    (args: {
      userMessageId: string;
      attachments?: AttachmentRef[];
      localHistory?: import("../services/local-chat-store").LocalHistoryMessage[];
    }) => {
      if (!activeConversationId) {
        return;
      }
      const runId = streamRunIdRef.current + 1;
      streamRunIdRef.current = runId;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(true);
      setPendingUserMessageId(args.userMessageId);

      // Clean up any previous local agent stream listener
      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current();
        agentStreamCleanupRef.current = null;
      }

      // Desktop is always the orchestrator — no HTTP fallback
      if (!window.electronAPI?.agentHealthCheck) {
        console.error("[chat] Local agent not available (no electronAPI)");
        showToast({ title: "Stella agent is not running", variant: "error" });
        resetStreamingState(runId);
        return;
      }
      void window.electronAPI.agentHealthCheck().then((health) => {
        if (runId !== streamRunIdRef.current) return;
        if (!health?.ready) {
          console.error("[chat] Local agent health check failed:", health);
          showToast({ title: "Stella agent is starting up — try again in a moment", variant: "error" });
          resetStreamingState(runId);
          return;
        }
        startLocalStream(args, runId);
      }).catch((err) => {
        if (runId !== streamRunIdRef.current) return;
        console.error("[chat] Local agent health check error:", err);
        showToast({ title: "Stella agent is not responding", variant: "error" });
        resetStreamingState(runId);
      });
    },
    [
      resetStreamingState,
      activeConversationId,
      resetStreamingText,
      resetReasoningText,
      startLocalStream,
    ],
  );

  useResumeAgentRun({
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
  });

  // ---- Internal effects: sync and follow-up queue ----

  // Auto-clear streaming when assistant reply arrives in events
  useEffect(() => {
    if (!pendingUserMessageId) return;
    const hasAssistantReply = events.some((event) => {
      if (event.type !== "assistant_message") return false;
      if (event.payload && typeof event.payload === "object") {
        return (
          (event.payload as { userMessageId?: string }).userMessageId ===
          pendingUserMessageId
        );
      }
      return false;
    });
    if (hasAssistantReply) {
      resetStreamingState();
    }
  }, [events, pendingUserMessageId, resetStreamingState]);

  // Auto-start queued follow-ups when idle
  useEffect(() => {
    if (isStreaming || pendingUserMessageId || !activeConversationId) return;
    const queued = findQueuedFollowUp<AttachmentRef>(events);
    if (!queued) return;

    let cancelled = false;
    // Use microtask to avoid double-fire edge case
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const localHistory = chatStoreBuildHistory(activeConversationId, 50);
      startStream({
        userMessageId: queued.event._id,
        attachments: queued.attachments,
        localHistory,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    events,
    isStreaming,
    pendingUserMessageId,
    startStream,
    activeConversationId,
    chatStoreBuildHistory,
  ]);

  const sendMessage = useCallback(
    async (opts: SendMessageArgs) => {
      const resolvedConversationId = activeConversationId;
      const selectedSnippet = opts.selectedText?.trim() ?? "";
      const windowSnippet = opts.chatContext?.window
        ? [opts.chatContext.window.app, opts.chatContext.window.title]
            .filter((part) => Boolean(part && part.trim()))
            .join(" - ")
        : "";
      const hasScreenshotContext = Boolean(
        opts.chatContext?.regionScreenshots?.length,
      );

      if (
        !resolvedConversationId ||
        (!opts.text.trim() && !selectedSnippet && !windowSnippet && !hasScreenshotContext)
      ) {
        return;
      }
      const deviceId = await getOrCreateDeviceId();
      const rawText = opts.text.trim();
      const cleanedText = rawText;

      const contextParts: string[] = [];
      if (windowSnippet) {
        contextParts.push(`<active-window context="The user's currently focused window. May or may not be relevant to their request.">${windowSnippet}</active-window>`);
      }
      if (selectedSnippet) {
        contextParts.push(`"${selectedSnippet}"`);
      }
      if (cleanedText) {
        contextParts.push(cleanedText);
      }
      const combinedText = contextParts.join("\n\n");

      if (!combinedText && !hasScreenshotContext) {
        return;
      }

      let attachments: AttachmentRef[] = [];
      if (isLocalStorage && hasScreenshotContext) {
        attachments = (opts.chatContext?.regionScreenshots ?? []).map((s) => {
          const match = s.dataUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
          return {
            url: s.dataUrl,
            mimeType: match ? match[1] : "image/png",
          };
        });
      } else {
        attachments = await chatStoreUploadAttachments({
          screenshots: opts.chatContext?.regionScreenshots,
          conversationId: resolvedConversationId,
          deviceId,
        }).then((uploaded) =>
          uploaded.map((a) => ({ id: a.id, url: a.url, mimeType: a.mimeType })),
        );
      }

      const platform = getPlatform();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const mode = isStreaming ? "follow_up" : undefined;

      const event = await chatStoreAppendEvent({
        conversationId: resolvedConversationId,
        type: "user_message",
        deviceId,
        payload: {
          text: combinedText,
          attachments,
          platform,
          timezone,
          ...(mode && { mode }),
        },
      });

      const eventId = toEventId(event);
      if (eventId) {
        if (mode === "follow_up") {
          return;
        }
        opts.onClear();
        const localHistory = chatStoreBuildHistory(resolvedConversationId, 50);
        startStream({ userMessageId: eventId, attachments, localHistory });
      }
    },
    [
      activeConversationId,
      isLocalStorage,
      isStreaming,
      chatStoreAppendEvent,
      chatStoreUploadAttachments,
      chatStoreBuildHistory,
      startStream,
    ],
  );

  return {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    sendMessage,
    cancelCurrentStream,
    resetStreamingState,
  };
}
