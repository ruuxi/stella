import { uIOhook, UiohookMouseEvent, UiohookKeyboardEvent } from 'uiohook-napi'
import { hasMacPermission } from '../utils/macos-permissions.js'
import {
  DEFAULT_RADIAL_TRIGGER_CODE,
  isRadialTriggerPressed,
  type RadialTriggerCode,
} from '../../src/shared/lib/radial-trigger.js'

type MouseHookEvents = {
  onRadialShow: () => void
  onRadialHide: () => void
  onMouseMove: (x: number, y: number) => void
  onTriggerUp: () => void
}

export class MouseHookManager {
  private events: MouseHookEvents
  private radialActive = false
  private started = false
  private pressedKeycodes = new Set<number>()
  private radialTriggerKey: RadialTriggerCode

  constructor(
    events: MouseHookEvents,
    radialTriggerKey: RadialTriggerCode = DEFAULT_RADIAL_TRIGGER_CODE,
  ) {
    this.events = events
    this.radialTriggerKey = radialTriggerKey
  }

  start() {
    if (this.started) return

    if (!hasMacPermission('accessibility', false)) {
      console.warn('[mouse-hook] Accessibility permission not granted — input hooks disabled until approved')
      return
    }

    this.started = true
    uIOhook.on('keydown', (event: UiohookKeyboardEvent) => {
      this.pressedKeycodes.add(event.keycode)
      if (this.matchesTriggerKey() && !this.radialActive) {
        this.radialActive = true
        this.events.onRadialShow()
      }
    })

    uIOhook.on('keyup', (event: UiohookKeyboardEvent) => {
      const wasTriggerHeld = this.matchesTriggerKey()
      this.pressedKeycodes.delete(event.keycode)
      if (wasTriggerHeld && !this.matchesTriggerKey() && this.radialActive) {
        this.events.onTriggerUp()
        this.events.onRadialHide()
        this.radialActive = false
      }
    })

    uIOhook.on('mousemove', (event: UiohookMouseEvent) => {
      if (this.radialActive) {
        this.events.onMouseMove(event.x, event.y)
      }
    })

    try {
      uIOhook.start()
    } catch (error) {
      console.error('[mouse-hook] Failed to start input hook:', (error as Error).message)
      this.started = false
    }
  }

  stop() {
    if (!this.started) return
    this.started = false
    this.radialActive = false
    this.pressedKeycodes.clear()
    uIOhook.stop()
  }

  setRadialTriggerKey(radialTriggerKey: RadialTriggerCode) {
    this.radialTriggerKey = radialTriggerKey
  }

  isRadialActive() {
    return this.radialActive
  }

  private matchesTriggerKey(): boolean {
    return isRadialTriggerPressed(this.radialTriggerKey, this.pressedKeycodes, process.platform)
  }
}
