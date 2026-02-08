import { useEffect, useRef } from 'react'
import { useCanvas } from '@/app/state/canvas-state'
import type { EventRecord } from './use-conversation-events'

type CanvasCommandPayload = {
  action: 'open' | 'close'
  name?: string
  title?: string
  url?: string
}

/**
 * Watches conversation events for `canvas_command` type and dispatches
 * to the canvas state (open/close).
 */
export const useCanvasCommands = (events: EventRecord[]) => {
  const { openCanvas, closeCanvas } = useCanvas()
  const processedRef = useRef<Set<string>>(new Set())

  // Reset processed set when conversation changes (events array identity changes)
  const prevEventsRef = useRef<EventRecord[]>(events)
  if (events.length === 0 && prevEventsRef.current.length > 0) {
    processedRef.current.clear()
  }
  prevEventsRef.current = events

  useEffect(() => {
    for (const event of events) {
      if (event.type !== 'canvas_command') continue
      if (processedRef.current.has(event._id)) continue

      processedRef.current.add(event._id)

      const payload = event.payload as CanvasCommandPayload | undefined
      if (!payload?.action) continue

      switch (payload.action) {
        case 'open': {
          if (!payload.name) break
          openCanvas({
            name: payload.name,
            title: payload.title,
            url: payload.url,
          })
          break
        }
        case 'close': {
          closeCanvas()
          break
        }
      }
    }
  }, [events, openCanvas, closeCanvas])
}
