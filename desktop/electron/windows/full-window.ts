import { BrowserWindow, screen, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
import { FULL_SHELL_MIN_SIZE } from '../layout-constants.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import type { ShellWindowDidFailLoadDetails } from './shell-window-factory.js'
import { ShellWindowController } from './shell-window-controller.js'

const FULL_SHELL_DEFAULT_SIZE = { width: 1400, height: 940 } as const

/**
 * The default 1400×940 can exceed the usable screen on Windows/Linux, where the
 * taskbar/panel eats into the display. `screen.workArea` already excludes that
 * chrome (and the macOS menu bar), so clamping the initial size to it keeps the
 * bottom of the shell on screen instead of hidden behind the taskbar. We also
 * center within the work area so a clamped window doesn't start flush against an
 * edge. macOS keeps Electron's default centering (no explicit x/y) since the
 * 940px height comfortably fits under the menu bar on supported displays.
 */
const resolveFullWindowInitialBounds = (): {
  width: number
  height: number
  x?: number
  y?: number
} => {
  const { width: dw, height: dh } = FULL_SHELL_DEFAULT_SIZE
  if (process.platform === 'darwin') {
    return { width: dw, height: dh }
  }
  try {
    const workArea = screen.getPrimaryDisplay().workArea
    const width = Math.max(
      FULL_SHELL_MIN_SIZE.width,
      Math.min(dw, workArea.width),
    )
    const height = Math.max(
      FULL_SHELL_MIN_SIZE.height,
      Math.min(dh, workArea.height),
    )
    const x = Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2))
    const y = Math.round(
      workArea.y + Math.max(0, (workArea.height - height) / 2),
    )
    return { width, height, x, y }
  } catch {
    // `screen` can throw if queried before the app is ready; fall back to the
    // raw default rather than block window creation.
    return { width: dw, height: dh }
  }
}

type FullWindowControllerOptions = {
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

export class FullWindowController {
  private readonly controller: ShellWindowController

  constructor(private readonly options: FullWindowControllerOptions) {
    this.controller = new ShellWindowController(options, {
      mode: 'full',
      createWindow: () => {
        const isMac = process.platform === 'darwin'
        const useNativeVibrancy = isMac && process.env.STELLA_STATIC_PREVIEW !== '1'
        const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined
        const initialBounds = resolveFullWindowInitialBounds()

        return new BrowserWindow({
          width: initialBounds.width,
          height: initialBounds.height,
          x: initialBounds.x,
          y: initialBounds.y,
          minWidth: FULL_SHELL_MIN_SIZE.width,
          minHeight: FULL_SHELL_MIN_SIZE.height,
          // Keep the full shell opaque. Transparent BrowserWindows are
          // significantly more expensive for macOS to composite during live
          // resize.
          // Windows: frameless so Stella's custom top bar provides the only
          // chrome (custom min/max/close live in `ShellTopBar`). macOS keeps
          // the native frame because traffic lights are hidden-inset under it.
          frame: process.platform !== 'win32',
          transparent: false,
          backgroundColor: isMac ? '#f2f4f8' : '#101016',
          hasShadow: true,
          vibrancy: useNativeVibrancy ? 'menu' : undefined,
          visualEffectState: useNativeVibrancy ? 'active' : undefined,
          titleBarStyle: isMac ? 'hiddenInset' : undefined,
          trafficLightPosition: isMac ? { x: 16, y: 13 } : undefined,
          icon: windowIcon,
          webPreferences: createSharedWebPreferences({
            preloadPath: this.options.preloadPath,
            sessionPartition: this.options.sessionPartition,
          }),
        })
      },
    })
  }

  getWindow() {
    return this.controller.getWindow()
  }

  create() {
    return this.controller.create()
  }

  loadRecoveryPage() {
    this.controller.loadRecoveryPage()
  }

  reloadMainWindow() {
    this.controller.reloadMainWindow()
  }
}
