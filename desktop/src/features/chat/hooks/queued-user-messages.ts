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

/**
 * Resolves the composer text after a queued message is cancelled and its
 * text restored. When the composer is empty we drop the restored text in
 * wholesale so the user can immediately edit/resend it. When the composer
 * already holds an unsent draft we don't clobber it — the restored text is
 * appended below the draft (separated by a blank line) so nothing the user
 * was typing is lost.
 */
export const restoreQueuedTextToComposer = (
  currentComposerText: string,
  restoredText: string,
) => {
  const restored = restoredText.trim()
  if (restored.length === 0) return currentComposerText
  if (currentComposerText.trim().length === 0) return restored
  return `${currentComposerText.replace(/\s+$/, '')}\n\n${restored}`
}
