import {
  createRootRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { ChatRuntimeProvider } from "@/context/chat-runtime";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { WelcomeDialog } from "@/global/onboarding/WelcomeDialog";
import { ChatColumn } from "@/app/chat/ChatColumn";
import {
  DisplaySidebar,
  type DisplaySidebarHandle,
} from "@/shell/DisplaySidebar";
import { ShellTopBar } from "@/shell/ShellTopBar";
import { useDisplayPanelLayout } from "@/shell/display/tab-store";
import { FullShellDialogs } from "@/shell/full-shell-dialogs";
import { Sidebar } from "@/shell/sidebar/Sidebar";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { useWindowType } from "@/shared/hooks/use-window-type";
import {
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
  type StellaOpenPanelChatDetail,
} from "@/shared/lib/stella-orb-chat";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import {
  ensureChatDisplayTab,
  openChatDisplayTab,
} from "@/shell/display/default-tabs";
import { ModelCatalogUpdatedAtProvider } from "@/global/settings/hooks/model-catalog-updated-at";
import { ProviderConnectedDialog } from "@/global/settings/ProviderConnectedDialog";
import { useDictationToggleBridge } from "@/shell/root-chrome/use-dictation-toggle-bridge";
import { useDisplayPayloadRouting } from "@/shell/root-chrome/use-display-payload-routing";
import { useLastLocationRestore } from "@/shell/root-chrome/use-last-location-restore";
import { useOnboardingMemoryPromotion } from "@/shell/root-chrome/use-onboarding-memory-promotion";
import { usePersistLastLocation } from "@/shell/root-chrome/use-persist-last-location";
import { useWorkspacePanelEvents } from "@/shell/root-chrome/use-workspace-panel-events";

const NEW_APP_ASK_STELLA_PROMPT =
  "The user wants to create a new workspace (app) added to the sidebar with its own content. Be concise and provide 2-4 suggestions and ideas.";

type PendingAskStellaRequest = {
  id: number;
  text: string;
};

/**
 * The root route owns the app chrome — sidebar, workspace panel, dialogs,
 * welcome — plus an `<Outlet />` where the
 * active route renders. Chat runtime state is hoisted into a provider so
 * both the chat route and the workspace panel consume the same hook
 * output.
 */
function RootLayout() {
  const { state, setConversationId } = useUiState();
  const matchRoute = useMatchRoute();
  const isOnChatRoute = Boolean(matchRoute({ to: "/chat" }));
  const routerConversationId = useRouterState({
    select: (s) =>
      s.location.pathname === "/chat"
        ? ((s.location.search as { c?: string }).c ?? null)
        : null,
  });
  const conversationId = routerConversationId ?? state.conversationId;
  const router = useRouter();

  useEffect(() => {
    if (routerConversationId && routerConversationId !== state.conversationId) {
      setConversationId(routerConversationId);
    }
  }, [routerConversationId, setConversationId, state.conversationId]);

  useLastLocationRestore(router);
  usePersistLastLocation(router);

  return (
    <ModelCatalogUpdatedAtProvider>
      <ChatRuntimeProvider
        activeConversationId={conversationId}
        isOnChatRoute={isOnChatRoute}
      >
        <RootChrome />
      </ChatRuntimeProvider>
    </ModelCatalogUpdatedAtProvider>
  );
}

function RootChrome() {
  const navigate = useNavigate();
  const { dialog: activeDialog } = Route.useSearch();
  const { state } = useUiState();
  const conversationId = state.conversationId;
  const chat = useChatRuntime();
  const { panelOpen } = useDisplayPanelLayout();

  const [pendingAskStellaRequest, setPendingAskStellaRequest] =
    useState<PendingAskStellaRequest | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const displaySidebarRef = useRef<DisplaySidebarHandle>(null);

  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnChatRoute = pathname === "/chat";
  const isMiniWindow = useWindowType() === "mini";

  const setDialogSearch = useCallback(
    (next: "auth" | "connect" | undefined) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown> | undefined) => ({
          ...(prev ?? {}),
          dialog: next,
        }),
      });
    },
    [navigate],
  );

  const showAuthDialog = useCallback(
    () => setDialogSearch("auth"),
    [setDialogSearch],
  );
  const showConnectDialog = useCallback(
    () => setDialogSearch("connect"),
    [setDialogSearch],
  );
  const closeDialog = useCallback(
    () => setDialogSearch(undefined),
    [setDialogSearch],
  );

  useOnboardingMemoryPromotion({
    hasConnectedAccount,
    isAuthLoading,
    showAuthDialog,
  });

  const handlePendingAskStellaHandled = useCallback((requestId: number) => {
    setPendingAskStellaRequest((current) =>
      current?.id === requestId ? null : current,
    );
  }, []);

  // When the user starts a "new app" flow from home, keep them on the full
  // chat surface instead of opening the display panel's chat tab. Everywhere
  // else, the side-panel chat remains the active surface for the flow.
  const handleNewAppAskStella = useCallback(() => {
    startTransition(() => {
      setPendingAskStellaRequest({
        id: Date.now(),
        text: NEW_APP_ASK_STELLA_PROMPT,
      });
    });
    if (isOnChatRoute) {
      chat.dismissHome();
    }
  }, [chat, isOnChatRoute]);

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeDialog();
    },
    [closeDialog],
  );

  const openChatPanel = useCallback(
    (detail: StellaOpenPanelChatDetail = {}) => {
      openChatDisplayTab({ id: Date.now(), ...detail });
    },
    [],
  );

  // Display tab rule: Chat is always present in the strip; its body
  // adapts to the route inside `ChatDisplayTab` (home shows the activity
  // / files overview, every other route shows the live chat panel).
  // Tabs are otherwise sticky — only the user closes them.
  useEffect(() => {
    ensureChatDisplayTab();
  }, []);

  const handleContextMenuOpenPanel = useCallback(() => {
    dispatchOpenWorkspacePanel();
  }, []);

  const handleContextMenuClosePanel = useCallback(() => {
    dispatchClosePanel();
  }, []);

  const isContextMenuPanelOpen = panelOpen;

  // Forward pending ask-Stella requests into the appropriate chat surface.
  // We deliberately clear the queued request from this effect — the state
  // here is acting as a one-shot mailbox, not derived state. The cascade is
  // bounded (one render to null), so the lint rule is suppressed here.
  useEffect(() => {
    if (!pendingAskStellaRequest) return;

    dispatchStellaSendMessage(
      {
        text: pendingAskStellaRequest.text,
        uiVisibility: "hidden",
        triggerKind: WORKSPACE_CREATION_TRIGGER_KIND,
        triggerSource: "sidebar",
      },
      { openPanel: !isOnChatRoute },
    );
    if (!isOnChatRoute) {
      openChatPanel();
    }
    handlePendingAskStellaHandled(pendingAskStellaRequest.id);
  }, [
    handlePendingAskStellaHandled,
    isOnChatRoute,
    openChatPanel,
    pendingAskStellaRequest,
  ]);

  const { latestDisplayPayloadRef } = useDisplayPayloadRouting({
    displaySidebarRef,
    isMiniWindow,
    isOnChatRoute,
    showHomeContent: chat.showHomeContent,
  });

  useDictationToggleBridge();

  useWorkspacePanelEvents({
    displaySidebarRef,
    latestDisplayPayloadRef,
    openChatPanel,
  });

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const handler = () => {
      if (!mq.matches) setDrawerOpen(false);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Close the mobile drawer whenever the route changes. setState-in-effect is
  // intentional here — the drawer is a UI artifact that should reset on every
  // navigation; the pathname *is* the external state we are syncing from.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <>
      {!isMiniWindow && drawerOpen && (
        <div className="sidebar-drawer-scrim" onClick={closeDrawer} />
      )}

      <ShellTopBar />

      {!isMiniWindow && (
        <Sidebar
          className={drawerOpen ? "sidebar--drawer-open" : undefined}
          onSignIn={showAuthDialog}
          onConnect={showConnectDialog}
          onNewAppAskStella={() => {
            closeDrawer();
            handleNewAppAskStella();
          }}
        />
      )}

      <StellaContextMenu
        isOpen={isContextMenuPanelOpen}
        onOpen={handleContextMenuOpenPanel}
        onClose={handleContextMenuClosePanel}
      >
        <div className="content-area">
          {!isMiniWindow && (
            <button
              type="button"
              className="compact-hamburger"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          )}
          <div
            className={`persistent-chat-surface${isOnChatRoute ? " persistent-chat-surface--active" : ""}`}
            aria-hidden={!isOnChatRoute}
          >
            <ChatColumn
              conversation={chat.conversation}
              composer={chat.composer}
              scroll={chat.scroll}
              conversationId={conversationId}
              showHomeContent={chat.showHomeContent}
              onSuggestionClick={chat.onSuggestionClick}
              onDismissHome={chat.dismissHome}
            />
          </div>
          <div
            className={`route-outlet-surface${isOnChatRoute ? "" : " route-outlet-surface--active"}`}
            aria-hidden={isOnChatRoute}
          >
            <Outlet />
          </div>
        </div>
      </StellaContextMenu>

      <DisplaySidebar ref={displaySidebarRef} />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      <WelcomeDialog
        conversationId={conversationId}
        onConnect={showConnectDialog}
        onSignIn={showAuthDialog}
      />

      <ProviderConnectedDialog />
    </>
  );
}

/**
 * Root-level search params: dialogs (auth/connect) become URL state so they
 * are deep-linkable (e.g. an auth deep-link from an external browser opens
 * the AuthDialog without any other glue).
 */
const RootSearch = z.object({
  dialog: z.enum(["auth", "connect"]).optional(),
});

export const Route = createRootRoute({
  validateSearch: RootSearch,
  component: RootLayout,
});
