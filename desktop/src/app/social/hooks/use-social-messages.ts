import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/api";

const PAGE_SIZE = 50;

type SocialMessage = {
  _id: string;
  _creationTime: number;
  roomId: string;
  senderOwnerId: string;
  clientMessageId?: string;
  kind: "text" | "system";
  body: string;
  moderationStatus?: "pending" | "clean" | "censored" | "failed";
  createdAt: number;
};

export function useSocialMessages(roomId: string, currentOwnerId: string) {
  // The backend returns desc-ordered pages (newest first per page) so
  // each `loadMore` adds the next-older slice; we reverse for display so
  // the timeline reads chronologically.
  const { results, status, loadMore } = usePaginatedQuery(
    api.social.messages.listRoomMessages,
    { roomId },
    { initialNumItems: PAGE_SIZE },
  );
  const realMessages = useMemo(
    () => [...(results as SocialMessage[])].reverse(),
    [results],
  );

  // Local pending-sends overlay. Replaces Convex `withOptimisticUpdate`
  // (which is awkward against `usePaginatedQuery`'s per-page cache
  // entries — each page has its own args including `paginationOpts`,
  // and the optimistic write needs to land on whichever entry happens
  // to be the newest). Tracking a small array of in-flight sends in
  // React state and merging them into the rendered list is simpler and
  // independent of Convex's internal pagination shape.
  const [pendingSends, setPendingSends] = useState<SocialMessage[]>([]);
  const clientIdRef = useRef(0);

  // Reconciliation: as the real page receives the message we sent
  // (matched by `clientMessageId`), drop the corresponding pending
  // entry so the timeline doesn't double-render the row.
  useEffect(() => {
    if (pendingSends.length === 0) return;
    const realClientIds = new Set<string>();
    for (const message of realMessages) {
      if (message.clientMessageId) realClientIds.add(message.clientMessageId);
    }
    setPendingSends((prev) =>
      prev.filter(
        (entry) =>
          !entry.clientMessageId || !realClientIds.has(entry.clientMessageId),
      ),
    );
  }, [pendingSends.length, realMessages]);

  // Reset pending sends when switching rooms — a stale optimistic
  // entry from the previous room would otherwise leak into the new
  // timeline (different `roomId`, but the same hook instance).
  useEffect(() => {
    setPendingSends([]);
  }, [roomId]);

  const messages = useMemo<SocialMessage[]>(
    () =>
      pendingSends.length === 0
        ? realMessages
        : [...realMessages, ...pendingSends],
    [realMessages, pendingSends],
  );

  const sendMutation = useMutation(api.social.messages.sendRoomMessage);

  const sendMessage = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      clientIdRef.current += 1;
      const clientMessageId = `local-${Date.now()}-${clientIdRef.current}`;
      const now = Date.now();
      const optimisticId = `optimistic:${clientMessageId}`;
      const pending: SocialMessage = {
        _id: optimisticId,
        _creationTime: now,
        roomId,
        senderOwnerId: currentOwnerId,
        clientMessageId,
        kind: "text",
        body: trimmed,
        moderationStatus: "pending",
        createdAt: now,
      };
      setPendingSends((prev) => [...prev, pending]);
      try {
        await sendMutation({ roomId, body: trimmed, clientMessageId });
      } catch (error) {
        setPendingSends((prev) =>
          prev.filter((entry) => entry._id !== optimisticId),
        );
        throw error;
      }
    },
    [roomId, currentOwnerId, sendMutation],
  );

  const loadOlder = useCallback(() => {
    if (status === "CanLoadMore") loadMore(PAGE_SIZE);
  }, [status, loadMore]);

  const hasOlder = status === "CanLoadMore" || status === "LoadingMore";

  return {
    messages,
    sendMessage,
    loadOlder,
    hasOlder,
    isLoadingOlder: status === "LoadingMore",
    isInitialLoading: status === "LoadingFirstPage",
  };
}
