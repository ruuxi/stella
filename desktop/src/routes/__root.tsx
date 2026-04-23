import {
  createRootRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  createElement,
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
import { IdeasTabContent } from "@/app/home/IdeasTabContent";
import { useDisplayAutoRoute } from "@/app/chat/use-display-auto-route";
import { useMediaMaterializer } from "@/app/media/use-media-materializer";
import {
  ChatSidebar,
  type ChatSidebarHandle,
} from "@/shell/ChatSidebar";
import {
  DisplaySidebar,
  type DisplaySidebarHandle,
} from "@/shell/DisplaySidebar";
import { displayTabs } from "@/shell/display/tab-store";
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
  STELLA_CLOSE_DISPLAY_SIDEBAR_EVENT,
  STELLA_CLOSE_SIDEBAR_CHAT_EVENT,
  STELLA_OPEN_DISPLAY_SIDEBAR_EVENT,
  STELLA_OPEN_SIDEBAR_CHAT_EVENT,
  type StellaOpenSidebarChatDetail,
} from "@/shared/lib/stella-orb-chat";
import {
  clearRequestSignInAfterOnboarding,
  consumeRequestSignInAfterOnboarding,
  dispatchCloseDisplaySidebar,
  dispatchCloseSidebarChat,
  dispatchOpenDisplaySidebar,
  dispatchOpenSidebarChat,
} from "@/shared/lib/stella-orb-chat";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import { dispatchStellaPinSuggestion } from "@/shared/lib/stella-suggestions";
import type { SuggestionChip } from "@/app/chat/hooks/use-auto-context-chips";
import { DICTATION_TOGGLE_EVENT } from "@/features/dictation/hooks/use-dictation";

const NEW_APP_ASK_STELLA_PROMPT =
  "The user wants to create a new workspace (app) added to the sidebar with its own content. Be concise and provide 2-4 suggestions and ideas.";

const DEFAULT_DISPLAY_TAB_ID = "ideas:default";

type PendingAskStellaRequest = {
  id: number;
  text: string;
};

/**
 * The root route owns the app chrome — sidebar, floating ChatSidebar /
 * DisplaySidebar overlays, dialogs, welcome — plus an `<Outlet />` where the
 * active route renders. Chat runtime state is hoisted into a provider so
 * both the chat route and the floating sidebars consume the same hook
 * output.
 */
