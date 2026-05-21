import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
import { FULL_SHELL_MIN_SIZE } from '../layout-constants.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import type { ShellWindowDidFailLoadDetails } from './shell-window-factory.js'
import { ShellWindowController } from './shell-window-controller.js'

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
        const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined

        return new BrowserWindow({
          width: 1400,
          height: 940,
          minWidth: FULL_SHELL_MIN_SIZE.width,
          minHeight: FULL_SHELL_MIN_SIZE.height,
          // Keep the full shell opaque like Codex's primary window. Transparent
          // BrowserWindows are significantly more expensive for macOS to
          // composite during live resize.
          frame: true,
          transparent: false,
          backgroundColor: isMac ? '#f2f4f8' : '#101016',
          hasShadow: true,
          vibrancy: isMac ? 'menu' : undefined,
          visualEffectState: isMac ? 'active' : undefined,
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
