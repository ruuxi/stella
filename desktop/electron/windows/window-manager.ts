import { app, BrowserWindow, screen } from 'electron'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { FullWindowController } from './full-window.js'
import { MiniWindowController } from './mini-window.js'
import type { UiState } from '../types.js'
import type { ExternalLinkService } from '../services/external-link-service.js'

type WindowManagerOptions = {
  electronDir: string
  preloadPath: string
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  isAppReady: () => boolean
  externalLinkService: ExternalLinkService
  onUpdateUiState: (partial: Partial<UiState>) => void
}

const compactSize = MINI_SHELL_SIZE

type Bounds = { x: number; y: number; width: number; height: number }
type ShellWindowMode = 'full' | 'mini'
type ShellWindowRef = { mode: ShellWindowMode; window: BrowserWindow }

const shouldRecoverFromDidFailLoad = (
  details: {
    errorCode: number
    validatedURL: string
    isMainFrame: boolean
  },
) => {
  if (!details.isMainFrame) return false
  // Ignore intentional navigation cancellation.
  if (details.errorCode === -3) return false
  // Avoid recovery loops if recovery.html itself fails to load.
  if (details.validatedURL.includes('recovery.html')) return false
  return true
}

export class WindowManager {
  private readonly fullWindowController: FullWindowController
  private readonly miniWindowController: MiniWindowController
  private readonly observedWindows = new WeakSet<BrowserWindow>()
  private lastActiveWindowMode: ShellWindowMode = 'full'
  private miniWindowBounds: Bounds | null = null
  private miniShouldRestoreExternalApp = false

