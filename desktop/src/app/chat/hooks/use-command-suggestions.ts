import type { EventRecord } from './use-conversation-events'

export type CommandSuggestion = {
  commandId: string
  name: string
  description: string
}

/**
 * Derives the latest command suggestions from conversation events.
 * Returns empty when streaming or no suggestions are available.
 * Purely derived from props — no internal state or refs.
 */
export const useCommandSuggestions = (
  events: EventRecord[],
  isStreaming: boolean,
): CommandSuggestion[] => {
  if (isStreaming) return []

  let hasNewerMessage = false

  // Scan once from newest to oldest to avoid repeated array slicing.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'user_message' || event.type === 'assistant_message') {
      hasNewerMessage = true
      continue
    }
    if (event.type !== 'command_suggestions') continue
    if (hasNewerMessage) return []

    const payload = event.payload as
      | { suggestions?: CommandSuggestion[] }
      | undefined
    if (!payload?.suggestions || !Array.isArray(payload.suggestions)) return []

    return payload.suggestions
      .filter(
        (s): s is CommandSuggestion =>
          typeof s.commandId === 'string' && typeof s.name === 'string',
      )
      .slice(0, 3)
  }

  return []
}
