import { BrowserWindow, screen } from 'electron'
import { loadWindow } from './window-load.js'

const MINI_SHELL_ANIM_MS = 140

const miniSize = {
  width: 480,
  height: 700,
}

type MiniWindowControllerOptions = {
  electronDir: string
  preloadPath: string
  sessionPartition: string
  isDev: boolean
  getDevServerUrl: () => string
  setupExternalLinkHandlers: (window: BrowserWindow) => void
  isQuitting: () => boolean
  onCloseRequested: () => void
}

type MiniShowDependencies = {
  getChatContextVersion: () => number
  getLastBroadcastChatContextVersion: () => number
  broadcastChatContext: () => void
  waitForMiniChatContext: (version: number) => Promise<void>
  onShowCommitted?: () => void
  onPreReveal?: () => void
}

export class MiniWindowController {
  private window: BrowserWindow | null = null
  private pendingMiniShowTimer: NodeJS.Timeout | null = null
  private miniShowRequestId = 0
  private pendingMiniBlurHideTimer: NodeJS.Timeout | null = null
  private suppressMiniBlurUntil = 0
  private pendingMiniOpacityHideTimer: NodeJS.Timeout | null = null
  private miniVisible = false
  private miniVisibilitySent = false
  private miniConcealedForCapture = false
  private miniRestoreFocusAfterCapture = false
  private miniVisibilityEpoch = 0

  constructor(private readonly options: MiniWindowControllerOptions) {}

  getWindow() {
    return this.window
  }

  isMiniShowing() {
    return Boolean(this.window && this.miniVisible)
  }

