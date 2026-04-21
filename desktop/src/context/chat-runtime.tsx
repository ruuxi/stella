import { createContext, useContext, type ReactNode } from "react";
import { useFullShellChat } from "@/shell/use-full-shell-chat";

/**
 * The chat runtime — `useFullShellChat`'s output — needs to be available to
 * both the chat route (`apps/chat`) and the floating chat/display sidebars
 * mounted in `__root.tsx`. We hoist the hook into a single provider so it
 * runs once and both consumers see the same conversation state.
 */
type ChatRuntime = ReturnType<typeof useFullShellChat>;

const ChatRuntimeContext = createContext<ChatRuntime | null>(null);

type ChatRuntimeProviderProps = {
  activeConversationId: string | null;
  isOnChatRoute: boolean;
  children: ReactNode;
};

export function ChatRuntimeProvider({
  activeConversationId,
  isOnChatRoute,
  children,
}: ChatRuntimeProviderProps) {
  const runtime = useFullShellChat({
    activeConversationId,
    isOnChatRoute,
    isDev: import.meta.env.DEV,
  });

  return (
    <ChatRuntimeContext.Provider value={runtime}>
      {children}
    </ChatRuntimeContext.Provider>
  );
}

export function useChatRuntime(): ChatRuntime {
  const ctx = useContext(ChatRuntimeContext);
  if (!ctx) {
    throw new Error("useChatRuntime must be used within ChatRuntimeProvider");
  }
  return ctx;
}
