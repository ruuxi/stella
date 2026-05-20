import { useCallback, useEffect, useState } from "react";
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
import { authClient } from "./lib/auth-client";
import { useAuthSessionState } from "./hooks/use-auth-session-state";
import { openExternalUrl } from "@/platform/electron/open-external";
import "./AuthDialog.css";

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SocialSignInResult = {
  data?: {
    url?: string;
  } | null;
  error?: {
    message?: string;
    statusText?: string;
  } | null;
};

const getDesktopAuthCallbackUrl = () => {
  const protocol =
    (import.meta.env.VITE_STELLA_PROTOCOL as string | undefined)
      ?.replace("://", "")
      .replace(":", "")
      .trim()
      .toLowerCase() || "stella";
  return `${protocol}://auth/callback`;
};

export const AuthDialog = ({ open, onOpenChange }: AuthDialogProps) => {
  const { hasConnectedAccount } = useAuthSessionState();

  useEffect(() => {
    if (hasConnectedAccount && open) {
      onOpenChange(false);
    }
  }, [hasConnectedAccount, open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              Use Google or your email to sign in. No password needed.
            </p>
          </div>
          <GoogleAuthButton />
          <div className="auth-dialog-method-divider">
            <span>or use email</span>
          </div>
          <MagicLinkAuthFlow
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

function GoogleAuthButton() {
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = useCallback(async () => {
    setError(null);
    setIsSigningIn(true);

    try {
      const result = (await authClient.signIn.social({
        provider: "google",
        callbackURL: getDesktopAuthCallbackUrl(),
        disableRedirect: true,
      })) as SocialSignInResult | undefined;
      const url = result?.data?.url;

      if (result?.error || !url) {
        setError(
          result?.error?.message ||
            result?.error?.statusText ||
            "Google sign-in could not start.",
        );
        return;
      }

      openExternalUrl(url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Google sign-in could not start.",
      );
    } finally {
      setIsSigningIn(false);
    }
  }, []);

  return (
    <div className="auth-dialog-google-wrap">
      <button
        type="button"
        className="auth-dialog-google"
        onClick={handleSignIn}
        disabled={isSigningIn}
      >
        <GoogleIcon />
        {isSigningIn ? "Opening Google..." : "Continue with Google"}
      </button>
      {error ? <div className="auth-dialog-error">{error}</div> : null}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg
      className="auth-dialog-google-icon"
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.89 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.95-2.18l-2.91-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.71A5.41 5.41 0 0 1 3.69 9c0-.59.1-1.16.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