  constructor(private readonly options: WindowManagerOptions) {
    this.fullWindowController = new FullWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) =>
        options.externalLinkService.setupExternalLinkHandlers(window),
      onDidStartLoading: () => {},
      onRenderProcessGone: (details) => {
        console.error('Renderer process gone:', details.reason)
        this.fullWindowController.loadRecoveryPage()
      },
      onDidFailLoad: (details) => {
        if (!shouldRecoverFromDidFailLoad(details)) {
          return
        }
        console.error(
          'Full renderer failed to load:',
          details.errorCode,
          details.errorDescription,
          details.validatedURL,
        )
        this.fullWindowController.loadRecoveryPage()
      },
      onClosed: () => {
        this.syncLastActiveWindowMode()
      },
    })
    this.miniWindowController = new MiniWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) =>
        options.externalLinkService.setupExternalLinkHandlers(window),
      onDidStartLoading: () => {},
      onRenderProcessGone: (details) => {
        console.error('Mini renderer process gone:', details.reason)
        this.miniWindowController.loadRecoveryPage()
      },
      onDidFailLoad: (details) => {
        if (!shouldRecoverFromDidFailLoad(details)) {
          return
        }
        console.error(
          'Mini renderer failed to load:',
          details.errorCode,
          details.errorDescription,
          details.validatedURL,
        )
        this.miniWindowController.loadRecoveryPage()
      },
      onClosed: () => {
        this.syncLastActiveWindowMode()
      },
    })
  }

  createFullWindow() {
    const window = this.fullWindowController.create()
    this.observeShellWindow(window, 'full')
    return window
  }

  private createMiniWindow() {
    const window = this.miniWindowController.create()
    this.observeShellWindow(window, 'mini')
    return window
  }

  createInitialWindows() {
    this.createFullWindow()
    this.createMiniWindow()
  }

  getFullWindow() {
    return this.fullWindowController.getWindow()
  }

  getMiniWindow(): BrowserWindow | null {
    return this.miniWindowController.getWindow()
  }

  getAllWindows() {
    return BrowserWindow.getAllWindows()
  }

  isCompactMode() {
    return this.lastActiveWindowMode === 'mini'
  }

  getLastActiveWindowMode() {
    return this.lastActiveWindowMode
  }

  isWindowFocused() {
    return this.getFocusedShellWindow() !== null
  }

  isFullWindowMacFullscreen() {
    if (process.platform !== 'darwin') {
      return false
    }

    const fullWindow = this.getFullWindow()
    return Boolean(fullWindow && !fullWindow.isDestroyed() && fullWindow.isFullScreen())
  }

  minimizeWindow() {
    const target =
      this.getFocusedShellWindow() ??
      this.getVisibleShellWindow(this.lastActiveWindowMode) ??
      this.getVisibleShellWindow(this.getOtherWindowMode(this.lastActiveWindowMode))

    if (target && !target.window.isDestroyed()) {
      this.hideWindow(target.window, {
        preserveExternalFocus: target.mode === 'mini',
      })
      this.syncLastActiveWindowMode()
    }
  }

  isMiniShowing() {
    const miniWindow = this.getMiniWindow()
    return Boolean(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible())
  }

  hideMiniWindow(_animate: boolean) {
    const miniWindow = this.getMiniWindow()
    if (!miniWindow || miniWindow.isDestroyed()) return
    this.hideWindow(miniWindow, { preserveExternalFocus: true })
    this.syncLastActiveWindowMode()
    if (process.platform === 'darwin' && this.miniShouldRestoreExternalApp) {
      this.miniShouldRestoreExternalApp = false
      app.hide()
    }
  }

  private observeShellWindow(window: BrowserWindow, mode: ShellWindowMode) {
    if (this.observedWindows.has(window)) {
      return
    }

    this.observedWindows.add(window)
    window.on('focus', () => {
      this.setLastActiveWindowMode(mode)
    })
    window.on('show', () => {
      this.lastActiveWindowMode = mode
    })
    window.on('hide', () => {
      this.syncLastActiveWindowMode()
    })

    if (mode === 'mini') {
      const rememberBounds = () => {
        if (window.isDestroyed()) return
        const { x, y, width, height } = window.getBounds()
        this.miniWindowBounds = { x, y, width, height }
      }

      window.on('move', rememberBounds)
      window.on('resize', rememberBounds)
    }
  }

  private getOtherWindowMode(mode: ShellWindowMode): ShellWindowMode {
    return mode === 'mini' ? 'full' : 'mini'
  }

  private getShellWindow(mode: ShellWindowMode): BrowserWindow | null {
    return mode === 'mini' ? this.getMiniWindow() : this.getFullWindow()
  }

  private getFocusedShellWindow(): ShellWindowRef | null {
    const miniWindow = this.getMiniWindow()
    if (miniWindow && !miniWindow.isDestroyed() && miniWindow.isFocused()) {
      return { mode: 'mini', window: miniWindow }
    }

    const fullWindow = this.getFullWindow()
    if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isFocused()) {
      return { mode: 'full', window: fullWindow }
    }

    return null
  }

  private getVisibleShellWindow(mode: ShellWindowMode): ShellWindowRef | null {
    const window = this.getShellWindow(mode)
    if (!window || window.isDestroyed() || !window.isVisible()) {
      return null
    }
    return { mode, window }
  }

  private setLastActiveWindowMode(mode: ShellWindowMode) {
    this.lastActiveWindowMode = mode
    this.options.onUpdateUiState({ window: mode })
  }

  private syncLastActiveWindowMode() {
    const focused = this.getFocusedShellWindow()
    if (focused) {
      this.setLastActiveWindowMode(focused.mode)
      return
    }

    if (this.getVisibleShellWindow(this.lastActiveWindowMode)) {
      return
    }

    const fallback = this.getVisibleShellWindow(
      this.getOtherWindowMode(this.lastActiveWindowMode),
    )
    if (fallback) {
      this.setLastActiveWindowMode(fallback.mode)
      return
    }

    if (this.lastActiveWindowMode === 'mini') {
      this.setLastActiveWindowMode('full')
    }
  }

  private computeCompactPosition(): { x: number; y: number } {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const wa = display.workArea
    const gap = 16

    let targetX = wa.x + wa.width - compactSize.width - gap
    let targetY = wa.y + Math.round((wa.height - compactSize.height) / 2)

    targetX = Math.max(
      wa.x,
      Math.min(targetX, wa.x + wa.width - compactSize.width),
    )
    targetY = Math.max(
      wa.y,
      Math.min(targetY, wa.y + wa.height - compactSize.height),
    )

    return { x: targetX, y: targetY }
  }

  private getPreferredMiniBounds(): Bounds {
    if (this.miniWindowBounds) {
      return this.miniWindowBounds
    }

    const pos = this.computeCompactPosition()
    return {
      x: pos.x,
      y: pos.y,
      width: compactSize.width,
      height: compactSize.height,
    }
  }

  private hideWindow(
    window: BrowserWindow,
    options?: { preserveExternalFocus?: boolean },
  ) {
    const preserveExternalFocus = options?.preserveExternalFocus ?? false
    const wasFocused = preserveExternalFocus && window.isFocused()

    if (wasFocused) {
      window.blur()
      window.setFocusable(false)
    }

    window.hide()

    if (wasFocused && !window.isDestroyed()) {
      window.setFocusable(true)
    }
  }

  restoreFullSize() {
    this.showWindow('full')
  }

  private focusAndRaise(window: BrowserWindow, mode: ShellWindowMode) {
    if (mode === 'mini') {
      if (process.platform === 'darwin') {
        if (app.isHidden()) {
          app.show()
        }
        app.focus({ steal: true })
        window.show()
        window.moveTop()
        window.setAlwaysOnTop(true, 'screen-saver')
        window.focus()
        setTimeout(() => {
          if (!window.isDestroyed()) {
            window.setAlwaysOnTop(false)
          }
        }, 75)
        return
      }

      app.focus({ steal: true })
      window.show()
      window.moveTop()
      window.focus()
      return
    }

    if (process.platform === 'win32') {
      app.focus({ steal: true })
      window.show()
      window.moveTop()
      window.setAlwaysOnTop(true, 'screen-saver')
      window.focus()
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(false)
        }
      }, 75)
    } else {
      app.focus({ steal: true })
      window.show()
      window.moveTop()
      window.focus()
    }
  }

  showWindow(target: ShellWindowMode) {
    if (target === 'mini') {
      if (!this.options.isAppReady()) return

      const miniWindow = this.createMiniWindow()
      const targetBounds = this.getPreferredMiniBounds()
      this.miniShouldRestoreExternalApp =
        process.platform === 'darwin' && this.getFocusedShellWindow() === null

      if (miniWindow.isMinimized()) {
        miniWindow.restore()
      }
      miniWindow.setBounds(targetBounds)
      this.focusAndRaise(miniWindow, 'mini')
      this.setLastActiveWindowMode('mini')
      return
    }

    const fullWindow = this.createFullWindow()
    if (this.isMiniShowing()) {
      this.miniShouldRestoreExternalApp = false
      this.hideMiniWindow(false)
    }
    if (fullWindow.isMinimized()) {
      fullWindow.restore()
    }
    this.focusAndRaise(fullWindow, 'full')
    this.setLastActiveWindowMode('full')
  }

  reloadFullWindow() {
    this.fullWindowController.reloadMainWindow()
    this.miniWindowController.reloadMainWindow()
  }

  onActivate() {
    if (BrowserWindow.getAllWindows().length === 0) {
      this.createInitialWindows()
    }
    this.showWindow(this.lastActiveWindowMode)
  }
}


