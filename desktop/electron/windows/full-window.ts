import { BrowserWindow, nativeTheme, type RenderProcessGoneDetails } from 'electron'
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
  onRenderProcessGone?: (details: RenderProcessGoneDetails, window: BrowserWindow) => void
  onDidFailLoad?: (details: ShellWindowDidFailLoadDetails, window: BrowserWindow) => void
  onClosed?: () => void
}

export class FullWindowController {
  private readonly controller: ShellWindowController

  constructor(private readonly options: FullWindowControllerOptions) {
    this.controller = new ShellWindowController(options, {
      mode: 'full',
      createWindow: () => {
        const isMac = process.platform === 'darwin'
        const isWindows = process.platform === 'win32'
        const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined

        return new BrowserWindow({
          width: 1400,
          height: 940,
          minWidth: 400,
          minHeight: 300,
          frame: isMac,
          titleBarStyle: isMac ? 'hiddenInset' : undefined,
          trafficLightPosition: isMac ? { x: 16, y: 13 } : undefined,
          ...(isWindows || process.platform === 'linux' ? { frame: false } : {}),
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#f2f4f8',
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
