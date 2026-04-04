import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import type { RuntimeSocialSessionStatus } from "../../../../runtime/protocol/index.js";

export type SocialSessionStatus = RuntimeSocialSessionStatus;

export type SocialSessionSummary = {
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

export type SocialSessionTurn = {
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

  const turns = useQuery(
    api.social.sessions.listTurns,
    sessionId ? { sessionId, limit: 20 } : "skip",
  ) as SocialSessionTurn[] | undefined;

  return {
    sessionSummary: sessionSummary ?? null,
    turns: turns ?? [],
  };
}
