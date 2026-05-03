import { BrowserWindow, screen } from 'electron'
import { loadWindow } from './window-load.js'
import { createSharedWebPreferences } from './shared-window-preferences.js'

type PetWindowControllerOptions = {
  preloadPath: string
  sessionPartition: string
  electronDir: string
  isDev: boolean
  getDevServerUrl: () => string
}

/**
 * Width/height of the pet window in CSS pixels. Sized to comfortably
 * contain the 96px sprite plus the action arc fanning out to its left
 * and the status bubble floating above it. Anything bigger would
 * needlessly block clicks in surrounding screen pixels; anything
 * smaller would clip the bubble or arc.
 */
const PET_WINDOW_WIDTH = 280
const PET_WINDOW_HEIGHT = 240
/**
 * Wider footprint the window grows into while the inline chat
 * composer is open. The sprite stays anchored to the right side so it
 * doesn't visually jump; the new space appears on the left where the
 * composer renders.
 */
const PET_WINDOW_COMPOSER_WIDTH = 540

/** Margin from the active display edge when the pet has never been moved. */
const DEFAULT_EDGE_MARGIN = 24

const pickDefaultPosition = () => {
  const cursor = screen.getCursorScreenPoint()
  const display =
    screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay()
  const work = display.workArea
  return {
    x: work.x + work.width - PET_WINDOW_WIDTH - DEFAULT_EDGE_MARGIN,
    y: work.y + work.height - PET_WINDOW_HEIGHT - DEFAULT_EDGE_MARGIN,
  }
}

/**
 * Dedicated tiny `BrowserWindow` that hosts the floating pet companion.
 *
 * The pet was originally rendered inside the screen-spanning unified
 * overlay window, but that approach forced us to play games with
 * `setIgnoreMouseEvents(true/false)` to keep clicks passing through to
 * apps below — and on macOS panel windows that toggle is unreliable
 * across focus changes / window respans, which produced "pet blocks
 * Stella's clicks even when the cursor is far from the pet".
 *
 * Giving the pet its own small window solves that cleanly: the window's
 * bounds *are* the hit zone. Clicks inside the bounds go to the pet,
 * clicks outside go to whatever app is below — no toggling required.
 */
class PetWindow {
  private window: BrowserWindow | null = null
  private ready = false
  private destroyed = false
  private composerActive = false
  private position = pickDefaultPosition()
  /** Concrete listener references so `destroy()` can detach them
   *  symmetrically before tearing down the BrowserWindow. The window's
   *  own native handles get released by `destroy()`, but holding onto
   *  the references makes the lifecycle obvious and prevents leaks if
   *  the controller is ever re-created after `destroy()`. */
  private readyToShowHandler: (() => void) | null = null
  private didFinishLoadHandler: (() => void) | null = null
  private movedHandler: (() => void) | null = null
  private closedHandler: (() => void) | null = null
  private closeHandler: ((event: Electron.Event) => void) | null = null

  constructor(private readonly options: PetWindowControllerOptions) {}

  getWindow() {
    return this.window
  }

  isReady() {
    return this.ready
  }

