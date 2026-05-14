import type { SocialRoomSummary } from "./hooks/use-social-rooms";

export function getSocialRoomDisplayName(
  room: SocialRoomSummary,
  currentOwnerId: string,
): string {
  if (room.room.title) return room.room.title;

  switch (room.room.kind) {
    case "dm": {
      const other = room.memberProfiles.find(
        (member) => member.ownerId !== currentOwnerId,
      );
      return other ? `@${other.username}` : "Someone";
    }
    case "group":
      return (
        room.memberProfiles
          .filter((member) => member.ownerId !== currentOwnerId)
          .map((member) => `@${member.username}`)
          .join(", ") || "Group"
      );
    default: {
      const exhaustiveCheck: never = room.room.kind;
      return exhaustiveCheck;
    }
  }
}
