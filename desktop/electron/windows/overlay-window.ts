import {
  BrowserWindow,
  ipcMain,
  screen,
  type RenderProcessGoneDetails,
} from 'electron'
import { RADIAL_SIZE } from '../layout-constants.js'
import type { SelfModHmrState } from '../../../runtime/contracts/index.js'
import { loadWindow } from './window-load.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'
import { getWindowInfoAtPoint } from '../window-capture.js'

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
  private destroyed = false
  private overlayOrigin = { x: 0, y: 0 }
  private reloadTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: OverlayWindowControllerOptions) {}

  getWindow() { return this.window }
  getOverlayOrigin() { return this.overlayOrigin }
  /** Keeps overlay-local coords aligned with `getContentBounds()` (macOS can nudge the panel). */
  refreshOverlayOriginFromContentBounds() {
    if (!this.window || this.window.isDestroyed()) return
    const cb = this.window.getContentBounds()
    this.overlayOrigin = { x: cb.x, y: cb.y }
  }
  isReady() { return this.ready }
  isDestroyed() { return this.destroyed }

  async ensureReady(timeoutMs = 1_500) {
    const win = this.create()
    if (!win || win.isDestroyed()) {
      return false
    }
    if (this.ready) {
      return true
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        win.removeListener('ready-to-show', handleReady)
        win.removeListener('closed', handleClosed)
        win.webContents.removeListener('did-finish-load', handleReady)
        resolve(value)
      }
      const handleReady = () => {
        this.ready = true
        finish(true)
      }
      const handleClosed = () => finish(false)
      const timer = setTimeout(() => finish(this.ready), timeoutMs)

      win.once('ready-to-show', handleReady)
      win.once('closed', handleClosed)
      win.webContents.once('did-finish-load', handleReady)
    })
  }

  create() {
    if (this.destroyed) return null
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
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      // `fullscreenable` MUST be false on macOS for `visibleOnFullScreen: true`
      // below to take effect. AppKit ignores the `FullScreenAuxiliary`
      // collection-behavior bit on any window that is itself fullscreen-able,
      // which is what caused the radial to jump the user back to the original
      // Space (blank, because the full shell had just moved to its own
      // fullscreen Space) instead of drawing over the active fullscreen Space.
      fullscreenable: false,
      ...(process.platform === 'darwin' ? { hiddenInMissionControl: true } : {}),
      hasShadow: false,
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: createSharedWebPreferences({
        preloadPath: this.options.preloadPath,
        sessionPartition: this.options.sessionPartition,
        backgroundThrottling: false,
      }),
    })

    this.window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      // Keep the overlay attached to the active Space on macOS. Without this,
      // the hidden panel stays bound to whichever Space it first materialized
      // on — when the radial is summoned from another Space, macOS jumps the
      // user to that home Space (which looks blank because the overlay is
      // fully transparent) instead of drawing the dial under the cursor.
      // skipTransformProcessType keeps the process type stable so this call
      // doesn't promote us out of accessory/agent state.
      this.window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      })
      this.window.excludedFromShownWindowsMenu = true
    } else {
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    this.window.setIgnoreMouseEvents(true, { forward: true })

    this.window.once('ready-to-show', () => {
      this.ready = true
      if (this.window && !this.window.isDestroyed()) {
        this.respanDisplays()
        this.window.setOpacity(0)
        if (process.platform !== 'darwin') {
          this.window.showInactive()
        }
        this.window.setIgnoreMouseEvents(true, { forward: true })
      }
    })
    this.window.webContents.once('did-finish-load', () => {
      this.ready = true
    })
    this.window.webContents.on('render-process-gone', (_event, details) => {
      this.handleRenderProcessGone(details)
    })
    this.window.webContents.on(
      'did-fail-load',
      (
        _event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      ) => {
        if (!isMainFrame || errorCode === -3) {
          return
        }
        console.error(
          'Overlay failed to load:',
          errorCode,
          errorDescription,
          validatedURL,
        )
        this.scheduleReload()
      },
    )

    loadWindow(this.window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'overlay',
      getDevServerUrl: this.options.getDevServerUrl,
    })

    this.window.on('closed', () => {
      this.window = null
      this.ready = false
      this.clearReloadTimer()
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
    // Re-read the actual content origin after showing so overlay-local
    // coordinates stay correct. macOS can silently reposition windows
    // (for example around the menu bar or notch), which otherwise leaves
    // first-open surfaces slightly offset from the cursor.
    this.refreshOverlayOriginFromContentBounds()
    // Use 0.99 instead of 1 so Chrome's occlusion tracker doesn't consider
    // this window as fully opaque (alpha < 255 = not occluding). Without this,
    // Chrome stops rendering video when the overlay becomes visible.
    this.window.setOpacity(0.99)
    // Showing a hidden BrowserWindow can reset mouse-event policy on some
    // Electron/macOS paths. Keep passive overlay surfaces (including the pet)
    // click-through unless their renderer explicitly claims interactivity.
    if (!options?.focus) {
      this.window.setIgnoreMouseEvents(true, { forward: true })
      this.window.setFocusable(false)
    }
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
    if (process.platform === 'darwin') {
      this.window.hide()
    }
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

  private handleRenderProcessGone(details: RenderProcessGoneDetails) {
    console.error('Overlay renderer process gone:', details.reason)
    this.scheduleReload()
  }

  private scheduleReload(delayMs = 250) {
    if (this.reloadTimer) {
      return
    }
    this.ready = false
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      if (!this.window || this.window.isDestroyed()) {
        return
      }
      loadWindow(this.window, {
        electronDir: this.options.electronDir,
        isDev: this.options.isDev,
        mode: 'overlay',
        getDevServerUrl: this.options.getDevServerUrl,
      })
    }, delayMs)
  }

  private clearReloadTimer() {
    if (!this.reloadTimer) {
      return
    }
    clearTimeout(this.reloadTimer)
    this.reloadTimer = null
  }

  /** Idempotent — calling more than once is a no-op after the first.
   *  After this returns, `create()` refuses to materialize the window
   *  again (the controller is treated as dead). */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.clearReloadTimer()

    if (this.respanHandler) {
      screen.removeListener('display-added', this.respanHandler)
      screen.removeListener('display-removed', this.respanHandler)
      screen.removeListener('display-metrics-changed', this.respanHandler)
      this.respanHandler = null
      this.displayListenersRegistered = false
    }

    if (this.window) {
      this.window.removeAllListeners('close')
      if (!this.window.isDestroyed()) {
        this.window.destroy()
      }
      this.window = null
    }
    this.ready = false
  }
}

