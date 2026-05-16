import { app, BrowserWindow, screen } from 'electron'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { FullWindowController } from './full-window.js'
import { MiniWindowController } from './mini-window.js'
import {
  WebsiteViewController,
  type WebsiteViewLayout,
  type WebsiteViewParams,
  type WebsiteViewTheme,
} from './website-view.js'
import type { UiState } from '../types.js'
import type { ExternalLinkService } from '../services/external-link-service.js'

type WindowManagerOptions = {
  electronDir: string
  preloadPath: string
  storeWebPreloadPath: string
  getStoreWebUrl: (params?: WebsiteViewParams) => string
  isAllowedStoreWebUrl: (url: string) => boolean
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  isAppReady: () => boolean
  externalLinkService: ExternalLinkService
  onUpdateUiState: (partial: Partial<UiState>) => void
  onMiniHidden?: () => void
}

const compactSize = MINI_SHELL_SIZE
const MINI_IDLE_DESTROY_DELAY_MS = 5 * 60 * 1000

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

/**
 * Additional grace period after Electron's `'unresponsive'` event fires
 * before we give up and force-load the recovery page. Electron's
 * `'unresponsive'` already has Chromium's hang-monitor delay baked in
 * (~30s of ignored input event pings), so this timer is *additional*
 * slack on top of that — total wall-clock freeze before recovery is
 * roughly hang-monitor + this value. Heavy work in Stella runs in the
 * runtime worker / backend / WebContentsViews, not the renderer's JS
 * main thread, so a renderer that's still frozen this far past the
 * hang-monitor threshold is genuinely stuck (infinite render loop,
 * runaway sync work, pathological compute) and the user deserves an
 * escape hatch instead of a beachball.
 */
const UNRESPONSIVE_RECOVERY_THRESHOLD_MS = 10_000

export class WindowManager {
  private readonly fullWindowController: FullWindowController
  private readonly miniWindowController: MiniWindowController
  private readonly observedWindows = new WeakSet<BrowserWindow>()
  private lastFocusedWindowMode: ShellWindowMode = 'full'
  private lastActiveWindowMode: ShellWindowMode = 'full'
  private miniWindowBounds: Bounds | null = null
  private miniShouldRestoreExternalApp = false
  private miniAlwaysOnTop = true
  private miniIdleDestroyTimer: ReturnType<typeof setTimeout> | null = null
  private readonly websiteViewController: WebsiteViewController
  private readonly transientReloadStateByMode = new Map<
    ShellWindowMode,
    TransientReloadState
  >()
  private readonly unresponsiveTimerByMode = new Map<
    ShellWindowMode,
    ReturnType<typeof setTimeout>
  >()

