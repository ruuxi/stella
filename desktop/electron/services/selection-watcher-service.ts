import { globalShortcut } from 'electron'
import { getSelectedText, type SelectedTextResult } from '../selected-text.js'
import type { LeftMouseUpEvent } from '../input/mouse-hook.js'
import type { CaptureService } from './capture-service.js'

const COMMIT_DELAY_MS = 80
const MIN_INTERVAL_MS = 120
const AUTO_HIDE_MS = 10_000
const MIN_TEXT_CHARS = 2
/**
 * Manhattan-distance threshold that distinguishes a click from a drag.
 * Below this we don't ask the macOS helper to do its synthetic-Cmd+C
 * pasteboard fallback — a click can't have produced a new selection,
 * so the round-trip would just slow every click down by ~250ms.
 */
const DRAG_DISTANCE_THRESHOLD = 6

export type SelectionChipPayload = {
  text: string
  rect: { x: number; y: number; width: number; height: number }
  requestId: number
}

export type SelectionWatcherOverlayBridge = {
  showSelectionChip: (payload: SelectionChipPayload) => void
  hideSelectionChip: (requestId?: number) => void
}

export type SelectionWatcherWindowBridge = {
  /** True when any Stella renderer window is currently focused. */
  isStellaFocused: () => boolean
  /**
   * True when the mini (compact) Stella window is currently on screen.
   * The global "Ask Stella" chip only ever appears while this returns
   * true — outside that surface we don't want to trail the user's
   * cursor across the OS.
   */
  isMiniWindowVisible: () => boolean
  /** Surface a freshly-clicked chip's text into the chat sidebar. */
  routeSelectionToSidebar: (text: string) => void
}

export type SelectionWatcherDeps = {
  shouldEnable: () => boolean
  overlay: SelectionWatcherOverlayBridge
  window: SelectionWatcherWindowBridge
  capture: Pick<CaptureService, 'setPendingChatContext' | 'getChatContextSnapshot' | 'broadcastChatContext' | 'emptyContext'>
}

/**
 * Watches global left-mouse-up events and surfaces an "Ask Stella" pill
 * via the overlay window when the user has just finished selecting text
 * in any foreground app.
 *
 * The pill itself lives in the renderer (`SelectionChipOverlay`); this
 * service is the main-process glue: it asks the native helper for the
 * current selection + screen rect, dedups against the most recent
 * showing, and routes the click into the chat sidebar.
 */
export class SelectionWatcherService {
  private enabled = false
  private capturing = false
  private lastFireAt = 0
  private requestCounter = 0
  private currentRequestId: number | null = null
  private currentText: string | null = null
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null
  private escRegistered = false

  constructor(private readonly deps: SelectionWatcherDeps) {}

  start() {
    this.enabled = this.deps.shouldEnable()
  }

  stop() {
    this.enabled = false
    this.hide('stop')
  }

  /** Wired into MouseHookManager via ContextMenuService. */
  readonly handleLeftMouseUp = (event: LeftMouseUpEvent) => {
    if (!this.enabled) return
    if (!this.deps.window.isMiniWindowVisible()) {
      // Product rule: the global "Ask Stella" pill only surfaces while
      // the mini window is open. If the user has Stella tucked away,
      // we never tail their cursor across other apps. Also clear any
      // chip we may have been showing when the window was hidden.
      if (this.currentRequestId !== null) this.hide('mini-hidden')
      return
    }
    const now = Date.now()
    if (this.capturing) return
    if (now - this.lastFireAt < MIN_INTERVAL_MS) return
    if (this.deps.window.isStellaFocused()) {
      // Easy in-app chip handles selections inside Stella's own surfaces.
      return
    }
    this.lastFireAt = now
    this.capturing = true
    const wasDrag = event.dragDistance >= DRAG_DISTANCE_THRESHOLD
    setTimeout(() => {
      void this.captureSelection(event, wasDrag).finally(() => {
        this.capturing = false
      })
    }, COMMIT_DELAY_MS)
  }

