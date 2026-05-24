import {
  createRootRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
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
import {
  displayTabs,
  useDisplayPanelLayout,
  useDisplayTabList,
} from "@/shell/display/tab-store";
import { CHAT_DISPLAY_TAB_ID } from "@/shell/display/default-tabs";
import { FullShellDialogs } from "@/shell/full-shell-dialogs";
import { Sidebar } from "@/shell/sidebar/Sidebar";
import {
  readPersistedSidebarVisible,
  syncSidebarHiddenDataset,
  writePersistedSidebarVisible,
} from "@/shell/sidebar/sidebar-visibility";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { useWindowType } from "@/shared/hooks/use-window-type";
import {
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
  type StellaOpenPanelChatDetail,
} from "@/shared/lib/stella-orb-chat";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  ensureChatDisplayTab,
  openChatDisplayTab,
} from "@/shell/display/default-tabs";
import { ModelCatalogUpdatedAtProvider } from "@/global/settings/hooks/model-catalog-updated-at";
import { ProviderConnectedDialog } from "@/global/settings/ProviderConnectedDialog";
import { SubscriptionUpgradeDialog } from "@/global/billing/SubscriptionUpgradeDialog";
import { MobileActivityNotificationsBridge } from "@/global/mobile/MobileActivityNotificationsBridge";
import { useDictationToggleBridge } from "@/shell/root-chrome/use-dictation-toggle-bridge";
import { useDisplayPayloadRouting } from "@/shell/root-chrome/use-display-payload-routing";
import { useLastLocationRestore } from "@/shell/root-chrome/use-last-location-restore";
import { useOnboardingMemoryPromotion } from "@/shell/root-chrome/use-onboarding-memory-promotion";
import { usePersistLastLocation } from "@/shell/root-chrome/use-persist-last-location";
import { useWorkspacePanelEvents } from "@/shell/root-chrome/use-workspace-panel-events";

const SHELL_RIGHT_PANEL_AUTO_CLOSE_WIDTH_WITH_SIDEBAR = 1280;
const SHELL_RIGHT_PANEL_AUTO_CLOSE_WIDTH_WITHOUT_SIDEBAR = 1120;
const SHELL_LEFT_SIDEBAR_AUTO_HIDE_WIDTH = 720;

type ShellBreakpointState = {
  hideLeftSidebar: boolean;
  hideRightContextPanel: boolean;
};

