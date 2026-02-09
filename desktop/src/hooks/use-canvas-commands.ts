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
  const previousLengthRef = useRef(events.length)

  // Reset processed IDs when the event stream is reset (e.g. conversation switch)
  useEffect(() => {
    if (events.length === 0 && previousLengthRef.current > 0) {
      processedRef.current.clear()
    }
    previousLengthRef.current = events.length
  }, [events.length])

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
