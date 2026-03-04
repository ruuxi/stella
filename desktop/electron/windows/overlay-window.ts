import { BrowserWindow, ipcMain, screen } from 'electron'
import { RADIAL_SIZE } from '../layout-constants.js'
import { loadWindow } from './window-load.js'

const getAllDisplaysBounds = () => {
  const displays = screen.getAllDisplays()
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x)
    minY = Math.min(minY, d.bounds.y)
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width)
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

type OverlayWindowControllerOptions = {
  preloadPath: string
  sessionPartition: string
  electronDir: string
  isDev: boolean
  getDevServerUrl: () => string
}

// ─── OverlayWindow: Electron window lifecycle ───────────────────────────

/** Pure window lifecycle: create, destroy, respan, show/hide, interactivity. */
class OverlayWindow {
  private window: BrowserWindow | null = null
  private displayListenersRegistered = false
  private respanHandler: (() => void) | null = null
  private ready = false
  private overlayOrigin = { x: 0, y: 0 }

  constructor(private readonly options: OverlayWindowControllerOptions) {}

  getWindow() { return this.window }
  getOverlayOrigin() { return this.overlayOrigin }
  isReady() { return this.ready }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const bounds = getAllDisplaysBounds()
    this.overlayOrigin = { x: bounds.x, y: bounds.y }

    this.window = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.options.sessionPartition,
      },
    })

    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.window.setIgnoreMouseEvents(true, { forward: true })

    this.window.once('ready-to-show', () => {
      this.ready = true
      if (this.window && !this.window.isDestroyed()) {
        this.respanDisplays()
        this.window.setOpacity(0)
        this.window.showInactive()
        this.window.setIgnoreMouseEvents(true, { forward: true })
      }
    })
    this.window.webContents.once('did-finish-load', () => {
      this.ready = true
    })

    loadWindow(this.window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'overlay',
      getDevServerUrl: this.options.getDevServerUrl,
    })

    this.window.on('closed', () => {
      this.window = null
      this.ready = false
    })

    this.window.on('close', (e) => {
      e.preventDefault()
    })

    if (!this.displayListenersRegistered) {
      this.displayListenersRegistered = true
      this.respanHandler = () => this.respanDisplays()
      screen.on('display-added', this.respanHandler)
      screen.on('display-removed', this.respanHandler)
      screen.on('display-metrics-changed', this.respanHandler)
    }

    return this.window
  }

  private respanDisplays() {
    if (!this.window) return
    const bounds = getAllDisplaysBounds()
    this.overlayOrigin = { x: bounds.x, y: bounds.y }
    this.window.setBounds(bounds)
    this.window.webContents.send('overlay:displayChange', {
      origin: this.overlayOrigin,
      bounds,
    })
  }

  show(options?: { focus?: boolean; inactive?: boolean }) {
    if (!this.window || !this.ready) return
    if (!this.window.isVisible()) {
      this.respanDisplays()
      if (options?.inactive) {
        this.window.showInactive()
      } else {
        this.window.show()
      }
    }
    this.window.setOpacity(1)
    if (options?.focus) {
      this.window.focus()
    }
  }

  /** Fade overlay to transparent (avoids Windows compositor artifacts from hide/show). */
  fadeOut() {
    if (!this.window || !this.ready) return
    this.window.setIgnoreMouseEvents(true, { forward: true })
    this.window.setFocusable(false)
    this.window.setOpacity(0)
  }

  setIgnoreMouseEvents(ignore: boolean) {
    if (!this.window) return
    if (ignore) {
      this.window.setIgnoreMouseEvents(true, { forward: true })
    } else {
      this.window.setIgnoreMouseEvents(false)
    }
  }

  setFocusable(focusable: boolean) {
    if (!this.window) return
    this.window.setFocusable(focusable)
    if (!focusable) this.window.blur()
  }

  send(channel: string, ...args: unknown[]) {
    this.window?.webContents.send(channel, ...args)
  }

  destroy() {
    if (this.respanHandler) {
      screen.removeListener('display-added', this.respanHandler)
      screen.removeListener('display-removed', this.respanHandler)
      screen.removeListener('display-metrics-changed', this.respanHandler)
      this.respanHandler = null
      this.displayListenersRegistered = false
    }

    if (this.window) {
      this.window.removeAllListeners('close')
      this.window.destroy()
      this.window = null
    }
  }
}

// ─── OverlayWindowController: Component orchestration ───────────────────

/**
 * Orchestrates overlay components (Radial Dial, Region Capture, Mini Shell,
 * Voice Overlay, modifier-block) within the overlay window. Delegates
 * window lifecycle to OverlayWindow.
 */
