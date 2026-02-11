import { useState, useMemo, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

const getCallbackUrl = () => {
  if (window.electronAPI) {
    const protocol = (import.meta.env.VITE_STELLA_PROTOCOL as string | undefined) ?? "Stella";
    return `${protocol}://auth`;
  }
  return (import.meta.env.VITE_SITE_URL as string | undefined) ?? window.location.origin;
};

interface InlineAuthProps {
  className?: string;
}

export function InlineAuth({ className }: InlineAuthProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const callbackURL = useMemo(getCallbackUrl, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setStatus("sending");
    try {
      await authClient.$fetch("/sign-in/magic-link", {
        method: "POST",
        body: { email: trimmed, callbackURL },
      });
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className={`onboarding-inline-auth ${className ?? ""}`}>
      {status === "sent" ? (
        <>
          <div className="onboarding-inline-auth-sent">
            check your inbox or spam for your sign-in link
          </div>
          <button
            type="button"
            className="onboarding-inline-auth-retry"
            onClick={() => { setStatus("idle"); setEmail(""); }}
          >
            go back
          </button>
        </>
      ) : (
        <>
          <div className="onboarding-inline-auth-label">enter email to get started</div>
          <form className="onboarding-inline-auth-form" onSubmit={handleSubmit}>
            <input
              type="email"
              className="onboarding-inline-auth-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
            />
            <button
              type="submit"
              className="onboarding-inline-auth-submit"
              disabled={status === "sending"}
            >
              {status === "sending" ? "sending..." : "send"}
            </button>
          </form>
          {status === "error" && (
            <div className="onboarding-inline-auth-error">something went wrong, try again</div>
          )}
        </>
      )}
    </div>
  );
}
