import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "@/ui/dialog";
import { TextField } from "@/ui/text-field";
import { Avatar } from "@/ui/avatar";
import { useSocialFriends } from "./hooks/use-social-friends";
import { useSocialProfile } from "./hooks/use-social-profile";

type FriendsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartChat: (otherOwnerId: string) => Promise<boolean>;
};

type StatusMessage = {
  type: "success" | "error";
  text: string;
};

export function FriendsDialog({ open, onOpenChange, onStartChat }: FriendsDialogProps) {
  const { profile } = useSocialProfile();
  const {
    friends,
    pendingRequests,
    sendFriendRequest,
    acceptRequest,
    declineRequest,
    removeFriend,
  } = useSocialFriends();

  const [friendCode, setFriendCode] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingChatOwnerId, setPendingChatOwnerId] = useState<string | null>(null);

  const handleAddFriend = useCallback(async () => {
    const code = friendCode.trim().toUpperCase();
    if (!code) return;
    setSending(true);
    setStatus(null);
    try {
      await sendFriendRequest(code);
      setStatus({ type: "success", text: "Friend request sent!" });
      setFriendCode("");
    } catch (err) {
      setStatus({
        type: "error",
        text: err instanceof Error ? err.message : "Something went wrong",
      });
    } finally {
      setSending(false);
    }
  }, [friendCode, sendFriendRequest]);

  const handleAccept = useCallback(
    async (requesterOwnerId: string) => {
      await acceptRequest(requesterOwnerId);
    },
    [acceptRequest],
  );

  const handleDecline = useCallback(
    async (requesterOwnerId: string) => {
      await declineRequest(requesterOwnerId);
    },
    [declineRequest],
  );

  const handleRemove = useCallback(
    async (otherOwnerId: string) => {
      await removeFriend(otherOwnerId);
    },
    [removeFriend],
  );

  const handleStartChat = useCallback(
    async (otherOwnerId: string) => {
      setPendingChatOwnerId(otherOwnerId);
      const didOpenChat = await onStartChat(otherOwnerId);
      setPendingChatOwnerId(null);
      if (!didOpenChat) {
        return;
      }
      onOpenChange(false);
    },
    [onOpenChange, onStartChat],
  );

  const { incoming, outgoing } = pendingRequests;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit>
        <DialogHeader>
          <DialogTitle>Friends</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <div className="friends-dialog-body">
            {profile && (
              <div style={{ marginBottom: 4 }}>
                <div className="friends-section-label">Your friend code</div>
                <div
                  className="social-profile-tag"
                  style={{ fontSize: 14, cursor: "pointer" }}
                  title="Click to copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(profile.friendCode);
                    setStatus({ type: "success", text: "Copied to clipboard!" });
                  }}
                >
                  {profile.friendCode}
                </div>
              </div>
            )}

            <div className="friends-add-section">
              <TextField
                label="Add a friend"
                hideLabel
                placeholder="Enter friend code"
                value={friendCode}
                onChange={(e) => {
                  setFriendCode((e.target as HTMLInputElement).value);
                  setStatus(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleAddFriend();
                  }
                }}
              />
              <button
                type="button"
                className="friends-add-button"
                onClick={() => void handleAddFriend()}
                disabled={!friendCode.trim() || sending}
              >
                Add
              </button>
            </div>

            {status && (
              <div className="friends-status-message" data-type={status.type}>
                {status.text}
              </div>
            )}

            {incoming.length > 0 && (
              <>
                <div className="friends-section-label">
                  Requests ({incoming.length})
                </div>
                <div className="friends-list">
                  {incoming.map((request) => (
                    <div key={request.relationship.requesterOwnerId} className="friends-item">
                      <Avatar
                        fallback={request.profile.nickname}
                        src={request.profile.avatarUrl}
                        size="normal"
                      />
                      <div className="friends-item-info">
                        <div className="friends-item-name">{request.profile.nickname}</div>
                        <div className="friends-item-tag">{request.profile.friendCode}</div>
                      </div>
                      <div className="friends-item-actions">
                        <button
                          type="button"
                          className="friends-item-action"
                          data-variant="primary"
                          onClick={() =>
                            void handleAccept(request.relationship.requesterOwnerId)
                          }
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="friends-item-action"
                          onClick={() =>
                            void handleDecline(request.relationship.requesterOwnerId)
                          }
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {outgoing.length > 0 && (
              <>
                <div className="friends-section-label">Sent</div>
                <div className="friends-list">
                  {outgoing.map((request) => (
                    <div key={request.relationship.addresseeOwnerId} className="friends-item">
                      <Avatar
                        fallback={request.profile.nickname}
                        src={request.profile.avatarUrl}
                        size="normal"
                      />
                      <div className="friends-item-info">
                        <div className="friends-item-name">{request.profile.nickname}</div>
                        <div className="friends-item-tag">Waiting for response</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="friends-section-label">
              Friends{friends.length > 0 ? ` (${friends.length})` : ""}
            </div>
            {friends.length === 0 ? (
              <div className="friends-empty">
                No friends yet. Share your friend code or enter someone else's above to connect.
              </div>
            ) : (
              <div className="friends-list">
                {friends.map((friend) => (
                  <div key={friend.profile.ownerId} className="friends-item">
                    <Avatar
                      fallback={friend.profile.nickname}
                      src={friend.profile.avatarUrl}
                      size="normal"
                    />
                    <div className="friends-item-info">
                      <div className="friends-item-name">{friend.profile.nickname}</div>
                      <div className="friends-item-tag">{friend.profile.friendCode}</div>
                    </div>
                    <div className="friends-item-actions">
                      <button
                        type="button"
                        className="friends-item-action"
                        disabled={pendingChatOwnerId !== null}
                        onClick={() => void handleStartChat(friend.profile.ownerId)}
                      >
                        {pendingChatOwnerId === friend.profile.ownerId
                          ? "Opening..."
                          : "Message"}
                      </button>
                      <button
                        type="button"
                        className="friends-item-action"
                        onClick={() => void handleRemove(friend.profile.ownerId)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
