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
import { useMediaMaterializer } from "@/app/media/use-media-materializer";
import {
  DisplaySidebar,
  type DisplaySidebarHandle,
} from "@/shell/DisplaySidebar";
import { ShellTopBar } from "@/shell/ShellTopBar";
import { displayTabs, useDisplayTabs } from "@/shell/display/tab-store";
import { FullShellDialogs } from "@/shell/full-shell-dialogs";
import { Sidebar } from "@/shell/sidebar/Sidebar";
import { StellaContextMenu } from "@/shell/context-menu/StellaContextMenu";
import {
  type DisplayPayload,
  normalizeDisplayPayload,
} from "@/shared/contracts/display-payload";
import { hasBillingCheckoutCompletionMarker } from "@/global/settings/lib/billing-checkout";
import {
  readPersistedLastLocation,
  writePersistedLastLocation,
} from "@/shared/lib/last-location";
import {
  STELLA_CLOSE_PANEL_EVENT,
  STELLA_OPEN_WORKSPACE_PANEL_EVENT,
  STELLA_OPEN_PANEL_CHAT_EVENT,
  type StellaOpenPanelChatDetail,
} from "@/shared/lib/stella-orb-chat";
import {
  clearRequestSignInAfterOnboarding,
  consumeRequestSignInAfterOnboarding,
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
  dispatchOpenPanelChat,
} from "@/shared/lib/stella-orb-chat";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import { DICTATION_TOGGLE_EVENT } from "@/features/dictation/hooks/use-dictation";
import {
  ensureChatDisplayTab,
  openChatDisplayTab,
  openIdeasDisplayTab,
} from "@/shell/display/default-tabs";

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
  const { state } = useUiState();
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

  // Restore the last persisted location exactly once. We read synchronously
  // from `localStorage` (no async hydration race) and only navigate if the
  // pathname matches a registered route in this router. Anything else falls
  // through to the memory-history default (`/chat`).
  //
  // Special case: a Stripe checkout return URL carries the
  // `?billingCheckout=complete` marker on `window.location`. When we see it,
  // we skip the persisted restore and go straight to `/billing` — the
  // BillingScreen consumes the marker (see
  // `consumeBillingCheckoutCompletionMarker`) so reloading later doesn't
  // bounce the user back here.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    if (hasBillingCheckoutCompletionMarker()) {
      void router.navigate({ to: "/billing" });
      return;
    }

    const target = readPersistedLastLocation();
    if (!target || target === "/chat" || target === "/") return;

    const queryIndex = target.indexOf("?");
    const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
    const knownPaths = router.routesByPath as unknown as Record<
      string,
      unknown
    >;
    if (!Object.prototype.hasOwnProperty.call(knownPaths, pathname)) return;

    const search = queryIndex === -1 ? "" : target.slice(queryIndex + 1);
    const searchParams = Object.fromEntries(new URLSearchParams(search));

    void router.navigate({
      to: pathname,
      search: searchParams as never,
    });
  }, [router]);

  // Persist every router resolution to renderer-side `localStorage` so a
  // fresh launch can restore where the user was. We deliberately don't
  // round-trip this through IPC — no other window cares.
  useEffect(() => {
    return router.subscribe("onResolved", ({ toLocation }) => {
      writePersistedLastLocation(toLocation.href);
    });
  }, [router]);

  return (
    <ChatRuntimeProvider
      activeConversationId={conversationId}
      isOnChatRoute={isOnChatRoute}
    >
      <RootChrome />
    </ChatRuntimeProvider>
  );
}

