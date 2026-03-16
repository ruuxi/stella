import { useState, useCallback, useEffect } from "react";
import { Avatar } from "@/ui/avatar";
import { useSocialProfile } from "./hooks/use-social-profile";
import { useSocialRooms } from "./hooks/use-social-rooms";
import { SocialChatPane } from "./SocialChatPane";
import { FriendsDialog } from "./FriendsDialog";
import { NewChatDialog } from "./NewChatDialog";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import Users from "lucide-react/dist/esm/icons/users";
import SquarePen from "lucide-react/dist/esm/icons/square-pen";
import Copy from "lucide-react/dist/esm/icons/copy";
import "./social.css";

type SocialViewProps = {
  onSignIn: () => void;
};

type RoomEntry = {
  room: {
    _id: string;
    kind: string;
    title?: string;
    latestMessageAt?: number;
  };
  members: Array<{
    ownerId: string;
    profile?: { nickname: string; avatarUrl?: string };
  }>;
  latestMessage?: { body: string; senderOwnerId: string };
  membership: { lastReadAt?: number };
};

function formatRoomTime(timestamp?: number): string {
  if (!timestamp) return "";
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function getRoomName(
  room: RoomEntry,
  currentOwnerId: string,
): string {
  if (room.room.title) return room.room.title;
  if (room.room.kind === "dm") {
    const other = room.members.find((m) => m.ownerId !== currentOwnerId);
    return other?.profile?.nickname ?? "Someone";
  }
  return (
    room.members
      .filter((m) => m.ownerId !== currentOwnerId)
      .map((m) => m.profile?.nickname ?? "?")
      .join(", ") || "Group"
  );
}

function getRoomAvatar(
  room: RoomEntry,
  currentOwnerId: string,
): { fallback: string; src?: string } {
  if (room.room.kind === "dm") {
    const other = room.members.find((m) => m.ownerId !== currentOwnerId);
    return {
      fallback: other?.profile?.nickname ?? "?",
      src: other?.profile?.avatarUrl,
    };
  }
  return { fallback: room.room.title ?? "G" };
}

function hasUnread(room: RoomEntry): boolean {
  if (!room.room.latestMessageAt) return false;
  if (!room.membership.lastReadAt) return true;
  return room.room.latestMessageAt > room.membership.lastReadAt;
}

export function SocialView({ onSignIn }: SocialViewProps) {
  const { profile, isSignedIn, ensureProfile, updateNickname } =
    useSocialProfile();
  const { rooms, openDm, createGroup } = useSocialRooms();

  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState("");
  const [tagCopied, setTagCopied] = useState(false);

  // Ensure social profile exists when signed in
  useEffect(() => {
    if (isSignedIn && !profile) {
      void ensureProfile();
    }
  }, [isSignedIn, profile, ensureProfile]);

  const handleStartChat = useCallback(
    async (otherOwnerId: string) => {
      try {
        const result = await openDm(otherOwnerId);
        if (result?._id) {
          setActiveRoomId(result._id);
        }
      } catch {
        // silently handled
      }
    },
    [openDm],
  );

  const handleCreateGroup = useCallback(
    async (title: string, memberOwnerIds: string[]) => {
      try {
        const result = await createGroup(title, memberOwnerIds);
        if (result?._id) {
          setActiveRoomId(result._id);
        }
      } catch {
        // silently handled
      }
    },
    [createGroup],
  );

  const handleCopyTag = useCallback(() => {
    if (!profile?.friendCode) return;
    void navigator.clipboard.writeText(profile.friendCode);
    setTagCopied(true);
    setTimeout(() => setTagCopied(false), 2000);
  }, [profile]);

  const handleSaveNickname = useCallback(async () => {
    const trimmed = nicknameInput.trim();
    if (trimmed && trimmed !== profile?.nickname) {
      await updateNickname(trimmed);
    }
    setEditingNickname(false);
  }, [nicknameInput, profile?.nickname, updateNickname]);

  // --- Sign-in gate ---
  if (!isSignedIn) {
    return (
      <div className="social-view">
        <div className="social-signin-gate">
          <div className="social-empty-icon">
            <MessageSquare size={24} />
          </div>
          <div className="social-signin-title">Messages</div>
          <div className="social-signin-subtitle">
            Sign in to message friends and collaborate together with Stella.
          </div>
          <button
            type="button"
            className="social-signin-button"
            onClick={onSignIn}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  const currentOwnerId = profile?.ownerId ?? "";
  const typedRooms = (rooms as unknown as RoomEntry[]) ?? [];

  return (
    <div className="social-view">
      {/* Sidebar */}
      <div className="social-sidebar">
        <div className="social-sidebar-header">
          <span className="social-sidebar-title">Messages</span>
          <div className="social-sidebar-actions">
            <button
              type="button"
              className="social-sidebar-action"
              title="Friends"
              onClick={() => setFriendsOpen(true)}
            >
              <Users size={18} />
            </button>
            <button
              type="button"
              className="social-sidebar-action"
              title="New message"
              onClick={() => setNewChatOpen(true)}
            >
              <SquarePen size={18} />
            </button>
          </div>
        </div>

        {/* Room List */}
        <div className="social-room-list">
          {typedRooms.length === 0 ? (
            <div className="social-no-rooms">
              <div className="social-no-rooms-text">
                No conversations yet. Add friends or start a new message.
              </div>
              <button
                type="button"
                className="social-no-rooms-action"
                onClick={() => setFriendsOpen(true)}
              >
                <Users size={14} />
                Add friends
              </button>
            </div>
          ) : (
            typedRooms.map((entry) => {
              const name = getRoomName(entry, currentOwnerId);
              const avatar = getRoomAvatar(entry, currentOwnerId);
              const isActive = activeRoomId === entry.room._id;
              const unread = hasUnread(entry);
              return (
                <button
                  key={entry.room._id}
                  type="button"
                  className="social-room-item"
                  data-active={isActive || undefined}
                  onClick={() => setActiveRoomId(entry.room._id)}
                >
                  <div className="social-room-item-avatar">
                    <Avatar
                      fallback={avatar.fallback}
                      src={avatar.src}
                      size="normal"
                    />
                  </div>
                  <div className="social-room-item-content">
                    <div className="social-room-item-row">
                      <span className="social-room-item-name">{name}</span>
                      <span className="social-room-item-time">
                        {formatRoomTime(entry.room.latestMessageAt)}
                      </span>
                    </div>
                    {entry.latestMessage && (
                      <span className="social-room-item-preview">
                        {entry.latestMessage.body}
                      </span>
                    )}
                  </div>
                  {unread && <span className="social-room-item-unread" />}
                </button>
              );
            })
          )}
        </div>

        {/* Profile Card */}
        {profile && (
          <div className="social-profile-card">
            <Avatar
              fallback={profile.nickname}
              src={profile.avatarUrl}
              size="normal"
            />
            <div className="social-profile-info">
              {editingNickname ? (
                <input
                  className="social-composer-input"
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    padding: 0,
                    minHeight: "auto",
                    maxHeight: "none",
                  }}
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  onBlur={() => void handleSaveNickname()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveNickname();
                    if (e.key === "Escape") setEditingNickname(false);
                  }}
                  autoFocus
                />
              ) : (
                <span
                  className="social-profile-name"
                  title="Click to edit"
                  onClick={() => {
                    setNicknameInput(profile.nickname);
                    setEditingNickname(true);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {profile.nickname}
                </span>
              )}
              <span
                className="social-profile-tag"
                title={tagCopied ? "Copied!" : "Click to copy your friend code"}
                onClick={handleCopyTag}
              >
                {tagCopied ? "Copied!" : profile.friendCode}
              </span>
            </div>
            <button
              type="button"
              className="social-sidebar-action"
              title="Copy friend code"
              onClick={handleCopyTag}
              style={{ width: 28, height: 28 }}
            >
              <Copy size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Chat Pane */}
      {activeRoomId && currentOwnerId ? (
        <SocialChatPane
          roomId={activeRoomId}
          currentOwnerId={currentOwnerId}
        />
      ) : (
        <div className="social-chat-pane">
          <div className="social-empty-state">
            <div className="social-empty-icon">
              <MessageSquare size={22} />
            </div>
            <div className="social-empty-title">Your messages</div>
            <div className="social-empty-subtitle">
              Pick a conversation from the left, or start a new one with a friend.
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <FriendsDialog
        open={friendsOpen}
        onOpenChange={setFriendsOpen}
        onStartChat={(otherOwnerId) => void handleStartChat(otherOwnerId)}
      />
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onSelectFriend={(otherOwnerId) => void handleStartChat(otherOwnerId)}
        onCreateGroup={(title, ids) => void handleCreateGroup(title, ids)}
      />
    </div>
  );
}
