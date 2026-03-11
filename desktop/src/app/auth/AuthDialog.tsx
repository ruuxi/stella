import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
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

  // Close dialog when user becomes authenticated
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
      <DialogContent fit>
        <DialogHeader>
          <DialogTitle>Welcome to Stella</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogDescription>Sign in with your email.</DialogDescription>
        <DialogBody>
          <MagicLinkAuthFlow
            key={resetVersion}
            formClassName="auth-dialog-form"
            buttonClassName="auth-dialog-button"
            buttonSize="large"
            successClassName="auth-dialog-status success"
            errorClassName="auth-dialog-status error"
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
