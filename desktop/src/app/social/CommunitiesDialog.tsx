import { useState, useCallback } from "react";
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
import { ChevronLeft } from "@/ui/icons";
import { useSocialCommunities } from "./hooks/use-social-communities";
import type { SocialRoomSummary } from "./hooks/use-social-rooms";
import { getSocialActionErrorMessage } from "./social-errors";

type CommunitiesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentOwnerId: string;
  onOpenRoom: (roomId: string) => void;
};

type StatusMessage = {
  type: "success" | "error";
  text: string;
};

/** "ABCD-EFGH" reads better than a raw 8-char run. */
function formatInviteCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function CommunitiesDialog({
  open,
  onOpenChange,
  currentOwnerId,
  onOpenRoom,
}: CommunitiesDialogProps) {
  const {
    communities,
    createCommunity,
    joinCommunity,
    renameCommunity,
    removeCommunityMember,
    leaveCommunity,
    deleteCommunity,
  } = useSocialCommunities();

  const [nameInput, setNameInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [managedRoomId, setManagedRoomId] = useState<string | null>(null);

  const managed =
    managedRoomId === null
      ? null
      : (communities.find((entry) => entry.room._id === managedRoomId) ?? null);

  const resetTransient = useCallback(() => {
    setStatus(null);
    setManagedRoomId(null);
    setNameInput("");
    setCodeInput("");
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) resetTransient();
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetTransient],
  );

  const runAction = useCallback(
    async (fallbackError: string, action: () => Promise<unknown>) => {
      setBusy(true);
      setStatus(null);
      try {
        await action();
        return true;
      } catch (error) {
        setStatus({
          type: "error",
          text: getSocialActionErrorMessage(fallbackError, error),
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleCreate = useCallback(async () => {
    const name = nameInput.trim();
    if (!name) return;
    const ok = await runAction(
      "Couldn't create that community. Please try again.",
      async () => {
        await createCommunity(name);
      },
    );
    if (ok) {
      setNameInput("");
      setStatus({ type: "success", text: `Created "${name}"!` });
    }
  }, [nameInput, createCommunity, runAction]);

  const handleJoin = useCallback(async () => {
    const code = codeInput.trim();
    if (!code) return;
    const ok = await runAction(
      "Couldn't join with that invite code. Check the code and try again.",
      async () => {
        await joinCommunity(code);
      },
    );
    if (ok) {
      setCodeInput("");
      setStatus({ type: "success", text: "You're in!" });
    }
  }, [codeInput, joinCommunity, runAction]);

  const handleOpenChat = useCallback(
    (roomId: string) => {
      onOpenRoom(roomId);
      handleOpenChange(false);
    },
    [onOpenRoom, handleOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="friends-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>Communities</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Create a community or join one with an invite code, then share
            add-ons with everyone in it.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="friends-dialog-close" />
        <DialogBody className="friends-dialog-body">
          {managed ? (
            <CommunityManagePane
              community={managed}
              currentOwnerId={currentOwnerId}
              busy={busy}
              status={status}
              setStatus={setStatus}
              runAction={runAction}
              onBack={() => {
                setManagedRoomId(null);
                setStatus(null);
              }}
              onClosed={() => setManagedRoomId(null)}
              onOpenChat={handleOpenChat}
              renameCommunity={renameCommunity}
              removeCommunityMember={removeCommunityMember}
              leaveCommunity={leaveCommunity}
              deleteCommunity={deleteCommunity}
            />
          ) : (
            <>
              <header className="friends-dialog-header">
                <p className="friends-dialog-title">Communities</p>
                <p className="friends-dialog-sub">
                  Trusted circles for sharing. Everyone in a community sees
                  what its members share.
                </p>
              </header>

              <form
                className="friends-add-section"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreate();
                }}
              >
                <TextField
                  label="Create a community"
                  hideLabel
                  placeholder="Name a new community"
                  value={nameInput}
                  maxLength={80}
                  onChange={(e) => {
                    setNameInput((e.target as HTMLInputElement).value);
                    setStatus(null);
                  }}
                />
                <button
                  type="submit"
                  className="pill-btn pill-btn--primary pill-btn--lg friends-add-button"
                  disabled={!nameInput.trim() || busy}
                >
                  Create
                </button>
              </form>

              <form
                className="friends-add-section"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleJoin();
                }}
              >
                <TextField
                  label="Join with an invite code"
                  hideLabel
                  placeholder="Enter an invite code"
                  value={codeInput}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setCodeInput((e.target as HTMLInputElement).value);
                    setStatus(null);
                  }}
                />
                <button
                  type="submit"
                  className="pill-btn pill-btn--lg friends-add-button"
                  disabled={!codeInput.trim() || busy}
                >
                  Join
                </button>
              </form>

              {status ? (
                <div className="friends-status-message" data-type={status.type}>
                  {status.text}
                </div>
              ) : null}

              <section className="friends-section">
                <div className="friends-section-label">
                  Your communities
                  {communities.length > 0 ? ` (${communities.length})` : ""}
                </div>
                {communities.length === 0 ? (
                  <div className="friends-empty">
                    No communities yet. Create one and share the invite code,
                    or join with a code someone sent you.
                  </div>
                ) : (
                  <div className="friends-list">
                    {communities.map((community) => {
                      const name = community.room.title ?? "Community";
                      const memberCount = community.memberProfiles.length;
                      return (
                        <div key={community.room._id} className="friends-item">
                          <Avatar fallback={name} size="normal" />
                          <div className="friends-item-info">
                            <div className="friends-item-name">{name}</div>
                            <div className="friends-item-tag">
                              {memberCount}{" "}
                              {memberCount === 1 ? "member" : "members"}
                              {community.membership.role === "owner"
                                ? " \u00b7 created by you"
                                : ""}
                            </div>
                          </div>
                          <div className="friends-item-actions">
                            <button
                              type="button"
                              className="pill-btn"
                              onClick={() => handleOpenChat(community.room._id)}
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              className="pill-btn"
                              onClick={() => {
                                setManagedRoomId(community.room._id);
                                setStatus(null);
                              }}
                            >
                              Details
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type CommunityManagePaneProps = {
  community: SocialRoomSummary;
  currentOwnerId: string;
  busy: boolean;
  status: StatusMessage | null;
  setStatus: (status: StatusMessage | null) => void;
  runAction: (
    fallbackError: string,
    action: () => Promise<unknown>,
  ) => Promise<boolean>;
  onBack: () => void;
  onClosed: () => void;
  onOpenChat: (roomId: string) => void;
  renameCommunity: (roomId: string, name: string) => Promise<unknown>;
  removeCommunityMember: (
    roomId: string,
    memberOwnerId: string,
  ) => Promise<unknown>;
  leaveCommunity: (roomId: string) => Promise<unknown>;
  deleteCommunity: (roomId: string) => Promise<unknown>;
};

function CommunityManagePane({
  community,
  currentOwnerId,
  busy,
  status,
  setStatus,
  runAction,
  onBack,
  onClosed,
  onOpenChat,
  renameCommunity,
  removeCommunityMember,
  leaveCommunity,
  deleteCommunity,
}: CommunityManagePaneProps) {
  const roomId = community.room._id;
  const name = community.room.title ?? "Community";
  const isCreator = community.membership.role === "owner";
  const inviteCode = community.room.inviteCode;

  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(name);
  const [codeCopied, setCodeCopied] = useState(false);
  const [confirmingDanger, setConfirmingDanger] = useState(false);
  const [pendingMemberOwnerId, setPendingMemberOwnerId] = useState<
    string | null
  >(null);

  const handleCopyCode = useCallback(() => {
    if (!inviteCode) return;
    void navigator.clipboard.writeText(formatInviteCode(inviteCode));
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  }, [inviteCode]);

  const handleRename = useCallback(async () => {
    const nextName = nameInput.trim();
    if (!nextName || nextName === name) {
      setEditingName(false);
      return;
    }
    const ok = await runAction(
      "Couldn't rename the community. Please try again.",
      async () => {
        await renameCommunity(roomId, nextName);
      },
    );
    if (ok) setEditingName(false);
  }, [nameInput, name, roomId, renameCommunity, runAction]);

  const handleRemoveMember = useCallback(
    async (memberOwnerId: string) => {
      setPendingMemberOwnerId(memberOwnerId);
      await runAction(
        "Couldn't remove that member. Please try again.",
        async () => {
          await removeCommunityMember(roomId, memberOwnerId);
        },
      );
      setPendingMemberOwnerId(null);
    },
    [roomId, removeCommunityMember, runAction],
  );

  const handleDanger = useCallback(async () => {
    if (!confirmingDanger) {
      setConfirmingDanger(true);
      return;
    }
    const ok = await runAction(
      isCreator
        ? "Couldn't delete the community. Please try again."
        : "Couldn't leave the community. Please try again.",
      async () => {
        if (isCreator) {
          await deleteCommunity(roomId);
        } else {
          await leaveCommunity(roomId);
        }
      },
    );
    setConfirmingDanger(false);
    if (ok) onClosed();
  }, [
    confirmingDanger,
    isCreator,
    roomId,
    deleteCommunity,
    leaveCommunity,
    runAction,
    onClosed,
  ]);

  return (
    <>
      <header className="friends-dialog-header communities-manage-header">
        <button
          type="button"
          className="pill-btn communities-back-button"
          onClick={onBack}
          disabled={busy}
        >
          <ChevronLeft size={14} aria-hidden />
          Back
        </button>
        {editingName ? (
          <form
            className="friends-add-section"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRename();
            }}
          >
            <TextField
              label="Community name"
              hideLabel
              placeholder="Community name"
              value={nameInput}
              maxLength={80}
              autoFocus
              onChange={(e) => {
                setNameInput((e.target as HTMLInputElement).value);
                setStatus(null);
              }}
            />
            <button
              type="submit"
              className="pill-btn pill-btn--primary friends-add-button"
              disabled={!nameInput.trim() || busy}
            >
              Save
            </button>
            <button
              type="button"
              className="pill-btn friends-add-button"
              onClick={() => {
                setEditingName(false);
                setNameInput(name);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <p className="friends-dialog-title">{name}</p>
            <p className="friends-dialog-sub">
              {isCreator
                ? "You created this community."
                : "You're a member of this community."}
            </p>
          </>
        )}
      </header>

      {inviteCode ? (
        <button
          type="button"
          className="friends-code-card"
          onClick={handleCopyCode}
          title="Click to copy"
        >
          <div className="friends-code-card-info">
            <span className="friends-section-label">Invite code</span>
            <span className="friends-code-card-value">
              {formatInviteCode(inviteCode)}
            </span>
          </div>
          <span className="pill-btn">{codeCopied ? "Copied!" : "Copy"}</span>
        </button>
      ) : null}
      <p className="communities-invite-hint">
        Anyone with this code can join, so only share it with people you
        trust.
      </p>

      {status ? (
        <div className="friends-status-message" data-type={status.type}>
          {status.text}
        </div>
      ) : null}

      <section className="friends-section">
        <div className="friends-section-label">
          Members ({community.memberProfiles.length})
        </div>
        <div className="friends-list">
          {community.memberProfiles.map((member) => {
            const isSelf = member.ownerId === currentOwnerId;
            const isMemberCreator =
              member.ownerId === community.room.createdByOwnerId;
            const isRemoving = pendingMemberOwnerId === member.ownerId;
            return (
              <div key={member.ownerId} className="friends-item">
                <Avatar
                  fallback={member.username}
                  src={member.avatarUrl}
                  size="normal"
                />
                <div className="friends-item-info">
                  <div className="friends-item-name">@{member.username}</div>
                  <div className="friends-item-tag">
                    {isMemberCreator ? "Creator" : "Member"}
                    {isSelf ? " \u00b7 you" : ""}
                  </div>
                </div>
                {isCreator && !isSelf ? (
                  <div className="friends-item-actions">
                    <button
                      type="button"
                      className="pill-btn pill-btn--danger"
                      disabled={busy}
                      onClick={() => void handleRemoveMember(member.ownerId)}
                    >
                      {isRemoving ? "Removing..." : "Remove"}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <div className="friends-dialog-footer communities-manage-footer">
        <button
          type="button"
          className="pill-btn pill-btn--danger"
          disabled={busy}
          onClick={() => void handleDanger()}
        >
          {isCreator
            ? confirmingDanger
              ? "Really delete this community?"
              : "Delete community"
            : confirmingDanger
              ? "Really leave?"
              : "Leave community"}
        </button>
        <span className="communities-footer-spacer" aria-hidden />
        {isCreator && !editingName ? (
          <button
            type="button"
            className="pill-btn"
            disabled={busy}
            onClick={() => {
              setNameInput(name);
              setEditingName(true);
              setConfirmingDanger(false);
            }}
          >
            Rename
          </button>
        ) : null}
        <button
          type="button"
          className="pill-btn pill-btn--primary"
          onClick={() => onOpenChat(roomId)}
        >
          Open chat
        </button>
      </div>
    </>
  );
}
