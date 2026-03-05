import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { useMagicLinkAuth } from "./useMagicLinkAuth";

export const AuthPanel = () => {
  const { email, setEmail, status, error, handleMagicLinkSubmit } = useMagicLinkAuth();

  return (
    <div className="auth-panel">
      <div className="auth-panel-card">
        <div className="auth-panel-header">
          <div className="auth-panel-title">Welcome to Stella</div>
          <div className="auth-panel-subtitle">Sign in to continue.</div>
        </div>

        <form className="auth-panel-form" onSubmit={handleMagicLinkSubmit}>
          <TextField
            label="Email"
            type="email"
            placeholder="you@fromyou.ai"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
          <Button type="submit" variant="primary" className="auth-panel-button">
            {status === "sending" ? "Sending..." : "Send sign-in email"}
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

