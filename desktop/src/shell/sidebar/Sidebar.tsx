import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { secureSignOut } from "@/global/auth/services/auth";
import { ThemePicker } from "@/global/settings/ThemePicker";
import type { ViewType } from "@/shared/contracts/ui";
import House from "lucide-react/dist/esm/icons/house";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import PlusSquare from "lucide-react/dist/esm/icons/square-plus";
import Settings from "lucide-react/dist/esm/icons/settings";
import User from "lucide-react/dist/esm/icons/user";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import "./sidebar.css";

interface SidebarProps {
  activeView?: ViewType;
  hideThemePicker?: boolean;
  themePickerOpen?: boolean;
  onThemePickerOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
  onSignIn?: () => void;
  onConnect?: () => void;
  onSettings?: () => void;
  onHome?: () => void;
  onChat?: () => void;
  onNewApp?: () => void;
}

const AuthButton = ({
  onSignIn,
}: {
  onSignIn?: () => void;
}) => {
  const { user, hasConnectedAccount } = useCurrentUser();

  const label = hasConnectedAccount
    ? user?.name ?? user?.email ?? "Account"
    : "Sign in";

  return (
    <button
      type="button"
      className="sidebar-nav-item"
      onClick={() => {
        if (hasConnectedAccount) {
          void secureSignOut();
        } else {
          onSignIn?.();
        }
      }}
    >
      <span className="sidebar-nav-icon">
        {hasConnectedAccount ? <User size={18} /> : <LogIn size={18} />}
      </span>
      <span className="sidebar-nav-label">{label}</span>
    </button>
  );
};

export const Sidebar = ({
  activeView,
  hideThemePicker,
  themePickerOpen,
  onThemePickerOpenChange,
  onThemeSelect,
  onSignIn,
  onConnect,
  onSettings,
  onHome,
  onChat,
  onNewApp,
}: SidebarProps) => {
  return (
    <aside className="sidebar">
      <div className="sidebar-header" />
      <button type="button" className="sidebar-brand" onClick={onHome}>
        <div className="sidebar-brand-logo" aria-hidden="true">
          <img src="stella-logo.svg" alt="" className="sidebar-brand-logo-art" />
        </div>
        <span className="sidebar-brand-text">Stella</span>
      </button>
      <nav className="sidebar-nav">
        <button
          type="button"
          className={`sidebar-nav-item ${activeView === "home" ? "sidebar-nav-item--active" : ""}`}
          onClick={onHome}
        >
          <span className="sidebar-nav-icon">
            <House size={18} />
          </span>
          <span className="sidebar-nav-label">Home</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeView === "chat" ? "sidebar-nav-item--active" : ""}`}
          onClick={onChat}
        >
          <span className="sidebar-nav-icon">
            <MessageSquare size={18} />
          </span>
          <span className="sidebar-nav-label">Chat</span>
        </button>
        <button type="button" className="sidebar-nav-item" onClick={onNewApp}>
          <span className="sidebar-nav-icon">
            <PlusSquare size={18} />
          </span>
          <span className="sidebar-nav-label">New App</span>
        </button>
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-footer-item">
          <ThemePicker
            hideTrigger={hideThemePicker}
            open={themePickerOpen}
            onOpenChange={onThemePickerOpenChange}
            onThemeSelect={onThemeSelect}
          />
        </div>
        <button type="button" className="sidebar-nav-item" onClick={onConnect}>
          <span className="sidebar-nav-icon">
            <Link2 size={18} />
          </span>
          <span className="sidebar-nav-label">Connect</span>
        </button>
        <div className="sidebar-footer-row">
          <AuthButton onSignIn={onSignIn} />
          <button
            type="button"
            className="sidebar-icon-button"
            onClick={onSettings}
            title="Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
};

