import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import type { SocialProfile } from "./use-social-profile";

export type SocialFriend = {
  profile: SocialProfile;
};

export type IncomingSocialFriendRequest = {
  relationship: {
    requesterOwnerId: string;
  };
  profile: SocialProfile;
};

export type OutgoingSocialFriendRequest = {
  relationship: {
    addresseeOwnerId: string;
  };
  profile: SocialProfile;
};

export type SocialPendingRequests = {
  incoming: IncomingSocialFriendRequest[];
  outgoing: OutgoingSocialFriendRequest[];
};

export function useSocialFriends() {
  const { hasConnectedAccount } = useAuthSessionState();

  const friends = useQuery(
    api.social.relationships.listFriends,
    hasConnectedAccount ? {} : "skip",
  ) as SocialFriend[] | undefined;

  const pendingRequests = useQuery(
    api.social.relationships.listPendingRequests,
    hasConnectedAccount ? {} : "skip",
  ) as SocialPendingRequests | undefined;

  const sendRequestMutation = useMutation(api.social.relationships.sendFriendRequest);
  const respondMutation = useMutation(api.social.relationships.respondToFriendRequest);
  const removeFriendMutation = useMutation(api.social.relationships.removeFriend);

  const sendFriendRequest = useCallback(
    async (friendCode: string) => {
      return await sendRequestMutation({ friendCode });
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

  return {
    friends: friends ?? [],
    pendingRequests:
      pendingRequests ?? {
        incoming: [],
        outgoing: [],
      },
    sendFriendRequest,
    acceptRequest,
    declineRequest,
    removeFriend,
  };
}
