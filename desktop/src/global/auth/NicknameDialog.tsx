import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import {
  hasNicknameBeenAsked,
  markNicknameAsked,
  useNickname,
} from "./hooks/use-nickname";
import "@/shell/sidebar/account-dialogs.css";

const NICKNAME_MAX_LENGTH = 40;

export function NicknameDialog() {
  const { nickname, email, hasConnectedAccount, setNickname } = useNickname();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hasConnectedAccount) return;
    if (!email) return;
    if (nickname) return;
    if (hasNicknameBeenAsked(email)) return;
    setDraft("");
    setOpen(true);
  }, [hasConnectedAccount, email, nickname]);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(handle);
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
    markNicknameAsked(email);
  }, [email]);

  const handleSave = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setNickname(trimmed);
    setOpen(false);
  }, [draft, setNickname]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent
        fit
        className="sidebar-nickname-dialog"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>What should I call you?</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sidebar-nickname-description">
          Pick a name for Stella to use across the app.
        </DialogDescription>
        <div className="sidebar-nickname-body">
          <TextField
            ref={inputRef as React.RefObject<HTMLInputElement>}
            label="Nickname"
            hideLabel
            placeholder="Your nickname"
            value={draft}
            maxLength={NICKNAME_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="sidebar-confirm-actions">
          <Button
            variant="ghost"
            size="large"
            className="pill-btn pill-btn--lg"
            onClick={handleClose}
          >
            Not now
          </Button>
          <Button
            variant="primary"
            size="large"
            className="pill-btn pill-btn--lg"
            onClick={handleSave}
            disabled={draft.trim().length === 0}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
