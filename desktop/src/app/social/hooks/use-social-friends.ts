import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import type { SocialProfile } from "./use-social-profile";

type SocialFriend = {
  profile: SocialProfile;
};

type IncomingSocialFriendRequest = {
  relationship: {
    requesterOwnerId: string;
  };
  profile: SocialProfile;
};

type OutgoingSocialFriendRequest = {
  relationship: {
    addresseeOwnerId: string;
  };
  profile: SocialProfile;
};

type SocialPendingRequests = {
  incoming: IncomingSocialFriendRequest[];
  outgoing: OutgoingSocialFriendRequest[];
};

/** Backend returns a flat list with `direction`; older clients may still see `{ incoming, outgoing }`. */
type PendingRequestRow = {
  relationship: IncomingSocialFriendRequest["relationship"] &
    OutgoingSocialFriendRequest["relationship"];
  profile: SocialProfile;
  direction: "incoming" | "outgoing";
};

function normalizePendingRequests(
  raw: SocialPendingRequests | PendingRequestRow[] | undefined,
): SocialPendingRequests | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const incoming: IncomingSocialFriendRequest[] = [];
    const outgoing: OutgoingSocialFriendRequest[] = [];
    for (const row of raw) {
      if (row.direction === "incoming") {
        incoming.push({ relationship: row.relationship, profile: row.profile });
      } else {
        outgoing.push({ relationship: row.relationship, profile: row.profile });
      }
    }
    return { incoming, outgoing };
  }
  return {
    incoming: raw.incoming ?? [],
    outgoing: raw.outgoing ?? [],
  };
}

export function useSocialFriends() {
  const { hasConnectedAccount } = useAuthSessionState();

  const friends = useQuery(
    api.social.relationships.listFriends,
    hasConnectedAccount ? {} : "skip",
  ) as SocialFriend[] | undefined;

  const pendingRequestsRaw = useQuery(
    api.social.relationships.listPendingRequests,
    hasConnectedAccount ? {} : "skip",
  ) as SocialPendingRequests | PendingRequestRow[] | undefined;

  const pendingRequests = useMemo(
    () => normalizePendingRequests(pendingRequestsRaw),
    [pendingRequestsRaw],
  );

  const sendRequestMutation = useMutation(
    api.social.relationships.sendFriendRequest,
  );
  const respondMutation = useMutation(
    api.social.relationships.respondToFriendRequest,
  );
  const markRequestsSeenMutation = useMutation(
    api.social.relationships.markIncomingFriendRequestsSeen,
  );
  const removeFriendMutation = useMutation(
    api.social.relationships.removeFriend,
  );

  const sendFriendRequest = useCallback(
    async (username: string) => {
      return await sendRequestMutation({ username });
    },
    [sendRequestMutation],
  );

  const acceptRequest = useCallback(
    async (requesterOwnerId: string) => {
      return await respondMutation({ requesterOwnerId, action: "accept" });
    },
    [respondMutation],
  );

  const declineRequest = useCallback(
    async (requesterOwnerId: string) => {
      return await respondMutation({ requesterOwnerId, action: "decline" });
    },
    [respondMutation],
  );

  const removeFriend = useCallback(
    async (otherOwnerId: string) => {
      return await removeFriendMutation({ otherOwnerId });
    },
    [removeFriendMutation],
  );

  const markIncomingFriendRequestsSeen = useCallback(async () => {
    return await markRequestsSeenMutation({});
  }, [markRequestsSeenMutation]);

  return {
    friends: friends ?? [],
    pendingRequests: pendingRequests ?? {
      incoming: [],
      outgoing: [],
    },
    sendFriendRequest,
    acceptRequest,
    declineRequest,
    markIncomingFriendRequestsSeen,
    removeFriend,
  };
}
