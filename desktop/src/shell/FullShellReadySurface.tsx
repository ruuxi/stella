import {
  lazy,
  Suspense,
  startTransition,
  useCallback,
  useState,
} from "react";
import type { GeneratedPage } from "@/app/registry";
import { WorkspaceArea } from "@/app/workspace/WorkspaceArea";
import { useDevProjects } from "@/context/dev-projects-state";
import { useUiState } from "@/context/ui-state";
import { useWorkspace } from "@/context/workspace-state";
import { secureSignOut } from "@/global/auth/services/auth";
import type { DashboardState } from "@/global/onboarding/DiscoveryFlow";
import { dispatchCloseOrbChat, dispatchOpenOrbChat } from "@/shared/lib/stella-orb-chat";
import type { ChatContext } from "@/shared/types/electron";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { Sidebar } from "@/shell/sidebar/Sidebar";
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
  dashboardState: DashboardState;
  onboardingExiting: boolean;
};

export const FullShellReadySurface = ({
  dashboardState,
  onboardingExiting,
}: FullShellReadySurfaceProps) => {
  const { state, setView } = useUiState();
  const activeConversationId = state.conversationId;
  const { state: workspaceState, openPanel, closePanel } = useWorkspace();
  const activePanel = workspaceState.activePanel;
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [pendingAskStellaRequest, setPendingAskStellaRequest] =
    useState<PendingAskStellaRequest | null>(null);
  const [isOrbChatOpen, setIsOrbChatOpen] = useState(false);
  const { projects, pickProjectDirectory } = useDevProjects();

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

  const showHomeView = useCallback(() => {
    closePanel();
    setView("home");
  }, [closePanel, setView]);

  const showChatView = useCallback(() => {
    closePanel();
    setView("chat");
  }, [closePanel, setView]);

  const showSocialView = useCallback(() => {
    closePanel();
    setView("social");
  }, [closePanel, setView]);

  const handlePageSelect = useCallback(
    (page: GeneratedPage) => {
      openPanel({
        kind: "generated-page",
        name: page.id,
        title: page.title,
        pageId: page.id,
      });
      setView("app");
    },
    [openPanel, setView],
  );

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
      setView("home");
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

  const isOrbVisible = state.view !== "chat" && state.view !== "social";
  const activeProjectId =
    activePanel?.kind === "dev-project" ? activePanel.projectId : null;
  const activePageId =
    activePanel?.kind === "generated-page" ? activePanel.pageId : null;
  const showChatSurface = state.view === "chat" || state.view === "social";

  // ---- Context menu handlers ----

  const handleContextMenuOpenOrbChat = useCallback(
    (chatContext?: ChatContext | null) => {
      if (state.view === "chat" || state.view === "social") {
        setView("home");
      }

      dispatchOpenOrbChat({ chatContext: chatContext ?? null });
    },
    [setView, state.view],
  );

  return (
    <>
      <Sidebar
        activeView={state.view}
        onSignIn={showAuthDialog}
        onConnect={showConnectDialog}
        onSettings={showSettingsDialog}
        onStore={showStoreView}
        onHome={showHomeView}
        onChat={showChatView}
        onSocial={showSocialView}
        onNewAppAskStella={handleNewAppAskStella}
        onNewAppLocalProject={handleNewAppLocalProject}
        activePageId={activePageId}
        onPageSelect={handlePageSelect}
        dashboardState={dashboardState}
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectSelect={handleProjectSelect}
      />

      <StellaContextMenu
        isOrbChatOpen={isOrbChatOpen}
        onOpenOrbChat={handleContextMenuOpenOrbChat}
        onCloseOrbChat={dispatchCloseOrbChat}
      >
        <div className="content-area">
          {showChatSurface ? (
            <Suspense
              fallback={
                <WorkspaceArea
                  view="home"
                  activeDemo={null}
                  demoClosing={false}
                />
              }
            >
              <FullShellRuntime
                activeConversationId={activeConversationId}
                activeView={state.view}
                composerEntering={onboardingExiting}
                conversationId={activeConversationId}
                isOrbVisible={false}
                onSignIn={showAuthDialog}
                pendingAskStellaRequest={pendingAskStellaRequest}
                onPendingAskStellaHandled={handlePendingAskStellaHandled}
                onOrbChatOpenChange={setIsOrbChatOpen}
              />
            </Suspense>
          ) : (
            <>
              <WorkspaceArea
                view={state.view}
                activeDemo={null}
                demoClosing={false}
                conversationId={activeConversationId ?? undefined}
              />
              <Suspense fallback={null}>
                <FullShellRuntime
                  activeConversationId={activeConversationId}
                  activeView={state.view}
                  composerEntering={onboardingExiting}
                  conversationId={activeConversationId}
                  isOrbVisible={isOrbVisible}
                  onSignIn={showAuthDialog}
                  pendingAskStellaRequest={pendingAskStellaRequest}
                  onPendingAskStellaHandled={handlePendingAskStellaHandled}
                  onOrbChatOpenChange={setIsOrbChatOpen}
                />
              </Suspense>
            </>
          )}
        </div>
      </StellaContextMenu>

      <FullShellDialogs
        activeDialog={activeDialog}
        onDialogOpenChange={handleDialogOpenChange}
        onSignOut={handleSettingsSignOut}
      />

      <DisplayOverlay />
    </>
  );
};