  private sendMiniVisibility(visible: boolean, force = false) {
    if (!this.window) return
    if (!force && this.miniVisibilitySent === visible) return
    this.miniVisibilitySent = visible
    this.window.webContents.send('mini:visibility', { visible })
  }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const window = new BrowserWindow({
      width: miniSize.width,
      height: miniSize.height,
      resizable: false,
      maximizable: false,
      minimizable: false,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.options.sessionPartition,
      },
    })

    this.window = window
    window.setAlwaysOnTop(true, 'pop-up-menu')
    this.options.setupExternalLinkHandlers(window)
    loadWindow(window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'mini',
      getDevServerUrl: this.options.getDevServerUrl,
    })

    window.on('closed', () => {
      this.window = null
      this.miniVisible = false
      this.miniVisibilitySent = false
      this.miniConcealedForCapture = false
      this.miniRestoreFocusAfterCapture = false
    })

    window.on('close', (event) => {
      if (this.options.isQuitting()) {
        return
      }
      event.preventDefault()
      this.options.onCloseRequested()
      this.hideWindow(false)
    })

    window.on('blur', () => {
      // Mini shell no longer auto-hides on blur.
    })

    this.positionWindow()
    this.hideWindow(false)
    window.showInactive()
    return window
  }

  ensureWindow() {
    return this.create()
  }

  positionWindow() {
    if (!this.window) {
      return
    }

    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const wa = display.workArea
    const gap = 16

    let targetX = cursor.x + gap
    let targetY = cursor.y - Math.round(miniSize.height / 3)

    if (targetX + miniSize.width > wa.x + wa.width) {
      targetX = cursor.x - miniSize.width - gap
    }

    targetX = Math.max(wa.x, Math.min(targetX, wa.x + wa.width - miniSize.width))
    targetY = Math.max(wa.y, Math.min(targetY, wa.y + wa.height - miniSize.height))

    this.window.setBounds({
      x: targetX,
      y: targetY,
      width: miniSize.width,
      height: miniSize.height,
    })
  }

  cancelPendingShow() {
    if (this.pendingMiniShowTimer) {
      clearTimeout(this.pendingMiniShowTimer)
      this.pendingMiniShowTimer = null
    }
  }

  hasPendingShow() {
    return Boolean(this.pendingMiniShowTimer)
  }

  hideWindow(animate = true) {
    if (!this.window) return
    const hideEpoch = ++this.miniVisibilityEpoch
    this.miniVisible = false
    this.miniConcealedForCapture = false
    this.miniRestoreFocusAfterCapture = false
    if (this.pendingMiniOpacityHideTimer) {
      clearTimeout(this.pendingMiniOpacityHideTimer)
      this.pendingMiniOpacityHideTimer = null
    }

    this.sendMiniVisibility(false)
    this.window.setIgnoreMouseEvents(true, { forward: true })
    this.window.setFocusable(false)
    this.window.blur()

    if (!animate) {
      this.window.setOpacity(0)
      return
    }

    if (this.window.getOpacity() <= 0.01) {
      return
    }

    this.pendingMiniOpacityHideTimer = setTimeout(() => {
      if (hideEpoch !== this.miniVisibilityEpoch) {
        return
      }
      this.pendingMiniOpacityHideTimer = null
      if (!this.window) return
      if (!this.window.isFocused()) {
        this.window.setOpacity(0)
      }
    }, MINI_SHELL_ANIM_MS)
  }

  concealMiniWindowForCapture() {
    if (!this.window || !this.miniVisible || this.miniConcealedForCapture) {
      return false
    }

    if (this.pendingMiniOpacityHideTimer) {
      clearTimeout(this.pendingMiniOpacityHideTimer)
      this.pendingMiniOpacityHideTimer = null
    }
    if (this.pendingMiniBlurHideTimer) {
      clearTimeout(this.pendingMiniBlurHideTimer)
      this.pendingMiniBlurHideTimer = null
    }

    this.suppressMiniBlurUntil = Date.now() + 250
    this.miniRestoreFocusAfterCapture = this.window.isFocused()
    this.miniConcealedForCapture = true
    this.window.setIgnoreMouseEvents(true, { forward: true })
    this.window.setFocusable(false)
    this.window.setOpacity(0)
    return true
  }

  restoreMiniWindowAfterCapture() {
    if (!this.window || !this.miniVisible || !this.miniConcealedForCapture) {
      return
    }

    this.miniVisibilityEpoch += 1
    this.miniConcealedForCapture = false
    this.suppressMiniBlurUntil = Date.now() + 250
    this.window.setIgnoreMouseEvents(false)
    this.window.setFocusable(true)
    this.window.setOpacity(1)
    this.window.show()
    if (this.miniRestoreFocusAfterCapture) {
      this.window.focus()
    } else {
      this.window.showInactive()
    }
    this.miniRestoreFocusAfterCapture = false
  }

  showWindow(deps: MiniShowDependencies) {
    this.ensureWindow()
    if (!this.window) {
      return
    }

    if (this.pendingMiniOpacityHideTimer) {
      clearTimeout(this.pendingMiniOpacityHideTimer)
      this.pendingMiniOpacityHideTimer = null
    }
    if (this.pendingMiniBlurHideTimer) {
      clearTimeout(this.pendingMiniBlurHideTimer)
      this.pendingMiniBlurHideTimer = null
    }
    this.miniVisibilityEpoch += 1

    if (this.isMiniShowing() && !this.miniConcealedForCapture) {
      this.suppressMiniBlurUntil = Date.now() + 250
      this.positionWindow()
      if (deps.getLastBroadcastChatContextVersion() !== deps.getChatContextVersion()) {
        deps.broadcastChatContext()
      }
      this.window.setIgnoreMouseEvents(false)
      this.window.setFocusable(true)
      this.window.setOpacity(1)
      this.window.show()
      this.window.focus()
      this.sendMiniVisibility(true)
      deps.onShowCommitted?.()
      return
    }

    const requestId = ++this.miniShowRequestId
    this.suppressMiniBlurUntil = Date.now() + 250
    if (deps.getLastBroadcastChatContextVersion() !== deps.getChatContextVersion()) {
      deps.broadcastChatContext()
    }
    this.positionWindow()

    if (this.pendingMiniShowTimer) {
      clearTimeout(this.pendingMiniShowTimer)
    }
    this.pendingMiniShowTimer = setTimeout(() => {
      this.pendingMiniShowTimer = null
      const versionToWait = deps.getChatContextVersion()
      void (async () => {
        deps.onPreReveal?.()
        this.window?.setIgnoreMouseEvents(false)
        this.window?.setFocusable(true)
        this.window?.setOpacity(0)
        this.window?.show()
        this.window?.focus()

        await deps.waitForMiniChatContext(versionToWait)

        if (requestId !== this.miniShowRequestId) {
          if (this.window?.isVisible()) {
            this.window.setOpacity(1)
          }
          return
        }

        this.window?.setIgnoreMouseEvents(false)
        this.window?.setFocusable(true)
        this.miniVisible = true
        this.miniConcealedForCapture = false
        this.miniRestoreFocusAfterCapture = false
        this.sendMiniVisibility(true)
        setTimeout(() => {
          if (requestId !== this.miniShowRequestId) return
          this.window?.setOpacity(1)
        }, 16)
        deps.onShowCommitted?.()
      })()
    }, 0)
  }
}
