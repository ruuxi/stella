import { useEffect, useRef } from "react";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { SocialView } from "@/app/social/SocialView";
import type { ViewType } from "@/shared/contracts/ui";
import { MiniBridgeRelay } from "@/shell/mini/MiniBridgeRelay";
import {
  STELLA_CLOSE_SIDEBAR_CHAT_EVENT,
  STELLA_OPEN_SIDEBAR_CHAT_EVENT,
  type StellaOpenSidebarChatDetail,
} from "@/shared/lib/stella-orb-chat";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import { ChatSidebar, type ChatSidebarHandle } from "./ChatSidebar";
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
}: FullShellRuntimeProps) => {
  const sidebarRef = useRef<ChatSidebarHandle>(null);
  const chat = useFullShellChat({
    activeConversationId,
    activeView,
    isDev: import.meta.env.DEV,
  });

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

  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;

  // Close sidebar when navigating to chat/home
  useEffect(() => {
    if (activeView === "chat") {
      sidebarRef.current?.close();
    }
  }, [activeView]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      if (activeViewRef.current === "chat") return;

      const detail = (event as CustomEvent<StellaOpenSidebarChatDetail>).detail;
      const chatContext = detail?.chatContext;

      if (chatContext === undefined) {
        sidebarRef.current?.open();
        return;
      }

      sidebarRef.current?.open(chatContext ?? null);
    };

    const handleClose = () => {
      sidebarRef.current?.close();
    };

    window.addEventListener(STELLA_OPEN_SIDEBAR_CHAT_EVENT, handleOpen);
    window.addEventListener(STELLA_CLOSE_SIDEBAR_CHAT_EVENT, handleClose);
    return () => {
      window.removeEventListener(STELLA_OPEN_SIDEBAR_CHAT_EVENT, handleOpen);
      window.removeEventListener(STELLA_CLOSE_SIDEBAR_CHAT_EVENT, handleClose);
    };
  }, []);

  return (
    <>
      <MiniBridgeRelay
        conversationId={activeConversationId}
        events={chat.conversation.events}
        streamingText={chat.conversation.streamingText}
        reasoningText={chat.conversation.reasoningText}
        isStreaming={chat.conversation.isStreaming}
        pendingUserMessageId={chat.conversation.pendingUserMessageId}
        sendMessage={chat.conversation.sendMessage}
        cancelCurrentStream={chat.conversation.cancelCurrentStream}
      />

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
          onShowHome={chat.showHome}
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
    </>
  );
};
