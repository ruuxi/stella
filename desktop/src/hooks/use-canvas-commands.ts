import { useEffect, useRef } from 'react'
import { useCanvas, type CanvasTier } from '@/app/state/canvas-state'
import type { EventRecord } from './use-conversation-events'

type CanvasCommandPayload = {
  action: 'open' | 'close' | 'update' | 'resize'
  component?: string
  title?: string
  tier?: CanvasTier
  data?: unknown
  url?: string
  width?: number
}

/**
 * Watches conversation events for `canvas_command` type and dispatches
 * to the canvas state (open/close/update/resize).
 */
export const useCanvasCommands = (events: EventRecord[]) => {
  const { openCanvas, closeCanvas, updateCanvasData, setWidth } = useCanvas()
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
          if (!payload.component || !payload.tier) break
          openCanvas({
            component: payload.component,
            title: payload.title,
            tier: payload.tier,
            data: payload.data,
            url: payload.url,
          })
          break
        }
        case 'close': {
          closeCanvas()
          break
        }
        case 'update': {
          if (payload.data !== undefined) {
            updateCanvasData(payload.data)
          }
          break
        }
        case 'resize': {
          if (payload.width !== undefined) {
            setWidth(payload.width)
          }
          break
        }
      }
    }
  }, [events, openCanvas, closeCanvas, updateCanvasData, setWidth])
}
