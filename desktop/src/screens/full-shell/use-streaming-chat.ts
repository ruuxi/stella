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
import { useIsLocalMode } from "@/providers/DataProvider";
import { localPost } from "@/services/local-client";
import { toCloudConversationId } from "@/lib/conversation-id";

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
  const isLocalMode = useIsLocalMode();
  const cloudConversationId = toCloudConversationId(conversationId);
  const activeConversationId = isLocalMode
    ? conversationId
    : cloudConversationId;
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
      if (isLocalMode) {
        const event = await localPost<AppendedEventResponse>("/api/events", args);
        return event ?? null;
      }
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
    [isLocalMode, appendEvent],
  );

  const createAttachment = useCallback(
    async (args: {
      conversationId: string;
      deviceId: string;
      dataUrl: string;
    }): Promise<AttachmentUploadResponse | null> => {
      if (isLocalMode) {
        const attachment = await localPost<AttachmentUploadResponse>(
          "/api/attachments/create",
          args,
        );
        return attachment ?? null;
      }
      const attachment = await createAttachmentAction({
        conversationId: args.conversationId as never,
        deviceId: args.deviceId,
        dataUrl: args.dataUrl,
      });
      return attachment as AttachmentUploadResponse | null;
    },
    [isLocalMode, createAttachmentAction],
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
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
    }
    streamAbortRef.current = null;
  }, []);

  const startStream = useCallback(
    (args: { userMessageId: string; attachments?: AttachmentRef[] }) => {
      if (!activeConversationId) {
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
          conversationId: activeConversationId,
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
      activeConversationId,
      resetStreamingText,
      resetReasoningText,
      appendStreamingDelta,
      appendReasoningDelta,
      streamingTextRef,
      setQueueNext,
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
