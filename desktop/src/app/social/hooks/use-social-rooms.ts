import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCallback } from "react";

export function useSocialRooms() {
  const { hasConnectedAccount } = useAuthSessionState();

  const rooms = useQuery(
    api.social.rooms.listRooms,
    hasConnectedAccount ? {} : "skip",
  );

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
