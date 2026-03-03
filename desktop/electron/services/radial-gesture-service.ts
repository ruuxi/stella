import { screen } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ChatContext } from '../chat-context.js'
import { RADIAL_SIZE } from '../layout-constants.js'
import { MouseHookManager } from '../input/mouse-hook.js'
import { calculateSelectedWedge, type RadialWedge } from '../radial-wedge.js'

export type RadialCaptureBridge = {
  cancelRadialContextCapture: () => void
  getChatContextSnapshot: () => ChatContext | null
  setPendingChatContext: (ctx: ChatContext | null) => void
  clearTransientContext: () => void
  setRadialContextShouldCommit: (commit: boolean) => void
  commitStagedRadialContext: (before: ChatContext | null) => void
  hasPendingRadialCapture: () => boolean
  captureRadialContext: (x: number, y: number, before: ChatContext | null) => void
  startRegionCapture: () => Promise<{
    screenshot: { dataUrl: string; width: number; height: number } | null
    window: ChatContext['window']
  } | null>
  emptyContext: () => ChatContext
  broadcastChatContext: () => void
}

export type RadialOverlayBridge = {
  showModifierBlock: () => void
  hideModifierBlock: () => void
  showRadial: (x: number, y: number) => void
  hideRadial: () => void
  updateRadialCursor: (x: number, y: number) => void
  getRadialBounds: () => { x: number; y: number } | null
}

export type RadialWindowBridge = {
  isMiniShowing: () => boolean
  hasPendingMiniShow: () => boolean
  getMiniWindow: () => BrowserWindow | null
  showWindow: (target: 'full' | 'mini') => void
  hideMiniWindow: (animate: boolean) => void
  concealMiniWindowForCapture: () => boolean
  restoreMiniWindowAfterCapture: () => void
}

type RadialGestureDeps = {
  isAppReady: () => boolean
  capture: RadialCaptureBridge
  overlay: RadialOverlayBridge
  window: RadialWindowBridge
  updateUiState: (partial: Record<string, unknown>) => void
}

export class RadialGestureService {
  private mouseHook: MouseHookManager | null = null
  private selectionCommitted = false
  private startedWithMiniVisible = false
  private contextBeforeGesture: ChatContext | null = null
  private readonly deps: RadialGestureDeps

  constructor(deps: RadialGestureDeps) {
    this.deps = deps
  }

  private async handleSelection(wedge: RadialWedge) {
    const { capture, overlay, window: win, updateUiState } = this.deps

    switch (wedge) {
      case 'dismiss': {
        capture.cancelRadialContextCapture()
        const pendingChatContext = capture.getChatContextSnapshot()
        if (this.startedWithMiniVisible) {
          if (pendingChatContext !== this.contextBeforeGesture) {
            capture.setPendingChatContext(this.contextBeforeGesture)
          }
        } else if (pendingChatContext !== null) {
          capture.clearTransientContext()
        }
        break
      }
      case 'capture': {
        capture.setRadialContextShouldCommit(true)
        capture.commitStagedRadialContext(this.contextBeforeGesture)
        capture.cancelRadialContextCapture()
        updateUiState({ mode: 'chat' })
        overlay.hideRadial()
        overlay.hideModifierBlock()
        const miniWasConcealed = win.concealMiniWindowForCapture()
        const regionCapture = await capture.startRegionCapture()
        if (regionCapture && (regionCapture.screenshot || regionCapture.window)) {
          const ctx = capture.getChatContextSnapshot() ?? capture.emptyContext()
          const existing = ctx.regionScreenshots ?? []
          const nextScreenshots = regionCapture.screenshot
            ? [...existing, regionCapture.screenshot]
            : existing
          capture.setPendingChatContext({
            ...ctx,
            window: regionCapture.window ?? ctx.window,
            regionScreenshots: nextScreenshots,
          })
        }
        if (miniWasConcealed) {
          win.restoreMiniWindowAfterCapture()
        }
        if (!win.isMiniShowing()) {
          win.showWindow('mini')
        } else {
          capture.broadcastChatContext()
        }
        break
      }
      case 'chat':
      case 'auto': {
        if (win.isMiniShowing()) {
          win.hideMiniWindow(true)
        } else {
          capture.setRadialContextShouldCommit(true)
          capture.commitStagedRadialContext(this.contextBeforeGesture)
          updateUiState({ mode: 'chat' })
          win.showWindow('mini')
        }
        break
      }
      case 'voice':
        break
      case 'full':
        capture.cancelRadialContextCapture()
        capture.setPendingChatContext(null)
        win.showWindow('full')
        break
    }
  }

  start() {
    const { isAppReady, capture, overlay, window: win } = this.deps

    this.mouseHook = new MouseHookManager({
      onModifierDown: () => {
        if (process.platform === 'darwin') {
          overlay.showModifierBlock()
        }
      },
      onModifierUp: () => {
        if (
          !win.isMiniShowing() &&
          !win.hasPendingMiniShow() &&
          !capture.hasPendingRadialCapture()
        ) {
          capture.clearTransientContext()
        }
        if (process.platform === 'darwin') {
          if (!this.mouseHook?.isRadialActive()) {
            overlay.hideModifierBlock()
          }
        }
      },
      onLeftClick: () => {
        // Mini shell no longer auto-hides on external click.
      },
      onRadialShow: (x: number, y: number) => {
        if (!isAppReady()) return

        this.startedWithMiniVisible = win.isMiniShowing()
        this.contextBeforeGesture = capture.getChatContextSnapshot()
        capture.setRadialContextShouldCommit(false)

        const miniWindow = win.getMiniWindow()
        if (this.startedWithMiniVisible && miniWindow) {
          miniWindow.webContents.send('mini:dismissPreview')
        }

        if (!this.startedWithMiniVisible && capture.getChatContextSnapshot()) {
          capture.clearTransientContext()
        }

        this.selectionCommitted = false
        overlay.showRadial(x, y)
        overlay.showModifierBlock()
        capture.captureRadialContext(x, y, this.contextBeforeGesture)
      },
      onRadialHide: () => {
        if (!this.selectionCommitted) {
          capture.cancelRadialContextCapture()
          const pendingChatContext = capture.getChatContextSnapshot()
          if (this.startedWithMiniVisible) {
            if (pendingChatContext !== this.contextBeforeGesture) {
              capture.setPendingChatContext(this.contextBeforeGesture)
            }
          } else if (!win.hasPendingMiniShow() && pendingChatContext !== null) {
            capture.clearTransientContext()
          }
        }
        this.selectionCommitted = false
        overlay.hideRadial()
        overlay.hideModifierBlock()
      },
      onMouseMove: (x: number, y: number) => {
        overlay.updateRadialCursor(x, y)
      },
      onMouseUp: (_x: number, _y: number) => {
        const radialBounds = overlay.getRadialBounds()
        if (!radialBounds) {
          return
        }

        // Use Electron's DIP cursor position (uiohook reports physical pixels on Windows)
        const cursorDip = screen.getCursorScreenPoint()
        const relativeX = cursorDip.x - radialBounds.x
        const relativeY = cursorDip.y - radialBounds.y
        const wedge = calculateSelectedWedge(
          relativeX,
          relativeY,
          RADIAL_SIZE / 2,
          RADIAL_SIZE / 2,
        )
        this.selectionCommitted = true
        void this.handleSelection(wedge)
      },
    })

    this.mouseHook.start()
  }

  stop() {
    if (this.mouseHook) {
      this.mouseHook.stop()
      this.mouseHook = null
    }
  }
}
