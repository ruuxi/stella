import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { Avatar } from "@/ui/avatar";
import { useSocialMessages } from "./hooks/use-social-messages";
import { SocialComposer } from "./SocialComposer";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";

type SocialChatPaneProps = {
  roomId: string;
  currentOwnerId: string;
};

type MessageDoc = {
  _id: string;
  senderOwnerId: string;
  kind: string;
  body: string;
  createdAt: number;
};

type RoomData = {
  room: { kind: string; title?: string };
  members: Array<{ ownerId: string; profile?: { nickname: string; avatarUrl?: string } }>;
  latestMessage?: { body: string };
};

function formatMessageTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function getRoomDisplayName(roomData: RoomData, currentOwnerId: string): string {
  if (roomData.room.title) return roomData.room.title;
  if (roomData.room.kind === "dm") {
    const other = roomData.members.find((m) => m.ownerId !== currentOwnerId);
    return other?.profile?.nickname ?? "Someone";
  }
  return "Group";
}

function getMemberCount(roomData: RoomData): number {
  return roomData.members.length;
}

function getProfileForOwner(
  roomData: RoomData | undefined,
  ownerId: string,
): { nickname: string; avatarUrl?: string } {
  const member = roomData?.members.find((m) => m.ownerId === ownerId);
  return member?.profile ?? { nickname: "Unknown" };
}

export function SocialChatPane({ roomId, currentOwnerId }: SocialChatPaneProps) {
  const roomData = useQuery(api.social.rooms.getRoom, { roomId }) as RoomData | undefined;
  const { messages, sendMessage } = useSocialMessages(roomId);

  // Group consecutive messages by same sender
  const messageGroups = useMemo(() => {
    if (!messages.length) return [];

    const groups: Array<{
      senderOwnerId: string;
      firstTimestamp: number;
      messages: MessageDoc[];
    }> = [];

    // Messages come newest-first from API, reverse for display
    const ordered = [...messages].reverse();

    for (const msg of ordered) {
      const last = groups[groups.length - 1];
      if (
        last &&
        last.senderOwnerId === msg.senderOwnerId &&
        msg.kind !== "system" &&
        last.messages[0]?.kind !== "system" &&
        msg.createdAt - last.messages[last.messages.length - 1].createdAt < 120_000
      ) {
        last.messages.push(msg);
      } else {
        groups.push({
          senderOwnerId: msg.senderOwnerId,
          firstTimestamp: msg.createdAt,
          messages: [msg],
        });
      }
    }

    return groups;
  }, [messages]);

  if (!roomData) {
    return <div className="social-chat-pane" />;
  }

  const displayName = getRoomDisplayName(roomData, currentOwnerId);
  const memberCount = getMemberCount(roomData);

  return (
    <div className="social-chat-pane">
      {/* Header */}
      <div className="social-chat-header">
        <div className="social-chat-header-info">
          <div className="social-chat-header-name">{displayName}</div>
          {memberCount > 2 && (
            <div className="social-chat-header-meta">
              {memberCount} people
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="social-messages-viewport">
        <div className="social-messages-container">
          {messageGroups.length === 0 && (
            <div className="social-empty-state">
              <div className="social-empty-icon">
                <MessageSquare size={22} />
              </div>
              <div className="social-empty-subtitle">
                Say hello to start the conversation
              </div>
            </div>
          )}
          {messageGroups.map((group) => {
            const isSelf = group.senderOwnerId === currentOwnerId;
            const isSystem = group.messages[0]?.kind === "system";
            const profile = getProfileForOwner(roomData, group.senderOwnerId);

            if (isSystem) {
              return group.messages.map((msg) => (
                <div key={msg._id} className="social-message-bubble" data-role="system">
                  {msg.body}
                </div>
              ));
            }

            return (
              <div key={group.messages[0]._id} className="social-message-group">
                {!isSelf && (
                  <div className="social-message-sender">
                    <Avatar
                      fallback={profile.nickname}
                      src={profile.avatarUrl}
                      size="small"
                    />
                    <span className="social-message-sender-name">
                      {profile.nickname}
                    </span>
                    <span className="social-message-sender-time">
                      {formatMessageTime(group.firstTimestamp)}
                    </span>
                  </div>
                )}
                {isSelf && (
                  <div className="social-message-sender" style={{ justifyContent: "flex-end" }}>
                    <span className="social-message-sender-time">
                      {formatMessageTime(group.firstTimestamp)}
                    </span>
                  </div>
                )}
                {group.messages.map((msg) => (
                  <div
                    key={msg._id}
                    className="social-message-bubble"
                    data-role={isSelf ? "self" : "other"}
                  >
                    {msg.body}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Composer */}
      <SocialComposer onSend={sendMessage} />
    </div>
  );
}
