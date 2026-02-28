import { useCallback, useEffect, useRef, useState } from "react";
import { useRafStringAccumulator } from "../../hooks/use-raf-state";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useUiState } from "../../app/state/ui-state";
import { api } from "../../convex/api";
import {
  useConversationEvents,
  type EventRecord,
} from "../../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../../services/device";
import { streamChat } from "../../services/model-gateway";
import type { ChatContext } from "../../types/electron";
import {
  appendLocalEvent,
  buildLocalHistoryMessages,
  type LocalHistoryMessage,
} from "../../services/local-chat-store";

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
  const [streamingText, appendStreamingDelta, resetStreamingText, streamingTextRef] =
    useRafStringAccumulator();
  const [reasoningText, appendReasoningDelta, resetReasoningText] =
    useRafStringAccumulator();
  const [pendingUserMessageId, setPendingUserMessageId] = useState<
    string | null
  >(null);
  const [expanded, setExpanded] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef(0);

  const { isAuthenticated } = useConvexAuth();
  const accountMode = useQuery(
    api.data.preferences.getAccountMode,
    isAuthenticated ? {} : "skip",
  ) as "private_local" | "connected" | undefined;
  const syncMode = useQuery(
    api.data.preferences.getSyncMode,
    isAuthenticated && accountMode === "connected" ? {} : "skip",
  ) as "on" | "off" | undefined;
  const storageMode =
    isAuthenticated &&
    accountMode === "connected" &&
    (syncMode ?? "on") !== "off"
      ? "cloud"
      : "local";
  const isLocalStorage = storageMode === "local";

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
  const events = useConversationEvents(activeConversationId ?? undefined, {
    source: storageMode,
  });

  const appendConversationEvent = useCallback(
    async (args: AppendEventArgs): Promise<AppendedEventResponse | null> => {
      if (isLocalStorage) {
        const localEvent = appendLocalEvent({
          conversationId: args.conversationId,
          type: args.type,
          deviceId: args.deviceId,
          requestId: args.requestId,
          targetDeviceId: args.targetDeviceId,
          payload: args.payload,
        });
        return { _id: localEvent._id };
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
    [appendEvent, isLocalStorage],
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

  const appendLocalAgentEvent = useCallback(
    (event: {
      type: "tool_request" | "tool_result" | "assistant_message";
      userMessageId?: string;
      toolCallId?: string;
      toolName?: string;
      resultPreview?: string;
      finalText?: string;
    }) => {
      if (!isLocalStorage || !activeConversationId) return;

      if (event.type === "assistant_message") {
        appendLocalEvent({
          conversationId: activeConversationId,
          type: "assistant_message",
          requestId: event.userMessageId,
          payload: {
            text: event.finalText ?? "",
            ...(event.userMessageId ? { userMessageId: event.userMessageId } : {}),
          },
        });
        return;
      }

      if (event.type === "tool_request") {
        appendLocalEvent({
          conversationId: activeConversationId,
          type: "tool_request",
          requestId: event.toolCallId,
          payload: {
            toolName: event.toolName,
          },
        });
        return;
      }

      appendLocalEvent({
        conversationId: activeConversationId,
        type: "tool_result",
        requestId: event.toolCallId,
        payload: {
          toolName: event.toolName,
          result: event.resultPreview,
        },
      });
    },
    [activeConversationId, isLocalStorage],
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

  // Track active local agent run for IPC path
  const localRunIdRef = useRef<string | null>(null);
  const localSeqRef = useRef(0);
  const agentStreamCleanupRef = useRef<(() => void) | null>(null);

  const cancelCurrentStream = useCallback(() => {
    if (streamAbortRef.current) streamAbortRef.current.abort();
    streamAbortRef.current = null;

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
            resetStreamingState(runIdCounter);
          }
          break;
        case "end":
          appendLocalAgentEvent({
            type: "assistant_message",
            userMessageId: options?.userMessageId,
            finalText: event.finalText ?? streamingTextRef.current,
          });
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
      setIsStreaming,
      streamingTextRef,
    ],
  );

  const startLocalStream = useCallback(
    (args: {
      userMessageId: string;
      attachments?: AttachmentRef[];
      localHistory?: LocalHistoryMessage[];
    }, runIdCounter: number, fallbackToHttp: boolean) => {
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
            // Do not fall back to cloud chat; only one orchestrator run is allowed.
            resetStreamingState(runIdCounter);
            return;
          }
          if (fallbackToHttp) {
            startHttpStream(args, runIdCounter);
          } else {
            resetStreamingState(runIdCounter);
          }
        });
    },
    [
      activeConversationId,
      appendStreamingDelta,
      appendLocalAgentEvent,
      handleAgentEvent,
      storageMode,
      resetStreamingState,
      resetStreamingText,
      setIsStreaming,
      streamingTextRef,
    ],
  );

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
      appendStreamingDelta,
      appendReasoningDelta,
      resetStreamingState,
    ],
  );

  const startStream = useCallback(
    (args: {
      userMessageId: string;
      attachments?: AttachmentRef[];
      localHistory?: LocalHistoryMessage[];
    }) => {
      if (!activeConversationId) return;
      const runId = streamRunIdRef.current + 1;
      streamRunIdRef.current = runId;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(true);
      setPendingUserMessageId(args.userMessageId);

      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current();
        agentStreamCleanupRef.current = null;
      }

      if (isLocalStorage) {
        if (!window.electronAPI?.agentHealthCheck) {
          resetStreamingState(runId);
          return;
        }
        void window.electronAPI.agentHealthCheck().then((health) => {
          if (runId !== streamRunIdRef.current) return;
          if (!health?.ready) {
            resetStreamingState(runId);
            return;
          }
          startLocalStream(args, runId, false);
        }).catch(() => {
          if (runId !== streamRunIdRef.current) return;
          resetStreamingState(runId);
        });
        return;
      }

      if (window.electronAPI?.agentHealthCheck) {
        void window.electronAPI.agentHealthCheck().then((health) => {
          if (runId !== streamRunIdRef.current) return;
          if (health?.ready) {
            startLocalStream(args, runId, true);
          } else {
            startHttpStream(args, runId);
          }
        }).catch(() => {
          if (runId !== streamRunIdRef.current) return;
          startHttpStream(args, runId);
        });
      } else {
        startHttpStream(args, runId);
      }
    },
    [
      activeConversationId,
      isLocalStorage,
      resetReasoningText,
      resetStreamingState,
      resetStreamingText,
      setIsStreaming,
      startHttpStream,
      startLocalStream,
    ],
  );

  useEffect(() => {
    if (isStreaming || !activeConversationId || !window.electronAPI) {
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
    activeConversationId,
    handleAgentEvent,
    isStreaming,
    resetReasoningText,
    resetStreamingState,
    resetStreamingText,
    setIsStreaming,
  ]);

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
      const localHistory = isLocalStorage
        ? buildLocalHistoryMessages(activeConversationId, 50)
        : undefined;
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
    activeConversationId,
    events,
    findQueuedFollowUp,
    isLocalStorage,
    isStreaming,
    pendingUserMessageId,
    startStream,
  ]);

  const sendMessage = async () => {
    const selectedSnippet = selectedText?.trim() ?? "";
    const windowSnippet = chatContext?.window
      ? [chatContext.window.app, chatContext.window.title]
          .filter((part) => Boolean(part && part.trim()))
          .join(" - ")
      : "";
    const rawText = message.trim();
    const hasScreenshotContext = Boolean(chatContext?.regionScreenshots?.length);
    if (
      !activeConversationId ||
      (!rawText && !selectedSnippet && !windowSnippet && !hasScreenshotContext)
    ) {
      return;
    }
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
    if (hasScreenshotContext && isLocalStorage) {
      contextParts.push(`[User included ${chatContext?.regionScreenshots?.length ?? 0} screenshot(s).]`);
    }
    if (cleanedText) contextParts.push(cleanedText);
    const combinedText = contextParts.join("\n\n");
    if (!combinedText) return;

    const attachments: AttachmentRef[] = [];

    if (!isLocalStorage && chatContext?.regionScreenshots?.length) {
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
      const localHistory = isLocalStorage
        ? buildLocalHistoryMessages(conversationId, 50)
        : undefined;
      startStream({ userMessageId: eventId, attachments, localHistory });
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
