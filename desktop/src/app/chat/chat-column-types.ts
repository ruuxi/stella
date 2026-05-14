import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { LegendListRef, NativeScrollEvent, NativeSyntheticEvent } from '@legendapp/list/react'
import type { TaskProgressSummaries } from '@/app/chat/hooks/use-task-progress-summaries'
import type { QueuedUserMessage } from '@/app/chat/hooks/use-streaming-chat'
import type { EventRecord, TaskItem } from '@/app/chat/lib/event-transforms'
import type { AgentResponseTarget } from '@/app/chat/streaming/streaming-types'
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
    responseTarget?: AgentResponseTarget | null
    isStreaming: boolean
    runtimeStatusText?: string | null
    pendingUserMessageId: string | null
    queuedUserMessages: QueuedUserMessage[]
    optimisticUserMessageIds: string[]
    liveTasks?: TaskItem[]
    taskProgressSummaries: TaskProgressSummaries
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
  focusRequestId?: number
  onSend: () => void
  onStop: () => void
}

/**
 * Scroll API for chat surfaces.
 *
 * Backed by `@legendapp/list/react` (Legend List v3 web entry):
 * the surface attaches `listRef` to the `<LegendList>` and forwards
 * `onListScroll` to its `onScroll` prop. The hook drives custom
 * scrollbar thumb state, "at bottom" tracking, and `scrollToBottom`
 * via the list's imperative API.
 */
export type ChatColumnScroll = {
  listRef: RefObject<LegendListRef | null>
  onListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  /** Forwarded to Legend List's `onStartReached` for older-history pagination. */
  onStartReached: () => void
  showScrollButton: boolean
  /** True when the user is at (or within ~1px of) the newest-content edge. */
  isAtBottom: boolean
  /** True when close enough to the bottom that auto-follow affordances apply. */
  isNearBottom: boolean
  /** Reads the live list geometry, avoiding one-render-late scroll state. */
  getIsNearBottom: () => boolean
  scrollToBottom: (behavior?: 'instant' | 'smooth') => void
  thumbState: ChatColumnThumbState
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
}
