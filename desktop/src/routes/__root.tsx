import {
  createRootRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ChatRuntimeProvider } from "@/context/chat-runtime";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { ComposerAreaSelectOverlay } from "@/app/chat/ComposerAreaSelectOverlay";
import { setActiveLocalConversationId } from "@/features/chat/services/local-chat-store";
import { writeActiveConversationIdCache } from "@/features/chat/services/active-conversation-cache";
import type { DisplaySidebarHandle } from "@/shell/DisplaySidebar";
// The workspace panel is a ~410-line surface not needed for first
// interaction, so it is lazy-loaded to keep it out of the always-eager
// shell's first-paint module graph. The imperative `ref` handle is null
// until the chunk mounts; every consumer (`use-workspace-panel-events`,
// `use-display-payload-routing`) already accesses it defensively with `?.`,
// and only from event/async callbacks — never synchronously on mount.
const DisplaySidebar = lazy(() =>
  import("@/shell/DisplaySidebar").then((m) => ({ default: m.DisplaySidebar })),
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
import {
  displayTabs,
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
  useDisplayTabList,
} from "@/features/workspace-display/tab-store";
import { CHAT_DISPLAY_TAB_ID } from "@/features/workspace-display/default-tabs";
import { FullShellDialogs } from "@/shell/full-shell-dialogs";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import { useWindowType } from "@/shared/hooks/use-window-type";
import {
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
  STELLA_COMPOSE_TEXT_EVENT,
  type StellaOpenPanelChatDetail,
  type StellaComposeTextDetail,
} from "@/shared/lib/stella-orb-chat";
import {
  ensureChatDisplayTab,
  openChatDisplayTab,
} from "@/features/workspace-display/default-tabs";
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
  // `localStorage` cache (fast boot read). Together they let the next boot
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
  const { activeTabId } = useDisplayTabList();

  const [shellBreakpoints, setShellBreakpoints] =
    useState<ShellBreakpointState>(() =>
      getShellBreakpointState(
        typeof window === "undefined" ? 0 : window.innerWidth,
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
  const shouldAutoHideWorkspaceStrip =
    !isMiniWindow && !isMobileWebView && shellBreakpoints.hideWorkspaceStrip;

  useEffect(() => {
    if (isMiniWindow) return;
    window.electronAPI?.window.setNativeButtonsVisible?.(true);
  }, [isMiniWindow]);

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
        const next = getShellBreakpointState(Math.round(pendingWidth));
        const previous = shellBreakpointsRef.current;
        if (
          next.hideWorkspaceStrip === previous.hideWorkspaceStrip &&
          next.hideDisplayPanel === previous.hideDisplayPanel
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
    if (isMiniWindow || isMobileWebView) return;
    if (shellBreakpoints.hideDisplayPanel) {
      const { panelExpanded, panelOpen } = displayTabs.getSnapshot();
      if (panelExpanded) displayTabs.setPanelExpanded(false);
      if (panelOpen) displayTabs.setPanelOpen(false);
    }
  }, [isMiniWindow, isMobileWebView, shellBreakpoints.hideDisplayPanel]);

  useEffect(() => {
    const root = document.documentElement;
    if (shouldAutoHideWorkspaceStrip) {
      root.dataset.shellRightContextHidden = "true";
    } else {
      delete root.dataset.shellRightContextHidden;
    }

    return () => {
      delete root.dataset.shellRightContextHidden;
    };
  }, [shouldAutoHideWorkspaceStrip]);

  const expandedDisplayPanelChat =
    panelOpen && panelExpanded && activeTabId === CHAT_DISPLAY_TAB_ID;

  return (
    <>
      <MobileActivityNotificationsBridge />

      <ShellTopBar
        onSignIn={showAuthDialog}
        onConnect={showConnectDialog}
        showWorkspaceStripToggle={
          isOnChatRoute &&
          !chat.showHomeContent &&
          !isMiniWindow &&
          !isMobileWebView &&
          !shouldAutoHideWorkspaceStrip &&
          (!panelOpen || expandedDisplayPanelChat)
        }
      />

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
              hideRightContextPanel={shouldAutoHideWorkspaceStrip}
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

      <Suspense fallback={null}>
        <DisplaySidebar ref={displaySidebarRef} />
      </Suspense>

      <ComposerAreaSelectOverlay
        active={chat.annotation.active}
        requestId={chat.annotation.requestId}
        onCancel={chat.annotation.cancel}
        onSubmit={chat.annotation.submit}
      />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      {/* Suspense fallback={null} mirrors the lazy DisplaySidebar above: the
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
