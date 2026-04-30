import { useMemo } from "react";
import { useSocialFriends } from "./use-social-friends";
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
  const { rooms } = useSocialRooms();
  const { pendingRequests } = useSocialFriends();

  return useMemo(() => {
    // Global Chat is intentionally excluded — it's a public firehose, so
    // background traffic there shouldn't pull the user back into the app.
    let unreadRoomCount = 0;
    for (const room of rooms) {
      if (room.room.kind === "global") continue;
      if (roomHasUnread(room)) unreadRoomCount += 1;
    }

    const incomingFriendRequestCount = pendingRequests.incoming.length;

    return {
      unreadRoomCount,
      incomingFriendRequestCount,
      totalBadge: unreadRoomCount + incomingFriendRequestCount,
    };
  }, [rooms, pendingRequests.incoming.length]);
}
