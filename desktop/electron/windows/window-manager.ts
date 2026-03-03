import { app, BrowserWindow } from 'electron'
import { FullWindowController } from './full-window.js'
import { MiniWindowController } from './mini-window.js'
import type { UiState } from '../types.js'
import type { WorkspaceService } from '../services/workspace-service.js'
import type { ExternalLinkService } from '../services/external-link-service.js'
import type { MiniBridgeService } from '../services/mini-bridge-service.js'

type ChatContextSyncBridge = {
  getChatContextVersion: () => number
  getLastBroadcastChatContextVersion: () => number
  broadcastChatContext: () => void
  waitForMiniChatContext: (version: number) => Promise<void>
}

type WindowManagerOptions = {
  electronDir: string
  preloadPath: string
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  isAppReady: () => boolean
  isQuitting: () => boolean
  workspaceService: WorkspaceService
  externalLinkService: ExternalLinkService
  miniBridgeService: MiniBridgeService
  chatContextSyncBridge: ChatContextSyncBridge
  onDeactivateVoiceModes: () => void
  onUpdateUiState: (partial: Partial<UiState>) => void
}

export class WindowManager {
  private readonly fullWindowController: FullWindowController
  private readonly miniWindowController: MiniWindowController

  constructor(private readonly options: WindowManagerOptions) {
    this.fullWindowController = new FullWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) => options.externalLinkService.setupExternalLinkHandlers(window),
      onDidStartLoading: () => {
        options.miniBridgeService.onFullWindowDidStartLoading()
      },
      onRenderProcessGone: (details) => {
        console.error('Renderer process gone:', details.reason)
        options.miniBridgeService.onFullWindowUnavailable('Full window renderer crashed')
        this.fullWindowController.loadRecoveryPage()
      },
      onClosed: () => {
        options.workspaceService.stopWorkspacePanelWatcher()
        options.miniBridgeService.onFullWindowUnavailable('Full window unavailable')
      },
    })

    this.miniWindowController = new MiniWindowController({
      electronDir: options.electronDir,
      preloadPath: options.preloadPath,
      sessionPartition: options.sessionPartition,
      isDev: options.isDev,
      getDevServerUrl: options.getDevServerUrl,
      setupExternalLinkHandlers: (window) => options.externalLinkService.setupExternalLinkHandlers(window),
      isQuitting: options.isQuitting,
      onCloseRequested: () => {
        options.onDeactivateVoiceModes()
      },
    })
  }

  createFullWindow() {
    const before = this.fullWindowController.getWindow()
    const fullWindow = this.fullWindowController.create()
    if (!before || before.isDestroyed()) {
      this.options.workspaceService.startWorkspacePanelWatcher(fullWindow)
    }
    return fullWindow
  }

  createMiniWindow() {
    return this.miniWindowController.create()
  }

  createInitialWindows() {
    this.createFullWindow()
    this.createMiniWindow()
  }

  getFullWindow() {
    return this.fullWindowController.getWindow()
  }

  getMiniWindow() {
    return this.miniWindowController.getWindow()
  }

  getAllWindows() {
    return BrowserWindow.getAllWindows()
  }

  isMiniShowing() {
    return this.miniWindowController.isMiniShowing()
  }

  hideMiniWindow(animate = true) {
    this.miniWindowController.hideWindow(animate)
  }

  hasPendingMiniShow() {
    return this.miniWindowController.hasPendingShow()
  }

  positionMiniWindow() {
    this.miniWindowController.positionWindow()
  }

  concealMiniWindowForCapture() {
    return this.miniWindowController.concealMiniWindowForCapture()
  }

  restoreMiniWindowAfterCapture() {
    this.miniWindowController.restoreMiniWindowAfterCapture()
  }

  showWindow(target: 'full' | 'mini') {
    if (target === 'mini') {
      if (!this.options.isAppReady()) {
        return
      }
      this.miniWindowController.showWindow({
        getChatContextVersion: this.options.chatContextSyncBridge.getChatContextVersion,
        getLastBroadcastChatContextVersion: this.options.chatContextSyncBridge.getLastBroadcastChatContextVersion,
        broadcastChatContext: this.options.chatContextSyncBridge.broadcastChatContext,
        waitForMiniChatContext: this.options.chatContextSyncBridge.waitForMiniChatContext,
        onPreReveal: () => {
          this.getFullWindow()?.hide()
        },
        onShowCommitted: () => {
          this.options.onUpdateUiState({ window: 'mini' })
        },
      })
      return
    }

    this.miniWindowController.cancelPendingShow()
    const fullWindow = this.createFullWindow()
    if (fullWindow.isMinimized()) {
      fullWindow.restore()
    }
    if (process.platform === 'win32') {
      app.focus({ steal: true })
      fullWindow.show()
      fullWindow.moveTop()
      fullWindow.setAlwaysOnTop(true, 'screen-saver')
      fullWindow.focus()
      setTimeout(() => {
        if (!fullWindow.isDestroyed()) {
          fullWindow.setAlwaysOnTop(false)
        }
      }, 75)
    } else {
      fullWindow.show()
      fullWindow.focus()
    }

    this.hideMiniWindow(false)
    this.options.onUpdateUiState({ window: 'full', mode: 'chat' })
  }

  reloadFullWindow() {
    this.fullWindowController.reloadMainWindow()
  }

  onActivate() {
    if (BrowserWindow.getAllWindows().length === 0) {
      this.createInitialWindows()
    }
    this.showWindow('full')
  }
}
