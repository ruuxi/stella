import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatColumnComposer,
  ChatColumnConversation,
  ChatColumnScroll,
} from "@/features/chat/chat-column-types";
import type { ChatContext } from "@/shared/types/electron";
import {
  attachComposerAppSelectionContext,
  deriveComposerState,
} from "@/features/chat/composer-context";
import { createNewLocalConversationId } from "@/features/chat/services/local-chat-store";
import { useConversationActivity } from "@/features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "@/features/chat/hooks/use-conversation-display-messages";
import { useConversationFiles } from "@/features/chat/hooks/use-conversation-files";
import { useConversationMessages } from "@/features/chat/hooks/use-conversation-messages";
import { useStreamingChat } from "@/features/chat/hooks/use-streaming-chat";
import {
  useTraceEventMonitor,
  useTraceIpcListener,
} from "@/platform/diagnostics/use-trace-listener";
import { type EventRecord } from "@/features/chat/lib/event-transforms";
import { useUiState } from "@/context/ui-state";
import { router } from "@/router";
import { useCapturedChatContext } from "./use-captured-chat-context";
import { useChatScrollManagement } from "./use-chat-scroll-management";
import { useChatHomeSurface } from "./use-chat-home-surface";
import { useAgentInputRouting } from "./use-agent-input-routing";
import { useStellaSendMessageBridge } from "./use-stella-send-message-bridge";

type UseFullShellChatOptions = {
  activeConversationId: string | null;
  /** True when the user is currently on the `/chat` route. */
  isOnChatRoute: boolean;
  /**
   * Explicit opt-in for trace diagnostics. NOT `import.meta.env.DEV`: Stella
   * ships as a Vite dev server so DEV is TRUE in production. Defaults OFF via
   * `isTraceDiagnosticsEnabled()` at the call site.
   */
  traceEnabled: boolean;
};

export type AnnotationSelection = NonNullable<ChatContext["appSelection"]>;

type AnnotationContextTarget = {
  id: number;
  submit: (selection: AnnotationSelection) => void;
};

type StartAnnotationOptions = {
  submit: (selection: AnnotationSelection) => void;
};

