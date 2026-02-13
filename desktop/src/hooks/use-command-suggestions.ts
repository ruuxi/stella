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

  // Find the last command_suggestions event
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'command_suggestions') continue

    // If there's a user_message or assistant_message after this suggestion,
    // it's stale — a new turn happened
    const hasNewerMessage = events
      .slice(i + 1)
      .some(
        (e) =>
          e.type === 'user_message' || e.type === 'assistant_message',
      )
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
