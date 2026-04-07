import { app, BrowserWindow, screen } from 'electron'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { FullWindowController } from './full-window.js'
import type { UiState } from '../types.js'
import type { ExternalLinkService } from '../services/external-link-service.js'
import type { OverlayWindowController } from './overlay-window.js'

type WindowManagerOptions = {
  electronDir: string
  preloadPath: string
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  isAppReady: () => boolean
  isQuitting: () => boolean
  externalLinkService: ExternalLinkService
  onDeactivateVoiceModes: () => void
  onUpdateUiState: (partial: Partial<UiState>) => void
  getOverlayController: () => OverlayWindowController | null
}

const compactSize = MINI_SHELL_SIZE

const FADE_OUT_MS = 120
const FADE_IN_MS = 150
const FADE_STEP_MS = 10

type Bounds = { x: number; y: number; width: number; height: number }

export class WindowManager {
  private readonly fullWindowController: FullWindowController

  private compactMode = false
  private lastActiveWindowMode: 'full' | 'mini' = 'full'
  private savedBounds: Bounds | null = null
  private fadeTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: WindowManagerOptions) {
    this.fullWindowController = new FullWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) => options.externalLinkService.setupExternalLinkHandlers(window),
      onDidStartLoading: () => {},
      onRenderProcessGone: (details) => {
        console.error('Renderer process gone:', details.reason)
        this.fullWindowController.loadRecoveryPage()
      },
      onClosed: () => {},
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

  getMiniWindow(): BrowserWindow | null {
    return null
  }

  getAllWindows() {
    return BrowserWindow.getAllWindows()
  }

  isCompactMode() {
    return this.compactMode
  }

  getLastActiveWindowMode() {
    return this.lastActiveWindowMode
  }

  isWindowFocused() {
    const fullWindow = this.getFullWindow()
    return fullWindow ? fullWindow.isFocused() : false
  }

  minimizeWindow() {
    const fullWindow = this.getFullWindow()
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.hide()
    }
  }

  isMiniShowing() {
    return this.compactMode
  }

  hasPendingMiniShow() {
    return false
  }

  hideMiniWindow(_animate: boolean) {
    this.restoreFullSize()
  }

  cancelPendingShow() {}

  concealMiniWindowForCapture() {
    return false
  }

  restoreMiniWindowAfterCapture() {}

  private cancelFade() {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }
  }

  private fadeTransition(win: Electron.BrowserWindow, to: Bounds, onSnap?: () => void) {
    this.cancelFade()
    if (win.isDestroyed()) return

    const start = Date.now()
    win.setOpacity(1)

    this.fadeTimer = setInterval(() => {
      if (win.isDestroyed()) { this.cancelFade(); return }
      const elapsed = Date.now() - start
      const t = Math.min(elapsed / FADE_OUT_MS, 1)
      win.setOpacity(1 - t)

      if (t >= 1) {
        this.cancelFade()
        win.setBounds(to)
        onSnap?.()

        const fadeInStart = Date.now()
        this.fadeTimer = setInterval(() => {
          if (win.isDestroyed()) { this.cancelFade(); return }
          const fadeElapsed = Date.now() - fadeInStart
          const ft = Math.min(fadeElapsed / FADE_IN_MS, 1)
          win.setOpacity(ft)
          if (ft >= 1) { this.cancelFade() }
        }, FADE_STEP_MS)
      }
    }, FADE_STEP_MS)
  }

  private computeCompactPosition(): { x: number; y: number } {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const wa = display.workArea
    const gap = 16

    let targetX = cursor.x + gap
    let targetY = cursor.y - Math.round(compactSize.height / 3)

    if (targetX + compactSize.width > wa.x + wa.width) {
      targetX = cursor.x - compactSize.width - gap
    }

    targetX = Math.max(wa.x, Math.min(targetX, wa.x + wa.width - compactSize.width))
    targetY = Math.max(wa.y, Math.min(targetY, wa.y + wa.height - compactSize.height))

    return { x: targetX, y: targetY }
  }

  restoreFullSize() {
    if (!this.compactMode) return

    this.compactMode = false
    this.lastActiveWindowMode = 'full'
    const fullWindow = this.getFullWindow()
    if (!fullWindow || fullWindow.isDestroyed()) return

    if (this.savedBounds) {
      const target = this.savedBounds
      this.savedBounds = null
      if (fullWindow.isVisible()) {
        this.fadeTransition(fullWindow, target)
      } else {
        fullWindow.setBounds(target)
      }
    }

    this.options.onUpdateUiState({ window: 'full' })
  }

  private focusAndRaise(fullWindow: Electron.BrowserWindow) {
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
      app.show()
      app.focus({ steal: true })
      fullWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      fullWindow.show()
      fullWindow.moveTop()
      fullWindow.setAlwaysOnTop(true, 'screen-saver')
      fullWindow.focus()
      setTimeout(() => {
        if (!fullWindow.isDestroyed()) {
          fullWindow.setAlwaysOnTop(false)
          fullWindow.setVisibleOnAllWorkspaces(false)
        }
      }, 75)
    }
  }

  showWindow(target: 'full' | 'mini') {
    if (target === 'mini') {
      if (!this.options.isAppReady()) return

      const fullWindow = this.createFullWindow()

      if (!this.compactMode) {
        this.savedBounds = fullWindow.getBounds()
      }

      this.compactMode = true
      this.lastActiveWindowMode = 'mini'

      const pos = this.computeCompactPosition()
      const targetBounds = {
        x: pos.x,
        y: pos.y,
        width: compactSize.width,
        height: compactSize.height,
      }

      if (fullWindow.isVisible()) {
        this.fadeTransition(fullWindow, targetBounds, () => {
          this.focusAndRaise(fullWindow)
        })
      } else {
        fullWindow.setOpacity(0)
        fullWindow.setBounds(targetBounds)
        this.focusAndRaise(fullWindow)
        setTimeout(() => {
          if (!fullWindow.isDestroyed()) fullWindow.setOpacity(1)
        }, 50)
      }

      this.options.onUpdateUiState({ window: 'mini', mode: 'chat' })
      return
    }

    // target === 'full'
    if (this.compactMode) {
      this.restoreFullSize()
    }

    const fullWindow = this.createFullWindow()
    this.lastActiveWindowMode = 'full'
    if (fullWindow.isMinimized()) {
      fullWindow.restore()
    }
    this.focusAndRaise(fullWindow)
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
