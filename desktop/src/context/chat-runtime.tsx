import { type ReactNode } from 'react'
import { useFullShellChat } from '@/shell/use-full-shell-chat'
import { ChatRuntimeContext } from '@/context/chat-runtime-context'
import { usePetStatusBroadcast } from '@/shell/pet/use-pet-status-broadcast'

/**
 * Hoists `useFullShellChat`'s output into a single Context so the chat
 * route (`app/chat`) and the floating ChatSidebar / DisplaySidebar overlays
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

  // Broadcast a derived PetOverlayStatus alongside the existing working
  // indicator so the floating pet always mirrors the same agent state
  // the chat surface displays.
  usePetStatusBroadcast({
    messages: runtime.conversation.messages,
    liveTasks: runtime.conversation.streaming.liveTasks,
    runtimeStatusText: runtime.conversation.streaming.runtimeStatusText ?? '',
    isStreaming: runtime.conversation.isStreaming,
    pendingUserMessageId: runtime.conversation.pendingUserMessageId ?? null,
  })

  return (
    <ChatRuntimeContext.Provider value={runtime}>
      {children}
    </ChatRuntimeContext.Provider>
  )
}
