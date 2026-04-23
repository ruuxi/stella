import { BrowserWindow, Menu, screen } from 'electron'
import { MouseHookManager, type LeftMouseUpEvent } from '../input/mouse-hook.js'
import type { ChatContext } from '../../src/shared/contracts/boundary.js'

const RADIAL_CONTEXT_CAPTURE_DELAY_MS = 0

export type StellaMenuAction = 'capture' | 'chat' | 'add'

export type ContextMenuCaptureBridge = {
  cancelRadialContextCapture: () => void
  getChatContextSnapshot: () => ChatContext | null
  setPendingChatContext: (ctx: ChatContext | null) => void
  clearTransientContext: () => void
  setRadialContextShouldCommit: (commit: boolean) => void
  setRadialWindowContextEnabled: (enabled: boolean) => void
  commitStagedRadialContext: (before: ChatContext | null) => void
  hasPendingRadialCapture: () => boolean
  captureRadialContext: (x: number, y: number, before: ChatContext | null) => void
  /** Wait for the in-flight radial capture (if any) to settle. */
  waitForRadialContextSettled: () => Promise<void>
  /** Read the most recent staged window+screenshot from the radial capture. */
  getStagedRadialContext: () => ChatContext | null
  startRegionCapture: () => Promise<{
    screenshot: { dataUrl: string; width: number; height: number } | null
    window: ChatContext['window']
  } | null>
  emptyContext: () => ChatContext
  broadcastChatContext: () => void
}

export type ContextMenuWindowBridge = {
  isCompactMode: () => boolean
  getLastActiveWindowMode: () => 'full' | 'mini'
  isWindowFocused: () => boolean
  showWindow: (target: 'full' | 'mini') => void
  minimizeWindow: () => void
  /** Tells whichever shell window is showing to open its chat sidebar. */
  openChatSidebar: (target: 'mini' | 'full') => void
}

export type SidebarSuggestionChip =
  | {
      kind: 'app'
      pid: number
      name: string
      bundleId?: string
      isActive: boolean
      windowTitle?: string
    }
  | {
      kind: 'tab'
      browser: string
      bundleId: string
      url: string
      title?: string
      host: string
    }

type ContextMenuServiceDeps = {
  shouldEnable: () => boolean
  capture: ContextMenuCaptureBridge
  window: ContextMenuWindowBridge
  updateUiState: (partial: Record<string, unknown>) => void
  /** Send a one-shot suggestion to the renderer's chip strip. */
  pinSidebarSuggestion: (chip: SidebarSuggestionChip) => void
  /**
   * Optional handler for the global "double-tap Option/Alt" gesture. Wired
   * through the same uIOhook lifecycle that powers the context-menu trigger
   * so we don't double-start the input hook.
   */
  onDoubleTapModifier?: () => void
  /**
   * Optional handler for global left-mouse-up events. Wired through the
   * same uIOhook lifecycle so the selection watcher doesn't have to start
   * a second hook (which would clash with this one).
   */
  onLeftMouseUp?: (event: LeftMouseUpEvent) => void
}

/**
 * Convert a captured radial chat context into the sidebar's suggestion-chip
 * shape. Returns null when the capture has nothing user-visible to pin (no
 * window info — e.g. the user's cursor was over the desktop). The renderer
 * picks app vs tab based on whether `browserUrl` is set.
 */
const stagedContextToSidebarSuggestion = (
  staged: ChatContext | null,
): SidebarSuggestionChip | null => {
  if (!staged?.window) return null
  const appName = staged.window.app.trim()
  if (!appName) return null

  const url = staged.browserUrl?.trim()
  if (url) {
    let host = url
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      // Fall through with the raw URL as the host label.
    }
    return {
      kind: 'tab',
      browser: appName,
      bundleId: '',
      url,
      title: staged.window.title || undefined,
      host,
    }
  }

  // App suggestions need a stable identity for the slot reducer; we don't
  // have a real pid for radial captures, so synthesize a stable negative
  // value derived from the app name. The reducer treats two pins of the
  // same app as the same loose-id (refresh, no fade).
  const syntheticPid = -hashAppName(appName)
  return {
    kind: 'app',
    pid: syntheticPid,
    name: appName,
    bundleId: undefined,
    isActive: false,
    windowTitle: staged.window.title || undefined,
  }
}

