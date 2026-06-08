/**
 * Scroll management for chat surfaces backed by Legend List v3 (web entry).
 *
 * The list owns scrolling and viewport measurement; this hook layers
 * surface-level UI concerns on top:
 *   - scroll-to-bottom button visibility from distance off the end,
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
import {
  clearAssistantScrollFollow,
  getAssistantScrollFollowKey,
  subscribeAssistantScrollFollow,
} from '@/shell/chat-scroll-follow'

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
 * Gentle one-shot motion profile for the post-send nudge.
 *
 * Stream auto-follow wants to be snappy (and even hard-snaps past
 * `FOLLOW_HARD_SNAP_PX`) so streamed text never lags below the
 * viewport. The post-send reframe has no such pressure — it's a single
 * settle into the reading position — so it reads better as a slow,
 * smooth ease-out. A low constant factor gives an exponential ease-out
 * that decelerates into the target over ~20–30 frames, and we skip the
 * hard snap entirely so even a tall just-sent bubble eases instead of
 * teleporting. If a stream chunk arrives mid-nudge, its (non-gentle)
 * `setTarget` clears the gentle flag and the snappy follow takes over —
 * the two motions blend on the same loop instead of fighting.
 */
const FOLLOW_GENTLE_LERP_FACTOR = 0.12
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

/** Matches `.event-list-trailing-region` min-heights in full-shell.chat.css */
const TRAILING_REGION_MIN_PX = {
  full: 160,
  compact: 120,
} as const

/** Breathing room between the user bubble's bottom edge and the footer. */
const POST_SEND_USER_MESSAGE_BREATHING_PX = 48

/** Extra slack beyond the trailing-region min-height for follow re-arm (less than post-send breathing). */
const FOLLOW_REARM_EXTRA_PX = 24

/** Re-arm stream auto-follow after scroll-up within the footer stack below the last message. */
const followRearmThresholdPx = (trailingRegionMinPx: number): number =>
  trailingRegionMinPx + FOLLOW_REARM_EXTRA_PX

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
  /**
   * Use the slow ease-out motion profile (post-send nudge) instead of
   * the snappy stream-follow lerp. Cleared automatically when a later
   * non-gentle `setTarget` (e.g. a streaming chunk) retargets the loop.
   */
  gentle?: boolean
}

