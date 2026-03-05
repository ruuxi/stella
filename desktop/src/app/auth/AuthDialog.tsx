import { useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { useMagicLinkAuth } from "./useMagicLinkAuth";
import "./AuthDialog.css";

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AuthDialog = ({ open, onOpenChange }: AuthDialogProps) => {
  const { isAuthenticated } = useConvexAuth();
  const { email, setEmail, status, error, handleMagicLinkSubmit, reset } = useMagicLinkAuth();

  // Close dialog when user becomes authenticated
  useEffect(() => {
    if (isAuthenticated && open) {
      onOpenChange(false);
    }
  }, [isAuthenticated, open, onOpenChange]);

  const handleOpenChange = (newOpen: boolean) => {
    // Reset state when closing
    if (!newOpen) {
      reset();
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
          <form className="auth-dialog-form" onSubmit={handleMagicLinkSubmit}>
            <TextField
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
            <Button type="submit" variant="primary" size="large" className="auth-dialog-button">
              {status === "sending" ? "Sending..." : "Send sign-in email"}
            </Button>
          </form>

          {status === "sent" && (
            <div className="auth-dialog-status success">
              Check your inbox for the sign-in link.
            </div>
          )}
          {error && <div className="auth-dialog-status error">{error}</div>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

