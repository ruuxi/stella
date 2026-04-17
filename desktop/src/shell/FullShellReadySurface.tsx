import {
  lazy,
  Suspense,
  startTransition,
  useCallback,
  useEffect,
  useState,
} from "react";
import { WorkspaceArea } from "@/app/workspace/WorkspaceArea";
import { useUiState } from "@/context/ui-state";
import { secureSignOut } from "@/global/auth/services/auth";
import {
  dispatchCloseDisplaySidebar,
  dispatchCloseSidebarChat,
  dispatchOpenSidebarChat,
} from "@/shared/lib/stella-orb-chat";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { Sidebar } from "@/shell/sidebar/Sidebar";
import { WelcomeDialog } from "@/global/onboarding/WelcomeDialog";
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
  /**
   * True while the onboarding splash is animating out. Currently consumed
   * by sub-surfaces (kept on the type so callers don't have to change), but
   * the home page no longer needs to coordinate any composer-entering
   * animation since the composer lives in the sidebar.
   */
  onboardingExiting?: boolean;
};

export const FullShellReadySurface = ({
  onboardingExiting: _onboardingExiting,
}: FullShellReadySurfaceProps) => {
  const { state, setView } = useUiState();
  const activeConversationId = state.conversationId;
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [pendingAskStellaRequest, setPendingAskStellaRequest] =
    useState<PendingAskStellaRequest | null>(null);
  const [isSidebarChatOpen, setIsSidebarChatOpen] = useState(false);
  const [isDisplaySidebarOpen, setIsDisplaySidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
    setView("store");
  }, [setView]);

  const showChatView = useCallback(() => {
    if (state.view === "chat") {
      return;
    }
    setView("chat");
  }, [setView, state.view]);

  const showSocialView = useCallback(() => {
    setView("social");
  }, [setView]);

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
      setView("app");
    }
  }, [setView, state.view]);

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setActiveDialog(null);
    }
  }, []);

  const handleSettingsSignOut = useCallback(() => {
    setActiveDialog(null);
    void secureSignOut();
  }, []);

  const showChatSurface = state.view === "chat" || state.view === "social";

  // Right-click toggles the chat sidebar from any view. When the display
  // sidebar happens to be open (a runtime-driven HTML panel), favor closing
  // it first so the same gesture dismisses whichever overlay is showing.
  const handleContextMenuOpenSidebarChat = useCallback(() => {
    dispatchOpenSidebarChat();
  }, []);

  const handleContextMenuCloseSidebarChat = useCallback(() => {
    if (isDisplaySidebarOpen) {
      dispatchCloseDisplaySidebar();
      return;
    }
    dispatchCloseSidebarChat();
  }, [isDisplaySidebarOpen]);

  const isContextMenuPanelOpen = isSidebarChatOpen || isDisplaySidebarOpen;

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <>
      {drawerOpen && (
        <div className="sidebar-drawer-scrim" onClick={closeDrawer} />
      )}

      <Sidebar
        className={drawerOpen ? "sidebar--drawer-open" : undefined}
        activeView={state.view}
        onSignIn={showAuthDialog}
        onConnect={showConnectDialog}
        onSettings={showSettingsDialog}
        onStore={showStoreView}
        onChat={() => { closeDrawer(); showChatView(); }}
        onSocial={() => { closeDrawer(); showSocialView(); }}
        onNewAppAskStella={() => { closeDrawer(); handleNewAppAskStella(); }}
      />

      <StellaContextMenu
        isOpen={isContextMenuPanelOpen}
        onOpen={handleContextMenuOpenSidebarChat}
        onClose={handleContextMenuCloseSidebarChat}
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
              conversationId={activeConversationId}
              onSignIn={showAuthDialog}
              pendingAskStellaRequest={pendingAskStellaRequest}
              onPendingAskStellaHandled={handlePendingAskStellaHandled}
              onSidebarChatOpenChange={setIsSidebarChatOpen}
              onDisplaySidebarOpenChange={setIsDisplaySidebarOpen}
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
    </>
  );
};
