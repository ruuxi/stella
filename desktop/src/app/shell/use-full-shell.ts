/**
 * Column-reverse scroll management for the chat viewport.
 *
 * The scroll container uses `flex-direction: column-reverse`, so:
 *   - scrollTop = 0 → at bottom (newest content)
 *   - Math.abs(scrollTop) → distance from bottom
 *   - Content growth at bottom is auto-anchored by the browser
 *
 * A ResizeObserver on the content element drives auto-scroll.
 * Programmatic scrolls are distinguished from user scrolls via a grace period.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { animate } from 'motion'

/** Sub-pixel threshold for "at bottom" detection */
const AT_BOTTOM_THRESHOLD = 2

/** Ignore scroll events within this window after a programmatic scroll (ms) */
const PROGRAMMATIC_GRACE_MS = 120

/** Keep auto-scrolling for this duration after streaming stops (ms) */
const SETTLE_MS = 500

/** Trigger load-older when this close to the top (px) */
const LOAD_OLDER_THRESHOLD = 200

/** Minimum custom scrollbar thumb height (px) */
const THUMB_MIN_HEIGHT = 24

/** Auto-hide custom scrollbar thumb after this delay (ms) */
const THUMB_FADE_MS = 1200

type ScrollManagementOptions = {
  /** Total event/item count — used to detect when older events arrive */
  itemCount?: number
  /** Whether there are older events available to load */
  hasOlderEvents?: boolean
  /** Whether older events are currently being loaded */
  isLoadingOlder?: boolean
  /** Called when the user scrolls near the top */
  onLoadOlder?: () => void
  /** Whether the AI is currently streaming/working */
  isWorking?: boolean
}

export type ThumbState = {
  top: number
  height: number
  visible: boolean
}

