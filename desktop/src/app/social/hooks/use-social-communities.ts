import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import type { SocialRoomSummary } from "./use-social-rooms";

/**
 * Communities are community-kind rooms in the shared `listRooms`
 * subscription (Convex dedupes the query with the sidebar's), so this hook
 * only filters the list and wraps the community mutations.
 */
export function useSocialCommunities() {
  const { hasConnectedAccount } = useAuthSessionState();

  const rooms = useQuery(
    api.social.rooms.listRooms,
    hasConnectedAccount ? {} : "skip",
  ) as SocialRoomSummary[] | undefined;

  const communities = useMemo(
    () => (rooms ?? []).filter((entry) => entry.room.kind === "community"),
    [rooms],
  );

  const createMutation = useMutation(api.social.communities.createCommunity);
  const joinMutation = useMutation(api.social.communities.joinCommunity);
  const renameMutation = useMutation(api.social.communities.renameCommunity);
  const removeMemberMutation = useMutation(
    api.social.communities.removeCommunityMember,
  );
  const leaveMutation = useMutation(api.social.communities.leaveCommunity);
  const deleteMutation = useMutation(api.social.communities.deleteCommunity);

  const createCommunity = useCallback(
    async (name: string) => {
      return await createMutation({ name });
    },
    [createMutation],
  );

  const joinCommunity = useCallback(
    async (inviteCode: string) => {
      return await joinMutation({ inviteCode });
    },
    [joinMutation],
  );

  const renameCommunity = useCallback(
    async (roomId: string, name: string) => {
      return await renameMutation({ roomId, name });
    },
    [renameMutation],
  );

  const removeCommunityMember = useCallback(
    async (roomId: string, memberOwnerId: string) => {
      return await removeMemberMutation({ roomId, memberOwnerId });
    },
    [removeMemberMutation],
  );

  const leaveCommunity = useCallback(
    async (roomId: string) => {
      return await leaveMutation({ roomId });
    },
    [leaveMutation],
  );

  const deleteCommunity = useCallback(
    async (roomId: string) => {
      return await deleteMutation({ roomId });
    },
    [deleteMutation],
  );

  return {
    communities,
    createCommunity,
    joinCommunity,
    renameCommunity,
    removeCommunityMember,
    leaveCommunity,
    deleteCommunity,
  };
}
