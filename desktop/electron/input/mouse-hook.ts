import { uIOhook, type UiohookKeyboardEvent } from 'uiohook-napi'
import { areGlobalShortcutsSuspended } from '../ipc/global-shortcuts.js'

const LEFT_ALT = 56
const RIGHT_ALT = 3640
const ALT_KEYCODES = new Set([LEFT_ALT, RIGHT_ALT])
const DICTATION_PUSH_TO_TALK_TRIGGER_DELAY_MS = 150

export type DictationPushToTalkHandlers = {
  isEnabled: () => boolean
  start: () => void
  reveal: () => void
  stop: (durationMs: number) => void
  cancel: () => void
  discard: () => void
}

/**
 * Owns the low-level keyboard hook required for bare-Option push-to-talk
 * dictation while keeping unrelated global input off the main-process hot
 * path.
 */
export class MouseHookManager {
  private started = false
  private uiohookListenersAttached = false
  private uiohookStarted = false
  private pressedKeycodes = new Set<number>()
  private dictationKeyDownAt: number | null = null
  private dictationStartTimer: ReturnType<typeof setTimeout> | null = null
  private dictationStarted = false
  private handlers: DictationPushToTalkHandlers | null = null

  setDictationPushToTalkHandlers(handlers: DictationPushToTalkHandlers) {
    this.handlers = handlers
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
    this.cancelActiveDictation()
    this.pressedKeycodes.clear()

    if (this.uiohookStarted) {
      try {
        uIOhook.stop()
      } catch (error) {
        console.warn(
          '[mouse-hook] Failed to stop input hook:',
          (error as Error).message,
        )
      }
      this.uiohookStarted = false
    }
    this.detachUiohookListeners()
  }

  isHookRunning() {
    return this.uiohookStarted
  }

  private attachUiohookListeners() {
    if (this.uiohookListenersAttached) return
    this.uiohookListenersAttached = true
    uIOhook.on('keydown', this.handleKeydown)
    uIOhook.on('keyup', this.handleKeyup)
    uIOhook.on('mousedown', this.handleMousedown)
  }

  private detachUiohookListeners() {
    if (!this.uiohookListenersAttached) return
    this.uiohookListenersAttached = false
    uIOhook.off('keydown', this.handleKeydown)
    uIOhook.off('keyup', this.handleKeyup)
    uIOhook.off('mousedown', this.handleMousedown)
  }

  private clearPendingDictationStart() {
    if (this.dictationStartTimer) {
      clearTimeout(this.dictationStartTimer)
      this.dictationStartTimer = null
    }
    this.dictationKeyDownAt = null
  }

  private cancelActiveDictation() {
    const wasActive = this.dictationKeyDownAt !== null || this.dictationStarted
    const hadStarted = this.dictationStarted
    this.clearPendingDictationStart()
    this.dictationStarted = false
    if (!wasActive) return
    if (hadStarted) {
      this.handlers?.cancel()
    } else {
      this.handlers?.discard()
    }
  }

  private readonly handleKeydown = (event: UiohookKeyboardEvent) => {
    if (!this.started) return
    if (areGlobalShortcutsSuspended()) {
      this.cancelActiveDictation()
      this.pressedKeycodes.clear()
      return
    }

    const wasAlreadyDown = this.pressedKeycodes.has(event.keycode)
    const otherKeyHeld = [...this.pressedKeycodes].some(
      (keycode) => !ALT_KEYCODES.has(keycode),
    )
    this.pressedKeycodes.add(event.keycode)
    const isAlt = ALT_KEYCODES.has(event.keycode)
    if (!isAlt) {
      // Bare Option is the dictation gesture. Any chord or ordinary keypress
      // means the user intended a normal keyboard command instead.
      if (this.dictationKeyDownAt !== null || this.dictationStarted) {
        this.cancelActiveDictation()
      }
      return
    }

    if (
      this.handlers?.isEnabled() !== true ||
      this.dictationKeyDownAt !== null ||
      wasAlreadyDown ||
      otherKeyHeld
    ) {
      return
    }

    this.dictationKeyDownAt = Date.now()
    this.dictationStarted = true
    this.handlers.start()
    this.dictationStartTimer = setTimeout(() => {
      this.dictationStartTimer = null
      if (this.dictationKeyDownAt === null || !this.dictationStarted) return
      this.handlers?.reveal()
    }, DICTATION_PUSH_TO_TALK_TRIGGER_DELAY_MS)
  }

  private readonly handleKeyup = (event: UiohookKeyboardEvent) => {
    if (!this.started) return
    if (areGlobalShortcutsSuspended()) {
      this.cancelActiveDictation()
      this.pressedKeycodes.clear()
      return
    }
    this.pressedKeycodes.delete(event.keycode)
    if (!ALT_KEYCODES.has(event.keycode) || this.dictationKeyDownAt === null) {
      return
    }

    const durationMs = Date.now() - this.dictationKeyDownAt
    const hadStarted = this.dictationStarted
    this.clearPendingDictationStart()
    this.dictationStarted = false
    if (hadStarted) {
      this.handlers?.stop(durationMs)
    } else {
      this.handlers?.discard()
    }
  }

  private readonly handleMousedown = () => {
    if (!this.started) return
    if (this.dictationKeyDownAt !== null || this.dictationStarted) {
      this.cancelActiveDictation()
    }
  }
}
