import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useSocialRooms, type SocialRoomSummary } from "./use-social-rooms";

function roomHasUnread(room: SocialRoomSummary): boolean {
  if (room.room.latestMessageAt === undefined) return false;
  if (room.membership.lastReadAt === undefined) return true;
  return room.room.latestMessageAt > room.membership.lastReadAt;
}

/**
 * Aggregated unread counts that drive the social badges (sidebar tab + the
 * Friends icon inside the Social view). Backend tracks `lastReadAt` per
 * membership rather than per-message counts, so unread is collapsed to
 * "rooms with at least one new message" — one badge unit per conversation.
 */
export function useSocialBadges() {
  const { hasConnectedAccount } = useAuthSessionState();
  const { rooms } = useSocialRooms();
  const unseenIncomingFriendRequestCount = useQuery(
    api.social.relationships.getUnseenIncomingFriendRequestCount,
    hasConnectedAccount ? {} : "skip",
  ) as number | undefined;

  return useMemo(() => {
    let unreadRoomCount = 0;
    for (const room of rooms) {
      if (roomHasUnread(room)) unreadRoomCount += 1;
    }

    const incomingFriendRequestCount = unseenIncomingFriendRequestCount ?? 0;

    return {
      unreadRoomCount,
      incomingFriendRequestCount,
      totalBadge: unreadRoomCount + incomingFriendRequestCount,
    };
  }, [rooms, unseenIncomingFriendRequestCount]);
}