type FollowApi = {
  /** Set an absolute target scrollTop. No-op if already past it. */
  setTarget: (target: number, options?: FollowTargetOptions) => void
  /** Bump the current target (or scrollTop if idle) by `delta` px. */
  nudgeBy: (delta: number) => void
  /** Scroll the latest user row into view with trailing reading space. */
  scrollLatestUserMessageIntoView: () => void
  /** Scroll the active queued follow-up stack into view during streaming. */
  scrollQueuedMessagesIntoView: () => void
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
  const followRearmThreshold = followRearmThresholdPx(trailingRegionMinPx)
  const listRef = useRef<LegendListRef | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isFollowingLatest, setIsFollowingLatest] = useState(true)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [thumbState, setThumbState] = useState<ThumbState>({
    top: 0,
    height: 0,
    visible: false,
  })
  const thumbFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollStateRafRef = useRef<number | null>(null)
  const isAtBottomRef = useRef(true)
  const showScrollButtonRef = useRef(false)

  /**
   * The follow latch. `true` means content growth should pull the
   * viewport down to the new bottom. Toggled off the instant the user
   * indicates upward intent, and back on once they're at/near the
   * bottom again (either by scrolling there themselves or hitting the
   * scroll-to-bottom button).
   */
  const followRef = useRef(true)
  const isFollowingLatestRef = useRef(true)

  const setFollow = useCallback((following: boolean) => {
    if (
      followRef.current === following &&
      isFollowingLatestRef.current === following
    ) {
      return
    }
    followRef.current = following
    isFollowingLatestRef.current = following
    setIsFollowingLatest(following)
  }, [])

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
      if (scrollStateRafRef.current !== null) return
      scrollStateRafRef.current = requestAnimationFrame(() => {
        scrollStateRafRef.current = null
        const list = listRef.current
        if (!list) return
        const state = list.getState()
        const { scroll, scrollLength, contentLength, isAtEnd } = state
        const distFromEnd = Math.max(0, contentLength - scrollLength - scroll)
        const shouldShowScrollButton =
          distFromEnd > SCROLL_BUTTON_THRESHOLD

        if (isAtBottomRef.current !== isAtEnd) {
          isAtBottomRef.current = isAtEnd
          setIsAtBottom(isAtEnd)
        }
        if (showScrollButtonRef.current !== shouldShowScrollButton) {
          showScrollButtonRef.current = shouldShowScrollButton
          setShowScrollButton(shouldShowScrollButton)
        }
        updateThumb(scroll, scrollLength, contentLength)

        // Re-arm follow when back in the normal reading position above the
        // off-screen trailing footer (not only at the literal scroll end).
        if (isAtEnd || distFromEnd <= followRearmThreshold) {
          setFollow(true)
        }
      })
    },
    [followRearmThreshold, setFollow, updateThumb],
  )

  /** `onStartReached` from Legend List — fires when the user nears the top. */
  const onStartReached = useCallback(() => {
    if (!hasOlderEvents || isLoadingOlder || !onLoadOlder) return
    onLoadOlder()
  }, [hasOlderEvents, isLoadingOlder, onLoadOlder])

  const scrollToBottom = useCallback(
    (behavior: 'instant' | 'smooth' = 'smooth') => {
      setFollow(true)
      // Legend's own scrollToEnd owns this motion; cancel any lerp
      // so we don't write scrollTop on the same frame Legend does.
      followApi.current?.cancel()
      void listRef.current?.scrollToEnd({ animated: behavior !== 'instant' })
    },
    [setFollow],
  )

  /**
   * Reads the follow latch — true while content growth should pull
   * the viewport along with new content. This is the right signal
   * for "should I auto-nudge on the next send?" because the latch
   * survives the gap between when a short assistant reply finishes
   * (leaving the user above the absolute end with the trailing footer
   * off-screen) and when the next user message lands.
   */
  const getIsFollowing = useCallback(() => followRef.current, [])

  useEffect(() => {
    return () => {
      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
      if (scrollStateRafRef.current !== null) {
        cancelAnimationFrame(scrollStateRafRef.current)
        scrollStateRafRef.current = null
      }
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
    setFollow(false)
    clearAssistantScrollFollow()
    followApi.current?.cancel()
  }, [setFollow])

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
    setFollow(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.nudgeBy(delta)
      })
    })
  }, [setFollow])

  /**
   * After send, scroll so the latest user bubble is fully visible and
   * the footer trailing region (empty reading area for the assistant)
   * sits below it — not just a fixed ~48px bump that leaves tall bubbles
   * clipped at the top while empty space exists off-screen below.
   */
  const nudgeAfterSend = useCallback(() => {
    setFollow(true)
    clearAssistantScrollFollow()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.scrollLatestUserMessageIntoView()
      })
    })
  }, [setFollow])

  /**
   * While a stream is active, additional sends render as queued chips in
   * the footer instead of as new event rows. Keep those chips in frame
   * without reusing the latest-user-row nudge, which would target the
   * previous turn and can scroll backward.
   */
  const nudgeQueuedMessagesIntoView = useCallback(() => {
    setFollow(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        followApi.current?.scrollQueuedMessagesIntoView()
      })
    })
  }, [setFollow])

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
   * - Streaming row layout changes publish explicit assistant-follow
   *   notifications. When the follow latch is set and the streaming
   *   assistant row's bottom has dropped below the visible viewport,
   *   we update the lerp target. The loop tweens toward it smoothly
   *   across however many frames the catch-up takes, and absorbs
   *   follow-up target updates without restarting the easing — no
   *   per-chunk snap, no restart-on-every-frame jitter.
   */
  useEffect(() => {
    let attached: HTMLElement | null = null
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

      // ---- continuous lerp follow loop -----------------------------
      // `followTarget` is the absolute scrollTop the loop is currently
      // chasing; `null` means idle. Updating the target mid-flight
      // doesn't restart the easing — the loop just lerps toward the
      // new value on its next frame.
      let followTarget: number | null = null
      let followRaf = 0
      let followGentle = false

      const stopLoop = () => {
        if (followRaf) cancelAnimationFrame(followRaf)
        followRaf = 0
        followTarget = null
        followGentle = false
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
        // the loop crawls. The gentle post-send nudge opts out: it has
        // no streaming pressure, so a tall reframe should ease rather
        // than teleport.
        if (!followGentle && absDiff > FOLLOW_HARD_SNAP_PX) {
          attached.scrollTop = target
          followTarget = null
          return
        }
        // Gentle: constant low factor → smooth ease-out into the target.
        // Otherwise adaptive lerp: smooth on small diffs (typical
        // word-by-word streaming), snappier on larger diffs so a chunk
        // that lands 80–200px below the viewport catches up in a couple
        // frames instead of taking ~half a second and leaving text below
        // the viewport bottom the whole time.
        const factor = followGentle
          ? FOLLOW_GENTLE_LERP_FACTOR
          : Math.min(
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
        followGentle = Boolean(options.gentle)
        if (!followRaf) followRaf = requestAnimationFrame(stepFollow)
      }

      const nudgeBy = (delta: number, options: FollowTargetOptions = {}) => {
        if (!attached) return
        if (!followRef.current) return
        const base = followTarget !== null ? followTarget : attached.scrollTop
        setTarget(base + delta, options)
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
          nudgeBy(POST_SEND_USER_MESSAGE_BREATHING_PX, { gentle: true })
          return
        }
        // Use offsetTop/offsetHeight (layout geometry) rather than
        // getBoundingClientRect (post-transform). The just-sent bubble
        // is mid-`user-message-enter` animation here (translateY 10→0,
        // scale 0.97→1, 360ms), so its rendered rect sits a few px
        // below its final layout position. Measuring the rect would
        // bake that transient offset into a static lerp target — the
        // bubble would end ~5–7px higher in the viewport than intended
        // and the residual transform would visibly settle after the
        // scroll lerp finished, reading as a tiny jagged "double
        // motion" right after send.
        let rowTop = 0
        let node: HTMLElement | null = userRow
        while (node && node !== attached) {
          rowTop += node.offsetTop
          node = node.offsetParent as HTMLElement | null
        }
        const rowBottom = rowTop + userRow.offsetHeight
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
        setTarget(target, { allowBackward: true, gentle: true })
      }

      const scrollQueuedMessagesIntoView = () => {
        if (!attached) return
        if (!followRef.current) return
        const queuedMessages = attached.querySelectorAll<HTMLElement>(
          '.composer-queued-message:not(.composer-queued-message--leaving)',
        )
        const queuedMessage =
          queuedMessages.length > 0
            ? queuedMessages[queuedMessages.length - 1]!
            : null
        if (!queuedMessage) return
        const messageRect = queuedMessage.getBoundingClientRect()
        const containerRect = attached.getBoundingClientRect()
        const messageBottom =
          messageRect.bottom - containerRect.top + attached.scrollTop
        const target =
          messageBottom -
          attached.clientHeight +
          POST_SEND_USER_MESSAGE_BREATHING_PX
        setTarget(target)
      }

      followApi.current = {
        setTarget,
        nudgeBy,
        scrollLatestUserMessageIntoView,
        scrollQueuedMessagesIntoView,
        cancel: stopLoop,
      }

      const followActiveAssistantRow = () => {
        if (!attached || !followRef.current) return
        const followKey = getAssistantScrollFollowKey()
        if (!followKey) return
        const streamingRow = attached.querySelector<HTMLElement>(
          `[data-scroll-follow-key="${CSS.escape(followKey)}"]`,
        )
        if (!streamingRow || streamingRow.offsetHeight <= 0) return
        const rowRect = streamingRow.getBoundingClientRect()
        const containerRect = attached.getBoundingClientRect()
        const rowBottom =
          rowRect.bottom - containerRect.top + attached.scrollTop
        const desiredScrollTop = Math.max(
          0,
          rowBottom - attached.clientHeight + FOLLOW_BREATHING_PX,
        )
        const queuedStack = attached.querySelector<HTMLElement>(
          '.composer-queued-stack',
        )
        const queuedStackBottom = queuedStack
          ? queuedStack.getBoundingClientRect().bottom -
            containerRect.top +
            attached.scrollTop
          : null
        const queuedScrollTop =
          queuedStackBottom === null
            ? 0
            : Math.max(
                0,
                queuedStackBottom -
                  attached.clientHeight +
                POST_SEND_USER_MESSAGE_BREATHING_PX,
              )
        const target = Math.max(desiredScrollTop, queuedScrollTop)
        setTarget(target)
      }
      let followAssistantRowRaf = 0
      const scheduleFollowActiveAssistantRow = () => {
        if (followAssistantRowRaf) return
        followAssistantRowRaf = requestAnimationFrame(() => {
          followAssistantRowRaf = 0
          followActiveAssistantRow()
        })
      }

      // ---- user-input release handlers -----------------------------
      const releaseLocalFollow = () => {
        setFollow(false)
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

      const unsubscribeFollow = subscribeAssistantScrollFollow(() => {
        if (!followRef.current) return
        scheduleFollowActiveAssistantRow()
      })

      // Keep the viewport glued to the end across container *width*
      // changes while the user is pinned to the bottom. The display
      // panel slides open/closed over 460ms, resizing the scroll
      // container's width frame-by-frame. While the list is still
      // settling its initial scroll-to-end (right after reload), that
      // width churn makes Legend re-evaluate its end position and the
      // content bounces vertically. Re-pinning to the end on each
      // width change absorbs the bounce. Gated on `followRef` so a user
      // scrolled up in history is left untouched (Legend's
      // `maintainVisibleContentPosition` keeps their anchor), and gated
      // on width-only so composer/height changes don't trigger it.
      let lastContainerWidth = attached.clientWidth
      const handleContainerResize = () => {
        if (!attached) return
        const width = attached.clientWidth
        if (width === lastContainerWidth) return
        lastContainerWidth = width
        if (!followRef.current) return
        void listRef.current?.scrollToEnd({ animated: false })
      }
      const containerResizeObserver =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(handleContainerResize)
      containerResizeObserver?.observe(attached)

      cleanup = () => {
        if (!attached) return
        unsubscribeFollow()
        containerResizeObserver?.disconnect()
        attached.removeEventListener('wheel', handleWheel)
        attached.removeEventListener('touchstart', handleTouchStart)
        attached.removeEventListener('keydown', handleKeyDown)
        if (followAssistantRowRaf) {
          cancelAnimationFrame(followAssistantRowRaf)
          followAssistantRowRaf = 0
        }
        stopLoop()
        followApi.current = null
        attached = null
      }
      return true
    }

    // Persistent attach watcher. `tryAttach` cleans up and re-binds
    // whenever the live scroll node differs from the one we're attached
    // to, so this loop handles two cases with the same code path:
    //   1. Initial mount — the scroll node may not exist for a few frames
    //      after the list mounts; poll every frame until it appears.
    //   2. Remount — navigating to home content unmounts the LegendList
    //      and returning remounts it with a *new* scroll DOM node. Without
    //      re-attaching, `followApi`/the wheel listeners stay bound to the
    //      old detached node and every `scrollTop` write (send-nudge and
    //      stream auto-follow) silently no-ops. Once attached we only need
    //      to notice the swap, so throttle the check to keep this cheap.
    const ATTACH_CHECK_INTERVAL_MS = 120
    let lastAttachCheck = 0
    const watch = (now: number) => {
      if (!attached || now - lastAttachCheck >= ATTACH_CHECK_INTERVAL_MS) {
        lastAttachCheck = now
        tryAttach()
      }
      frame = requestAnimationFrame(watch)
    }
    frame = requestAnimationFrame(watch)

    return () => {
      cancelAnimationFrame(frame)
      cleanup()
    }
  }, [setFollow, trailingRegionMinPx])

  return {
    listRef,
    onListScroll,
    onStartReached,
    isAtBottom,
    isFollowingLatest,
    showScrollButton,
    scrollToBottom,
    releaseFollow,
    nudgeAfterSend,
    nudgeQueuedMessagesIntoView,
    nudgeBy,
    getIsFollowing,
    thumbState,
  }
}
