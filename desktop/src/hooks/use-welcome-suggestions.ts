import type { WelcomeSuggestion } from '../services/synthesis'
import type { EventRecord } from './use-conversation-events'

/**
 * Derives welcome suggestions from conversation events.
 * Returns empty once the user has sent any message (suggestions served their purpose).
 */
export const useWelcomeSuggestions = (
  events: EventRecord[],
): WelcomeSuggestion[] => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'welcome_suggestions') continue

    // If there's a user_message after the suggestions, hide them
    const hasUserMessage = events
      .slice(i + 1)
      .some((e) => e.type === 'user_message')
    if (hasUserMessage) return []

    const payload = event.payload as
      | { suggestions?: WelcomeSuggestion[] }
      | undefined
    if (!payload?.suggestions || !Array.isArray(payload.suggestions)) return []

    return payload.suggestions.slice(0, 5)
  }

  return []
}
