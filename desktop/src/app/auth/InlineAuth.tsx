import { cn } from "@/shared/lib/utils";
import { useMagicLinkAuth } from "./useMagicLinkAuth";

interface InlineAuthProps {
  className?: string;
  onSkip?: () => void;
}

export function InlineAuth({ className, onSkip }: InlineAuthProps) {
  const { email, setEmail, status, error, handleMagicLinkSubmit, reset } = useMagicLinkAuth();

  return (
    <div className={cn("onboarding-inline-auth", className)}>
      {status === "sent" ? (
        <>
          <div className="onboarding-inline-auth-sent">
            Check your inbox or spam for your sign-in link
          </div>
          <button
            type="button"
            className="onboarding-inline-auth-retry"
            onClick={reset}
          >
            Go Back
          </button>
        </>
      ) : (
        <>
          <div className="onboarding-inline-auth-label">Enter email to get started</div>
          <form className="onboarding-inline-auth-form" onSubmit={handleMagicLinkSubmit}>
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
              {status === "sending" ? "Sending..." : "Send"}
            </button>
          </form>
          {error && <div className="onboarding-inline-auth-error">{error}</div>}
        </>
      )}
      {onSkip && (
        <button type="button" className="onboarding-inline-auth-skip" onClick={onSkip}>
          Skip for now
        </button>
      )}
    </div>
  );
}
