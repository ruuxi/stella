import "./auth-panel.css";
import { MagicLinkAuthFlow } from "./MagicLinkAuthFlow";

export const AuthPanel = () => {
  return (
    <div className="auth-panel">
      <div className="auth-panel-card">
        <div className="auth-panel-header">
          <div className="auth-panel-title">Welcome to Stella</div>
          <div className="auth-panel-subtitle">Sign in to continue.</div>
        </div>

        <MagicLinkAuthFlow
          formClassName="auth-panel-form"
          buttonClassName="auth-panel-button"
          successClassName="auth-panel-status success"
          errorClassName="auth-panel-status error"
        />
      </div>
    </div>
  );
};
