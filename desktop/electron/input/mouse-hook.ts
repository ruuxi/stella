import { uIOhook, UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi'
import {
  DEFAULT_RADIAL_TRIGGER_CODE,
  isRadialTriggerPressed,
  type RadialTriggerCode,
} from '../../src/shared/lib/radial-trigger.js'
import {
  DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  type MiniDoubleTapModifier,
} from '../../src/shared/lib/mini-double-tap.js'

// uIOhook keycodes for the Option/Alt key (left + right). On macOS this is
// the Option key; on Windows/Linux it is the Alt key. Mapped from
// `UiohookKey.Alt` (56) and `UiohookKey.AltRight` (3640).
const LEFT_ALT = 56
const RIGHT_ALT = 3640
const LEFT_META = 3675
const RIGHT_META = 3676
const LEFT_CONTROL = 29
const RIGHT_CONTROL = 3613
const LEFT_SHIFT = 42
const RIGHT_SHIFT = 54
const MODIFIER_KEYCODES: Record<Exclude<MiniDoubleTapModifier, 'Off'>, ReadonlySet<number>> = {
  Alt: new Set([LEFT_ALT, RIGHT_ALT]),
  Control: new Set([LEFT_CONTROL, RIGHT_CONTROL]),
  Command: new Set([LEFT_META, RIGHT_META]),
  Shift: new Set([LEFT_SHIFT, RIGHT_SHIFT]),
}

const LEFT_MOUSE_BUTTON = 1

// Max time (ms) between the first Alt keyup and the second Alt keydown for
// the gesture to count as a "double-tap". 350ms matches the typical OS
// double-click threshold and feels fast-but-not-twitchy in practice.
const DOUBLE_TAP_WINDOW_MS = 350

export type LeftMouseUpEvent = {
  x: number
  y: number
  /**
   * Manhattan distance between the matching left-mousedown coordinates
   * and this mouseup. Consumers use this as a "did the user drag?" gate
   * — a true click hovers near zero; a text selection drags > 4px.
   */
  dragDistance: number
}

type MouseHookEvents = {
  /**
   * Fired when the radial trigger chord transitions from "not held" → "held"
   * (e.g. user just pressed Option+Cmd on macOS). Consumers should show the
   * radial dial overlay at the current cursor position.
   */
  onRadialShow: () => void
  /**
   * Fired when the radial trigger chord is released (or the user pressed a
   * non-trigger key cancelling the gesture). Consumers should hide the
   * radial overlay.
   */
  onRadialHide: () => void
  /**
   * Fired on every mouse-move while the radial is active. Coordinates are
   * native screen pixels.
   */
  onMouseMove: (x: number, y: number) => void
  /**
   * Fired right before `onRadialHide` when the trigger chord was released
   * cleanly (vs. cancelled). Consumers use this to commit the wedge under
   * the cursor.
   */
  onTriggerUp: () => void
  /**
   * Fired when the user taps the Option (macOS) / Alt (Windows / Linux) key
   * twice in rapid succession with no other keys pressed in between. The
   * gesture is purely keyboard, so no coordinates are supplied.
   */
  onDoubleTapModifier?: () => void
  /**
   * Fired on every global left-mouse-button release. Used by the selection
   * watcher to trigger an "Ask Stella" pill above any text the user just
   * finished selecting; only attached when a consumer actually needs it.
   */
  onLeftMouseUp?: (event: LeftMouseUpEvent) => void
}

/**
 * Tiny state machine that fires once when the user double-taps the Option
 * (macOS) / Alt (Windows / Linux) key. The gesture is "two solo taps within
 * `DOUBLE_TAP_WINDOW_MS`" — any other key pressed in between cancels the
 * sequence so we don't false-trigger while typing.
 */
class DoubleTapModifierDetector {
  private state: 'idle' | 'first-down' | 'first-up' | 'second-down' = 'idle'
  private firstTapUpAt = 0

  constructor(
    private modifier: MiniDoubleTapModifier,
    private readonly fire: () => void,
  ) {}

  setModifier(modifier: MiniDoubleTapModifier) {
    this.modifier = modifier
    this.reset()
  }

  isModifierKey(keycode: number) {
    if (this.modifier === 'Off') return false
    return MODIFIER_KEYCODES[this.modifier]?.has(keycode) ?? false
  }

  notifyModifierKeydown(now: number) {
    if (this.state === 'first-up') {
      if (now - this.firstTapUpAt <= DOUBLE_TAP_WINDOW_MS) {
        this.state = 'second-down'
        return
      }
      this.reset()
    }
    this.state = 'first-down'
  }

  notifyModifierKeyup(now: number) {
    if (this.state === 'first-down') {
      this.state = 'first-up'
      this.firstTapUpAt = now
    } else if (this.state === 'second-down') {
      this.reset()
      this.fire()
    } else {
      this.reset()
    }
  }

  cancel() {
    this.reset()
  }

  private reset() {
    this.state = 'idle'
    this.firstTapUpAt = 0
  }
}

/**
 * Listens for global input gestures and forwards them as semantic events.
 *
 * Currently surfaces:
 *   - Radial chord (default Option+Cmd on macOS / Alt+Win on Windows / Linux):
 *     `onRadialShow` on press, `onMouseMove` while held, `onTriggerUp` then
 *     `onRadialHide` on release.
 *   - Option/Alt double-tap → `onDoubleTapModifier`.
 *   - Left-mouse-button release → `onLeftMouseUp`.
 *
 * The radial chord is a keyboard gesture, so we never need to swallow the
 * OS context menu — uIOhook is enough on every platform.
 */
export class MouseHookManager {
  private events: MouseHookEvents
  private started = false
  private uiohookListenersAttached = false
  private uiohookStarted = false
  private pressedKeycodes = new Set<number>()
  private radialActive = false
  private radialTriggerKey: RadialTriggerCode
  private readonly doubleTapDetector: DoubleTapModifierDetector | null
  private lastLeftDownPoint: { x: number; y: number } | null = null

  constructor(
    events: MouseHookEvents,
    radialTriggerKey: RadialTriggerCode = DEFAULT_RADIAL_TRIGGER_CODE,
    miniDoubleTapModifier: MiniDoubleTapModifier = DEFAULT_MINI_DOUBLE_TAP_MODIFIER,
  ) {
    this.events = events
    this.radialTriggerKey = radialTriggerKey
    this.doubleTapDetector = events.onDoubleTapModifier
      ? new DoubleTapModifierDetector(miniDoubleTapModifier, events.onDoubleTapModifier)
      : null
  }

  start() {
    if (this.started) return
    this.started = true

    this.attachUiohookListeners()

    if (!this.uiohookStarted) {
      try {
        uIOhook.start()
        this.uiohookStarted = true
      } catch (error) {
        console.error(
          '[mouse-hook] Failed to start input hook:',
          (error as Error).message,
        )
      }
    }
  }

  stop() {
    if (!this.started) return
    this.started = false
    this.pressedKeycodes.clear()
    this.radialActive = false
    this.doubleTapDetector?.cancel()

    if (this.uiohookStarted) {
      try {
        uIOhook.stop()
      } catch {
        // ignore — uIOhook can throw if already stopped on shutdown
      }
      this.uiohookStarted = false
    }
  }

  setRadialTriggerKey(radialTriggerKey: RadialTriggerCode) {
    this.radialTriggerKey = radialTriggerKey
  }

  setMiniDoubleTapModifier(modifier: MiniDoubleTapModifier) {
    this.doubleTapDetector?.setModifier(modifier)
  }

  isRadialActive() {
    return this.radialActive
  }

  private matchesTriggerKey(): boolean {
    return isRadialTriggerPressed(
      this.radialTriggerKey,
      this.pressedKeycodes,
      process.platform,
    )
  }

  private attachUiohookListeners() {
    if (this.uiohookListenersAttached) return
    this.uiohookListenersAttached = true

    uIOhook.on('keydown', this.handleKeydown)
    uIOhook.on('keyup', this.handleKeyup)
    uIOhook.on('mousemove', this.handleMousemove)
    uIOhook.on('mousedown', this.handleMousedown)
    if (this.events.onLeftMouseUp) {
      uIOhook.on('mouseup', this.handleMouseup)
    }
  }

  private readonly handleKeydown = (event: UiohookKeyboardEvent) => {
    const wasAlreadyDown = this.pressedKeycodes.has(event.keycode)
    this.pressedKeycodes.add(event.keycode)

    // Radial chord: fire `onRadialShow` exactly when the chord transitions
    // from incomplete → complete. Holding any extra keys does not retrigger.
    if (this.matchesTriggerKey() && !this.radialActive) {
      this.radialActive = true
      this.events.onRadialShow()
    }

    if (!this.doubleTapDetector) return

    // Suppress auto-repeat (the OS resends keydown while a key is held).
    if (wasAlreadyDown) return

    if (this.doubleTapDetector.isModifierKey(event.keycode)) {
      this.doubleTapDetector.notifyModifierKeydown(Date.now())
    } else {
      // Any other key pressed during the gesture cancels it — the user is
      // clearly typing/triggering something else, not double-tapping Option.
      this.doubleTapDetector.cancel()
    }
  }

  private readonly handleKeyup = (event: UiohookKeyboardEvent) => {
    const wasTriggerHeld = this.matchesTriggerKey()
    this.pressedKeycodes.delete(event.keycode)
    if (wasTriggerHeld && !this.matchesTriggerKey() && this.radialActive) {
      this.events.onTriggerUp()
      this.events.onRadialHide()
      this.radialActive = false
    }

    if (!this.doubleTapDetector) return
    if (this.doubleTapDetector.isModifierKey(event.keycode)) {
      this.doubleTapDetector.notifyModifierKeyup(Date.now())
    }
  }

  private readonly handleMousemove = (event: UiohookMouseEvent) => {
    if (this.radialActive) {
      this.events.onMouseMove(event.x, event.y)
    }
  }

  private readonly handleMousedown = (event: UiohookMouseEvent) => {
    const button = typeof event.button === 'number' ? event.button : -1
    if (button === LEFT_MOUSE_BUTTON) {
      this.lastLeftDownPoint = { x: event.x, y: event.y }
    }
  }

  private readonly handleMouseup = (event: UiohookMouseEvent) => {
    const handler = this.events.onLeftMouseUp
    if (!handler) return
    const button = typeof event.button === 'number' ? event.button : -1
    if (button !== LEFT_MOUSE_BUTTON) return
    const downPoint = this.lastLeftDownPoint
    this.lastLeftDownPoint = null
    const dragDistance = downPoint
      ? Math.abs(event.x - downPoint.x) + Math.abs(event.y - downPoint.y)
      : 0
    handler({ x: event.x, y: event.y, dragDistance })
  }
}
