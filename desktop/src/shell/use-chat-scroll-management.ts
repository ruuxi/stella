/**
 * Column-reverse scroll management for the chat viewport.
 *
 * The scroll container uses `flex-direction: column-reverse`, so:
 *   - scrollTop = 0 -> at bottom (newest content)
 *   - Math.abs(scrollTop) -> distance from bottom
 *   - Content growth at bottom is auto-anchored by the browser
 *
 * A ResizeObserver on the content element drives auto-scroll.
 * Programmatic scrolls are distinguished from user scrolls via a grace period.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { animate } from 'motion'

export type ThumbState = {
  top: number
  height: number
  visible: boolean
}

const AT_BOTTOM_THRESHOLD = 2
const SCROLL_BUTTON_THRESHOLD = 180
const PROGRAMMATIC_GRACE_MS = 120
const SETTLE_MS = 500
const LOAD_OLDER_THRESHOLD = 200
const THUMB_MIN_HEIGHT = 24
const THUMB_FADE_MS = 1200

type ChatScrollManagementOptions = {
  hasOlderEvents?: boolean
  isLoadingOlder?: boolean
  onLoadOlder?: () => void
  isWorking?: boolean
  /** When true, content growth does not snap scroll to newest (turn-anchored reply). */
  pauseResizeFollow?: boolean
}

const PIN_TOP_PADDING_PX = 48

