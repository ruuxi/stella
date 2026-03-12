import { useEffect, useRef } from 'react'
import { useWorkspace } from '@/context/workspace-state'
import { useUiState } from '@/context/ui-state'
import { getLocalhostPort } from '@/shared/lib/utils'
import type { EventRecord } from '@/app/chat/lib/event-transforms'

type CanvasCommandPayload = {
  action: 'open' | 'close'
  name?: string
  title?: string
  url?: string
}

const PANEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

const findEventWindowStart = (
  previousIds: string[],
  nextEvents: EventRecord[],
): number => {
  if (previousIds.length === 0 || previousIds.length > nextEvents.length) {
    return -1
  }

  outer: for (let start = 0; start <= nextEvents.length - previousIds.length; start += 1) {
    for (let offset = 0; offset < previousIds.length; offset += 1) {
      if (nextEvents[start + offset]?._id !== previousIds[offset]) {
        continue outer
      }
    }
    return start
  }

  return -1
}

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

/**
 * Watches conversation events for `canvas_command` type and dispatches
 * to the canvas state (open/close).
 */
export const useCanvasCommands = (
  events: EventRecord[],
  conversationId?: string | null,
) => {
  const { state, openPanel, closePanel } = useWorkspace()
  const { setView } = useUiState()
  const processedRef = useRef<Set<string>>(new Set())
  const previousEventIdsRef = useRef<string[]>([])

  useEffect(() => {
    processedRef.current.clear()
    previousEventIdsRef.current = []
  }, [conversationId])

  useEffect(() => {
    if (events.length === 0) {
      processedRef.current.clear()
      previousEventIdsRef.current = []
      return
    }

    const previousEventIds = previousEventIdsRef.current
    let nextEventsToProcess = events

    if (previousEventIds.length > 0) {
      const previousWindowStart = findEventWindowStart(previousEventIds, events)
      if (previousWindowStart === -1) {
        processedRef.current.clear()
      } else {
        nextEventsToProcess = events.slice(previousWindowStart + previousEventIds.length)
      }
    }

    for (const event of nextEventsToProcess) {
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
          openPanel({
            name: normalizedName,
            title: payload.title,
            url: payload.url,
          })
          setView('app')
          break
        }
        case 'close': {
          // Kill dev server shell if canvas had a localhost URL
          const port = getLocalhostPort(state.activePanel?.url)
          if (port) {
            window.electronAPI?.system.shellKillByPort(port)
          }
          closePanel()
          setView('home')
          break
        }
      }
    }

    previousEventIdsRef.current = events.map((event) => event._id)
  }, [events, state.activePanel, openPanel, closePanel, setView])
}


