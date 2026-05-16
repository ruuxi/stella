/**
 * Hook that returns the windowed list of visible chat messages for a
 * conversation. Successor to the message-rendering half of
 * `useConversationEventFeed`: the chat timeline now reads `MessageRecord[]`
 * (each assistant message carrying its turn's tool/agent-completed
 * events) instead of walking a flat event stream.
 *
 * Window growth is purely visible-message-count based — no secondary raw-
 * event cap — so "load older" reliably surfaces more chat history
 * regardless of how tool-heavy any individual turn is. The previous
 * `MAX_RENDERED_EVENTS = 500` raw-event cap is what made `loadOlder` look
 * like a no-op for chats with even a handful of agent runs.
 *
 * `hasOlderMessages` is inferred from "did the latest fetch saturate the
 * requested window?" — exact only when the conversation has more messages
 * than the cap; harmless ~1-fetch false-positive when the count is exactly
 * the cap (a `loadOlder` will fetch and surface zero new rows, then latch
 * `hasOlderMessages` to `false`).
 */
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChatStore } from "@/context/chat-store";
import {
  subscribeToLocalMessageWindow,
  type LocalMessageWindowSnapshot,
} from "@/app/chat/services/local-message-store";
import {
  stabilizeMessageList,
  type StableMessageListState,
} from "@/app/chat/lib/stable-rows";
import { showToast } from "@/ui/toast";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";

export const MESSAGE_PAGE_SIZE = 200;
const LOCAL_MESSAGE_LOAD_RETRY_MS = 300;

const EMPTY_MESSAGES: MessageRecord[] = [];

const EMPTY_SNAPSHOT: LocalMessageWindowSnapshot = {
  window: { messages: EMPTY_MESSAGES, visibleMessageCount: 0 },
  hasLoaded: false,
  error: null,
};

export type ConversationMessagesFeed = {
  messages: MessageRecord[];
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  loadOlder: () => void;
};

export const useConversationMessages = (
  conversationId?: string,
): ConversationMessagesFeed => {
  const { storageMode } = useChatStore();
  const isLocalMode = storageMode === "local";

  const visitKey = `${storageMode}:${conversationId ?? ""}`;
  const visitToken = useMemo(() => Symbol(visitKey), [visitKey]);

  const [maxVisibleMessages, setMaxVisibleMessages] = useState(
    MESSAGE_PAGE_SIZE,
  );
  const [pendingMaxVisibleMessages, setPendingMaxVisibleMessages] =
    useState<number | null>(null);

  // Reset window size on conversation/storage-mode change.
  useEffect(() => {
    setMaxVisibleMessages(MESSAGE_PAGE_SIZE);
    setPendingMaxVisibleMessages(null);
  }, [visitToken]);

  const [snapshotState, setSnapshotState] = useState<{
    visitToken: symbol;
    snapshot: LocalMessageWindowSnapshot;
  }>({
    visitToken,
    snapshot: EMPTY_SNAPSHOT,
  });
  const lastLocalLoadToastAtRef = useRef(0);
  const [localRetryTick, setLocalRetryTick] = useState(0);

  useEffect(() => {
    setSnapshotState({ visitToken, snapshot: EMPTY_SNAPSHOT });
  }, [visitToken]);

  useEffect(() => {
    if (!isLocalMode || !conversationId) {
      setSnapshotState({
        visitToken,
        snapshot: {
          window: { messages: EMPTY_MESSAGES, visibleMessageCount: 0 },
          hasLoaded: true,
          error: null,
        },
      });
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) {
          setLocalRetryTick((current) => current + 1);
        }
      }, LOCAL_MESSAGE_LOAD_RETRY_MS);
    };
    const unsubscribe = subscribeToLocalMessageWindow(
      { conversationId, maxVisibleMessages },
      (snapshot) => {
        if (cancelled) return;
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        setSnapshotState({ visitToken, snapshot });
        if (!snapshot.error) return;
        const now = Date.now();
        if (now - lastLocalLoadToastAtRef.current > 10_000) {
          lastLocalLoadToastAtRef.current = now;
          showToast({
            title: "Couldn’t load chat history",
            description:
              snapshot.error.message || "Stella will retry in a moment.",
            variant: "error",
          });
        }
        scheduleRetry();
      },
    );
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      unsubscribe();
    };
  }, [
    conversationId,
    isLocalMode,
    localRetryTick,
    maxVisibleMessages,
    visitToken,
  ]);

  const activeSnapshot =
    snapshotState.visitToken === visitToken
      ? snapshotState.snapshot
      : EMPTY_SNAPSHOT;

  const liveMessages = activeSnapshot.window.messages;

  // Reuse prior `MessageRecord` references whenever id + payload + tool
  // event ids match, so `useEventRows` downstream stays bailout-eligible
  // across update ticks. See `stable-rows.ts:stabilizeMessageList`.
  const stableMessagesRef = useRef<StableMessageListState | null>(null);
  const stableMessagesState = useMemo(
    () => stabilizeMessageList(liveMessages, stableMessagesRef.current),
    [liveMessages],
  );
  useEffect(() => {
    stableMessagesRef.current = stableMessagesState;
  }, [stableMessagesState]);
  const messages = stableMessagesState.result;
  const visibleMessageCount = activeSnapshot.window.visibleMessageCount;

  // Inferred from "did the last fetch saturate the requested window?".
  // Counted in visible messages (not raw `messages.length`) so UI-hidden
  // system reminders / workspace requests inside the window don't
  // misreport "older history available" forever. Latches off after a
  // `loadOlder` that returned fewer visible messages than the new cap.
  const hasOlderMessages =
    activeSnapshot.hasLoaded && visibleMessageCount >= maxVisibleMessages;

  const isLoadingOlder =
    pendingMaxVisibleMessages !== null &&
    visibleMessageCount < pendingMaxVisibleMessages;

  // Pending bumps that have been satisfied (we got back at least the
  // requested number of visible rows) get cleared.
  useEffect(() => {
    if (pendingMaxVisibleMessages === null) return;
    if (visibleMessageCount >= pendingMaxVisibleMessages) {
      setPendingMaxVisibleMessages(null);
      return;
    }
    if (activeSnapshot.hasLoaded && !hasOlderMessages) {
      // Fetched fewer than requested — there are no more messages.
      setPendingMaxVisibleMessages(null);
    }
  }, [
    activeSnapshot.hasLoaded,
    hasOlderMessages,
    pendingMaxVisibleMessages,
    visibleMessageCount,
  ]);

  const loadOlder = useCallback(() => {
    if (!conversationId || !isLocalMode) return;
    if (!hasOlderMessages) return;
    if (pendingMaxVisibleMessages !== null) return;
    const next = maxVisibleMessages + MESSAGE_PAGE_SIZE;
    setPendingMaxVisibleMessages(next);
    startTransition(() => {
      setMaxVisibleMessages(next);
    });
  }, [
    conversationId,
    hasOlderMessages,
    isLocalMode,
    maxVisibleMessages,
    pendingMaxVisibleMessages,
  ]);

  const isInitialLoading =
    Boolean(conversationId) &&
    isLocalMode &&
    !activeSnapshot.hasLoaded &&
    activeSnapshot.window.messages.length === 0;

  return {
    messages,
    hasOlderMessages,
    isLoadingOlder,
    isInitialLoading,
    loadOlder,
  };
};
