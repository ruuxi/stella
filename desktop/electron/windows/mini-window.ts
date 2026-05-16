import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import type { ShellWindowDidFailLoadDetails } from './shell-window-factory.js'
import { ShellWindowController } from './shell-window-controller.js'

const MINI_SHELL_MAX_SIZE = {
  width: 500,
  height: 900,
} as const

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
        const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined
        const initial = this.nextInitialBounds

        return new BrowserWindow({
          x: initial?.x,
          y: initial?.y,
          width: initial?.width ?? MINI_SHELL_SIZE.width,
          height: initial?.height ?? MINI_SHELL_SIZE.height,
          minWidth: 420,
          minHeight: 560,
          maxWidth: MINI_SHELL_MAX_SIZE.width,
          maxHeight: MINI_SHELL_MAX_SIZE.height,
          ...(isMac ? { type: 'panel' as const } : {}),
          show: false,
          frame: !isMac,
          transparent: isMac,
          titleBarStyle: isMac ? 'hidden' : undefined,
          trafficLightPosition: isMac ? { x: 16, y: 13 } : undefined,
          fullscreenable: false,
          backgroundColor: isMac ? '#00000000' : '#101016',
          ...(isMac ? { hiddenInMissionControl: true } : {}),
          icon: windowIcon,
          webPreferences: createSharedWebPreferences({
            preloadPath: this.options.preloadPath,
            sessionPartition: this.options.sessionPartition,
          }),
        })
      },
      afterCreate: (window) => {
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
