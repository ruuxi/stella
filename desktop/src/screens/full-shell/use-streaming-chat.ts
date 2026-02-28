/**
 * Custom hook: streaming state machine, SSE connection, tool/task tracking, abort.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { showToast } from "../../components/toast";
import {
  appendLocalEvent,
  buildLocalHistoryMessages,
  type LocalHistoryMessage,
} from "../../services/local-chat-store";

export type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

type ChatStorageMode = "cloud" | "local";

type UseStreamingChatOptions = {
  conversationId: string | null;
  storageMode?: ChatStorageMode;
};

type AppendEventArgs = {
  conversationId: string;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: unknown;
};

export type SelfModAppliedData = {
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
  storageMode = "cloud",
}: UseStreamingChatOptions) {
  const activeConversationId = conversationId;
  const isLocalStorage = storageMode === "local";
  const [streamingText, appendStreamingDelta, resetStreamingText, streamingTextRef] = useRafStringAccumulator();
  const [reasoningText, appendReasoningDelta, resetReasoningText] = useRafStringAccumulator();
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef(0);
  const [queueNext, setQueueNext] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(null);
  const [selfModMap, setSelfModMap] = useState<Record<string, SelfModAppliedData>>({});

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
          setQueueNext(false);
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
      setQueueNext,
      streamingTextRef,
    ],
  );

  /** Start streaming via IPC (local agent runtime in Electron) */
  const startLocalStream = useCallback(
    (
      args: {
        userMessageId: string;
        attachments?: AttachmentRef[];
        localHistory?: LocalHistoryMessage[];
      },
      runIdCounter: number,
      fallbackToHttp: boolean,
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
    (args: {
      userMessageId: string;
      attachments?: AttachmentRef[];
      localHistory?: LocalHistoryMessage[];
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

      // Dual-path: try local agent runtime first, fall back to HTTP
      if (isLocalStorage) {
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
          startLocalStream(args, runId, false);
        }).catch((err) => {
          if (runId !== streamRunIdRef.current) return;
          console.error("[chat] Local agent health check error:", err);
          showToast({ title: "Stella agent is not responding", variant: "error" });
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
      resetStreamingState,
      activeConversationId,
      isLocalStorage,
      resetStreamingText,
      resetReasoningText,
      streamingTextRef,
      setQueueNext,
      startLocalStream,
      startHttpStream,
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
      setQueueNext(false);
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
  ]);

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
      const localHistory = isLocalStorage
        ? buildLocalHistoryMessages(activeConversationId, 50)
        : undefined;
      startStream({
        userMessageId: queued.event._id,
        attachments: queued.attachments,
        localHistory,
      });
    },
    [
      isStreaming,
      pendingUserMessageId,
      startStream,
      activeConversationId,
      isLocalStorage,
    ],
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
      if (hasScreenshotContext && isLocalStorage) {
        contextParts.push(`[User included ${opts.chatContext?.regionScreenshots?.length ?? 0} screenshot(s).]`);
      }
      if (cleanedText) {
        contextParts.push(cleanedText);
      }
      const combinedText = contextParts.join("\n\n");

      if (!combinedText && !hasScreenshotContext) {
        return;
      }

      const attachments: AttachmentRef[] = isLocalStorage
        ? []
        : await uploadScreenshotAttachments({
            screenshots: opts.chatContext?.regionScreenshots,
            conversationId: resolvedConversationId,
            deviceId,
            createAttachment,
          });

      const platform = window.electronAPI?.platform ?? "unknown";
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
          timezone,
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
        const localHistory = isLocalStorage
          ? buildLocalHistoryMessages(resolvedConversationId, 50)
          : undefined;
        startStream({ userMessageId: eventId, attachments, localHistory });
      }
    },
    [
      activeConversationId,
      isLocalStorage,
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
    selfModMap,
    sendMessage,
    syncWithEvents,
    processFollowUpQueue,
    cancelCurrentStream,
    resetStreamingState,
  };
}
