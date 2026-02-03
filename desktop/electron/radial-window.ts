import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = process.env.NODE_ENV === 'development'

const RADIAL_SIZE = 280 // Diameter of the radial dial

let radialWindow: BrowserWindow | null = null
// Cache the bounds/scale used when the radial is shown.
// Using getBounds() during the first few ms after setBounds() can return stale values on some systems.
let radialBounds: { x: number; y: number } | null = null
let radialScaleFactor = 1

const getDevUrl = () => 'http://localhost:5173/radial.html'

const getProdPath = () => path.join(__dirname, '../dist/radial.html')

export const createRadialWindow = () => {
  if (radialWindow) return radialWindow

  radialWindow = new BrowserWindow({
    width: RADIAL_SIZE,
    height: RADIAL_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: true,
    opacity: 0,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:stellar',
    },
  })

  // Set higher alwaysOnTop level than overlay
  radialWindow.setAlwaysOnTop(true, 'screen-saver')

  // Start click-through — window is invisible until first show
  radialWindow.setIgnoreMouseEvents(true, { forward: true })

  if (isDev) {
    radialWindow.loadURL(getDevUrl())
  } else {
    radialWindow.loadFile(getProdPath())
  }

  radialWindow.on('closed', () => {
    radialWindow = null
  })

  return radialWindow
}

export const showRadialWindow = (x: number, y: number) => {
  if (!radialWindow) {
    createRadialWindow()
  }

  if (!radialWindow) return

  // Get the display where the cursor is
  const cursorPoint = { x, y }
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const scaleFactor = display.scaleFactor ?? 1
  radialScaleFactor = scaleFactor

  // Position window centered on cursor
  // Account for display scaling
  const adjustedX = Math.round(x / scaleFactor - RADIAL_SIZE / 2)
  const adjustedY = Math.round(y / scaleFactor - RADIAL_SIZE / 2)
  radialBounds = { x: adjustedX, y: adjustedY }

  radialWindow.setBounds({
    x: adjustedX,
    y: adjustedY,
    width: RADIAL_SIZE,
    height: RADIAL_SIZE,
  })

  // Send initial cursor position to renderer (relative to window center).
  // Doing this on show avoids a "previous selection flash" before the first cursor move event arrives.
  const relativeX = x / scaleFactor - adjustedX
  const relativeY = y / scaleFactor - adjustedY
  // Make visible and interactive
  radialWindow.setOpacity(1)
  radialWindow.setIgnoreMouseEvents(false)

  radialWindow.webContents.send('radial:show', {
    x: relativeX,
    y: relativeY,
    centerX: RADIAL_SIZE / 2,
    centerY: RADIAL_SIZE / 2,
  })
}

export const hideRadialWindow = () => {
  if (radialWindow) {
    radialWindow.webContents.send('radial:hide')
    // Make invisible and click-through. The window stays on-screen so the
    // renderer is never throttled by Chromium — rAF and IPC stay responsive.
    radialWindow.setOpacity(0)
    radialWindow.setIgnoreMouseEvents(true, { forward: true })
    radialBounds = null
  }
}

export const updateRadialCursor = (x: number, y: number) => {
  if (!radialWindow || !radialBounds) return

  // Use cached bounds/scale from show time for stable math (especially right after setBounds()).
  const bounds = radialBounds ?? radialWindow.getBounds()
  const scaleFactor = radialBounds ? radialScaleFactor : (screen.getDisplayNearestPoint({ x, y }).scaleFactor ?? 1)

  const relativeX = x / scaleFactor - bounds.x
  const relativeY = y / scaleFactor - bounds.y

  radialWindow.webContents.send('radial:cursor', {
    x: relativeX,
    y: relativeY,
    centerX: RADIAL_SIZE / 2,
    centerY: RADIAL_SIZE / 2,
  })
}

export const getRadialWindow = () => radialWindow

export const RADIAL_WEDGES = ['capture', 'chat', 'full', 'voice', 'auto'] as const
export type RadialWedge = (typeof RADIAL_WEDGES)[number] | 'dismiss'

const DEAD_ZONE_RADIUS = 30 // Larger center zone for "dismiss"

export const calculateSelectedWedge = (
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number
): RadialWedge => {
  const dx = cursorX - centerX
  const dy = cursorY - centerY
  const distance = Math.sqrt(dx * dx + dy * dy)

  // Center zone = dismiss (cancel action)
  if (distance < DEAD_ZONE_RADIUS) {
    return 'dismiss'
  }

  // Calculate angle (0 = right, going clockwise)
  let angle = Math.atan2(dy, dx) * (180 / Math.PI)
  // Normalize to 0-360
  if (angle < 0) angle += 360

  // 5 wedges, each 72 degrees
  // Starting from top (-90 degrees / 270 degrees)
  // Adjust angle to start from top
  angle = (angle + 90) % 360

  // Determine wedge index
  const wedgeIndex = Math.floor(angle / 72)

  // Map: 0=Capture (top), 1=Chat (top-right), 2=Full (bottom-right), 3=Voice (bottom-left), 4=Auto (top-left)
  return RADIAL_WEDGES[wedgeIndex] ?? 'dismiss'
}
