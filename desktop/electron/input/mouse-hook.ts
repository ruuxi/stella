import { uIOhook, UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi'
import {
  isNativeBlockingAvailable,
  startMouseBlock,
  stopMouseBlock,
} from './mouse-block.js'

// Modifier keys we track for the uIOhook fallback (Linux + dev macOS without
// the native helper). On macOS the modifier is Command; on Windows/Linux it
// is Control. The native helpers do their own modifier check at OS level.
const LEFT_META = 3675
const RIGHT_META = 3676
const LEFT_CTRL = 29
const RIGHT_CTRL = 3613

// uIOhook keycodes for the Option/Alt key (left + right). On macOS this is
// the Option key; on Windows/Linux it is the Alt key. Mapped from
// `UiohookKey.Alt` (56) and `UiohookKey.AltRight` (3640).
const LEFT_ALT = 56
const RIGHT_ALT = 3640
const ALT_KEYS: ReadonlySet<number> = new Set([LEFT_ALT, RIGHT_ALT])

const MODIFIER_KEYS_BY_PLATFORM: Record<string, readonly number[]> = {
  darwin: [LEFT_META, RIGHT_META],
  win32: [LEFT_CTRL, RIGHT_CTRL],
  linux: [LEFT_CTRL, RIGHT_CTRL],
}

const RIGHT_MOUSE_BUTTON = 2
const LEFT_MOUSE_BUTTON = 1

// Max time (ms) between the first Alt keyup and the second Alt keydown for
// the gesture to count as a "double-tap". 350ms matches the typical OS
// double-click threshold and feels fast-but-not-twitchy in practice.
const DOUBLE_TAP_WINDOW_MS = 350

export type ContextMenuTriggerEvent = {
  x: number
  y: number
}

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
  onContextMenuTrigger: (event: ContextMenuTriggerEvent) => void
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
 *
 * State transitions:
 *   idle      → first Alt keydown  → first-down
 *   first-down → Alt keyup         → first-up (record timestamp)
 *   first-up  → Alt keydown (in window) → fire + idle
 *   first-up  → Alt keydown (after window) → first-down (start over)
 *   any       → non-Alt keydown    → idle (cancel)
 *
 * Auto-repeated keydowns from holding the key are suppressed by the caller
 * (it only forwards transitions on `wasAlreadyDown=false`).
 */
class DoubleTapAltDetector {
  private state: 'idle' | 'first-down' | 'first-up' = 'idle'
  private firstTapUpAt = 0

  constructor(private readonly fire: () => void) {}

  notifyAltKeydown(now: number) {
    if (this.state === 'first-up') {
      if (now - this.firstTapUpAt <= DOUBLE_TAP_WINDOW_MS) {
        this.reset()
        this.fire()
        return
      }
    }
    this.state = 'first-down'
  }

  notifyAltKeyup(now: number) {
    if (this.state === 'first-down') {
      this.state = 'first-up'
      this.firstTapUpAt = now
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
 * Currently surfaces:
 *   - `onContextMenuTrigger` — modifier + right-click (Cmd on macOS,
 *     Ctrl on Windows/Linux). The OS-level menu is suppressed by the
 *     bundled native helper where available.
 *   - `onDoubleTapModifier`  — two fast taps of Option / Alt in a row.
 *
 *   macOS  → CGEventTap helper drops the click before the OS can show its
 *             context menu, then fires the trigger.
 *   win32  → WH_MOUSE_LL helper drops the click before the OS can show its
 *             context menu, then fires the trigger.
 *   linux  → Falls back to uIOhook observation (the OS context menu will
 *             still appear).
 *
 * The Option/Alt double-tap gesture is detected from raw uIOhook key events
 * on every platform (no native blocking — the OS doesn't reserve Option-tap
 * for anything by default, so we don't need to suppress it).
 */
export class MouseHookManager {
  private events: MouseHookEvents
  private started = false
  private uiohookListenersAttached = false
  private uiohookStarted = false
  private pressedKeycodes = new Set<number>()
  private nativeBlockingActive = false
  private readonly doubleTapDetector: DoubleTapAltDetector | null
  private lastLeftDownPoint: { x: number; y: number } | null = null

  constructor(events: MouseHookEvents) {
    this.events = events
    this.doubleTapDetector = events.onDoubleTapModifier
      ? new DoubleTapAltDetector(events.onDoubleTapModifier)
      : null
  }

  start() {
    if (this.started) return
    this.started = true

    // Prefer the native helper that consumes the OS-level click — it is the
    // only way to suppress the foreground app's context menu.
    if (isNativeBlockingAvailable()) {
      this.nativeBlockingActive = startMouseBlock((event, x, y) => {
        if (event === 'down') {
          this.events.onContextMenuTrigger({ x, y })
        }
        // The native helper also eats the matching mouseup so the foreground
        // app never sees half a click; we don't need to forward it.
      })
    }

    // We always attach uIOhook for two reasons:
    //   1. As a fallback for the modifier+right-click trigger when the
    //      native helper is unavailable (Linux, or a dev macOS install
    //      without the bundled binary).
    //   2. To start the background uIOhook event loop required by other
    //      services that may attach listeners later.
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
    this.doubleTapDetector?.cancel()

    if (this.nativeBlockingActive) {
      stopMouseBlock()
      this.nativeBlockingActive = false
    }

    if (this.uiohookStarted) {
      try {
        uIOhook.stop()
      } catch {
        // ignore — uIOhook can throw if already stopped on shutdown
      }
      this.uiohookStarted = false
    }
  }

  private isModifierPressed(): boolean {
    const keys =
      MODIFIER_KEYS_BY_PLATFORM[process.platform] ??
      MODIFIER_KEYS_BY_PLATFORM.linux
    return keys.some((keycode) => this.pressedKeycodes.has(keycode))
  }

  private attachUiohookListeners() {
    if (this.uiohookListenersAttached) return
    this.uiohookListenersAttached = true

    uIOhook.on('keydown', this.handleKeydown)
    uIOhook.on('keyup', this.handleKeyup)
    uIOhook.on('mousedown', this.handleMousedown)
    if (this.events.onLeftMouseUp) {
      uIOhook.on('mouseup', this.handleMouseup)
    }
  }

  private readonly handleKeydown = (event: UiohookKeyboardEvent) => {
    const wasAlreadyDown = this.pressedKeycodes.has(event.keycode)
    this.pressedKeycodes.add(event.keycode)

    if (!this.doubleTapDetector) return

    // Suppress auto-repeat (the OS resends keydown while a key is held).
    if (wasAlreadyDown) return

    if (ALT_KEYS.has(event.keycode)) {
      this.doubleTapDetector.notifyAltKeydown(Date.now())
    } else {
      // Any other key pressed during the gesture cancels it — the user is
      // clearly typing/triggering something else, not double-tapping Option.
      this.doubleTapDetector.cancel()
    }
  }

  private readonly handleKeyup = (event: UiohookKeyboardEvent) => {
    this.pressedKeycodes.delete(event.keycode)

    if (!this.doubleTapDetector) return
    if (ALT_KEYS.has(event.keycode)) {
      this.doubleTapDetector.notifyAltKeyup(Date.now())
    }
  }

  private readonly handleMousedown = (event: UiohookMouseEvent) => {
    const button = typeof event.button === 'number' ? event.button : -1
    if (button === LEFT_MOUSE_BUTTON) {
      this.lastLeftDownPoint = { x: event.x, y: event.y }
    }

    // The fallback trigger path: if the native helper isn't suppressing the
    // OS context menu we still need uIOhook to detect modifier+right-click
    // and forward the trigger to the service.
    if (this.nativeBlockingActive) return
    if (button !== RIGHT_MOUSE_BUTTON) return
    if (!this.isModifierPressed()) return
    this.events.onContextMenuTrigger({ x: event.x, y: event.y })
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
