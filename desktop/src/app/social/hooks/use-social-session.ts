import { useCallback, useMemo } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/api";
import type { RuntimeSocialSessionStatus } from "../../../../../runtime/protocol/index.js";

const TURNS_PAGE_SIZE = 20;

export type SocialSessionStatus = RuntimeSocialSessionStatus;

type SocialSessionSummary = {
  room: {
    _id: string;
    kind: "dm" | "group";
    title?: string;
    stellaSessionId?: string;
  };
  session: {
    _id: string;
    hostOwnerId: string;
    hostDeviceId: string;
    workspaceSlug: string;
    workspaceFolderName: string;
    conversationId: string;
    status: SocialSessionStatus;
    latestTurnOrdinal: number;
    latestFileOpOrdinal: number;
    createdAt: number;
    updatedAt: number;
    lastSnapshotAt?: number;
  };
  membershipRole: "owner" | "member";
  isHost: boolean;
} | null;

type SocialSessionTurn = {
  _id: string;
  sessionId: string;
  ordinal: number;
  status: "queued" | "claimed" | "completed" | "failed" | "canceled";
  requestedByOwnerId: string;
  requestId?: string;
  prompt: string;
  agentType?: string;
  claimedByDeviceId?: string;
  claimedAt?: number;
  completedAt?: number;
  resultText?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export function useSocialSession(sessionId?: string | null) {
  const sessionSummary = useQuery(
    api.social.sessions.getSession,
    sessionId ? { sessionId } : "skip",
  ) as SocialSessionSummary | undefined;

  // Backend returns pages in desc-ordinal order so each `loadMore`
  // pulls the next-older slice; reverse for chronological display.
  const { results, status, loadMore } = usePaginatedQuery(
    api.social.sessions.listTurns,
    sessionId ? { sessionId } : "skip",
    { initialNumItems: TURNS_PAGE_SIZE },
  );
  const turns = useMemo(
    () => [...(results as SocialSessionTurn[])].reverse(),
    [results],
  );

  const loadOlderTurns = useCallback(() => {
    if (status === "CanLoadMore") loadMore(TURNS_PAGE_SIZE);
  }, [status, loadMore]);

  const hasOlderTurns =
    status === "CanLoadMore" || status === "LoadingMore";

  return {
    sessionSummary: sessionSummary ?? null,
    turns,
    loadOlderTurns,
    hasOlderTurns,
    isLoadingOlderTurns: status === "LoadingMore",
    isInitialLoadingTurns: status === "LoadingFirstPage",
  };
}
