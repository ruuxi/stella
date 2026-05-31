export type QueuedUserMessage = {
  id: string
  text: string
  timestamp: number
}

export type TerminalRunOutcome = 'completed' | 'error' | 'canceled'

export const removeQueuedUserMessageById = (
  messages: QueuedUserMessage[],
  messageId: string,
) => messages.filter((message) => message.id !== messageId)

export const shouldClearQueuedUserMessagesForRunOutcome = (
  outcome: TerminalRunOutcome,
) => outcome === 'error' || outcome === 'canceled'
