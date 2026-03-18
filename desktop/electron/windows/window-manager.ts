import { app, BrowserWindow, screen } from 'electron'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { FullWindowController } from './full-window.js'
import type { UiState } from '../types.js'
import type { ExternalLinkService } from '../services/external-link-service.js'
import type { MiniBridgeService } from '../services/mini-bridge-service.js'
import type { OverlayWindowController } from './overlay-window.js'

type ChatContextSyncBridge = {
  getChatContextVersion: () => number
  getLastBroadcastChatContextVersion: () => number
  broadcastChatContext: () => void
  waitForMiniChatContext: (version: number) => Promise<void>
}

type WindowManagerOptions = {
  electronDir: string
  preloadPath: string
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  isAppReady: () => boolean
  isQuitting: () => boolean
  externalLinkService: ExternalLinkService
  miniBridgeService: MiniBridgeService
  chatContextSyncBridge: ChatContextSyncBridge
  onDeactivateVoiceModes: () => void
  onUpdateUiState: (partial: Partial<UiState>) => void
  getOverlayController: () => OverlayWindowController | null
}

const MINI_SHELL_ANIM_MS = 140

const miniSize = MINI_SHELL_SIZE

export class WindowManager {
  private readonly fullWindowController: FullWindowController

  // Mini shell state (now managed via overlay window)
  private miniVisible = false
  private miniConcealedForCapture = false
  private pendingMiniShowTimer: NodeJS.Timeout | null = null
  private miniShowRequestId = 0
  private miniVisibilityEpoch = 0
  private pendingMiniOpacityHideTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: WindowManagerOptions) {
    this.fullWindowController = new FullWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) => options.externalLinkService.setupExternalLinkHandlers(window),
      onDidStartLoading: () => {
        options.miniBridgeService.onFullWindowDidStartLoading()
      },
      onRenderProcessGone: (details) => {
        console.error('Renderer process gone:', details.reason)
        options.miniBridgeService.onFullWindowUnavailable('Full window renderer crashed')
        this.fullWindowController.loadRecoveryPage()
      },
      onClosed: () => {
        options.miniBridgeService.onFullWindowUnavailable('Full window unavailable')
      },
    })
  }

  createFullWindow() {
    return this.fullWindowController.create()
  }

  createInitialWindows() {
    this.createFullWindow()
  }

  getFullWindow() {
    return this.fullWindowController.getWindow()
  }

  /** Returns the overlay window (which now hosts the mini shell). */
  getMiniWindow() {
    return this.options.getOverlayController()?.getWindow() ?? null
  }

  getAllWindows() {
    return BrowserWindow.getAllWindows()
  }

  isMiniShowing() {
    return this.miniVisible
  }

  /** Compute mini shell position near the cursor, clamped to work area. */
  private computeMiniPosition(): { x: number; y: number } {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const wa = display.workArea
    const gap = 16

    let targetX = cursor.x + gap
    let targetY = cursor.y - Math.round(miniSize.height / 3)

    if (targetX + miniSize.width > wa.x + wa.width) {
      targetX = cursor.x - miniSize.width - gap
    }

    targetX = Math.max(wa.x, Math.min(targetX, wa.x + wa.width - miniSize.width))
    targetY = Math.max(wa.y, Math.min(targetY, wa.y + wa.height - miniSize.height))

    return { x: targetX, y: targetY }
  }

  hideMiniWindow(animate = true) {
    const overlay = this.options.getOverlayController()
    if (!overlay) return

    const hideEpoch = ++this.miniVisibilityEpoch
    this.miniVisible = false
    this.miniConcealedForCapture = false

    if (this.pendingMiniOpacityHideTimer) {
      clearTimeout(this.pendingMiniOpacityHideTimer)
      this.pendingMiniOpacityHideTimer = null
    }

    // Send visibility=false to overlay renderer (triggers MiniShell hide animation)
    overlay.getWindow()?.webContents.send('mini:visibility', { visible: false })
    overlay.getWindow()?.setIgnoreMouseEvents(true, { forward: true })
    overlay.getWindow()?.setFocusable(false)

    if (!animate) {
      // Immediately clear mini activity so overlay can hide when idle.
      overlay.hideMini()
      return
    }

    // After the CSS animation completes, fully hide mini in overlay state.
    this.pendingMiniOpacityHideTimer = setTimeout(() => {
      if (hideEpoch !== this.miniVisibilityEpoch) return
      this.pendingMiniOpacityHideTimer = null
      overlay.hideMini()
    }, MINI_SHELL_ANIM_MS)
  }

  hasPendingMiniShow() {
    return Boolean(this.pendingMiniShowTimer)
  }

  cancelPendingShow() {
    if (this.pendingMiniShowTimer) {
      clearTimeout(this.pendingMiniShowTimer)
      this.pendingMiniShowTimer = null
    }
  }

  concealMiniWindowForCapture() {
    if (!this.miniVisible || this.miniConcealedForCapture) {
      return false
    }

    if (this.pendingMiniOpacityHideTimer) {
      clearTimeout(this.pendingMiniOpacityHideTimer)
      this.pendingMiniOpacityHideTimer = null
    }

    this.miniConcealedForCapture = true
    const overlay = this.options.getOverlayController()
    overlay?.concealMiniForCapture()
    return true
  }

  restoreMiniWindowAfterCapture() {
    if (!this.miniVisible || !this.miniConcealedForCapture) {
      return
    }

    this.miniVisibilityEpoch += 1
    this.miniConcealedForCapture = false
    const overlay = this.options.getOverlayController()
    overlay?.restoreMiniAfterCapture()
  }

  showWindow(target: 'full' | 'mini') {
    if (target === 'mini') {
      if (!this.options.isAppReady()) {
        return
      }

      const overlay = this.options.getOverlayController()
      if (!overlay?.getWindow()) return

      if (this.pendingMiniOpacityHideTimer) {
        clearTimeout(this.pendingMiniOpacityHideTimer)
        this.pendingMiniOpacityHideTimer = null
      }
      this.miniVisibilityEpoch += 1

      // If already showing and not concealed, just reposition and refresh context
      if (this.isMiniShowing() && !this.miniConcealedForCapture) {
        const pos = this.computeMiniPosition()
        const bridge = this.options.chatContextSyncBridge
        if (bridge.getLastBroadcastChatContextVersion() !== bridge.getChatContextVersion()) {
          bridge.broadcastChatContext()
        }
        overlay.showMini(pos.x, pos.y)
        overlay.getWindow()?.webContents.send('mini:visibility', { visible: true })
        this.options.onUpdateUiState({ window: 'mini' })
        return
      }

      const requestId = ++this.miniShowRequestId
      const bridge = this.options.chatContextSyncBridge
      if (bridge.getLastBroadcastChatContextVersion() !== bridge.getChatContextVersion()) {
        bridge.broadcastChatContext()
      }

      const pos = this.computeMiniPosition()

      if (this.pendingMiniShowTimer) {
        clearTimeout(this.pendingMiniShowTimer)
      }
      this.pendingMiniShowTimer = setTimeout(() => {
        this.pendingMiniShowTimer = null
        const versionToWait = bridge.getChatContextVersion()
        void (async () => {
          // Hide full window before revealing mini
          this.getFullWindow()?.hide()

          // Position and show the mini shell in the overlay
          overlay.showMini(pos.x, pos.y)

          await bridge.waitForMiniChatContext(versionToWait)

          if (requestId !== this.miniShowRequestId) {
            return
          }

          this.miniVisible = true
          this.miniConcealedForCapture = false
          overlay.getWindow()?.webContents.send('mini:visibility', { visible: true })
          this.options.onUpdateUiState({ window: 'mini' })
        })()
      }, 0)
      return
    }

    // target === 'full'
    this.cancelPendingShow()
    const fullWindow = this.createFullWindow()
    if (fullWindow.isMinimized()) {
      fullWindow.restore()
    }
    if (process.platform === 'win32') {
      app.focus({ steal: true })
      fullWindow.show()
      fullWindow.moveTop()
      fullWindow.setAlwaysOnTop(true, 'screen-saver')
      fullWindow.focus()
      setTimeout(() => {
        if (!fullWindow.isDestroyed()) {
          fullWindow.setAlwaysOnTop(false)
        }
      }, 75)
    } else {
      fullWindow.show()
      fullWindow.focus()
    }

    this.hideMiniWindow(false)
    this.options.onUpdateUiState({ window: 'full', mode: 'chat' })
  }

  reloadFullWindow() {
    this.fullWindowController.reloadMainWindow()
  }

  onActivate() {
    if (BrowserWindow.getAllWindows().length === 0) {
      this.createInitialWindows()
    }
    this.showWindow('full')
  }
}