const hashAppName = (name: string): number => {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return Math.abs(hash) || 1
}

const buildMenuLabels = (
  compactFocused: boolean,
): Array<{ id: StellaMenuAction; label: string }> => [
  { id: 'chat', label: compactFocused ? 'Close chat' : 'Open chat' },
  { id: 'capture', label: 'Capture region' },
  { id: 'add', label: 'Add to context' },
]

/**
 * ContextMenuService handles the global "modifier + right-click" gesture.
 *
 * On Cmd+RightClick (mac) / Ctrl+RightClick (Windows / Linux) the native
 * mouse-block helper drops the click before the OS context menu fires, then
 * we pop a themed Stella quick menu inside the overlay window.
 */
export class ContextMenuService {
  private mouseHook: MouseHookManager | null = null
  private contextBeforeGesture: ChatContext | null = null
  private startedInCompactMode = false
  private inFlight = false
  private readonly deps: ContextMenuServiceDeps
  private scheduledCaptureTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: ContextMenuServiceDeps) {
    this.deps = deps
  }

  start() {
    if (!this.deps.shouldEnable()) {
      this.stop()
      return
    }

    if (this.mouseHook) {
      this.mouseHook.start()
      return
    }

    this.mouseHook = new MouseHookManager({
      onContextMenuTrigger: ({ x, y }) => {
        void this.handleTrigger({ x, y })
      },
      onDoubleTapModifier: this.deps.onDoubleTapModifier
        ? () => {
            this.deps.onDoubleTapModifier?.()
          }
        : undefined,
      onLeftMouseUp: this.deps.onLeftMouseUp
        ? (event) => {
            this.deps.onLeftMouseUp?.(event)
          }
        : undefined,
    })

    this.mouseHook.start()
  }

  stop() {
    this.clearScheduledCapture()
    this.startedInCompactMode = false
    this.contextBeforeGesture = null
    this.inFlight = false
    this.deps.capture.cancelRadialContextCapture()
    if (this.mouseHook) {
      this.mouseHook.stop()
      this.mouseHook = null
    }
  }

  // Stage current chat context, schedule a fresh capture, then pop the
  // native OS menu at the cursor. Electron's Menu.popup() handles
  // open/close/outside-click/selection for us, so we just resolve the
  // chosen action via the click handler and treat "no click" as dismiss.
  private async handleTrigger(point: { x: number; y: number }) {
    if (this.inFlight) {
      // Drop overlapping triggers — the in-flight menu will close on its own
      // when the user clicks anywhere; the next gesture will reopen.
      return
    }
    this.inFlight = true

    const { capture, window: win } = this.deps

    this.startedInCompactMode = win.isCompactMode()
    this.contextBeforeGesture = capture.getChatContextSnapshot()
    capture.setRadialContextShouldCommit(false)
    if (!this.startedInCompactMode && capture.getChatContextSnapshot()) {
      capture.clearTransientContext()
    }

    this.scheduleContextCapture(point)

    const compactFocused = win.isCompactMode() && win.isWindowFocused()
    const labels = buildMenuLabels(compactFocused)

    // Use the OS cursor at popup time (matches what the user sees) instead
    // of the click point reported by the native helper, in case the cursor
    // moved between mousedown and our handler running.
    const cursor = screen.getCursorScreenPoint()
    const action = await this.popupNativeMenu(labels, cursor)

    if (!action) {
      this.handleDismiss()
    } else {
      await this.handleSelection(action)
    }
    this.inFlight = false
  }

  private popupNativeMenu(
    labels: Array<{ id: StellaMenuAction; label: string }>,
    cursor: { x: number; y: number },
  ): Promise<StellaMenuAction | null> {
    return new Promise((resolve) => {
      let resolvedAction: StellaMenuAction | null = null
      const menu = Menu.buildFromTemplate(
        labels.map((item) => ({
          label: item.label,
          click: () => {
            resolvedAction = item.id
          },
        })),
      )
      // Anchor to whichever Stella window is focused, falling back to any
      // visible window. Menu.popup() requires a BrowserWindow and uses it
      // only as a coordinate parent — it does not steal focus to it.
      const anchor =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
        null
      if (!anchor) {
        resolve(null)
        return
      }
      menu.popup({
        window: anchor,
        x: Math.round(cursor.x),
        y: Math.round(cursor.y),
        callback: () => resolve(resolvedAction),
      })
    })
  }

  private scheduleContextCapture(point: { x: number; y: number }) {
    this.clearScheduledCapture()
    const fire = () => {
      this.scheduledCaptureTimer = null
      this.deps.capture.captureRadialContext(
        point.x,
        point.y,
        this.contextBeforeGesture,
      )
    }
    if (RADIAL_CONTEXT_CAPTURE_DELAY_MS <= 0) {
      fire()
      return
    }
    this.scheduledCaptureTimer = setTimeout(fire, RADIAL_CONTEXT_CAPTURE_DELAY_MS)
  }

  private clearScheduledCapture() {
    if (this.scheduledCaptureTimer) {
      clearTimeout(this.scheduledCaptureTimer)
      this.scheduledCaptureTimer = null
    }
  }

  private handleDismiss() {
    this.clearScheduledCapture()
    this.deps.capture.cancelRadialContextCapture()
    this.restoreOrClearTransientContext()
  }

  private restoreOrClearTransientContext() {
    const { capture } = this.deps
    const pendingChatContext = capture.getChatContextSnapshot()
    if (this.startedInCompactMode) {
      if (pendingChatContext !== this.contextBeforeGesture) {
        capture.setPendingChatContext(this.contextBeforeGesture)
      }
      return
    }
    if (pendingChatContext !== null) {
      capture.clearTransientContext()
    }
  }

  private async handleSelection(action: StellaMenuAction) {
    const { capture, window: win, updateUiState } = this.deps

    switch (action) {
      case 'capture': {
        this.clearScheduledCapture()
        capture.setRadialContextShouldCommit(true)
        capture.commitStagedRadialContext(this.contextBeforeGesture)
        capture.cancelRadialContextCapture()
        updateUiState({ mode: 'chat' })
        const targetWindowMode = win.getLastActiveWindowMode()
        win.minimizeWindow()
        const regionCapture = await capture.startRegionCapture()
        if (regionCapture && (regionCapture.screenshot || regionCapture.window)) {
          const ctx = capture.getChatContextSnapshot() ?? capture.emptyContext()
          const existing = ctx.regionScreenshots ?? []
          const nextScreenshots = regionCapture.screenshot
            ? [...existing, regionCapture.screenshot]
            : existing
          const nextWindow = regionCapture.window ?? ctx.window
          capture.setPendingChatContext({
            ...ctx,
            window: nextWindow,
            windowContextEnabled: regionCapture.window ? false : ctx.windowContextEnabled,
            regionScreenshots: nextScreenshots,
          })
          capture.broadcastChatContext()
        }
        // Cancel (Escape / exit without capturing) resolves null; leave the window minimized.
        if (regionCapture !== null) {
          win.showWindow(targetWindowMode)
        }
        break
      }
      case 'chat': {
        // Open the chat sidebar but do NOT attach the staged window context.
        // Instead, surface the captured window as a sidebar SUGGESTION chip
        // — the user clicks it (just like a recent-app suggestion) to
        // attach + capture. Keeps the cmd+rc gesture lightweight.
        this.clearScheduledCapture()

        // Wait for any in-flight radial capture to land so we can pin the
        // exact window the user pointed at, then read the staged context.
        await capture.waitForRadialContextSettled()
        const staged = capture.getStagedRadialContext()
        capture.cancelRadialContextCapture()
        this.restoreOrClearTransientContext()

        const suggestionChip = stagedContextToSidebarSuggestion(staged)
        if (suggestionChip) {
          this.deps.pinSidebarSuggestion(suggestionChip)
        }

        updateUiState({ mode: 'chat' })
        if (win.isCompactMode() && win.isWindowFocused()) {
          win.minimizeWindow()
        } else {
          win.showWindow('mini')
          win.openChatSidebar('mini')
        }
        break
      }
      case 'add': {
        capture.setRadialContextShouldCommit(true)
        capture.commitStagedRadialContext(this.contextBeforeGesture)
        break
      }
    }
  }
}
