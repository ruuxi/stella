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

export type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

type UseStreamingChatOptions = {
  conversationId: string | null;
};

export function useStreamingChat({ conversationId }: UseStreamingChatOptions) {
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
  const createAttachment = useAction(api.data.attachments.createFromDataUrl);

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
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
    }
    streamAbortRef.current = null;
  }, []);

  const startStream = useCallback(
    (args: { userMessageId: string; attachments?: AttachmentRef[] }) => {
      if (!conversationId) {
        return;
      }
      const runId = streamRunIdRef.current + 1;
      streamRunIdRef.current = runId;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(true);
      setPendingUserMessageId(args.userMessageId);

      void streamChat(
        {
          conversationId,
          userMessageId: args.userMessageId,
          attachments: args.attachments ?? [],
        },
        {
          onTextDelta: (delta) => {
            if (runId !== streamRunIdRef.current) return;
            appendStreamingDelta(delta);
          },
          onReasoningDelta: (delta) => {
            if (runId !== streamRunIdRef.current) return;
            appendReasoningDelta(delta);
          },
          onDone: () => {
            if (runId !== streamRunIdRef.current) return;
            streamAbortRef.current = null;
            setIsStreaming(false);
            setQueueNext(false);
            if (streamingTextRef.current.trim().length === 0) {
              resetStreamingText();
              setPendingUserMessageId(null);
            }
          },
          onAbort: () => resetStreamingState(runId),
          onError: (error) => {
            if (runId !== streamRunIdRef.current) return;
            console.error("Model gateway error", error);
            resetStreamingState(runId);
          },
        },
        { signal: controller.signal },
      ).catch((error) => {
        if (runId !== streamRunIdRef.current) return;
        console.error("Model gateway error", error);
        resetStreamingState(runId);
      });
    },
    [
      resetStreamingState,
      conversationId,
      resetStreamingText,
      resetReasoningText,
      appendStreamingDelta,
      appendReasoningDelta,
      streamingTextRef,
      setQueueNext,
    ],
  );

  const findQueuedFollowUp = useCallback((source: EventRecord[]) => {
    const responded = new Set<string>();
    for (const event of source) {
      if (event.type !== "assistant_message") continue;
      if (event.payload && typeof event.payload === "object") {
        const payload = event.payload as { userMessageId?: string };
        if (payload.userMessageId) {
          responded.add(payload.userMessageId);
        }
      }
    }

    for (const event of source) {
      if (event.type !== "user_message") continue;
      if (!event.payload || typeof event.payload !== "object") continue;
      const payload = event.payload as {
        mode?: string;
        attachments?: AttachmentRef[];
      };
      if (payload.mode !== "follow_up") continue;
      if (responded.has(event._id)) continue;
      return { event, attachments: payload.attachments ?? [] };
    }
    return null;
  }, []);

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
      if (isStreaming || pendingUserMessageId || !conversationId) return;
      const queued = findQueuedFollowUp(events);
      if (!queued) return;
      startStream({
        userMessageId: queued.event._id,
        attachments: queued.attachments,
      });
    },
    [
      findQueuedFollowUp,
      isStreaming,
      pendingUserMessageId,
      startStream,
      conversationId,
    ],
  );

  const sendMessage = useCallback(
    async (opts: {
      text: string;
      selectedText: string | null;
      chatContext: ChatContext | null;
      onClear: () => void;
    }) => {
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
        !conversationId ||
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

      const attachments: AttachmentRef[] = [];
      if (opts.chatContext?.regionScreenshots?.length) {
        const uploadedAttachments: Array<AttachmentRef | null> =
          await Promise.all(
            opts.chatContext.regionScreenshots.map(async (screenshot) => {
              try {
                const attachment = await createAttachment({
                  conversationId,
                  deviceId,
                  dataUrl: screenshot.dataUrl,
                });
                if (!attachment?._id) {
                  return null;
                }
                return {
                  id: attachment._id as string,
                  url: attachment.url,
                  mimeType: attachment.mimeType,
                };
              } catch (error) {
                console.error("Screenshot upload failed", error);
                return null;
              }
            }),
          );

        for (const attachment of uploadedAttachments) {
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }

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

      const event = await appendEvent({
        conversationId,
        type: "user_message",
        deviceId,
        payload: {
          text: combinedText,
          attachments,
          platform,
          ...(mode && { mode }),
        },
      });

      if (event?._id) {
        if (mode === "follow_up") {
          setQueueNext(false);
          return;
        }
        setQueueNext(false);
        opts.onClear();
        startStream({ userMessageId: event._id, attachments });
      }
    },
    [
      conversationId,
      isStreaming,
      queueNext,
      cancelCurrentStream,
      resetStreamingState,
      appendEvent,
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
