/**
 * Scroll management for chat surfaces backed by Legend List v3 (web entry).
 *
 * The list owns scrolling and viewport measurement; this hook layers
 * surface-level UI concerns on top:
 *   - "is the user at/near the bottom" → drives `at-bottom` styling and
 *     scroll-to-bottom button visibility,
 *   - custom scrollbar thumb position/height,
 *   - `scrollToBottom` via the list ref,
 *   - `onStartReached` → load older history,
 *   - **auto-follow** during streaming, driven manually rather than via
 *     Legend's `maintainScrollAtEnd`. Legend's built-in fights user wheel
 *     input on the same frame as content growth: by the time React
 *     re-renders with the disable flag, the user has already been yanked
 *     back to the bottom. Owning the follow ourselves means the user's
 *     wheel always wins — we just stop following when they've left the
 *     bottom and resume when they return.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LegendListRef,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from '@legendapp/list/react'
import { cancelSmoothScroll, smoothScrollTo } from '@/shared/lib/smooth-scroll'

type ThumbState = {
  top: number
  height: number
  visible: boolean
}

const SCROLL_BUTTON_THRESHOLD = 180
const NEAR_BOTTOM_THRESHOLD = 96
const FOLLOW_REARM_THRESHOLD = 16
const THUMB_MIN_HEIGHT = 24
const THUMB_FADE_MS = 1200
/**
 * Soft tween duration when content grows while we're auto-following.
 * Short enough to feel like the indicator/text is sliding into view,
 * long enough that successive growths blend instead of teleporting.
 */