  constructor(private readonly options: WindowManagerOptions) {
    this.websiteViewController = new WebsiteViewController({
      preloadPath: options.storeWebPreloadPath,
      sessionPartition: `${options.sessionPartition}:website`,
      getUrl: options.getStoreWebUrl,
      isAllowedUrl: options.isAllowedStoreWebUrl,
    })
    this.fullWindowController = new FullWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) =>
        options.externalLinkService.setupExternalLinkHandlers(window),
      onDidFinishLoad: () => {
        this.resetTransientReloadStateOnSuccess('full')
      },
      onRenderProcessGone: (details) => {
        console.error('Renderer process gone:', details.reason)
        this.cancelUnresponsiveWatchdog('full')
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
      onUnresponsive: () => {
        this.armUnresponsiveWatchdog('full', () => {
          this.fullWindowController.loadRecoveryPage()
        })
      },
      onResponsive: () => {
        this.cancelUnresponsiveWatchdog('full')
      },
      onClosed: () => {
        this.cancelTransientReload('full')
        this.cancelUnresponsiveWatchdog('full')
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
      onDidFinishLoad: () => {
        this.resetTransientReloadStateOnSuccess('mini')
      },
      onRenderProcessGone: (details) => {
        console.error('Mini renderer process gone:', details.reason)
        this.cancelUnresponsiveWatchdog('mini')
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
      onUnresponsive: () => {
        this.armUnresponsiveWatchdog('mini', () => {
          this.miniWindowController.loadRecoveryPage()
        })
      },
      onResponsive: () => {
        this.cancelUnresponsiveWatchdog('mini')
      },
      onClosed: () => {
        this.cancelTransientReload('mini')
        this.cancelUnresponsiveWatchdog('mini')
        this.cancelMiniIdleDestroy()
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
   * Clears the retry budget only after a navigation actually finishes
   * loading. Resetting on `did-start-loading` was wrong: the retry timer
   * itself emits `did-start-loading` immediately when it calls
   * `reloadMainWindow`, which would delete the state before the retry's
   * `did-fail-load` arrived — so every failed retry would re-enter at
   * `attempts = 1` and the bounded backoff/recovery-page fallback would
   * never engage. `did-finish-load` is the only signal that means the
   * page actually came up.
   */
  private resetTransientReloadStateOnSuccess(mode: ShellWindowMode) {
    const state = this.transientReloadStateByMode.get(mode)
    if (!state) return
    if (state.scheduledTimer) {
      clearTimeout(state.scheduledTimer)
    }
    this.transientReloadStateByMode.delete(mode)
  }

  private cancelTransientReload(mode: ShellWindowMode) {
    const state = this.transientReloadStateByMode.get(mode)
    if (state?.scheduledTimer) {
      clearTimeout(state.scheduledTimer)
    }
    this.transientReloadStateByMode.delete(mode)
  }

  /**
   * Starts the unresponsive watchdog for a shell window. If the renderer
   * doesn't emit `'responsive'` (or get closed) before the threshold
   * elapses, `forceRecover` runs and the window is force-navigated to
   * the recovery surface. A second `'unresponsive'` while the timer is
   * already armed is a no-op so we don't shorten the window.
   */
  private armUnresponsiveWatchdog(
    mode: ShellWindowMode,
    forceRecover: () => void,
  ) {
    if (this.unresponsiveTimerByMode.has(mode)) return
    console.warn(
      `[unresponsive] ${mode} renderer stopped responding; recovering in ${UNRESPONSIVE_RECOVERY_THRESHOLD_MS}ms if it doesn't recover`,
    )
    const timer = setTimeout(() => {
      this.unresponsiveTimerByMode.delete(mode)
      console.error(
        `[unresponsive] ${mode} renderer still unresponsive after ${UNRESPONSIVE_RECOVERY_THRESHOLD_MS}ms; forcing recovery surface`,
      )
      forceRecover()
    }, UNRESPONSIVE_RECOVERY_THRESHOLD_MS)
    this.unresponsiveTimerByMode.set(mode, timer)
  }

  private cancelUnresponsiveWatchdog(mode: ShellWindowMode) {
    const timer = this.unresponsiveTimerByMode.get(mode)
    if (!timer) return
    clearTimeout(timer)
    this.unresponsiveTimerByMode.delete(mode)
  }

  createFullWindow() {
    const window = this.fullWindowController.create()
    this.observeShellWindow(window, 'full')
    this.websiteViewController.attachResizeTracking(window)
    return window
  }

  private createMiniWindow(initialBounds?: Bounds) {
    this.cancelMiniIdleDestroy()
    const window = this.miniWindowController.create(initialBounds)
    this.observeShellWindow(window, 'mini')
    return window
  }

  createInitialWindows() {
    this.createFullWindow()
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

  showStoreWebView(params?: WebsiteViewParams) {
    const fullWindow = this.getFullWindow() ?? this.createFullWindow()
    this.websiteViewController.show(fullWindow, {
      route: params?.route ?? 'store',
      tab: params?.tab,
      packageId: params?.packageId,
      embedded: params?.embedded,
      theme: params?.theme,
    })
  }

  hideStoreWebView() {
    this.websiteViewController.hide()
  }

  setStoreWebViewLayout(layout: WebsiteViewLayout | null) {
    this.websiteViewController.setLayout(layout)
  }

  setStoreWebViewTheme(theme: WebsiteViewTheme) {
    this.websiteViewController.setTheme(theme)
  }

  goBackInStoreWebView() {
    this.websiteViewController.goBack()
  }

  goForwardInStoreWebView() {
    this.websiteViewController.goForward()
  }

  reloadStoreWebView() {
    this.websiteViewController.reload()
  }

  isStoreWebViewWebContents(id: number) {
    return this.websiteViewController.hasWebContentsId(id)
  }

  isCompactMode() {
    return this.lastActiveWindowMode === 'mini'
  }

  getLastActiveWindowMode() {
    return this.lastActiveWindowMode
  }

  getLastFocusedWindowMode() {
    return this.lastFocusedWindowMode
  }

  isWindowFocused() {
    return this.getFocusedShellWindow() !== null
  }

  isShellWindowVisible(mode: ShellWindowMode) {
    const window = this.getShellWindow(mode)
    return Boolean(window && !window.isDestroyed() && window.isVisible())
  }

  isShellWindowFocused(mode: ShellWindowMode) {
    const window = this.getShellWindow(mode)
    return Boolean(window && !window.isDestroyed() && window.isFocused())
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

    if (!target || target.window.isDestroyed()) return

    if (target.mode === 'mini') {
      // Delegate to the dedicated mini-hide path so macOS gets the
      // `app.hide()` call when the mini was popped from outside the
      // app. Without that, hiding the mini just transfers focus to the
      // next window in the stack — which surfaces the full window even
      // when the user only ever interacted with the mini (the symptom
      // was: option-option closed the mini and brought the main window
      // forward).
      this.hideMiniWindow(false)
      return
    }

    this.hideWindow(target.window)
    this.syncLastActiveWindowMode()
  }

  isMiniShowing() {
    const miniWindow = this.getMiniWindow()
    return Boolean(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible())
  }

  isMiniAlwaysOnTop() {
    return this.miniAlwaysOnTop
  }

  setMiniAlwaysOnTop(enabled: boolean) {
    this.miniAlwaysOnTop = enabled
    const miniWindow = this.getMiniWindow()
    if (!miniWindow || miniWindow.isDestroyed()) return
    if (enabled) {
      miniWindow.setAlwaysOnTop(true, 'screen-saver')
    } else {
      miniWindow.setAlwaysOnTop(false)
    }
  }

  hideMiniWindow(_animate: boolean) {
    const miniWindow = this.getMiniWindow()
    if (!miniWindow || miniWindow.isDestroyed()) return

    const willRestoreExternalApp =
      process.platform === 'darwin' && this.miniShouldRestoreExternalApp

    const fullWindow = this.getFullWindow()
    const fullIsOnScreen = Boolean(
      fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible(),
    )

    // Case A: user popped the mini from outside Stella AND the full
    // window is also visible (e.g., they had Stella full open in the
    // background, then summoned mini from another app). When `mini.hide()`
    // runs, macOS would normally pick the full window as the next key
    // window — visually pulling it to the front. The user doesn't want
    // that; they want focus to fall through to whatever app they were
    // in, with the full window left exactly where it was.
    //
    // Trick: temporarily mark the full window unfocusable so macOS
    // skips it during the post-hide stack walk. With nothing focusable
    // in our process, Stella deactivates and focus returns to the
    // previous external app. We do NOT touch the full window's
    // visibility — its z-order and on-screen state are preserved.
    //
    // The restoration to `setFocusable(true)` is deferred via
    // `setImmediate` so it runs AFTER the synchronous hide + focus
    // transfer have completed; doing it inline races macOS's stack
    // walk and the full window can still get pulled forward.
    if (willRestoreExternalApp && fullIsOnScreen && fullWindow) {
      fullWindow.setFocusable(false)
      this.hideWindow(miniWindow, { preserveExternalFocus: true })
      this.syncLastActiveWindowMode()
      this.scheduleMiniIdleDestroy()
      this.miniShouldRestoreExternalApp = false
      setImmediate(() => {
        if (fullWindow && !fullWindow.isDestroyed()) {
          fullWindow.setFocusable(true)
        }
      })
      return
    }

    this.hideWindow(miniWindow, { preserveExternalFocus: true })
    this.syncLastActiveWindowMode()
    this.scheduleMiniIdleDestroy()

    // Case B: user popped the mini from outside Stella AND the full
    // window isn't on screen. `app.hide()` is safe here (nothing of
    // ours for it to disturb) and is the cleanest way to return focus
    // to the previous app.
    //
    // Case C (the remaining else): the mini was opened from inside
    // Stella (the full window was focused at raise time, so
    // `miniShouldRestoreExternalApp` was false). In that case the
    // user's intent on close is to return to the full window — let
    // macOS do its natural thing and promote full to key. No special
    // handling needed.
    if (willRestoreExternalApp) {
      this.miniShouldRestoreExternalApp = false
      app.hide()
    }
  }

  private cancelMiniIdleDestroy() {
    if (!this.miniIdleDestroyTimer) {
      return
    }
    clearTimeout(this.miniIdleDestroyTimer)
    this.miniIdleDestroyTimer = null
  }

  private scheduleMiniIdleDestroy() {
    this.cancelMiniIdleDestroy()
    this.miniIdleDestroyTimer = setTimeout(() => {
      this.miniIdleDestroyTimer = null
      const miniWindow = this.getMiniWindow()
      if (!miniWindow || miniWindow.isDestroyed() || miniWindow.isVisible()) {
        return
      }
      this.miniWindowController.destroy()
    }, MINI_IDLE_DESTROY_DELAY_MS)
  }

  private observeShellWindow(window: BrowserWindow, mode: ShellWindowMode) {
    if (this.observedWindows.has(window)) {
      return
    }

    this.observedWindows.add(window)
    window.on('focus', () => {
      this.lastFocusedWindowMode = mode
      this.setLastActiveWindowMode(mode)
    })
    window.on('show', () => {
      if (mode === 'mini') {
        this.cancelMiniIdleDestroy()
      }
      this.lastActiveWindowMode = mode
    })
    window.on('hide', () => {
      this.syncLastActiveWindowMode()
      if (mode === 'mini') {
        this.options.onMiniHidden?.()
        this.scheduleMiniIdleDestroy()
      }
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

  restoreWindowVisibility(target: ShellWindowMode) {
    const window = this.getShellWindow(target)
    if (!window || window.isDestroyed()) return

    if (target === 'mini') {
      this.cancelMiniIdleDestroy()
      if (process.platform === 'darwin') {
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        window.setAlwaysOnTop(this.miniAlwaysOnTop, 'screen-saver')
      }
    }

    if (window.isMinimized()) {
      window.restore()
    }
    if (!window.isVisible()) {
      window.showInactive()
    }
    this.setLastActiveWindowMode(target)
  }

  private focusAndRaise(window: BrowserWindow, mode: ShellWindowMode) {
    if (mode === 'mini') {
      if (process.platform === 'darwin') {
        // When the full shell is sitting in its own macOS fullscreen Space,
        // any app-level activation (`app.dock.show()`, `app.focus({ steal })`,
        // or making the panel key via `window.focus()`) makes AppKit
        // re-resolve "the app's frontmost window" against that fullscreen
        // window and either switches Spaces to it or — worse — pulls it
        // out of fullscreen back to the home Space. The mini is an NSPanel
        // at `screen-saver` level with `visibleOnFullScreen: true`, so it
        // can render over the active Space (fullscreen included) without
        // any app activation at all. Take a quiet show-inactive path in
        // that case and skip every activation call.
        const fullIsMacFullscreen = this.isFullWindowMacFullscreen()
        if (fullIsMacFullscreen) {
          window.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
          })
          if (this.miniAlwaysOnTop) {
            window.setAlwaysOnTop(true, 'screen-saver')
          } else {
            window.setAlwaysOnTop(false)
          }
          if (!window.isVisible()) {
            window.showInactive()
          }
          window.moveTop()
          window.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
          })
          if (this.miniAlwaysOnTop) {
            window.setAlwaysOnTop(true, 'screen-saver')
          }
          return
        }

        app.dock?.show()
        // Do not call `app.show()` here. On macOS it unhides every owned
        // BrowserWindow, which can briefly surface the full shell when the
        // user is only restoring the mini (notably after radial capture).
        app.focus({ steal: true })
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        })
        if (this.miniAlwaysOnTop) {
          window.setAlwaysOnTop(true, 'screen-saver')
        } else {
          window.setAlwaysOnTop(false)
        }
        if (!window.isVisible()) {
          window.showInactive()
        } else {
          window.show()
        }
        window.moveTop()
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        })
        if (this.miniAlwaysOnTop) {
          window.setAlwaysOnTop(true, 'screen-saver')
        }
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

      // Compute the destination bounds BEFORE constructing the panel so it
      // materializes in place. If we let `BrowserWindow` cascade-default and
      // then `setBounds` afterwards, macOS panels can paint one frame at the
      // cascade location (forced visible by the `setAlwaysOnTop` /
      // `setVisibleOnAllWorkspaces` calls in mini-window's `afterCreate`)
      // before snapping to the right spot, which surfaces as a visible jump
      // on first summon.
      const targetBounds = this.getPreferredMiniBounds()
      const miniWindow = this.createMiniWindow(targetBounds)
      this.miniShouldRestoreExternalApp =
        process.platform === 'darwin' && this.getFocusedShellWindow() === null

      // The mini and full shells are independent windows; if the full
      // shell happens to be on screen we want to leave it alone and just
      // raise the mini on top. The one wrinkle is macOS: `focusAndRaise`
      // calls `app.show()` to wake the app, and that side-effect un-hides
      // every owned window — so a deliberately-hidden full shell would
      // re-appear behind the mini. Snapshot its visibility before raising
      // the mini and tuck it back down only if it was hidden going in.
      const fullWindow = this.getFullWindow()
      const fullWasHiddenBeforeRaise = Boolean(
        fullWindow && !fullWindow.isDestroyed() && !fullWindow.isVisible(),
      )

      if (miniWindow.isMinimized()) {
        miniWindow.restore()
      }
      // Re-apply bounds for the case where `createMiniWindow` returned an
      // already-existing panel (the constructor's `x`/`y` only takes effect
      // on the first construction). For a fresh panel this is a no-op snap
      // to the same coords we baked in.
      miniWindow.setBounds(targetBounds)

      const raiseMini = () => {
        if (miniWindow.isDestroyed()) return
        this.focusAndRaise(miniWindow, 'mini')
        this.setLastActiveWindowMode('mini')

        if (
          fullWasHiddenBeforeRaise &&
          fullWindow &&
          !fullWindow.isDestroyed() &&
          fullWindow.isVisible()
        ) {
          this.hideWindow(fullWindow, { preserveExternalFocus: true })
        }
      }

      if (miniWindow.webContents.isLoadingMainFrame()) {
        miniWindow.webContents.once('did-finish-load', raiseMini)
        return
      }

      raiseMini()
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
      return
    }

    const miniWindow = this.getMiniWindow()
    const shouldRaiseMini = Boolean(
      miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible(),
    )

    const fullWindow = this.createFullWindow()
    if (fullWindow.isMinimized()) {
      fullWindow.restore()
    }
    this.focusAndRaise(fullWindow, 'full')
    this.setLastActiveWindowMode('full')

    if (shouldRaiseMini && miniWindow && !miniWindow.isDestroyed()) {
      if (miniWindow.isMinimized()) {
        miniWindow.restore()
      }
      this.focusAndRaise(miniWindow, 'mini')
      this.setLastActiveWindowMode('mini')
    }
  }
}
