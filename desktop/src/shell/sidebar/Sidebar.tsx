import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppMetadata } from "@/apps/_shared/app-metadata";
import { useTheme } from "@/context/theme-context";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { secureSignOut } from "@/global/auth/services/auth";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { getPlatform } from "@/platform/electron/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { ShiftingGradient } from "../background/ShiftingGradient";
import {
  CustomDevice as Device,
  CustomLogIn as LogIn,
  CustomPalette as Palette,
  CustomPlusSquare as PlusSquare,
  CustomUser as User,
} from "./SidebarIcons";
import "./sidebar.css";

/**
 * App discovery: every `desktop/src/apps/<id>/metadata.ts` is loaded eagerly
 * by Vite at build time, sorted by `order`, and split into top / bottom slots.
 *
 * Add a new app by dropping a `metadata.ts` into `desktop/src/apps/<id>/`.
 * No edits to this file are needed.
 */
const APP_MODULES = import.meta.glob<{ default: AppMetadata }>(
  "../../apps/*/metadata.ts",
  { eager: true },
);

const ALL_APPS: AppMetadata[] = Object.values(APP_MODULES)
  .map((m) => m.default)
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

const TOP_APPS = ALL_APPS.filter((a) => a.slot === "top");
const BOTTOM_APPS = ALL_APPS.filter((a) => a.slot === "bottom");

interface SidebarProps {
  className?: string;
  hideThemePicker?: boolean;
  themePickerOpen?: boolean;
  onThemePickerOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
  onSignIn?: () => void;
  onConnect?: () => void;
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

interface AppNavItemProps {
  app: AppMetadata;
}

const AppNavItem = ({ app }: AppNavItemProps) => {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(matchRoute({ to: app.route }));
  const Icon = app.icon;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (isActive && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
      }
    },
    [isActive, app],
  );

  return (
    <Link
      to={app.route}
      className={`sidebar-nav-item${isActive ? " sidebar-nav-item--active" : ""}`}
      onClick={handleClick}
    >
      <span className="sidebar-nav-icon">
        <Icon size={18} />
      </span>
      <span className="sidebar-nav-label">{app.label}</span>
    </Link>
  );
};

export const Sidebar = ({
  className,
  hideThemePicker,
  themePickerOpen,
  onThemePickerOpenChange,
  onThemeSelect,
  onSignIn,
  onConnect,
  onNewApp,
  onNewAppAskStella,
}: SidebarProps) => {
  const { gradientMode, gradientColor } = useTheme();
  const isMac = getPlatform() === "darwin";
  const handleAskStella = onNewAppAskStella ?? onNewApp;
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const isOnChatRoute = Boolean(matchRoute({ to: "/chat" }));

  const homeApp = useMemo(
    () => ALL_APPS.find((app) => app.id === "chat"),
    [],
  );

  const handleBrandClick = useCallback(() => {
    if (isOnChatRoute) {
      homeApp?.onActiveClick?.();
      return;
    }
    void navigate({ to: "/chat" });
  }, [isOnChatRoute, homeApp, navigate]);

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
        onClick={handleBrandClick}
      >
        <div className="sidebar-brand-logo" aria-hidden="true">
          <img src="stella-logo.svg" alt="" className="sidebar-brand-logo-art" />
        </div>
        <span className="sidebar-brand-text">Stella</span>
      </button>
      <nav className="sidebar-nav">
        {TOP_APPS.map((app) => (
          <AppNavItem key={app.id} app={app} />
        ))}
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
        </div>
        {BOTTOM_APPS.map((app) => (
          <AppNavItem key={app.id} app={app} />
        ))}
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
