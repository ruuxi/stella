import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import {
  createShellWindow,
  loadShellRecoveryPage,
  reloadShellMainWindow,
  type ShellWindowDidFailLoadDetails,
  type ShellWindowMode,
} from './shell-window-factory.js'

export type ShellWindowControllerOptions = {
  electronDir: string
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

export type ShellWindowControllerConfig = {
  mode: ShellWindowMode
  createWindow: () => BrowserWindow
  afterCreate?: (window: BrowserWindow) => void
}

export class ShellWindowController {
  private window: BrowserWindow | null = null

  constructor(
    private readonly options: ShellWindowControllerOptions,
    private readonly config: ShellWindowControllerConfig,
  ) {}

  getWindow() {
    return this.window
  }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const window = createShellWindow({
      mode: this.config.mode,
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      getDevServerUrl: this.options.getDevServerUrl,
      createWindow: this.config.createWindow,
      setupExternalLinkHandlers: this.options.setupExternalLinkHandlers,
      onDidStartLoading: this.options.onDidStartLoading,
      onDidFinishLoad: this.options.onDidFinishLoad,
      onRenderProcessGone: this.options.onRenderProcessGone,
      onDidFailLoad: this.options.onDidFailLoad,
      onUnresponsive: this.options.onUnresponsive,
      onResponsive: this.options.onResponsive,
      onClosed: () => {
        this.window = null
        this.options.onClosed?.()
      },
    })

    this.config.afterCreate?.(window)
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
      mode: this.config.mode,
      getDevServerUrl: this.options.getDevServerUrl,
    })
  }

  destroy() {
    if (!this.window || this.window.isDestroyed()) {
      return
    }
    this.window.destroy()
  }
}
