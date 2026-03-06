import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { loadWindow } from './window-load.js'

type VoiceRuntimeWindowControllerOptions = {
  electronDir: string
  preloadPath: string
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  onRenderProcessGone?: (details: RenderProcessGoneDetails) => void
}

export class VoiceRuntimeWindowController {
  private window: BrowserWindow | null = null

  constructor(private readonly options: VoiceRuntimeWindowControllerOptions) {}

  getWindow() {
    return this.window
  }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const window = new BrowserWindow({
      width: 1,
      height: 1,
      x: -10_000,
      y: -10_000,
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      resizable: false,
      movable: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.options.sessionPartition,
        backgroundThrottling: false,
      },
    })

    this.window = window

    loadWindow(window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'voice-runtime',
      getDevServerUrl: this.options.getDevServerUrl,
    })

    window.webContents.on('render-process-gone', (_event, details) => {
      this.options.onRenderProcessGone?.(details)
    })

    window.on('closed', () => {
      this.window = null
    })

    return window
  }

  destroy() {
    if (!this.window) {
      return
    }
    this.window.removeAllListeners()
    this.window.destroy()
    this.window = null
  }
}
