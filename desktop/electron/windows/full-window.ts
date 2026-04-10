import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import path from 'path'
import { resolveAppIconPath } from '../app-icon.js'
import { loadWindow } from './window-load.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'

type FullWindowControllerOptions = {
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

export class FullWindowController {
  private window: BrowserWindow | null = null
  private lastBounds: Electron.Rectangle | null = null
  private readonly shouldOpenDevTools = process.env.STELLA_OPEN_DEVTOOLS === '1'

  constructor(private readonly options: FullWindowControllerOptions) {}

  getWindow() {
    return this.window
  }

  getLastBounds() {
    return this.lastBounds
  }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const isMac = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
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
    })

    this.window = window
    this.lastBounds = window.getBounds()

    window.on('resize', () => {
      this.lastBounds = window.getBounds()
    })
    window.on('move', () => {
      this.lastBounds = window.getBounds()
    })

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
      mode: 'full',
      getDevServerUrl: this.options.getDevServerUrl,
    })

    return window
  }

  ensureWindow() {
    return this.create()
  }

  loadRecoveryPage() {
    if (!this.window || this.window.isDestroyed()) {
      return
    }
    this.window.loadFile(path.join(this.options.electronDir, 'recovery.html'))
  }

  reloadMainWindow() {
    if (!this.window || this.window.isDestroyed()) {
      return
    }
    loadWindow(this.window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'full',
      getDevServerUrl: this.options.getDevServerUrl,
    })
  }
}
