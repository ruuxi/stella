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
 *   - **auto-follow** during streaming, driven by a continuous rAF lerp
 *     loop that smoothly chases a moving target (the bottom of the
 *     growing streaming row). Legend's built-in `maintainScrollAtEnd`
 *     fights user wheel input on the same frame as content growth: by
 *     the time React re-renders with the disable flag, the user has
 *     already been yanked back to the bottom. Owning the follow
 *     ourselves means the user's wheel always wins — the loop yields
 *     immediately on any user input and only resumes when the user is
 *     near the bottom again.
 *   - **post-send scroll** routed through the same lerp loop so the
 *     user-message reveal blends with any concurrent stream-follow
 *     motion rather than fighting it.
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
const NEAR_BOTTOM_THRESHOLD = 96
const FOLLOW_REARM_THRESHOLD = 16
const THUMB_MIN_HEIGHT = 24
const THUMB_FADE_MS = 1200
/**
 * Suppress thumb-state setState calls when nothing visible has moved.
 * Sub-pixel jitter from Legend's continuous content-length measurements
 * during streaming would otherwise re-render every scroll frame.
 */
const THUMB_EPSILON_PX = 0.5

/**
 * Auto-follow lerp tuning.
 *
 * Each frame we move the viewport closer to the target by
 * `diff * factor(diff)`. A fixed factor trades off smoothness against
 * how far the viewport can fall behind a moving target: the
 * steady-state lag is `growth_per_frame / factor`, so a soft factor
 * like 0.22 looks buttery on slow streams but lets text drop below
 * the viewport whenever the model emits a burst of a few hundred
 * pixels at once (post-tool dumps, slow network catching up).
 *
 * Instead we ramp the factor with the current diff: low for typical
 * streaming, climbing toward 0.65 as the gap grows so big jumps
 * catch up in a couple frames instead of crawling for ~half a
 * second with text invisible the whole time. Above
 * `FOLLOW_HARD_SNAP_PX` we just land on target — at that point the
 * row is so far off that any lerp would visibly flicker text in and
 * out of view.
 */
const FOLLOW_LERP_FACTOR_BASE = 0.30
const FOLLOW_LERP_FACTOR_MAX = 0.65
const FOLLOW_LERP_FACTOR_SCALE = 0.005
const FOLLOW_HARD_SNAP_PX = 240
/**
 * Minimum per-frame step when the lerp would otherwise produce a
 * sub-pixel movement. Prevents the loop from stalling near the target
 * because of scrollTop rounding (most engines floor to integer at
 * the OS-compositor boundary even when CSS-side scrollTop accepts
 * fractions).
 */
const FOLLOW_MIN_STEP_PX = 0.5
/**
 * Breathing margin between the streaming row's bottom edge and the
 * viewport bottom while auto-following. Larger values keep the latest
 * text further from the absolute edge (reads as more comfortable but
 * shows less new text); smaller values pin tight to the bottom.
 *
 * The effective visible margin is `FOLLOW_BREATHING_PX − lerp_lag`.
 * 72px combined with the adaptive lerp keeps a positive margin (i.e.
 * text stays inside the viewport) for any per-frame growth up to
 * ~100px, which covers everything short of the rare hundreds-of-px
 * post-tool burst that `FOLLOW_HARD_SNAP_PX` already catches.
 */
const FOLLOW_BREATHING_PX = 72

/**
 * Gap left above the streaming assistant row's top edge when auto-follow
 * pins to the top. Without it the row sits flush at the viewport top
 * and the prior user/assistant message is cut off cleanly; a small
 * peek of the previous message above makes the conversation feel
 * continuous rather than chopped.
 */
const FOLLOW_TOP_PEEK_PX = 56

/** Matches `.event-list-trailing-region` min-heights in full-shell.chat.css */
const TRAILING_REGION_MIN_PX = {
  full: 160,
  compact: 120,
} as const

/** Breathing room between the user bubble's bottom edge and the footer. */
const POST_SEND_USER_MESSAGE_BREATHING_PX = 48

type ChatScrollSurface = keyof typeof TRAILING_REGION_MIN_PX

type ChatScrollManagementOptions = {
  hasOlderEvents?: boolean
  isLoadingOlder?: boolean
  onLoadOlder?: () => void
  /** Sidebar/mini use the compact trailing-region min-height. */
  surface?: ChatScrollSurface
}

type FollowTargetOptions = {
  /** Post-send positioning may scroll up to reveal a tall user bubble. */
  allowBackward?: boolean
}

type FollowApi = {
  /** Set an absolute target scrollTop. No-op if already past it. */
  setTarget: (target: number, options?: FollowTargetOptions) => void
  /** Bump the current target (or scrollTop if idle) by `delta` px. */
  nudgeBy: (delta: number) => void
  /** Scroll the latest user row into view with trailing reading space. */
  scrollLatestUserMessageIntoView: () => void
  /** Stop the lerp loop and drop the pending target. */
  cancel: () => void
}

