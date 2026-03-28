import { useEffect, useRef } from "react";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { SocialView } from "@/app/social/SocialView";
import type { ViewType } from "@/shared/contracts/ui";
import { MiniBridgeRelay } from "@/shell/mini/MiniBridgeRelay";
import {
  STELLA_CLOSE_ORB_CHAT_EVENT,
  STELLA_OPEN_ORB_CHAT_EVENT,
  type StellaOpenOrbChatDetail,
} from "@/shared/lib/stella-orb-chat";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import { FloatingOrb, type FloatingOrbHandle } from "./FloatingOrb";
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
  isOrbVisible: boolean;
  onSignIn: () => void;
  pendingAskStellaRequest: PendingAskStellaRequest | null;
  onPendingAskStellaHandled: (requestId: number) => void;
  onOrbChatOpenChange?: (open: boolean) => void;
};

export const FullShellRuntime = ({
  activeConversationId,
  activeView,
  composerEntering,
  conversationId,
  isOrbVisible,
  onSignIn,
  pendingAskStellaRequest,
  onPendingAskStellaHandled,
  onOrbChatOpenChange,
}: FullShellRuntimeProps) => {
  const orbRef = useRef<FloatingOrbHandle>(null);
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
    orbRef.current?.openChat();
    onPendingAskStellaHandled(pendingAskStellaRequest.id);
  }, [onPendingAskStellaHandled, pendingAskStellaRequest]);

  useEffect(() => {
    const handleOpenOrbChat = (event: Event) => {
      const detail = (event as CustomEvent<StellaOpenOrbChatDetail>).detail;
      const chatContext = detail?.chatContext;

      if (chatContext === undefined) {
        orbRef.current?.openChat();
        return;
      }

      orbRef.current?.openChat(chatContext ?? null);
    };

    const handleCloseOrbChat = () => {
      orbRef.current?.closeChat();
    };

    window.addEventListener(STELLA_OPEN_ORB_CHAT_EVENT, handleOpenOrbChat);
    window.addEventListener(STELLA_CLOSE_ORB_CHAT_EVENT, handleCloseOrbChat);
    return () => {
      window.removeEventListener(STELLA_OPEN_ORB_CHAT_EVENT, handleOpenOrbChat);
      window.removeEventListener(STELLA_CLOSE_ORB_CHAT_EVENT, handleCloseOrbChat);
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
        />
      ) : activeView === "social" ? (
        <SocialView onSignIn={onSignIn} />
      ) : null}

      <FloatingOrb
        ref={orbRef}
        visible={isOrbVisible}
        events={chat.conversation.events}
        streamingText={chat.conversation.streamingText}
        reasoningText={chat.conversation.reasoningText}
        isStreaming={chat.conversation.isStreaming}
        pendingUserMessageId={chat.conversation.pendingUserMessageId}
        selfModMap={chat.conversation.selfModMap}
        hasOlderEvents={chat.conversation.hasOlderEvents}
        isLoadingOlder={chat.conversation.isLoadingOlder}
        isInitialLoading={chat.conversation.isInitialLoading}
        onAdd={chat.composer.onAdd}
        onSend={chat.conversation.sendMessageWithContext}
        onChatOpenChange={onOrbChatOpenChange}
      />
    </>
  );
};