export function useFullShellChat({
  activeConversationId,
  isOnChatRoute,
  traceEnabled,
}: UseFullShellChatOptions) {
  const { setConversationId } = useUiState();
  const [message, setMessage] = useState("");
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const annotationIdRef = useRef(0);
  const annotationTargetRef = useRef<AnnotationContextTarget | null>(null);
  const [annotationTarget, setAnnotationTarget] =
    useState<AnnotationContextTarget | null>(null);
  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext();
  const restoredConversationScrollRef = useRef<string | null>(null);

  const {
    messages: persistedMessages,
    hasOlderMessages,
    isLoadingOlder: isLoadingOlderMessages,
    isInitialLoading: isInitialLoadingMessages,
    loadOlder: loadOlderMessages,
  } = useConversationMessages(activeConversationId ?? undefined);

  const {
    activities,
    latestMessageTimestampMs,
    hasOlderActivity,
    isLoadingOlder: isLoadingOlderActivity,
    loadOlder: loadOlderActivity,
  } = useConversationActivity(activeConversationId ?? undefined);

  const {
    files: persistedFiles,
    hasOlderFiles,
    isLoadingOlder: isLoadingOlderFiles,
    loadOlder: loadOlderFiles,
  } = useConversationFiles(activeConversationId ?? undefined);

  const {
    liveTasks,
    optimisticEvents,
    runtimeStatusText,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    reasoningText,
    streamingAssistants,
    isStreaming,
    isStreamingResponseText,
    pendingUserMessageId,
    queuedUserMessages,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChat({
    conversationId: activeConversationId,
    persistedMessages,
  });

  // Visible chat timeline: SQLite-backed `persistedMessages` plus the
  // synthetic overlays (optimistic users, in-memory streaming
  // assistants, scheduler-pending) that drop off as their persisted
  // counterparts land. Lives in its own hook so the overlay-
  // composition concerns stay next to each other.
  const displayMessages = useConversationDisplayMessages({
    conversationId: activeConversationId,
    persistedMessages,
    optimisticEvents,
    streamingAssistants,
  });

  useTraceIpcListener(traceEnabled);

  // Opt-in event trace consumes the union of activity + message + the
  // per-turn tool events. The hook's internal `seenIds` set keeps it
  // idempotent across re-runs, so we can rebuild the list cheaply on
  // every tick without double-firing trace entries. Gated on `traceEnabled`
  // (explicit opt-in) rather than `import.meta.env.DEV`, which is TRUE in
  // Stella's dev-server-as-production build, so the array stays empty for
  // real users.
  const traceEvents = useMemo<EventRecord[]>(() => {
    if (!traceEnabled) return [];
    const out: EventRecord[] = [];
    for (const event of activities) out.push(event);
    for (const message of persistedMessages) {
      out.push(message);
      for (const toolEvent of message.toolEvents) out.push(toolEvent);
    }
    return out;
  }, [activities, traceEnabled, persistedMessages]);
  useTraceEventMonitor(traceEnabled, traceEvents);

  const hasMessages = displayMessages.length > 0;

  const {
    showHomeContent,
    enterChatSurfaceForInteraction,
    resetIdleTimer,
    dismissHome,
    showHome,
  } = useChatHomeSurface({
    isOnChatRoute,
    hasMessages,
    isStreaming,
    activeConversationId,
  });

  // Focus the composer on mount and whenever the user navigates onto the
  // chat route (covers both home content and the full chat surface), so
  // the user can start typing without clicking first.
  useEffect(() => {
    if (!isOnChatRoute) return;
    setComposerFocusRequestId((id) => id + 1);
  }, [isOnChatRoute, activeConversationId]);

  const startNewChat = useCallback(async () => {
    const nextConversationId = await createNewLocalConversationId();
    setMessage("");
    setSelectedText(null);
    setChatContext(null);
    setConversationId(nextConversationId);
    showHome();

    if (isOnChatRoute) {
      await router.navigate({
        to: "/chat",
        search: (prev: { c?: string } | undefined) => ({
          ...(prev ?? {}),
          c: nextConversationId,
        }),
        replace: true,
      });
    }
  }, [
    isOnChatRoute,
    setChatContext,
    setConversationId,
    setSelectedText,
    showHome,
  ]);

  const {
    sendContextlessMessage,
    sendAgentInputMessage,
    sendMessageWithContext,
  } = useAgentInputRouting({
    activeConversationId,
    sendMessage,
    enterChatSurfaceForInteraction,
  });

  useStellaSendMessageBridge({
    sendContextlessMessage,
    sendAgentInputMessage,
  });

  const startAnnotation = useCallback((options: StartAnnotationOptions) => {
    const nextTarget = {
      id: ++annotationIdRef.current,
      submit: options.submit,
    };
    annotationTargetRef.current = nextTarget;
    setAnnotationTarget(nextTarget);
  }, []);

  const cancelAnnotation = useCallback(() => {
    annotationTargetRef.current = null;
    setAnnotationTarget(null);
  }, []);

  const submitAnnotation = useCallback(
    (selection: AnnotationSelection, requestId?: number | null) => {
      const activeTarget = annotationTargetRef.current;
      const target =
        activeTarget && (requestId == null || activeTarget.id === requestId)
          ? activeTarget
          : null;

      if (!target) return;
      try {
        target.submit(selection);
      } finally {
        annotationTargetRef.current = null;
        setAnnotationTarget(null);
      }
    },
    [],
  );

  /**
   * Scroll: backed by Legend List (web entry). The list owns scrolling
   * and content geometry; the hook adapts list state into the surface
   * UI concerns (at-bottom, custom thumb, scroll-to-bottom button).
   */
  const {
    listRef,
    onListScroll,
    onStartReached,
    isAtBottom,
    isFollowingLatest,
    getIsFollowing,
    showScrollButton,
    scrollToBottom,
    releaseFollow,
    nudgeAfterSend,
    nudgeQueuedMessagesIntoView,
    thumbRef,
  } = useChatScrollManagement({
    hasOlderEvents: hasOlderMessages,
    isLoadingOlder: isLoadingOlderMessages,
    onLoadOlder: loadOlderMessages,
  });

  // On conversation change, snap to the latest content. `initialScrollAtEnd`
  // covers fresh mounts; this handles in-place conversation switches.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.getScrollableNode();
    el?.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, [activeConversationId, listRef]);

  useEffect(() => {
    if (
      !activeConversationId ||
      isInitialLoadingMessages ||
      displayMessages.length === 0 ||
      restoredConversationScrollRef.current === activeConversationId
    ) {
      return;
    }
    const conversationId = activeConversationId;
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom("instant");
      restoredConversationScrollRef.current = conversationId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeConversationId,
    displayMessages.length,
    isInitialLoadingMessages,
    scrollToBottom,
  ]);

  const handleSend = useCallback(() => {
    // `getIsFollowing()` reads the follow latch (intent), not the
    // physical scroll position. After a short assistant reply, the
    // user is visually at the bottom of the conversation but ~150px
    // physically above the absolute end (because the trailing-region
    // footer is off-screen below the latest text).
    //
    // While a stream is already in flight, the send queues as a
    // follow-up chip in the trailing region (no new user-row in the
    // event list). The normal latest-user-row nudge is still skipped:
    // it would fall through to the prior turn's user bubble and scroll
    // *backwards* to re-frame it. The streaming branch below uses a
    // footer-tail target instead.
    const shouldKeepTailFramed = showHomeContent || getIsFollowing();
    const shouldNudgeAfterSend = !isStreaming && shouldKeepTailFramed;
    if (showHomeContent) {
      setComposerFocusRequestId((id) => id + 1);
    }
    enterChatSurfaceForInteraction();
    resetIdleTimer();
    void sendMessage({
      text: message,
      selectedText,
      chatContext,
      onClear: () => {
        setMessage("");
        setSelectedText(null);
        setChatContext(null);
      },
    });
    if (isStreaming) {
      // Queued follow-up — no new user row lands in the event list.
      // The streaming assistant row's own auto-follow keeps the reply
      // framed, but repeated queued chips live below that row in the
      // footer and can drift under the viewport without their own tail
      // target.
      if (shouldKeepTailFramed) {
        nudgeQueuedMessagesIntoView();
      }
    } else if (shouldNudgeAfterSend) {
      // Routes the small post-send bump through the same lerp loop
      // as streaming auto-follow so the two motions blend rather
      // than fight via separate concurrent rAF tweens.
      nudgeAfterSend();
    } else {
      releaseFollow();
    }
  }, [
    chatContext,
    enterChatSurfaceForInteraction,
    getIsFollowing,
    isStreaming,
    message,
    nudgeAfterSend,
    nudgeQueuedMessagesIntoView,
    releaseFollow,
    resetIdleTimer,
    selectedText,
    sendMessage,
    setChatContext,
    setSelectedText,
    showHomeContent,
  ]);

  const attachFullChatAnnotation = useCallback(
    (selection: AnnotationSelection) => {
      enterChatSurfaceForInteraction();
      resetIdleTimer();
      attachComposerAppSelectionContext(selection, setChatContext);
      setComposerFocusRequestId((id) => id + 1);
    },
    [enterChatSurfaceForInteraction, resetIdleTimer, setChatContext],
  );

  const { canSubmit } = deriveComposerState({
    message,
    chatContext,
    selectedText,
    conversationId: activeConversationId,
    requireConversationId: true,
  });

  const chatColumnConversation = useMemo<ChatColumnConversation>(
    () => ({
      messages: displayMessages,
      activity: {
        activities,
        latestMessageTimestampMs,
        hasOlder: hasOlderActivity,
        isLoadingOlder: isLoadingOlderActivity,
        loadOlder: loadOlderActivity,
      },
      files: {
        files: persistedFiles,
        hasOlder: hasOlderFiles,
        isLoadingOlder: isLoadingOlderFiles,
        loadOlder: loadOlderFiles,
      },
      streaming: {
        reasoningText,
        isStreaming,
        isStreamingResponseText,
        runtimeStatusText,
        activeToolCallId,
        activeToolName,
        hasToolActivity,
        isToolActive,
        pendingUserMessageId,
        queuedUserMessages,
        liveTasks,
      },
      history: {
        hasOlderMessages,
        isLoadingOlder: isLoadingOlderMessages,
        isInitialLoading: isInitialLoadingMessages,
      },
    }),
    [
      activities,
      activeToolCallId,
      activeToolName,
      displayMessages,
      hasToolActivity,
      hasOlderActivity,
      hasOlderFiles,
      hasOlderMessages,
      isInitialLoadingMessages,
      isLoadingOlderActivity,
      isLoadingOlderFiles,
      isLoadingOlderMessages,
      latestMessageTimestampMs,
      liveTasks,
      loadOlderActivity,
      loadOlderFiles,
      pendingUserMessageId,
      persistedFiles,
      queuedUserMessages,
      reasoningText,
      runtimeStatusText,
      isStreaming,
      isStreamingResponseText,
      isToolActive,
    ],
  );

  const chatColumnComposer = useMemo<ChatColumnComposer>(
    () => ({
      message,
      setMessage,
      chatContext,
      setChatContext,
      selectedText,
      setSelectedText,
      canSubmit,
      focusRequestId: composerFocusRequestId,
      requestFocus: () => setComposerFocusRequestId((id) => id + 1),
      onSelectArea: () => startAnnotation({ submit: attachFullChatAnnotation }),
      onSend: handleSend,
      onStop: cancelCurrentStream,
      onNewChat: startNewChat,
    }),
    [
      message,
      setMessage,
      chatContext,
      setChatContext,
      selectedText,
      setSelectedText,
      canSubmit,
      composerFocusRequestId,
      startAnnotation,
      attachFullChatAnnotation,
      handleSend,
      cancelCurrentStream,
      startNewChat,
    ],
  );

  const chatColumnScroll = useMemo<ChatColumnScroll>(
    () => ({
      listRef,
      onListScroll,
      onStartReached,
      showScrollButton,
      isAtBottom,
      isFollowingLatest,
      getIsFollowing,
      scrollToBottom,
      thumbRef,
    }),
    [
      listRef,
      onListScroll,
      onStartReached,
      showScrollButton,
      isAtBottom,
      isFollowingLatest,
      getIsFollowing,
      scrollToBottom,
      thumbRef,
    ],
  );

  return {
    conversation: {
      ...chatColumnConversation,
      hasOlderMessages,
      isLoadingOlder: isLoadingOlderMessages,
      isInitialLoading: isInitialLoadingMessages,
      loadOlderMessages,
      reasoningText,
      isStreaming,
      pendingUserMessageId,
      queuedUserMessages,
      sendMessage,
      sendContextlessMessage,
      sendMessageWithContext,
      cancelCurrentStream,
      startNewChat,
    },
    composer: {
      ...chatColumnComposer,
      handleSend,
      handleStop: cancelCurrentStream,
    },
    scroll: chatColumnScroll,
    annotation: {
      active: Boolean(annotationTarget),
      requestId: annotationTarget?.id ?? null,
      start: startAnnotation,
      cancel: cancelAnnotation,
      submit: submitAnnotation,
    },
    showHomeContent,
    dismissHome,
    showHome,
  };
}
