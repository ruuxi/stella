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

/**
 * Chromium net error codes for failures that are usually transient — most
 * commonly seen in dev when Vite is briefly cycling (HMR config change,
 * dev runner restart) right as the renderer attempts to reload. Recovering
 * to the static recovery surface for these is wrong: the dev server will
 * be back in a few hundred ms and a simple reload of the original URL is
 * the right move.
 *
 * Codes:
 *   -3   ABORTED            (intentional navigation cancellation)
 *   -7   TIMED_OUT
 *   -21  NETWORK_CHANGED
 *   -100 CONNECTION_CLOSED
 *   -101 CONNECTION_RESET
 *   -102 CONNECTION_REFUSED
 *   -103 CONNECTION_ABORTED
 *   -104 CONNECTION_FAILED
 *   -105 NAME_NOT_RESOLVED
 *   -106 INTERNET_DISCONNECTED
 *   -118 CONNECTION_TIMED_OUT
 */
const TRANSIENT_NET_ERROR_CODES = new Set([
  -3,
  -7,
  -21,
  -100,
  -101,
  -102,
  -103,
  -104,
  -105,
  -106,
  -118,
])

const isTransientNetError = (errorCode: number) =>
  TRANSIENT_NET_ERROR_CODES.has(errorCode)

const shouldRecoverFromDidFailLoad = (
  details: {
    errorCode: number
    validatedURL: string
    isMainFrame: boolean
  },
) => {
  if (!details.isMainFrame) return false
  // Avoid recovery loops if recovery.html itself fails to load.
  if (details.validatedURL.includes('recovery.html')) return false
  // Transient failures are handled separately via bounded reload retries —
  // recovery is for genuinely broken renderers (crashed processes, missing
  // bundles), not for "Vite restarted while you held Cmd+Shift+R".
  if (isTransientNetError(details.errorCode)) return false
  return true
}

/**
 * Tracks bounded reload retries per window so a flaky dev server can't
 * either (a) leave the window stranded after one transient failure, or
 * (b) trap us in a tight reload loop if Vite is genuinely down. We retry
 * with linear backoff and surface the recovery page after the cap.
 */
const TRANSIENT_RELOAD_MAX_ATTEMPTS = 4
const TRANSIENT_RELOAD_BASE_DELAY_MS = 350

type TransientReloadState = {
  attempts: number
  lastFailureAtMs: number
  scheduledTimer: ReturnType<typeof setTimeout> | null
}

const RELOAD_RETRY_RESET_MS = 5_000

export class WindowManager {
  private readonly fullWindowController: FullWindowController
  private readonly miniWindowController: MiniWindowController
  private readonly observedWindows = new WeakSet<BrowserWindow>()
  private lastActiveWindowMode: ShellWindowMode = 'full'
  private miniWindowBounds: Bounds | null = null
  private miniShouldRestoreExternalApp = false
  private readonly transientReloadStateByMode = new Map<
    ShellWindowMode,
    TransientReloadState
  >()

