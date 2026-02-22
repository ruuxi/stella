import { useCallback, useEffect, useRef, useState } from "react";
import { useRafStringAccumulator } from "../../hooks/use-raf-state";
import { useAction, useMutation } from "convex/react";
import { useUiState } from "../../app/state/ui-state";
import { api } from "../../convex/api";
import {
  useConversationEvents,
  type EventRecord,
} from "../../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../../services/device";
import { streamChat } from "../../services/model-gateway";
import type { ChatContext } from "../../types/electron";

export type AttachmentRef = { id?: string; url?: string; mimeType?: string };

type AppendEventArgs = {
  conversationId: string;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: unknown;
};

type AppendedEventResponse = { _id?: string; id?: string };

type AttachmentResponse = {
  _id?: string;
  storageKey?: string;
  url?: string | null;
  mimeType?: string;
  size?: number;
};

const toEventId = (event: AppendedEventResponse | null | undefined): string | null => {
  if (!event) return null;
  if (typeof event._id === "string" && event._id.length > 0) return event._id;
  if (typeof event.id === "string" && event.id.length > 0) return event.id;
  return null;
};

export function useMiniChat(opts: {
  chatContext: ChatContext | null;
  selectedText: string | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  isStreaming: boolean;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { chatContext, selectedText, setChatContext, setSelectedText, isStreaming, setIsStreaming } =
    opts;
  const { state } = useUiState();
  const activeConversationId = state.conversationId;
  const [message, setMessage] = useState("");
  const [streamingText, appendStreamingDelta, resetStreamingText] =
    useRafStringAccumulator();
  const [reasoningText, appendReasoningDelta, resetReasoningText] =
    useRafStringAccumulator();
  const [pendingUserMessageId, setPendingUserMessageId] = useState<
    string | null
  >(null);
  const [expanded, setExpanded] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef(0);

  const appendEvent = useMutation(
    api.events.appendEvent,
  ).withOptimisticUpdate((localStore, args) => {
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
  });

  const createAttachmentAction = useAction(api.data.attachments.createFromDataUrl);
  const events = useConversationEvents(activeConversationId ?? undefined);

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
    }): Promise<AttachmentResponse | null> => {
      const attachment = await createAttachmentAction({
        conversationId: args.conversationId as never,
        deviceId: args.deviceId,
        dataUrl: args.dataUrl,
      });
      return attachment as AttachmentResponse | null;
    },
    [createAttachmentAction],
  );

  const resetStreamingState = useCallback(
    (runId?: number) => {
      if (typeof runId === "number" && runId !== streamRunIdRef.current) return;
      const scheduledForRunId = streamRunIdRef.current;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(false);
      requestAnimationFrame(() => {
        if (scheduledForRunId !== streamRunIdRef.current) return;
        setPendingUserMessageId(null);
      });
      streamAbortRef.current = null;
    },
    [resetStreamingText, resetReasoningText, setIsStreaming],
  );

  const cancelCurrentStream = useCallback(() => {
    if (streamAbortRef.current) streamAbortRef.current.abort();
    streamAbortRef.current = null;
  }, []);

  const startStream = useCallback(
    (args: { userMessageId: string; attachments?: AttachmentRef[] }) => {
      if (!activeConversationId) return;
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
      setIsStreaming,
      appendStreamingDelta,
      appendReasoningDelta,
    ],
  );

  const findQueuedFollowUp = useCallback((source: EventRecord[]) => {
    const responded = new Set<string>();
    for (const event of source) {
      if (event.type !== "assistant_message") continue;
      if (event.payload && typeof event.payload === "object") {
        const payload = event.payload as { userMessageId?: string };
        if (payload.userMessageId) responded.add(payload.userMessageId);
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

  // Sync streaming with assistant reply
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
    if (hasAssistantReply) resetStreamingState();
  }, [events, pendingUserMessageId, resetStreamingState]);

  // Process follow-up queue
  useEffect(() => {
    if (isStreaming || pendingUserMessageId || !activeConversationId) return;
    const queued = findQueuedFollowUp(events);
    if (!queued) return;

    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      startStream({
        userMessageId: queued.event._id,
        attachments: queued.attachments,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    events,
    findQueuedFollowUp,
    isStreaming,
    pendingUserMessageId,
    startStream,
    activeConversationId,
  ]);

  const sendMessage = async () => {
    const selectedSnippet = selectedText?.trim() ?? "";
    const windowSnippet = chatContext?.window
      ? [chatContext.window.app, chatContext.window.title]
          .filter((part) => Boolean(part && part.trim()))
          .join(" - ")
      : "";
    const rawText = message.trim();
    if (
      !activeConversationId ||
      (!rawText && !selectedSnippet && !windowSnippet)
    )
      return;
    const conversationId = activeConversationId;

    const deviceId = await getOrCreateDeviceId();
    setMessage("");

    const followUpMatch = rawText.match(/^\/(followup|queue)\s+/i);
    const cleanedText = followUpMatch
      ? rawText.slice(followUpMatch[0].length).trim()
      : rawText;
    const contextParts: string[] = [];
    if (windowSnippet) contextParts.push(`<active-window context="The user's currently focused window. May or may not be relevant to their request.">${windowSnippet}</active-window>`);
    if (selectedSnippet) contextParts.push(`"${selectedSnippet}"`);
    if (cleanedText) contextParts.push(cleanedText);
    const combinedText = contextParts.join("\n\n");
    if (!combinedText) return;

    const attachments: AttachmentRef[] = [];

    if (chatContext?.regionScreenshots?.length) {
      const uploadedAttachments: Array<AttachmentRef | null> =
        await Promise.all(
          chatContext.regionScreenshots.map(async (screenshot) => {
            try {
              const attachment = await createAttachment({
                conversationId,
                deviceId,
                dataUrl: screenshot.dataUrl,
              });
              const attachmentId = attachment?._id ?? attachment?.storageKey;
              if (!attachmentId) return null;
              const attachmentUrl = attachment?.url ?? undefined;
              const attachmentMimeType = attachment?.mimeType;
              return {
                id: attachmentId,
                url: attachmentUrl,
                mimeType: attachmentMimeType,
              };
            } catch (error) {
              console.error("Screenshot upload failed", error);
              return null;
            }
          }),
        );

      for (const attachment of uploadedAttachments) {
        if (attachment) attachments.push(attachment);
      }
    }

    const platform = window.electronAPI?.platform ?? "unknown";
    const mode =
      isStreaming && followUpMatch
        ? "follow_up"
        : isStreaming
          ? "steer"
          : undefined;

    if (isStreaming && mode === "steer") {
      cancelCurrentStream();
      resetStreamingState();
    }

    const event = await appendConversationEvent({
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

    const eventId = toEventId(event);
    if (eventId) {
      if (mode === "follow_up") return;
      setSelectedText(null);
      setChatContext(null);
      setExpanded(true);
      startStream({ userMessageId: eventId, attachments });
    }
  };

  return {
    message,
    setMessage,
    streamingText,
    reasoningText,
    pendingUserMessageId,
    expanded,
    setExpanded,
    events,
    sendMessage,
  };
}
