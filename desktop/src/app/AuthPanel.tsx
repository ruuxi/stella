import { useMemo, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";

type Status = "idle" | "sending" | "sent" | "error";

const getCallbackUrl = () => {
  if (window.electronAPI) {
    const protocol = (import.meta.env.VITE_STELLAR_PROTOCOL as string | undefined) ?? "stellar";
    return `${protocol}://auth`;
  }
  return (import.meta.env.VITE_SITE_URL as string | undefined) ?? window.location.origin;
};

export const AuthPanel = () => {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const callbackURL = useMemo(() => getCallbackUrl(), []);

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

  /*
  const handleSocial = async (provider: "google" | "github") => {
    setError(null);
    try {
      await authClient.signIn.social({ provider, callbackURL });
    } catch (err) {
      setError((err as Error)?.message ?? `Failed to sign in with ${provider}.`);
    }
  };
  */

  return (
    <div className="auth-panel">
      <div className="auth-panel-card">
        <div className="auth-panel-header">
          <div className="auth-panel-title">Welcome to Stellar</div>
          <div className="auth-panel-subtitle">Sign in to continue.</div>
        </div>

        {/* Social logins disabled for now. Re-enable by uncommenting handleSocial + buttons. */}
        {/*
        <div className="auth-panel-actions">
          <Button
            type="button"
            variant="primary"
            className="auth-panel-button auth-panel-google"
            onClick={() => handleSocial("google")}
          >
            Continue with Google
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="auth-panel-button auth-panel-github"
            onClick={() => handleSocial("github")}
          >
            Continue with GitHub
          </Button>
        </div>

        <div className="auth-panel-divider">
          <span>or</span>
        </div>
        */}

        <form className="auth-panel-form" onSubmit={handleMagicLink}>
          <TextField
            label="Email"
            type="email"
            placeholder="you@fromyou.ai"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
          <Button type="submit" variant="primary" className="auth-panel-button">
            {status === "sending" ? "Sending..." : "Send magic link"}
          </Button>
        </form>

        {status === "sent" && (
          <div className="auth-panel-status success">
            Check your inbox for the sign-in link.
          </div>
        )}
        {error && <div className="auth-panel-status error">{error}</div>}
      </div>
    </div>
  );
};
