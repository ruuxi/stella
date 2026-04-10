import {
  lazy,
  Suspense,
  startTransition,
  useCallback,
  useEffect,
  useState,
} from "react";
import { WorkspaceArea } from "@/app/workspace/WorkspaceArea";
import { useDevProjects } from "@/context/dev-projects-state";
import { useUiState } from "@/context/ui-state";
import { useWorkspace } from "@/context/workspace-state";
import { secureSignOut } from "@/global/auth/services/auth";
import { dispatchCloseSidebarChat, dispatchOpenSidebarChat, dispatchShowHome } from "@/shared/lib/stella-orb-chat";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { Sidebar } from "@/shell/sidebar/Sidebar";
import { WelcomeDialog } from "@/global/onboarding/WelcomeDialog";
import { WindowRadialOverlay } from "./WindowRadialOverlay";
import { DisplayOverlay } from "./DisplayOverlay";
import { FullShellDialogs } from "./full-shell-dialogs";
import type { DialogType } from "./full-shell-dialogs";

const FullShellRuntime = lazy(() =>
  import("./FullShellRuntime").then((module) => ({
    default: module.FullShellRuntime,
  })),
);

const NEW_APP_ASK_STELLA_PROMPT =
  "The user wants to create a new workspace (app) added to the sidebar with its own content. Be concise and provide 2-4 suggestions and ideas.";

type PendingAskStellaRequest = {
  id: number;
  text: string;
};

type FullShellReadySurfaceProps = {
  onboardingExiting: boolean;
};

export const FullShellReadySurface = ({
  onboardingExiting,
}: FullShellReadySurfaceProps) => {
  const { state, setView } = useUiState();
  const activeConversationId = state.conversationId;
  const { state: workspaceState, openPanel, closePanel } = useWorkspace();
  const activePanel = workspaceState.activePanel;
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [pendingAskStellaRequest, setPendingAskStellaRequest] =
    useState<PendingAskStellaRequest | null>(null);
  const [isSidebarChatOpen, setIsSidebarChatOpen] = useState(false);
  const [isShowingHomeContent, setIsShowingHomeContent] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { projects, pickProjectDirectory } = useDevProjects();

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const handler = () => { if (!mq.matches) setDrawerOpen(false); };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const showAuthDialog = useCallback(() => {
    setActiveDialog("auth");
  }, []);

  const showConnectDialog = useCallback(() => {
    setActiveDialog("connect");
  }, []);

  const showSettingsDialog = useCallback(() => {
    setActiveDialog("settings");
  }, []);

  const showStoreView = useCallback(() => {
    closePanel();
    setView("store");
  }, [closePanel, setView]);

  const showChatView = useCallback(() => {
    if (state.view === "chat") {
      dispatchShowHome();
      return;
    }
    closePanel();
    setView("chat");
  }, [closePanel, setView, state.view]);

  const showSocialView = useCallback(() => {
    closePanel();
    setView("social");
  }, [closePanel, setView]);

  const handlePendingAskStellaHandled = useCallback((requestId: number) => {
    setPendingAskStellaRequest((current) =>
      current?.id === requestId ? null : current,
    );
  }, []);

  const handleNewAppAskStella = useCallback(() => {
    startTransition(() => {
      setPendingAskStellaRequest({
        id: Date.now(),
        text: NEW_APP_ASK_STELLA_PROMPT,
      });
    });

    if (state.view === "chat") {
      closePanel();
      setView("app");
    }
  }, [closePanel, setView, state.view]);

  const handleProjectSelect = useCallback(
    (project: (typeof projects)[number]) => {
      openPanel({
        name: `dev-project:${project.id}`,
        title: project.name,
        kind: "dev-project",
        projectId: project.id,
      });
      setView("app");
    },
    [openPanel, setView],
  );

  const handleNewAppLocalProject = useCallback(async () => {
    const project = await pickProjectDirectory();
    if (!project) {
      return;
    }

    handleProjectSelect(project);
  }, [handleProjectSelect, pickProjectDirectory]);

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setActiveDialog(null);
    }
  }, []);

  const handleSettingsSignOut = useCallback(() => {
    setActiveDialog(null);
    void secureSignOut();
  }, []);

  const activeProjectId =
    activePanel?.kind === "dev-project" ? activePanel.projectId : null;
  const showChatSurface = state.view === "chat" || state.view === "social";

  const handleContextMenuOpenSidebarChat = useCallback(() => {
    if (state.view === "chat") return;

    dispatchOpenSidebarChat();
  }, [state.view]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <>
      {drawerOpen && (
        <div className="sidebar-drawer-scrim" onClick={closeDrawer} />
      )}

      <Sidebar
        className={drawerOpen ? "sidebar--drawer-open" : undefined}
        activeView={state.view}
        isShowingHomeContent={isShowingHomeContent}
        onSignIn={showAuthDialog}
        onConnect={showConnectDialog}
        onSettings={showSettingsDialog}
        onStore={showStoreView}
        onChat={() => { closeDrawer(); showChatView(); }}
        onSocial={() => { closeDrawer(); showSocialView(); }}
        onNewAppAskStella={() => { closeDrawer(); handleNewAppAskStella(); }}
        onNewAppLocalProject={() => { closeDrawer(); void handleNewAppLocalProject(); }}
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectSelect={(project) => { closeDrawer(); handleProjectSelect(project); }}
      />

      <StellaContextMenu
        isSidebarChatOpen={isSidebarChatOpen}
        onOpenSidebarChat={handleContextMenuOpenSidebarChat}
        onCloseSidebarChat={dispatchCloseSidebarChat}
      >
        <div className="content-area">
          <button
            type="button"
            className="compact-hamburger"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          {!showChatSurface && (
            <WorkspaceArea
              view={state.view}
              activeDemo={null}
              demoClosing={false}
            />
          )}
          <Suspense
            fallback={
              showChatSurface ? (
                <WorkspaceArea
                  view="chat"
                  activeDemo={null}
                  demoClosing={false}
                />
              ) : null
            }
          >
            <FullShellRuntime
              activeConversationId={activeConversationId}
              activeView={state.view}
              composerEntering={onboardingExiting}
              conversationId={activeConversationId}
              onSignIn={showAuthDialog}
              pendingAskStellaRequest={pendingAskStellaRequest}
              onPendingAskStellaHandled={handlePendingAskStellaHandled}
              onSidebarChatOpenChange={setIsSidebarChatOpen}
              onHomeContentChange={setIsShowingHomeContent}
            />
          </Suspense>
        </div>
      </StellaContextMenu>

      <FullShellDialogs
        activeDialog={activeDialog}
        onDialogOpenChange={handleDialogOpenChange}
        onSignOut={handleSettingsSignOut}
      />

      <WelcomeDialog
        conversationId={activeConversationId}
        onConnect={showConnectDialog}
      />

      <WindowRadialOverlay />
      <DisplayOverlay />
    </>
  );
};
