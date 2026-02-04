import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useConvexAuth } from "convex/react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/components/dialog";
import "./AuthDialog.css";

type Status = "idle" | "sending" | "sent" | "error";

const getCallbackUrl = () => {
  if (window.electronAPI) {
    const protocol = (import.meta.env.VITE_STELLA_PROTOCOL as string | undefined) ?? "Stella";
    return `${protocol}://auth`;
  }
  return (import.meta.env.VITE_SITE_URL as string | undefined) ?? window.location.origin;
};

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AuthDialog = ({ open, onOpenChange }: AuthDialogProps) => {
  const { isAuthenticated } = useConvexAuth();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const callbackURL = useMemo(() => getCallbackUrl(), []);

  // Close dialog when user becomes authenticated
  useEffect(() => {
    if (isAuthenticated && open) {
      onOpenChange(false);
    }
  }, [isAuthenticated, open, onOpenChange]);

  const handleMagicLink = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter an email address.");
      return;
    }
    setError(null);
    setStatus("sending");
    try {
      await authClient.$fetch("/sign-in/magic-link", {
        method: "POST",
        body: { email: trimmed, callbackURL },
      });
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError((err as Error)?.message ?? "Failed to send magic link.");
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    // Reset state when closing
    if (!newOpen) {
      setEmail("");
      setStatus("idle");
      setError(null);
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
        <DialogDescription>Sign in to sync your conversations and settings.</DialogDescription>
        <DialogBody>
          <form className="auth-dialog-form" onSubmit={handleMagicLink}>
            <TextField
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
            <Button type="submit" variant="primary" size="large" className="auth-dialog-button">
              {status === "sending" ? "Sending..." : "Send magic link"}
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
