import { useCallback, useEffect, useState } from "react";
import type { GeneratedPage } from "@/app/registry";
import { generatedPages, HOME_PAGE } from "@/app/registry";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { secureSignOut } from "@/global/auth/services/auth";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { getPlatform } from "@/platform/electron/platform";
import type { ViewType } from "@/shared/contracts/ui";
import type { LocalDevProjectRecord } from "@/shared/types/electron";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import AlertCircle from "lucide-react/dist/esm/icons/circle-alert";
import Folder from "lucide-react/dist/esm/icons/folder";
import House from "lucide-react/dist/esm/icons/house";
import Layout from "lucide-react/dist/esm/icons/layout-dashboard";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import PlusSquare from "lucide-react/dist/esm/icons/square-plus";
import Settings from "lucide-react/dist/esm/icons/settings";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import User from "lucide-react/dist/esm/icons/user";
import Users from "lucide-react/dist/esm/icons/users";
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
  onStore?: () => void;

  onChat?: () => void;
  onSocial?: () => void;
  onNewApp?: () => void;
  onNewAppAskStella?: () => void;
  onNewAppLocalProject?: () => void;
  activePageId: string | null;
  onPageSelect: (page: GeneratedPage) => void;
  projects?: LocalDevProjectRecord[];
  activeProjectId?: string | null;
  onProjectSelect?: (project: LocalDevProjectRecord) => void;
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
  onNewAppLocalProject,
  activePageId,
  onPageSelect,
  projects = [],
  activeProjectId,
  onProjectSelect,
}: SidebarProps) => {
  const isMac = getPlatform() === "darwin";
  const handleAskStella = onNewAppAskStella ?? onNewApp;
  const customPages = generatedPages.filter((page) => page.id !== HOME_PAGE.id);
  const getProjectMeta = (project: LocalDevProjectRecord) => {
    switch (project.runtime.status) {
      case "stopped":
        return "Ready to start";
      case "running":
        return "Live preview open";
      case "starting":
        return "Starting now";
      case "error":
        return "Needs attention";
      default: {
        const exhaustiveCheck: never = project.runtime.status;
        return exhaustiveCheck;
      }
    }
  };

  return (
    <aside className="sidebar">
      <div
        className={`sidebar-header${isMac ? " sidebar-header--mac" : ""}`}
      >
        {!isMac && <WindowControls />}
      </div>
      <button
        type="button"
        className="sidebar-brand"
        onClick={() => onPageSelect(HOME_PAGE)}
      >
        <div className="sidebar-brand-logo" aria-hidden="true">
          <img src="stella-logo.svg" alt="" className="sidebar-brand-logo-art" />
        </div>
        <span className="sidebar-brand-text">Stella</span>
      </button>
      <nav className="sidebar-nav">
        <button
          type="button"
          className={`sidebar-nav-item ${activePageId === HOME_PAGE.id ? "sidebar-nav-item--active" : ""}`}
          onClick={() => onPageSelect(HOME_PAGE)}
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
        {customPages.length > 0 && (
          <>
            {customPages.map((page) => (
              <button
                key={page.id}
                type="button"
                className={`sidebar-nav-item ${activePageId === page.id ? "sidebar-nav-item--active" : ""}`}
                onClick={() => onPageSelect(page)}
                title={page.title}
              >
                <span className="sidebar-nav-icon">
                  <Layout size={18} />
                </span>
                <span className="sidebar-nav-label">{page.title}</span>
              </button>
            ))}
          </>
        )}
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
            <DropdownMenuItem onClick={onNewAppLocalProject}>Local Project</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {projects.length > 0 && (
          <>
            <div className="sidebar-nav-section-label">Projects</div>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`sidebar-nav-item sidebar-nav-item--project ${activeProjectId === project.id ? "sidebar-nav-item--active" : ""}`}
                onClick={() => onProjectSelect?.(project)}
                title={project.name}
              >
                <span className="sidebar-nav-icon">
                  <Folder size={18} />
                </span>
                <span className="sidebar-project-copy">
                  <span className="sidebar-project-label">{project.name}</span>
                  <span className="sidebar-project-meta">{getProjectMeta(project)}</span>
                </span>
                {project.runtime.status === "running" && (
                  <span className="sidebar-page-status sidebar-page-status--ready" aria-label="Running" />
                )}
                {project.runtime.status === "starting" && (
                  <span className="sidebar-page-status sidebar-page-status--running" aria-label="Starting" />
                )}
                {project.runtime.status === "error" && (
                  <span className="sidebar-page-status sidebar-page-status--failed" aria-label="Error">
                    <AlertCircle size={12} />
                  </span>
                )}
              </button>
            ))}
          </>
        )}
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
        <button
          type="button"
          className={`sidebar-nav-item ${activeView === "store" ? "sidebar-nav-item--active" : ""}`}
          onClick={onStore}
        >
          <span className="sidebar-nav-icon">
            <Sparkles size={18} />
          </span>
          <span className="sidebar-nav-label">Store</span>
        </button>
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
