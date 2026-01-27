import { uIOhook, UiohookMouseEvent } from 'uiohook-napi'

type MouseHookEvents = {
  onRadialShow: (x: number, y: number) => void
  onRadialHide: () => void
  onMouseMove: (x: number, y: number) => void
  onMouseUp: (x: number, y: number) => void
  onNativeMenuRequest: (x: number, y: number) => void
}

const HOLD_THRESHOLD_MS = 100
const RIGHT_BUTTON = 2

export class MouseHookManager {
  private events: MouseHookEvents
  private rightDownTime: number | null = null
  private rightDownPosition: { x: number; y: number } | null = null
  private radialActive = false
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(events: MouseHookEvents) {
    this.events = events
  }

  start() {
    if (this.started) return
    this.started = true

    uIOhook.on('mousedown', (event: UiohookMouseEvent) => {
      if (event.button === RIGHT_BUTTON) {
        this.rightDownTime = Date.now()
        this.rightDownPosition = { x: event.x, y: event.y }

        // Start timer for hold detection
        this.holdTimer = setTimeout(() => {
          if (this.rightDownPosition) {
            this.radialActive = true
            this.events.onRadialShow(
              this.rightDownPosition.x,
              this.rightDownPosition.y
            )
          }
        }, HOLD_THRESHOLD_MS)
      }
    })

    uIOhook.on('mouseup', (event: UiohookMouseEvent) => {
      if (event.button === RIGHT_BUTTON) {
        const wasHeld = this.radialActive

        // Clear hold timer
        if (this.holdTimer) {
          clearTimeout(this.holdTimer)
          this.holdTimer = null
        }

        if (wasHeld) {
          // Radial was shown, trigger selection
          this.events.onMouseUp(event.x, event.y)
          this.events.onRadialHide()
        } else {
          // Short click - pass through to native menu
          if (this.rightDownPosition) {
            this.events.onNativeMenuRequest(
              this.rightDownPosition.x,
              this.rightDownPosition.y
            )
          }
        }

        this.radialActive = false
        this.rightDownTime = null
        this.rightDownPosition = null
      }
    })

    uIOhook.on('mousemove', (event: UiohookMouseEvent) => {
      if (this.radialActive) {
        this.events.onMouseMove(event.x, event.y)
      }
    })

    uIOhook.start()
  }

  stop() {
    if (!this.started) return
    this.started = false

    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }

    uIOhook.stop()
  }

  isRadialActive() {
    return this.radialActive
  }
}
