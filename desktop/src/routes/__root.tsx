import {
  createRootRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { ChatRuntimeProvider } from "@/context/chat-runtime";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { ComposerAreaSelectOverlay } from "@/app/chat/ComposerAreaSelectOverlay";
import { OPEN_CONNECT_DIALOG_EVENT } from "@/global/integrations/connect-action";
import { setActiveLocalConversationId } from "@/features/chat/services/local-chat-store";
import { writeActiveConversationIdCache } from "@/features/chat/services/active-conversation-cache";
import type { RightSidebarHandle } from "@/shell/RightSidebar";
// The workspace panel is a ~410-line surface not needed for first
// interaction, so it is lazy-loaded to keep it out of the always-eager
// shell's first-paint module graph. The imperative `ref` handle is null
// until the chunk mounts; every consumer (`use-workspace-panel-events`,
// `use-display-payload-routing`) already accesses it defensively with `?.`,
// and only from event/async callbacks — never synchronously on mount.
const RightSidebar = lazy(() =>
  import("@/shell/RightSidebar").then((m) => ({ default: m.RightSidebar })),
);
// These dialogs are rarely seen on first interaction (onboarding welcome,
// nickname prompt, post-OAuth confirmation, billing upgrade) and each already
// renders null until its own open/visibility state flips. In a dev-server-in-prod
// app every static import is a separate first-paint transform, so they are
// lazy-loaded — wrapped in <Suspense fallback={null}> at their conditional mount
// sites — to keep them off the always-eager shell's first-paint graph. Behavior
// is unchanged: each dialog still renders null until its own state opens, so
// nothing visual depends on the deferred chunk and there is no fallback flash.
const WelcomeDialog = lazy(() =>
  import("@/global/onboarding/WelcomeDialog").then((m) => ({
    default: m.WelcomeDialog,
  })),
);
const NicknameDialog = lazy(() =>
  import("@/global/auth/NicknameDialog").then((m) => ({
    default: m.NicknameDialog,
  })),
);
const ProviderConnectedDialog = lazy(() =>
  import("@/global/settings/ProviderConnectedDialog").then((m) => ({
    default: m.ProviderConnectedDialog,
  })),
);
const SubscriptionUpgradeDialog = lazy(() =>
  import("@/global/billing/SubscriptionUpgradeDialog").then((m) => ({
    default: m.SubscriptionUpgradeDialog,
  })),
);
import { ShellTopBar } from "@/shell/ShellTopBar";
import { WindowControls } from "@/shell/WindowControls";
import { LeftSidebar } from "@/shell/LeftSidebar";
import { leftSidebarVisibilityStore } from "@/shell/left-sidebar-visibility-store";
import {
  displayTabs,
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import {
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  ensureChatDisplayTab,
  openChatDisplayTab,
  openHomeDisplayTab,
} from "@/shell/display/default-tabs";
import { FullShellDialogs } from "@/shell/full-shell-dialogs";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { getPlatform } from "@/platform/electron/platform";
import { uiState } from "@/platform/ui-state";
import { PanelLeft, PanelRight } from "@/ui/icons";
import {
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
  STELLA_COMPOSE_TEXT_EVENT,
  type StellaOpenPanelChatDetail,
  type StellaComposeTextDetail,
} from "@/shared/lib/stella-orb-chat";
import { ModelCatalogUpdatedAtProvider } from "@/global/settings/hooks/model-catalog-updated-at";
import { useRestrictedStellaModelReset } from "@/global/settings/hooks/use-restricted-stella-model-reset";
import { MobileActivityNotificationsBridge } from "@/global/mobile/MobileActivityNotificationsBridge";
import { useDictationToggleBridge } from "@/shell/root-chrome/use-dictation-toggle-bridge";
import { useDisplayPayloadRouting } from "@/shell/root-chrome/use-display-payload-routing";
import { useLastLocationRestore } from "@/shell/root-chrome/use-last-location-restore";
import { useOnboardingMemoryPromotion } from "@/shell/root-chrome/use-onboarding-memory-promotion";
import { usePersistLastLocation } from "@/shell/root-chrome/use-persist-last-location";
import { useWorkspacePanelEvents } from "@/shell/root-chrome/use-workspace-panel-events";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  getShellBreakpointState,
  type ShellBreakpointState,
} from "@/shell/shell-breakpoints";

/** Persisted left-sidebar visibility ("0" = hidden). */
const LEFT_SIDEBAR_VISIBLE_KEY = "stella.leftSidebar.visible";

/**
 * The root route owns the app chrome — top shell bar, workspace panel,
 * dialogs, welcome — plus an `<Outlet />` where the active route renders.
 * Chat runtime state is hoisted into a provider so both the chat route and
 * the workspace panel consume the same hook output.
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

  // Single writer for the active-conversation pointer. The router
  // (`/chat?c=<id>`) is the live source of truth; whenever it changes we
  // mirror the id into SQLite (durable, cross-process) and a synchronous
  // shared-UI-state cache (fast boot read). Together they let the next boot
  // restore exactly this conversation — surviving both renderer hard reloads
  // and full restarts — without the empty-state flash an IPC-only read causes.
  useEffect(() => {
    if (!routerConversationId) return;
    writeActiveConversationIdCache(routerConversationId);
    void setActiveLocalConversationId(routerConversationId);
  }, [routerConversationId]);

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
  useRestrictedStellaModelReset();

  const navigate = useNavigate();
  const { dialog: activeDialog } = Route.useSearch();
  const { state } = useUiState();
  const conversationId = state.conversationId;
  const chat = useChatRuntime();
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const [leftSidebarVisible, setLeftSidebarVisible] = useState<boolean>(
    () => uiState.getItem(LEFT_SIDEBAR_VISIBLE_KEY) !== "0",
  );

  const [shellBreakpoints, setShellBreakpoints] =
    useState<ShellBreakpointState>(() =>
      getShellBreakpointState(
        typeof window === "undefined" ? 0 : window.innerWidth,
        leftSidebarVisible,
      ),
    );
  const shellBreakpointsRef = useRef(shellBreakpoints);
  const displayPanelWasHiddenRef = useRef(shellBreakpoints.hideDisplayPanel);
  const autoCollapsedDisplayPanelRef = useRef<{
    panelExpanded: boolean;
  } | null>(null);
  const displayBreakpointTransitionTimeoutRef = useRef<number | null>(null);

  const rightSidebarRef = useRef<RightSidebarHandle>(null);

  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnChatRoute = pathname === "/chat";
  const isMiniWindow = useWindowType() === "mini";
  const isMobileWebView =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-platform") === "mobile";
  const isFullWindow = !isMiniWindow && !isMobileWebView;
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const dockedLeftSidebarVisible =
    isFullWindow && leftSidebarVisible && !shellBreakpoints.hideLeftSidebar;

  // Left sidebar visibility — a toggle next to the traffic lights collapses
  // it; a floating button at the same spot brings it back. Persisted so the
  // choice survives reloads.
  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarVisible((prev) => {
      const next = !prev;
      uiState.setItem(LEFT_SIDEBAR_VISIBLE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const triggerDisplayBreakpointTransition = useCallback(() => {
    document.body.dataset.displayBreakpointTransition = "true";
    if (displayBreakpointTransitionTimeoutRef.current !== null) {
      window.clearTimeout(displayBreakpointTransitionTimeoutRef.current);
    }
    displayBreakpointTransitionTimeoutRef.current = window.setTimeout(() => {
      displayBreakpointTransitionTimeoutRef.current = null;
      delete document.body.dataset.displayBreakpointTransition;
    }, 520);
  }, []);

  useEffect(
    () => () => {
      if (displayBreakpointTransitionTimeoutRef.current !== null) {
        window.clearTimeout(displayBreakpointTransitionTimeoutRef.current);
        displayBreakpointTransitionTimeoutRef.current = null;
      }
      delete document.body.dataset.displayBreakpointTransition;
    },
    [],
  );

  useEffect(() => {
    if (isMiniWindow) return;
    window.electronAPI?.window.setNativeButtonsVisible?.(true);
  }, [isMiniWindow]);

  useEffect(() => {
    const root = document.documentElement;
    if (isFullWindow) root.dataset.shellPanelChrome = "true";
    else delete root.dataset.shellPanelChrome;
    return () => {
      delete root.dataset.shellPanelChrome;
    };
  }, [isFullWindow]);

  // Expose the current left-sidebar width so an expanded display panel can
  // inset past it (keeping the rail visible). 252px mirrors
  // `--left-sidebar-width` in left-sidebar.css; 0 when collapsed.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (dockedLeftSidebarVisible) root.dataset.shellLeftSidebarDocked = "true";
    else delete root.dataset.shellLeftSidebarDocked;

    root.style.setProperty(
      "--shell-left-sidebar-width",
      dockedLeftSidebarVisible ? "252px" : "0px",
    );
    // Mirror the effective sidebar state into the module store so the
    // composer activity pill (a separate tree) can stand down while the
    // sidebar's Activity section is on screen.
    leftSidebarVisibilityStore.setDocked(dockedLeftSidebarVisible);
    return () => {
      delete root.dataset.shellLeftSidebarDocked;
      root.style.removeProperty("--shell-left-sidebar-width");
      leftSidebarVisibilityStore.setDocked(false);
    };
  }, [dockedLeftSidebarVisible]);

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

  useEffect(() => {
    const handler = () => showConnectDialog();
    window.addEventListener(OPEN_CONNECT_DIALOG_EVENT, handler);
    return () => window.removeEventListener(OPEN_CONNECT_DIALOG_EVENT, handler);
  }, [showConnectDialog]);

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

  // Route-aware default surface for a manual panel summon (right-click /
  // keyboard). Home never opens to a duplicate chat — it shows the Home
  // launcher; every other route opens the chat viewer. An already-active
  // artifact viewer (media / canvas / pdf / …) reopens as-is regardless of
  // route so summoning doesn't lose what the user was looking at.
  const openDefaultPanelSurface = useCallback(() => {
    const { activeTabId } = displayTabs.getTabListSnapshot();
    const isArtifactViewer =
      activeTabId !== null &&
      activeTabId !== CHAT_DISPLAY_TAB_ID &&
      activeTabId !== HOME_DISPLAY_TAB_ID;
    if (isArtifactViewer) {
      displayTabs.setPanelOpen(true);
      return;
    }
    if (isOnChatRoute) {
      openHomeDisplayTab();
      return;
    }
    openChatPanel();
  }, [isOnChatRoute, openChatPanel]);

  useEffect(() => {
    const handleComposeText = (event: Event) => {
      const detail = (event as CustomEvent<StellaComposeTextDetail>).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
      const hasPrefillText = Boolean(text.trim());
      const hasChatContext = Object.prototype.hasOwnProperty.call(
        detail,
        "chatContext",
      );
      const hasSelectedText = Object.prototype.hasOwnProperty.call(
        detail,
        "selectedText",
      );
      if (!hasPrefillText && !hasChatContext && !hasSelectedText) return;

      const selectedTextContext =
        hasSelectedText && detail.selectedText
          ? {
              window: null,
              browserUrl: null,
              selectedText: detail.selectedText,
              regionScreenshots: [],
            }
          : null;
      const nextChatContext = hasChatContext
        ? (detail.chatContext ?? null)
        : selectedTextContext;

      if (isOnChatRoute) {
        if (hasPrefillText) {
          chat.composer.setMessage(text);
        }
        if (hasChatContext || selectedTextContext) {
          chat.composer.setChatContext(nextChatContext);
        }
        if (hasSelectedText) {
          chat.composer.setSelectedText(detail.selectedText ?? null);
        }
        chat.composer.requestFocus?.();
        return;
      }

      openChatDisplayTab({
        id: Date.now(),
        chatContext: nextChatContext,
        ...(hasPrefillText ? { prefillText: text } : {}),
      });
    };

    window.addEventListener(STELLA_COMPOSE_TEXT_EVENT, handleComposeText);
    return () => {
      window.removeEventListener(STELLA_COMPOSE_TEXT_EVENT, handleComposeText);
    };
  }, [chat.composer, isOnChatRoute]);

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
    rightSidebarRef,
    isMiniWindow,
  });

  useDictationToggleBridge();

  useWorkspacePanelEvents({
    rightSidebarRef,
    latestDisplayPayloadRef,
    openChatPanel,
    openDefaultPanelSurface,
  });

  // Auto-follow the route with the panel's default surface: navigating to
  // home flips an open Chat panel to the Home launcher, and navigating away
  // from home flips an open Home launcher to Chat. Only the default
  // surfaces follow the route — an open artifact viewer (Media / Canvas /
  // PDF / …) is left untouched so navigation never yanks the user off it,
  // and a closed panel stays closed (it picks the right surface on summon).
  useEffect(() => {
    if (isMiniWindow || isMobileWebView) return;
    const { panelOpen, activeTabId } = displayTabs.getSnapshot();
    if (!panelOpen) return;
    const isDefaultSurface =
      activeTabId === CHAT_DISPLAY_TAB_ID ||
      activeTabId === HOME_DISPLAY_TAB_ID;
    if (!isDefaultSurface) return;
    if (isOnChatRoute) {
      if (activeTabId !== HOME_DISPLAY_TAB_ID) openHomeDisplayTab();
    } else if (activeTabId !== CHAT_DISPLAY_TAB_ID) {
      displayTabs.activateTab(CHAT_DISPLAY_TAB_ID);
    }
  }, [isOnChatRoute, isMiniWindow, isMobileWebView]);

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

  const applyShellBreakpoints = useCallback(
    (width: number, sidebarVisible: boolean) => {
      const next = getShellBreakpointState(Math.round(width), sidebarVisible);
      const previous = shellBreakpointsRef.current;
      if (
        next.hideWorkspaceStrip === previous.hideWorkspaceStrip &&
        next.hideDisplayPanel === previous.hideDisplayPanel &&
        next.hideLeftSidebar === previous.hideLeftSidebar
      ) {
        return;
      }
      shellBreakpointsRef.current = next;
      setShellBreakpoints(next);
    },
    [],
  );

  // The observer mounts once; `leftSidebarVisible` flows in via a ref so a
  // sidebar toggle doesn't tear down / recreate the ResizeObserver and force
  // a synchronous re-measure on the very frame the collapse animation starts.
  const leftSidebarVisibleRef = useRef(leftSidebarVisible);
  leftSidebarVisibleRef.current = leftSidebarVisible;
  const shellWidthRef = useRef(0);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".full-body");
    if (!shell) return;

    let frame = 0;
    const syncWidth = (width: number) => {
      shellWidthRef.current = width;
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyShellBreakpoints(
          shellWidthRef.current,
          leftSidebarVisibleRef.current,
        );
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
  }, [applyShellBreakpoints]);

  // Breakpoints also depend on the sidebar's visibility (the strip / display
  // panel auto-hide thresholds shift by its width) — recompute from the
  // cached shell width instead of re-measuring on toggle.
  useEffect(() => {
    if (shellWidthRef.current <= 0) return;
    applyShellBreakpoints(shellWidthRef.current, leftSidebarVisible);
  }, [applyShellBreakpoints, leftSidebarVisible]);

  useEffect(() => {
    if (isMiniWindow || isMobileWebView) {
      displayPanelWasHiddenRef.current = shellBreakpoints.hideDisplayPanel;
      autoCollapsedDisplayPanelRef.current = null;
      return;
    }

    const wasHidden = displayPanelWasHiddenRef.current;
    const isHidden = shellBreakpoints.hideDisplayPanel;
    displayPanelWasHiddenRef.current = isHidden;

    const { panelExpanded, panelOpen } = displayTabs.getSnapshot();

    if (isHidden) {
      if (!wasHidden && panelOpen) {
        autoCollapsedDisplayPanelRef.current = { panelExpanded };
        triggerDisplayBreakpointTransition();
      }
      if (panelExpanded) displayTabs.setPanelExpanded(false);
      if (panelOpen) displayTabs.setPanelOpen(false);
      return;
    }

    const autoCollapsedPanel = autoCollapsedDisplayPanelRef.current;
    if (!wasHidden || !autoCollapsedPanel) return;
    autoCollapsedDisplayPanelRef.current = null;
    triggerDisplayBreakpointTransition();
    if (!panelOpen) displayTabs.setPanelOpen(true);
    if (autoCollapsedPanel.panelExpanded) displayTabs.setPanelExpanded(true);
  }, [
    isMiniWindow,
    isMobileWebView,
    panelExpanded,
    panelOpen,
    shellBreakpoints.hideDisplayPanel,
    triggerDisplayBreakpointTransition,
  ]);

  return (
    <>
      <MobileActivityNotificationsBridge />

      {!isFullWindow ? <ShellTopBar /> : null}

      {isFullWindow ? (
        <LeftSidebar
          onSignIn={showAuthDialog}
          onConnect={showConnectDialog}
          collapsed={!dockedLeftSidebarVisible}
        />
      ) : null}

      <StellaContextMenu
        isOpen={isContextMenuPanelOpen}
        onOpen={handleContextMenuOpenPanel}
        onClose={handleContextMenuClosePanel}
      >
        <div className="content-area">
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

      {/* Rendered after `.content-area` so their `no-drag` carve is applied
          after the content area's top `-webkit-app-region: drag` strip —
          draggable regions resolve in DOM order, not z-index, so a button
          painted above but earlier in the DOM would still read as draggable
          (and swallow clicks). The left toggle is always mounted at a fixed
          position so it doesn't shift between the open and collapsed states. */}
      {isFullWindow ? (
        <button
          type="button"
          className="shell-topbar-icon-btn shell-edge-toggle shell-edge-toggle--left"
          data-platform={isMac ? "mac" : "other"}
          onClick={toggleLeftSidebar}
          aria-label={
            dockedLeftSidebarVisible ? "Hide sidebar" : "Show sidebar"
          }
          title={dockedLeftSidebarVisible ? "Hide sidebar" : "Show sidebar"}
        >
          <PanelLeft size={16} strokeWidth={1.75} />
        </button>
      ) : null}

      {isFullWindow && !panelOpen ? (
        isWin ? (
          // Windows: the panel toggle and the custom min/max/close controls
          // share the top-right corner, controls outermost. Mounted only
          // while the panel is closed — opening the panel hides both.
          <div className="shell-edge-right-cluster">
            <button
              type="button"
              className="shell-topbar-icon-btn"
              onClick={() => dispatchOpenWorkspacePanel()}
              aria-label="Open panel"
              title="Open panel"
            >
              <PanelRight size={16} strokeWidth={1.75} />
            </button>
            <WindowControls useWindowsIcons hidden={false} />
          </div>
        ) : (
          <button
            type="button"
            className="shell-topbar-icon-btn shell-edge-toggle shell-edge-toggle--right"
            onClick={() => dispatchOpenWorkspacePanel()}
            aria-label="Open panel"
            title="Open panel"
          >
            <PanelRight size={16} strokeWidth={1.75} />
          </button>
        )
      ) : null}

      <Suspense fallback={null}>
        <RightSidebar ref={rightSidebarRef} />
      </Suspense>

      <ComposerAreaSelectOverlay
        active={chat.annotation.active}
        requestId={chat.annotation.requestId}
        onCancel={chat.annotation.cancel}
        onSelect={chat.annotation.submit}
      />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      {/* Suspense fallback={null} mirrors the lazy RightSidebar above: the
          deferred chunk stays off the first-paint graph, and each dialog still
          renders null until its own open state flips — no flash, no behavior change. */}
      <Suspense fallback={null}>
        <WelcomeDialog
          conversationId={conversationId}
          onConnect={showConnectDialog}
          onSignIn={showAuthDialog}
        />
      </Suspense>

      <Suspense fallback={null}>
        <NicknameDialog />
      </Suspense>

      <Suspense fallback={null}>
        <ProviderConnectedDialog />
      </Suspense>

      <Suspense fallback={null}>
        <SubscriptionUpgradeDialog />
      </Suspense>
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
