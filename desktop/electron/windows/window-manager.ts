import { app, BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'
import { FullWindowController } from './full-window.js'
import {
  attachStoreWebviewGuards,
  isStoreWebviewWebContents,
} from './store-webview.js'
import { getMainLogger } from '../observability/main-logger.js'
import type { ExternalLinkService } from '../services/external-link-service.js'

type WindowManagerOptions = {
  electronDir: string
  preloadPath: string
  storeWebPreloadPath: string
  storeWebBaseUrl: string
  isAllowedStoreWebUrl: (url: string) => boolean
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  externalLinkService: ExternalLinkService
  /**
   * Whether a genuine app quit is in progress. When true, the Windows
   * full-window close handler lets the close proceed instead of diverting
   * it into a minimize-to-tray.
   */
  isQuitting?: () => boolean
  /** Invoked when the Windows full window is hidden to the tray via close. */
  onMinimizeFullToTray?: () => void
}

/**
 * Chromium net error codes for failures that are usually transient, most
 * commonly seen in dev while Vite is cycling.
 */
const TRANSIENT_NET_ERROR_CODES = new Set([
  -3, -7, -21, -100, -101, -102, -103, -104, -105, -106, -118,
])

const isTransientNetError = (errorCode: number) =>
  TRANSIENT_NET_ERROR_CODES.has(errorCode)

const shouldRecoverFromDidFailLoad = (details: {
  errorCode: number
  validatedURL: string
  isMainFrame: boolean
}) => {
  if (!details.isMainFrame) return false
  if (details.validatedURL.includes('recovery.html')) return false
  if (isTransientNetError(details.errorCode)) return false
  return true
}

const TRANSIENT_RELOAD_MAX_ATTEMPTS = 4
const TRANSIENT_RELOAD_BASE_DELAY_MS = 350
const RELOAD_RETRY_RESET_MS = 5_000
const UNRESPONSIVE_RECOVERY_THRESHOLD_MS = 10_000

type TransientReloadState = {
  attempts: number
  lastFailureAtMs: number
  scheduledTimer: ReturnType<typeof setTimeout> | null
}

export class WindowManager {
  private readonly fullWindowController: FullWindowController
  private readonly observedWindows = new WeakSet<BrowserWindow>()
  private transientReloadState: TransientReloadState | null = null
  private unresponsiveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: WindowManagerOptions) {
    this.fullWindowController = new FullWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) =>
        options.externalLinkService.setupExternalLinkHandlers(window),
      onDidFinishLoad: () => {
        this.resetTransientReloadStateOnSuccess()
      },
      onRenderProcessGone: (details) => {
        console.error('Renderer process gone:', details.reason)
        this.cancelUnresponsiveWatchdog()
        this.fullWindowController.loadRecoveryPage()
      },
      onDidFailLoad: (details) => {
        if (this.handleTransientReload(details)) {
          return
        }
        if (!shouldRecoverFromDidFailLoad(details)) {
          return
        }
        console.error(
          'Renderer failed to load:',
          details.errorCode,
          details.errorDescription,
          details.validatedURL,
        )
        this.fullWindowController.loadRecoveryPage()
      },
      onUnresponsive: () => {
        this.armUnresponsiveWatchdog()
      },
      onResponsive: () => {
        this.cancelUnresponsiveWatchdog()
      },
      onClosed: () => {
        this.cancelTransientReload()
        this.cancelUnresponsiveWatchdog()
      },
    })
  }

  private handleTransientReload(details: {
    errorCode: number
    validatedURL: string
    isMainFrame: boolean
  }): boolean {
    if (!details.isMainFrame || !isTransientNetError(details.errorCode)) {
      return false
    }
    if (details.validatedURL.includes('recovery.html')) return false
    if (details.errorCode === -3) return true

    const now = Date.now()
    const previous = this.transientReloadState
    const attemptsSoFar =
      previous && now - previous.lastFailureAtMs < RELOAD_RETRY_RESET_MS
        ? previous.attempts
        : 0
    const nextAttempt = attemptsSoFar + 1

    if (nextAttempt > TRANSIENT_RELOAD_MAX_ATTEMPTS) {
      this.cancelTransientReload()
      return false
    }

    if (previous?.scheduledTimer) {
      clearTimeout(previous.scheduledTimer)
    }

    const delayMs = TRANSIENT_RELOAD_BASE_DELAY_MS * nextAttempt
    console.warn(
      `[reload] full transient ${details.errorCode} on ${details.validatedURL}; retry ${nextAttempt}/${TRANSIENT_RELOAD_MAX_ATTEMPTS} in ${delayMs}ms`,
    )

    const scheduledTimer = setTimeout(() => {
      if (this.transientReloadState) {
        this.transientReloadState.scheduledTimer = null
      }
      this.fullWindowController.reloadMainWindow()
    }, delayMs)

    this.transientReloadState = {
      attempts: nextAttempt,
      lastFailureAtMs: now,
      scheduledTimer,
    }
    return true
  }

  private resetTransientReloadStateOnSuccess() {
    if (this.transientReloadState?.scheduledTimer) {
      clearTimeout(this.transientReloadState.scheduledTimer)
    }
    this.transientReloadState = null
  }

  private cancelTransientReload() {
    if (this.transientReloadState?.scheduledTimer) {
      clearTimeout(this.transientReloadState.scheduledTimer)
    }
    this.transientReloadState = null
  }

  private armUnresponsiveWatchdog() {
    if (this.unresponsiveTimer) return
    console.warn(
      `[unresponsive] renderer stopped responding; recovering in ${UNRESPONSIVE_RECOVERY_THRESHOLD_MS}ms if it doesn't recover`,
    )
    getMainLogger()?.error('main.renderer-unresponsive', {
      mode: 'full',
      recoverInMs: UNRESPONSIVE_RECOVERY_THRESHOLD_MS,
    })
    this.unresponsiveTimer = setTimeout(() => {
      this.unresponsiveTimer = null
      console.error(
        `[unresponsive] renderer still unresponsive after ${UNRESPONSIVE_RECOVERY_THRESHOLD_MS}ms; forcing recovery surface`,
      )
      getMainLogger()?.error('main.renderer-recovery-forced', {
        mode: 'full',
        afterMs: UNRESPONSIVE_RECOVERY_THRESHOLD_MS,
      })
      this.fullWindowController.loadRecoveryPage()
    }, UNRESPONSIVE_RECOVERY_THRESHOLD_MS)
  }

  private cancelUnresponsiveWatchdog() {
    if (!this.unresponsiveTimer) return
    clearTimeout(this.unresponsiveTimer)
    this.unresponsiveTimer = null
  }

  createFullWindow() {
    const window = this.fullWindowController.create()
    this.observeFullWindow(window)
    attachStoreWebviewGuards(window, {
      preloadPath: this.options.storeWebPreloadPath,
      isAllowedUrl: this.options.isAllowedStoreWebUrl,
    })
    return window
  }

  createInitialWindows() {
    this.createFullWindow()
  }

  getFullWindow() {
    return this.fullWindowController.getWindow()
  }

  getAllWindows() {
    return BrowserWindow.getAllWindows()
  }

  getStoreWebEmbedConfig() {
    return {
      baseUrl: this.options.storeWebBaseUrl,
      partition: `${this.options.sessionPartition}:website`,
      preloadUrl: pathToFileURL(this.options.storeWebPreloadPath).toString(),
    }
  }

  isStoreWebViewWebContents(id: number) {
    return isStoreWebviewWebContents(id)
  }

  isWindowFocused() {
    const window = this.getFullWindow()
    return Boolean(window && !window.isDestroyed() && window.isFocused())
  }

  isWindowVisible() {
    const window = this.getFullWindow()
    return Boolean(window && !window.isDestroyed() && window.isVisible())
  }

  minimizeWindow() {
    const window = this.getFullWindow()
    if (!window || window.isDestroyed()) return
    this.hideWindow(window)
  }

  restoreWindowVisibility() {
    const window = this.getFullWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) {
      window.restore()
    }
    if (!window.isVisible()) {
      window.showInactive()
    }
  }

  restoreFullSize() {
    this.showWindow()
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

  private focusAndRaise(window: BrowserWindow) {
    if (process.platform === 'win32') {
      const alreadyForeground = window.isFocused()
      app.focus({ steal: true })
      window.show()
      window.moveTop()
      if (alreadyForeground) {
        window.focus()
      } else {
        window.setAlwaysOnTop(true, 'screen-saver')
        window.focus()
        setTimeout(() => {
          if (!window.isDestroyed()) {
            window.setAlwaysOnTop(false)
          }
        }, 75)
      }
      return
    }

    app.focus({ steal: true })
    window.show()
    window.moveTop()
    window.focus()
  }

  private observeFullWindow(window: BrowserWindow) {
    if (this.observedWindows.has(window)) return
    this.observedWindows.add(window)
    window.on('close', (event) => {
      if (process.platform !== 'win32' || this.options.isQuitting?.()) return
      event.preventDefault()
      this.hideWindow(window)
      this.options.onMinimizeFullToTray?.()
    })
  }

  showWindow() {
    const window = this.createFullWindow()
    if (window.isMinimized()) {
      window.restore()
    }
    this.focusAndRaise(window)
  }

  reloadFullWindow() {
    this.fullWindowController.reloadMainWindow()
  }

  onActivate() {
    if (BrowserWindow.getAllWindows().length === 0) {
      this.createInitialWindows()
      return
    }
    this.showWindow()
  }
}
