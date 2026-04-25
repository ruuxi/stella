import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { resolveAppIconPath } from '../app-icon.js'
import { MINI_SHELL_SIZE } from '../layout-constants.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import type { ShellWindowDidFailLoadDetails } from './shell-window-factory.js'
import { ShellWindowController } from './shell-window-controller.js'

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
  private readonly controller: ShellWindowController

  constructor(private readonly options: MiniWindowControllerOptions) {
    this.controller = new ShellWindowController(options, {
      mode: 'mini',
      createWindow: () => {
        const isMac = process.platform === 'darwin'
        const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined

        return new BrowserWindow({
          width: MINI_SHELL_SIZE.width,
          height: MINI_SHELL_SIZE.height,
          minWidth: 400,
          minHeight: 300,
          maxWidth: MINI_SHELL_MAX_SIZE.width,
          maxHeight: MINI_SHELL_MAX_SIZE.height,
          ...(isMac ? { type: 'panel' as const } : {}),
          show: false,
          frame: false,
          fullscreenable: false,
          backgroundColor: '#00000000',
          ...(isMac ? { hiddenInMissionControl: true } : {}),
          icon: windowIcon,
          webPreferences: createSharedWebPreferences({
            preloadPath: this.options.preloadPath,
            sessionPartition: this.options.sessionPartition,
          }),
        })
      },
      afterCreate: (window) => {
        if (process.platform !== 'darwin') return
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        window.setAlwaysOnTop(true, 'screen-saver')
      },
    })
  }

  getWindow() {
    return this.controller.getWindow()
  }

  create() {
    return this.controller.create()
  }

  reloadMainWindow() {
    this.controller.reloadMainWindow()
  }

  loadRecoveryPage() {
    this.controller.loadRecoveryPage()
  }

  destroy() {
    this.controller.destroy()
  }
}
