import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Avatar } from "@/ui/avatar";
import { showToast } from "@/ui/toast";
import { Copy, Check, Send, Lock } from "lucide-react";
import { useSocialFriends } from "@/app/social/hooks/use-social-friends";
import type { StorePackageRecord } from "@/shared/types/electron";
import { buildShareLink } from "./share-link";
import "@/global/integrations/credential-modal.css";

type ShareAddonDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pkg: StorePackageRecord;
};

/**
 * Share an add-on with friends.
 *
 * Two paths:
 *   1. Multi-select friends → "Send" hands a one-line message
 *      (`stella://store/<handle>/<packageId>`) to each selected friend's
 *      DM via `getOrCreateDmRoom` + `sendRoomMessage`. The receiving
 *      chat detects the link and renders an `AddonShareCard`.
 *   2. "Copy link" copies the same URL to the clipboard so the user can
 *      paste it anywhere (the social chat will also render it as a card
 *      when pasted in a friend DM).
 *
 * Visibility rules: the share link resolves on the recipient side for
 * `public` and `unlisted` add-ons; `private` blocks every non-owner
 * read so the recipient would only see the "unavailable" fallback
 * card.
 *
 * To honour the user's intent ("share with this friend"), private
 * add-ons surface a one-click "Make unlisted to share" CTA at the top
 * of the dialog. This requires an explicit flip — we don't silently
 * change visibility — but keeps the path to actually delivering an
 * accessible link a single click. After flipping, the rest of the
 * dialog functions normally.
 */
export function ShareAddonDialog({ open, onOpenChange, pkg }: ShareAddonDialogProps) {
  const { friends } = useSocialFriends();
  const getOrCreateDm = useMutation(api.social.rooms.getOrCreateDmRoom);
  const sendRoomMessage = useMutation(api.social.messages.sendRoomMessage);
  const setVisibility = useMutation(api.data.store_packages.setPackageVisibility);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [promotingVisibility, setPromotingVisibility] = useState(false);

  // Visibility tier as the dialog sees it. `pkg` is a snapshot from
  // the parent's `usePaginatedQuery`; we shadow it with a local state
  // so the "Make unlisted" CTA can flip the dialog instantly without
  // waiting for a Convex round-trip / parent re-render.
  const [shadowVisibility, setShadowVisibility] = useState<
    "public" | "unlisted" | "private" | undefined
  >(pkg.visibility);
  const effectiveVisibility = shadowVisibility ?? pkg.visibility ?? "public";
  const isPrivate = effectiveVisibility === "private";

  // The link only resolves on the receiver's side when the package row
  // carries an `authorUsername` (stamped at publish time from
  // `social_profiles`). Without one the share link is meaningless —
  // surface a clear inline error rather than letting them send an
  // unresolvable link.
  const link = useMemo(
    () =>
      pkg.authorUsername
        ? buildShareLink(pkg.authorUsername, pkg.packageId)
        : null,
    [pkg.authorUsername, pkg.packageId],
  );

  // Reset transient state when the dialog opens/closes so a re-open
  // doesn't carry the previous selection or the copied-state flash.
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

  const handlePromoteToUnlisted = useCallback(async () => {
    if (promotingVisibility) return;
    setPromotingVisibility(true);
    try {
      await setVisibility({
        packageId: pkg.packageId,
        visibility: "unlisted",
      });
      setShadowVisibility("unlisted");
      showToast({ title: "Now unlisted — anyone with the link", variant: "success" });
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Couldn't update visibility",
        variant: "error",
      });
    } finally {
      setPromotingVisibility(false);
    }
  }, [promotingVisibility, setVisibility, pkg.packageId]);

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
      // Quick "Copied" affordance flip — clear after ~1.5s so a second
      // copy still feels responsive.
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      showToast({ title: "Couldn't copy link", variant: "error" });
    }
  }, [link]);

  const handleSend = useCallback(async () => {
    if (!link || selected.size === 0 || sending) return;
    setSending(true);
    try {
      // Fan out: per-friend, ensure the DM exists then send the link as
      // its own message. We do these sequentially rather than in
      // parallel because Convex mutations rate-limit per identity and
      // a burst of N concurrent sends can hit `RATE_STANDARD` for any
      // user with more than a handful of friends.
      let sent = 0;
      for (const ownerId of selected) {
        try {
          const room = await getOrCreateDm({ otherOwnerId: ownerId });
          await sendRoomMessage({ roomId: room._id, body: link });
          sent += 1;
        } catch (error) {
          // Best-effort per friend — surface a single aggregate toast
          // at the end rather than spamming one per failure.
          console.warn("[share-addon] send failed", ownerId, error);
        }
      }
      if (sent === selected.size) {
        showToast(
          sent === 1
            ? "Sent to 1 friend"
            : `Sent to ${sent} friends`,
        );
        handleOpenChange(false);
      } else if (sent > 0) {
        showToast({
          title: `Sent to ${sent} of ${selected.size} friends`,
        });
        handleOpenChange(false);
      } else {
        showToast({ title: "Couldn't send", variant: "error" });
      }
    } finally {
      setSending(false);
    }
  }, [link, selected, sending, getOrCreateDm, sendRoomMessage, handleOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="credential-modal-content share-addon-dialog">
        <DialogCloseButton className="credential-modal-close" />
        <DialogBody className="credential-modal-body">
          <div className="share-addon-dialog-intro">
            <DialogTitle className="share-addon-dialog-title">
              Share {pkg.displayName}
            </DialogTitle>
            <DialogDescription className="share-addon-dialog-description">
              {!link
                ? "This add-on doesn't have a public author username yet, so it can't be shared. Set a username in Settings first."
                : isPrivate
                  ? "This add-on is private. Make it unlisted so people you share with can install it."
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
                  Private add-ons can't be opened by anyone else
                </div>
                <div className="share-addon-private-banner-sub">
                  Switch to <strong>Unlisted</strong> so friends with the link
                  can install it. It still won't appear on the Store.
                </div>
              </div>
              <Button
                variant="primary"
                type="button"
                disabled={promotingVisibility}
                onClick={() => void handlePromoteToUnlisted()}
              >
                {promotingVisibility ? "Updating…" : "Make unlisted"}
              </Button>
            </div>
          ) : null}

          {link && !isPrivate ? (
            <div className="share-addon-link-row">
              <code className="share-addon-link">{link}</code>
              <Button variant="secondary" onClick={handleCopy} type="button">
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
                  onClick={handleSend}
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
