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

const MODIFIER_KEYS_BY_PLATFORM: Record<string, readonly number[]> = {
  darwin: [LEFT_META, RIGHT_META],
  win32: [LEFT_CTRL, RIGHT_CTRL],
  linux: [LEFT_CTRL, RIGHT_CTRL],
}

const RIGHT_MOUSE_BUTTON = 2

export type ContextMenuTriggerEvent = {
  x: number
  y: number
}

type MouseHookEvents = {
  onContextMenuTrigger: (event: ContextMenuTriggerEvent) => void
}

/**
 * Listens for the global "modifier + right-click" gesture and fires
 * `onContextMenuTrigger` when detected.
 *
 *   macOS  → CGEventTap helper drops the event before the OS can show its
 *             context menu, then fires the trigger.
 *   win32  → WH_MOUSE_LL helper drops the event before the OS can show its
 *             context menu, then fires the trigger.
 *   linux  → Falls back to uIOhook observation (the OS context menu will
 *             still appear).
 */
export class MouseHookManager {
  private events: MouseHookEvents
  private started = false
  private uiohookListenersAttached = false
  private uiohookStarted = false
  private pressedKeycodes = new Set<number>()
  private nativeBlockingActive = false

  constructor(events: MouseHookEvents) {
    this.events = events
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
  }

  private readonly handleKeydown = (event: UiohookKeyboardEvent) => {
    this.pressedKeycodes.add(event.keycode)
  }

  private readonly handleKeyup = (event: UiohookKeyboardEvent) => {
    this.pressedKeycodes.delete(event.keycode)
  }

  private readonly handleMousedown = (event: UiohookMouseEvent) => {
    // The fallback trigger path: if the native helper isn't suppressing the
    // OS context menu we still need uIOhook to detect modifier+right-click
    // and forward the trigger to the service.
    if (this.nativeBlockingActive) return
    const button = typeof event.button === 'number' ? event.button : -1
    if (button !== RIGHT_MOUSE_BUTTON) return
    if (!this.isModifierPressed()) return
    this.events.onContextMenuTrigger({ x: event.x, y: event.y })
  }
}
