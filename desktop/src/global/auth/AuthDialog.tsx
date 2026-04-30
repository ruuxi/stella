import { useEffect, useState } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { MagicLinkAuthFlow } from "./MagicLinkAuthFlow";
import { useAuthSessionState } from "./hooks/use-auth-session-state";
import "./AuthDialog.css";

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AuthDialog = ({ open, onOpenChange }: AuthDialogProps) => {
  const { hasConnectedAccount } = useAuthSessionState();
  const [resetVersion, setResetVersion] = useState(0);

  useEffect(() => {
    if (hasConnectedAccount && open) {
      onOpenChange(false);
    }
  }, [hasConnectedAccount, open, onOpenChange]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setResetVersion((current) => current + 1);
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="auth-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>Welcome to Stella</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Sign in with your email to start using Stella.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="auth-dialog-close" />
        <DialogBody className="auth-dialog-body">
          <div className="auth-dialog-hero">
            <p className="auth-dialog-headline">Welcome to Stella</p>
            <p className="auth-dialog-sub">
              Sign in with your email — we'll send you a one-tap link.
            </p>
          </div>
          <MagicLinkAuthFlow
            key={resetVersion}
            className="auth-dialog-flow"
            hideEmailLabel
            inputVariant="normal"
            emailPlaceholder="you@example.com"
            autoFocus
            formClassName="auth-dialog-form"
            inputClassName="auth-dialog-input"
            buttonClassName="pill-btn pill-btn--primary pill-btn--lg auth-dialog-cta"
            buttonVariant="primary"
            buttonSize="large"
            submitLabel="Continue"
            sendingLabel="Sending..."
            resendLabel="Resend email"
            extrasClassName="auth-dialog-extras"
            extrasInnerClassName="auth-dialog-extras-inner"
            sentClassName="auth-dialog-sent"
            sentMessage="We sent a sign-in link. Open it on this device to finish."
            openInboxClassName="pill-btn pill-btn--primary pill-btn--lg auth-dialog-open-inbox"
            errorClassName="auth-dialog-error"
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
