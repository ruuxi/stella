import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { useChatRuntime } from "@/context/chat-runtime";
import { useUiState } from "@/context/ui-state";
import { Route } from "@/routes/chat";

export function ChatApp() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { state, setConversationId } = useUiState();
  const chat = useChatRuntime();

  /**
   * `?c=<id>` is the canonical handle for the active conversation (deep-
   * linkable, persistable). On first paint after bootstrap, the conversation
   * id arrives in `state.conversationId` before any URL exists, so we
   * promote it into the URL via `replace`. Conversely, a deep-link or
   * back-nav into `/chat?c=<id>` writes the id back into `UiState` so the
   * voice overlay and any other window-scoped consumers stay in sync.
   */
  const conversationId = search.c ?? state.conversationId;

  useEffect(() => {
    if (!search.c && state.conversationId) {
      void navigate({
        to: "/chat",
        search: { c: state.conversationId },
        replace: true,
      });
      return;
    }
    if (search.c && search.c !== state.conversationId) {
      setConversationId(search.c);
    }
  }, [navigate, search.c, setConversationId, state.conversationId]);

  return (
    <ChatColumn
      conversation={chat.conversation}
      composer={chat.composer}
      scroll={chat.scroll}
      conversationId={conversationId}
      showHomeContent={chat.showHomeContent}
      onSuggestionClick={chat.onSuggestionClick}
      onDismissHome={chat.dismissHome}
    />
  );
}

export default ChatApp;