export class OverlayWindowController {
  private readonly overlayWindow: OverlayWindow

  // Active component tracking — overlay stays visible when any component is active.
  private activeModifierBlock = false
  private activeRadial = false
  private activeRegionCapture = false
  private activeMini = false
  private activeVoice = false
  private activeNiri = false

  private readonly handleOverlaySetInteractive = (_event: unknown, interactive: boolean) => {
    this.overlayWindow.setIgnoreMouseEvents(!interactive)
  }
  private readonly handleRadialAnimDone = () => {
    if (this.radialHideTimeout) {
      clearTimeout(this.radialHideTimeout)
      this.radialHideTimeout = null
    }
    this.activeRadial = false
    this.hideOverlayIfIdle()
  }

  private readonly handleNiriRequest = () => {
    this.showNiri()
  }
  private readonly handleNiriHideRequest = () => {
    this.hideNiri()
  }

  constructor(options: OverlayWindowControllerOptions) {
    this.overlayWindow = new OverlayWindow(options)
    ipcMain.on('overlay:setInteractive', this.handleOverlaySetInteractive)
    ipcMain.on('radial:animDone', this.handleRadialAnimDone)
    ipcMain.on('overlay:showNiri:request', this.handleNiriRequest)
    ipcMain.on('overlay:hideNiri:request', this.handleNiriHideRequest)
  }

  getWindow() { return this.overlayWindow.getWindow() }
  getOverlayOrigin() { return this.overlayWindow.getOverlayOrigin() }

  create() { return this.overlayWindow.create() }

  private get isAnyActive() {
    return this.activeModifierBlock || this.activeRadial || this.activeRegionCapture || this.activeMini || this.activeVoice || this.activeMorph || this.activeNiri
  }

  private hideOverlayIfIdle() {
    if (this.isAnyActive) return
    this.overlayWindow.fadeOut()
  }

  // ─── Modifier Block ──────────────────────────────────────────────────

  showModifierBlock() {
    this.activeModifierBlock = true
    this.overlayWindow.show({ inactive: true })
    this.overlayWindow.setIgnoreMouseEvents(false)
    this.overlayWindow.send('overlay:modifierBlock', true)
  }

  hideModifierBlock() {
    this.activeModifierBlock = false
    if (!this.activeRegionCapture && !this.activeMini && !this.activeRadial) {
      this.overlayWindow.setIgnoreMouseEvents(true)
    }
    this.overlayWindow.send('overlay:modifierBlock', false)
    this.hideOverlayIfIdle()
  }

  // ─── Radial Dial ──────────────────────────────────────────────────────

  private radialBounds: { x: number; y: number } | null = null
  private radialHideTimeout: ReturnType<typeof setTimeout> | null = null
  private static readonly CLOSE_ANIM_FALLBACK = 350

  showRadial(physX: number, physY: number) {
    if (!this.overlayWindow.getWindow()) return

    if (this.radialHideTimeout) {
      clearTimeout(this.radialHideTimeout)
      this.radialHideTimeout = null
    }

    this.activeRadial = true
    this.overlayWindow.show({ inactive: true })

    const cursorDip = screen.getCursorScreenPoint()
    const screenDipX = Math.round(cursorDip.x - RADIAL_SIZE / 2)
    const screenDipY = Math.round(cursorDip.y - RADIAL_SIZE / 2)
    this.radialBounds = { x: screenDipX, y: screenDipY }

    const relativeX = cursorDip.x - screenDipX
    const relativeY = cursorDip.y - screenDipY
    const origin = this.overlayWindow.getOverlayOrigin()
    const localX = screenDipX - origin.x
    const localY = screenDipY - origin.y

    this.overlayWindow.setIgnoreMouseEvents(false)
    this.overlayWindow.send('radial:show', {
      x: relativeX,
      y: relativeY,
      centerX: RADIAL_SIZE / 2,
      centerY: RADIAL_SIZE / 2,
      screenX: localX,
      screenY: localY,
    })
  }

  hideRadial() {
    if (!this.overlayWindow.getWindow()) return
    this.overlayWindow.send('radial:hide')
    if (!this.activeRegionCapture && !this.activeMini && !this.activeModifierBlock) {
      this.overlayWindow.setIgnoreMouseEvents(true)
    }
    this.radialBounds = null

    if (this.radialHideTimeout) clearTimeout(this.radialHideTimeout)
    this.radialHideTimeout = setTimeout(() => {
      this.radialHideTimeout = null
      this.activeRadial = false
      this.hideOverlayIfIdle()
    }, OverlayWindowController.CLOSE_ANIM_FALLBACK)
  }

