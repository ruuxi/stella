/**
 * Scroll management for chat surfaces backed by Legend List v3 (web entry).
 *
 * The list itself owns scrolling and viewport measurement; this hook
 * just translates its state into the surface-level UI concerns:
 *   - "is the user at the bottom" → drives `at-bottom` styling and
 *     scroll-to-bottom button visibility,
 *   - custom scrollbar thumb position/height,
 *   - `scrollToBottom` via the list ref,
 *   - `onStartReached` → load older history.
 *
 * The list scroll element, ResizeObserver, and resize-anchor logic that
 * the previous column-reverse implementation owned are subsumed by the
 * list (`maintainScrollAtEnd`, `maintainVisibleContentPosition`,
 * `initialScrollAtEnd`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LegendListRef,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from '@legendapp/list/react'

type ThumbState = {
  top: number
  height: number
  visible: boolean
}

const SCROLL_BUTTON_THRESHOLD = 180
const THUMB_MIN_HEIGHT = 24
const THUMB_FADE_MS = 1200
/**
 * Suppress thumb-state setState calls when nothing visible has moved.
 * Sub-pixel jitter from Legend's continuous content-length measurements
 * during streaming would otherwise re-render every scroll frame.
 */
const THUMB_EPSILON_PX = 0.5

type ChatScrollManagementOptions = {
  hasOlderEvents?: boolean
  isLoadingOlder?: boolean
  onLoadOlder?: () => void
}

export function useChatScrollManagement({
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
}: ChatScrollManagementOptions = {}) {
  const listRef = useRef<LegendListRef | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [thumbState, setThumbState] = useState<ThumbState>({
    top: 0,
    height: 0,
    visible: false,
  })
  const thumbFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateThumb = useCallback(
    (scroll: number, scrollLength: number, contentLength: number) => {
      if (contentLength <= scrollLength || scrollLength <= 0) {
        setThumbState((thumb) =>
          thumb.visible ? { top: 0, height: 0, visible: false } : thumb,
        )
        return
      }

      const ratio = scrollLength / contentLength
      const thumbHeight = Math.max(THUMB_MIN_HEIGHT, ratio * scrollLength)
      const maxScroll = Math.max(1, contentLength - scrollLength)
      const progress = Math.max(0, Math.min(1, scroll / maxScroll))
      const maxThumbTop = Math.max(0, scrollLength - thumbHeight)
      const thumbTop = progress * maxThumbTop

      setThumbState((prev) => {
        if (
          prev.visible &&
          Math.abs(prev.top - thumbTop) < THUMB_EPSILON_PX &&
          Math.abs(prev.height - thumbHeight) < THUMB_EPSILON_PX
        ) {
          return prev
        }
        return { top: thumbTop, height: thumbHeight, visible: true }
      })

      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
      thumbFadeRef.current = setTimeout(() => {
        setThumbState((thumb) =>
          thumb.visible ? { ...thumb, visible: false } : thumb,
        )
      }, THUMB_FADE_MS)
    },
    [],
  )

  const onListScroll = useCallback(
    (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const list = listRef.current
      if (!list) return
      const state = list.getState()
      const { scroll, scrollLength, contentLength, isAtEnd } = state
      // Booleans bail out on === inside React's setState, so these are
      // effectively no-ops while nothing has changed.
      setIsAtBottom(isAtEnd)
      const distFromEnd = Math.max(0, contentLength - scrollLength - scroll)
      setShowScrollButton(distFromEnd > SCROLL_BUTTON_THRESHOLD)
      updateThumb(scroll, scrollLength, contentLength)
    },
    [updateThumb],
  )

  /** `onStartReached` from Legend List — fires when the user nears the top. */
  const onStartReached = useCallback(() => {
    if (!hasOlderEvents || isLoadingOlder || !onLoadOlder) return
    onLoadOlder()
  }, [hasOlderEvents, isLoadingOlder, onLoadOlder])

  const scrollToBottom = useCallback(
    (behavior: 'instant' | 'smooth' = 'smooth') => {
      void listRef.current?.scrollToEnd({ animated: behavior !== 'instant' })
    },
    [],
  )

  useEffect(() => {
    return () => {
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
    }
  }, [])

  return {
    listRef,
    onListScroll,
    onStartReached,
    isAtBottom,
    isNearBottom: isAtBottom,
    showScrollButton,
    scrollToBottom,
    thumbState,
  }
}
