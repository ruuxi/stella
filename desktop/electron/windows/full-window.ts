import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
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
          minWidth: 880,
          minHeight: 620,
          // Transparent + frameless so the renderer can feather the window's
          // edges (fog effect) during onboarding, and round its corners during
          // normal use. On macOS we keep the traffic lights via
          // `titleBarStyle: 'hidden'`, which is compatible with `frame: false`
          // and `transparent: true`.
          frame: !isMac,
          transparent: isMac,
          backgroundColor: isMac ? '#00000000' : '#101016',
          hasShadow: true,
          titleBarStyle: isMac ? 'hidden' : undefined,
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
