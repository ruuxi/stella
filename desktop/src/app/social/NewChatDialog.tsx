import { useState, useCallback } from "react";
import { Check, UserPlus } from "lucide-react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { TextField } from "@/ui/text-field";
import { Avatar } from "@/ui/avatar";
import { useSocialFriends } from "./hooks/use-social-friends";

type NewChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFriend: (otherOwnerId: string) => Promise<boolean>;
  onCreateGroup: (title: string, memberOwnerIds: string[]) => Promise<boolean>;
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
  const [pendingFriendId, setPendingFriendId] = useState<string | null>(null);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);

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

  const handleCreateGroup = useCallback(async () => {
    setIsCreatingGroup(true);
    const didCreateGroup = await onCreateGroup(
      groupName.trim() || "Group",
      [...selectedIds],
    );
    setIsCreatingGroup(false);
    if (!didCreateGroup) {
      return;
    }
    handleOpenChange(false);
  }, [selectedIds, groupName, onCreateGroup, handleOpenChange]);

  const handleSelectFriend = useCallback(
    async (otherOwnerId: string) => {
      setPendingFriendId(otherOwnerId);
      const didOpenChat = await onSelectFriend(otherOwnerId);
      setPendingFriendId(null);
      if (!didOpenChat) {
        return;
      }
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectFriend],
  );

  if (friends.length === 0) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent fit className="friends-dialog-content">
          <VisuallyHidden asChild>
            <DialogTitle>New message</DialogTitle>
          </VisuallyHidden>
          <VisuallyHidden asChild>
            <DialogDescription>
              Add some friends first to start a conversation.
            </DialogDescription>
          </VisuallyHidden>
          <DialogCloseButton className="friends-dialog-close" />
          <DialogBody className="friends-dialog-body">
            <header className="friends-dialog-header">
              <p className="friends-dialog-title">New message</p>
              <p className="friends-dialog-sub">
                Add some friends first to start a conversation.
              </p>
            </header>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  if (mode === "group") {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent fit className="friends-dialog-content">
          <VisuallyHidden asChild>
            <DialogTitle>New group</DialogTitle>
          </VisuallyHidden>
          <VisuallyHidden asChild>
            <DialogDescription>
              Pick friends to add to this group.
            </DialogDescription>
          </VisuallyHidden>
          <DialogCloseButton className="friends-dialog-close" />
          <DialogBody className="friends-dialog-body">
            <header className="friends-dialog-header">
              <p className="friends-dialog-title">New group</p>
              <p className="friends-dialog-sub">
                Pick friends to add to this group.
              </p>
            </header>

            <TextField
              label="Group name"
              hideLabel
              placeholder="Group name (optional)"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />

            <section className="friends-section">
              <div className="friends-section-label">Members</div>
              <div className="friends-list">
                {friends.map((friend) => {
                  const isSelected = selectedIds.has(friend.profile.ownerId);
                  return (
                    <button
                      key={friend.profile.ownerId}
                      type="button"
                      className="new-chat-item"
                      data-selected={isSelected ? "true" : undefined}
                      onClick={() => toggleSelection(friend.profile.ownerId)}
                      disabled={isCreatingGroup}
                    >
                      <Avatar
                        fallback={friend.profile.username}
                        src={friend.profile.avatarUrl}
                        size="normal"
                      />
                      <span className="new-chat-item-name">
                        @{friend.profile.username}
                      </span>
                      {isSelected ? (
                        <Check
                          size={16}
                          className="new-chat-item-check"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="friends-dialog-footer">
              <button
                type="button"
                className="pill-btn pill-btn--lg"
                onClick={() => setMode("pick")}
                disabled={isCreatingGroup}
              >
                Back
              </button>
              <button
                type="button"
                className="pill-btn pill-btn--primary pill-btn--lg"
                disabled={selectedIds.size === 0 || isCreatingGroup}
                onClick={() => void handleCreateGroup()}
              >
                {isCreatingGroup ? "Creating..." : "Create group"}
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="friends-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>New message</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Pick a friend or start a new group conversation.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="friends-dialog-close" />
        <DialogBody className="friends-dialog-body">
          <header className="friends-dialog-header">
            <p className="friends-dialog-title">New message</p>
            <p className="friends-dialog-sub">
              Pick a friend or start a group.
            </p>
          </header>

          <div className="new-chat-list">
            <button
              type="button"
              className="new-chat-item"
              onClick={() => setMode("group")}
            >
              <span className="new-chat-item-icon">
                <UserPlus size={16} aria-hidden />
              </span>
              <span className="new-chat-item-name">New group</span>
            </button>

            <div className="friends-section-label new-chat-list-label">
              Friends
            </div>

            {friends.map((friend) => (
              <button
                key={friend.profile.ownerId}
                type="button"
                className="new-chat-item"
                disabled={pendingFriendId !== null}
                onClick={() => void handleSelectFriend(friend.profile.ownerId)}
              >
                <Avatar
                  fallback={friend.profile.username}
                  src={friend.profile.avatarUrl}
                  size="normal"
                />
                <span className="new-chat-item-name">
                  {pendingFriendId === friend.profile.ownerId
                    ? "Opening..."
                    : `@${friend.profile.username}`}
                </span>
              </button>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
