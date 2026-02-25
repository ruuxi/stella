/**
 * Custom hook: streaming state machine, SSE connection, tool/task tracking, abort.
 */

import { useCallback, useRef, useState } from "react";
import { useRafStringAccumulator } from "../../hooks/use-raf-state";
import { useMutation, useAction } from "convex/react";
import { api } from "../../convex/api";
import { streamChat } from "../../services/model-gateway";
import { getOrCreateDeviceId } from "../../services/device";
import type { EventRecord } from "../../hooks/use-conversation-events";
import type { ChatContext } from "../../types/electron";
import {
  findQueuedFollowUp,
  toEventId,
  type AppendedEventResponse,
} from "./streaming/streaming-event-utils";
import {
  uploadScreenshotAttachments,
  type AttachmentUploadResponse,
} from "./streaming/attachment-upload";

export type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

type UseStreamingChatOptions = {
  conversationId: string | null;
};

type AppendEventArgs = {
  conversationId: string;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: unknown;
};

export function useStreamingChat({ conversationId }: UseStreamingChatOptions) {
  const activeConversationId = conversationId;
  const [streamingText, appendStreamingDelta, resetStreamingText, streamingTextRef] = useRafStringAccumulator();
  const [reasoningText, appendReasoningDelta, resetReasoningText] = useRafStringAccumulator();
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef(0);
  const [queueNext, setQueueNext] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(null);

  const appendEvent = useMutation(api.events.appendEvent).withOptimisticUpdate(
    (localStore, args) => {
      if (args.type !== "user_message") return;

      const queryArgs = {
        conversationId: args.conversationId,
        paginationOpts: { cursor: null, numItems: 200 },
      };
      const current = localStore.getQuery(api.events.listEvents, queryArgs);
      if (!current?.page) return;

      const optimisticEvent = {
        _id: `optimistic-${crypto.randomUUID()}`,
        timestamp: (current.page[0]?.timestamp ?? 0) + 1,
        type: args.type,
        deviceId: args.deviceId,
        payload: args.payload,
      };

      localStore.setQuery(api.events.listEvents, queryArgs, {
        ...current,
        page: [optimisticEvent, ...current.page],
      });
    },
  );
  const createAttachmentAction = useAction(api.data.attachments.createFromDataUrl);

  const appendConversationEvent = useCallback(
    async (args: AppendEventArgs): Promise<AppendedEventResponse | null> => {
      const event = await appendEvent({
        conversationId: args.conversationId as never,
        type: args.type,
        deviceId: args.deviceId,
        requestId: args.requestId,
        targetDeviceId: args.targetDeviceId,
        payload: args.payload,
      });
      return event as AppendedEventResponse | null;
    },
    [appendEvent],
  );

  const createAttachment = useCallback(
    async (args: {
      conversationId: string;
      deviceId: string;
      dataUrl: string;
    }): Promise<AttachmentUploadResponse | null> => {
      const attachment = await createAttachmentAction({
        conversationId: args.conversationId as never,
        deviceId: args.deviceId,
        dataUrl: args.dataUrl,
      });
      return attachment as AttachmentUploadResponse | null;
    },
    [createAttachmentAction],
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
      setQueueNext(false);
      requestAnimationFrame(() => {
        if (scheduledForRunId !== streamRunIdRef.current) {
          return;
        }
        setPendingUserMessageId(null);
      });
      streamAbortRef.current = null;
    },
    [resetStreamingText, resetReasoningText, setQueueNext],
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

  /** Start streaming via IPC (local agent runtime in Electron) */
  const startLocalStream = useCallback(
    (args: { userMessageId: string }, runIdCounter: number) => {
      if (!activeConversationId || !window.electronAPI) return;

      const cleanup = window.electronAPI.onAgentStream((event) => {
        if (runIdCounter !== streamRunIdRef.current) return;
        if (localRunIdRef.current && event.runId !== localRunIdRef.current) return;

        // Track seq for reconnect
        localSeqRef.current = Math.max(localSeqRef.current, event.seq);

        switch (event.type) {
          case "stream":
            if (event.chunk) appendStreamingDelta(event.chunk);
            break;
          case "tool-start":
            // Could be used to show tool activity indicators
            break;
          case "tool-end":
            break;
          case "error":
            if (event.fatal) {
              console.error("Local agent error:", event.error);
              resetStreamingState(runIdCounter);
            }
            break;
          case "end":
            streamAbortRef.current = null;
            setIsStreaming(false);
            setQueueNext(false);
            localRunIdRef.current = null;
            if (streamingTextRef.current.trim().length === 0) {
              resetStreamingText();
              setPendingUserMessageId(null);
            }
            break;
        }
      });

      agentStreamCleanupRef.current = cleanup;

      window.electronAPI
        .startAgentChat({
          conversationId: activeConversationId,
          userMessageId: args.userMessageId,
        })
        .then(({ runId: agentRunId }) => {
          if (runIdCounter !== streamRunIdRef.current) return;
          localRunIdRef.current = agentRunId;
          localSeqRef.current = 0;
        })
        .catch((error) => {
          if (runIdCounter !== streamRunIdRef.current) return;
          console.error("Failed to start local agent chat:", error);
          // Fall back to HTTP stream
          startHttpStream(args, runIdCounter);
        });
    },
    [
      activeConversationId,
      appendStreamingDelta,
      resetStreamingState,
      resetStreamingText,
      streamingTextRef,
      setQueueNext,
    ],
  );

  /** Start streaming via HTTP (server-side agent loop) */
  const startHttpStream = useCallback(
    (args: { userMessageId: string; attachments?: AttachmentRef[] }, runIdCounter: number) => {
      if (!activeConversationId) return;

      const controller = new AbortController();
      streamAbortRef.current = controller;

      void streamChat(
        {
          conversationId: activeConversationId,
          userMessageId: args.userMessageId,
          attachments: args.attachments ?? [],
        },
        {
          onTextDelta: (delta) => {
            if (runIdCounter !== streamRunIdRef.current) return;
            appendStreamingDelta(delta);
          },
          onReasoningDelta: (delta) => {
            if (runIdCounter !== streamRunIdRef.current) return;
            appendReasoningDelta(delta);
          },
          onDone: () => {
            if (runIdCounter !== streamRunIdRef.current) return;
            streamAbortRef.current = null;
            setIsStreaming(false);
            setQueueNext(false);
            if (streamingTextRef.current.trim().length === 0) {
              resetStreamingText();
              setPendingUserMessageId(null);
            }
          },
          onAbort: () => resetStreamingState(runIdCounter),
          onError: (error) => {
            if (runIdCounter !== streamRunIdRef.current) return;
            console.error("Model gateway error", error);
            resetStreamingState(runIdCounter);
          },
        },
        { signal: controller.signal },
      ).catch((error) => {
        if (runIdCounter !== streamRunIdRef.current) return;
        console.error("Model gateway error", error);
        resetStreamingState(runIdCounter);
      });
    },
    [
      activeConversationId,
      resetStreamingState,
      resetStreamingText,
      appendStreamingDelta,
      appendReasoningDelta,
      streamingTextRef,
      setQueueNext,
    ],
  );

  const startStream = useCallback(
    (args: { userMessageId: string; attachments?: AttachmentRef[] }) => {
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

      // Dual-path: try local agent runtime first, fall back to HTTP
      if (window.electronAPI?.agentHealthCheck) {
        void window.electronAPI.agentHealthCheck().then((health) => {
          if (runId !== streamRunIdRef.current) return;
          if (health?.ready) {
            startLocalStream(args, runId);
          } else {
            const controller = new AbortController();
            streamAbortRef.current = controller;
            startHttpStream(args, runId);
          }
        }).catch(() => {
          if (runId !== streamRunIdRef.current) return;
          const controller = new AbortController();
          streamAbortRef.current = controller;
          startHttpStream(args, runId);
        });
      } else {
        const controller = new AbortController();
        streamAbortRef.current = controller;
        startHttpStream(args, runId);
      }
    },
    [
      resetStreamingState,
      activeConversationId,
      resetStreamingText,
      resetReasoningText,
      streamingTextRef,
      setQueueNext,
      startLocalStream,
      startHttpStream,
    ],
  );

  // Auto-clear streaming when assistant reply arrives
  const syncWithEvents = useCallback(
    (events: EventRecord[]) => {
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
    },
    [pendingUserMessageId, resetStreamingState],
  );

  // Auto-start queued follow-ups
  const processFollowUpQueue = useCallback(
    (events: EventRecord[]) => {
      if (isStreaming || pendingUserMessageId || !activeConversationId) return;
      const queued = findQueuedFollowUp<AttachmentRef>(events);
      if (!queued) return;
      startStream({
        userMessageId: queued.event._id,
        attachments: queued.attachments,
      });
    },
    [isStreaming, pendingUserMessageId, startStream, activeConversationId],
  );

  const sendMessage = useCallback(
    async (opts: {
      text: string;
      selectedText: string | null;
      chatContext: ChatContext | null;
      onClear: () => void;
    }) => {
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

      const followUpMatch = rawText.match(/^\/(followup|queue)\s+/i);
      const cleanedText = followUpMatch
        ? rawText.slice(followUpMatch[0].length).trim()
        : rawText;

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

      const attachments: AttachmentRef[] = await uploadScreenshotAttachments({
        screenshots: opts.chatContext?.regionScreenshots,
        conversationId: resolvedConversationId,
        deviceId,
        createAttachment,
      });

      const platform = window.electronAPI?.platform ?? "unknown";
      const shouldQueue =
        isStreaming && (queueNext || Boolean(followUpMatch));
      const mode = shouldQueue
        ? "follow_up"
        : isStreaming
          ? "steer"
          : undefined;

      if (isStreaming && mode === "steer") {
        cancelCurrentStream();
        resetStreamingState();
      }

      const event = await appendConversationEvent({
        conversationId: resolvedConversationId,
        type: "user_message",
        deviceId,
        payload: {
          text: combinedText,
          attachments,
          platform,
          ...(mode && { mode }),
        },
      });

      const eventId = toEventId(event);
      if (eventId) {
        if (mode === "follow_up") {
          setQueueNext(false);
          return;
        }
        setQueueNext(false);
        opts.onClear();
        startStream({ userMessageId: eventId, attachments });
      }
    },
    [
      activeConversationId,
      isStreaming,
      queueNext,
      cancelCurrentStream,
      resetStreamingState,
      appendConversationEvent,
      createAttachment,
      startStream,
    ],
  );

  return {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    queueNext,
    setQueueNext,
    sendMessage,
    syncWithEvents,
    processFollowUpQueue,
    cancelCurrentStream,
    resetStreamingState,
  };
}
