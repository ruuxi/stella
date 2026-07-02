/**
 * Scroll management for chat surfaces backed by Legend List v3 (web entry).
 *
 * The list owns scrolling and viewport measurement; this hook layers
 * surface-level UI concerns on top:
 *   - scroll-to-bottom button visibility from distance off the end,
 *   - custom scrollbar thumb position/height, written **imperatively** to
 *     the thumb DOM node (via `thumbRef`) rather than through React state.
 *     Middle-click autoscroll (and the scrollbar drag) are driven on the
 *     main thread, not the compositor — re-rendering the whole chat tree
 *     once per scroll frame just to reposition the thumb starves that
 *     main-thread pan and makes it stutter. Writing `style.top`/`height`
 *     straight to the node keeps every steady-state scroll frame
 *     setState-free, so the pan stays smooth.
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
import { registerChatAtRestProbe } from '@/features/chat/hooks/use-conversation-messages'

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
 * Auto-follow motion model.
 *
 * Streaming content grows in discrete, irregular bursts (a line / a few
 * tokens at a time). A naive "ease toward the new bottom, then stop"
 * follow restarts an ease-in/ease-out per chunk and crawls the last few
 * pixels asymptotically, so back-to-back short bumps read as a start/stop
 * stutter.
 *
 * Instead we model the follow as a critically-damped spring whose
 * velocity *persists* across frames and across chunk boundaries: a new
 * chunk just moves the spring's target, and because the spring is still
 * carrying velocity from the previous chunk the motion blends into one
 * continuous glide. Acceleration scales with the gap (`stiffness · diff`),
 * so a big burst still catches up quickly while a slow trickle glides
 * gently — no asymptotic crawl, no per-chunk restart. Critical damping
 * (`damping ≈ 2·√stiffness`) means it settles without overshoot. The loop
 * stays warm for `FOLLOW_STREAM_IDLE_MS` after the last growth so a slow
 * stream doesn't re-settle per line, then eases to rest. Above
 * `FOLLOW_HARD_SNAP_PX` we land directly — that far off, any glide would
 * leave the streamed text below the viewport for too many frames.
 */
const FOLLOW_SPRING_STIFFNESS = 0.00026 // px/ms² per px of gap (~250ms settle)
const FOLLOW_SPRING_DAMPING = 0.0322 // ≈ 2·√stiffness → critically damped
/** Keep gliding this long after the last content growth before settling to rest. */
const FOLLOW_STREAM_IDLE_MS = 200
/** Clamp per-frame dt so a tab-switch / GC pause can't fling the viewport. */
const FOLLOW_MAX_FRAME_MS = 48
/** Assumed dt for the first frame of a glide (before two timestamps exist). */
const FOLLOW_DEFAULT_FRAME_MS = 16
const FOLLOW_HARD_SNAP_PX = 240
/**
 * Gentle one-shot motion profile for the post-send nudge.
 *
 * The post-send reframe is a single settle into the reading position with
 * no streaming pressure, so it reads better as a slow ease-out rather than
 * the spring's stream-tuned glide. A low constant factor gives an
 * exponential ease-out that decelerates into the target over ~20–30
 * frames, and it skips the hard snap entirely so even a tall just-sent
 * bubble eases instead of teleporting. If a stream chunk arrives mid-nudge
 * its (non-gentle) `setTarget` clears the gentle flag and the spring takes
 * over — the two motions blend on the same loop instead of fighting.
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

/**
 * Gap left above the streaming assistant row's top edge when auto-follow
 * pins to the top. Once a reply grows taller than the viewport, follow
 * stops here instead of chasing the bottom forever — the user gets a
 * stable reading area with a small peek of the prior message above so
 * the conversation reads as continuous rather than chopped.
 */
const FOLLOW_TOP_PEEK_PX = 56

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

/**
 * Resolved reduce-motion state. Prefer the `data-reduce-motion` attribute
 * written by `interface-preferences` (covers the in-app override as well as
 * the OS setting); fall back to the media query if the attribute hasn't
 * been applied yet. Gentle one-shot reframes land instantly under reduced
 * motion; the continuous stream-follow is position tracking, not a
 * decorative transition, so it is unaffected.
 */
