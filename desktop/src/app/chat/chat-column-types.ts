import type { Dispatch, RefCallback, SetStateAction } from 'react'
import type { TaskProgressSummaries } from '@/app/chat/hooks/use-task-progress-summaries'
import type { QueuedUserMessage } from '@/app/chat/hooks/use-streaming-chat'
import type { EventRecord, TaskItem } from '@/app/chat/lib/event-transforms'
import type {
  AgentResponseTarget,
  SelfModAppliedData,
} from '@/app/chat/streaming/streaming-types'
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
    selfModMap: Record<string, SelfModAppliedData>
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

export type ChatColumnScroll = {
  setViewportElement: RefCallback<HTMLDivElement>
  setContentElement: RefCallback<HTMLDivElement>
  onScroll: () => void
  showScrollButton: boolean
  /** True when the user is at (or within ~1px of) the newest-content edge. */
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
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
}
