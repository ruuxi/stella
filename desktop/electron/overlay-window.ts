import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDevServerUrl } from './dev-url.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = process.env.NODE_ENV === 'development'

/**
 * Compute the bounding rectangle that spans all displays (in DIP coordinates).
 */
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
}

/**
 * Manages a single fullscreen transparent BrowserWindow that hosts all overlay
 * UI components: Radial Dial, Region Capture, Mini Shell, Voice Overlay, and
 * the modifier-block context-menu suppression layer.
 *
 * The window starts hidden and is only shown when a component activates.
 * When all components deactivate, the window is hidden again so it doesn't
 * block interaction with windows below it (including the Stella full window).
 */
export class OverlayWindowController {
  private window: BrowserWindow | null = null
  private displayListenersRegistered = false
  private respanHandler: (() => void) | null = null
  private ready = false
  /** Overlay window origin in screen coords — used by renderer to compute component positions */
  private overlayOrigin = { x: 0, y: 0 }

  // ─── Active component tracking ─────────────────────────────────────
  // The overlay is shown only when at least one component is active.
  private activeModifierBlock = false
  private activeRadial = false
  private activeRegionCapture = false
  private activeMini = false
  private activeVoice = false
  private readonly handleOverlaySetInteractive = (_event: unknown, interactive: boolean) => {
    if (!this.window) return
    if (interactive) {
      this.window.setIgnoreMouseEvents(false)
    } else {
      this.window.setIgnoreMouseEvents(true, { forward: true })
    }
  }
  private readonly handleRadialAnimDone = () => {
    if (this.radialHideTimeout) {
      clearTimeout(this.radialHideTimeout)
      this.radialHideTimeout = null
    }
    this.activeRadial = false
    this.hideOverlayIfIdle()
  }

  constructor(private readonly options: OverlayWindowControllerOptions) {
    // Renderer -> main: toggle click-through
    ipcMain.on('overlay:setInteractive', this.handleOverlaySetInteractive)

    // Renderer signals radial close animation is done
    ipcMain.on('radial:animDone', this.handleRadialAnimDone)
  }

  getWindow() {
    return this.window
  }

  getOverlayOrigin() {
    return this.overlayOrigin
  }

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

    // Mark ready once content has loaded (prevents white flash)
    this.window.once('ready-to-show', () => {
      this.ready = true
    })
    // Fallback readiness signal for cases where ready-to-show does not fire.
    this.window.webContents.once('did-finish-load', () => {
      this.ready = true
    })

    // Load the overlay page
    if (isDev) {
      const url = new URL('overlay.html', `${getDevServerUrl()}/`).toString()
      this.window.loadURL(url)
    } else {
      const filePath = path.join(__dirname, '../dist/overlay.html')
      this.window.loadFile(filePath)
    }

    this.window.on('closed', () => {
      this.window = null
      this.ready = false
    })

    // Prevent the window from being closed (it should live for the app lifetime)
    this.window.on('close', (e) => {
      e.preventDefault()
    })

    // Register display change listeners to re-span all monitors
    if (!this.displayListenersRegistered) {
      this.displayListenersRegistered = true
      this.respanHandler = () => this.respanDisplays()
      screen.on('display-added', this.respanHandler)
      screen.on('display-removed', this.respanHandler)
      screen.on('display-metrics-changed', this.respanHandler)
    }

