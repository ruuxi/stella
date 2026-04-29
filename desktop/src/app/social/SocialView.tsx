import { useState, useCallback, useEffect } from "react";
import { CollaborationIllustration } from "./CollaborationIllustration";
import { Copy, Globe, Pencil, SquarePen, Users } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { showToast } from "@/ui/toast";
import { getSocialActionErrorMessage } from "./social-errors";
import { useSocialProfile } from "./hooks/use-social-profile";
import { useSocialRooms, type SocialRoomSummary } from "./hooks/use-social-rooms";
import { getSocialRoomDisplayName } from "./room-display";
import { SocialChatPane } from "./SocialChatPane";
import { FriendsDialog } from "./FriendsDialog";
import { NewChatDialog } from "./NewChatDialog";
import "./social.css";

type SocialViewProps = {
  onSignIn: () => void;
};

function formatRoomTime(timestamp?: number): string {
  if (timestamp === undefined) return "";
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

function getRoomAvatar(
  room: SocialRoomSummary,
  currentOwnerId: string,
): { fallback: string; src?: string } {
  switch (room.room.kind) {
    case "dm": {
      const other = room.memberProfiles.find((member) => member.ownerId !== currentOwnerId);
      return {
        fallback: other?.nickname ?? "?",
        src: other?.avatarUrl,
      };
    }
    case "group":
      return { fallback: room.room.title ?? "G" };
    case "global":
      return { fallback: "Global" };
    default: {
      const exhaustiveCheck: never = room.room.kind;
      return exhaustiveCheck;
    }
  }
}

function hasUnread(room: SocialRoomSummary): boolean {
  if (room.room.latestMessageAt === undefined) return false;
  if (room.membership.lastReadAt === undefined) return true;
  return room.room.latestMessageAt > room.membership.lastReadAt;
}

export function SocialView({ onSignIn }: SocialViewProps) {
  const { profile, isSignedIn, ensureProfile, updateNickname } =
    useSocialProfile();
  const { rooms, openDm, createGroup, joinGlobalRoom, globalRoom } =
    useSocialRooms();

  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState("");
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [savingNickname, setSavingNickname] = useState(false);
  const [tagCopied, setTagCopied] = useState(false);

  useEffect(() => {
    if (isSignedIn && !profile) {
      void ensureProfile();
    }
  }, [isSignedIn, profile, ensureProfile]);

  const handleStartChat = useCallback(
    async (otherOwnerId: string) => {
      try {
        const result = await openDm(otherOwnerId);
        setActiveRoomId(result._id);
        return true;
      } catch (error) {
        showToast({
          variant: "error",
          description: getSocialActionErrorMessage(
            "Couldn't start that conversation. Please try again.",
            error,
          ),
        });
        return false;
      }
    },
    [openDm],
  );

  const handleCreateGroup = useCallback(
    async (title: string, memberOwnerIds: string[]) => {
      try {
        const result = await createGroup(title, memberOwnerIds);
        setActiveRoomId(result._id);
        return true;
      } catch (error) {
        showToast({
          variant: "error",
          description: getSocialActionErrorMessage(
            "Couldn't create the group. Please try again.",
            error,
          ),
        });
        return false;
      }
    },
    [createGroup],
  );

  const handleCopyTag = useCallback(() => {
    void navigator.clipboard.writeText(profile!.friendCode);
    setTagCopied(true);
    setTimeout(() => setTagCopied(false), 2000);
  }, [profile]);

  const handleSaveNickname = useCallback(async () => {
    const trimmed = nicknameInput.trim().replace(/\s+/g, " ");
    if (!profile) {
      setEditingNickname(false);
      return;
    }
    if (!trimmed) {
      setNicknameError("Name can't be empty.");
      return;
    }
    if (trimmed.length > 40) {
      setNicknameError("Name is too long (40 characters max).");
      return;
    }
    if (trimmed === profile.nickname) {
      setEditingNickname(false);
      setNicknameError(null);
      return;
    }
    setSavingNickname(true);
    try {
      await updateNickname(trimmed);
      setEditingNickname(false);
      setNicknameError(null);
    } catch (error) {
      setNicknameError(
        getSocialActionErrorMessage(
          "Couldn't update your name. Please try again.",
          error,
        ),
      );
    } finally {
      setSavingNickname(false);
    }
  }, [nicknameInput, profile, updateNickname]);

  const handleStartEditNickname = useCallback(() => {
    if (!profile) return;
    setNicknameInput(profile.nickname);
    setNicknameError(null);
    setEditingNickname(true);
  }, [profile]);

  const handleCancelEditNickname = useCallback(() => {
    setEditingNickname(false);
    setNicknameError(null);
  }, []);

  const handleOpenGlobalRoom = useCallback(async () => {
    try {
      const room = await joinGlobalRoom();
      setActiveRoomId(room._id);
    } catch (error) {
      showToast({
        variant: "error",
        description: getSocialActionErrorMessage(
          "Couldn't open Global Chat. Please try again.",
          error,
        ),
      });
    }
  }, [joinGlobalRoom]);

  if (!isSignedIn) {
    return (
      <div className="social-view">
        <div className="social-signin-gate">
          <div style={{ width: 240, height: 180, marginBottom: -10 }}>
            <CollaborationIllustration />
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

  return (
    <div className="social-view">
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

        <div className="social-room-list">
          <button
            type="button"
            className="social-room-item social-room-item--global"
            data-active={
              (globalRoom && activeRoomId === globalRoom.room._id) || undefined
            }
            onClick={() => void handleOpenGlobalRoom()}
          >
            <div className="social-room-item-avatar social-room-item-avatar--global">
              <Globe size={18} />
            </div>
            <div className="social-room-item-content">
              <div className="social-room-item-row">
                <span className="social-room-item-name">Global Chat</span>
                {globalRoom?.room.latestMessageAt !== undefined && (
                  <span className="social-room-item-time">
                    {formatRoomTime(globalRoom.room.latestMessageAt)}
                  </span>
                )}
              </div>
              <span className="social-room-item-preview">
                {globalRoom?.latestMessage?.body ??
                  "Open chat with everyone on Stella"}
              </span>
            </div>
            {globalRoom && hasUnread(globalRoom) && (
              <span className="social-room-item-unread" />
            )}
          </button>

          {rooms.length === 0 ? (
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
            rooms.map((room) => {
              const name = getSocialRoomDisplayName(room, currentOwnerId);
              const avatar = getRoomAvatar(room, currentOwnerId);
              const isActive = activeRoomId === room.room._id;
              const unread = hasUnread(room);

              return (
                <button
                  key={room.room._id}
                  type="button"
                  className="social-room-item"
                  data-active={isActive || undefined}
                  onClick={() => setActiveRoomId(room.room._id)}
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
                        {formatRoomTime(room.room.latestMessageAt)}
                      </span>
                    </div>
                    {room.latestMessage && (
                      <span className="social-room-item-preview">
                        {room.latestMessage.body}
                      </span>
                    )}
                  </div>
                  {unread && <span className="social-room-item-unread" />}
                </button>
              );
            })
          )}
        </div>

        {profile && (
          <div className="social-profile-card">
            <Avatar
              fallback={profile.nickname}
              src={profile.avatarUrl}
              size="normal"
            />
            <div className="social-profile-info">
              {editingNickname ? (
                <>
                  <input
                    className="social-profile-name-input"
                    value={nicknameInput}
                    maxLength={40}
                    placeholder="Your name"
                    onChange={(e) => {
                      setNicknameInput(e.target.value);
                      if (nicknameError) setNicknameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleSaveNickname();
                      }
                      if (e.key === "Escape") handleCancelEditNickname();
                    }}
                    disabled={savingNickname}
                    autoFocus
                  />
                  {nicknameError ? (
                    <span className="social-profile-error">
                      {nicknameError}
                    </span>
                  ) : (
                    <span className="social-profile-tag">
                      {profile.friendCode}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="social-profile-name social-profile-name-button"
                    title="Edit your name"
                    onClick={handleStartEditNickname}
                  >
                    {profile.nickname}
                    <Pencil size={11} aria-hidden />
                  </button>
                  <span
                    className="social-profile-tag"
                    title={
                      tagCopied
                        ? "Copied!"
                        : "Click to copy your friend code"
                    }
                    onClick={handleCopyTag}
                  >
                    {tagCopied ? "Copied!" : profile.friendCode}
                  </span>
                </>
              )}
            </div>
            {editingNickname ? (
              <div className="social-profile-edit-actions">
                <button
                  type="button"
                  className="social-sidebar-action"
                  title="Cancel"
                  onClick={handleCancelEditNickname}
                  disabled={savingNickname}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="social-sidebar-action social-sidebar-action--primary"
                  title="Save"
                  onClick={() => void handleSaveNickname()}
                  disabled={savingNickname || nicknameInput.trim().length === 0}
                >
                  {savingNickname ? "Saving..." : "Save"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="social-sidebar-action"
                title="Copy friend code"
                onClick={handleCopyTag}
                style={{ width: 28, height: 28 }}
              >
                <Copy size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {activeRoomId && currentOwnerId ? (
        <SocialChatPane
          roomId={activeRoomId}
          currentOwnerId={currentOwnerId}
        />
      ) : (
        <div className="social-chat-pane">
          <div className="social-empty-state">
            <div style={{ width: 200, height: 150, opacity: 0.8, marginBottom: -10 }}>
              <CollaborationIllustration />
            </div>
            <div className="social-empty-title">Your messages</div>
            <div className="social-empty-subtitle">
              Pick a conversation from the left, or start a new one with a friend.
            </div>
          </div>
        </div>
      )}

      <FriendsDialog
        open={friendsOpen}
        onOpenChange={setFriendsOpen}
        onStartChat={handleStartChat}
      />
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onSelectFriend={handleStartChat}
        onCreateGroup={handleCreateGroup}
      />
    </div>
  );
}
