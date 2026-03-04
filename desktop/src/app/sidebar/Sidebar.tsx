import type { ReactNode } from "react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { secureSignOut } from "@/services/auth";
import { ThemePicker } from "./ThemePicker";
import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import Settings from "lucide-react/dist/esm/icons/settings";
import User from "lucide-react/dist/esm/icons/user";
import LogIn from "lucide-react/dist/esm/icons/log-in";

interface SidebarProps {
  hideThemePicker?: boolean;
  themePickerOpen?: boolean;
  onThemePickerOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
  onSignIn?: () => void;
  onConnect?: () => void;
  onSettings?: () => void;
  onStore?: () => void;
  onHome?: () => void;
  storeActive?: boolean;
}

type NavAction = "store" | "connect";

const navItems: { action: NavAction; label: string; icon: ReactNode }[] = [
  { action: "store", label: "App Store", icon: <LayoutGrid size={18} /> },
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
  onStore,
  onHome,
  storeActive,
}: SidebarProps) => {
  const actionHandlers: Record<NavAction, (() => void) | undefined> = {
    store: onStore,
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
            className={`sidebar-nav-item${item.action === "store" && storeActive ? " sidebar-nav-item--active" : ""}`}
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