function RootChrome() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const { dialog: activeDialog } = Route.useSearch();
  const { state } = useUiState();
  const conversationId = state.conversationId;
  const chat = useChatRuntime();
  const { panelOpen } = useDisplayTabs();

  const [pendingAskStellaRequest, setPendingAskStellaRequest] =
    useState<PendingAskStellaRequest | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const displaySidebarRef = useRef<DisplaySidebarHandle>(null);
  const latestDisplayPayloadRef = useRef<DisplayPayload | null>(null);

  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();

  // Set when the user opted into Live Memory during onboarding without
  // being signed in. We hold the request across the auth roundtrip so
  // we can call `memory.promotePending()` immediately after sign-in.
  const memorySignInPendingRef = useRef(false);

  const isOnChatRoute = Boolean(matchRoute({ to: "/chat" }));

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

  const showAuthDialog = useCallback(() => setDialogSearch("auth"), [
    setDialogSearch,
  ]);
  const showConnectDialog = useCallback(
    () => setDialogSearch("connect"),
    [setDialogSearch],
  );
  const closeDialog = useCallback(() => setDialogSearch(undefined), [
    setDialogSearch,
  ]);

  // One-shot consumer for "user opted into Live Memory but isn't signed
  // in yet" (set during onboarding). On first render after onboarding,
  // we open the auth dialog and remember the intent in a ref so the
  // auth-completion effect below can call `memory.promotePending()`.
  // We deliberately wait for the auth session to finish loading before
  // deciding — otherwise we'd flash the dialog on every refresh.
  useEffect(() => {
    if (isAuthLoading) return;
    if (!consumeRequestSignInAfterOnboarding()) return;
    if (hasConnectedAccount) {
      // Already signed in (e.g. user signed in mid-onboarding). Just
      // promote the pending intent — no dialog needed.
      void window.electronAPI?.memory?.promotePending().catch(() => {
        // Best-effort; user can re-toggle from Settings.
      });
      return;
    }
    memorySignInPendingRef.current = true;
    showAuthDialog();
  }, [hasConnectedAccount, isAuthLoading, showAuthDialog]);

  // Once the user successfully signs in (after we opened the dialog for
  // memory), promote Live Memory's pending intent into a real enable.
  useEffect(() => {
    if (!hasConnectedAccount) return;
    if (!memorySignInPendingRef.current) return;
    memorySignInPendingRef.current = false;
    clearRequestSignInAfterOnboarding();
    void window.electronAPI?.memory?.promotePending().catch(() => {
      // Best-effort; user can re-toggle from Settings.
    });
  }, [hasConnectedAccount]);

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

  const openChatPanel = useCallback((detail: StellaOpenPanelChatDetail = {}) => {
    openChatDisplayTab({ id: Date.now(), ...detail });
  }, []);

  // Display tab rule: Chat is always present in the strip; its body
  // adapts to the route inside `ChatDisplayTab` (home shows the activity
  // / files overview, every other route shows the live chat panel).
  // Tabs are otherwise sticky — only the user closes them.
  useEffect(() => {
    ensureChatDisplayTab();
  }, []);

  const handleContextMenuOpenPanel = useCallback(() => {
    if (isOnChatRoute) {
      dispatchOpenWorkspacePanel();
      return;
    }
    dispatchOpenPanelChat();
  }, [isOnChatRoute]);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot consumer (see comment above).
    handlePendingAskStellaHandled(pendingAskStellaRequest.id);
  }, [
    handlePendingAskStellaHandled,
    isOnChatRoute,
    openChatPanel,
    pendingAskStellaRequest,
  ]);

  // Push payloads into the workspace panel.
  //
  // - `media` and `url` payloads always open the panel (generated artifacts
  //   and live previews are the user's main goal in that moment).
  //   Producers running on the active surface itself (e.g. a future
  //   `MediaStudio` page) should pass `suppress` to the materializer.
  // - For everything else (html / office / pdf), keep the existing behavior:
  //   open on the chat home pane, hot-update elsewhere so we don't steal
  //   focus mid-conversation.
  // - In the mini window, register payloads passively (`ds.update`) and let
  //   the user summon the panel via the right-click context menu.
  const isMiniWindow = state.window === "mini";
  const routeDisplayPayload = useCallback(
    (payload: DisplayPayload) => {
      latestDisplayPayloadRef.current = payload;
      const ds = displaySidebarRef.current;
      if (!ds) return;
      if (isMiniWindow) {
        ds.update(payload);
        return;
      }
      if (
        payload.kind === "media" ||
        payload.kind === "url" ||
        payload.kind === "trash"
      ) {
        ds.open(payload);
        return;
      }
      if (chat.showHomeContent && isOnChatRoute) {
        ds.open(payload);
      } else {
        ds.update(payload);
      }
    },
    [chat.showHomeContent, isMiniWindow, isOnChatRoute],
  );

  // Runtime-side `Display` tool / structured payloads from main process.
  useEffect(() => {
    return window.electronAPI?.display.onUpdate((rawPayload) => {
      const payload = normalizeDisplayPayload(rawPayload);
      if (!payload) return;
      routeDisplayPayload(payload);
    });
  }, [routeDisplayPayload]);

  // If the previous agent run left files in deferred-delete trash, seed the
  // workspace panel with a stable tab without opening UI. The actual Trash tab
  // UI is intentionally deferred; this just wires discovery and tab routing.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.display
      ?.listTrash?.()
      ?.then((result: { items?: unknown[] } | null) => {
        if (cancelled || !result || !Array.isArray(result.items)) return;
        if (result.items.length === 0) return;
        displaySidebarRef.current?.update({
          kind: "trash",
          title: "Trash",
          createdAt: Date.now(),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Owner-scoped materializer: any media job (this conversation, another
  // device, the agent, the studio, ...) gets downloaded into
  // `state/media/outputs/` and surfaced in the workspace panel.
  useMediaMaterializer({ onMaterialized: routeDisplayPayload });

  // Global Cmd/Ctrl+Shift+M (or any dictation accelerator the user picks)
  // arrives here as an IPC signal from the focused window. Re-dispatch as
  // a window event so the active composer's `useDictation` hook can toggle
  // its STT session — this avoids each composer talking to IPC directly.
  useEffect(() => {
    return window.electronAPI?.dictation?.onToggle((payload) => {
      window.dispatchEvent(
        new CustomEvent(DICTATION_TOGGLE_EVENT, {
          detail: payload,
        }),
      );
    });
  }, []);

  // Window-event wiring for the workspace panel.
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<StellaOpenPanelChatDetail>)
        .detail;
      openChatPanel(detail ?? {});
    };

    const handleClose = () => displayTabs.setPanelOpen(false);

    const handleOpenDisplay = () => {
      // Prefer reopening whatever tabs are already in the manager; only
      // fall back to re-routing the last payload when nothing has been
      // opened yet this session. If there is no display payload yet, seed
      // the panel with Ideas so the workspace panel is always openable.
      if (displayTabs.getSnapshot().tabs.length > 0) {
        displayTabs.setPanelOpen(true);
        return;
      }
      const payload = latestDisplayPayloadRef.current;
      if (!payload) {
        openIdeasDisplayTab();
        return;
      }
      displaySidebarRef.current?.open(payload);
    };

    window.addEventListener(STELLA_OPEN_PANEL_CHAT_EVENT, handleOpen);
    window.addEventListener(STELLA_CLOSE_PANEL_EVENT, handleClose);
    window.addEventListener(
      STELLA_OPEN_WORKSPACE_PANEL_EVENT,
      handleOpenDisplay,
    );

    const cleanupIpcOpen = window.electronAPI?.ui.onOpenChatSidebar?.(() => {
      openChatPanel();
    });

    return () => {
      window.removeEventListener(STELLA_OPEN_PANEL_CHAT_EVENT, handleOpen);
      window.removeEventListener(STELLA_CLOSE_PANEL_EVENT, handleClose);
      window.removeEventListener(
        STELLA_OPEN_WORKSPACE_PANEL_EVENT,
        handleOpenDisplay,
      );
      cleanupIpcOpen?.();
    };
  }, [openChatPanel]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const handler = () => {
      if (!mq.matches) setDrawerOpen(false);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Close the mobile drawer whenever the route changes. setState-in-effect is
  // intentional here — the drawer is a UI artifact that should reset on every
  // navigation; the pathname *is* the external state we are syncing from.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpen(false);
  }, [pathname]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <>
      {drawerOpen && (
        <div className="sidebar-drawer-scrim" onClick={closeDrawer} />
      )}

      <ShellTopBar />

      <Sidebar
        className={drawerOpen ? "sidebar--drawer-open" : undefined}
        onSignIn={showAuthDialog}
        onConnect={showConnectDialog}
        onNewAppAskStella={() => {
          closeDrawer();
          handleNewAppAskStella();
        }}
      />

      <StellaContextMenu
        isOpen={isContextMenuPanelOpen}
        onOpen={handleContextMenuOpenPanel}
        onClose={handleContextMenuClosePanel}
      >
        <div className="content-area">
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
          <Outlet />
        </div>
      </StellaContextMenu>

      <DisplaySidebar
        ref={displaySidebarRef}
      />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      <WelcomeDialog
        conversationId={conversationId}
        onConnect={showConnectDialog}
        onSignIn={showAuthDialog}
      />
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
