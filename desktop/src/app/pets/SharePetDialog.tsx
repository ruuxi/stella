import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { Check, Copy, Lock, Send } from "lucide-react";
import { api } from "@/convex/api";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Avatar } from "@/ui/avatar";
import { showToast } from "@/ui/toast";
import { useSocialFriends } from "@/app/social/hooks/use-social-friends";
import type { UserPetRecord, UserPetVisibility } from "./user-pet-data";
import { getUserPetShareLink } from "./user-pet-share";
import "@/global/integrations/credential-modal.css";

type SharePetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pet: UserPetRecord;
};

export function SharePetDialog({
  open,
  onOpenChange,
  pet,
}: SharePetDialogProps) {
  const { friends } = useSocialFriends();
  const getOrCreateDm = useMutation(api.social.rooms.getOrCreateDmRoom);
  const sendRoomMessage = useMutation(api.social.messages.sendRoomMessage);
  const setVisibility = useMutation(api.data.user_pets.setVisibility);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [shadowVisibility, setShadowVisibility] = useState<
    UserPetVisibility | undefined
  >(pet.visibility);
  const effectiveVisibility = shadowVisibility ?? pet.visibility;
  const isPrivate = effectiveVisibility === "private";

  const link = useMemo(() => getUserPetShareLink(pet), [pet]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelected(new Set());
        setLinkCopied(false);
        setShadowVisibility(undefined);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handlePromote = useCallback(async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      await setVisibility({ petId: pet.petId, visibility: "unlisted" });
      setShadowVisibility("unlisted");
      showToast({
        title: "Now unlisted — anyone with the link",
        variant: "success",
      });
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Couldn't update visibility",
        variant: "error",
      });
    } finally {
      setPromoting(false);
    }
  }, [pet.petId, promoting, setVisibility]);

  const toggleFriend = useCallback((ownerId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });
  }, []);

  const handleCopy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      showToast("Link copied");
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      showToast({ title: "Couldn't copy link", variant: "error" });
    }
  }, [link]);

  const handleSend = useCallback(async () => {
    if (!link || selected.size === 0 || sending) return;
    setSending(true);
    try {
      let sent = 0;
      for (const ownerId of selected) {
        try {
          const room = await getOrCreateDm({ otherOwnerId: ownerId });
          await sendRoomMessage({ roomId: room._id, body: link });
          sent += 1;
        } catch {
          // best-effort; aggregate at the end
        }
      }
      if (sent === selected.size) {
        showToast(sent === 1 ? "Sent to 1 friend" : `Sent to ${sent} friends`);
        handleOpenChange(false);
      } else if (sent > 0) {
        showToast({ title: `Sent to ${sent} of ${selected.size} friends` });
        handleOpenChange(false);
      } else {
        showToast({ title: "Couldn't send", variant: "error" });
      }
    } finally {
      setSending(false);
    }
  }, [
    getOrCreateDm,
    handleOpenChange,
    link,
    selected,
    sendRoomMessage,
    sending,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="credential-modal-content share-addon-dialog">
        <DialogCloseButton className="credential-modal-close" />
        <DialogBody className="credential-modal-body">
          <div className="share-addon-dialog-intro">
            <DialogTitle className="share-addon-dialog-title">
              Share {pet.displayName}
            </DialogTitle>
            <DialogDescription className="share-addon-dialog-description">
              {!link
                ? "This pet doesn't have a public author handle yet, so it can't be shared."
                : isPrivate
                  ? "This pet is private. Make it unlisted so people you share with can use it."
                  : "Send to friends or copy a link to share anywhere."}
            </DialogDescription>
          </div>
          {link && isPrivate ? (
            <div className="share-addon-private-banner">
              <div className="share-addon-private-banner-icon" aria-hidden>
                <Lock size={14} />
              </div>
              <div className="share-addon-private-banner-text">
                <div className="share-addon-private-banner-title">
                  Private pets can't be opened by anyone else
                </div>
                <div className="share-addon-private-banner-sub">
                  Switch to <strong>Unlisted</strong> so friends with the link
                  can use it. It still won't appear on the Store.
                </div>
              </div>
              <Button
                variant="primary"
                type="button"
                disabled={promoting}
                onClick={() => void handlePromote()}
              >
                {promoting ? "Updating…" : "Make unlisted"}
              </Button>
            </div>
          ) : null}

          {link && !isPrivate ? (
            <div className="share-addon-link-row">
              <code className="share-addon-link">{link}</code>
              <Button variant="secondary" type="button" onClick={handleCopy}>
                {linkCopied ? (
                  <>
                    <Check size={14} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={14} /> Copy link
                  </>
                )}
              </Button>
            </div>
          ) : null}

          {link && !isPrivate ? (
            <div className="share-addon-friends">
              <div className="share-addon-friends-header">
                Send to friends
                {selected.size > 0 ? (
                  <span className="share-addon-friends-count">
                    {selected.size} selected
                  </span>
                ) : null}
              </div>
              {friends.length === 0 ? (
                <div className="share-addon-empty">
                  No friends yet. Add a friend in Social to share directly.
                </div>
              ) : (
                <div className="share-addon-friend-list">
                  {friends.map((friend) => {
                    const isSelected = selected.has(friend.profile.ownerId);
                    return (
                      <button
                        key={friend.profile.ownerId}
                        type="button"
                        className="share-addon-friend-row"
                        data-selected={isSelected || undefined}
                        onClick={() => toggleFriend(friend.profile.ownerId)}
                      >
                        <Avatar
                          src={friend.profile.avatarUrl}
                          fallback={friend.profile.username}
                          size="small"
                        />
                        <span className="share-addon-friend-name">
                          @{friend.profile.username}
                        </span>
                        <span className="share-addon-friend-check" aria-hidden>
                          {isSelected ? <Check size={14} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="share-addon-actions">
                <Button
                  variant="primary"
                  type="button"
                  disabled={selected.size === 0 || sending}
                  onClick={() => void handleSend()}
                >
                  <Send size={14} />
                  {sending
                    ? "Sending…"
                    : selected.size === 0
                    ? "Send"
                    : selected.size === 1
                    ? "Send to 1 friend"
                    : `Send to ${selected.size} friends`}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
