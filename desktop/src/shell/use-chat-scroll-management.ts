/**
 * Normal-column scroll management for the chat viewport.
 *
 * The scroll container uses `flex-direction: column`, so:
 *   - scrollTop = 0 -> at top (oldest content)
 *   - scrollTop = scrollHeight - clientHeight -> at bottom (newest content)
 *
 * No auto-scroll: when a message is sent, the user's message is scrolled
 * to the top of the viewport. The assistant response streams in below
 * without moving the viewport (ChatGPT/Claude-style).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { animate } from 'motion'

export type ThumbState = {
  top: number
  height: number
  visible: boolean
}

const AT_BOTTOM_THRESHOLD = 2
const PROGRAMMATIC_GRACE_MS = 120
const LOAD_OLDER_THRESHOLD = 200
const THUMB_MIN_HEIGHT = 24
const THUMB_FADE_MS = 1200
const SCROLL_TO_TURN_PADDING = 16

type ChatScrollManagementOptions = {
  itemCount?: number
  hasOlderEvents?: boolean
  isLoadingOlder?: boolean
  onLoadOlder?: () => void
  isWorking?: boolean
}

export function useChatScrollManagement({
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
}: ChatScrollManagementOptions = {}) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [hasViewport, setHasViewport] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [hasContent, setHasContent] = useState(false)

  const [userScrolled, setUserScrolledState] = useState(false)
  const userScrolledRef = useRef(false)

  const springRef = useRef<ReturnType<typeof animate> | null>(null)
  const lastProgrammaticRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  const [thumbState, setThumbState] = useState<ThumbState>({
    top: 0,
    height: 0,
    visible: false,
  })
  const thumbFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pendingScrollToLastTurnRef = useRef(false)

  const showScrollButton = userScrolled

  const setUserScrolled = useCallback((scrolled: boolean) => {
    userScrolledRef.current = scrolled
    setUserScrolledState(scrolled)
  }, [])

  const markProgrammatic = useCallback(() => {
    lastProgrammaticRef.current = performance.now()
  }, [])

  const isWithinGrace = useCallback(
    () => performance.now() - lastProgrammaticRef.current < PROGRAMMATIC_GRACE_MS,
    [],
  )

  const stopSpring = useCallback(() => {
    springRef.current?.stop()
    springRef.current = null
  }, [])

  const setScrollContainerElement = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setHasViewport(Boolean(node))
  }, [])

  const setContentElement = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
    setHasContent(Boolean(node))
  }, [])

  const updateThumb = useCallback(() => {
    const el = viewportRef.current
    if (!el) return

    const { scrollHeight, clientHeight, scrollTop } = el
    if (scrollHeight <= clientHeight) {
      setThumbState((thumb) => (thumb.visible ? { top: 0, height: 0, visible: false } : thumb))
      return
    }

    const ratio = clientHeight / scrollHeight
    const thumbHeight = Math.max(THUMB_MIN_HEIGHT, ratio * clientHeight)
    const maxScroll = scrollHeight - clientHeight
    const progress = scrollTop / maxScroll
    const maxThumbTop = clientHeight - thumbHeight
    const thumbTop = Math.max(0, Math.min(maxThumbTop, progress * maxThumbTop))

    setThumbState({ top: thumbTop, height: thumbHeight, visible: true })

    if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
    thumbFadeRef.current = setTimeout(() => {
      setThumbState((thumb) => ({ ...thumb, visible: false }))
    }, THUMB_FADE_MS)
  }, [])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = viewportRef.current
      if (!el) return

      stopSpring()
      markProgrammatic()
      setUserScrolled(false)

      const target = el.scrollHeight - el.clientHeight

      if (behavior === 'instant') {
        el.scrollTop = target
        return
      }

      if (Math.abs(el.scrollTop - target) < 1) return

      springRef.current = animate(el.scrollTop, target, {
        type: 'spring',
        duration: 0.35,
        bounce: 0,
        onUpdate: (value) => {
          el.scrollTop = value
        },
        onComplete: () => {
          springRef.current = null
          markProgrammatic()
        },
      })
    },
    [stopSpring, markProgrammatic, setUserScrolled],
  )

  const performScrollToLastTurn = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return

    const lastTurn = content.querySelector('.session-turn:last-child')
    if (!lastTurn) return

    markProgrammatic()
    setUserScrolled(false)

    const viewportRect = viewport.getBoundingClientRect()
    const turnRect = (lastTurn as HTMLElement).getBoundingClientRect()
    const scrollDelta = turnRect.top - viewportRect.top - SCROLL_TO_TURN_PADDING
    viewport.scrollTop = Math.max(0, viewport.scrollTop + scrollDelta)
  }, [markProgrammatic, setUserScrolled])

  /** Request scroll to pin the last turn at the top of the viewport on next content resize. */
  const scrollToLastTurn = useCallback(() => {
    pendingScrollToLastTurnRef.current = true
  }, [])

  const resetScrollState = useCallback(() => {
    stopSpring()
    setUserScrolled(false)
    pendingScrollToLastTurnRef.current = false
  }, [stopSpring, setUserScrolled])

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null

      if (isWithinGrace() || springRef.current) {
        updateThumb()
        return
      }

      const el = viewportRef.current
      if (!el) return

      const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < AT_BOTTOM_THRESHOLD

      if (atBottom && userScrolledRef.current) {
        setUserScrolled(false)
      } else if (!atBottom && !userScrolledRef.current) {
        setUserScrolled(true)
        stopSpring()
      }

      // Load older when near the top
      if (hasOlderEvents && !isLoadingOlder && onLoadOlder) {
        if (el.scrollTop < LOAD_OLDER_THRESHOLD) {
          onLoadOlder()
        }
      }

      updateThumb()
    })
  }, [
    isWithinGrace,
    updateThumb,
    setUserScrolled,
    stopSpring,
    hasOlderEvents,
    isLoadingOlder,
    onLoadOlder,
  ])

  // Content resize observer — executes pending scrollToLastTurn
  useEffect(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return

    const resizeObserver = new ResizeObserver(() => {
      if (pendingScrollToLastTurnRef.current) {
        pendingScrollToLastTurnRef.current = false
        performScrollToLastTurn()
      }

      updateThumb()
    })

    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [hasViewport, hasContent, performScrollToLastTurn, updateThumb])

  // Stop spring on user interaction
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const stop = () => stopSpring()

    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('touchstart', stop, { passive: true })
    return () => {
      el.removeEventListener('wheel', stop)
      el.removeEventListener('touchstart', stop)
    }
  }, [hasViewport, stopSpring])

  // Keyboard navigation
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          (active as HTMLElement).isContentEditable)
      ) {
        return
      }

      const page = el.clientHeight * 0.85

      switch (event.key) {
        case 'Home':
          event.preventDefault()
          stopSpring()
          springRef.current = animate(el.scrollTop, 0, {
            type: 'spring',
            duration: 0.35,
            bounce: 0,
            onUpdate: (value) => {
              el.scrollTop = value
            },
            onComplete: () => {
              springRef.current = null
            },
          })
          break
        case 'End':
          event.preventDefault()
          scrollToBottom('smooth')
          break
        case 'PageUp':
          event.preventDefault()
          el.scrollBy({ top: -page, behavior: 'smooth' })
          break
        case 'PageDown':
          event.preventDefault()
          el.scrollBy({ top: page, behavior: 'smooth' })
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [hasViewport, stopSpring, scrollToBottom])

  // Cleanup
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
      springRef.current?.stop()
    }
  }, [])

  return {
    scrollContainerRef: viewportRef,
    setScrollContainerElement,
    setContentElement,
    hasScrollElement: hasViewport,
    showScrollButton,
    scrollToBottom,
    scrollToLastTurn,
    handleScroll,
    resetScrollState,
    thumbState,
  }
}
