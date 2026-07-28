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
import { useChatStore } from "@/context/chat-store-context";
import {
  subscribeToLocalMessageWindow,
  type LocalMessageWindowSnapshot,
} from "@/features/chat/services/local-message-store";
import {
  stabilizeMessageList,
  type StableMessageListState,
} from "@/features/chat/lib/stable-rows";
import { showToast } from "@/ui/toast";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";

export const MESSAGE_PAGE_SIZE = 200;
/**
 * Hard ceiling on `loadOlder` window growth. A grown window costs memory
 * for every row it retains (and IPC on the full-refetch fallback paths),
 * so an unbounded window makes worst-case cost scale with how far the
 * user once scrolled. In practice users rarely scroll past a few hundred
 * rows; 1000 keeps deep history reachable while bounding the worst case.
 */
export const MAX_VISIBLE_MESSAGES = 1_000;
const LOCAL_MESSAGE_LOAD_RETRY_MS = 300;

/**
 * Window decay: once the window has been grown via `loadOlder`, shrink it
 * back to one page after every chat surface has sat at the bottom of the
 * timeline for this long. The grown window only exists to serve a
 * scroll-up that's no longer happening; decaying frees the retained rows
 * and returns refresh cost to baseline. If the user scrolls up again
 * right after, `loadOlder` simply re-pages.
 */
const WINDOW_DECAY_AT_REST_MS = 90_000;
const WINDOW_DECAY_CHECK_INTERVAL_MS = 5_000;

/**
 * At-rest probes registered by chat scroll surfaces (full chat, sidebar —
 * each `useChatScrollManagement` instance). The window decays only while
 * *every* registered surface reports it is at the bottom, so a sidebar
 * scrolled deep into history is never yanked because the full chat
 * happens to be at rest. No registered surfaces means no decay.
 */
const chatAtRestProbes = new Set<() => boolean>();

export const registerChatAtRestProbe = (probe: () => boolean): (() => void) => {
  chatAtRestProbes.add(probe);
  return () => {
    chatAtRestProbes.delete(probe);
  };
};

const allChatSurfacesAtRest = (): boolean => {
  if (chatAtRestProbes.size === 0) return false;
  for (const probe of chatAtRestProbes) {
    if (!probe()) return false;
  }
  return true;
};

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
  loadOlder: () => boolean;
};

export const useConversationMessages = (
  conversationId?: string,
): ConversationMessagesFeed => {
  const { storageMode } = useChatStore();
  const isLocalMode = storageMode === "local";

  const visitKey = `${storageMode}:${conversationId ?? ""}`;
  const visitToken = useMemo(() => Symbol(visitKey), [visitKey]);

  const [maxVisibleMessages, setMaxVisibleMessages] =
    useState(MESSAGE_PAGE_SIZE);
  const [pendingMaxVisibleMessages, setPendingMaxVisibleMessages] = useState<
    number | null
  >(null);
  // Synchronous request lock shared by every mounted chat surface. React
  // state does not update until the next render, so full chat + sidebar could
  // otherwise both accept the same cursor/window bump in one event turn.
  const pendingMaxVisibleMessagesRef = useRef<number | null>(null);

  // Reset window size on conversation/storage-mode change.
  useEffect(() => {
    setMaxVisibleMessages(MESSAGE_PAGE_SIZE);
    setPendingMaxVisibleMessages(null);
    pendingMaxVisibleMessagesRef.current = null;
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
  stableMessagesRef.current = stableMessagesState;
  const messages = stableMessagesState.result;
  const visibleMessageCount = activeSnapshot.window.visibleMessageCount;

  // Inferred from "did the last fetch saturate the requested window?".
  // Counted in visible messages (not raw `messages.length`) so UI-hidden
  // system reminders / workspace requests inside the window don't
  // misreport "older history available" forever. Latches off after a
  // `loadOlder` that returned fewer visible messages than the new cap.
  const hasOlderMessages =
    activeSnapshot.hasLoaded &&
    visibleMessageCount >= maxVisibleMessages &&
    maxVisibleMessages < MAX_VISIBLE_MESSAGES;

  const isLoadingOlder =
    pendingMaxVisibleMessages !== null &&
    visibleMessageCount < pendingMaxVisibleMessages;

  // Pending bumps that have been satisfied (we got back at least the
  // requested number of visible rows) get cleared.
  useEffect(() => {
    if (pendingMaxVisibleMessages === null) return;
    if (visibleMessageCount >= pendingMaxVisibleMessages) {
      pendingMaxVisibleMessagesRef.current = null;
      setPendingMaxVisibleMessages(null);
      return;
    }
    if (activeSnapshot.hasLoaded && !hasOlderMessages) {
      // Fetched fewer than requested — there are no more messages.
      pendingMaxVisibleMessagesRef.current = null;
      setPendingMaxVisibleMessages(null);
    }
  }, [
    activeSnapshot.hasLoaded,
    hasOlderMessages,
    pendingMaxVisibleMessages,
    visibleMessageCount,
  ]);

  const loadOlder = useCallback(() => {
    if (!conversationId || !isLocalMode) return false;
    if (!hasOlderMessages) return false;
    if (pendingMaxVisibleMessagesRef.current !== null) return false;
    if (maxVisibleMessages >= MAX_VISIBLE_MESSAGES) return false;
    const next = Math.min(
      maxVisibleMessages + MESSAGE_PAGE_SIZE,
      MAX_VISIBLE_MESSAGES,
    );
    pendingMaxVisibleMessagesRef.current = next;
    setPendingMaxVisibleMessages(next);
    startTransition(() => {
      setMaxVisibleMessages(next);
    });
    return true;
  }, [conversationId, hasOlderMessages, isLocalMode, maxVisibleMessages]);

  // Decay the grown window back to one page once every chat surface has
  // been at the bottom continuously for the rest interval. At the bottom
  // the visible rows are the newest page, so dropping the older prefix
  // changes nothing on screen (the virtualized list holds its end
  // anchor); the re-keyed subscription seeds from the retained window
  // sliced to the new cap, so there is no flash either.
  const windowGrown = maxVisibleMessages > MESSAGE_PAGE_SIZE;
  useEffect(() => {
    if (!windowGrown || !isLocalMode || !conversationId) return;
    if (pendingMaxVisibleMessages !== null) return;
    let atRestSince: number | null = null;
    const interval = window.setInterval(() => {
      if (!allChatSurfacesAtRest()) {
        atRestSince = null;
        return;
      }
      const now = Date.now();
      atRestSince ??= now;
      if (now - atRestSince < WINDOW_DECAY_AT_REST_MS) return;
      window.clearInterval(interval);
      startTransition(() => {
        setMaxVisibleMessages(MESSAGE_PAGE_SIZE);
      });
    }, WINDOW_DECAY_CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    conversationId,
    isLocalMode,
    pendingMaxVisibleMessages,
    visitToken,
    windowGrown,
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