  /** Returns the existing window or lazily creates it. After `destroy()`
   *  this controller is dead — re-entry returns `null` so the caller
   *  knows to construct a fresh `PetWindowController`. */
  ensure() {
    if (this.destroyed) return null
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const window = new BrowserWindow({
      x: this.position.x,
      y: this.position.y,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      ...(process.platform === 'darwin'
        ? { hiddenInMissionControl: true }
        : {}),
      hasShadow: false,
      // Keep the pet window non-focusable so showing it doesn't steal
      // keyboard focus from the user's active app (Stella included).
      // `acceptFirstMouse: true` ensures clicks on the pet still
      // register on the very first click even when the window has no
      // focus, which is the entire point of a floating companion.
      focusable: false,
      acceptFirstMouse: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: createSharedWebPreferences({
        preloadPath: this.options.preloadPath,
        sessionPartition: this.options.sessionPartition,
        backgroundThrottling: false,
      }),
    })
    this.window = window

    // Float above normal windows but DON'T use the 'screen-saver' level
    // — that level on macOS sits above pretty much everything and tends
    // to interfere with focus management of the active app.
    window.setAlwaysOnTop(true, 'floating')
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      })
      window.excludedFromShownWindowsMenu = true
    } else {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      })
    }

    this.readyToShowHandler = () => {
      this.ready = true
    }
    this.didFinishLoadHandler = () => {
      this.ready = true
    }
    this.movedHandler = () => {
      const current = this.window
      if (!current || current.isDestroyed()) return
      const bounds = current.getBounds()
      this.position = { x: bounds.x, y: bounds.y }
    }
    this.closedHandler = () => {
      this.window = null
      this.ready = false
      this.readyToShowHandler = null
      this.didFinishLoadHandler = null
      this.movedHandler = null
      this.closedHandler = null
      this.closeHandler = null
    }
    this.closeHandler = (event) => {
      event.preventDefault()
    }

    // The pet window is mostly transparent — the sprite, action arc, and
    // bubble cover only a fraction of the 280×240 rect. Default to
    // mouse-passthrough so clicks in the empty pixels go to whatever
    // app is below. The renderer flips this off via `setInteractive`
    // when the cursor moves over a visible interactive element.
    // `forward: true` keeps mousemove events flowing to the renderer
    // while ignored, which is what makes that hover detection work.
    window.setIgnoreMouseEvents(true, { forward: true })

    window.once('ready-to-show', this.readyToShowHandler)
    window.webContents.once('did-finish-load', this.didFinishLoadHandler)
    window.on('moved', this.movedHandler)
    window.on('closed', this.closedHandler)
    window.on('close', this.closeHandler)

    loadWindow(window, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: 'pet',
      getDevServerUrl: this.options.getDevServerUrl,
    })

    return window
  }

  show() {
    const win = this.ensure()
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) {
      win.showInactive()
    }
  }

  hide() {
    if (!this.window || this.window.isDestroyed()) return
    if (this.window.isVisible()) {
      this.window.hide()
    }
  }

  /** Move the pet window to an absolute screen position. Used by the
   *  renderer's drag handler. */
  setPosition(x: number, y: number) {
    if (!this.window || this.window.isDestroyed()) return
    const rounded = { x: Math.round(x), y: Math.round(y) }
    this.position = rounded
    const width = this.composerActive
      ? PET_WINDOW_COMPOSER_WIDTH
      : PET_WINDOW_WIDTH
    this.window.setBounds(
      {
        x: rounded.x,
        y: rounded.y,
        width,
        height: PET_WINDOW_HEIGHT,
      },
      false,
    )
  }

  /**
   * Toggle the inline chat composer footprint. We grow the window
   * leftward (anchored to its current right edge so the sprite stays
   * put visually) and flip `focusable` so the textarea can receive
   * keystrokes — the resting pet window is non-focusable so it never
   * steals focus from the user's active app.
   */
  setComposerActive(active: boolean) {
    if (!this.window || this.window.isDestroyed()) return
    if (active === this.composerActive) return
    this.composerActive = active
    const bounds = this.window.getBounds()
    const targetWidth = active ? PET_WINDOW_COMPOSER_WIDTH : PET_WINDOW_WIDTH
    // Anchor by the existing right edge so the sprite doesn't jump.
    // `Math.round` keeps the new x integer-aligned — Electron rounds
    // bounds internally, so passing rationals (e.g. after a drag mid-
    // float) can land us on a different pixel column than the right
    // edge we computed from. `animate: false` is the default, but we
    // pass it explicitly to make sure macOS never decides to slide
    // the window into its new size on close.
    const rightEdge = bounds.x + bounds.width
    const nextX = Math.round(rightEdge - targetWidth)
    if (active) {
      // Toggle mouse-passthrough off BEFORE the resize so the click
      // that lands on the textarea right after open is honored on the
      // first frame. Order matters here because Electron processes
      // setIgnoreMouseEvents asynchronously on macOS — flipping after
      // the resize would leave a 1–2 frame window where the composer
      // is visible but unclickable.
      this.window.setIgnoreMouseEvents(false)
    }
    this.window.setBounds(
      {
        x: nextX,
        y: bounds.y,
        width: targetWidth,
        height: PET_WINDOW_HEIGHT,
      },
      false,
    )
    this.position = { x: nextX, y: bounds.y }
    this.window.setFocusable(active)
    if (active) {
      // Pull focus so the textarea picks up keystrokes. We avoid
      // `show()` / `focus()` calls on close because they were the
      // source of an apparent reposition on the close transition —
      // `setAlwaysOnTop('floating')` keeps the window on top either
      // way, so we don't need to re-raise it.
      this.window.focus()
    } else {
      // Restore passthrough AFTER the resize so the renderer-driven
      // mousemove hit-test can immediately re-flip it back to
      // interactive if the cursor is still over the sprite. Doing it
      // before the resize was visually indistinguishable from a
      // reposition because the window's tracking area got rebuilt
      // mid-shrink on macOS.
      this.window.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  /** Renderer-driven mouse passthrough toggle. Active means clicks land
   *  on the pet; inactive means clicks pass through to whatever app is
   *  below. While the composer is open we keep the window fully
   *  interactive (the composer needs every click), so this is a no-op
   *  in that mode. */
  setInteractive(active: boolean) {
    if (!this.window || this.window.isDestroyed()) return
    if (this.composerActive) return
    if (active) {
      this.window.setIgnoreMouseEvents(false)
    } else {
      this.window.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  /** Tear down the pet window. Idempotent — safe to call more than
   *  once. After this returns, `ensure()` will refuse to recreate the
   *  window (the controller is treated as dead). */
  destroy() {
    this.destroyed = true
    const win = this.window
    if (!win) return
    if (this.closeHandler) {
      win.removeListener('close', this.closeHandler)
      this.closeHandler = null
    }
    if (this.movedHandler) {
      win.removeListener('moved', this.movedHandler)
      this.movedHandler = null
    }
    if (this.closedHandler) {
      win.removeListener('closed', this.closedHandler)
      this.closedHandler = null
    }
    if (this.readyToShowHandler) {
      win.removeListener('ready-to-show', this.readyToShowHandler)
      this.readyToShowHandler = null
    }
    if (this.didFinishLoadHandler && !win.webContents.isDestroyed()) {
      win.webContents.removeListener(
        'did-finish-load',
        this.didFinishLoadHandler,
      )
      this.didFinishLoadHandler = null
    }
    if (!win.isDestroyed()) {
      win.destroy()
    }
    this.window = null
    this.ready = false
  }
}

export class PetWindowController {
  private readonly petWindow: PetWindow
  private destroyed = false

  constructor(options: PetWindowControllerOptions) {
    this.petWindow = new PetWindow(options)
  }

  setOpen(open: boolean) {
    if (this.destroyed) return
    if (open) {
      this.petWindow.show()
    } else {
      this.petWindow.hide()
    }
  }

  isVisible() {
    if (this.destroyed) return false
    const win = this.petWindow.getWindow()
    return Boolean(win && !win.isDestroyed() && win.isVisible())
  }

  getWindow() {
    if (this.destroyed) return null
    const win = this.petWindow.getWindow()
    return win && !win.isDestroyed() ? win : null
  }

  getWebContents() {
    if (this.destroyed) return null
    return this.petWindow.getWindow()?.webContents ?? null
  }

  setWindowPosition(x: number, y: number) {
    if (this.destroyed) return
    this.petWindow.setPosition(x, y)
  }

  setComposerActive(active: boolean) {
    if (this.destroyed) return
    this.petWindow.setComposerActive(active)
  }

  setInteractive(active: boolean) {
    if (this.destroyed) return
    this.petWindow.setInteractive(active)
  }

  /** Idempotent — calling more than once is a no-op after the first. */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.petWindow.destroy()
  }
}

export const PET_WINDOW_DIMENSIONS = {
  width: PET_WINDOW_WIDTH,
  height: PET_WINDOW_HEIGHT,
}
