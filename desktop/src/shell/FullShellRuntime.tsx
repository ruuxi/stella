import { useCallback, useEffect, useRef } from "react";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { useDisplayAutoRoute } from "@/app/chat/use-display-auto-route";
import { SocialView } from "@/app/social/SocialView";
import {
  type DisplayPayload,
  normalizeDisplayPayload,
} from "@/shared/contracts/display-payload";
import type { ViewType } from "@/shared/contracts/ui";
import {
  STELLA_CLOSE_DISPLAY_SIDEBAR_EVENT,
  STELLA_CLOSE_SIDEBAR_CHAT_EVENT,
  STELLA_OPEN_DISPLAY_SIDEBAR_EVENT,
  STELLA_OPEN_SIDEBAR_CHAT_EVENT,
  type StellaOpenSidebarChatDetail,
} from "@/shared/lib/stella-orb-chat";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import { dispatchStellaPinSuggestion } from "@/shared/lib/stella-suggestions";
import type { SuggestionChip } from "@/app/chat/hooks/use-auto-context-chips";
import { ChatSidebar, type ChatSidebarHandle } from "./ChatSidebar";
import { DisplaySidebar, type DisplaySidebarHandle } from "./DisplaySidebar";
import { useFullShellChat } from "./use-full-shell-chat";

type PendingAskStellaRequest = {
  id: number;
  text: string;
};

type FullShellRuntimeProps = {
  activeConversationId: string | null;
  activeView: ViewType;
  composerEntering: boolean;
  conversationId: string | null;
  onSignIn: () => void;
  pendingAskStellaRequest: PendingAskStellaRequest | null;
  onPendingAskStellaHandled: (requestId: number) => void;
  onSidebarChatOpenChange?: (open: boolean) => void;
  onDisplaySidebarOpenChange?: (open: boolean) => void;
  onHomeContentChange?: (showing: boolean) => void;
};

export const FullShellRuntime = ({
  activeConversationId,
  activeView,
  composerEntering,
  conversationId,
  onSignIn,
  pendingAskStellaRequest,
  onPendingAskStellaHandled,
  onSidebarChatOpenChange,
  onDisplaySidebarOpenChange,
  onHomeContentChange,
}: FullShellRuntimeProps) => {
  const sidebarRef = useRef<ChatSidebarHandle>(null);
  const displaySidebarRef = useRef<DisplaySidebarHandle>(null);
  const latestDisplayPayloadRef = useRef<DisplayPayload | null>(null);
  const chat = useFullShellChat({
    activeConversationId,
    activeView,
    isDev: import.meta.env.DEV,
  });

  useEffect(() => {
    onHomeContentChange?.(chat.showHomeContent);
  }, [chat.showHomeContent, onHomeContentChange]);

  const activeViewRef = useRef(activeView);
  const showHomeContentRef = useRef(chat.showHomeContent);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    showHomeContentRef.current = chat.showHomeContent;
  }, [chat.showHomeContent]);

  useEffect(() => {
    if (!pendingAskStellaRequest) {
      return;
    }

    dispatchStellaSendMessage({
      text: pendingAskStellaRequest.text,
      uiVisibility: "hidden",
      triggerKind: WORKSPACE_CREATION_TRIGGER_KIND,
      triggerSource: "sidebar",
    });
    sidebarRef.current?.open();
    onPendingAskStellaHandled(pendingAskStellaRequest.id);
  }, [onPendingAskStellaHandled, pendingAskStellaRequest]);

  // Push a new payload (HTML, office preview, PDF) into the Display
  // sidebar. When the home pane is visible inside the chat view the first
  // payload also opens the sidebar; otherwise we only hot-update its
  // content so we don't steal focus from whatever the user is doing.
  const routeDisplayPayload = useCallback((payload: DisplayPayload) => {
    latestDisplayPayloadRef.current = payload;
    const ds = displaySidebarRef.current;
    if (!ds) return;
    if (showHomeContentRef.current && activeViewRef.current === "chat") {
      ds.open(payload);
    } else {
      ds.update(payload);
    }
  }, []);

  // Runtime-side `Display` tool / future structured payloads arrive here.
  // The legacy channel passes a raw HTML string; structured payloads come
  // through as a `DisplayPayload`. `normalizeDisplayPayload` accepts both.
  useEffect(() => {
    return window.electronAPI?.display.onUpdate((rawPayload) => {
      const payload = normalizeDisplayPayload(rawPayload);
      if (!payload) return;
      routeDisplayPayload(payload);
    });
  }, [routeDisplayPayload]);

  // Renderer-side auto-routing: when a chat tool result produces something
  // visual (office preview ref, PDF read), surface it in the sidebar
  // automatically. No new tool call required from the agent.
  useDisplayAutoRoute(chat.conversation.events, routeDisplayPayload);

  // Cmd+right-click → "Open chat" surfaces the pointed-at window as a one-shot
  // suggestion chip in the sidebar. The main process broadcasts via
  // `home:pinSuggestion` (typed via `electronAPI.home.onPinSuggestion`); we
  // re-dispatch as a window event so the suggestion-row hook can absorb it
  // without coupling to electronAPI directly.
  useEffect(() => {
    return window.electronAPI?.home.onPinSuggestion((payload) => {
      if (payload?.chip) {
        dispatchStellaPinSuggestion({
          chip: payload.chip as SuggestionChip,
        });
      }
    });
  }, []);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<StellaOpenSidebarChatDetail>).detail;
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

    const handleClose = () => {
      sidebarRef.current?.close();
    };

    const handleOpenDisplay = () => {
      const payload = latestDisplayPayloadRef.current;
      if (!payload) return;
      displaySidebarRef.current?.open(payload);
    };

    const handleCloseDisplay = () => {
      displaySidebarRef.current?.close();
    };

    window.addEventListener(STELLA_OPEN_SIDEBAR_CHAT_EVENT, handleOpen);
    window.addEventListener(STELLA_CLOSE_SIDEBAR_CHAT_EVENT, handleClose);
    window.addEventListener(STELLA_OPEN_DISPLAY_SIDEBAR_EVENT, handleOpenDisplay);
    window.addEventListener(STELLA_CLOSE_DISPLAY_SIDEBAR_EVENT, handleCloseDisplay);

    // The global Cmd+RightClick → "Open chat" menu fires this from main
    // after the mini window finishes loading.
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

  return (
    <>
      {activeView === "chat" ? (
        <ChatColumn
          conversation={chat.conversation}
          composer={chat.composer}
          scroll={chat.scroll}
          composerEntering={composerEntering}
          conversationId={conversationId}
          showHomeContent={chat.showHomeContent}
          onSuggestionClick={chat.onSuggestionClick}
          onDismissHome={chat.dismissHome}
        />
      ) : activeView === "social" ? (
        <SocialView onSignIn={onSignIn} />
      ) : null}

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
        onOpenChange={onSidebarChatOpenChange}
      />

      <DisplaySidebar
        ref={displaySidebarRef}
        onOpenChange={onDisplaySidebarOpenChange}
      />
    </>
  );
};
