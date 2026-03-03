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
import { getEventText } from "../lib/event-transforms";
import type { AgentHealth, ChatContext } from "../types/electron";
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

const toErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "";
};

const isOrchestratorBusyError = (error: unknown): boolean => {
  return toErrorMessage(error).toLowerCase().includes("orchestrator is already running");
};

const getAgentHealthReason = (health: AgentHealth | null | undefined): string | null => {
  if (!health || health.ready) return null;
  if (typeof health.reason === "string" && health.reason.trim()) {
    return health.reason.trim();
  }
  return null;
};

const isTokenReadinessIssue = (reason: string | null): boolean => {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return normalized.includes("token") || normalized.includes("auth");
};

const resolveAgentNotReadyToast = (
  reason: string | null,
): { title: string; description?: string } => {
  if (!reason) {
    return { title: "Stella is still starting up", description: "Please try again in a moment." };
  }
  if (isTokenReadinessIssue(reason)) {
    return { title: "Sign-in is still syncing", description: "Please wait a few seconds and try again." };
  }
  if (reason.toLowerCase().includes("proxy url")) {
    return { title: "Stella setup is incomplete", description: "Please restart Stella and try again." };
  }
  return { title: "Stella is still starting up", description: "Please try again in a moment." };
};

const trySyncHostToken = async (): Promise<boolean> => {
  if (!window.electronAPI?.system.setAuthState) return false;
  try {
    const { getConvexToken } = await import("../services/auth-token");
    const token = await getConvexToken();
    if (!token) return false;
    await window.electronAPI.system.setAuthState({ authenticated: true, token });
    return true;
  } catch (error) {
    return false;
  }
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
  } = useChatStore();

  const [streamingText, appendStreamingDelta, resetStreamingText, streamingTextRef] = useRafStringAccumulator();
  const [reasoningText, , resetReasoningText] = useRafStringAccumulator();
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
    if (localRunIdRef.current && window.electronAPI?.agent.cancelChat) {
      window.electronAPI.agent.cancelChat(localRunIdRef.current);
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
        userPrompt: string;
        attachments?: AttachmentRef[];
      },
      runIdCounter: number,
    ) => {
      if (!activeConversationId || !window.electronAPI) return;

      const cleanup = window.electronAPI.agent.onStream((event) => {
        handleAgentEvent(event, runIdCounter, {
          userMessageId: args.userMessageId,
        });
      });

      agentStreamCleanupRef.current = cleanup;

      window.electronAPI.agent
        .startChat({
          conversationId: activeConversationId,
          userMessageId: args.userMessageId,
          userPrompt: args.userPrompt,
          storageMode,
        })
        .then(({ runId: agentRunId }) => {
          if (runIdCounter !== streamRunIdRef.current) return;
          localRunIdRef.current = agentRunId;
          localSeqRef.current = 0;
        })
        .catch((error) => {
          if (runIdCounter !== streamRunIdRef.current) return;
          console.error("Failed to start local agent chat:", (error as Error).message);
          if (isOrchestratorBusyError(error)) {
            showToast({
              title: "Stella is finishing your previous request",
              description: "Try sending your next message in a moment.",
              variant: "loading",
            });
            resetStreamingState(runIdCounter);
            return;
          }
          const message = toErrorMessage(error);
          showToast({
            title: "Stella couldn't start this reply",
            description: message || "Please try again.",
            variant: "error",
          });
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
      userPrompt: string;
      attachments?: AttachmentRef[];
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
      if (!window.electronAPI?.agent.healthCheck) {
        console.error("[chat] Local agent not available (no electronAPI)");
        showToast({ title: "Stella agent is not running", variant: "error" });
        resetStreamingState(runId);
        return;
      }
      void window.electronAPI.agent.healthCheck().then(async (health) => {
        if (runId !== streamRunIdRef.current) return;

        let nextHealth = health;
        let reason = getAgentHealthReason(nextHealth);

        // Token setup can race with the first user message in anonymous mode.
        // Try one immediate token sync + recheck before failing the send.
        if (!nextHealth?.ready && isTokenReadinessIssue(reason)) {
          const synced = await trySyncHostToken();
          if (runId !== streamRunIdRef.current) return;
          if (synced && window.electronAPI?.agent.healthCheck) {
            nextHealth = await window.electronAPI.agent.healthCheck();
            if (runId !== streamRunIdRef.current) return;
            reason = getAgentHealthReason(nextHealth);
          }
        }

        if (!nextHealth?.ready) {
          console.error("[chat] Local agent health check failed:", nextHealth);
          const toast = resolveAgentNotReadyToast(reason);
          showToast({
            title: toast.title,
            description: toast.description,
            variant: "error",
          });
          resetStreamingState(runId);
          return;
        }

        startLocalStream(args, runId);
      }).catch((err) => {
        if (runId !== streamRunIdRef.current) return;
        console.error("[chat] Local agent health check error:", (err as Error).message);
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
    refs: {
      streamRunIdRef,
      localRunIdRef,
      localSeqRef,
      agentStreamCleanupRef,
    },
    actions: {
      resetStreamingText,
      resetReasoningText,
      resetStreamingState,
      setIsStreaming,
      setPendingUserMessageId,
      handleAgentEvent,
    },
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
      const userPrompt = getEventText(queued.event);
      if (!userPrompt) return;
      startStream({
        userMessageId: queued.event._id,
        userPrompt,
        attachments: queued.attachments,
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
        startStream({ userMessageId: eventId, userPrompt: combinedText, attachments });
      }
    },
    [
      activeConversationId,
      isLocalStorage,
      isStreaming,
      chatStoreAppendEvent,
      chatStoreUploadAttachments,
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