export function useChatScrollManagement({
  hasOlderEvents = false,
  isLoadingOlder = false,
  onLoadOlder,
  surface = 'full',
}: ChatScrollManagementOptions = {}) {
  const trailingRegionMinPx = TRAILING_REGION_MIN_PX[surface]
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

  /**
   * Imperative bridge to the per-scroll-element follow loop. Populated
   * by the setup effect once Legend's scrollable node is attached, and
   * cleared on cleanup. Surfaces drive it indirectly through
   * `nudgeAfterSend` / `releaseFollow` / `scrollToBottom`.
   */
  const followApi = useRef<FollowApi | null>(null)

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
      // Legend's own scrollToEnd owns this motion; cancel any lerp
      // so we don't write scrollTop on the same frame Legend does.
      followApi.current?.cancel()
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

  /**
   * Reads the follow latch — true while content growth should pull
   * the viewport along with new content. This is the right signal
   * for "should I auto-nudge on the next send?" because the latch
   * survives the gap between when a short assistant reply finishes
   * (leaving the user `trailingRegionHeight − breathing` ≈ 150px
   * physically away from the absolute end, off-screen empty footer)
   * and when the next user message lands. `getIsNearBottom` measures
   * raw pixel distance and reports false in that window even though
   * the user is visually at the bottom of the conversation and
   * hasn't expressed any intent to leave it.
   */
  const getIsFollowing = useCallback(() => followRef.current, [])

  useEffect(() => {
    return () => {
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
    }
  }, [])

  /**
   * Explicitly release the auto-follow latch. Surfaces call this from
   * their send-message handler when the user fires a message from
   * scrollback (i.e. not near the bottom) — without it, `followRef`
   * stays armed across runs and the next assistant stream's content
   * growth auto-scrolls the user to the bottom even though they were
   * up in history. Paired with `scrollToBottom` (the existing arm-
   * the-latch op) so the send handler can express the user's intent
   * directly: nudge-to-bottom + arm follow, or stay-put + release
   * follow.
   */
  const releaseFollow = useCallback(() => {
    followRef.current = false
    followApi.current?.cancel()
  }, [])

  /**
   * Smooth one-shot scroll bump used by send handlers when the user
   * fires a message from near-the-bottom. Routes through the same
   * lerp loop as the streaming auto-follow so the two motions blend
   * (nudge → stream-follow as the assistant reply arrives) rather
   * than fighting via separate concurrent rAF tweens writing
   * scrollTop on alternating frames.
   *
   * The two-rAF wait lets the optimistic user-message row lay out
   * and grow `scrollHeight` before we bump, so the target lands at
   * a real position rather than getting clamped to the old maxScroll.
   */
  const nudgeBy = useCallback((delta: number) => {
    followRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.nudgeBy(delta)
      })
    })
  }, [])

  /**
   * After send, scroll so the latest user bubble is fully visible and
   * the footer trailing region (empty reading area for the assistant)
   * sits below it — not just a fixed ~48px bump that leaves tall bubbles
   * clipped at the top while empty space exists off-screen below.
   */
  const nudgeAfterSend = useCallback(() => {
    followRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.scrollLatestUserMessageIntoView()
      })
    })
  }, [])

  /**
   * Wheel/touch/keyboard listeners + auto-follow loop.
   *
   * - User wheel-up / touch-start / Up-arrow / PageUp / Home = explicit
   *   intent to leave the bottom; we drop the follow latch immediately
   *   and stop the lerp loop.
   * - User wheel-down / PageDown / End / Down-arrow = intent to lead
   *   the scroll themselves; we stop the loop so it doesn't fight the
   *   user's input on the next frame, but leave the latch armed so
   *   reaching the bottom re-engages auto-follow on the next chunk.
   * - A `ResizeObserver` on the scroll element fires whenever its
   *   `scrollHeight` grows (streamed text, new rows, etc.). When the
   *   follow latch is set and the streaming assistant row's bottom
   *   has dropped below the visible viewport, we update the lerp
   *   target. The loop tweens toward it smoothly across however many
   *   frames the catch-up takes, and absorbs follow-up target updates
   *   without restarting the easing — no per-chunk snap, no
   *   restart-on-every-frame jitter.
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
      // Becomes true on the first width-change tick of a resize burst so
      // we only nudge the user away from the absolute bottom once per
      // burst, not on every observer tick of the slide.
      let resizeBurstActive = false
      let resizeBurstResetId: ReturnType<typeof setTimeout> | null = null

      // ---- continuous lerp follow loop -----------------------------
      // `followTarget` is the absolute scrollTop the loop is currently
      // chasing; `null` means idle. Updating the target mid-flight
      // doesn't restart the easing — the loop just lerps toward the
      // new value on its next frame.
      let followTarget: number | null = null
      let followRaf = 0

      const stopLoop = () => {
        if (followRaf) cancelAnimationFrame(followRaf)
        followRaf = 0
        followTarget = null
      }

      const stepFollow = () => {
        followRaf = 0
        if (!attached || followTarget === null) return
        if (!followRef.current) {
          followTarget = null
          return
        }
        const maxScroll = Math.max(
          0,
          attached.scrollHeight - attached.clientHeight,
        )
        const target = Math.max(0, Math.min(maxScroll, followTarget))
        const current = attached.scrollTop
        const diff = target - current
        const absDiff = Math.abs(diff)
        if (absDiff < FOLLOW_MIN_STEP_PX) {
          attached.scrollTop = target
          followTarget = null
          return
        }
        // Massive gap (post-tool dump, slow network catching up,
        // resumed conversation jumping to the latest reply) — just
        // land on the target. Trying to lerp hundreds of px would
        // leave the streaming text invisible for many frames while
        // the loop crawls.
        if (absDiff > FOLLOW_HARD_SNAP_PX) {
          attached.scrollTop = target
          followTarget = null
          return
        }
        // Adaptive lerp: smooth on small diffs (typical word-by-word
        // streaming), snappier on larger diffs so a chunk that lands
        // 80–200px below the viewport catches up in a couple frames
        // instead of taking ~half a second and leaving text below
        // the viewport bottom the whole time.
        const factor = Math.min(
          FOLLOW_LERP_FACTOR_MAX,
          FOLLOW_LERP_FACTOR_BASE + absDiff * FOLLOW_LERP_FACTOR_SCALE,
        )
        const lerpStep = diff * factor
        const stepPx =
          Math.abs(lerpStep) >= FOLLOW_MIN_STEP_PX
            ? lerpStep
            : Math.sign(diff) * FOLLOW_MIN_STEP_PX
        attached.scrollTop = current + stepPx
        followRaf = requestAnimationFrame(stepFollow)
      }

      const setTarget = (
        newTarget: number,
        options: FollowTargetOptions = {},
      ) => {
        if (!attached) return
        if (!followRef.current) return
        const maxScroll = Math.max(
          0,
          attached.scrollHeight - attached.clientHeight,
        )
        const clamped = Math.max(0, Math.min(maxScroll, newTarget))
        // Don't lerp backwards during stream-follow (would scroll the
        // user up against their intent). Post-send positioning opts in.
        if (
          !options.allowBackward &&
          clamped <= attached.scrollTop + 0.5
        ) {
          return
        }
        followTarget = clamped
        if (!followRaf) followRaf = requestAnimationFrame(stepFollow)
      }

      const nudgeBy = (delta: number) => {
        if (!attached) return
        if (!followRef.current) return
        const base = followTarget !== null ? followTarget : attached.scrollTop
        setTarget(base + delta)
      }

      const scrollLatestUserMessageIntoView = () => {
        if (!attached) return
        if (!followRef.current) return
        const userRow =
          attached.querySelector<HTMLElement>('.event-row--user--just-sent') ??
          (() => {
            const rows = attached.querySelectorAll<HTMLElement>(
              '.event-row--user',
            )
            return rows.length > 0 ? rows[rows.length - 1]! : null
          })()
        if (!userRow) {
          nudgeBy(POST_SEND_USER_MESSAGE_BREATHING_PX)
          return
        }
        const containerRect = attached.getBoundingClientRect()
        const rowRect = userRow.getBoundingClientRect()
        const rowTop = rowRect.top - containerRect.top + attached.scrollTop
        const rowBottom =
          rowRect.bottom - containerRect.top + attached.scrollTop
        const readingSpaceBelow =
          trailingRegionMinPx + POST_SEND_USER_MESSAGE_BREATHING_PX
        const availableForRow = Math.max(
          0,
          attached.clientHeight - readingSpaceBelow,
        )
        const rowHeight = Math.max(0, rowBottom - rowTop)
        const target =
          rowHeight <= availableForRow
            ? rowBottom - attached.clientHeight + readingSpaceBelow
            : rowTop
        setTarget(target, { allowBackward: true })
      }

      followApi.current = {
        setTarget,
        nudgeBy,
        scrollLatestUserMessageIntoView,
        cancel: stopLoop,
      }

      // ---- user-input release handlers -----------------------------
      const releaseLocalFollow = () => {
        followRef.current = false
        stopLoop()
      }
      const handleWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) releaseLocalFollow()
        else stopLoop()
      }
      const handleTouchStart = () => {
        releaseLocalFollow()
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (
          event.key === 'ArrowUp' ||
          event.key === 'PageUp' ||
          event.key === 'Home'
        ) {
          releaseLocalFollow()
        } else {
          stopLoop()
        }
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
        // Width changes (display sidebar sliding open, drag handle,
        // window resize) reflow the chat narrower/wider, which grows or
        // shrinks `scrollHeight` on every observer tick of the ~460ms
        // transition. Trying to keep the user glued to the absolute
        // bottom through that reflow produces the visible bounce: the
        // browser repaints the new layout one frame before our pin
        // catches up, so the content visibly jumps.
        //
        // The simpler fix is to step the user off the absolute bottom
        // at the start of the resize burst — once they're a few pixels
        // up, no per-frame pin is needed and the reflow is invisible.
        // `followRef` stays armed, so streaming-text growth + reaching
        // the bottom themselves still re-engages auto-follow normally.
        if (widthChanged) {
          if (!resizeBurstActive && followRef.current) {
            resizeBurstActive = true
            const distFromEnd = Math.max(
              0,
              attached.scrollHeight -
                attached.clientHeight -
                attached.scrollTop,
            )
            if (distFromEnd < 12) {
              attached.scrollTop = Math.max(
                0,
                attached.scrollTop - (12 - distFromEnd),
              )
            }
          }
          if (resizeBurstResetId) clearTimeout(resizeBurstResetId)
          resizeBurstResetId = setTimeout(() => {
            resizeBurstActive = false
            resizeBurstResetId = null
          }, 160)
          return
        }
        if (!grew || !followRef.current) return
        // Auto-follow is ONLY for a live streaming assistant reply.
        // Everything else that grows `scrollHeight` — the just-sent
        // user bubble, a persisted preamble, tool cards, the footer,
        // the overlay→persisted swap at run-end — must not move the
        // viewport. The send handler's ~48px nudge handles those.
        // After an assistant boundary (preamble → post-tool answer,
        // hidden agent-completion → orchestrator follow-up, etc.) the
        // prior overlay slot stays in the timeline as a locked
        // `.event-row--streaming` row until its persisted counterpart
        // lands. The actively-growing slot is always the LAST match —
        // grabbing the first one (querySelector) would keep tracking
        // the now-static prior message and skip auto-follow on the
        // new reply.
        const streamingRows = attached.querySelectorAll<HTMLElement>(
          '.event-row--streaming',
        )
        const streamingRow =
          streamingRows.length > 0
            ? streamingRows[streamingRows.length - 1]!
            : null
        if (!streamingRow || streamingRow.offsetHeight <= 0) return
        const rowRect = streamingRow.getBoundingClientRect()
        const containerRect = attached.getBoundingClientRect()
        const rowTop = rowRect.top - containerRect.top + attached.scrollTop
        const rowBottom =
          rowRect.bottom - containerRect.top + attached.scrollTop
        // Two competing targets:
        //   - `desiredScrollTop` chases the streaming row's bottom
        //     edge with `FOLLOW_BREATHING_PX` of margin, so the
        //     latest text sits just above the viewport bottom rather
        //     than stranded mid-viewport with empty footer below
        //     (the old `naturalTarget`-only approach scrolled to the
        //     absolute content end, leaving the streaming row pushed
        //     up by the ~180px trailing-region footer).
        //   - `rowTop - FOLLOW_TOP_PEEK_PX` is the pin: once
        //     `desiredScrollTop` would push the row's top above the
        //     viewport top, we stop a few px short so the bottom of
        //     the previous message stays peeking in. Auto-follow
        //     stops there and the user reads top-down from then on.
        //
        // `Math.min` picks `desiredScrollTop` while the row is short
        // enough to keep the bottom in view AND the top (with peek)
        // inside the viewport, then naturally switches to the pinned
        // row-top as the row grows past
        // `clientHeight − FOLLOW_BREATHING_PX`.
        const desiredScrollTop = Math.max(
          0,
          rowBottom - attached.clientHeight + FOLLOW_BREATHING_PX,
        )
        const pinnedTop = Math.max(0, rowTop - FOLLOW_TOP_PEEK_PX)
        const target = Math.min(pinnedTop, desiredScrollTop)
        // `setTarget` already no-ops when target <= scrollTop, which
        // naturally absorbs the "row still fits in the visible
        // viewport" case without needing a separate guard.
        setTarget(target)
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
        stopLoop()
        if (resizeBurstResetId) {
          clearTimeout(resizeBurstResetId)
          resizeBurstResetId = null
        }
        resizeBurstActive = false
        followApi.current = null
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
  }, [trailingRegionMinPx])

  return {
    listRef,
    onListScroll,
    onStartReached,
    isAtBottom,
    isNearBottom,
    getIsNearBottom,
    showScrollButton,
    scrollToBottom,
    releaseFollow,
    nudgeAfterSend,
    nudgeBy,
    getIsFollowing,
    thumbState,
  }
}
