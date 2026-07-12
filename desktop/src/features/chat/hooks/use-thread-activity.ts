/**
 * Hook over the authoritative thread-activity rows for a conversation
 * (`localChat:listThreadActivity`, backed by the runtime's `runtime_agents`
 * table). One row per background-agent thread — status, description, and
 * timestamps are the runtime's current truth, refreshed on every
 * `localChat:threadActivityUpdated` push. No paging: the list is bounded by
 * thread count, not event history.
 */
import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/context/chat-store-context";
import {
  subscribeToThreadActivity,
  type ThreadActivitySnapshot,
} from "@/features/chat/services/thread-activity-store";
import type { ThreadActivityRecord } from "../../../../../runtime/contracts/local-chat.js";

const EMPTY_RECORDS: ThreadActivityRecord[] = [];

const EMPTY_SNAPSHOT: ThreadActivitySnapshot = {
  records: EMPTY_RECORDS,
  hasLoaded: false,
  error: null,
};

export type ConversationThreadActivity = {
  records: ThreadActivityRecord[];
  isInitialLoading: boolean;
};

export const useThreadActivity = (
  conversationId?: string,
): ConversationThreadActivity => {
  const { storageMode } = useChatStore();
  const isLocalMode = storageMode === "local";

  const visitKey = `${storageMode}:${conversationId ?? ""}`;
  const visitToken = useMemo(() => Symbol(visitKey), [visitKey]);

  const [snapshotState, setSnapshotState] = useState<{
    visitToken: symbol;
    snapshot: ThreadActivitySnapshot;
  }>({ visitToken, snapshot: EMPTY_SNAPSHOT });

  useEffect(() => {
    setSnapshotState({ visitToken, snapshot: EMPTY_SNAPSHOT });
  }, [visitToken]);

  useEffect(() => {
    if (!isLocalMode || !conversationId) {
      setSnapshotState({
        visitToken,
        snapshot: { records: EMPTY_RECORDS, hasLoaded: true, error: null },
      });
      return;
    }
    let cancelled = false;
    const unsubscribe = subscribeToThreadActivity(
      conversationId,
      (snapshot) => {
        if (cancelled) return;
        setSnapshotState({ visitToken, snapshot });
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId, isLocalMode, visitToken]);

  const activeSnapshot =
    snapshotState.visitToken === visitToken
      ? snapshotState.snapshot
      : EMPTY_SNAPSHOT;

  return {
    records: activeSnapshot.records,
    isInitialLoading:
      Boolean(conversationId) &&
      isLocalMode &&
      !activeSnapshot.hasLoaded &&
      activeSnapshot.records.length === 0,
  };
};