  constructor(private readonly options: WindowManagerOptions) {
    this.fullWindowController = new FullWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) =>
        options.externalLinkService.setupExternalLinkHandlers(window),
      onDidStartLoading: () => {
        this.resetTransientReloadStateOnSuccess('full')
      },
      onRenderProcessGone: (details) => {
        console.error('Renderer process gone:', details.reason)
        this.fullWindowController.loadRecoveryPage()
      },
      onDidFailLoad: (details) => {
        if (this.handleTransientReload('full', details)) {
          return
        }
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
        this.cancelTransientReload('full')
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
      onDidStartLoading: () => {
        this.resetTransientReloadStateOnSuccess('mini')
      },
      onRenderProcessGone: (details) => {
        console.error('Mini renderer process gone:', details.reason)
        this.miniWindowController.loadRecoveryPage()
      },
      onDidFailLoad: (details) => {
        if (this.handleTransientReload('mini', details)) {
          return
        }
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
        this.cancelTransientReload('mini')
        this.syncLastActiveWindowMode()
      },
    })
  }

  /**
   * Returns `true` when the failure was a transient connection blip that we
   * absorbed via a delayed reload — caller should bail out of the recovery
   * fall-through path. Returns `false` for terminal failures (e.g. missing
   * bundle, JS parse error in main frame).
   *
   * Bounded by `TRANSIENT_RELOAD_MAX_ATTEMPTS`; each attempt waits a little
   * longer than the previous so we don't hammer a still-restarting Vite.
   */
  private handleTransientReload(
    mode: ShellWindowMode,
    details: { errorCode: number; validatedURL: string; isMainFrame: boolean },
  ): boolean {
    if (!details.isMainFrame) return false
    if (!isTransientNetError(details.errorCode)) return false
    // Recovery loops itself isn't reachable here (already filtered upstream),
    // but be conservative.
    if (details.validatedURL.includes('recovery.html')) return false
    // -3 (ABORTED) is silent on purpose. It usually means the user/system
    // initiated a fresh navigation, so a reload would race or even cancel
    // the new navigation. Just swallow it.
    if (details.errorCode === -3) return true

    const now = Date.now()
    const previous = this.transientReloadStateByMode.get(mode)
    const attemptsSoFar =
      previous && now - previous.lastFailureAtMs < RELOAD_RETRY_RESET_MS
        ? previous.attempts
        : 0
    const nextAttempt = attemptsSoFar + 1

    if (nextAttempt > TRANSIENT_RELOAD_MAX_ATTEMPTS) {
      // Give up on retries; let the caller fall through to recovery.
      this.cancelTransientReload(mode)
      return false
    }

    if (previous?.scheduledTimer) {
      clearTimeout(previous.scheduledTimer)
    }

    const delayMs = TRANSIENT_RELOAD_BASE_DELAY_MS * nextAttempt
    console.warn(
      `[reload] ${mode} transient ${details.errorCode} on ${details.validatedURL}; retry ${nextAttempt}/${TRANSIENT_RELOAD_MAX_ATTEMPTS} in ${delayMs}ms`,
    )

    const scheduledTimer = setTimeout(() => {
      const state = this.transientReloadStateByMode.get(mode)
      if (state) {
        state.scheduledTimer = null
      }
      if (mode === 'full') {
        this.fullWindowController.reloadMainWindow()
      } else {
        this.miniWindowController.reloadMainWindow()
      }
    }, delayMs)

    this.transientReloadStateByMode.set(mode, {
      attempts: nextAttempt,
      lastFailureAtMs: now,
      scheduledTimer,
    })
    return true
  }

  /**
   * `did-start-loading` fires both on the failed attempt AND on the
   * subsequent retry attempt; we only want to clear the budget when a
   * load actually progresses past the initial connect. Realistically,
   * once any new load has begun we can safely consider the previous
   * window of failures resolved — the next failure within the reset
   * window will rebuild the counter.
   */
  private resetTransientReloadStateOnSuccess(mode: ShellWindowMode) {
    const state = this.transientReloadStateByMode.get(mode)
    if (!state) return
    // Don't clear if we're mid-retry (the timer is scheduled but hasn't
    // fired yet) — the start-loading we're observing is the previous
    // attempt's, not the retry's.
    if (state.scheduledTimer) return
    this.transientReloadStateByMode.delete(mode)
  }

  private cancelTransientReload(mode: ShellWindowMode) {
    const state = this.transientReloadStateByMode.get(mode)
    if (state?.scheduledTimer) {
      clearTimeout(state.scheduledTimer)
    }
    this.transientReloadStateByMode.delete(mode)
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

      // Hide the full window first so showing the mini doesn't accidentally
      // also surface a previously-hidden full shell (macOS app.show()
      // unhides every Stella window, and the full window otherwise stays
      // raised behind the mini).
      const fullWindow = this.getFullWindow()
      if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) {
        this.hideWindow(fullWindow, { preserveExternalFocus: true })
      }

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


