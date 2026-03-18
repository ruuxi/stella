import type { LocalDevProjectRecord } from "@/shared/types/electron";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { secureSignOut } from "@/global/auth/services/auth";
import { ThemePicker } from "@/global/settings/ThemePicker";
import type { ViewType } from "@/shared/contracts/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import AlertCircle from "lucide-react/dist/esm/icons/circle-alert";
import Folder from "lucide-react/dist/esm/icons/folder";
import House from "lucide-react/dist/esm/icons/house";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import PlusSquare from "lucide-react/dist/esm/icons/square-plus";
import Settings from "lucide-react/dist/esm/icons/settings";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import User from "lucide-react/dist/esm/icons/user";
import Users from "lucide-react/dist/esm/icons/users";
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
  onStore?: () => void;
  onHome?: () => void;
  onChat?: () => void;
  onSocial?: () => void;
  onNewApp?: () => void;
  onNewAppAskStella?: () => void;
  onNewAppLocalProject?: () => void;
  projects?: LocalDevProjectRecord[];
  activeProjectId?: string | null;
  onProjectSelect?: (project: LocalDevProjectRecord) => void;
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
  onStore,
  onHome,
  onChat,
  onSocial,
  onNewApp,
  onNewAppAskStella,
  onNewAppLocalProject,
  projects = [],
  activeProjectId,
  onProjectSelect,
}: SidebarProps) => {
  const handleAskStella = onNewAppAskStella ?? onNewApp;
  const getProjectMeta = (project: LocalDevProjectRecord) => {
    switch (project.runtime.status) {
      case "running":
        return "Live preview open";
      case "starting":
        return "Starting now";
      case "error":
        return "Needs attention";
      default:
        return "Ready to start";
    }
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
