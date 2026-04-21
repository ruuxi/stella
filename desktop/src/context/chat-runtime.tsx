import { type ReactNode } from 'react'
import { useFullShellChat } from '@/shell/use-full-shell-chat'
import { ChatRuntimeContext } from '@/context/chat-runtime-context'

/**
 * Hoists `useFullShellChat`'s output into a single Context so the chat
 * route (`apps/chat`) and the floating ChatSidebar / DisplaySidebar overlays
 * mounted by `__root.tsx` all consume the same conversation state. Running
 * the hook once also keeps Convex subscriptions deduplicated.
 *
 * The matching `useChatRuntime` hook lives in
 * `@/context/use-chat-runtime` — they are deliberately split so this file
 * exports *only* the Provider component and stays Fast-Refresh eligible.
 */
type ChatRuntimeProviderProps = {
  activeConversationId: string | null
  isOnChatRoute: boolean
  children: ReactNode
}

export function ChatRuntimeProvider({
  activeConversationId,
  isOnChatRoute,
  children,
}: ChatRuntimeProviderProps) {
  const runtime = useFullShellChat({
    activeConversationId,
    isOnChatRoute,
    isDev: import.meta.env.DEV,
  })

  return (
    <ChatRuntimeContext.Provider value={runtime}>
      {children}
    </ChatRuntimeContext.Provider>
  )
}
