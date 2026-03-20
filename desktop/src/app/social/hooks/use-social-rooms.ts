import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import type { SocialProfile } from "./use-social-profile";

export type SocialRoomSummary = {
  room: {
    _id: string;
    kind: "dm" | "group";
    title?: string;
    latestMessageAt?: number;
  };
  membership: {
    lastReadAt?: number;
  };
  latestMessage: {
    body: string;
    senderOwnerId: string;
  } | null;
  memberProfiles: SocialProfile[];
};

export function useSocialRooms() {
  const { hasConnectedAccount } = useAuthSessionState();

  const rooms = useQuery(
    api.social.rooms.listRooms,
    hasConnectedAccount ? {} : "skip",
  ) as SocialRoomSummary[] | undefined;

  const getOrCreateDmMutation = useMutation(api.social.rooms.getOrCreateDmRoom);
  const createGroupMutation = useMutation(api.social.rooms.createGroupRoom);
  const markReadMutation = useMutation(api.social.rooms.markRoomRead);

  const openDm = useCallback(
    async (otherOwnerId: string) => {
      return await getOrCreateDmMutation({ otherOwnerId });
    },
    [getOrCreateDmMutation],
  );

  const createGroup = useCallback(
    async (title: string, memberOwnerIds: string[]) => {
      return await createGroupMutation({ title, memberOwnerIds });
    },
    [createGroupMutation],
  );

  const markRead = useCallback(
    async (roomId: string, messageId: string) => {
      return await markReadMutation({ roomId, messageId });
    },
    [markReadMutation],
  );

  return {
    rooms: rooms ?? [],
    openDm,
    createGroup,
    markRead,
  };
}
