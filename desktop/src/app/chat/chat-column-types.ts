import type { Dispatch, RefCallback, SetStateAction } from 'react'
import type { EventRecord, TaskItem } from '@/app/chat/lib/event-transforms'
import type { SelfModAppliedData } from '@/app/chat/streaming/streaming-types'
import type { ChatContext } from '@/shared/types/electron'

type ChatColumnThumbState = {
  top: number
  height: number
  visible: boolean
}

export type ChatColumnConversation = {
  events: EventRecord[]
  streaming: {
    text: string
    reasoningText: string
    subagentStreamingText?: string
    isStreaming: boolean
    runtimeStatusText?: string | null
    pendingUserMessageId: string | null
    selfModMap: Record<string, SelfModAppliedData>
    liveTasks?: TaskItem[]
  }
  history: {
    hasOlderEvents: boolean
    isLoadingOlder: boolean
    isInitialLoading: boolean
  }
}

export type ChatColumnComposer = {
  message: string
  setMessage: Dispatch<SetStateAction<string>>
  chatContext: ChatContext | null
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>
  selectedText: string | null
  setSelectedText: Dispatch<SetStateAction<string | null>>
  canSubmit: boolean
  onAdd?: () => void
  onSend: () => void
  onStop: () => void
}

export type ChatColumnScroll = {
  setViewportElement: RefCallback<HTMLDivElement>
  setContentElement: RefCallback<HTMLDivElement>
  onScroll: () => void
  showScrollButton: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /** Scroll so the turn's top aligns with the reading area (column-reverse viewport). */
  scrollTurnToPinTop: (turnId: string) => boolean
  overflowAnchor: 'auto' | 'none'
  thumbState: ChatColumnThumbState
  hasScrollElement?: boolean
}

export type ChatColumnProps = {
  conversation: ChatColumnConversation
  composer: ChatColumnComposer
  scroll: ChatColumnScroll
  composerEntering?: boolean
  conversationId: string | null
  showHomeContent?: boolean
  onSuggestionClick?: (prompt: string) => void
  onDismissHome?: () => void
  onShowHome?: () => void
}
