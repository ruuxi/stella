import type { ReactNode } from "react";
import { useCurrentUser } from "@/app/auth/hooks/use-current-user";
import { secureSignOut } from "@/app/auth/services/auth";
import { ThemePicker } from "../settings/ThemePicker";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import Settings from "lucide-react/dist/esm/icons/settings";
import User from "lucide-react/dist/esm/icons/user";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import "./sidebar.css";

interface SidebarProps {
  hideThemePicker?: boolean;
  themePickerOpen?: boolean;
  onThemePickerOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
  onSignIn?: () => void;
  onConnect?: () => void;
  onSettings?: () => void;
  onHome?: () => void;
}

type NavAction = "connect";

const navItems: { action: NavAction; label: string; icon: ReactNode }[] = [
  { action: "connect", label: "Connect", icon: <Link2 size={18} /> },
];

const AuthButton = ({
  onSignIn,
}: {
  onSignIn?: () => void;
}) => {
  const { user, isAuthenticated } = useCurrentUser();

  const label = isAuthenticated
    ? user?.name ?? user?.email ?? "Account"
    : "Sign in";

  return (
    <button
      type="button"
      className="sidebar-nav-item"
      onClick={() => {
        if (isAuthenticated) {
          void secureSignOut();
        } else {
          onSignIn?.();
        }
      }}
    >
      <span className="sidebar-nav-icon">
        {isAuthenticated ? <User size={18} /> : <LogIn size={18} />}
      </span>
      <span className="sidebar-nav-label">{label}</span>
    </button>
  );
};

export const Sidebar = ({
  hideThemePicker,
  themePickerOpen,
  onThemePickerOpenChange,
  onThemeSelect,
  onSignIn,
  onConnect,
  onSettings,
  onHome,
}: SidebarProps) => {
  const actionHandlers: Record<NavAction, (() => void) | undefined> = {
    connect: onConnect,
  };

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
        {navItems.map((item) => (
          <button
            key={item.action}
            className="sidebar-nav-item"
            type="button"
            onClick={actionHandlers[item.action]}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            <span className="sidebar-nav-label">{item.label}</span>
          </button>
        ))}
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
        <button type="button" className="sidebar-nav-item" onClick={onSettings}>
          <span className="sidebar-nav-icon">
            <Settings size={18} />
          </span>
          <span className="sidebar-nav-label">Settings</span>
        </button>
        <AuthButton onSignIn={onSignIn} />
      </div>
    </aside>
  );
};

