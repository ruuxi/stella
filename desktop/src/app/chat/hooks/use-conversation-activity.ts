/**
 * Hook over the agent-lifecycle activity stream for a conversation
 * (`localChat:listActivity` IPC, backed by `SessionStore.listActivity`).
 * Returns the raw activity events plus the latest user/assistant message
 * timestamp the storage layer surfaces alongside them — the two inputs
 * `extractTasksFromActivities` needs to project Now / Done / Up Next
 * state without touching the message stream.
 *
 * Window growth is purely activity-count based. Activity events are
 * sparse relative to messages (a handful per turn) so the cap can be
 * comfortably small; `loadOlder` doubles the window for the
 * ActivityHistoryDialog "Completed" view when the user scrolls past it.
 *
 * `hasOlderActivity` is inferred from "did the latest fetch saturate the
 * requested limit?" — exact when more rows exist, harmless 1-fetch
 * false-positive when the count is exactly the cap.
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
  subscribeToLocalActivityWindow,
  type LocalActivityWindowSnapshot,
} from "@/app/chat/services/local-activity-store";
import { showToast } from "@/ui/toast";
import type { EventRecord } from "../../../../../runtime/contracts/local-chat.js";

export const ACTIVITY_PAGE_SIZE = 500;
const LOCAL_ACTIVITY_LOAD_RETRY_MS = 300;

const EMPTY_ACTIVITIES: EventRecord[] = [];

const EMPTY_SNAPSHOT: LocalActivityWindowSnapshot = {
  window: { activities: EMPTY_ACTIVITIES, latestMessageTimestampMs: null },
  hasLoaded: false,
  error: null,
};

export type ConversationActivityFeed = {
  activities: EventRecord[];
  latestMessageTimestampMs: number | null;
  hasOlderActivity: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  loadOlder: () => void;
};

export const useConversationActivity = (
  conversationId?: string,
): ConversationActivityFeed => {
  const { storageMode } = useChatStore();
  const isLocalMode = storageMode === "local";

  const visitKey = `${storageMode}:${conversationId ?? ""}`;
  const visitToken = useMemo(() => Symbol(visitKey), [visitKey]);

  const [limit, setLimit] = useState(ACTIVITY_PAGE_SIZE);
  const [pendingLimit, setPendingLimit] = useState<number | null>(null);

  useEffect(() => {
    setLimit(ACTIVITY_PAGE_SIZE);
    setPendingLimit(null);
  }, [visitToken]);

  const [snapshotState, setSnapshotState] = useState<{
    visitToken: symbol;
    snapshot: LocalActivityWindowSnapshot;
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
          window: {
            activities: EMPTY_ACTIVITIES,
            latestMessageTimestampMs: null,
          },
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
      }, LOCAL_ACTIVITY_LOAD_RETRY_MS);
    };
    const unsubscribe = subscribeToLocalActivityWindow(
      { conversationId, limit },
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
            title: "Couldn’t load chat activity",
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
  }, [conversationId, isLocalMode, limit, localRetryTick, visitToken]);

  const activeSnapshot =
    snapshotState.visitToken === visitToken
      ? snapshotState.snapshot
      : EMPTY_SNAPSHOT;

  const activities = activeSnapshot.window.activities;
  const latestMessageTimestampMs =
    activeSnapshot.window.latestMessageTimestampMs;

  const hasOlderActivity =
    activeSnapshot.hasLoaded && activities.length >= limit;

  const isLoadingOlder =
    pendingLimit !== null && activities.length < pendingLimit;

  useEffect(() => {
    if (pendingLimit === null) return;
    if (activities.length >= pendingLimit) {
      setPendingLimit(null);
      return;
    }
    if (activeSnapshot.hasLoaded && !hasOlderActivity) {
      setPendingLimit(null);
    }
  }, [
    activeSnapshot.hasLoaded,
    activities.length,
    hasOlderActivity,
    pendingLimit,
  ]);

  const loadOlder = useCallback(() => {
    if (!conversationId || !isLocalMode) return;
    if (!hasOlderActivity) return;
    if (pendingLimit !== null) return;
    const next = limit + ACTIVITY_PAGE_SIZE;
    setPendingLimit(next);
    startTransition(() => {
      setLimit(next);
    });
  }, [conversationId, hasOlderActivity, isLocalMode, limit, pendingLimit]);

  const isInitialLoading =
    Boolean(conversationId) &&
    isLocalMode &&
    !activeSnapshot.hasLoaded &&
    activities.length === 0;

  return {
    activities,
    latestMessageTimestampMs,
    hasOlderActivity,
    isLoadingOlder,
    isInitialLoading,
    loadOlder,
  };
};
