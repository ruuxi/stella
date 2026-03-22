import { useEffect, useRef } from "react";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { SocialView } from "@/app/social/SocialView";
import type { ViewType } from "@/shared/contracts/ui";
import { MiniBridgeRelay } from "@/shell/mini/MiniBridgeRelay";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import { FloatingOrb, type FloatingOrbHandle } from "./FloatingOrb";
import { useFullShellChat } from "./use-full-shell-chat";
import { useFullShellVoiceTranscript } from "./use-full-shell-voice-transcript";

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
}: FullShellRuntimeProps) => {
  const orbRef = useRef<FloatingOrbHandle>(null);
  const chat = useFullShellChat({
    activeConversationId,
    activeView,
    isDev: import.meta.env.DEV,
  });

  useFullShellVoiceTranscript({
    activeView,
    orbRef,
    setMessage: chat.composer.setMessage,
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
        onSend={chat.conversation.sendContextlessMessage}
      />
    </>
  );
};