function RootLayout() {
  const { state } = useUiState();
  const conversationId = state.conversationId;
  const matchRoute = useMatchRoute();
  const isOnChatRoute = Boolean(matchRoute({ to: "/chat" }));
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

  const [pendingAskStellaRequest, setPendingAskStellaRequest] =
    useState<PendingAskStellaRequest | null>(null);
  const [isSidebarChatOpen, setIsSidebarChatOpen] = useState(false);
  const [isDisplaySidebarOpen, setIsDisplaySidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sidebarRef = useRef<ChatSidebarHandle>(null);
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

  // When the user starts a "new app" flow from the sidebar, the prompt goes
  // into the floating ChatSidebar (opened below). The main chat column would
  // otherwise still show the home overlay (suggestions / categories), which
  // distracts from the workspace-creation conversation. Pre-router this was
  // achieved by switching the active view to a stub "app" view; we now
  // achieve the same by dismissing the home overlay when on `/chat`.
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

  const handleContextMenuOpenSidebarChat = useCallback(() => {
    if (isOnChatRoute) {
      dispatchOpenDisplaySidebar();
      return;
    }
    dispatchOpenSidebarChat();
  }, [isOnChatRoute]);

  const handleContextMenuCloseSidebarChat = useCallback(() => {
    if (isOnChatRoute) {
      dispatchCloseDisplaySidebar();
      return;
    }
    dispatchCloseSidebarChat();
  }, [isOnChatRoute]);

  const isContextMenuPanelOpen = isOnChatRoute
    ? isDisplaySidebarOpen
    : isSidebarChatOpen;

  // In the mini window the chat sidebar covers `.content-area`, so the
  // root-level `StellaContextMenu` is unreachable. Forward right-clicks
  // on the chat sidebar surface to the same display-sidebar toggle the
  // context menu uses on the full window.
  const handleChatSidebarContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (state.window !== "mini") return;
      event.preventDefault();
      if (isDisplaySidebarOpen) {
        dispatchCloseDisplaySidebar();
      } else {
        dispatchOpenDisplaySidebar();
      }
    },
    [isDisplaySidebarOpen, state.window],
  );

  // Forward pending ask-Stella requests into the right-side ChatSidebar.
  // We deliberately clear the queued request from this effect — the state
  // here is acting as a one-shot mailbox, not derived state. The cascade is
  // bounded (one render to null), so the lint rule is suppressed here.
  useEffect(() => {
    if (!pendingAskStellaRequest) return;

    dispatchStellaSendMessage({
      text: pendingAskStellaRequest.text,
      uiVisibility: "hidden",
      triggerKind: WORKSPACE_CREATION_TRIGGER_KIND,
      triggerSource: "sidebar",
    });
    sidebarRef.current?.open();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot consumer (see comment above).
    handlePendingAskStellaHandled(pendingAskStellaRequest.id);
  }, [handlePendingAskStellaHandled, pendingAskStellaRequest]);

  // Push payloads into the Display sidebar.
  //
  // - `media` payloads always open the sidebar (a generated image/video/audio
  //   is the user's main goal in that moment; surfacing it is non-negotiable).
  //   Producers running on the active surface itself (e.g. a future
  //   `MediaStudio` page) should pass `suppress` to the materializer.
  // - For everything else (html / office / pdf), keep the existing behavior:
  //   open on the chat home pane, hot-update elsewhere so we don't steal
  //   focus mid-conversation.
  // - In the mini window the chat is the entire surface, so opening the
  //   display panel would cover everything. We register every payload
  //   passively (`ds.update`) and let the user summon the panel via the
  //   right-click context menu — same gesture as the full window.
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
      if (payload.kind === "media") {
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

  // Renderer-side auto-routing: chat tool results that produce visual
  // payloads (office preview, PDF read) surface in the Display sidebar.
  useDisplayAutoRoute(chat.conversation.events, routeDisplayPayload);

  // Owner-scoped materializer: any media job (this conversation, another
  // device, the agent, the studio, …) gets downloaded into
  // `state/media/outputs/` and surfaced in the Display sidebar.
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

  // Cmd+right-click → "Open chat" on a window dispatches a context chip.
  useEffect(() => {
    return window.electronAPI?.home.onPinSuggestion((payload) => {
      if (payload?.chip) {
        dispatchStellaPinSuggestion({
          chip: payload.chip as SuggestionChip,
        });
      }
    });
  }, []);

  // Window-event wiring for the floating sidebars (orb → open sidebar chat,
  // context menu → open display, IPC from main when the mini chat is opened).
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<StellaOpenSidebarChatDetail>)
        .detail;
      const chatContext = detail?.chatContext;
      const prefillText = detail?.prefillText;

      if (chatContext === undefined && prefillText === undefined) {
        sidebarRef.current?.open();
        return;
      }

      sidebarRef.current?.open({
        ...(chatContext !== undefined ? { chatContext } : {}),
        ...(prefillText !== undefined ? { prefillText } : {}),
      });
    };

    const handleClose = () => sidebarRef.current?.close();

    const handleOpenDisplay = () => {
      // Prefer reopening whatever tabs are already in the manager; only
      // fall back to re-routing the last payload when nothing has been
      // opened yet this session. If there is no display payload yet, seed
      // the panel with Ideas so the display sidebar is always openable.
      if (displayTabs.getSnapshot().tabs.length > 0) {
        displayTabs.setPanelOpen(true);
        return;
      }
      const payload = latestDisplayPayloadRef.current;
      if (!payload) {
        displayTabs.openTab({
          id: DEFAULT_DISPLAY_TAB_ID,
          kind: "ideas",
          title: "Ideas",
          render: () => createElement(IdeasTabContent),
        });
        return;
      }
      displaySidebarRef.current?.open(payload);
    };

    const handleCloseDisplay = () => displaySidebarRef.current?.close();

    window.addEventListener(STELLA_OPEN_SIDEBAR_CHAT_EVENT, handleOpen);
    window.addEventListener(STELLA_CLOSE_SIDEBAR_CHAT_EVENT, handleClose);
    window.addEventListener(
      STELLA_OPEN_DISPLAY_SIDEBAR_EVENT,
      handleOpenDisplay,
    );
    window.addEventListener(
      STELLA_CLOSE_DISPLAY_SIDEBAR_EVENT,
      handleCloseDisplay,
    );

    const cleanupIpcOpen = window.electronAPI?.ui.onOpenChatSidebar?.(() => {
      sidebarRef.current?.open();
    });

    return () => {
      window.removeEventListener(STELLA_OPEN_SIDEBAR_CHAT_EVENT, handleOpen);
      window.removeEventListener(STELLA_CLOSE_SIDEBAR_CHAT_EVENT, handleClose);
      window.removeEventListener(
        STELLA_CLOSE_DISPLAY_SIDEBAR_EVENT,
        handleCloseDisplay,
      );
      window.removeEventListener(
        STELLA_OPEN_DISPLAY_SIDEBAR_EVENT,
        handleOpenDisplay,
      );
      cleanupIpcOpen?.();
    };
  }, []);

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

      <ChatSidebar
        ref={sidebarRef}
        events={chat.conversation.events}
        streamingText={chat.conversation.streamingText}
        reasoningText={chat.conversation.reasoningText}
        isStreaming={chat.conversation.isStreaming}
        runtimeStatusText={chat.conversation.streaming.runtimeStatusText}
        pendingUserMessageId={chat.conversation.pendingUserMessageId}
        selfModMap={chat.conversation.selfModMap}
        liveTasks={chat.conversation.streaming.liveTasks}
        hasOlderEvents={chat.conversation.hasOlderEvents}
        isLoadingOlder={chat.conversation.isLoadingOlder}
        isInitialLoading={chat.conversation.isInitialLoading}
        onAdd={chat.composer.onAdd}
        onSend={chat.conversation.sendMessageWithContext}
        onOpenChange={setIsSidebarChatOpen}
        onContextMenu={handleChatSidebarContextMenu}
      />

      <DisplaySidebar
        ref={displaySidebarRef}
        onOpenChange={setIsDisplaySidebarOpen}
      />

      <FullShellDialogs
        activeDialog={activeDialog ?? null}
        onDialogOpenChange={handleDialogOpenChange}
      />

      <WelcomeDialog
        conversationId={conversationId}
        onConnect={showConnectDialog}
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