const FOLLOW_TWEEN_MS = 220
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
  const [isNearBottom, setIsNearBottom] = useState(true)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [thumbState, setThumbState] = useState<ThumbState>({
    top: 0,
    height: 0,
    visible: false,
  })
  const thumbFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * The follow latch. `true` means content growth should pull the
   * viewport down to the new bottom. Toggled off the instant the user
   * indicates upward intent, and back on once they're at/near the
   * bottom again (either by scrolling there themselves or hitting the
   * scroll-to-bottom button).
   */
  const followRef = useRef(true)

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
      const distFromEnd = Math.max(0, contentLength - scrollLength - scroll)
      // Booleans bail out on === inside React's setState, so these are
      // effectively no-ops while nothing has changed.
      setIsAtBottom(isAtEnd)
      setIsNearBottom(isAtEnd || distFromEnd <= NEAR_BOTTOM_THRESHOLD)
      setShowScrollButton(distFromEnd > SCROLL_BUTTON_THRESHOLD)
      updateThumb(scroll, scrollLength, contentLength)

      // Re-arm follow as the user comes back to the bottom themselves.
      // The 16px threshold is tighter than `isNearBottom` so we don't
      // re-engage prematurely while they're still browsing scrollback.
      if (isAtEnd || distFromEnd <= FOLLOW_REARM_THRESHOLD) {
        followRef.current = true
      }
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
      followRef.current = true
      void listRef.current?.scrollToEnd({ animated: behavior !== 'instant' })
    },
    [],
  )

  const getIsNearBottom = useCallback(() => {
    const state = listRef.current?.getState()
    if (!state) return isNearBottom
    const { scroll, scrollLength, contentLength, isAtEnd } = state
    const distFromEnd = Math.max(0, contentLength - scrollLength - scroll)
    return isAtEnd || distFromEnd <= NEAR_BOTTOM_THRESHOLD
  }, [isNearBottom])

  useEffect(() => {
    return () => {
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
    }
  }, [])

  /**
   * Wheel/touch/keyboard listeners + auto-follow loop.
   *
   * - User wheel-up / touch-start / Up-arrow / PageUp / Home = explicit
   *   intent to leave the bottom; we drop the follow latch immediately
   *   and cancel any in-flight smooth tween.
   * - A `ResizeObserver` on the scroll element fires whenever its
   *   `scrollHeight` grows (streamed text, new rows, etc.). When the
   *   follow latch is set, we tween the viewport to the new bottom.
   *   When it's not, we leave the user where they are.
   */
  useEffect(() => {
    let attached: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null
    let cleanup = () => {}
    let frame = 0

    const tryAttach = (): boolean => {
      const node = listRef.current?.getScrollableNode() as
        | HTMLElement
        | undefined
        | null
      if (!node || node === attached) return Boolean(attached)
      cleanup()
      attached = node
      let lastScrollHeight = node.scrollHeight
      let lastClientWidth = node.clientWidth

      const cancelTween = () => {
        if (attached) cancelSmoothScroll(attached)
      }
      const releaseFollow = () => {
        followRef.current = false
        cancelTween()
      }
      const handleWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) releaseFollow()
        else cancelTween()
      }
      const handleTouchStart = () => {
        releaseFollow()
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (
          event.key === 'ArrowUp' ||
          event.key === 'PageUp' ||
          event.key === 'Home'
        ) {
          releaseFollow()
        } else {
          cancelTween()
        }
      }
      const pinToBottom = () => {
        if (!attached || !followRef.current) return
        cancelTween()
        attached.scrollTop = Math.max(0, attached.scrollHeight - attached.clientHeight)
      }

      node.addEventListener('wheel', handleWheel, { passive: true })
      node.addEventListener('touchstart', handleTouchStart, { passive: true })
      node.addEventListener('keydown', handleKeyDown)

      resizeObserver = new ResizeObserver(() => {
        if (!attached) return
        const newHeight = attached.scrollHeight
        const newWidth = attached.clientWidth
        const widthChanged = newWidth !== lastClientWidth
        if (newHeight === lastScrollHeight && !widthChanged) return
        const grew = newHeight > lastScrollHeight
        lastScrollHeight = newHeight
        lastClientWidth = newWidth
        // Width changes (e.g. the display sidebar sliding open) reflow the
        // chat narrower, which makes `scrollHeight` grow on every observer
        // tick of the 460ms transition. That is not new content — running
        // the smooth follow tween for it produces a "scroll for no reason"
        // during the slide. If the user was pinned to the bottom we snap
        // instantly to keep them there; otherwise we leave their scroll
        // position alone.
        if (widthChanged) {
          if (followRef.current) {
            pinToBottom()
            requestAnimationFrame(pinToBottom)
          }
          return
        }
        if (!grew || !followRef.current) return
        const naturalTarget = newHeight - attached.clientHeight
        // Cap the auto-follow at "streaming assistant row pinned to the
        // top of the viewport" so a long reply stops scrolling once the
        // user has a full viewport of fresh assistant text to read,
        // instead of chasing the bottom forever. `min` with the natural
        // bottom means short replies (cap > naturalTarget) and the
        // pre-mount window (no streaming row yet) fall through to the
        // existing bottom-follow behavior unchanged.
        const streamingRow = attached.querySelector<HTMLElement>(
          '.event-row--streaming',
        )
        let target = naturalTarget
        if (streamingRow) {
          const cap = Math.max(
            0,
            streamingRow.getBoundingClientRect().top -
              attached.getBoundingClientRect().top +
              attached.scrollTop,
          )
          target = Math.min(naturalTarget, cap)
        }
        if (target <= attached.scrollTop + 0.5) return
        smoothScrollTo(attached, target, FOLLOW_TWEEN_MS)
      })
      // Observe the scroll node itself plus its content child so we
      // pick up either form of growth (Legend's content wrapper resizes
      // independently of the scroll viewport's own box).
      resizeObserver.observe(node)
      const inner = node.firstElementChild as HTMLElement | null
      if (inner) resizeObserver.observe(inner)

      cleanup = () => {
        if (!attached) return
        attached.removeEventListener('wheel', handleWheel)
        attached.removeEventListener('touchstart', handleTouchStart)
        attached.removeEventListener('keydown', handleKeyDown)
        resizeObserver?.disconnect()
        resizeObserver = null
        attached = null
      }
      return true
    }

    if (!tryAttach()) {
      const poll = () => {
        if (tryAttach()) return
        frame = requestAnimationFrame(poll)
      }
      frame = requestAnimationFrame(poll)
    }

    return () => {
      cancelAnimationFrame(frame)
      cleanup()
    }
  }, [])

  return {
    listRef,
    onListScroll,
    onStartReached,
    isAtBottom,
    isNearBottom,
    getIsNearBottom,
    showScrollButton,
    scrollToBottom,
    thumbState,
  }
}
