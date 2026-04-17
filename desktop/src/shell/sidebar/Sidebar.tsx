import { useCallback, useEffect, useState } from "react";
import { useTheme } from "@/context/theme-context";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { secureSignOut } from "@/global/auth/services/auth";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { getPlatform } from "@/platform/electron/platform";
import type { ViewType } from "@/shared/contracts/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { ShiftingGradient } from "../background/ShiftingGradient";
import {
  CustomHouse as House,
  CustomDevice as Device,
  CustomLogIn as LogIn,
  CustomPalette as Palette,
  CustomPlusSquare as PlusSquare,
  CustomSettings as Settings,
  CustomStore as Store,
  CustomUser as User,
  CustomUsers as Users,
} from "./SidebarIcons";
import "./sidebar.css";

interface SidebarProps {
  className?: string;
  activeView?: ViewType;
  hideThemePicker?: boolean;
  themePickerOpen?: boolean;
  onThemePickerOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
  onSignIn?: () => void;
  onConnect?: () => void;
  onSettings?: () => void;
  onStore?: () => void;

  onChat?: () => void;
  onSocial?: () => void;
  onNewApp?: () => void;
  onNewAppAskStella?: () => void;
}

const MAXIMIZE_STATE_SYNC_DELAY_MS = 50;

const WindowControls = () => {
  const [isMaximized, setIsMaximized] = useState(false);

  const updateMaximizedState = useCallback(() => {
    const promise = window.electronAPI?.window.isMaximized?.();
    if (!promise) return;
    void promise.then((maximized) => setIsMaximized(Boolean(maximized)));
  }, []);

  useEffect(() => {
    updateMaximizedState();
  }, [updateMaximizedState]);

  return (
    <div className="sidebar-window-controls">
      <button
        className="sidebar-wc-btn"
        onClick={() => window.electronAPI?.window.minimize?.()}
        aria-label="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className="sidebar-wc-btn"
        onClick={() => {
          window.electronAPI?.window.maximize?.();
          window.setTimeout(updateMaximizedState, MAXIMIZE_STATE_SYNC_DELAY_MS);
        }}
        aria-label={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path fill="none" stroke="currentColor" strokeWidth="1" d="M2.5 0.5h7v7h-7zM0.5 2.5v7h7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        className="sidebar-wc-btn sidebar-wc-close"
        onClick={() => window.electronAPI?.window.close?.()}
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path stroke="currentColor" strokeWidth="1.2" d="M1 1l8 8M9 1l-8 8" />
        </svg>
      </button>
    </div>
  );
};

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
  className,
  activeView,
  hideThemePicker,
  themePickerOpen,
  onThemePickerOpenChange,
  onThemeSelect,
  onSignIn,
  onConnect,
  onSettings,
  onStore,
  onChat,
  onSocial,
  onNewApp,
  onNewAppAskStella,
}: SidebarProps) => {
  const { gradientMode, gradientColor } = useTheme();
  const isMac = getPlatform() === "darwin";
  const handleAskStella = onNewAppAskStella ?? onNewApp;

  return (
    <aside className={`sidebar${className ? ` ${className}` : ""}`}>
      <ShiftingGradient
        mode={gradientMode}
        colorMode={gradientColor}
        contained
      />
      <div className="sidebar-stack">
      <div
        className={`sidebar-header${isMac ? " sidebar-header--mac" : ""}`}
      >
        {!isMac && <WindowControls />}
      </div>
      <button
        type="button"
        className="sidebar-brand"
        onClick={onChat}
      >
        <div className="sidebar-brand-logo" aria-hidden="true">
          <img src="stella-logo.svg" alt="" className="sidebar-brand-logo-art" />
        </div>
        <span className="sidebar-brand-text">Stella</span>
      </button>
      <nav className="sidebar-nav">
        <button
          type="button"
          className={`sidebar-nav-item ${activeView === "chat" ? "sidebar-nav-item--active" : ""}`}
          onClick={onChat}
        >
          <span className="sidebar-nav-icon">
            <House size={18} />
          </span>
          <span className="sidebar-nav-label">Home</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item ${activeView === "social" ? "sidebar-nav-item--active" : ""}`}
          onClick={onSocial}
        >
          <span className="sidebar-nav-icon">
            <Users size={18} />
          </span>
          <span className="sidebar-nav-label">Social</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="sidebar-nav-item">
              <span className="sidebar-nav-icon">
                <PlusSquare size={18} />
              </span>
              <span className="sidebar-nav-label">New App</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onClick={handleAskStella}>Ask Stella</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-footer-row sidebar-footer-row--theme">
          <ThemePicker
            hideTrigger={hideThemePicker}
            open={themePickerOpen}
            onOpenChange={onThemePickerOpenChange}
            onThemeSelect={onThemeSelect}
            trigger={
              <button
                type="button"
                className="sidebar-icon-button"
                aria-label="Theme"
                title="Theme"
              >
                <Palette size={18} />
              </button>
            }
          />
          <button
            type="button"
            className="sidebar-icon-button"
            onClick={onSettings}
            title="Settings"
          >
            <Settings size={18} />
          </button>
        </div>
        <button
          type="button"
          className={`sidebar-nav-item ${activeView === "store" ? "sidebar-nav-item--active" : ""}`}
          onClick={onStore}
        >
          <span className="sidebar-nav-icon">
            <Store size={18} />
          </span>
          <span className="sidebar-nav-label">Store</span>
        </button>
        <button type="button" className="sidebar-nav-item" onClick={onConnect}>
          <span className="sidebar-nav-icon">
            <Device size={18} />
          </span>
          <span className="sidebar-nav-label">Connect</span>
        </button>
        <div className="sidebar-footer-row">
          <AuthButton onSignIn={onSignIn} />
        </div>
      </div>
      </div>
    </aside>
  );
};
