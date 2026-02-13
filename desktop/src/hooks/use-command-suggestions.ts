import { useEffect, useRef, useState } from 'react'
import type { EventRecord } from './use-conversation-events'

export type CommandSuggestion = {
  commandId: string
  name: string
  description: string
}

/**
 * Watches conversation events for `command_suggestions` type and
 * exposes the latest suggestion set. Clears when streaming starts
 * or when the event stream resets (conversation switch).
 */
export const useCommandSuggestions = (
  events: EventRecord[],
  isStreaming: boolean,
) => {
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([])
  const processedRef = useRef<Set<string>>(new Set())
  const previousLengthRef = useRef(events.length)

  // Reset when event stream resets (conversation switch)
  useEffect(() => {
    if (events.length === 0 && previousLengthRef.current > 0) {
      processedRef.current.clear()
      setSuggestions([])
    }
    previousLengthRef.current = events.length
  }, [events.length])

  // Clear suggestions when a new turn starts
  useEffect(() => {
    if (isStreaming) {
      setSuggestions([])
    }
  }, [isStreaming])

  // Process new suggestion events
  useEffect(() => {
    for (const event of events) {
      if (event.type !== 'command_suggestions') continue
      if (processedRef.current.has(event._id)) continue

      processedRef.current.add(event._id)

      const payload = event.payload as
        | { suggestions?: CommandSuggestion[] }
        | undefined
      if (!payload?.suggestions || !Array.isArray(payload.suggestions)) continue

      setSuggestions(
        payload.suggestions
          .filter(
            (s): s is CommandSuggestion =>
              typeof s.commandId === 'string' && typeof s.name === 'string',
          )
          .slice(0, 3),
      )
    }
  }, [events])

  return suggestions
}