export function useScrollManagement({
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
  isWorking = false,
}: ScrollManagementOptions = {}) {
  // --- DOM refs ---
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [hasViewport, setHasViewport] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [hasContent, setHasContent] = useState(false)

  // --- Scroll state ---
  const [userScrolled, setUserScrolledState] = useState(false)
  const userScrolledRef = useRef(false)

  // --- Animation ---
  const springRef = useRef<ReturnType<typeof animate> | null>(null)

  // --- Grace period ---
  const lastProgrammaticRef = useRef(0)

  // --- Settle timer ---
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- RAF throttle ---
  const rafRef = useRef<number | null>(null)

  // --- Custom scrollbar ---
  const [thumbState, setThumbState] = useState<ThumbState>({
    top: 0,
    height: 0,
    visible: false,
  })
  const thumbFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- Derived state ---
  const isNearBottom = !userScrolled
  const isNearBottomRef = useRef(true)
  const showScrollButton = userScrolled

  // --- Setters ---

  const setUserScrolled = useCallback((scrolled: boolean) => {
    userScrolledRef.current = scrolled
    isNearBottomRef.current = !scrolled
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

  // --- Callback refs for DOM elements ---

  const setScrollContainerElement = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setHasViewport(Boolean(node))
  }, [])

  const setContentElement = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
    setHasContent(Boolean(node))
  }, [])

  // --- Custom scrollbar thumb computation ---

  const updateThumb = useCallback(() => {
    const el = viewportRef.current
    if (!el) return

    const { scrollHeight, clientHeight, scrollTop } = el
    if (scrollHeight <= clientHeight) {
      setThumbState((t) => (t.visible ? { top: 0, height: 0, visible: false } : t))
      return
    }

    const ratio = clientHeight / scrollHeight
    const thumbH = Math.max(THUMB_MIN_HEIGHT, ratio * clientHeight)
    const maxScroll = scrollHeight - clientHeight
    // column-reverse: scrollTop=0 at bottom. Progress 0=bottom, 1=top.
    const progress = Math.abs(scrollTop) / maxScroll
    const maxThumbTop = clientHeight - thumbH
    const thumbTop = Math.max(0, Math.min(maxThumbTop, progress * maxThumbTop))

    setThumbState({ top: thumbTop, height: thumbH, visible: true })

    if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
    thumbFadeRef.current = setTimeout(() => {
      setThumbState((t) => ({ ...t, visible: false }))
    }, THUMB_FADE_MS)
  }, [])

  // --- Scroll to bottom ---

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = viewportRef.current
      if (!el) return

      stopSpring()
      markProgrammatic()
      setUserScrolled(false)

      if (behavior === 'instant') {
        el.scrollTop = 0
        return
      }

      // Already at bottom
      if (Math.abs(el.scrollTop) < 1) return

      springRef.current = animate(el.scrollTop, 0, {
        type: 'spring',
        duration: 0.35,
        bounce: 0,
        onUpdate: (v) => {
          el.scrollTop = v
        },
        onComplete: () => {
          springRef.current = null
          markProgrammatic()
        },
      })
    },
    [stopSpring, markProgrammatic, setUserScrolled],
  )

  // --- Reset ---

  const resetScrollState = useCallback(() => {
    stopSpring()
    setUserScrolled(false)
    if (settleRef.current) {
      clearTimeout(settleRef.current)
      settleRef.current = null
    }
  }, [stopSpring, setUserScrolled])

  // --- Scroll event handler ---

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null

      // Skip programmatic scroll detection
      if (isWithinGrace()) {
        updateThumb()
        return
      }

      const el = viewportRef.current
      if (!el) return

      const atBottom = Math.abs(el.scrollTop) < AT_BOTTOM_THRESHOLD

      if (atBottom && userScrolledRef.current) {
        // User scrolled back to bottom — re-engage auto-follow
        setUserScrolled(false)
      } else if (!atBottom && !userScrolledRef.current) {
        // User scrolled away from bottom
        setUserScrolled(true)
        stopSpring()
      }

      // Load older messages when near the top
      if (hasOlderEvents && !isLoadingOlder && onLoadOlder) {
        const maxScroll = el.scrollHeight - el.clientHeight
        const distFromTop = maxScroll - Math.abs(el.scrollTop)
        if (distFromTop < LOAD_OLDER_THRESHOLD) {
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

  // --- Content ResizeObserver: auto-scroll when content grows ---

  useEffect(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return

    let lastHeight = content.getBoundingClientRect().height

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const newH = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
      if (Math.abs(newH - lastHeight) < 1) return

      const grew = newH > lastHeight
      lastHeight = newH

      // Auto-scroll when content grows and we're following
      if (grew && !userScrolledRef.current) {
        viewport.scrollTop = 0
        markProgrammatic()
      }

      updateThumb()
    })

    ro.observe(content)
    return () => ro.disconnect()
  }, [hasViewport, hasContent, markProgrammatic, updateThumb])

  // --- Settle timer: keep following briefly after streaming stops ---

  useEffect(() => {
    if (isWorking) {
      if (settleRef.current) {
        clearTimeout(settleRef.current)
        settleRef.current = null
      }
    } else if (!userScrolledRef.current) {
      // Streaming stopped — maintain auto-scroll for a bit
      settleRef.current = setTimeout(() => {
        settleRef.current = null
      }, SETTLE_MS)
    }
  }, [isWorking])

  // --- Stop spring on user interaction ---

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

  // --- Keyboard navigation ---

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const handleKeyDown = (e: KeyboardEvent) => {
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

      switch (e.key) {
        case 'Home':
          e.preventDefault()
          stopSpring()
          // Scroll to top (oldest) — max negative scrollTop
          springRef.current = animate(
            el.scrollTop,
            -(el.scrollHeight - el.clientHeight),
            {
              type: 'spring',
              duration: 0.35,
              bounce: 0,
              onUpdate: (v) => {
                el.scrollTop = v
              },
              onComplete: () => {
                springRef.current = null
              },
            },
          )
          break
        case 'End':
          e.preventDefault()
          scrollToBottom('smooth')
          break
        case 'PageUp':
          e.preventDefault()
          el.scrollBy({ top: -page, behavior: 'smooth' })
          break
        case 'PageDown':
          e.preventDefault()
          el.scrollBy({ top: page, behavior: 'smooth' })
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [hasViewport, stopSpring, scrollToBottom])

  // --- Cleanup ---

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (settleRef.current) clearTimeout(settleRef.current)
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
      springRef.current?.stop()
    }
  }, [])

  return {
    /** Ref for the column-reverse scroll viewport */
    scrollContainerRef: viewportRef,
    /** Callback ref — assign to the scroll viewport element */
    setScrollContainerElement,
    /** Callback ref — assign to the content wrapper inside the viewport */
    setContentElement,
    hasScrollElement: hasViewport,
    isNearBottom,
    isNearBottomRef,
    showScrollButton,
    scrollToBottom,
    handleScroll,
    resetScrollState,
    /** 'none' when auto-following, 'auto' when user has scrolled */
    overflowAnchor: (userScrolled ? 'auto' : 'none') as 'auto' | 'none',
    /** Custom scrollbar thumb position/visibility */
    thumbState,
  }
}
