import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./index.css";
import "./ui/register-styles";
import "./shared/styles/app-base.css";
import "./shared/i18n/rtl.css";
import "./mini-entry.css";

import { LocalChatStoreProvider } from "./context/chat-store-context";
import { ThemeProvider, useTheme } from "./context/theme-context";
import { ShiftingGradient } from "./shell/background/ShiftingGradient";
import { UiStateProvider } from "./context/ui-state";
import { BootstrapStateProvider } from "./bootstrap/bootstrap-state";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { ChatPanelTab, type ChatPanelOpenRequest } from "./shell/ChatSidebar";
import { ToastProvider } from "./ui/toast";
import {
  LocalI18nProvider,
  useLocale,
} from "./shared/i18n/I18nProvider";
import { readActiveConversationIdCache, writeActiveConversationIdCache } from "./features/chat/services/active-conversation-cache";
import {
  createNewLocalConversationId,
  setActiveLocalConversationId,
} from "./features/chat/services/local-chat-store";
import { useConversationActivity } from "./features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "./features/chat/hooks/use-conversation-display-messages";
import { useConversationMessages } from "./features/chat/hooks/use-conversation-messages";
import { useStreamingChatCore } from "./features/chat/hooks/use-streaming-chat-core";

document.documentElement.dataset.stellaWindow = "mini";

const noopNotifyTierRestrictedModel = () => {};

function useMiniActiveConversationId() {
  const [conversationId, setConversationId] = useState<string | null>(() =>
    readActiveConversationIdCache(),
  );

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI?.localChat;
    if (!api) return;

    void api
      .getOrCreateDefaultConversationId()
      .then((activeConversationId) => {
        if (cancelled || !activeConversationId) return;
        setConversationId(activeConversationId);
      })
      .catch(() => {
        if (!cancelled) setConversationId((current) => current ?? null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    writeActiveConversationIdCache(conversationId);
    void setActiveLocalConversationId(conversationId);
  }, [conversationId]);

  return { conversationId, setConversationId };
}

function MiniChatSurface() {
  const locale = useLocale();
  const { gradientMode, gradientColor } = useTheme();
  const { conversationId, setConversationId } = useMiniActiveConversationId();

  // Focus the composer each time the mini window opens / regains focus, so the
  // user can type immediately and focus never lands on the scrollable message
  // region (a keyboard-focusable scroller that would otherwise draw a
  // focus-ring "selected" border on open). Mirrors the full window, which
  // focuses the composer whenever chat opens.
  const [composerFocusRequest, setComposerFocusRequest] =
    useState<ChatPanelOpenRequest>({ id: 1 });
  useEffect(() => {
    const onFocus = () =>
      setComposerFocusRequest((prev) => ({ id: prev.id + 1 }));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const {
    messages: persistedMessages,
    hasOlderMessages,
    isLoadingOlder: isLoadingOlderMessages,
    isInitialLoading: isInitialLoadingMessages,
    loadOlder: loadOlderMessages,
  } = useConversationMessages(conversationId ?? undefined);

  const {
    activities,
    latestMessageTimestampMs,
  } = useConversationActivity(conversationId ?? undefined);

  const {
    liveTasks,
    optimisticEvents,
    runtimeStatusText,
    streamingAssistants,
    isStreaming,
    pendingUserMessageId,
    queuedUserMessages,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChatCore({
    conversationId,
    locale,
    notifyTierRestrictedModel: noopNotifyTierRestrictedModel,
    persistedMessages,
  });

  const displayMessages = useConversationDisplayMessages({
    conversationId,
    persistedMessages,
    optimisticEvents,
    streamingAssistants,
  });

  const startNewChat = useCallback(async () => {
    const nextConversationId = await createNewLocalConversationId();
    setConversationId(nextConversationId);
  }, [setConversationId]);

  const handleSend = useCallback(
    (
      text: string,
      chatContext?: Parameters<typeof sendMessage>[0]["chatContext"],
      selectedText?: string | null,
    ) => {
      void sendMessage({
        text,
        chatContext: chatContext ?? null,
        selectedText: selectedText ?? null,
        onClear: () => {},
      });
    },
    [sendMessage],
  );

  const loadingConversation = !conversationId || isInitialLoadingMessages;
  const messages = useMemo(
    () => (conversationId ? displayMessages : []),
    [conversationId, displayMessages],
  );

  return (
    <div className="mini-chat-app">
      <div className="mini-chat-shell">
        <ShiftingGradient
          mode={gradientMode}
          colorMode={gradientColor}
          lightweight={false}
          contained
        />
        <div className="mini-chat-drag-strip" aria-hidden="true" />
        <div className="mini-chat-content">
          <ChatPanelTab
            openRequest={composerFocusRequest}
            conversationId={conversationId}
            variant="mini"
            messages={messages}
            activities={activities}
            latestMessageTimestampMs={latestMessageTimestampMs}
            isStreaming={isStreaming}
            runtimeStatusText={runtimeStatusText}
            pendingUserMessageId={pendingUserMessageId}
            queuedUserMessages={queuedUserMessages}
            liveTasks={liveTasks}
            hasOlderMessages={hasOlderMessages}
            isLoadingOlder={isLoadingOlderMessages}
            isInitialLoading={loadingConversation}
            onLoadOlder={loadOlderMessages}
            onSend={handleSend}
            onStop={cancelCurrentStream}
            onNewChat={startNewChat}
          />
        </div>
      </div>
    </div>
  );
}

function MiniRoot() {
  return (
    <ErrorBoundary>
      <LocalI18nProvider>
        <ThemeProvider>
          <ToastProvider>
            <BootstrapStateProvider>
              <UiStateProvider>
                <LocalChatStoreProvider>
                  <MiniChatSurface />
                </LocalChatStoreProvider>
              </UiStateProvider>
            </BootstrapStateProvider>
          </ToastProvider>
        </ThemeProvider>
      </LocalI18nProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(<MiniRoot />);