const getShellBreakpointState = (
  width: number,
  userSidebarVisible = true,
): ShellBreakpointState => {
  const hideLeftSidebar =
    width > 0 && width <= SHELL_LEFT_SIDEBAR_AUTO_HIDE_WIDTH;
  const leftSidebarVisible = userSidebarVisible && !hideLeftSidebar;
  const rightPanelBreakpoint = leftSidebarVisible
    ? SHELL_RIGHT_PANEL_AUTO_CLOSE_WIDTH_WITH_SIDEBAR
    : SHELL_RIGHT_PANEL_AUTO_CLOSE_WIDTH_WITHOUT_SIDEBAR;

  return {
    hideLeftSidebar,
    hideRightContextPanel: width > 0 && width <= rightPanelBreakpoint,
  };
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
  const { panelOpen, panelExpanded } = useDisplayPanelLayout();
  const { activeTabId } = useDisplayTabList();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(
    readPersistedSidebarVisible,
  );
  const sidebarVisibleRef = useRef(sidebarVisible);
  const [shellBreakpoints, setShellBreakpoints] =
    useState<ShellBreakpointState>(() =>
      getShellBreakpointState(
        typeof window === "undefined" ? 0 : window.innerWidth,
        sidebarVisible,
      ),
    );
  const shellBreakpointsRef = useRef(shellBreakpoints);

  const displaySidebarRef = useRef<DisplaySidebarHandle>(null);

  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnChatRoute = pathname === "/chat";
  const isMiniWindow = useWindowType() === "mini";
  const isMobileWebView =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-platform") === "mobile";
  const shouldRenderSidebar = !isMiniWindow || isMobileWebView;
  const shouldAutoHideRightContextPanel =
    !isMiniWindow && !isMobileWebView && shellBreakpoints.hideRightContextPanel;
  const shouldAutoHideLeftSidebar =
    !isMiniWindow && !isMobileWebView && shellBreakpoints.hideLeftSidebar;
  const sidebarVisibleInLayout = sidebarVisible && !shouldAutoHideLeftSidebar;
  const canToggleSidebar = shouldRenderSidebar && !shouldAutoHideLeftSidebar;

  const setSidebarVisiblePersisted = useCallback((next: boolean) => {
    sidebarVisibleRef.current = next;
    setSidebarVisible(next);
    writePersistedSidebarVisible(next);
  }, []);

  const hideSidebar = useCallback(() => {
    setSidebarVisiblePersisted(false);
  }, [setSidebarVisiblePersisted]);

  const toggleSidebar = useCallback(() => {
    if (shouldAutoHideLeftSidebar) return;
    setSidebarVisiblePersisted(!sidebarVisibleRef.current);
  }, [setSidebarVisiblePersisted, shouldAutoHideLeftSidebar]);

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
    const root = document.documentElement;
    if (panelOpen) root.dataset.displayPanelOpen = "true";
    else delete root.dataset.displayPanelOpen;

    if (panelOpen && panelExpanded) root.dataset.displayPanelExpanded = "true";
    else delete root.dataset.displayPanelExpanded;

    return () => {
      delete root.dataset.displayPanelOpen;
      delete root.dataset.displayPanelExpanded;
    };
  }, [panelExpanded, panelOpen]);

  useEffect(() => {
    const root = document.documentElement;
    let active = false;
    let timeout = 0;

    const clearActive = () => {
      active = false;
      timeout = 0;
      delete root.dataset.shellWindowResizing;
    };

    const onResize = () => {
      if (!active) {
        active = true;
        root.dataset.shellWindowResizing = "true";
      }
      window.clearTimeout(timeout);
      timeout = window.setTimeout(clearActive, 140);
    };

    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", onResize);
      delete root.dataset.shellWindowResizing;
    };
  }, []);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".full-body");
    if (!shell) return;

    let frame = 0;
    let pendingWidth = 0;
    const syncWidth = (width: number) => {
      pendingWidth = width;
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = getShellBreakpointState(
          Math.round(pendingWidth),
          sidebarVisibleRef.current,
        );
        const previous = shellBreakpointsRef.current;
        if (
          next.hideLeftSidebar === previous.hideLeftSidebar &&
          next.hideRightContextPanel === previous.hideRightContextPanel
        ) {
          return;
        }
        shellBreakpointsRef.current = next;
        setShellBreakpoints(next);
      });
    };

    syncWidth(shell.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      const onResize = () => syncWidth(shell.getBoundingClientRect().width);
      window.addEventListener("resize", onResize);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", onResize);
      };
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      syncWidth(entry.contentRect.width);
    });
    observer.observe(shell);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".full-body");
    if (!shell) return;
    const next = getShellBreakpointState(
      Math.round(shell.getBoundingClientRect().width),
      sidebarVisible,
    );
    const previous = shellBreakpointsRef.current;
    if (
      next.hideLeftSidebar === previous.hideLeftSidebar &&
      next.hideRightContextPanel === previous.hideRightContextPanel
    ) {
      return;
    }
    shellBreakpointsRef.current = next;
    setShellBreakpoints(next);
  }, [sidebarVisible]);

  useEffect(() => {
    if (isMiniWindow || isMobileWebView) return;

    if (shellBreakpoints.hideRightContextPanel) {
      const { panelExpanded, panelOpen } = displayTabs.getSnapshot();
      if (panelExpanded) displayTabs.setPanelExpanded(false);
      if (panelOpen) displayTabs.setPanelOpen(false);
    }

    if (shellBreakpoints.hideLeftSidebar) {
      setDrawerOpen(false);
    }
  }, [
    isMiniWindow,
    isMobileWebView,
    shellBreakpoints.hideLeftSidebar,
    shellBreakpoints.hideRightContextPanel,
  ]);

  useEffect(() => {
    const root = document.documentElement;
    if (shouldAutoHideRightContextPanel) {
      root.dataset.shellRightContextHidden = "true";
    } else {
      delete root.dataset.shellRightContextHidden;
    }

    return () => {
      delete root.dataset.shellRightContextHidden;
    };
  }, [shouldAutoHideRightContextPanel]);

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

  useEffect(() => {
    sidebarVisibleRef.current = sidebarVisible;
  }, [sidebarVisible]);

  useEffect(() => {
    syncSidebarHiddenDataset(sidebarVisibleInLayout);
  }, [sidebarVisibleInLayout]);

  const expandedDisplayPanelChat =
    panelOpen && panelExpanded && activeTabId === CHAT_DISPLAY_TAB_ID;

  return (
    <>
      <MobileActivityNotificationsBridge />

      {!isMiniWindow && !isMobileWebView && drawerOpen && (
        <div className="sidebar-drawer-scrim" onClick={closeDrawer} />
      )}

      <ShellTopBar
        sidebarVisible={sidebarVisibleInLayout}
        onToggleSidebar={toggleSidebar}
        showSidebarToggle={canToggleSidebar}
        showWorkspaceStripToggle={
          isOnChatRoute &&
          !chat.showHomeContent &&
          !isMiniWindow &&
          !isMobileWebView &&
          !shouldAutoHideRightContextPanel &&
          (!panelOpen || expandedDisplayPanelChat)
        }
      />

      {shouldRenderSidebar && (
        <Sidebar
          visible={sidebarVisibleInLayout}
          onHide={hideSidebar}
          className={
            !isMobileWebView && drawerOpen ? "sidebar--drawer-open" : undefined
          }
          onSignIn={showAuthDialog}
          onConnect={showConnectDialog}
        />
      )}

      <StellaContextMenu
        isOpen={isContextMenuPanelOpen}
        onOpen={handleContextMenuOpenPanel}
        onClose={handleContextMenuClosePanel}
      >
        <div className="content-area">
          {!isMiniWindow && !isMobileWebView && !shouldAutoHideLeftSidebar && (
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
              hideRightContextPanel={shouldAutoHideRightContextPanel}
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

      <SubscriptionUpgradeDialog />
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
