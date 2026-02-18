import { useEffect, useRef } from 'react'
import { useCanvas } from '@/app/state/canvas-state'
import type { EventRecord } from './use-conversation-events'

type CanvasCommandPayload = {
  action: 'open' | 'close'
  name?: string
  title?: string
  url?: string
}

const PANEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

const normalizeCanvasName = (value?: string): string | null => {
  if (!value) return null
  const normalized = value.trim().replace(/\.tsx$/i, '')
  if (!PANEL_NAME_PATTERN.test(normalized)) {
    return null
  }
  return normalized
}

const isSafeCanvasUrl = (value?: string): boolean => {
  if (!value) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Extract port from a localhost URL, or null if not localhost. */
const getLocalhostPort = (url?: string): number | null => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const port = parseInt(parsed.port, 10)
      return Number.isFinite(port) ? port : null
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Watches conversation events for `canvas_command` type and dispatches
 * to the canvas state (open/close).
 */
export const useCanvasCommands = (events: EventRecord[]) => {
  const { state, openCanvas, closeCanvas } = useCanvas()
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
          const normalizedName = normalizeCanvasName(payload.name)
          if (!normalizedName) break
          if (!isSafeCanvasUrl(payload.url)) break
          openCanvas({
            name: normalizedName,
            title: payload.title,
            url: payload.url,
          })
          break
        }
        case 'close': {
          // Kill dev server shell if canvas had a localhost URL
          const port = getLocalhostPort(state.canvas?.url)
          if (port) {
            window.electronAPI?.shellKillByPort(port)
          }
          closeCanvas()
          break
        }
      }
    }
  }, [events, state.canvas, openCanvas, closeCanvas])
}
