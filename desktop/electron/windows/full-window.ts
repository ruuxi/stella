import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import {
  createShellWindow,
  loadShellRecoveryPage,
  reloadShellMainWindow,
  type ShellWindowDidFailLoadDetails,
} from './shell-window-factory.js'

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
  private window: BrowserWindow | null = null

  constructor(private readonly options: FullWindowControllerOptions) {}

  getWindow() {
    return this.window
  }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const isMac = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined
    const window = createShellWindow({
      mode: 'full',
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      getDevServerUrl: this.options.getDevServerUrl,
      createWindow: () =>
        new BrowserWindow({
          width: 1400,
          height: 940,
          minWidth: 400,
          minHeight: 300,
          frame: isMac,
          titleBarStyle: isMac ? 'hiddenInset' : undefined,
          trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
          ...(isWindows || process.platform === 'linux' ? { frame: false } : {}),
          icon: windowIcon,
          webPreferences: createSharedWebPreferences({
            preloadPath: this.options.preloadPath,
            sessionPartition: this.options.sessionPartition,
          }),
        }),
      setupExternalLinkHandlers: this.options.setupExternalLinkHandlers,
      onDidStartLoading: this.options.onDidStartLoading,
      onRenderProcessGone: this.options.onRenderProcessGone,
      onDidFailLoad: this.options.onDidFailLoad,
      onClosed: () => {
        this.window = null
        this.options.onClosed?.()
      },
    })

    this.window = window

    return window
  }

  loadRecoveryPage() {
    loadShellRecoveryPage(this.window, this.options.electronDir)
  }

  reloadMainWindow() {
    reloadShellMainWindow(this.window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'full',
      getDevServerUrl: this.options.getDevServerUrl,
    })
  }
}
