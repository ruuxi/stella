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
  const { state, setConversationId } = useUiState();
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

  const createAttachment = useAction(api.data.attachments.createFromDataUrl);
  const getOrCreateDefaultConversation = useMutation(
    api.conversations.getOrCreateDefaultConversation,
  );
  const events = useConversationEvents(state.conversationId ?? undefined);

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
      if (!state.conversationId) return;
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
          conversationId: state.conversationId,
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
      state.conversationId,
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

  // Ensure mini chat binds to the default conversation instead of creating a
  // fresh non-default thread during startup races.
  useEffect(() => {
    if (!state.conversationId) {
      void getOrCreateDefaultConversation({}).then(
        (conversation: { _id?: string } | null) => {
          if (conversation?._id) setConversationId(conversation._id);
        },
      );
    }
  }, [state.conversationId, getOrCreateDefaultConversation, setConversationId]);

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
    if (isStreaming || pendingUserMessageId || !state.conversationId) return;
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
    state.conversationId,
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
      !state.conversationId ||
      (!rawText && !selectedSnippet && !windowSnippet)
    )
      return;

    const deviceId = await getOrCreateDeviceId();
    setMessage("");

    const followUpMatch = rawText.match(/^\/(followup|queue)\s+/i);
    const cleanedText = followUpMatch
      ? rawText.slice(followUpMatch[0].length).trim()
      : rawText;
    const contextParts: string[] = [];
    if (windowSnippet) contextParts.push(`[Window] ${windowSnippet}`);
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
                conversationId: state.conversationId,
                deviceId,
                dataUrl: screenshot.dataUrl,
              });
              if (!attachment?._id) return null;
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

    const event = await appendEvent({
      conversationId: state.conversationId,
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
      if (mode === "follow_up") return;
      setSelectedText(null);
      setChatContext(null);
      setExpanded(true);
      startStream({ userMessageId: event._id, attachments });
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