const prefersReducedMotion = (): boolean => {
  if (typeof document === 'undefined') return false
  const attr = document.documentElement.getAttribute('data-reduce-motion')
  if (attr) return attr === 'reduce'
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/**
 * Turn identity (`userMessageId`) embedded in an assistant scroll-follow
 * key (`assistant-<userMessageId>-<indexInTurn>`). Used to tell "a new
 * turn started streaming" (gentle reframe) apart from "the same turn
 * grew or advanced to its next slot" (spring follow / hard snap).
 */
const followKeyTurnId = (followKey: string): string =>
  followKey.replace(/^assistant-/, '').replace(/-\d+$/, '')

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
  /**
   * Imperative scrollbar-thumb plumbing. The thumb is positioned by
   * writing straight to the DOM node so a scroll frame never triggers a
   * React render (see the module header). `thumbElRef` is the node the
   * surface attaches via the returned `thumbRef` callback; surfaces that
   * don't render a custom thumb (sidebar, social) simply never attach it
   * and every thumb write below short-circuits.
   */
  const thumbElRef = useRef<HTMLDivElement | null>(null)
  const thumbVisibleRef = useRef(false)
  const thumbTopRef = useRef(0)
  const thumbHeightRef = useRef(0)
  const setThumbRef = useCallback((el: HTMLDivElement | null) => {
    thumbElRef.current = el
  }, [])
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

  const hideThumb = useCallback(() => {
    if (!thumbVisibleRef.current) return
    thumbVisibleRef.current = false
    thumbElRef.current?.classList.remove('chat-scrollbar__thumb--visible')
  }, [])

  const updateThumb = useCallback(
    (scroll: number, scrollLength: number, contentLength: number) => {
      const el = thumbElRef.current
      if (!el) return
      if (contentLength <= scrollLength || scrollLength <= 0) {
        hideThumb()
        return
      }

      const ratio = scrollLength / contentLength
      const thumbHeight = Math.max(THUMB_MIN_HEIGHT, ratio * scrollLength)
      const maxScroll = Math.max(1, contentLength - scrollLength)
      const progress = Math.max(0, Math.min(1, scroll / maxScroll))
      const maxThumbTop = Math.max(0, scrollLength - thumbHeight)
      const thumbTop = progress * maxThumbTop

      // Skip the style write when nothing visible has moved — Legend's
      // sub-pixel content-length jitter during streaming would otherwise
      // touch the node every frame for no visual change.
      if (
        !thumbVisibleRef.current ||
        Math.abs(thumbTopRef.current - thumbTop) >= THUMB_EPSILON_PX ||
        Math.abs(thumbHeightRef.current - thumbHeight) >= THUMB_EPSILON_PX
      ) {
        thumbTopRef.current = thumbTop
        thumbHeightRef.current = thumbHeight
        el.style.top = `${thumbTop}px`
        el.style.height = `${thumbHeight}px`
      }
      if (!thumbVisibleRef.current) {
        thumbVisibleRef.current = true
        el.classList.add('chat-scrollbar__thumb--visible')
      }

      if (thumbFadeRef.current) clearTimeout(thumbFadeRef.current)
      thumbFadeRef.current = setTimeout(hideThumb, THUMB_FADE_MS)
    },
    [hideThumb],
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

  // Report this surface's at-bottom state to the message-window decay
  // gate: the grown loadOlder window only shrinks back to one page while
  // every mounted chat scroll surface sits at the bottom, so history a
  // user is reading in *any* surface is never trimmed out from under them.
  useEffect(() => registerChatAtRestProbe(() => isAtBottomRef.current), [])

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

      // ---- continuous spring follow loop ---------------------------
      // `followTarget` is the absolute scrollTop the loop is chasing
      // (`null` = idle). `followVel` (px/ms) carries across frames so
      // consecutive streaming chunks blend into one glide instead of
      // restarting an ease per chunk. `lastTargetTime` marks the last
      // content growth so the loop can stay warm through the gaps
      // between slow lines, then settle once the stream pauses.
      let followTarget: number | null = null
      let followRaf = 0
      let followGentle = false
      let followVel = 0
      let lastFrameTime = 0
      let lastTargetTime = 0
      // Turn-start reframe latch. When the followed turn changes (a fresh
      // send, or a queued follow-up dispatching once its turn comes) the
      // first catch-up is a one-shot reframe with no reading continuity to
      // preserve, so it uses the gentle ease-out instead of the
      // stream-tuned spring — whose hard-snap branch is exactly the
      // jarring jump on queued-message dispatch. The latch holds gentle
      // across the per-chunk retargets until the loop first catches up,
      // then the spring owns the follow for the rest of the turn.
      let lastFollowedTurnId: string | null = null
      let turnStartGlide = false

      const stopLoop = () => {
        if (followRaf) cancelAnimationFrame(followRaf)
        followRaf = 0
        followTarget = null
        followGentle = false
        followVel = 0
        lastFrameTime = 0
        lastTargetTime = 0
        turnStartGlide = false
      }

      const stepFollow = () => {
        followRaf = 0
        if (!attached || followTarget === null) return
        if (!followRef.current) {
          followTarget = null
          followVel = 0
          lastFrameTime = 0
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

        // Caught up. The gentle one-shot nudge ends here; a stream-follow
        // glide instead idles in place (velocity bled off) and stays warm
        // so the next chunk continues without a restart — until the stream
        // has been quiet for `FOLLOW_STREAM_IDLE_MS`, then it settles.
        if (absDiff < FOLLOW_MIN_STEP_PX) {
          attached.scrollTop = target
          followVel = 0
          lastFrameTime = 0
          turnStartGlide = false
          if (
            followGentle ||
            performance.now() - lastTargetTime > FOLLOW_STREAM_IDLE_MS
          ) {
            followTarget = null
            return
          }
          followRaf = requestAnimationFrame(stepFollow)
          return
        }

        // Gentle post-send reframe: constant low-factor ease-out (no
        // velocity carry, no hard snap) — a single smooth settle.
        if (followGentle) {
          const lerpStep = diff * FOLLOW_GENTLE_LERP_FACTOR
          const stepPx =
            Math.abs(lerpStep) >= FOLLOW_MIN_STEP_PX
              ? lerpStep
              : Math.sign(diff) * FOLLOW_MIN_STEP_PX
          attached.scrollTop = current + stepPx
          followRaf = requestAnimationFrame(stepFollow)
          return
        }

        // Massive gap (post-tool dump, slow network catching up, resumed
        // conversation jumping to the latest reply) — land directly rather
        // than glide hundreds of px with text off-screen the whole time.
        // Stay warm so the trickle that follows the dump still glides.
        if (absDiff > FOLLOW_HARD_SNAP_PX) {
          attached.scrollTop = target
          followVel = 0
          lastFrameTime = 0
          if (performance.now() - lastTargetTime > FOLLOW_STREAM_IDLE_MS) {
            followTarget = null
            return
          }
          followRaf = requestAnimationFrame(stepFollow)
          return
        }

        // Critically-damped spring step. Velocity persists across frames
        // (and across chunk boundaries via `setTarget`), so the motion is
        // a continuous glide rather than a per-chunk ease-out-to-stop.
        const now = performance.now()
        const dt = lastFrameTime
          ? Math.min(FOLLOW_MAX_FRAME_MS, Math.max(1, now - lastFrameTime))
          : FOLLOW_DEFAULT_FRAME_MS
        lastFrameTime = now
        const accel =
          FOLLOW_SPRING_STIFFNESS * diff - FOLLOW_SPRING_DAMPING * followVel
        // Stream-follow never runs backward, so clamp velocity ≥ 0.
        followVel = Math.max(0, followVel + accel * dt)
        let step = followVel * dt
        if (step < FOLLOW_MIN_STEP_PX) step = FOLLOW_MIN_STEP_PX
        if (step >= diff) {
          // Would reach/overshoot the target this frame — land exactly and
          // keep velocity consistent with the distance actually covered.
          attached.scrollTop = target
          followVel = diff / dt
        } else {
          attached.scrollTop = current + step
        }
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
        // Don't follow backwards during stream-follow (would scroll the
        // user up against their intent). Post-send positioning opts in.
        if (
          !options.allowBackward &&
          clamped <= attached.scrollTop + 0.5
        ) {
          return
        }
        const gentle = Boolean(options.gentle)
        // Reduced motion: gentle one-shot reframes land instantly instead
        // of easing (the animation is the point of `gentle`, so there is
        // nothing slower to fall back to).
        if (gentle && prefersReducedMotion()) {
          attached.scrollTop = clamped
          followTarget = null
          followGentle = false
          followVel = 0
          lastFrameTime = 0
          turnStartGlide = false
          return
        }
        // Switching from a warm spring glide into a gentle one-shot (or
        // vice versa) shouldn't carry stale velocity between the two
        // motion profiles.
        if (gentle !== followGentle) followVel = 0
        followTarget = clamped
        followGentle = gentle
        // Mark content growth so the spring loop stays warm between the
        // irregular gaps in a slow stream (gentle nudges don't extend it).
        if (!gentle) lastTargetTime = performance.now()
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
        const userRow = attached.querySelector<HTMLElement>(
          '.event-row--user--just-sent',
        )
        if (!userRow) {
          // The optimistic just-sent row isn't in the DOM. This happens
          // when the user is parked far up in history (follow latch still
          // armed — e.g. they were following a reply taller than the
          // viewport, pinned near its top) and the new user row
          // virtualized off the bottom. We must NOT fall back to the last
          // *rendered* user row: that's an earlier turn's bubble up in the
          // current viewport, and framing it scrolls the viewport
          // *backward* — the "send scrolled me further up" bug. Instead
          // settle forward toward the end so the just-sent bubble (and the
          // assistant reply about to stream below it) come into view.
          const maxScroll = Math.max(
            0,
            attached.scrollHeight - attached.clientHeight,
          )
          setTarget(maxScroll, { gentle: true })
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
        // A different turn started streaming — arm the gentle turn-start
        // reframe. Same-turn key changes (next slot after a tool call)
        // keep the spring so post-tool content dumps still hard-snap into
        // view instead of gliding with the text off-screen.
        const turnId = followKeyTurnId(followKey)
        if (turnId !== lastFollowedTurnId) {
          lastFollowedTurnId = turnId
          turnStartGlide = true
        }
        const streamingRow = attached.querySelector<HTMLElement>(
          `[data-scroll-follow-key="${CSS.escape(followKey)}"]`,
        )
        if (!streamingRow || streamingRow.offsetHeight <= 0) return
        const rowRect = streamingRow.getBoundingClientRect()
        const containerRect = attached.getBoundingClientRect()
        const rowTop = rowRect.top - containerRect.top + attached.scrollTop
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
        const bottomFollow = Math.max(desiredScrollTop, queuedScrollTop)
        // Cap at "streaming row pinned near the viewport top" so a reply
        // taller than the viewport stops following once its start reaches
        // the top, instead of chasing the bottom forever. `min` lets short
        // replies and the queued-follow-up stack keep bottom-following
        // (their `pinnedTop` sits below `bottomFollow`, so it never bites).
        const pinnedTop = Math.max(0, rowTop - FOLLOW_TOP_PEEK_PX)
        const target = Math.min(bottomFollow, pinnedTop)
        setTarget(target, turnStartGlide ? { gentle: true } : undefined)
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

      // NOTE: We intentionally do NOT re-pin scrollTop on container *width*
      // changes (the display/sidebar panel sliding open/closed over 460ms).
      // Earlier versions re-ran `scrollToEnd`, or wrote `scrollTop` directly,
      // on every width tick to keep the bottom glued during the reflow — but
      // any external scroll write during the slide fights Legend's
      // `maintainVisibleContentPosition`, which independently re-anchors on
      // each reflow frame. The two controllers disagree frame-to-frame and
      // oscillate: the heavy vertical shake at the bottom while toggling the
      // sidebar. An isolated A/B harness confirmed it — with the per-frame
      // pin the reference row's on-screen Y oscillated (5 direction reversals,
      // 42px range); with no custom write Legend's MVCP held it smoothly (0
      // reversals, 21px monotonic settle). So we let MVCP own scroll position
      // across width reflows and write scrollTop only for the explicit motions
      // (send nudge, stream follow, scroll-to-bottom button).

      cleanup = () => {
        if (!attached) return
        unsubscribeFollow()
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
    thumbRef: setThumbRef,
  }
}