  updateRadialCursor(x: number, y: number) {
    if (!this.overlayWindow.getWindow() || !this.radialBounds) return

    const cursorDip = screen.getCursorScreenPoint()
    const bounds = this.radialBounds
    this.overlayWindow.send('radial:cursor', {
      x: cursorDip.x - bounds.x,
      y: cursorDip.y - bounds.y,
      centerX: RADIAL_SIZE / 2,
      centerY: RADIAL_SIZE / 2,
    })
  }

  getRadialBounds() { return this.radialBounds }

  setRadialInteractive(interactive: boolean) {
    this.overlayWindow.setIgnoreMouseEvents(!interactive)
  }

  // ─── Region Capture ───────────────────────────────────────────────────

  startRegionCapture() {
    this.activeRegionCapture = true
    this.overlayWindow.setFocusable(true)
    this.overlayWindow.show({ focus: true })
    this.overlayWindow.setIgnoreMouseEvents(false)
    this.overlayWindow.send('overlay:startRegionCapture')
  }

  endRegionCapture() {
    this.activeRegionCapture = false
    this.overlayWindow.setIgnoreMouseEvents(true)
    this.overlayWindow.setFocusable(false)
    this.overlayWindow.send('overlay:endRegionCapture')
    this.hideOverlayIfIdle()
  }

  // ─── Mini Shell ────────────────────────────────────────────────────────

  showMini(screenX: number, screenY: number) {
    this.activeMini = true
    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.send('overlay:showMini', { x: screenX - origin.x, y: screenY - origin.y })
    this.overlayWindow.show({ focus: true })
    this.overlayWindow.setIgnoreMouseEvents(false)
    this.overlayWindow.setFocusable(true)
  }

  hideMini() {
    this.activeMini = false
    this.overlayWindow.send('overlay:hideMini')
    this.overlayWindow.setIgnoreMouseEvents(true)
    this.overlayWindow.setFocusable(false)
    this.hideOverlayIfIdle()
  }

  concealMiniForCapture() {
    this.overlayWindow.send('overlay:hideMini')
  }

  restoreMiniAfterCapture() {
    this.overlayWindow.send('overlay:restoreMini')
  }

  // ─── Voice ─────────────────────────────────────────────────────────────

  showVoice(screenX: number, screenY: number, mode: 'stt' | 'realtime') {
    this.activeVoice = true
    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.show({ inactive: true })
    this.overlayWindow.send('overlay:showVoice', { x: screenX - origin.x, y: screenY - origin.y, mode })
  }

  hideVoice() {
    this.activeVoice = false
    this.overlayWindow.send('overlay:hideVoice')
    this.hideOverlayIfIdle()
  }

  // ─── Niri Demo ─────────────────────────────────────────────────────────

  showNiri() {
    this.activeNiri = true
    this.overlayWindow.show({ focus: true })
    this.overlayWindow.setIgnoreMouseEvents(false)
    this.overlayWindow.setFocusable(true)
    this.overlayWindow.send('overlay:showNiri')
  }

  hideNiri() {
    this.activeNiri = false
    this.overlayWindow.send('overlay:hideNiri')
    this.overlayWindow.setIgnoreMouseEvents(true)
    this.overlayWindow.setFocusable(false)
    this.hideOverlayIfIdle()
  }

  // ─── Morph Transition (HMR Resume) ───────────────────────────────────

  private activeMorph = false

  startMorphForward(screenshotDataUrl: string, bounds: { x: number; y: number; width: number; height: number }) {
    this.activeMorph = true
    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.show({ inactive: true })
    this.overlayWindow.send('overlay:morphForward', {
      screenshotDataUrl,
      x: bounds.x - origin.x,
      y: bounds.y - origin.y,
      width: bounds.width,
      height: bounds.height,
    })
  }

  startMorphReverse(screenshotDataUrl: string) {
    this.overlayWindow.send('overlay:morphReverse', { screenshotDataUrl })
  }

  endMorph() {
    this.activeMorph = false
    this.overlayWindow.send('overlay:morphEnd')
    this.hideOverlayIfIdle()
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  destroy() {
    ipcMain.removeListener('overlay:setInteractive', this.handleOverlaySetInteractive)
    ipcMain.removeListener('radial:animDone', this.handleRadialAnimDone)
    ipcMain.removeListener('overlay:showNiri:request', this.handleNiriRequest)
    ipcMain.removeListener('overlay:hideNiri:request', this.handleNiriHideRequest)
    this.overlayWindow.destroy()
  }
}