// ─── OverlayWindowController: Component orchestration ───────────────────

/**
 * Orchestrates overlay components (Region Capture, Voice Overlay, Screen
 * Guide, Window Highlight, Morph Transition) within the overlay window.
 * Delegates window lifecycle to OverlayWindow.
 */
export type MorphTransitionFlavor = 'hmr' | 'onboarding'

export type SelectionChipPayload = {
  text: string
  rect: { x: number; y: number; width: number; height: number }
  requestId: number
}

export class OverlayWindowController {
  private readonly overlayWindow: OverlayWindow
  private destroyed = false
  private morphTrackedWindow: BrowserWindow | null = null
  private activeMorphTransitionId: string | null = null
  private morphFlavor: MorphTransitionFlavor = 'hmr'
  private readonly handleMorphWindowBoundsChanged = () => {
    this.syncMorphBounds()
  }

  // Active component tracking — overlay stays visible when any component is active.
  private activeRadial = false
  private activeRegionCapture = false
  private activeDictation = false
  private activeScreenGuide = false
  private activeWindowHighlight = false
  private windowHighlightRequestId = 0
  private activeSelectionChip = false
  private currentSelectionChipRequestId: number | null = null
  private selectionChipClickHandler:
    | ((requestId: number) => void)
    | null = null