function escapeTurnIdForSelector(turnId: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(turnId)
  }
  return turnId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function useChatScrollManagement({
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
  isWorking = false,
  pauseResizeFollow = false,
}: ChatScrollManagementOptions = {}) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [hasViewport, setHasViewport] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [hasContent, setHasContent] = useState(false)

  const [userScrolled, setUserScrolledState] = useState(false)
  const userScrolledRef = useRef(false)
  const [scrollButtonVisible, setScrollButtonVisibleState] = useState(false)
  const scrollButtonVisibleRef = useRef(false)

  const springRef = useRef<ReturnType<typeof animate> | null>(null)
  const lastProgrammaticRef = useRef(0)
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number | null>(null)

  const [thumbState, setThumbState] = useState<ThumbState>({
    top: 0,
    height: 0,
    visible: false,
  })
  const thumbFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pauseResizeFollowRef = useRef(pauseResizeFollow)
  useEffect(() => {
    pauseResizeFollowRef.current = pauseResizeFollow
  }, [pauseResizeFollow])

  const [pinnedToTurn, setPinnedToTurnState] = useState(false)
  const pinnedToTurnRef = useRef(false)
  const setPinnedToTurn = useCallback((pinned: boolean) => {
    pinnedToTurnRef.current = pinned
    setPinnedToTurnState(pinned)
  }, [])

  const isNearBottom = !userScrolled
  const isNearBottomRef = useRef(true)
  const showScrollButton = scrollButtonVisible && !pinnedToTurn

  const setUserScrolled = useCallback((scrolled: boolean) => {
    userScrolledRef.current = scrolled
    isNearBottomRef.current = !scrolled
    setUserScrolledState(scrolled)
  }, [])

  const setScrollButtonVisible = useCallback((visible: boolean) => {
    scrollButtonVisibleRef.current = visible
    setScrollButtonVisibleState(visible)
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
    const progress = Math.abs(scrollTop) / maxScroll
    const maxThumbTop = clientHeight - thumbHeight
    // Invert: scrollTop=0 (bottom/newest) → thumb at bottom of track
    const thumbTop = Math.max(0, Math.min(maxThumbTop, (1 - progress) * maxThumbTop))

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
      setScrollButtonVisible(false)

      if (behavior === 'instant') {
        el.scrollTop = 0
        return
      }

      if (Math.abs(el.scrollTop) < 1) return

      springRef.current = animate(el.scrollTop, 0, {
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
    [stopSpring, markProgrammatic, setScrollButtonVisible, setUserScrolled],
  )

  /**
   * Places the latest user bubble near the top of the scrollport (reading area).
   * Scroll container is column-reverse (scrollTop = 0 = newest edge); we use the
   * user bubble as the anchor, not the whole turn, then correct with rects.
   */
  const scrollTurnToPinTop = useCallback(
    (turnId: string): boolean => {
      const viewport = viewportRef.current
      if (!viewport) return false

      const turn = viewport.querySelector(
        `[data-turn-id="${escapeTurnIdForSelector(turnId)}"]`,
      ) as HTMLElement | null
      if (!turn) return false

      const anchor =
        (turn.querySelector('.event-item.user') as HTMLElement | null) ?? turn

      const maxScroll = viewport.scrollHeight - viewport.clientHeight

      setUserScrolled(true)
      setPinnedToTurn(true)
      markProgrammatic()
      stopSpring()

      if (maxScroll < 1) {
        markProgrammatic()
        updateThumb()
        return true
      }

      // Avoid scrollIntoView({ block: 'start' }) — column-reverse can flip block
      // alignment. Align user bubble to the scrollport using rect error vs scrollTop
      // (scrollTop = 0 = newest edge; negative = scrolled toward older content).
      const alignUserBubble = (invert: boolean) => {
        for (let i = 0; i < 20; i += 1) {
          const vpRect = viewport.getBoundingClientRect()
          const elRect = anchor.getBoundingClientRect()
          const err = elRect.top - vpRect.top - PIN_TOP_PADDING_PX
          if (Math.abs(err) < 2) return true

          const before = viewport.scrollTop
          if (invert) viewport.scrollTop += err
          else viewport.scrollTop -= err
          if (Math.abs(viewport.scrollTop - before) < 0.5 && Math.abs(err) > 2) {
            viewport.scrollTop = invert ? before - err : before + err
          }
        }
        return false
      }

      if (!alignUserBubble(false)) {
        alignUserBubble(true)
      }

      markProgrammatic()
      updateThumb()
      return true
    },
    [markProgrammatic, setPinnedToTurn, setUserScrolled, stopSpring, updateThumb],
  )

  const resetScrollState = useCallback(() => {
    stopSpring()
    setUserScrolled(false)
    setScrollButtonVisible(false)
    setPinnedToTurn(false)
    if (settleRef.current) {
      clearTimeout(settleRef.current)
      settleRef.current = null
    }
  }, [stopSpring, setScrollButtonVisible, setUserScrolled, setPinnedToTurn])

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null

      if (isWithinGrace() || springRef.current) {
        updateThumb()
        return
      }

      if (pinnedToTurnRef.current) {
        setPinnedToTurn(false)
      }

      const el = viewportRef.current
      if (!el) return

      const atBottom = Math.abs(el.scrollTop) < AT_BOTTOM_THRESHOLD

      if (
        atBottom &&
        userScrolledRef.current &&
        !pauseResizeFollowRef.current
      ) {
        setUserScrolled(false)
        setScrollButtonVisible(false)
      } else if (!atBottom && !userScrolledRef.current) {
        setUserScrolled(true)
        stopSpring()
      }

      const shouldShowScrollButton =
        Math.abs(el.scrollTop) > SCROLL_BUTTON_THRESHOLD
      if (shouldShowScrollButton !== scrollButtonVisibleRef.current) {
        setScrollButtonVisible(shouldShowScrollButton)
      }

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
    setScrollButtonVisible,
    setUserScrolled,
    setPinnedToTurn,
    stopSpring,
    hasOlderEvents,
    isLoadingOlder,
    onLoadOlder,
  ])

  useEffect(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return

    let lastHeight = content.getBoundingClientRect().height

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const newHeight = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
      if (Math.abs(newHeight - lastHeight) < 1) return

      const grew = newHeight > lastHeight
      lastHeight = newHeight

      if (grew && !userScrolledRef.current && !pauseResizeFollowRef.current) {
        viewport.scrollTop = 0
        markProgrammatic()
      }

      updateThumb()
    })

    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [hasViewport, hasContent, markProgrammatic, updateThumb])

  useEffect(() => {
    if (isWorking) {
      if (settleRef.current) {
        clearTimeout(settleRef.current)
        settleRef.current = null
      }
    } else if (!userScrolledRef.current) {
      settleRef.current = setTimeout(() => {
        settleRef.current = null
      }, SETTLE_MS)
    }
  }, [isWorking])

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
          springRef.current = animate(el.scrollTop, -(el.scrollHeight - el.clientHeight), {
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

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (settleRef.current) clearTimeout(settleRef.current)
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
      springRef.current?.stop()
    }
  }, [])

  return {
    scrollContainerRef: viewportRef,
    setScrollContainerElement,
    setContentElement,
    hasScrollElement: hasViewport,
    isNearBottom,
    isNearBottomRef,
    showScrollButton,
    scrollToBottom,
    scrollTurnToPinTop,
    handleScroll,
    resetScrollState,
    overflowAnchor: (userScrolled ? 'auto' : 'none') as 'auto' | 'none',
    thumbState,
  }
}
