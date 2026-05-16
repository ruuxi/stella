/**
 * Pages strictly older `EventRecord`s for a conversation directly from
 * SQLite, used by the chat home overview's "See all" dialog to walk
 * conversation history beyond the renderer's ~500-event window.
 *
 * Stays off while disabled (the dialog is closed) — no IPC, no state
 * allocation — and resets cleanly when the conversation, anchor cursor,
 * or `enabled` flag changes so reopening the dialog starts a fresh
 * page set rather than appending to stale older fetches.
 *
 * Cursor is `(beforeTimestampMs, beforeId)`. Initial anchor is the
 * caller-provided oldest event in their in-memory window; subsequent
 * pages advance the cursor to the oldest row returned so the next
 * fetch picks up strictly older history without re-reading rows the
 * caller already has.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

const PAGE_SIZE = 100;

export type ConversationHistoryPager = {
  extras: EventRecord[];
  hasMore: boolean;
  isLoading: boolean;
  loadMore: () => void;
};

type Anchor = {
  beforeTimestampMs: number;
  beforeId: string;
};

const EMPTY: EventRecord[] = [];

const NO_PAGER: ConversationHistoryPager = {
  extras: EMPTY,
  hasMore: false,
  isLoading: false,
  loadMore: () => {},
};

export function useConversationHistoryPager(opts: {
  conversationId: string | null;
  anchor: Anchor | null;
  enabled: boolean;
}): ConversationHistoryPager {
  const { conversationId, anchor, enabled } = opts;
  const [extras, setExtras] = useState<EventRecord[]>(EMPTY);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const cursorRef = useRef<Anchor | null>(null);
  // Guards against overlapping `loadMore` calls (e.g. `onEndReached`
  // firing repeatedly while a fetch is mid-flight).
  const inFlightRef = useRef(false);

  // Reset whenever the dialog re-opens or the conversation changes.
  // Anchor changes are also a reset (a fresh in-memory event with an
  // older-than-anchor timestamp is impossible — the caller's anchor is
  // always the oldest record they have).
  useEffect(() => {
    if (!enabled || !conversationId || !anchor) {
      cursorRef.current = null;
      inFlightRef.current = false;
      setExtras(EMPTY);
      setHasMore(Boolean(enabled && conversationId && anchor));
      setIsLoading(false);
      return;
    }
    cursorRef.current = anchor;
    inFlightRef.current = false;
    setExtras(EMPTY);
    setHasMore(true);
    setIsLoading(false);
  }, [enabled, conversationId, anchor?.beforeId, anchor?.beforeTimestampMs]);

  const loadMore = useCallback(() => {
    if (!enabled || !conversationId) return;
    if (inFlightRef.current) return;
    const cursor = cursorRef.current;
    if (!cursor) return;
    const api = window.electronAPI?.localChat;
    if (!api?.listEventsBefore) {
      setHasMore(false);
      return;
    }
    inFlightRef.current = true;
    setIsLoading(true);
    void api
      .listEventsBefore({
        conversationId,
        beforeTimestampMs: cursor.beforeTimestampMs,
        beforeId: cursor.beforeId,
        limit: PAGE_SIZE,
      })
      .then((page) => {
        // The page comes back ASC by timestamp. The next cursor
        // should be the OLDEST row in this page (the first one) so
        // the subsequent call asks for strictly older rows.
        const next = Array.isArray(page) ? page : EMPTY;
        if (next.length === 0) {
          setHasMore(false);
          return;
        }
        const oldest = next[0];
        cursorRef.current = {
          beforeTimestampMs: oldest.timestamp,
          beforeId: oldest._id,
        };
        setExtras((prev) => {
          // Prepend (since the new page is strictly older than what
          // we already accumulated) and keep ASC ordering.
          return [...next, ...prev];
        });
        if (next.length < PAGE_SIZE) {
          setHasMore(false);
        }
      })
      .catch(() => {
        // Network-style transient failures shouldn't latch off — the
        // user can trigger another `loadMore` by scrolling again. We
        // do mark loading false so the spinner clears.
      })
      .finally(() => {
        inFlightRef.current = false;
        setIsLoading(false);
      });
  }, [conversationId, enabled]);

  if (!enabled || !conversationId || !anchor) {
    return NO_PAGER;
  }

  return { extras, hasMore, isLoading, loadMore };
}