  private readonly handleRadialAnimDone = () => {
    if (this.radialHideTimeout) {
      clearTimeout(this.radialHideTimeout)
      this.radialHideTimeout = null
    }
    this.activeRadial = false
    this.hideOverlayIfIdle()
  }

  private readonly handleOverlaySetInteractive = (_event: unknown, interactive: boolean) => {
    if (this.activeRegionCapture && !interactive) {
      return
    }
    this.overlayWindow.setIgnoreMouseEvents(!interactive)
  }
  private readonly handleOverlayShowWindowHighlight = (
    _event: unknown,
    payload:
      | {
          bounds: { x: number; y: number; width: number; height: number }
          tone?: 'default' | 'subtle'
        }
      | { x: number; y: number; width: number; height: number }
      | null,
  ) => {
    this.windowHighlightRequestId += 1
    if (!payload) {
      this.setWindowHighlight(null)
      return
    }
    if ('bounds' in payload) {
      this.setWindowHighlight(payload.bounds, payload.tone ?? 'default')
      return
    }
    this.setWindowHighlight(payload, 'default')
  }
  private readonly handleOverlayHideWindowHighlight = () => {
    this.windowHighlightRequestId += 1
    this.clearWindowHighlight()
  }
  private readonly handleOverlayPreviewWindowHighlightAtPoint = (
    _event: unknown,
    point: { x: number; y: number },
  ) => {
    const requestId = ++this.windowHighlightRequestId
    const origin = this.overlayWindow.getOverlayOrigin()
    const screenPoint = {
      x: Math.round(point.x + origin.x),
      y: Math.round(point.y + origin.y),
    }
    void getWindowInfoAtPoint(screenPoint.x, screenPoint.y, {
      excludePids: [process.pid],
    }).then((info) => {
      if (requestId !== this.windowHighlightRequestId) return
      this.setWindowHighlight(info?.bounds ?? null, 'default')
    })
  }
  private readonly handleOverlaySelectionChipClicked = (
    _event: unknown,
    payload: { requestId: number } | null,
  ) => {
    const requestId = payload?.requestId
    if (typeof requestId !== 'number') return
    this.selectionChipClickHandler?.(requestId)
  }
  constructor(options: OverlayWindowControllerOptions) {
    this.overlayWindow = new OverlayWindow(options)
    ipcMain.on('overlay:setInteractive', this.handleOverlaySetInteractive)
    ipcMain.on('overlay:showWindowHighlight', this.handleOverlayShowWindowHighlight)
    ipcMain.on('overlay:hideWindowHighlight', this.handleOverlayHideWindowHighlight)
    ipcMain.on(
      'overlay:previewWindowHighlightAtPoint',
      this.handleOverlayPreviewWindowHighlightAtPoint,
    )
    ipcMain.on(
      'overlay:selectionChipClicked',
      this.handleOverlaySelectionChipClicked,
    )
    ipcMain.on('radial:animDone', this.handleRadialAnimDone)
  }

  setSelectionChipClickHandler(handler: ((requestId: number) => void) | null) {
    this.selectionChipClickHandler = handler
  }

  getWindow() { return this.overlayWindow.getWindow() }
  getOverlayOrigin() { return this.overlayWindow.getOverlayOrigin() }

  create() { return this.overlayWindow.create() }
  ensureReadyForMorph(timeoutMs?: number) {
    return this.overlayWindow.ensureReady(timeoutMs)
  }

  private get isAnyActive() {
    return this.activeRadial ||
      this.activeRegionCapture ||
      this.activeDictation ||
      this.activeScreenGuide ||
      this.activeWindowHighlight ||
      this.activeSelectionChip ||
      this.activeMorph
  }

  private setWindowHighlight(
    bounds: { x: number; y: number; width: number; height: number } | null,
    tone: 'default' | 'subtle' = 'default',
  ) {
    if (!bounds) {
      this.clearWindowHighlight()
      return
    }

    this.activeWindowHighlight = true
    this.overlayWindow.show({ inactive: true })
    if (this.activeRegionCapture) {
      this.overlayWindow.setFocusable(true)
      this.overlayWindow.setIgnoreMouseEvents(false)
    } else {
      this.overlayWindow.setIgnoreMouseEvents(true)
      this.overlayWindow.setFocusable(false)
    }

    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.send('overlay:windowHighlight', {
      x: bounds.x - origin.x,
      y: bounds.y - origin.y,
      width: bounds.width,
      height: bounds.height,
      tone,
    })
  }

