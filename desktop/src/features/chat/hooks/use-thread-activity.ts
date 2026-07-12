/**
 * Hook over the authoritative thread-activity rows for a conversation
 * (`localChat:listThreadActivity`, backed by the runtime's `runtime_agents`
 * table). One row per background-agent thread — status, description, and
 * timestamps are the runtime's current truth, refreshed on every
 * `localChat:threadActivityUpdated` push. No paging: the list is bounded by
 * thread count, not event history. Not storage-mode gated: `persistTask`
 * writes `runtime_agents` rows regardless of the task's storage mode, so the
 * rows exist (and this hook works) for cloud-mode conversations too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  subscribeToThreadActivity,
  type ThreadActivitySnapshot,
} from "@/features/chat/services/thread-activity-store";
import { showToast } from "@/ui/toast";
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
  const visitToken = useMemo(
    () => Symbol(conversationId ?? ""),
    [conversationId],
  );

  const [snapshotState, setSnapshotState] = useState<{
    visitToken: symbol;
    snapshot: ThreadActivitySnapshot;
  }>({ visitToken, snapshot: EMPTY_SNAPSHOT });
  const lastErrorToastAtRef = useRef(0);

  useEffect(() => {
    if (!conversationId) {
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
        if (!snapshot.error) return;
        // The store keeps retrying on its own; just tell the user once in a
        // while so a stuck-empty Activity list isn't a silent mystery.
        const now = Date.now();
        if (now - lastErrorToastAtRef.current > 10_000) {
          lastErrorToastAtRef.current = now;
          showToast({
            title: "Couldn’t load activity",
            description:
              snapshot.error.message || "Stella will retry in a moment.",
            variant: "error",
          });
        }
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId, visitToken]);

  const activeSnapshot =
    snapshotState.visitToken === visitToken
      ? snapshotState.snapshot
      : EMPTY_SNAPSHOT;

  return {
    records: activeSnapshot.records,
    isInitialLoading:
      Boolean(conversationId) &&
      !activeSnapshot.hasLoaded &&
      activeSnapshot.records.length === 0,
  };
};
