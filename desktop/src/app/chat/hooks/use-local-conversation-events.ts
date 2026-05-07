import { useEffect, useRef, useState } from "react";
import {
  subscribeToLocalConversationEventWindow,
  type LocalConversationEventSnapshot,
} from "@/app/chat/services/local-chat-store";
import { showToast } from "@/ui/toast";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

const LOCAL_LOAD_RETRY_MS = 300;
const EMPTY_EVENTS: EventRecord[] = [];

const EMPTY_LOCAL_SNAPSHOT: LocalConversationEventSnapshot = {
  events: EMPTY_EVENTS,
  count: 0,
  hasLoaded: false,
  error: null,
};

type UseLocalConversationEventsOptions = {
  conversationId: string | undefined;
  enabled: boolean;
  /** Maximum number of *visible* messages to load (window cap). */
  maxItems: number;
  /** Visit token bumped on conversation/storage-mode change so the
   *  hook knows to clear stale snapshot state. */
  visitToken: symbol;
};

type UseLocalConversationEventsResult = {
  snapshot: LocalConversationEventSnapshot;
};

/**
 * SQLite-backed conversation event subscription with toast-on-error
 * + automatic retry when the local store is briefly unavailable
 * (e.g. mid-reset). Owned by `useConversationEventFeed`, which
 * decides the window size externally.
 */
export function useLocalConversationEvents({
  conversationId,
  enabled,
  maxItems,
  visitToken,
}: UseLocalConversationEventsOptions): UseLocalConversationEventsResult {
  const [localSnapshot, setLocalSnapshot] = useState(() => ({
    visitToken,
    snapshot: EMPTY_LOCAL_SNAPSHOT,
  }));
  const lastLocalLoadToastAtRef = useRef(0);
  const [localRetryTick, setLocalRetryTick] = useState(0);

  const activeSnapshot =
    localSnapshot.visitToken === visitToken
      ? localSnapshot.snapshot
      : EMPTY_LOCAL_SNAPSHOT;

  useEffect(() => {
    setLocalSnapshot({
      visitToken,
      snapshot: EMPTY_LOCAL_SNAPSHOT,
    });
  }, [visitToken]);

  useEffect(() => {
    if (!enabled || !conversationId) {
      setLocalSnapshot({
        visitToken,
        snapshot: {
          events: EMPTY_EVENTS,
          count: 0,
          hasLoaded: true,
          error: null,
        },
      });
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const options = {
      conversationId,
      maxItems,
      windowBy: "visible_messages" as const,
    };

    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) {
          setLocalRetryTick((current) => current + 1);
        }
      }, LOCAL_LOAD_RETRY_MS);
    };

    const handleSnapshot = (snapshot: LocalConversationEventSnapshot) => {
      if (cancelled) {
        return;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      setLocalSnapshot({
        visitToken,
        snapshot,
      });

      if (!snapshot.error) {
        return;
      }
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
    };

    const unsubscribe = subscribeToLocalConversationEventWindow(
      options,
      handleSnapshot,
    );

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      unsubscribe();
    };
  }, [conversationId, enabled, maxItems, localRetryTick, visitToken]);

  return { snapshot: activeSnapshot };
}