  private clearWindowHighlight() {
    this.activeWindowHighlight = false
    this.overlayWindow.send('overlay:windowHighlight', null)
    this.hideOverlayIfIdle()
  }

  private hideOverlayIfIdle() {
    if (this.isAnyActive) return
    this.overlayWindow.fadeOut()
  }

  private showSurface(options: {
    setActive: () => void
    channel: string
    payload?: unknown
    showOptions?: { focus?: boolean; inactive?: boolean }
    interactive?: boolean
    focusable?: boolean
    sendBeforeShow?: boolean
  }) {
    options.setActive()
    if (options.focusable !== undefined) {
      this.overlayWindow.setFocusable(options.focusable)
    }
    if (options.sendBeforeShow) {
      this.overlayWindow.send(options.channel, options.payload)
    }
    this.overlayWindow.show(options.showOptions)
    if (options.interactive !== undefined) {
      this.overlayWindow.setIgnoreMouseEvents(!options.interactive)
    }
    if (!options.sendBeforeShow) {
      this.overlayWindow.send(options.channel, options.payload)
    }
  }

  private hideSurface(options: {
    setInactive: () => void
    channel: string
    payload?: unknown
    restoreIgnoreMouseEvents?: boolean
    focusable?: boolean
  }) {
    options.setInactive()
    if (options.restoreIgnoreMouseEvents && !this.isAnyActive) {
      this.overlayWindow.setIgnoreMouseEvents(true)
    }
    if (options.focusable !== undefined) {
      this.overlayWindow.setFocusable(options.focusable)
    }
    this.overlayWindow.send(options.channel, options.payload)
    this.hideOverlayIfIdle()
  }

  // ─── Radial Dial ──────────────────────────────────────────────────────

  private radialBounds: { x: number; y: number } | null = null
  private radialHideTimeout: ReturnType<typeof setTimeout> | null = null
  private static readonly CLOSE_ANIM_FALLBACK = 350

  showRadial(options?: { compactFocused?: boolean; miniAlwaysOnTop?: boolean }) {
    if (this.radialHideTimeout) {
      clearTimeout(this.radialHideTimeout)
      this.radialHideTimeout = null
    }

    this.activeRadial = true

    if (!this.overlayWindow.getWindow()) return
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
    const payload = {
      x: relativeX,
      y: relativeY,
      centerX: RADIAL_SIZE / 2,
      centerY: RADIAL_SIZE / 2,
      screenX: localX,
      screenY: localY,
      compactFocused: options?.compactFocused ?? false,
      miniAlwaysOnTop: options?.miniAlwaysOnTop ?? false,
    }

    this.overlayWindow.send('radial:show', payload)
  }

