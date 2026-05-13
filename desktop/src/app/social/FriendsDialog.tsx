import { useState, useCallback, useEffect } from "react";
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

export function FriendsDialog({
  open,
  onOpenChange,
  onStartChat,
}: FriendsDialogProps) {
  const { profile } = useSocialProfile();
  const {
    friends,
    pendingRequests,
    sendFriendRequest,
    acceptRequest,
    declineRequest,
    markIncomingFriendRequestsSeen,
    removeFriend,
  } = useSocialFriends();

  const [usernameInput, setUsernameInput] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingChatOwnerId, setPendingChatOwnerId] = useState<string | null>(
    null,
  );
  const [pendingActionOwnerId, setPendingActionOwnerId] = useState<
    string | null
  >(null);

  const handleAddFriend = useCallback(async () => {
    const username = usernameInput.trim().replace(/^@/, "").toLowerCase();
    if (!username) return;
    setSending(true);
    setStatus(null);
    try {
      await sendFriendRequest(username);
      setStatus({ type: "success", text: "Friend request sent!" });
      setUsernameInput("");
    } catch (err) {
      setStatus({
        type: "error",
        text: err instanceof Error ? err.message : "Something went wrong",
      });
    } finally {
      setSending(false);
    }
  }, [usernameInput, sendFriendRequest]);

  const runOwnerAction = useCallback(
    async (ownerId: string, action: () => Promise<unknown>) => {
      setPendingActionOwnerId(ownerId);
      try {
        await action();
      } finally {
        setPendingActionOwnerId(null);
      }
    },
    [],
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

  const handleCopyCode = useCallback(() => {
    if (!profile) return;
    void navigator.clipboard.writeText(`@${profile.username}`);
    setStatus({ type: "success", text: "Username copied!" });
  }, [profile]);

  const { incoming, outgoing } = pendingRequests;

  useEffect(() => {
    if (!open) return;
    if (incoming.length === 0) return;
    void markIncomingFriendRequestsSeen().catch(() => {
      // Best-effort notification marker; the next open will retry.
    });
  }, [incoming.length, markIncomingFriendRequestsSeen, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit className="friends-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>Friends</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Share your friend code to connect, or enter someone else&rsquo;s to
            send a request.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="friends-dialog-close" />
        <DialogBody className="friends-dialog-body">
          <header className="friends-dialog-header">
            <p className="friends-dialog-title">Friends</p>
            <p className="friends-dialog-sub">
              Share your username, or enter a friend&rsquo;s to connect.
            </p>
          </header>

          {profile ? (
            <button
              type="button"
              className="friends-code-card"
              onClick={handleCopyCode}
              title="Click to copy"
            >
              <div className="friends-code-card-info">
                <span className="friends-section-label">Your username</span>
                <span className="friends-code-card-value">
                  @{profile.username}
                </span>
              </div>
              <span className="pill-btn">Copy</span>
            </button>
          ) : null}

          <form
            className="friends-add-section"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddFriend();
            }}
          >
            <TextField
              label="Add a friend"
              hideLabel
              placeholder="Enter username"
              value={usernameInput}
              onChange={(e) => {
                setUsernameInput((e.target as HTMLInputElement).value);
                setStatus(null);
              }}
            />
            <button
              type="submit"
              className="pill-btn pill-btn--primary pill-btn--lg friends-add-button"
              disabled={!usernameInput.trim() || sending}
            >
              {sending ? "Adding..." : "Add"}
            </button>
          </form>

          {status ? (
            <div className="friends-status-message" data-type={status.type}>
              {status.text}
            </div>
          ) : null}

          {incoming.length > 0 ? (
            <section className="friends-section">
              <div className="friends-section-label">
                Requests ({incoming.length})
              </div>
              <div className="friends-list">
                {incoming.map((request) => {
                  const ownerId = request.relationship.requesterOwnerId;
                  const isPending = pendingActionOwnerId === ownerId;
                  return (
                    <div key={ownerId} className="friends-item">
                      <Avatar
                        fallback={request.profile.username}
                        src={request.profile.avatarUrl}
                        size="normal"
                      />
                      <div className="friends-item-info">
                        <div className="friends-item-name">
                          @{request.profile.username}
                        </div>
                      </div>
                      <div className="friends-item-actions">
                        <button
                          type="button"
                          className="pill-btn pill-btn--primary"
                          disabled={isPending}
                          onClick={() =>
                            void runOwnerAction(ownerId, () =>
                              acceptRequest(ownerId),
                            )
                          }
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="pill-btn"
                          disabled={isPending}
                          onClick={() =>
                            void runOwnerAction(ownerId, () =>
                              declineRequest(ownerId),
                            )
                          }
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {outgoing.length > 0 ? (
            <section className="friends-section">
              <div className="friends-section-label">Sent</div>
              <div className="friends-list">
                {outgoing.map((request) => (
                  <div
                    key={request.relationship.addresseeOwnerId}
                    className="friends-item"
                  >
                    <Avatar
                      fallback={request.profile.username}
                      src={request.profile.avatarUrl}
                      size="normal"
                    />
                    <div className="friends-item-info">
                      <div className="friends-item-name">
                        @{request.profile.username}
                      </div>
                      <div className="friends-item-tag">
                        Waiting for response
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="friends-section">
            <div className="friends-section-label">
              Friends{friends.length > 0 ? ` (${friends.length})` : ""}
            </div>
            {friends.length === 0 ? (
              <div className="friends-empty">
                No friends yet. Share your username or enter someone
                else&rsquo;s above to connect.
              </div>
            ) : (
              <div className="friends-list">
                {friends.map((friend) => {
                  const ownerId = friend.profile.ownerId;
                  const isOpening = pendingChatOwnerId === ownerId;
                  const isRemoving = pendingActionOwnerId === ownerId;
                  return (
                    <div key={ownerId} className="friends-item">
                      <Avatar
                        fallback={friend.profile.username}
                        src={friend.profile.avatarUrl}
                        size="normal"
                      />
                      <div className="friends-item-info">
                        <div className="friends-item-name">
                          @{friend.profile.username}
                        </div>
                      </div>
                      <div className="friends-item-actions">
                        <button
                          type="button"
                          className="pill-btn"
                          disabled={pendingChatOwnerId !== null}
                          onClick={() => void handleStartChat(ownerId)}
                        >
                          {isOpening ? "Opening..." : "Message"}
                        </button>
                        <button
                          type="button"
                          className="pill-btn pill-btn--danger"
                          disabled={isRemoving}
                          onClick={() =>
                            void runOwnerAction(ownerId, () =>
                              removeFriend(ownerId),
                            )
                          }
                        >
                          {isRemoving ? "Removing..." : "Remove"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