  /** Resolve a click on the overlay chip from the renderer. */
  resolveClick(requestId: number): boolean {
    if (this.currentRequestId !== requestId) return false
    const text = this.currentText
    if (!text) {
      this.hide('stale')
      return false
    }

    this.deps.window.routeSelectionToSidebar(text)
    this.hide('clicked')
    return true
  }

  /** Hide the chip externally (e.g. on bootstrap teardown). */
  hideChip() {
    this.hide('external')
  }

  private async captureSelection(
    event: LeftMouseUpEvent,
    wasDrag: boolean,
  ): Promise<void> {
    let result: SelectedTextResult | null = null
    try {
      // Fast pass: AX only. Cheap, side-effect-free, succeeds in
      // browsers + most native text views.
      result = await getSelectedText({ allowClipboardFallback: false })
      if (!result && wasDrag) {
        // Slow pass: synthetic Cmd+C with pasteboard restore. Covers
        // apps whose AX trees don't expose `AXSelectedText` (Discord,
        // Slack, terminals, Electron-based custom text views). Gated
        // on the user actually dragging so plain clicks never pay the
        // ~250ms clipboard-round-trip cost.
        result = await getSelectedText({ allowClipboardFallback: true })
      }
    } catch (error) {
      console.warn('[selection-watcher] getSelectedText failed', error)
      return
    }

    if (!result) {
      // Nothing currently selected — clear any stale chip we put up earlier.
      if (this.currentRequestId !== null) this.hide('empty')
      return
    }

    const trimmed = result.text.trim()
    if (trimmed.length < MIN_TEXT_CHARS) {
      if (this.currentRequestId !== null) this.hide('too-short')
      return
    }

    if (this.currentText === trimmed) {
      // Same selection as the chip we already have up; leave it alone so
      // we don't spam the user with re-anchoring during a click-through.
      return
    }

    const rect = this.resolveAnchorRect(result, event)
    const requestId = ++this.requestCounter
    this.currentRequestId = requestId
    this.currentText = trimmed

    this.deps.overlay.showSelectionChip({ text: trimmed, rect, requestId })
    this.scheduleAutoHide()
    this.registerEscape()
  }

  private resolveAnchorRect(
    result: SelectedTextResult,
    event: LeftMouseUpEvent,
  ): { x: number; y: number; width: number; height: number } {
    if (result.rect && result.rect.width > 0 && result.rect.height > 0) {
      return result.rect
    }
    // Fallback: anchor to the mouseup point with a small synthetic box.
    return {
      x: Math.max(0, event.x - 60),
      y: Math.max(0, event.y - 24),
      width: 120,
      height: 24,
    }
  }

  private scheduleAutoHide() {
    this.clearAutoHide()
    this.autoHideTimer = setTimeout(() => {
      this.hide('timeout')
    }, AUTO_HIDE_MS)
  }

  private clearAutoHide() {
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer)
      this.autoHideTimer = null
    }
  }

  private registerEscape() {
    if (this.escRegistered) return
    try {
      const ok = globalShortcut.register('Escape', () => {
        this.hide('escape')
      })
      this.escRegistered = ok
    } catch {
      this.escRegistered = false
    }
  }

  private unregisterEscape() {
    if (!this.escRegistered) return
    try {
      globalShortcut.unregister('Escape')
    } catch {
      // Shortcut may already be released by another path; ignore.
    }
    this.escRegistered = false
  }

  private hide(_reason: string) {
    this.clearAutoHide()
    this.unregisterEscape()
    const requestId = this.currentRequestId
    this.currentRequestId = null
    this.currentText = null
    if (requestId !== null) {
      this.deps.overlay.hideSelectionChip(requestId)
    } else {
      this.deps.overlay.hideSelectionChip()
    }
  }
}
