import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import path from 'path'
import { resolveAppIconPath } from '../app-icon.js'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { loadWindow } from './window-load.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'

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
  onDidFailLoad?: (
    details: {
      errorCode: number
      errorDescription: string
      validatedURL: string
      isMainFrame: boolean
    },
    window: BrowserWindow,
  ) => void
  onClosed?: () => void
}

export class MiniWindowController {
  private window: BrowserWindow | null = null
  private readonly shouldOpenDevTools = process.env.STELLA_OPEN_DEVTOOLS === '1'

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
    const window = new BrowserWindow({
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
    })

    this.window = window

    this.options.setupExternalLinkHandlers(window)

    if (this.options.isDev && this.shouldOpenDevTools) {
      window.webContents.openDevTools()
    }

    window.webContents.on('did-start-loading', () => {
      this.options.onDidStartLoading?.()
    })

    window.webContents.on('render-process-gone', (_event, details) => {
      this.options.onRenderProcessGone?.(details, window)
    })

    window.webContents.on(
      'did-fail-load',
      (
        _event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      ) => {
        this.options.onDidFailLoad?.(
          {
            errorCode,
            errorDescription,
            validatedURL,
            isMainFrame,
          },
          window,
        )
      },
    )

    window.on('closed', () => {
      this.window = null
      this.options.onClosed?.()
    })

    loadWindow(window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'mini',
      getDevServerUrl: this.options.getDevServerUrl,
    })

    return window
  }

  reloadMainWindow() {
    if (!this.window || this.window.isDestroyed()) {
      return
    }
    loadWindow(this.window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'mini',
      getDevServerUrl: this.options.getDevServerUrl,
    })
  }

  loadRecoveryPage() {
    if (!this.window || this.window.isDestroyed()) {
      return
    }
    this.window.loadFile(path.join(this.options.electronDir, 'recovery.html'))
  }
}
