import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import {
  createShellWindow,
  loadShellRecoveryPage,
  reloadShellMainWindow,
  type ShellWindowDidFailLoadDetails,
} from './shell-window-factory.js'

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
  onRenderProcessGone?: (details: RenderProcessGoneDetails, window: BrowserWindow) => void
  onDidFailLoad?: (details: ShellWindowDidFailLoadDetails, window: BrowserWindow) => void
  onClosed?: () => void
}

export class MiniWindowController {
  private window: BrowserWindow | null = null

  constructor(private readonly options: MiniWindowControllerOptions) {}

  getWindow() {
    return this.window
  }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const isMac = process.platform === 'darwin'
    const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined
    const window = createShellWindow({
      mode: 'mini',
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      getDevServerUrl: this.options.getDevServerUrl,
      createWindow: () =>
        new BrowserWindow({
          width: MINI_SHELL_SIZE.width,
          height: MINI_SHELL_SIZE.height,
          minWidth: 400,
          minHeight: 300,
          maxWidth: MINI_SHELL_MAX_SIZE.width,
          maxHeight: MINI_SHELL_MAX_SIZE.height,
          show: false,
          frame: false,
          backgroundColor: '#00000000',
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

  reloadMainWindow() {
    reloadShellMainWindow(this.window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'mini',
      getDevServerUrl: this.options.getDevServerUrl,
    })
  }

  loadRecoveryPage() {
    loadShellRecoveryPage(this.window, this.options.electronDir)
  }
}
