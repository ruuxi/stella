import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
import {
  MINI_SHELL_MAX_SIZE,
  MINI_SHELL_MIN_SIZE,
  MINI_SHELL_SIZE,
} from '../layout-constants.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import type { ShellWindowDidFailLoadDetails } from './shell-window-factory.js'
import { ShellWindowController } from './shell-window-controller.js'

type MiniWindowControllerOptions = {
  electronDir: string
  preloadPath: string
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  setupExternalLinkHandlers: (window: BrowserWindow) => void
  onDidStartLoading?: () => void
  onDidFinishLoad?: () => void
  onRenderProcessGone?: (details: RenderProcessGoneDetails, window: BrowserWindow) => void
  onDidFailLoad?: (details: ShellWindowDidFailLoadDetails, window: BrowserWindow) => void
  onUnresponsive?: (window: BrowserWindow) => void
  onResponsive?: (window: BrowserWindow) => void
  onClosed?: () => void
}

export type MiniWindowInitialBounds = {
  x: number
  y: number
  width: number
  height: number
}

export class MiniWindowController {
  private readonly controller: ShellWindowController
  /**
   * Bounds to bake into the next `BrowserWindow` construction. Set by
   * `WindowManager.showWindow("mini")` immediately before `create()` so the
   * NSPanel materializes at the final position — without this, AppKit picks a
   * cascade default and `afterCreate`'s `setAlwaysOnTop`/`setVisibleOnAllWorkspaces`
   * can paint one frame there before our post-construct `setBounds` snaps it
   * over, which surfaces as a visible jump on first summon.
   */
  private nextInitialBounds: MiniWindowInitialBounds | null = null

  constructor(private readonly options: MiniWindowControllerOptions) {
    this.controller = new ShellWindowController(options, {
      mode: 'mini',
      createWindow: () => {
        const isMac = process.platform === 'darwin'
        const useNativeVibrancy = isMac && process.env.STELLA_STATIC_PREVIEW !== '1'
        const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined
        const initial = this.nextInitialBounds

        return new BrowserWindow({
          x: initial?.x,
          y: initial?.y,
          width: initial?.width ?? MINI_SHELL_SIZE.width,
          height: initial?.height ?? MINI_SHELL_SIZE.height,
          minWidth: MINI_SHELL_MIN_SIZE.width,
          minHeight: MINI_SHELL_MIN_SIZE.height,
          maxWidth: MINI_SHELL_MAX_SIZE.width,
          maxHeight: MINI_SHELL_MAX_SIZE.height,
          ...(isMac ? { type: 'panel' as const } : {}),
          show: false,
          frame: process.platform !== 'win32',
          transparent: false,
          vibrancy: useNativeVibrancy ? 'menu' : undefined,
          visualEffectState: useNativeVibrancy ? 'active' : undefined,
          titleBarStyle: isMac ? 'hiddenInset' : undefined,
          trafficLightPosition: isMac ? { x: 16, y: 13 } : undefined,
          fullscreenable: false,
          backgroundColor: isMac ? '#f2f4f8' : '#101016',
          ...(isMac ? { hiddenInMissionControl: true } : {}),
          icon: windowIcon,
          webPreferences: createSharedWebPreferences({
            preloadPath: this.options.preloadPath,
            sessionPartition: this.options.sessionPartition,
          }),
        })
      },
      afterCreate: (window) => {
        if (process.platform === 'win32') {
          // The mini window's whole purpose is to float above other apps.
          // Without this it materializes as a plain window that Windows tucks
          // behind whatever app currently owns the foreground, so the user
          // either sees nothing or has to click the taskbar button to raise
          // it. `WindowManager` re-applies the user's always-on-top
          // preference on every show; this just seeds the correct state at
          // construction so the first summon already floats.
          window.setAlwaysOnTop(true, 'screen-saver')
          return
        }
        if (process.platform !== 'darwin') return
        // `skipTransformProcessType: true` is critical here. Without it,
        // Electron calls `TransformProcessType` on NSApplication to normalize
        // the app's process type before applying the all-Spaces collection
        // behavior — and `TransformProcessType` is the macOS API that yanks
        // a fullscreen window out of its own Space back to the home Space.
        // On the very first lazy construction of the mini panel that surfaced
        // as: user is in their fullscreen full shell, opens the mini, and
        // macOS rips the full shell out of fullscreen. The overlay panel
        // already passes this flag for the same reason; the mini was the
        // only screen-saver-level panel still on the slow path.
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        })
        window.setAlwaysOnTop(true, 'screen-saver')
      },
    })
  }

  getWindow() {
    return this.controller.getWindow()
  }

  create(initialBounds?: MiniWindowInitialBounds) {
    this.nextInitialBounds = initialBounds ?? null
    try {
      return this.controller.create()
    } finally {
      this.nextInitialBounds = null
    }
  }

  reloadMainWindow() {
    this.controller.reloadMainWindow()
  }

  loadRecoveryPage() {
    this.controller.loadRecoveryPage()
  }

  destroy() {
    this.controller.destroy()
  }
}