    return this.window
  }

  /** Resize the overlay to cover all displays. */
  private respanDisplays() {
    if (!this.window) return
    const bounds = getAllDisplaysBounds()
    this.overlayOrigin = { x: bounds.x, y: bounds.y }
    this.window.setBounds(bounds)
    // Notify renderer of new origin so it can reposition components
    this.window.webContents.send('overlay:displayChange', {
      origin: this.overlayOrigin,
      bounds,
    })
  }

  // ─── Show/hide lifecycle ────────────────────────────────────────────

  private get isAnyActive() {
    return this.activeModifierBlock || this.activeRadial || this.activeRegionCapture || this.activeMini || this.activeVoice
  }

  /** Show the overlay window (no-op if already visible or not ready). */
  private showOverlay(options?: { focus?: boolean; inactive?: boolean }) {
    if (!this.window || !this.ready) return
    if (!this.window.isVisible()) {
      this.respanDisplays()
      if (options?.inactive) {
        this.window.showInactive()
      } else {
        this.window.show()
      }
    }
    if (options?.focus) {
      this.window.focus()
    }
  }

  /** Hide the overlay if no components are active — allows windows below to be interactive. */
  private hideOverlayIfIdle() {
    if (this.isAnyActive) return
    if (!this.window) return
    this.window.setIgnoreMouseEvents(true, { forward: true })
    this.window.setFocusable(false)
    if (!this.ready) return
    this.window.hide()
  }

  // ─── Modifier Block ──────────────────────────────────────────────────

  /**
   * Enable modifier-block mode: overlay captures right-clicks to suppress
   * native context menus during a radial gesture.
   */
  showModifierBlock() {
    if (!this.window) return
    this.activeModifierBlock = true
    this.showOverlay({ inactive: true })
    this.window.setIgnoreMouseEvents(false)
    this.window.webContents.send('overlay:modifierBlock', true)
  }

  /**
   * Show the overlay pre-emptively on macOS when the modifier key is pressed,
   * before a right-click fires. Uses showInactive to keep underlying app focused.
   */
  showModifierBlockPreemptive() {
    if (!this.window) return
    this.activeModifierBlock = true
    this.showOverlay({ inactive: true })
    this.window.setIgnoreMouseEvents(false)
    this.window.webContents.send('overlay:modifierBlock', true)
  }

  /**
   * Disable modifier-block mode: overlay becomes click-through again.
   */
  hideModifierBlock() {
    if (!this.window) return
    this.activeModifierBlock = false
    // Do not force click-through if another interactive overlay mode is active
    // (for example region capture, mini shell, or an active radial gesture).
    if (!this.activeRegionCapture && !this.activeMini && !this.activeRadial) {
      this.window.setIgnoreMouseEvents(true, { forward: true })
    }
    this.window.webContents.send('overlay:modifierBlock', false)
    this.hideOverlayIfIdle()
  }

  // ─── Radial Dial ──────────────────────────────────────────────────────

  private radialBounds: { x: number; y: number } | null = null
  private radialHideTimeout: ReturnType<typeof setTimeout> | null = null
  private static readonly RADIAL_SIZE = 280
  private static readonly CLOSE_ANIM_FALLBACK = 350

  /**
   * Show the radial dial centered on cursor.
   *
   * @param physX Physical pixel X from uiohook/mouse_block (used for subsequent cursor updates)
   * @param physY Physical pixel Y from uiohook/mouse_block
   */
  showRadial(physX: number, physY: number) {
    if (!this.window) return

    // Cancel any pending close-animation hide
    if (this.radialHideTimeout) {
      clearTimeout(this.radialHideTimeout)
      this.radialHideTimeout = null
    }

    this.activeRadial = true

    this.showOverlay({ inactive: true })
    // Use Electron's DIP cursor position for accurate positioning.
    // uiohook/mouse_block report physical pixels on Windows, but Electron APIs use DIP.
    const cursorDip = screen.getCursorScreenPoint()

    // Position the radial centered on cursor (DIP coords)
    const screenDipX = Math.round(cursorDip.x - OverlayWindowController.RADIAL_SIZE / 2)
    const screenDipY = Math.round(cursorDip.y - OverlayWindowController.RADIAL_SIZE / 2)
    this.radialBounds = { x: screenDipX, y: screenDipY }

    // Cursor relative to radial container (for wedge calculation in renderer)
    const relativeX = cursorDip.x - screenDipX
    const relativeY = cursorDip.y - screenDipY

    // Convert screen DIP → overlay-local for CSS positioning
    const localX = screenDipX - this.overlayOrigin.x
    const localY = screenDipY - this.overlayOrigin.y
    this.window.setIgnoreMouseEvents(false)

    // Send position + cursor data to overlay renderer
    this.window.webContents.send('radial:show', {
      x: relativeX,
      y: relativeY,
      centerX: OverlayWindowController.RADIAL_SIZE / 2,
      centerY: OverlayWindowController.RADIAL_SIZE / 2,
      // Overlay-local coords for OverlayRoot CSS positioning
      screenX: localX,
      screenY: localY,
    })
  }

  hideRadial() {
    if (!this.window) return
    this.window.webContents.send('radial:hide')
    // Make non-interactive immediately, unless another mode still needs input.
    if (!this.activeRegionCapture && !this.activeMini && !this.activeModifierBlock) {
      this.window.setIgnoreMouseEvents(true, { forward: true })
    }
    this.radialBounds = null

    // Fallback: if renderer doesn't ack close animation in time, hide anyway
    if (this.radialHideTimeout) clearTimeout(this.radialHideTimeout)
    this.radialHideTimeout = setTimeout(() => {
      this.radialHideTimeout = null
      this.activeRadial = false
      this.hideOverlayIfIdle()
    }, OverlayWindowController.CLOSE_ANIM_FALLBACK)
  }

  updateRadialCursor(x: number, y: number) {
    if (!this.window || !this.radialBounds) return

    // Use Electron's DIP cursor position for consistency with showRadial
    const cursorDip = screen.getCursorScreenPoint()
    const bounds = this.radialBounds

    const relativeX = cursorDip.x - bounds.x
    const relativeY = cursorDip.y - bounds.y

    this.window.webContents.send('radial:cursor', {
      x: relativeX,
      y: relativeY,
      centerX: OverlayWindowController.RADIAL_SIZE / 2,
      centerY: OverlayWindowController.RADIAL_SIZE / 2,
    })
  }

  getRadialBounds() {
    return this.radialBounds
  }

  /** Force overlay interactive for the duration of a radial gesture. */
  setRadialInteractive(interactive: boolean) {
    if (!this.window) return
    if (interactive) {
      this.window.setIgnoreMouseEvents(false)
    } else {
      this.window.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  // ─── Region Capture ───────────────────────────────────────────────────

  /** Make overlay fully interactive for region capture (covers all screens). */
  startRegionCapture() {
    if (!this.window) return
    this.activeRegionCapture = true
    this.window.setFocusable(true)
    this.showOverlay({ focus: true })
    this.window.setIgnoreMouseEvents(false)
    this.window.webContents.send('overlay:startRegionCapture')
  }

  endRegionCapture() {
    if (!this.window) return
    this.activeRegionCapture = false
    this.window.setIgnoreMouseEvents(true, { forward: true })
    this.window.setFocusable(false)
    this.window.webContents.send('overlay:endRegionCapture')
    this.hideOverlayIfIdle()
  }

  // ─── Mini Shell ────────────────────────────────────────────────────────

  showMini(screenX: number, screenY: number) {
    if (!this.window) return
    this.activeMini = true
    // Convert screen coords to overlay-local coords
    const localX = screenX - this.overlayOrigin.x
    const localY = screenY - this.overlayOrigin.y
    this.window.webContents.send('overlay:showMini', { x: localX, y: localY })
    this.showOverlay({ focus: true })
    this.window.setIgnoreMouseEvents(false)
    this.window.setFocusable(true)
  }

  hideMini() {
    if (!this.window) return
    this.activeMini = false
    this.window.webContents.send('overlay:hideMini')
    this.window.setIgnoreMouseEvents(true, { forward: true })
    this.window.setFocusable(false)
    this.window.blur()
    this.hideOverlayIfIdle()
  }

  /** Temporarily hide mini shell during screen capture. */
  concealMiniForCapture() {
    if (!this.window) return
    this.window.webContents.send('overlay:hideMini')
  }

  restoreMiniAfterCapture() {
    if (!this.window) return
    this.window.webContents.send('overlay:restoreMini')
  }

  // ─── Voice ─────────────────────────────────────────────────────────────

  showVoice(screenX: number, screenY: number, mode: 'stt' | 'realtime') {
    if (!this.window) return
    this.activeVoice = true
    const localX = screenX - this.overlayOrigin.x
    const localY = screenY - this.overlayOrigin.y
    this.showOverlay({ inactive: true })
    this.window.webContents.send('overlay:showVoice', { x: localX, y: localY, mode })
  }

  hideVoice() {
    if (!this.window) return
    this.activeVoice = false
    this.window.webContents.send('overlay:hideVoice')
    this.hideOverlayIfIdle()
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  destroy() {
    ipcMain.removeListener('overlay:setInteractive', this.handleOverlaySetInteractive)
    ipcMain.removeListener('radial:animDone', this.handleRadialAnimDone)

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