  hideRadial() {
    if (!this.overlayWindow.getWindow()) return

    this.overlayWindow.send('radial:hide')

    if (!this.isAnyActive) {
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

  updateRadialCursor() {
    if (!this.radialBounds) return

    const cursorDip = screen.getCursorScreenPoint()
    const bounds = this.radialBounds
    const payload = {
      x: cursorDip.x - bounds.x,
      y: cursorDip.y - bounds.y,
      centerX: RADIAL_SIZE / 2,
      centerY: RADIAL_SIZE / 2,
    }

    if (!this.overlayWindow.getWindow()) return
    this.overlayWindow.send('radial:cursor', payload)
  }

  getRadialBounds() { return this.radialBounds }

  setRadialInteractive(interactive: boolean) {
    this.overlayWindow.setIgnoreMouseEvents(!interactive)
  }

  // ─── Region Capture ───────────────────────────────────────────────────

  startRegionCapture() {
    this.showSurface({
      setActive: () => {
        this.activeRegionCapture = true
      },
      channel: 'overlay:startRegionCapture',
      showOptions: { focus: true },
      interactive: true,
      focusable: true,
    })
  }

  suspendRegionCaptureForScreenshot() {
    if (!this.activeRegionCapture) return
    this.overlayWindow.fadeOut()
  }

  restoreRegionCaptureAfterScreenshot() {
    if (!this.activeRegionCapture) return
    this.overlayWindow.setFocusable(true)
    this.overlayWindow.show({ focus: true })
    this.overlayWindow.setIgnoreMouseEvents(false)
  }

  endRegionCapture() {
    this.hideSurface({
      setInactive: () => {
        this.activeRegionCapture = false
      },
      channel: 'overlay:endRegionCapture',
      restoreIgnoreMouseEvents: true,
      focusable: false,
    })
  }

  send(channel: string, ...args: unknown[]) {
    this.overlayWindow.send(channel, ...args)
  }

  // ─── Dictation ─────────────────────────────────────────────────────────

  showDictation(screenX: number, screenY: number) {
    this.activeDictation = true
    this.overlayWindow.show({ inactive: true })
    this.overlayWindow.refreshOverlayOriginFromContentBounds()
    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.send('overlay:showDictation', {
      x: screenX - origin.x,
      y: screenY - origin.y,
    })
  }

  hideDictation() {
    this.activeDictation = false
    this.overlayWindow.send('overlay:hideDictation')
    this.hideOverlayIfIdle()
  }

  // ─── Screen Guide ────────────────────────────────────────────────────

  showScreenGuide(annotations: Array<{
    id: string
    label: string
    x: number
    y: number
  }>) {
    this.activeScreenGuide = true
    this.overlayWindow.show({ inactive: true })
    const origin = this.overlayWindow.getOverlayOrigin()
    const adjusted = annotations.map((a) => ({
      ...a,
      x: a.x - origin.x,
      y: a.y - origin.y,
    }))
    this.overlayWindow.send('overlay:showScreenGuide', { annotations: adjusted })
  }

  hideScreenGuide() {
    this.activeScreenGuide = false
    this.overlayWindow.send('overlay:hideScreenGuide')
    this.hideOverlayIfIdle()
  }

  // ─── Selection Chip ("Ask Stella" pill above text selection) ──────────

  showSelectionChip(payload: SelectionChipPayload) {
    this.activeSelectionChip = true
    this.currentSelectionChipRequestId = payload.requestId
    this.overlayWindow.show({ inactive: true })
    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.send('overlay:showSelectionChip', {
      requestId: payload.requestId,
      text: payload.text,
      rect: {
        x: payload.rect.x - origin.x,
        y: payload.rect.y - origin.y,
        width: payload.rect.width,
        height: payload.rect.height,
      },
    })
  }

  hideSelectionChip(requestId?: number) {
    if (
      typeof requestId === 'number' &&
      this.currentSelectionChipRequestId !== null &&
      this.currentSelectionChipRequestId !== requestId
    ) {
      // Stale hide for a chip we already replaced; ignore.
      return
    }
    this.activeSelectionChip = false
    this.currentSelectionChipRequestId = null
    this.overlayWindow.send('overlay:hideSelectionChip', { requestId })
    this.hideOverlayIfIdle()
  }

  // ─── Morph Transition (HMR Resume) ───────────────────────────────────

  private activeMorph = false
  private currentMorphBounds: { x: number; y: number; width: number; height: number } | null = null

  private stopTrackingMorphWindow() {
    if (!this.morphTrackedWindow) return
    this.morphTrackedWindow.removeListener('move', this.handleMorphWindowBoundsChanged)
    this.morphTrackedWindow.removeListener('resize', this.handleMorphWindowBoundsChanged)
    this.morphTrackedWindow = null
  }

  private syncMorphBounds() {
    if (!this.activeMorph || !this.activeMorphTransitionId) return

    const trackedBounds = this.morphTrackedWindow && !this.morphTrackedWindow.isDestroyed()
      ? this.morphTrackedWindow.getBounds()
      : this.currentMorphBounds

    if (!trackedBounds) return

    this.currentMorphBounds = trackedBounds
    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.send('overlay:morphBounds', {
      transitionId: this.activeMorphTransitionId,
      x: trackedBounds.x - origin.x,
      y: trackedBounds.y - origin.y,
      width: trackedBounds.width,
      height: trackedBounds.height,
    })
  }

  getActiveMorphTransitionId() {
    return this.activeMorphTransitionId
  }

  startMorphForward(
    transitionId: string,
    screenshotDataUrl: string,
    bounds: { x: number; y: number; width: number; height: number },
    trackedWindow?: BrowserWindow | null,
    flavor: MorphTransitionFlavor = 'hmr',
  ) {
    this.activeMorph = true
    this.activeMorphTransitionId = transitionId
    this.morphFlavor = flavor
    this.currentMorphBounds = bounds
    this.stopTrackingMorphWindow()
    if (trackedWindow && !trackedWindow.isDestroyed()) {
      this.morphTrackedWindow = trackedWindow
      trackedWindow.on('move', this.handleMorphWindowBoundsChanged)
      trackedWindow.on('resize', this.handleMorphWindowBoundsChanged)
    }
    this.overlayWindow.show({ inactive: true })
    const origin = this.overlayWindow.getOverlayOrigin()
    this.overlayWindow.send('overlay:morphForward', {
      transitionId,
      screenshotDataUrl,
      x: bounds.x - origin.x,
      y: bounds.y - origin.y,
      width: bounds.width,
      height: bounds.height,
      flavor,
    })
  }

  startMorphReverse(
    transitionId: string,
    screenshotDataUrl: string,
    requiresFullReload: boolean,
  ) {
    if (this.activeMorphTransitionId !== transitionId) {
      return false
    }
    this.overlayWindow.send('overlay:morphReverse', {
      transitionId,
      screenshotDataUrl,
      requiresFullReload,
      flavor: this.morphFlavor,
    })
    return true
  }

  setMorphState(transitionId: string, state: SelfModHmrState) {
    if (this.activeMorphTransitionId !== transitionId) {
      return false
    }
    this.overlayWindow.send('overlay:morphState', { transitionId, state })
    return true
  }

  endMorph(transitionId: string) {
    if (this.activeMorphTransitionId !== transitionId) {
      return false
    }
    this.activeMorph = false
    this.activeMorphTransitionId = null
    this.morphFlavor = 'hmr'
    this.currentMorphBounds = null
    this.stopTrackingMorphWindow()
    this.overlayWindow.send('overlay:morphState', {
      transitionId,
      state: {
        phase: 'idle',
        paused: false,
        requiresFullReload: false,
      },
    })
    this.overlayWindow.send('overlay:morphEnd', { transitionId })
    this.hideOverlayIfIdle()
    return true
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  /** Idempotent — calling more than once is a no-op after the first.
   *  Detaches every IPC listener this controller registered in its
   *  constructor so we don't leak listeners across a hot-restart, and
   *  destroys the underlying overlay window. */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.stopTrackingMorphWindow()
    ipcMain.removeListener('overlay:setInteractive', this.handleOverlaySetInteractive)
    ipcMain.removeListener('overlay:showWindowHighlight', this.handleOverlayShowWindowHighlight)
    ipcMain.removeListener('overlay:hideWindowHighlight', this.handleOverlayHideWindowHighlight)
    ipcMain.removeListener(
      'overlay:previewWindowHighlightAtPoint',
      this.handleOverlayPreviewWindowHighlightAtPoint,
    )
    ipcMain.removeListener(
      'overlay:selectionChipClicked',
      this.handleOverlaySelectionChipClicked,
    )
    ipcMain.removeListener('radial:animDone', this.handleRadialAnimDone)
    this.selectionChipClickHandler = null
    if (this.radialHideTimeout) {
      clearTimeout(this.radialHideTimeout)
      this.radialHideTimeout = null
    }
    this.overlayWindow.destroy()
  }
}
