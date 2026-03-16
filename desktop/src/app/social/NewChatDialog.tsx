import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
  DialogDescription,
} from "@/ui/dialog";
import { Avatar } from "@/ui/avatar";
import { useSocialFriends } from "./hooks/use-social-friends";

type NewChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFriend: (otherOwnerId: string) => void;
  onCreateGroup: (title: string, memberOwnerIds: string[]) => void;
};

export function NewChatDialog({
  open,
  onOpenChange,
  onSelectFriend,
  onCreateGroup,
}: NewChatDialogProps) {
  const { friends } = useSocialFriends();
  const [mode, setMode] = useState<"pick" | "group">("pick");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState("");

  const handleReset = useCallback(() => {
    setMode("pick");
    setSelectedIds(new Set());
    setGroupName("");
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) handleReset();
      onOpenChange(nextOpen);
    },
    [onOpenChange, handleReset],
  );

  const toggleSelection = useCallback((ownerId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) {
        next.delete(ownerId);
      } else {
        next.add(ownerId);
      }
      return next;
    });
  }, []);

  const handleCreateGroup = useCallback(() => {
    if (selectedIds.size === 0) return;
    const title = groupName.trim() || "Group";
    onCreateGroup(title, [...selectedIds]);
    handleOpenChange(false);
  }, [selectedIds, groupName, onCreateGroup, handleOpenChange]);

  if (friends.length === 0) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent fit>
          <DialogHeader>
            <DialogTitle>New message</DialogTitle>
            <DialogCloseButton />
          </DialogHeader>
          <DialogBody>
            <div className="friends-empty">
              Add some friends first to start a conversation.
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  if (mode === "group") {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent fit>
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogCloseButton />
          </DialogHeader>
          <DialogDescription>Pick friends to add to this group.</DialogDescription>
          <DialogBody>
            <div className="friends-dialog-body">
              <div className="friends-add-section">
                <input
                  className="social-composer-input"
                  style={{
                    background: "var(--background)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border)",
                    padding: "6px 12px",
                    fontSize: 14,
                  }}
                  placeholder="Group name (optional)"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </div>
              <div className="friends-list">
                {friends.map((f: unknown) => {
                  const friend = f as {
                    profile: {
                      nickname: string;
                      avatarUrl?: string;
                      ownerId: string;
                    };
                  };
                  const isSelected = selectedIds.has(friend.profile.ownerId);
                  return (
                    <button
                      key={friend.profile.ownerId}
                      type="button"
                      className="new-chat-item"
                      onClick={() => toggleSelection(friend.profile.ownerId)}
                      style={{
                        background: isSelected
                          ? "color-mix(in oklch, var(--foreground) 8%, transparent)"
                          : undefined,
                      }}
                    >
                      <Avatar
                        fallback={friend.profile.nickname}
                        src={friend.profile.avatarUrl}
                        size="normal"
                      />
                      <span className="new-chat-item-name">
                        {friend.profile.nickname}
                      </span>
                      {isSelected && (
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          style={{ marginLeft: "auto", color: "var(--interactive)" }}
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="friends-add-button"
                style={{ alignSelf: "flex-end" }}
                disabled={selectedIds.size === 0}
                onClick={handleCreateGroup}
              >
                Create group
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit>
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <div className="new-chat-list">
            <button
              type="button"
              className="new-chat-item"
              onClick={() => setMode("group")}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "var(--radius-sm)",
                  background:
                    "color-mix(in oklch, var(--foreground) 8%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-base)",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="19" y1="8" x2="19" y2="14" />
                  <line x1="22" y1="11" x2="16" y2="11" />
                </svg>
              </div>
              <span className="new-chat-item-name">New group</span>
            </button>

            <div
              className="friends-section-label"
              style={{ padding: "8px 12px 4px" }}
            >
              Friends
            </div>

            {friends.map((f: unknown) => {
              const friend = f as {
                profile: {
                  nickname: string;
                  avatarUrl?: string;
                  ownerId: string;
                };
              };
              return (
                <button
                  key={friend.profile.ownerId}
                  type="button"
                  className="new-chat-item"
                  onClick={() => {
                    onSelectFriend(friend.profile.ownerId);
                    handleOpenChange(false);
                  }}
                >
                  <Avatar
                    fallback={friend.profile.nickname}
                    src={friend.profile.avatarUrl}
                    size="normal"
                  />
                  <span className="new-chat-item-name">
                    {friend.profile.nickname}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
